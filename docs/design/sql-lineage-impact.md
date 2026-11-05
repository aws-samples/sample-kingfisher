# Design — Automatic SQL Lineage Parsing + Impact Analysis (Governance Depth, First-Priority Track)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is summarized in the [modules overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> Revision: 1.8.0 | Date: 2026-06-14 | Status: implemented and verified in a live environment
> Addresses the gap-analysis item "Automatic SQL lineage parsing + impact analysis" under the "re-check / first-priority track · governance depth" heading. This is the second item delivered in the first-priority track (the first was run parameterization, revision 1.7.0).

---

## 0. Goals

The platform already has **source → S3 Tables → Redshift column-level lineage** pushed by **sync tasks** (revision 1.0.6, stored in OpenMetadata). But the table dependencies produced by **SQL written by users themselves** (Redshift SQL jobs in job development, SQL tasks saved in Redshift Query) did not enter the lineage graph until now.

This release adds two things:

1. **Automatic SQL lineage parsing**: parse out of Redshift SQL text "which table this statement / this batch of statements writes, and which tables it reads", automatically generate **table-level lineage** and push it to OpenMetadata (the system of record), on the same graph and with the same FQNs as the sync lineage.
2. **Impact analysis**: given a table, follow the downstream lineage to answer "if this table is changed or dropped, which downstream tables are affected, and which jobs / tasks are affected", visualized on the Data Governance page.

**Reuse instead of rebuild**: lineage keeps **OpenMetadata as the single source of truth** (no new DynamoDB table); the push reuses the entity ensure logic of `om-push.ts` plus `/api/v1/lineage` edges; reading reuses the ReactFlow rendering already on the Data Governance page and the existing OM lineage read path. **Only the Platform is redeployed; there is no infrastructure change.**

---

## 1. Parsing scope and method

### 1.1 Scope (this release)

| Source | Field | Notes |
|------|------|------|
| ETL jobs (job development) | `script` of jobs with `type=redshift` | code-first Redshift SQL jobs, clearly structured |
| Saved Redshift tasks | `sql` in `bgp-redshift-tasks` | tasks saved from the SQL editor |

- **Out of scope for this release**: Glue PySpark (arbitrary Python; table reads and writes are hidden behind DataFrame / connector APIs, so text parsing is unreliable); CDC / Flink. Glue lineage continues to be pushed by sync-task events (already in place).
- **Granularity**: **table level**. Column-level SQL lineage (an exact mapping from select columns to target columns, including expressions) is complex and error-prone to parse and is not done in this release; the column-level lineage of the sync path is unaffected and keeps working as before.

### 1.2 The heuristic parser `lib/lineage/sql-lineage.ts`

A pure function, no external dependencies, never throws (a parse failure returns an empty result; best-effort). Same style as the existing `splitSql` / `renderTemplate` (the project's established lightweight SQL text processing). The reason for choosing a heuristic over introducing an AST parsing library (such as `node-sql-parser`): AST libraries do not fully cover the Redshift dialect (CTAS, `CREATE EXTERNAL TABLE`, `UNLOAD`, `COPY`, and so on) and throw for the whole statement when they meet unsupported syntax; a heuristic extraction of "target + sources" is more robust and matches the best-effort positioning of lineage.

Processing flow (per statement, split on `;`):

1. **Denoise**: strip block comments `/* */` and line comments `--`, and replace string literals (`'...'` / `"..."`) with placeholders so that keywords / table names inside strings are not mistaken for SQL structure.
2. **Recognize CTE names**: `WITH [RECURSIVE] a AS (...), b AS (...)` → collect `a,b` and exclude them from the sources (CTEs are not real tables).
3. **Recognize the write target** (decides which table this statement produces):
   - `CREATE [OR REPLACE] [TEMP] TABLE [IF NOT EXISTS] <t> AS` → CTAS
   - `CREATE [OR REPLACE] [MATERIALIZED] VIEW [IF NOT EXISTS] <t> AS` → view
   - `INSERT INTO <t> ...`
   - `MERGE INTO <t> ...`
   - `UPDATE <t> SET ... [FROM ...]`
   - `DELETE FROM <t> [USING ...]`
4. **Recognize the sources**: every table captured by `FROM <t>` / `JOIN <t>`; the right-hand tables of `UPDATE...FROM` / `DELETE...USING` / `MERGE...USING`.
   - Distinguish `JOIN ... USING (col)` (followed by `(`; a column join, **not** a table) from `MERGE/DELETE ... USING <table>` (followed by an identifier).
5. **Normalize** every table reference into `{database, schema, table}`: strip quotes, lowercase, split on dots (1 part → default schema; 2 parts → `schema.table`; 3 parts → `db.schema.table`), defaulting to `database=dev` and `schema=public` (the Redshift defaults).
6. **Aggregate edges**: aggregate across statements; an edge is a deduplicated `(source → target)`; drop self-loops, drop CTEs, drop the case where the target itself appears in FROM.

Output:
```ts
interface SqlLineageResult {
  targets: TableRef[];           // 本批 SQL 写入的表
  sources: TableRef[];           // 本批 SQL 读取的真实表（已去 CTE）
  edges: { from: TableRef; to: TableRef }[];  // 表级血缘边
  statements: { kind, target?, sources[] }[]; // 逐语句明细（供预览展示）
}
```

`tableFqn(ref)` → `bgp-redshift.<db>.<schema>.<table>` (identical to the Redshift FQN used by sync / ingestion, so no duplicate entities are created).

---

## 2. Pushing to OpenMetadata (`om-push.ts` gains `pushSqlLineageToOpenMetadata`)

Best-effort, never throws. Steps:

1. `ensureService("bgp-redshift", ...)` (create-if-absent, reusing the existing logic; never clobbers a service owned by the ingestion connector).
2. For the two tables at the ends of every edge: **ensure-if-absent** (first `getEntityByName("tables", fqn)`; skip if it exists; only when it does not exist create the database / create the schema / create a minimal stub table) — **key point: the real columns of an existing table are never overwritten** (so a schema pushed up by ingestion / sync is not flattened). A newly created stub table is annotated with a `description` whose Chinese text reads "created by automatic SQL lineage parsing (placeholder)".
3. `addLineage(fromFqn, toFqn, { sqlQuery, description })`: a table-level edge; `lineageDetails.sqlQuery` carries the SQL that produced the edge (truncated), `description` carries the name of the originating job / task.

> OM's `PUT /api/v1/lineage` is an upsert for the same (from, to) pair (saving the same job repeatedly does not produce duplicate edges).

---

## 3. Parse trigger points (hooks)

Parsing happens **on save** (it reflects the definition rather than depending on a successful run):

- `POST /api/etl-jobs` (create) + `PUT /api/etl-jobs/[id]` (save): when the final `type=redshift` and a `script` is present → fire-and-forget call to `pushSqlLineageToOpenMetadata` (default db = `redshiftConfig.database||dev`, schema `public`).
- `POST /api/redshift/tasks` + `PUT /api/redshift/tasks/[id]`: when `sql` is present → same as above.

All of them `.catch(()=>{})`; **saving is never blocked** (consistent with the behavior when OM is unreachable / not configured).

---

## 4. Impact analysis

### 4.1 API `GET /api/governance/impact?fqn=<tableFqn>&depth=N` (`requireAuth`)

1. Read the **downstream** lineage from OM (`/api/v1/lineage/table/name/<fqn>?downstreamDepth=N`) and BFS out the set of affected tables (with a `depth` level).
2. **Job enrichment**: scan `bgp-etl-jobs` (redshift) + `bgp-redshift-tasks`, parse their SQL on the fly, and annotate:
   - `writes` (producers): jobs whose target table ∈ the affected set;
   - `reads` (consumers, directly affected): jobs / tasks whose source tables include the queried table.
3. Return `{ centerNode, nodes, edges, impacted:[{fqn,depth,type}], jobs:[{id,name,resourceType,role}] }` — `nodes/edges` have the same shape as the lineage API, so the front end renders them directly with the existing ReactFlow.

> Impact analysis is a governance / administrator-level read-only view; job enrichment is a cross-workspace scan (consistent with the authorization for reading the governance catalog; `requireAuth` is sufficient).

### 4.2 Parse preview API `POST /api/lineage/parse {sql, database?, schema?}` (`requireAuth`)

Pure parsing; writes nothing, does not touch OM. Returns a `SqlLineageResult` for the instant "Parse lineage" preview on the job development page (this SQL writes X and reads Y / Z).

---

## 5. Front end

- **Data Governance page**: a new **"Impact analysis"** tab: pick a table (reusing the catalog FQN options) → downstream impact graph (ReactFlow, center highlighted) + an "Affected data assets" table (FQN / level) + an "Affected jobs / tasks" table (name / type / read or write). Every catalog row gets an "Impact analysis" button that jumps to the tab and positions on that table in one click.
- **Job development page** (Redshift SQL jobs): the script editor toolbar gets a **"Parse lineage"** button → calls the preview API and pops up a "written tables / read tables / edges" summary; a hint says "after saving, lineage is synchronized to Data Governance automatically".

---

## 6. Security / red lines

- No new DynamoDB table; lineage lives only in OM. Only the Platform is redeployed, and the deployment **must** carry `-c openmetadata-url=<OM CloudFront>`.
- Push / parse are entirely best-effort; when OM is not configured or unreachable they are skipped silently and never block saving a job / task.
- The new APIs go through `requireAuth` (Cognito ID token).

---

## 7. Live verification (a test account / us-east-1)

1. `POST /api/lineage/parse` with multiple cases (CTAS, `INSERT...SELECT...JOIN`, `WITH` with CTEs, `UPDATE...FROM`, `DELETE...USING`, `CREATE VIEW`) → targets / sources / edges correct, CTEs excluded.
2. Create a Redshift SQL job (`CREATE TABLE public.t_impact_demo AS SELECT ... FROM public.customers JOIN public.orders ...`) → save → OM shows the table-level edges `customers→t_impact_demo` and `orders→t_impact_demo` (visible under "Data Lineage" in Data Governance).
3. `GET /api/governance/impact?fqn=bgp-redshift.dev.public.customers` → the affected tables include `t_impact_demo`, the affected jobs include that job (role=writes, and it is a downstream consumer of customers).
4. Cleanup: delete the test job and table (leftover version rows are harmless).

---

## 8. Known limitations / follow-ups

1. **Table-level** lineage (this release); column-level SQL lineage (including expression mapping) is a follow-up.
2. The heuristic parser covers common Redshift DML / DDL; highly dynamic SQL (string concatenation, `EXECUTE`) and `COPY/UNLOAD` (S3 ↔ Redshift) are not included (a follow-up could add `COPY FROM 's3://...'` → table edges).
3. Glue PySpark lineage cannot be derived reliably by static parsing and is not in this release (sync-event lineage already covers the sync path).
4. Job enrichment in impact analysis is an on-demand full scan plus on-the-fly parsing (the job count is small, which is sufficient); at scale it can be changed to a `parsedLineage` index written on save.
5. Parsing is triggered on save and reflects the "definition"; it may differ from the actual run (for example a branch not taken and therefore nothing written) — lineage expresses potential dependencies, which matches governance semantics.
