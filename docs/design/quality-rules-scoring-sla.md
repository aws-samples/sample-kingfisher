# Design — Data Quality Rule Templates + Scoring + SLA (Governance Depth, First-Priority Track)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is summarized in the [modules overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> - Revision: 1.10.0 | Date: 2026-06-14 | Status: design → implementation → live verification
>   Addresses the gap-analysis item "Quality rule template library + scoring + SLA" under the "re-check / first-priority track · governance depth" heading. The fourth item of the first-priority track (the first three were run parameterization in revision 1.7.0, SQL lineage + impact analysis in revision 1.8.0, and classification / masking / access requests in revision 1.9.0).

---

## 0. Goals and positioning

Build a **platform-managed data quality engine**: users instantiate quality rules from **built-in rule templates** and bind them to tables / fields; the platform **executes the validation SQL directly on Redshift**, counts passes / failures, and computes a **quality score** (weighted pass rate + per-dimension scores) and an **SLA** (freshness threshold breaches).

### Why self-managed rather than only reading OpenMetadata quality

The early "Data Quality" page of the platform (revision 1.0.12) read **OM TestSuite / Profiler results**, which are written by the scheduled Profiler task of `BgpOmIngestionStack`. But that ingestion stack is **optional and deployed on demand**; in an environment where the ingestion stack is not deployed, OM quality data is empty and the quality page has nothing to show.

This module **brings the quality capability down into the platform itself**: rules and results are stored in the platform's DynamoDB, and the validation SQL is executed by the platform under the **unified Redshift admin identity** (reusing the execution-identity scheme of revision 1.6.1). As a result:

- it **does not depend** on whether the ingestion / Profiler stack is deployed, and every environment can run quality checks on real data;
- rule templates, scoring rules and the SLA are all controlled by and explainable by the platform;
- the display of **OM Profiler / TestSuite results** on the Data Governance page is kept as a supplement (if the ingestion stack is deployed).

---

## 1. Rule template library (dimensions)

`lib/quality/templates.ts` — isomorphic pure TS (the front end imports the metadata to build forms; the back end imports everything for SQL generation and evaluation). Six built-in templates cover five quality dimensions:

| type | dimension | Meaning | Column required | Parameters |
|------|----------------|------|--------|------|
| `not_null` | completeness | not null (null rate ≤ threshold, default 0) | yes | `maxNullPct` (optional, default 0) |
| `unique` | uniqueness | field values are unique (duplicate rows ≤ threshold, default 0) | yes | `maxDupRows` (optional, default 0) |
| `range` | validity | numeric values fall within [min,max] | yes | `min`,`max` (numeric, at least one) |
| `accepted_values` | validity | values are within the allowed set | yes | `values` (list of strings) |
| `row_count` | consistency | table row count falls within [min,max] | no | `min`,`max` (integers, at least one) |
| `freshness` | freshness | the latest value of a time column is ≤ SLA hours old | yes | `slaHours` (required, >0) |

Every template provides `buildSql(ident, params)`, which generates a SELECT **returning a single metric row**, and `evaluate(row, params)`, which decides `{ passed, metric, detail }`.

Example validation SQL (all return a single row):
- not_null: `SELECT COUNT(*) AS total, COUNT(*) - COUNT(<col>) AS failed FROM <t>` → null rate = failed/total.
- unique: `SELECT COUNT(*) AS total, COUNT(*) - COUNT(DISTINCT <col>) AS failed FROM <t>`.
- range: `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE <col> < :min OR <col> > :max) AS failed FROM <t>`.
- accepted_values: `... FILTER (WHERE <col> IS NOT NULL AND <col> NOT IN (:v0,:v1,...))`.
- row_count: `SELECT COUNT(*) AS total FROM <t>` → pass = min≤total≤max.
- freshness: `SELECT DATEDIFF(second, MAX(<col>), GETDATE())/3600.0 AS hours FROM <t>` → pass = hours ≤ slaHours.

## 2. Security (SQL injection prevention) — key quality points

The validation SQL has two kinds of untrusted input:

- **Identifiers** (table / column names): SQL cannot bind identifiers as parameters. → **Strict allow-list validation**: `schema.table` / `column` only allow segments matching `^[A-Za-z_][A-Za-z0-9_]*$` (at most the three segments db.schema.table), and after validation they are wrapped in double quotes (`"schema"."table"`). Any invalid identifier is **refused**.
- **Literal parameters** (min/max/values/thresholds): **⚠️ (documentation audit calibration, 2026-08-26) the actual implementation mechanism differs from the original design but is equivalent in security**.
  - The original text said "bind with Redshift Data API named parameters `Parameters:[{name,value}]`" — the code **does not use Parameters**: numbers are validated as finite numbers by `toFiniteNumber` and then **inlined directly** (`lib/quality/templates.ts:217-218` 🔵),
  - enumerated values are single-quote-escaped by `strLit` and **inlined into the IN list** (`templates.ts:239-240` 🔵),
  - the `ExecuteStatement` of `execCheck` **has no `Parameters` field** (`lib/quality/service.ts:150-152` 🔵).
  - Security rests on the triple guarantee "strict numeric validation + string escaping + identifier allow-list", which is equivalent to named parameters, but **the mechanism is validate-and-escape inlining, not parameter binding**.

> Execution uses a per-rule `ExecuteStatement` rather than `BatchExecuteStatement`. A table has a limited number of rules; `Promise.all` concurrent execution + polling is fast enough. **⚠️ (audit calibration)** the original text justified this with "because ExecuteStatement supports Parameters binding" — in fact the choice of ExecuteStatement has nothing to do with Parameters (the code does not use Parameters, see above); security is guaranteed by validate-and-escape inlining.

## 3. Execution engine and identity

`lib/quality/service.ts`:
- Runs all **enabled** rules of one table: for every rule `buildSql` → `ExecuteStatement` (`WorkgroupName` / `Database` from env, `SecretArn` = the unified admin secret `redshift!bgp-namespace-admin`, reusing `getRedshiftSecretArn`) → poll `DescribeStatement` → `GetStatementResult` to fetch the single row → `evaluate`.
- All validations are **read-only** (COUNT / SELECT); the admin identity is only there for stable read permission.
- A failure (SQL error, such as a non-existent column) is recorded as `status:"error"` for that rule and does not affect the other rules (error isolation).

## 4. Scoring and dimension scores

- Every rule has a `weight` (default 1) and a `severity` (`error`|`warn`).
- **Quality score** = `round( Σ(weight of passed rules) / Σ(weight of all executed rules) × 100 )` (0–100; `error` / `warn` rules both count toward the pass rate; severity is only used for display and SLA severity).
- **Dimension scores**: group by `dimension` and compute the weighted pass rate per dimension (completeness / uniqueness / validity / consistency / freshness).
- At the end of a run a **summary** row is written (with score, dimension scores, passed/total, slaBreached, and the run time).

## 5. SLA

- A `freshness` rule is the SLA: `slaHours` is the freshness threshold, and `hours > slaHours` is an **SLA breach**.
- The summary records `slaBreached` (whether any freshness rule of the table is breached) and the `hours` of every freshness rule.
- The Data Governance page **highlights** SLA breaches (in red).
- In this release the SLA check is triggered by "Run Check"; **scheduled inspection** (automatic daily runs + alerts) is a follow-up (EventBridge / MWAA can be reused).

## 6. Data model (DynamoDB, two new tables)

| Table | pk | sk | Key attributes |
|----|----|----|----------|
| `bgp-quality-rules` | `fqn` (table FQN) | `ruleId` (ulid) | `type`,`column`,`params` (map),`severity`,`weight`,`enabled`,`createdBy`,`createdAt`,`updatedAt` |
| `bgp-quality-results` | `fqn` | `runId#ruleId` (runId = ulid, time-ordered; summary row `runId#__summary__`) | `runId`,`ruleId`,`type`,`column`,`status` (passed/failed/error),`metric`,`total`,`failed`,`detail`,`ts`; the summary row has `score`,`dimensions`,`passed`,`total`,`slaBreached`,`ts` |

- `Query(pk=fqn)` fetches all rules / all results of one table; results are read in descending `runId` order to get the most recent run (including the summary); the trend = the most recent N summary rows.

## 7. API

- `GET /api/governance/quality-rules?fqn=` lists rules; `POST` creates a rule (editor and above; the platform layer validates template / parameters).
- `PUT/DELETE /api/governance/quality-rules/[id]?fqn=` edits / deletes a rule.
- `POST /api/governance/quality-run {fqn}` runs all enabled rules of the table → writes results + summary → returns this run's results.
- `GET /api/governance/quality-results?fqn=[&history=1]` the most recent results + summary (score / SLA); `history=1` appends the trend of the most recent summaries.
- Template metadata goes through a **shared constant** (the front end imports `QUALITY_TEMPLATES_META`); there is no separate endpoint.

Authorization: reads use `requireAuth`; writes (create / delete / run rules) use `requireAuth` (governance is platform-level; no project isolation — quality rules target physical tables). Should create / delete be restricted to **platform administrators or any logged-in user**? For consistency with classification, **create / delete / run are restricted to platform administrators** (governance management actions), while reads are open to every logged-in user.

## 8. Front end

The "Data Quality" tab of the Data Governance page is rebuilt:
- Top: pick a table (reusing the catalog FQN) → show the **quality score** (big number + small dimension-score cards), the **SLA status**, the last run time, and the **"Run Check"** button.
- **Rule list**: the table's rules (type / column / parameters / severity / latest result status + metric); administrators can **delete**.
- **"Add rule"**: pick a template type → dynamic form (according to the template's parameter schema) → save.
- **History trend**: the most recent N quality scores (number sequence / mini bars).
- The **OpenMetadata Profiler / TestSuite** section is kept (collapsed, supplementary display).

## 9. Live verification (a test account / us-east-1, headless browser)

Against the real table `bgp-redshift.dev.public.customers` (customer_id/name/region/city/segment/signup_date, 200 rows):
1. admin creates rules: `customer_id` not null, `customer_id` unique, table `row_count` [1,100000], `signup_date` freshness slaHours (set a small value **that will breach**, such as 1 hour, to demonstrate the SLA, then a generous value to demonstrate a pass).
2. Run Check → the quality score, dimension scores, per-rule pass / fail, and SLA status appear.
3. Screenshot assertions: the score number appears, rule result statuses are correct, the SLA breach is highlighted.
4. Clean up the test rules and results.

## 10. Known limitations / follow-ups

1. This release runs **manually**; automatic scheduled inspection + alerts (e-mail / events) are a follow-up.
2. Validation runs on Redshift (the platform warehouse); quality validation on source databases / other engines is a follow-up.
3. The score is a weighted pass rate; more sophisticated scoring (weighted by row-level failure ratio, historical decay) is a follow-up.
4. Rules apply to physical tables and are not isolated per workspace (consistent with classification).
5. `freshness` requires the table to have a time column; the template does not apply to tables without one.
