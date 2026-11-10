# Design — Warehouse Modeling (Layering + Subject Areas / Data Domains + Data Standards / Code Tables + Dimensional Modeling + Metric System), Detailed Design

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is summarized in the [modules overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> - Revision: 1.2 | Date: 2026-06-26 | Status: **both the first slice (warehouse layering + data domains / data standards / code tables) and the second slice (dimensional / fact modeling + metric system) have been delivered and verified end to end in the browser**.
> - First slice: layering / data domains / data standards / code tables + landing in Redshift.
> - **Second slice (dimensional / fact modeling + metric system + OM Glossary): design in section 11, implemented + all headless verification green**
>   (dimensional modeling: create a dimension table → DDL → apply, with hard evidence of the real table in Redshift; metric system: hard evidence of computed values — atomic GMV = 1649 / derived 30-day paidGMV = 350).
> - Benchmark: the data modeling / data governance — warehouse planning features of a leading cloud data-development suite. Capability groups: layering, data standards · dictionaries · code tables, dimensional modeling, metric system (first-priority roadmap item "data modeling").
> - Master plan: the capability roadmap of 2026-08 (a historical document that is not part of this repository), section 1 "data modeling": layering / data standards · dictionaries · code tables / dimensional modeling / metric system.
>
> - 🔴 Red lines: only `--profile temp-account` (account facts are always looked up live), no hard-coded secrets, every new feature verified headlessly / for real, no unauthorized push.
> - 💰 **Cost: this module is pure metadata + reuse of the existing Redshift Serverless (pay per use); zero new standing-charge components.**

---

## 1. Goals and scope

Upgrade the platform from "a pile of tables / metrics without organization" to "**systematic modeling with warehouse planning**":

- **Warehouse layering**: the standard ODS / DWD / DWS / ADS layers, each mapped to a Redshift schema; a table can be registered as belonging to a layer.
- **Subject areas / data domains**: a business classification tree (for example trade domain / user domain / product domain); tables and metrics can be assigned to a domain.
- **Data standards / code tables**: standard fields (naming / type / meaning / constraints) + code tables (enumeration dictionaries, for example order status 0 = pending payment / 1 = paid),
  landed as Redshift code tables + optionally pushed to the OpenMetadata Glossary.
- **Dimensional modeling** (second-slice iteration): dimension table / fact table registration + one-click Redshift DDL generation.
- **Metric system** (second-slice iteration): on top of the existing "lightweight single-aggregate metrics" ([metrics store](./metrics-store.md)), add a modeling layer of atomic → derived → modifiers → time periods.

### 1.1 The first slice (delivered in this round) = layering + domains / standards / code tables (the planning layer)

> Rationale: the planning layer (layering / domains / standards / code tables) is the "skeleton" of modeling — pure metadata + a small amount of Redshift landing (code tables),
> which can be closed completely + verified for real + with zero new charges. Dimensional modeling / the metric system depend on the planning layer and are left for the second slice.

**First-slice deliverables**:
1. The data layering model (preset ODS/DWD/DWS/ADS + custom layers), a schema mapping per layer + table ownership.
2. Data domains / subject areas (a two-level business classification tree), with create / read / update / delete.
3. Data standards (standard field dictionary) + code tables (enumeration dictionaries); a code table can be "landed in Redshift" (create the table + load the enumeration values).
4. Management-plane API (RBAC: lists readable by any logged-in user / write operations by platform administrators / audit) + the front-end "Data Modeling" page (tabs).
5. Headless browser end-to-end verification + roadmap write-back.

**Not in the first slice** (left for the second slice): dimension / fact table DDL generation, metric-system extension, automatic lineage attachment, cross-domain impact analysis.

---

## 2. Reused foundation (no parallel implementation)

| Reused | Source | How it is reused |
|---|---|---|
| DynamoDB document client + table constants | `lib/aws/dynamodb.ts` (docClient / TABLES) | Add TABLES constants; use docClient directly |
| Table creation (CMK/PITR/RETAIN one-click hardened) | `infra/lib/database-stack.ts` tables[] | Add rows to the array |
| Identity / RBAC | `lib/auth/identity.ts` (resolveIdentity / isPlatformAdmin) | API authorization follows the [metrics store](./metrics-store.md) pattern exactly |
| Unified responses | `lib/api-response.ts` (apiOk / apiError) | Use directly |
| Audit | `lib/audit.ts` (recordAudit, fire-and-forget) | Write operations record an audit entry |
| Safe SQL (identifier allow-list + double quotes) | `lib/metrics/service.ts` (safeIdent / quoteTable) | Reused for landing code tables in Redshift; extracted into a same-named utility inside modeling |
| Redshift execution (unified admin identity + polling) | `lib/metrics/service.ts` (execSql, private) | Code-table landing reuses the same execution pattern |
| OpenMetadata client | `lib/openmetadata/om-client.ts` (omRequest / isOmConfigured) | Data standards → OM Glossary (optional; failure does not block) |
| ULID primary keys | `ulid` | ids of every entity |
| Front-end Tabs / table / Modal framework | `app/governance/page.tsx`, `app/metrics/page.tsx` | Reference for the front-end page |

> Key constraint (from the metrics hub experience): Redshift write operations must go through the `safeIdent` allow-list (`^[A-Za-z_][A-Za-z0-9_]*$`)
> + double-quote wrapping against injection; code-table enumeration values are parameterized / escaped — **never concatenated as raw strings**.

---

## 3. Data model (new DynamoDB tables, reusing the hardened option)

```text
bgp-data-layers          data layers
  pk = "layer" (single logical partition)   sk = layerId (ULID)
  { layerId, code (ODS/DWD/DWS/ADS/custom), name, schema (Redshift schema name), seq (ordering), description }

bgp-data-domains         data domains / subject areas (two-level tree)
  pk = "domain"            sk = domainId (ULID)
  { domainId, name, code, parentId (null = top-level data domain / non-null = child subject area), level (1|2), owner, description }

bgp-data-standards       data standards (standard field dictionary)
  pk = "standard"          sk = standardId (ULID)
  { standardId, name (standard name, e.g. "amount"), code, dataType, length, unit, refCodeTableId? (linked code table),
    namingRule (naming convention), constraint (constraint description), description }

bgp-code-tables          code tables (enumeration dictionaries)
  pk = "codetable"         sk = codeTableId (ULID)
  { codeTableId, name (e.g. "order status"), code (e.g. order_status), description,
    values:[{ value, label, seq }] (enumeration items, embedded array, far below 400KB),
    landed? (landed in Redshift or not), landedTable? (landed table name), landedAt? }

bgp-model-assets         table / metric → layer / domain ownership (modeling asset binding)
  pk = fqn (table / metric FQN)     sk = "binding"
  { fqn, layerId?, domainId?, kind ("table"|"metric"), boundBy, boundAt }
```

> Design trade-off: layers / domains / standards / code tables are all **low-frequency, low-volume** configuration data, so they use "single logical partition + ULID sort key" (the same pattern as bgp-metrics
> / bgp-projects): `Query(pk)` lists everything, `Get(pk,sk)` fetches one row. The ownership table `bgp-model-assets` uses fqn as pk, so
> `Get(fqn,"binding")` looks up the ownership of a table / metric in O(1). **No new billable component** (DynamoDB pay per request + reuse of Redshift).

---

## 4. Landing code tables in Redshift (the only capability that writes to Redshift)

"Landing" a code table = creating a physical code table in Redshift and loading the enumeration values, for ETL / BI joins:

```sql
-- 表名: 固定前缀 dim_code_<code>，<code> 经 safeIdent 校验
CREATE TABLE IF NOT EXISTS public."dim_code_order_status" (
  "value" VARCHAR(64) NOT NULL,
  "label" VARCHAR(256),
  "seq"   INTEGER
);
DELETE FROM public."dim_code_order_status";          -- 幂等重灌
INSERT INTO public."dim_code_order_status" ("value","label","seq") VALUES (...);  -- 枚举值转义
```text

- Table name / schema go through the `safeIdent` allow-list; enumeration value / label are single-quote escaped (`'' ` escaping, no free-form SQL).
- The landing result is written back to `landed/landedTable/landedAt`; landing can be repeated (idempotent DELETE+INSERT).
- Landing reuses the same execution as the metrics `execSql` (unified admin identity / Redshift Data API / polling).

---

## 5. Data standards → OpenMetadata Glossary (optional enhancement; failure does not block)

A data standard naturally corresponds to an OM **Glossary Term** (business term). If `isOmConfigured()`:
- When a standard is created, `PUT /v1/glossaryTerms` (filed under the glossary `bgp-data-standards`, created first if it does not exist).
- Fire-and-forget (the same pattern as om-push); OM being unavailable does not affect the storage of the standard itself.

> The first slice does "storage + UI + code-table landing" first; the OM Glossary push is a bonus; if OM is not configured at the moment, skip it (and log).

---

## 6. API design (RBAC + audit, following the metrics store pattern)

```
GET    /api/modeling/layers                list layers (any logged-in user)
POST   /api/modeling/layers                create layer (platform administrator)
PUT    /api/modeling/layers/[id]           update (platform administrator)
DELETE /api/modeling/layers/[id]           delete (platform administrator)
POST   /api/modeling/layers/seed           one-click preset ODS/DWD/DWS/ADS (platform administrator, idempotent)

GET/POST/PUT/DELETE  /api/modeling/domains[/id]      data domains / subject areas (tree)
GET/POST/PUT/DELETE  /api/modeling/standards[/id]    data standards
GET/POST/PUT/DELETE  /api/modeling/codetables[/id]   code tables
POST   /api/modeling/codetables/[id]/land            land a code table in Redshift (platform administrator)

GET/PUT  /api/modeling/assets?fqn=...      table / metric ownership of layer / domain (PUT: platform administrator)
```text

Uniformly: `resolveIdentity` → 401; write operations `isPlatformAdmin` → 403; `apiOk/apiError`; writes record `recordAudit`.

---

## 7. Front end (the "Data Modeling" page, tabs)

`app/modeling/page.tsx` — top-level tabs:
- **Warehouse layers**: cards / list showing ODS→DWD→DWS→ADS (ordered by seq) + schema mapping; a "one-click preset" button; create / edit / delete modals.
- **Data Domain**: two-level tree (data domain → subject area); create / edit / delete.
- **Data Standard**: table (standard name / code / type / unit / linked code table); create / edit / delete modal.
- **Code table**: list + expandable enumeration items; a "Land in Redshift" button (shows the landing state).

Non-administrators: read-only (write buttons hidden / disabled), consistent with the existing pages. The navigation entry goes under the "Data Governance" or "Data Development" group.

---

## 8. Implementation steps (each step: local verification + deployment + real verification + local commit, no push)

```
M1 Design document (this file). ✅
M2 Infrastructure: database-stack.ts adds 5 tables + dynamodb.ts adds the TABLES constants; cdk synth; deploy DatabaseStack.
M3 Service layer lib/modeling/: layers/domains/standards/codetables/assets CRUD + code-table landing + OM Glossary; unit tests.
M4 API routes lib/modeling → app/api/modeling/* (RBAC + audit).
M5 Front end app/modeling/page.tsx (tabs) + navigation entry; tsc.
M6 Deploy PlatformStack; headless browser end-to-end verification (create layer / domain / standard / code table + land code table; 0 console errors / 0 5xx).
M7 Write back to the roadmap progress table (data modeling, first slice); request approval to commit after the security gate.
```text

---

## 9. Acceptance criteria

- Warehouse layers: one-click preset of ODS/DWD/DWS/ADS succeeds and the schema mapping is visible; custom layers can be created / edited / deleted.
- Data domains: a data domain + subject areas beneath it (two levels) can be created, and the tree renders correctly.
- Data standards: standard fields can be created / edited / deleted and linked to a code table.
- Code tables: a code table + enumeration items can be created; "Land in Redshift" succeeds (the dim_code_xxx table really exists in Redshift and contains the enumeration rows).
- RBAC: non-administrators are read-only and write operations return 403; every write operation is visible in the audit log.
- Site-wide headless regression: 0 console errors / 0 5xx; existing features unaffected.
- Cost: zero new standing charges (pure DynamoDB pay per request + reuse of Redshift).

---

## 10. Hand-off to what follows (second-slice iteration)

- **Dimensional modeling**: dimension / fact table registration, reusing this module's layers / domains + the DDL generation of glue-script-generator, one-click creation of Redshift dimension / fact tables.
- **Metric system**: on top of the [metrics store](./metrics-store.md) lightweight metrics, add a metadata modeling layer of atomic metrics (bound field + aggregation) → derived metrics (atomic + modifiers + time period);
  computation still reuses the metrics execSql; metrics are assigned to data domains.
- **Lineage attachment**: table / metric ownership (bgp-model-assets) can be linked with the [SQL lineage](./sql-lineage-impact.md) for "domain-level impact analysis".
- **Governance health score ([governance deepening](./governance-deepening.md))**: layering compliance rate / standard coverage / code-table landing rate can feed the governance health score.

---

## 11. Detailed design of the second slice (dimensional / fact modeling + metric system + OM Glossary)

> - Revision 1.1 | 2026-06-26. The second slice adds a "modeling-entity layer" on top of the first-slice planning layer (layering / domains / standards / code tables):
> - **dimension table / fact table registration → one-click generation and application of Redshift DDL → lineage attachment**;
> - **metric system (atomic → derived, modifiers + time periods) → safe aggregate computation** (a governance modeling layer above the [metrics store](./metrics-store.md), which stays untouched).
> - 💰 Still pure metadata + reuse of the existing Redshift; **zero new standing charges**.

### 11.0 Slices and cadence
- **Commit one = dimensional modeling** (dimension / fact modeling + DDL generation / application + lineage + front-end tab + headless verification), closed first.
- **Commit two = metric system** (metric system + OM Glossary push + front-end tab + headless verification).
- Each of the two is deployed independently + verified headlessly end to end + committed locally (no push).

### 11.1 Reused foundation (new reuse in the second slice)

| Reused | Source | How it is reused |
|---|---|---|
| Safe aggregate SQL (safeIdent / aggExpr / quoteTable / Redshift execSql) | `lib/metrics/service.ts` | Metric computation copies the same safety pattern directly |
| Safe SQL utilities (safeIdent / sqlString / execStatements) | `lib/modeling/redshift.ts` (first slice) | Dimensional-modeling DDL generation / application extends this |
| Real Redshift schema introspection | `lib/genbi/schema.ts` introspectSchema | Write-back / validation after applying DDL (optional) |
| OM table entity push (create-if-absent, never clobber) | `lib/openmetadata/om-push.ts` ensure*/putTable | Push the table entity to the governance catalog after apply |
| OM client (omRequest / isOmConfigured) | `lib/openmetadata/om-client.ts` | Glossary push for dimensional modeling / metric system |
| Modeling asset ownership (setAssetBinding / getAssetBinding) | `lib/modeling/service.ts` (first slice) | A created table is attached to layer / domain; a metric is attached to a domain |

### 11.2 Data model (2 new DynamoDB tables, reusing the hardened option)
```
bgp-model-tables        dimension table / fact table registration
  pk = "modeltable"      sk = modelTableId (ULID)
  {
    modelTableId, name (logical name), tableType ("dimension"|"fact"),
    layerId?, domainId?,                         // ownership (layer / domain, attached via bgp-model-assets)
    schema (target Redshift schema), physicalTable (physical table name),
    columns: [{ name, dataType, length?, precision?, scale?, nullable, isPrimaryKey,
                comment?, standardId? (linked data standard) }],
    // dimension-specific
    scdType? ("SCD1"|"SCD2"), businessKey? (business key column name),
    // fact-specific
    grain? (grain description), dimensionRefs?: [modelTableId] (linked dimension tables), measures?: [column names],
    applied? (created in Redshift or not), appliedTable? (schema.table), appliedAt?,
    createdBy?, createdAt, updatedAt
  }

bgp-model-metrics       metric system (atomic / derived)
  pk = "modelmetric"     sk = modelMetricId (ULID)
  {
    modelMetricId, name, metricType ("atomic"|"derived"),
    domainId? (owning data domain), caliber? (business definition), unit?, format?,
    // atomic metric
    fqn?, agg? ("count"|"count_distinct"|"sum"|"avg"|"min"|"max"), measureColumn?,
    // derived metric
    atomicId? (sk of the referenced atomic metric), timeWindow? (enumeration, see 11.5),
    modifiers?: [{ column, op ("="|"!="|">"|">="|"<"|"<="|"in"), value (string|string[]) }],
    timeColumn? (time column needed by a derived metric for the time-window filter; an atomic metric may carry a default),
    lastValue?, lastComputedAt?,
    createdBy?, createdAt, updatedAt
  }
```text
> Design trade-off: continues the first slice's "single logical partition + ULID sort key". **The metric system is independent of `bgp-metrics` ([metrics store](./metrics-store.md))**: the metrics store = quick
> single-value metrics (running, untouched); `bgp-model-metrics` = the governance metric system (atomic → derived). Both computations share the same safe aggregation, but
> the metadata lives in separate tables and neither pollutes the other.

### 11.3 DDL generation for dimensional modeling (pure function + data-type allow-list, zero injection surface)
Extend `lib/modeling/redshift.ts` with a new pure function `buildCreateTableStatements(spec)`:
```sql
CREATE SCHEMA IF NOT EXISTS "dwd";
CREATE TABLE IF NOT EXISTS "dwd"."dim_user" (
  "user_key"   BIGINT       NOT NULL,   -- 业务主键
  "user_name"  VARCHAR(128),
  "reg_date"   DATE
);
COMMENT ON COLUMN "dwd"."dim_user"."user_name" IS '用户名';   -- 列注释(标准/comment)
```
- **Identifiers** (schema / table / column) all go through the `safeIdent` allow-list (`^[A-Za-z_][A-Za-z0-9_]*$`) + double quotes.
- **Data-type allow-list**: `DDL_TYPES = {VARCHAR,CHAR,INTEGER,BIGINT,SMALLINT,DECIMAL,DOUBLE PRECISION,REAL,BOOLEAN,DATE,TIMESTAMP,TIMESTAMPTZ,SUPER}`.
  - Types with a length (VARCHAR/CHAR) → `TYPE(len)`; len is coerced to a positive integer, out-of-range values fall back to the default;
  - DECIMAL → `DECIMAL(precision,scale)`; p/s are coerced to numbers and clamped to the legal range;
  - all other parameterless types use the keyword directly. **A free-form type string is never accepted** (anything not in the allow-list is rejected).
- **Comment values** are single-quote escaped by `sqlString`. The whole DDL contains no free-form user SQL fragment.
- Extracted as a pure function → Jest unit tests (type mapping, length / precision clamping, illegal identifier / illegal type throws, injection strings are escaped).

**Apply**: `applyModelTable(id)` = `buildCreateTableStatements` → `execStatements` (the first slice's sequential execution with polling) →
write back `applied/appliedTable/appliedAt` → call `setAssetBinding` (attach layer / domain) → best-effort push of the OM table entity.
`previewDDL(id)` only returns the DDL text and executes nothing. A fact table's `dimensionRefs` is a metadata association only (no enforced foreign key; Redshift has no enforced foreign keys).

### 11.4 Lineage attachment for dimensional modeling
- Create / update a dimension or fact table → write `bgp-model-assets` (fqn = `bgp-redshift.<db>.<schema>.<physicalTable>`, kind="table", bound to layerId/domainId).
- After applying the DDL → `pushModelTableToOM` (reusing ensureService/putDatabase/putSchema/putTable of om-push,
  overwriting the placeholders with the real columns), so that the new table appears in the governance catalog immediately; the fact → dimension `dimensionRefs` can later become lineage edges (optional in the second slice).

### 11.5 Metric computation (safe predicates, enumerated time windows)
- **Atomic metric**: `SELECT <aggExpr> FROM <quoteTable(fqn)>`, reusing `aggExpr`/`safeIdent`/`quoteTable` of the [metrics store](./metrics-store.md).
- **Derived metric**: adds a `WHERE` on top of the atomic metric —
  - **Modifiers**: `column` goes through `safeIdent`; `op` is allow-listed (`= != > >= < <=` / `in`); `value` is escaped by `sqlString`
    (`in` → `(v1,v2,…)`, each escaped); numbers and strings are both passed as string literals and left to Redshift's implicit conversion.
  - **Time window**: an enumeration mapped to safe predicates (no free-form expressions accepted):
    `7d/30d/90d` → `<timeColumn> >= DATEADD(day,-N,CURRENT_DATE)`;
    `mtd` → `>= DATE_TRUNC('month',CURRENT_DATE)`; `ytd` → `>= DATE_TRUNC('year',CURRENT_DATE)`;
    `today` → `::date = CURRENT_DATE`; `all` → no time filter. timeColumn goes through `safeIdent`.
- The computation lands in `lastValue/lastComputedAt` (the same pattern as the metrics store); optionally a snapshot (the second slice does not connect to metric-values yet, to avoid cross-table coupling).
- **Zero injection surface**: no free-form SQL anywhere; columns / tables / time columns allow-listed, values escaped, op / time window enumerated. Covered by unit tests.

### 11.6 OM Glossary push (best-effort, non-blocking)
- Data standards (already stored in the first slice) → OM Glossary Term: `ensureGlossary("bgp-data-standards")` → `PUT /v1/glossaryTerms`
  ({name = standard name, glossary, description = definition + type + unit}). Fire-and-forget when a standard is created / updated.
- Metric-system metrics → the same Glossary (or a separate glossary `bgp-metrics`); term = metric name + definition.
- Guarded throughout by `isOmConfigured()`; if OM is unavailable it is skipped outright (and logged) and never affects the primary storage.
- Implementation location: `lib/openmetadata/om-glossary.ts` (new), called by the modeling service.

### 11.7 API (RBAC: read when logged in / write as administrator + audit, following the first-slice pattern)
```text
# dimensional modeling
GET/POST            /api/modeling/dimensions            list / create (administrator)
PUT/DELETE          /api/modeling/dimensions/[id]       update / delete (administrator)
GET                 /api/modeling/dimensions/[id]/ddl   DDL preview (logged in)
POST                /api/modeling/dimensions/[id]/apply apply to Redshift (administrator)
# metric system
GET/POST            /api/modeling/model-metrics         list / create (administrator)
PUT/DELETE          /api/modeling/model-metrics/[id]    update / delete (administrator)
POST                /api/modeling/model-metrics/[id]/compute  compute (logged in; read-only against Redshift)
```
Uniformly `resolveIdentity` → 401; write / apply `isPlatformAdmin` → 403; `apiOk/apiError`; writes record `recordAudit`.

### 11.8 Front end (2 new tabs on the Data Modeling page)
- **Dimensional modeling**: table (logical name / type / owning layer and domain / physical table / applied) + a create modal (basic information + column editor: column name / type / length / nullable / primary key / comment / linked standard) + "Preview DDL" (read-only dialog) + an "Apply to Redshift" button (administrator; shows the applied state).
- **Metric system**: table (metric name / type / owning domain / definition / latest value) + a create modal (atomic: table / aggregation / measure column; derived: pick the atomic metric + modifier list + time-window dropdown) + a "Compute" button (shows the resulting value).
- Reuses the Tabs / Modal / RBAC / authedFetch framework of the first-slice page; non-administrators are read-only.

### 11.9 Acceptance criteria (second slice)
- Dimensional modeling: create a dimension table → DDL preview is correct (types / comments) → apply succeeds → **the table verifiably exists in Redshift (hard evidence)** → visible in the governance catalog → ownership (bgp-model-assets) written.
- Metric system: create an atomic metric → a value is computed; create a derived metric (with modifiers + time window) → a value is computed and the predicates are correct.
- Security: all DDL / metric SQL is allow-listed / enumerated / escaped; unit tests cover injection cases.
- RBAC: non-administrators are read-only; write / apply return 403; write operations are visible in the audit log.
- Site-wide headless regression: 0 console errors / 0 5xx; the first slice and existing features unaffected. Zero new standing charges. Verification artefacts cleaned up.
