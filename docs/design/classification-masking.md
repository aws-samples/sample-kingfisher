# Design — Data Classification + Field Masking + Access Requests (Governance Depth, First-Priority Track)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is summarized in the [modules overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> Revision: 1.10.0 | Date: 2026-10-24 | Status: implemented and verified in a live environment (**revision 1.10.0, fix of 2026-10-24: result columns are matched to classifications through their physical columns — aliased columns and expression columns are no longer missed by masking**; the code landed on 2026-10-24 and was merged into the main development line after page-level re-verification)
> Addresses the gap-analysis item "Data classification / masking / access requests" under the "re-check / first-priority track · governance depth" heading. The third item of the first-priority track (the first two were run parameterization in revision 1.7.0 and SQL lineage + impact analysis in revision 1.8.0).

---

## 0. Goals

Add a **closed data-security loop** to governance:

1. **Classification**: tag tables / fields with a **sensitivity level** (L1 public / L2 internal / L3 confidential / L4 highly confidential) + an optional **category label** (PII / finance / contract …) + a field-level **masking strategy**.
2. **Field masking**: for sensitive fields tagged with a masking strategy, mask **on the server side** in the **returned query values** (Redshift query results + GenBI results); **only the returned values are masked, the data in the database is never modified**. Platform administrators / resource owners / users who have been granted access are **exempt**.
3. **Access requests**: an unauthorized user **requests access** to a sensitive table → approval flow → on approval a **grant** is written → masking is lifted for that user on that table. **Reuses** `bgp-approvals` (`type:"data-access"`) + the existing approval UI.

**Reuse instead of rebuild**: the approval flow reuses `bgp-approvals` + `/api/approvals` from the [multi-tenancy / RBAC design](./multitenancy-rbac.md); identity / administrator determination reuses `resolveIdentity` (`isPlatformAdmin`); the "which tables does this query reference" step of masking reuses the SQL parser of the [SQL lineage design](./sql-lineage-impact.md). **Two new DynamoDB tables** (control plane), **no OM changes**.

---

## 1. Data model (DynamoDB, control plane)

Why DynamoDB rather than OM tags: masking needs a **low-latency, platform-managed** decision on the query path; classification is a platform-enforced security control plane, and DynamoDB is the most direct place for it (OM remains the system of record for catalog / lineage / quality; classification is displayed on the catalog page as an annotation).

| Table | pk | sk | Attributes |
|----|----|----|------|
| `bgp-data-classification` | `fqn` (table FQN, e.g. `bgp-redshift.dev.public.customers`) | `column` (field name; `__table__` for the table level) | `level` (L1–L4), `category`, `maskStrategy` (none/full/partial/email/hash), `classifiedBy`, `updatedAt` |
| `bgp-data-grants` | `username` (Cognito user name) | `fqn` (the granted table FQN) | `grantedBy`, `grantedAt`, `approvalId` |

- `Query(pk=fqn)` fetches the whole classification of one table; `Get(pk=username, sk=fqn)` decides whether a user has been granted a table; `Query(pk=username)` lists "my grants".

## 2. Masking strategies

`lib/governance/masking.ts` `applyMask(value, strategy)` (`null` / empty values are returned as they are):

| Strategy | Behavior | Example |
|------|------|----|
| `full` | mask the whole value | `***` |
| `partial` | keep the first and last character | `13800001234` → `1*********4` |
| `email` | mask the local part, keep the domain | `john@x.com` → `j***@x.com` |
| `hash` | first 8 characters of SHA-256 (masked yet joinable) | `sha256:9f86d081` |

## 3. Masking enforcement points (server side)

`maskRows({ columns, rows, sql, database, identity })` — **never throws**; on failure it **defaults to the safer side** (undecidable → fall back to masking by name):

1. **Exemption**: `identity.isPlatformAdmin` (`bgp-admin`) → return as is (administrators / super users are not masked).
2. **Determine the referenced tables**: ① for Redshift results use `ColumnMetadata.schemaName/tableName` to pinpoint the table each result column belongs to (the most reliable method); ② at the same time parse the SQL with the SQL lineage parser to obtain the source tables, as a fallback when `tableName` is missing.
3. **Decide the masking strategy per result column**: the table the column belongs to has been **granted** to this user → no masking; otherwise look up the `maskStrategy` of that table and column (anything other than none means masking). When `tableName` is missing, match by **column name** against the classifications of the "referenced and not granted" tables (taking the strongest strategy).
4. Return the masked `rows` + `maskedColumns` (the names of the masked columns, so the front end can hint "you can request access").

**Enforcement points**:
- `GET /api/redshift/result/[id]`: `DescribeStatement` already has the `QueryString` (fallback parsing) and `GetStatementResult` has the `ColumnMetadata` (exact pinpointing); mask in the `FINISHED` branch before returning.
- `POST /api/genbi/ask`: mask the `columns/rows` produced by the agent according to the generated SQL before returning.
- Both call `resolveIdentity(req)` (the front-end global fetch interceptor already carries the ID token); no identity → treated as not granted (the safer side).

> ~~Limitation: masking matches by **column name / the column's table**;
> a column renamed by `SELECT col AS alias` or a pure expression column (`CONCAT(...)`) cannot be related to a classification and may escape masking (recorded as a limitation).
> ~~ **Lifted in revision 1.10.0 (fix of 2026-10-24)**: every result column is first parsed by `parseSelectOutputs` of the SQL lineage parser (`lib/lineage/sql-lineage.ts`) into "which physical columns it references" (AS / bare alias / expression / aggregate / `::cast` / case-when / extract; aliases inside CTEs and subqueries are expanded level by level; literals / keywords / type names / function names do not count), and `maskRows` takes the strongest strategy for any hit on **the result column name ∪ the physical columns** (an expression that touches a sensitive column is masked too — better strict than leaky);
> when nothing can be parsed (`SELECT *`, a non-select statement) only the result column name itself remains = the original rule, never looser;
> `maskedColumns` still reports result column names.
> Why the fix was mandatory: the Ask-Your-Data model almost always writes Chinese aliases (`country AS <alias>`, where the alias is the Chinese word for "region"); the page-driven headless-browser acceptance of the GenBI chain of 2026-10-24, using SQL really returned by the model, confirmed "the classification sits on country, the result column is called by its Chinese alias ⇒ always plaintext".

## 4. Access requests (reusing the approval flow)

- **Request**: `POST /api/approvals { type:"data-access", projectId, fqn, note }` — `projectId` is the requester's current workspace (a platform administrator is the owner of every workspace and therefore sees and handles it in the approval inbox; a project owner can as well). The `payload` carries `fqn`.
- **Approval**: `POST /api/approvals/[id] {decision}` — `approve` with `type==="data-access"` → writes `bgp-data-grants` (username=requester, fqn=payload.fqn). Reuses the existing `requireProject(owner)` guard (administrator = owner of every workspace).
- **My grants**: `GET /api/governance/access-grants?mine=1` lists the tables the current user has been granted.

## 5. Classification settings API

- `GET /api/governance/classification?fqn=<table FQN>` (readable when logged in) → the field classifications of that table; `GET /api/governance/classification` (no fqn) → everything (for the governance overview / catalog annotations).
- `PUT /api/governance/classification {fqn, column, level, category?, maskStrategy?}` (**platform administrators only**) → upsert.
- `DELETE /api/governance/classification?fqn=&column=` (**platform administrators only**) → remove.
- **Catalog annotation**: `/api/governance/catalog` reads the full classification and adds `sensitivity` (the highest level among the table's fields) to every row for the front end to tag.

## 6. Front end

- **Data Governance page**: a new **"Data Classification"** tab: pick a table (reusing the catalog FQN) → list its fields (taken from the `columns` of the OM table entity) → set the level + masking strategy per field (administrators); show the current classification; non-administrators can "Request access" to a sensitive table and see "My grants".
- **Data Catalog** rows gain a `sensitivity` tag (L3 / L4 in red / orange).
- **Redshift Query page**: when the result contains masked columns, a notice bar shows "some sensitive fields have been masked (you can request access on the Data Governance page)".
- **/projects approval drawer**: renders the `data-access` type (shows the requested table FQN + the reason).

## 7. Security / red lines

- Masking is enforced **on the server side**, applies to **returned values**, **does not modify data in the database**, and is low-impact and reversible; administrators / owners / grantees are exempt.
- Only two new DynamoDB tables (BgpDatabaseStack); the Platform deployment **must** carry `-c openmetadata-url`.
- Classification settings are restricted to platform administrators; request / approval / grant are audited end to end (best-effort).
- **This mechanism is enforced at the application layer (the platform query path)** — connecting to Redshift directly, bypassing the platform, is not subject to masking (consistent with the existing application-layer RBAC; database-level RLS / column-level GRANT is a follow-up).

## 8. Live verification (a test account / us-east-1)

1. An administrator `PUT`s classifications: for `bgp-redshift.dev.public.customers`, `email` → `email` strategy, `phone` → `partial`.
2. **admin** runs `SELECT customer_id,email,phone FROM public.customers LIMIT 3` → **not masked** (administrator exemption).
3. **rbac-tester** runs the same query → `email` / `phone` **are masked**, and the result contains `maskedColumns`.
4. rbac-tester `POST`s a data-access request for customers → admin `approve`s → the grant is written → rbac-tester queries again → **not masked**.
5. Cleanup: delete the grant, delete the classification, delete the approval leftovers (harmless).

## 9. Known limitations / follow-ups

1. ~~Masking matches by column name / the column's table; aliased columns / expression columns may escape (recorded)~~ **Fixed (revision 1.10.0, 2026-10-24)**: result columns are matched to classifications through the physical columns they reference (see the end of section 3); pushing column-level GRANT / RLS down into Redshift is a follow-up.
2. Classification settings are restricted to platform administrators (project-level delegation of classification is a follow-up); grants are at **whole-table** granularity (column-level grants are a follow-up).
3. Only the two return paths Redshift Query + GenBI are masked; other export paths (such as a future API export) must each hook into the same `maskRows`.
4. Automatic classification (PII detection) is not done — this release classifies manually; it can later be combined with the Profiler / regular expressions for automatic suggestions.
