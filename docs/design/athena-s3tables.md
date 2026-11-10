# Athena Queries on S3 Tables (Iceberg)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is summarized in the [modules overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> - Design revision: 1.16.0 | Status: in progress
> - Related designs: Redshift Query (no separate design document), [OpenMetadata ingestion](./openmetadata-ingestion.md), [multi-tenancy / RBAC](./multitenancy-rbac.md), Data Sync (writes to S3 Tables; no separate design document)

## 1. Background and goals

The platform could already query Redshift, but had no query entry point at all for **S3 Tables (the Iceberg table bucket `bgp-table-bucket`, namespace `ecommerce`)**. Data Sync lands source-database data in S3 Tables, yet the only way to look at it was the metadata in the governance catalog — no direct SQL exploration. This module delivers the end-to-end capability of **querying S3 Tables with Amazon Athena**: infrastructure (workgroup + result location + IAM), a read-only back-end execution API, and a front-end query page.

## 2. Feasibility probe conclusion (a key prerequisite)

An earlier recorded pitfall said: "in the workshop account the Lake Formation administrator list was empty and could not be granted, and the ingestion role got AccessDenied on every S3 Tables schema read". This time a **probe was run first**, with the conclusion: **Athena queries on S3 Tables are fully feasible and are not blocked by LF**.

Evidence (a test account / us-east-1, 2026-06-15):
- Executing `SELECT * FROM "s3tablescatalog/bgp-table-bucket"."ecommerce"."products" LIMIT 10` in the `data-exploration` workgroup → **SUCCEEDED**, returning real data (Chinese product names), 1223 bytes scanned, with complete ColumnInfo.
- `lakeformation get-data-lake-settings`: `DataLakeAdmins` is **not empty** and contains `WSParticipantRole` (the current identity is an LF administrator) + `WSSystemRole` — unlike the "administrator list empty" state recorded in the earlier pitfall (the account had been changed / reset).
- The Glue multi-level catalog already registers the federated catalog `s3tablescatalog` (`CatalogId <account>:s3tablescatalog`, connection `aws:s3tables`), whose `CreateTable/DatabaseDefaultPermissions = IAM_ALLOWED_PRINCIPALS ALL` → **IAM is the authorization**, no per-table explicit LF grant is needed.
- The S3 Tables namespace `ecommerce` has 4 tables: `customers / order_items / orders / products`.

**Remaining risk**: the probe ran as an LF administrator (WSParticipantRole); the platform's ECS **TaskRole is a non-administrator identity**. The infrastructure in the next section closes this gap.

## 3. Architecture

```
front end: /athena query page ──► /api/athena/* ──► Amazon Athena (workgroup bgp-athena)
   │  left: S3 Tables table tree    StartQueryExecution → poll GetQueryExecution → GetQueryResults
   │  right: SQL editor / results        │ queries use the 3-part name "s3tablescatalog/bgp-table-bucket"."ecommerce"."<table>"
   └─ read-only guard (front + back end) ▼
                       Glue federated catalog s3tablescatalog ──► S3 Tables table bucket bgp-table-bucket
                       results written to s3://bgp-datalake-<account>/athena-results/ (SSE_S3)
```

- The federated catalog is **discovered automatically through the Glue multi-level catalog**; there is no need to register a separate DataCatalog in Athena. Queries use the 3-part name `"<catalog>"."<namespace>"."<table>"`, with catalog = `s3tablescatalog/bgp-table-bucket`.

## 4. Infrastructure (CDK, PlatformStack)

1. **Athena workgroup `bgp-athena`** (`CfnWorkGroup`, self-managed, independent of the workshop's `data-exploration` / `data-lake-stagings3bucket-*`):
   - `ResultConfiguration.OutputLocation = s3://bgp-datalake-<account>/athena-results/` (the bucket already exists); `EncryptionConfiguration = SSE_S3`.
   - `EnforceWorkGroupConfiguration = true` (the result location / encryption are enforced and cannot be overridden by clients).
   - `EngineVersion = Athena engine version 3`; `PublishCloudWatchMetricsEnabled = true`; `RemovalPolicy = DESTROY`.
2. **TaskRole gains `athena:*`** (`StartQueryExecution` / `GetQueryExecution` / `GetQueryResults` / `StopQueryExecution` / `ListWorkGroups` / `GetWorkGroup` / `ListDataCatalogs` / `GetDataCatalog` / `GetDatabase` / `GetTableMetadata`, and so on).
   - The remaining permissions **are already present**: `s3tables:*`, `lakeformation:*` (including `GetDataAccess`), `glue:*` (`AWSGlueConsoleFullAccess`), `AmazonS3FullAccess` (can write the results bucket + read the underlying data).
3. **Container environment variables**: `ATHENA_WORKGROUP=bgp-athena`, `ATHENA_OUTPUT_LOCATION=s3://bgp-datalake-<account>/athena-results/`, `S3TABLES_BUCKET=bgp-table-bucket`, `S3TABLES_CATALOG=s3tablescatalog`, `S3TABLES_NAMESPACE=ecommerce`.

**LF authorization strategy**: rely on the federated catalog's default `IAM_ALLOWED_PRINCIPALS` (IAM is the authorization) + the TaskRole's existing `lakeformation:GetDataAccess`, the same path the existing `glueRole` uses to query / write S3 Tables (already proven to work by Data Sync). **No explicit `CfnPrincipalPermissions` is introduced** — this avoids a deployment blocked by a CloudFormation execution role that is not an LF administrator. If LF strict mode is adopted in the future, explicit SELECT / DESCRIBE grants are added then.

## 5. Back end (`lib/athena/*` + `app/api/athena/*`)

- `lib/athena/client.ts`: wraps `runQuery` (StartQueryExecution, injecting the workgroup) / `getExecution` (GetQueryExecution status + statistics) / `getResults` (GetQueryResults, ColumnInfo → columns, Rows → rows, dropping the header row, supporting nextToken) / `stopQuery` (StopQueryExecution).
  <br>⚠️ (audit calibration, 2026-08-26) the exported function that starts a query is named **`startQuery`** (not `runQuery`), with the signature `startQuery(query, context?)`; `context` may carry catalog / database (client.ts:39).
- `lib/athena/sql-guard.ts`: the **read-only guard** (application-layer defense, same idea as the GenBI `sql-guard`). Only a single `SELECT/WITH/SHOW/DESCRIBE/EXPLAIN` statement is allowed; `insert/update/delete/drop/create/alter/truncate/grant/revoke/merge/...` are forbidden as whole words; `SELECT/WITH` is wrapped in `SELECT * FROM (...) LIMIT N` as a row-count safety net, while `SHOW/DESCRIBE/EXPLAIN` pass through unchanged.
  <br>⚠️ (audit calibration, 2026-08-26) the guard logic **has been moved down into `@/lib/genbi/core/sql-guard`** (shared with the Athena path of the genbi-skills Lambda); this file now **only re-exports** `sanitizeReadOnly` + keeps the `AthenaGuardResult` type alias (athena/sql-guard.ts:10-14).
- `lib/athena/s3tables.ts`: enumerates namespaces + tables with the s3tables API (`ListNamespaces` / `ListTables`) for the front-end table tree; returns the 3-part qualified name of every table.
- API (all `force-dynamic`):
  - `POST /api/athena/query` — `requireProject(viewer)` + read-only guard → StartQueryExecution → `{queryExecutionId}`.
  - `GET  /api/athena/query/[id]` — GetQueryExecution → `{state, stats(bytes scanned / elapsed time), error}`.
  - `GET  /api/athena/query/[id]/results` — GetQueryResults → `{columns, rows, nextToken}`.
  - `POST /api/athena/query/[id]/stop` — StopQueryExecution.
  - `GET  /api/athena/tables` — the S3 Tables namespace + table tree.
- **RBAC / read-only**: `requireProject` is reused (read = viewer). **Uniformly read-only**; no write / DDL is exposed. The operations-analyst account (analyst-only) is **not authorized** for Athena (its allow-list contains only Ask-Your-Data + raising requests), so `middleware.ts` does not add `/api/athena`.

## 6. Front-end `/athena` query page (under the "Data Development" category)

- Modeled on the `/redshift` page: on the left the **S3 Tables table tree** (clicking a table generates `SELECT * FROM "s3tablescatalog/bgp-table-bucket"."ecommerce"."<table>" LIMIT 100`), on the right a Monaco SQL editor + execute / cancel + a result table + execution statistics (bytes scanned, elapsed time).
- Polls `GET /api/athena/query/[id]` until `SUCCEEDED/FAILED/CANCELLED`, then fetches `results` on success.
- `Sidebar.tsx`: the "Data Development" category gains the leaf "Athena Query" (`/athena`, icon `CloudOutlined` / `FunctionOutlined`).

## 7. Not done / scope control

- No new DynamoDB table; no "save task" (to differentiate from the Redshift page); query history uses front-end session state for now.
- No explicit LF authorization and no separate Athena DataCatalog (automatic federated-catalog discovery + IAM_ALLOWED_PRINCIPALS suffice).
- GenBI is not changed (GenBI still queries only Redshift).
  <br>⚠️ (audit calibration, 2026-08-26) this item is **outdated**: GenBI now supports the `athena` engine — when `engine === "athena"` it queries the data-lake S3 Tables namespace (genbi/athena.ts; genbi/agent.ts:93-94 `isAthena`; cookbookGuard follows the athena dialect), so it no longer queries only Redshift.

## 8. Live verification plan

- API: StartQueryExecution → poll → GetQueryResults succeeds for the three tables (products / customers / orders); the read-only guard rejects `DROP/INSERT`; privilege overreach (a non-member of the project) gets 403.
- Playwright headless: admin logs in → /athena → clicks products in the table tree → execute → the result table renders (asserting Chinese product names / column names). The test data carries a retention marker and is kept.
