# OM-IngestionMetadata — End-to-End Metadata Ingestion and Synchronization with OpenMetadata

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is described in the [module overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> Priority: highest | Module: Data Governance (OpenMetadata) | Status: design reviewed and approved, being implemented phase by phase
> Revision: design revision 1 | Date: 2026-06-10
> Target release: v1.0.3 and later (released iteratively, one phase at a time)

---

## 0. Decision Summary (confirmed with the owner)

| Decision point | Conclusion |
|--------|------|
| Role of OpenMetadata | **The system-level source of truth (System of Record) for "data catalog + lineage"**; the governance pages switch to reading from OM |
| Ingestion runtime | **EventBridge Scheduler → scheduled ECS Fargate tasks** running the official `openmetadata/ingestion` image (no resident Airflow) |
| Delivery approach | **Iterative**, one phase at a time. **Scope of this round: Phase 0 + Phase 1** (first make "data is visible inside OM" work end to end) |
| Platform control plane | DynamoDB keeps only operational configuration (data sources / tasks / schedules / run records) and no longer owns catalog or lineage responsibilities |

---

## 1. Background and Problem

### 1.1 Current state (confirmed by measurement)
- OpenMetadata Server (`server:1.6.1`) is already running on ECS Fargate and can be logged into (`admin@open-metadata.org`), but it is **completely empty inside**: `databaseServices / pipelineServices / storageServices / ingestionPipelines / tables` all report `total=0`.
- `OmServiceStack` **deploys only the single server container and no ingestion component**; there is no connector of any kind.
- The platform (`main` in the cloud) **contains no code that writes to OM**; the `/openmetadata` page is merely an iframe embed.
- Data sources of the governance pages: `GET /api/governance/catalog` queries Glue + Redshift directly, and `GET /api/governance/lineage` reads the DynamoDB table `bgp-lineage` — **OM is bypassed entirely**.

### 1.2 Root cause
OM is "installed but not wired up". Metadata lives in **two sources that do not talk to each other**: one on the platform side (DynamoDB + direct queries against Glue/Redshift) and one in OM (empty). The result is what users experience as "there is no data in OM", plus the two sides drifting apart.

### 1.3 The essential problem that must be solved
Real data governance requires OM to collect metadata from **every stage**: source databases → S3 Tables (Iceberg) → Redshift, plus ETL orchestration (MWAA) and the S3 data lake, and to form **end-to-end lineage**. Among these, "cross-system lineage" (`MySQL → S3 Iceberg → Redshift`, including column-level mappings) is ETL intent: a connector cannot derive it, only the platform knows it, so the platform must push it.

---

## 2. Goals and Non-Goals

### 2.1 Goals
1. OM becomes the source of truth for catalog + lineage, covering every data stage of the platform.
2. **Two complementary mechanisms**: periodic connector ingestion (comprehensive, reconciling) + event-driven push (immediate, cross-system lineage).
3. Production grade: idempotent, least privilege, no secrets on disk, observable, retryable, configuration as code.
4. The governance pages (catalog/lineage) switch to reading from OM, eliminating "the two sides are out of sync" once and for all.

### 2.2 Non-goals (not in this design / later iterations)
- Does not replace the platform control plane (DynamoDB still stores operational configuration).
- Does not deliver OM data-quality test suites / Profiler sampling in this round (listed as optional for Phase 4).
- Does not introduce OM's own resident ingestion Airflow (the decision is to use scheduled ECS tasks).

---

## 3. Design Principles

- **Single source of truth**: catalog and lineage are authoritative in OM; the platform reads OM instead of every page querying on its own.
- **Idempotency first**: every write goes through `PUT createOrUpdate` keyed by FQN and can be re-executed without side effects; connector ingestion itself upserts by FQN.
- **Immediate + reconciling**: event push guarantees that platform operations are "visible immediately"; periodic ingestion is the safety net that corrects drift (new tables / changed columns / dropped tables) and captures query-log lineage.
- **Least privilege + zero plaintext secrets**: automation uses the JWT of OM's `ingestion-bot`; source-database and warehouse passwords are fetched from Secrets Manager at run time; the default `admin/admin` credentials are never used.
- **Configuration as code**: connector configuration (YAML templates + parameters) lives in the repository and is injected per environment.
- **Observable**: the status of every ingestion run is written back to the OM `IngestionPipeline` plus CloudWatch logs/alarms.

---

## 4. Overall Architecture

```
            Platform operations (create data source / create & run sync / publish workflow)
                       │  event-driven push (OM REST API, idempotent upsert)
                       ▼
 ┌────────────────┐  periodic ingestion (connector)  ┌─────────────────────────┐  read catalog/lineage  ┌──────────────────┐
 │ Source MySQL/PG│────────────────────────────────▶ │                         │◀───────────────────────│ Platform         │
 │ Glue/S3 Tables │────────────────────────────────▶ │   OpenMetadata Server   │                        │ governance pages │
 │ Redshift       │────────────────────────────────▶ │   (SoR: catalog +       │                        │ catalog /        │
 │ S3 datalake    │────────────────────────────────▶ │    lineage)             │                        │ lineage          │
 │ MWAA/Airflow   │──(Phase 3)─────────────────────▶ │                         │                        └──────────────────┘
 └────────────────┘                                  └─────────────────────────┘
        ▲                                                       ▲
        │ metadata ingest -c <cfg>                              │ JWT (ingestion-bot, stored in Secrets Manager)
  ┌─────┴───────────────────────────────────────┐
  │ ECS Fargate task (openmetadata/             │  ← launched on schedule by EventBridge Scheduler (one schedule per connector)
  │ ingestion:1.6.1, private subnets, task role)│
  └─────────────────────────────────────────────┘
```

Two data paths:
1. **Periodic ingestion path** (the focus of Phase 1 in this round): EventBridge Scheduler triggers a one-off ECS Fargate task on a cron schedule; inside the container, `metadata ingest -c <connector-config.yaml>` runs and sinks into the OM Server.
2. **Event-driven push path** (Phase 3): at key operations the platform calls the OM REST API to register entities and push cross-system column-level lineage.

---

## 5. Mapping of Each Stage → OM Ingestion

| Stage | Mechanism | OM entity | What is collected | Phase |
|------|------|---------|---------|-------|
| Data sources (source MySQL/PG databases) | MySQL/PG connector (one configuration per data source) | DatabaseService→Schema→Table | Databases / tables / columns / constraints / comments | Phase 2 |
| S3 Tables (Iceberg) | Glue connector (`s3tablescatalog`) | DatabaseService(Glue)→Table | Iceberg table structure / partitions / location | **Phase 1** |
| Redshift | Redshift connector + **usage/lineage** | DatabaseService(Redshift)→Table | Table structure + query-log lineage | **Phase 1** |
| S3 data lake | S3/storage connector | StorageService→Container | Buckets / prefixes / container structure | **Phase 1** |
| ETL orchestration (MWAA) | Platform push (preferred) / Airflow connector | PipelineService→Pipeline | DAG→pipeline entities + pipeline lineage | Phase 3 |
| **Cross-system lineage** | **Event-driven push** | Lineage Edge (with columnsLineage) | Source table→S3→Redshift column-level mappings | Phase 3 |
| Immediate registration of data sources / tasks | Event-driven push | Service/Table/Pipeline | Platform operations become visible immediately | Phase 3 |

> ⚠️ (Audit calibration, 2026-08-26) The row "ETL orchestration (MWAA) → PipelineService→Pipeline" (pipeline entities + pipeline lineage) in the table above **was cancelled by decision**: the platform **only models physical storage / stream nodes (Container/Topic) and does not create pipeline entities** (Glue/DMS/Flink pipelines) — the comment at om-push.ts:249-253 reads "no pipeline entities (Glue/DMS/Flink pipeline) — explicitly decided". Cross-system lineage is still produced (source table→S3→Redshift, column level); it is simply no longer carried by Pipeline entities.

> **Verification point for S3 Tables ingestion**: S3 Tables are exposed in Glue through the `s3tablescatalog` federated catalog. Phase 1 acceptance must confirm whether the OM Glue connector traverses the federated catalog and picks up the Iceberg tables; if it does not, the fallback is the Athena connector or direct collection specific to S3 Tables.

---

## 6. Component Design

### 6.1 Ingestion runtime (Phase 1)
- **Image**: `docker.getcollate.io/openmetadata/ingestion:1.6.1` (strictly aligned with server 1.6.1 to avoid schema incompatibility).
- **Carrier**: one-off ECS Fargate task (`RunTask`), private subnets, no public IP, egress through NAT.
- **Trigger**: EventBridge Scheduler, one schedule per connector (decoupled; each can be retried / disabled independently).
  - Recommended frequencies: metadata every 6 h; Redshift usage/lineage daily; S3 daily.
- **Configuration delivery**: connector YAML is generated from parameterized templates and stored in S3 (`bgp-glue-scripts` or a dedicated prefix) or as an SSM Parameter; the container pulls it at start-up and then runs `metadata ingest -c`. Sensitive fields use `secretsmanager://` placeholders that are resolved at run time.
- **Why not a resident Airflow / MWAA**: a resident Airflow is costly to run and operate; reusing MWAA would let connector dependencies pollute the users' workflow environment and invite version conflicts. Scheduled ECS tasks are billed per run, isolated, and version-controlled.

### 6.2 Connector configuration (config-as-code, illustrative)
```yaml
# redshift.yaml（参数：${OM_HOST} ${JWT} ${RS_HOST} ...）
source:
  type: redshift
  serviceName: bgp-redshift
  serviceConnection:
    config:
      type: Redshift
      hostPort: ${RS_HOST}:5439
      database: dev
      username: ${RS_USER}
      password: ${RS_PASSWORD}     # secretsmanager 注入
  sourceConfig:
    config:
      type: DatabaseMetadata
sink:
  type: metadata-rest
  config: {}
workflowConfig:
  openMetadataServerConfig:
    hostPort: ${OM_HOST}/api
    authProvider: openmetadata
    securityConfig:
      jwtToken: ${JWT}             # ingestion-bot, secretsmanager 注入
```
Redshift usage/lineage is a separate workflow (`type: redshift-usage` / lineage sourceConfig) that is scheduled on its own.

### 6.3 OM service account and secrets (Phase 0)
- Use the JWT of OM's built-in **`ingestion-bot`** (`GET /api/v1/bots/name/ingestion-bot` → take the token of its auth mechanism) and write it to **Secrets Manager** as `bgp/om/ingestion-bot-token`.
- Ingestion tasks authenticate with this JWT; **the default `admin/admin` credentials are not used**.
- Source-database / Redshift passwords: connection configurations reference existing or newly created Secrets Manager secrets; the task role is granted `GetSecretValue` only on the corresponding secrets.

### 6.4 Event-driven push (Phase 3; reuses and modernizes the legacy `lib/openmetadata/*`)
- The platform wraps `omRequest` (with ingestion-bot JWT caching, retry on 401 and tolerance of 409 — the legacy `om-client.ts` already contains a prototype).
- Trigger points: create data source / create & run sync / publish workflow → `createOrUpdate` the corresponding OM entity; when a sync runs, `PUT /api/v1/lineage` pushes the **column-level columnsLineage** for `source→S3→Redshift` (taken from the task's `fieldMappings`).

### 6.5 Governance pages switch to reading OM (Phase 4)
- `GET /api/governance/catalog` → changed to query the OM `search/query` or `tables` API.
- `GET /api/governance/lineage` → changed to query OM `GET /api/v1/lineage/getLineage`.
- The DynamoDB table `bgp-lineage` is retired or kept only as a cache.

---

## 7. Data Model / FQN Naming Convention

OM identifies entities uniquely by FQN, which must correspond stably to platform naming:

| Platform object | OM FQN convention |
|---------|------------|
| Redshift table | `bgp-redshift.dev.<schema>.<table>` |
| S3 Tables (Iceberg) | `bgp-glue.s3tablescatalog/<bucket>.<namespace>.<table>` |
| Source-database table | `<service=bgp-src-<datasourceId>>.<db>.<schema>.<table>` |
| S3 container | `bgp-s3.<bucket>/<prefix>` |
| Workflow pipeline | `bgp-mwaa.<airflowDagId>` |

> ⚠️ (Audit calibration, 2026-08-26) The S3 Tables row of this table contradicts the "as implemented" record later in this document: after Phase 1 / Phase 3 landed, S3 Tables moved to a **separate `bgp-s3tables` (CustomDatabase) service**,
> with the FQN `bgp-s3tables.<bucket>.<namespace>.<table>` (see the "follow-up / as implemented" passages of section 14: `bgp-s3tables.bgp-table-bucket.ecommerce.customers`),
> not the `bgp-glue.s3tablescatalog/...` of the table above (the Glue connector does not traverse the federated catalog; that approach was rolled back).
> `bgp-s3tables` is authoritative.

> Event push and connector ingestion must produce **identical serviceName/FQN values**, otherwise duplicate entities appear. Both paths use the constants of the table above for serviceName.

---

## 8. Security Considerations

- **Least-privilege task role**: `glue:Get*/BatchGet*`, `s3:ListBucket/GetObject` (datalake only), `redshift-data:*` or `redshift:GetClusterCredentials` + querying system tables, `secretsmanager:GetSecretValue` (only `bgp/*` and the OM bot token), `logs:*` (only this task's log group).
- **Zero plaintext secrets**: all passwords/JWTs are injected via Secrets Manager and never written into the image, the logs or the repository.
- **Network**: ingestion tasks run in private subnets; the SG allows egress to RDS:3306 / Redshift:5439 / OM ALB:80 / Glue·S3 (VPC endpoint or NAT).
- **Narrowing the OM ALB** (Phase 0): the OM ALB currently accepts logins from the public internet; its SG must be narrowed to the CloudFront prefix list + the VPC's internal network (the same policy as the platform ALB), or CloudFront must be put in front of it.
- **Audit**: ingestion runs and push writes both produce CloudWatch logs for traceability.

---

## 9. Scheduling, Idempotency and Failure Handling

- **Scheduling**: EventBridge Scheduler (cron), independent per connector; manual `RunTask` re-runs are supported.
- **Idempotency**: connectors upsert by FQN; event push uses `createOrUpdate` and tolerates 409.
- **Failure handling**: the task exits non-zero → EventBridge / the task status marks it failed → CloudWatch alarm; the next scheduled run retries automatically (metadata ingestion is safely re-entrant).
- **Observability**: ingestion status is written to the OM `IngestionPipeline` entity (run history / status); ECS task logs go to CloudWatch; critical failures get SNS alarms (end of Phase 1).

---

## 10. Infrastructure (CDK)

Add a new **`BgpOmIngestionStack`**:
- ECS Fargate `TaskDefinition` (ingestion image) + task role + execution role.
- An SG for the ingestion tasks (egress to RDS/Redshift/OM/Glue/S3).
- One `EventBridge Scheduler` schedule per connector (`Ecs RunTask` target).
- References: VPC (existing), OM ALB DNS, Redshift workgroup, datalake bucket, related secrets.
- Reuses the existing CDK conventions and the `--profile temp-account` deployment red line (**never deploy to the default personal account**).

Phase 0 change to `OmServiceStack`: narrow the OM ALB SG (CloudFront prefix list + VPC).

---

## 11. Phased Implementation Plan (iterative, delivered one phase at a time)

### ✅ Scope of this round: Phase 0 + Phase 1

**Phase 0 — Hardening and service account**
- [ ] Fetch the `ingestion-bot` JWT and write it to Secrets Manager `bgp/om/ingestion-bot-token`
- [ ] Narrow the OM ALB SG to the CloudFront prefix list + the VPC's internal network
- Acceptance: automation can call OM with the bot JWT; the OM ALB can no longer be logged into directly from an arbitrary public IP

**Phase 1 — Ingestion foundation + fixed targets (Glue/Redshift/S3)**
- [ ] `BgpOmIngestionStack`: ECS task definition + roles + SG + EventBridge schedules + configuration delivery
- [ ] Glue connector (covering S3 Tables / `s3tablescatalog`)
- [ ] Redshift connector (metadata + usage/lineage)
- [ ] S3 storage connector (datalake bucket)
- Acceptance:
  - [ ] The `bgp-glue` / `bgp-redshift` / `bgp-s3` services appear in OM, and already-synchronized tables such as `customers` are visible in OM
  - [ ] The scheduled tasks run successfully as planned and their status can be viewed in OM / CloudWatch
  - [ ] SQL lineage inside Redshift appears (if query logs exist)

### Later iterations (not in this round)

**Phase 2 — Automatic onboarding of source databases**: when a data source is created, automatically register an OM DatabaseService and schedule MySQL/PG ingestion.

**Phase 3 — Event-driven push + cross-system lineage**: the platform pushes entities + column-level `source→S3→Redshift` lineage; MWAA/Airflow pipeline lineage.

**Phase 4 — Governance pages read OM (closing the SoR loop)**: catalog/lineage query OM; optional Profiler / data-quality test suites.

---

## 12. Risks and Trade-offs

| Risk | Impact | Mitigation |
|------|------|------|
| The Glue connector does not traverse the `s3tablescatalog` federated catalog | S3 Tables tables are not collected | Confirm during Phase 1 acceptance first; fall back to Athena / direct collection |
| Redshift Serverless usage/lineage differences in permissions / system tables | Missing lineage | Use `SYS_QUERY_HISTORY`; configure permissions per the Serverless documentation |
| Version drift between the ingestion image and the server | Schema incompatibility, ingestion failures | Pin the image tag to `1.6.1` and upgrade in lockstep with the server |
| Event push and connector FQNs disagree | Duplicate entities inside OM | Unified serviceName/FQN constants (section 7) |
| Credentials of the temporary workshop account expire | Deployment / ingestion interrupted | Validate credentials before deploying; ingestion failures retry automatically |

---

## 13. Acceptance Criteria (overall)
- [ ] Implemented phase by phase and passed end-to-end verification (see the acceptance items of each phase)
- [ ] All deployments only in `temp-account` (a temporary account in us-east-2); the default personal account was never touched
- [ ] No plaintext secrets; least-privilege roles
- [ ] Ingestion is observable, retryable and idempotent
- [ ] No conflict with existing features; the governance pages ultimately treat OM as authoritative (Phase 4)

---

## 14. Implementation Record

### Phase 0 (2026-06-10, completed)
- Created a dedicated service account `bgp-ingestion-bot` (isBot/isAdmin, JWT never expires); the JWT was obtained via `GET /api/v1/users/token/{id}` and stored in Secrets Manager `bgp/om/ingestion-bot-token`; authentication verified by measurement.
- ALB hardening option (a) completed: the listener uses `open:false` and `0.0.0.0/0` was removed; the OM ALB SG keeps only the VPC CIDR + the CloudFront prefix list `pl-b6a144df`; a new CloudFront distribution `<OM_CLOUDFRONT_URL>` (HTTPS) was added; the platform's `OPENMETADATA_URL` points to that CDN (no mixed content in the browser iframe). Measured: the CDN returns 200, direct ALB access returns 000 (blocked).

### Phase 1 (2026-06-10, essentially completed)
- `BgpOmIngestionStack` deployed: ECS cluster `bgp-ingestion-cluster` + three connector task definitions + EventBridge schedules (Redshift/Glue every 6 h, S3 every 24 h), image `openmetadata/ingestion:1.6.1`, secrets injected at run time via ECS secrets.
- Connector measurements:
  - **Redshift** ✅: `bgp-redshift.dev.public.customers` is in OM (the first run failed because Redshift Serverless enforces SSL; it succeeded after adding `sslMode=require`).
  - **S3** ✅: `bgp-datalake / bgp-glue-scripts / bgp-mwaa-dags` are in OM as containers.
  - **Glue** ⚠️: the `bgp-glue` service is registered but has 0 tables — confirming the risk from section 12: S3 Tables (Iceberg) live in the `s3tablescatalog` federated catalog, and the OM Glue connector reads only the default catalog and never traverses it.
- **Follow-up (S3 Tables ingestion) — landed (v1.0.5)**: added a custom ingestion task that enumerates tables with the s3tables API and upserts them into OM's `bgp-s3tables` (CustomDatabase) service, achieving table-level registration; `products` is now in OM.
  - **Important conclusion**: S3 Tables are governed by Lake Formation; Glue get-table / S3 get-object / Athena reads of their schema are all denied to the ingestion role, and this workshop account has no LF administrator who could grant access. Therefore **the authoritative source of column schemas should be the platform's event push (Phase 3, derived from the source-side schema, bypassing LF)**; the ingestion task is non-destructive (when the schema cannot be read it does not overwrite existing columns), and the columns of `products` were back-filled manually.
  - The ingestion task reaches OM through the OM CloudFront distribution (after the narrowing in v1.0.4, tasks inside the VPC egress through the NAT public IP and cannot reach the internal ALB directly, so they go through the CDN that the CloudFront prefix list allows).

### Phase 3 (2026-06-10, completed in v1.0.6) — Event-driven cross-system lineage
- When a sync runs (`sync/[id]/start`), the platform pushes to OM fire-and-forget: source→S3 Tables→Redshift table entities + **column-level lineage** (taken from `fieldMappings`); it also completes the S3 Tables columns from the **source-side schema** (bypassing Lake Formation and closing the limitation of section 12 / Phase 1).
- Added `platform/src/lib/openmetadata/om-client.ts` (token cache + retry on 401 + 409 tolerance + getEntityByName, accessed via `OPENMETADATA_URL` = the OM CloudFront distribution) and `om-push.ts` (type mapping, ensure service/db/schema/table, `PUT /api/v1/lineage` with columnsLineage).
- FQNs are consistent with the ingestion connectors (`bgp-redshift`/`bgp-s3tables`/`bgp-sources`); services are create-if-absent and never clobber a service owned by a connector.
- Measured: OM shows `bgp-sources.ecommerce.default.customers → bgp-s3tables.bgp-table-bucket.ecommerce.customers → bgp-redshift.dev.public.customers`, each edge carrying 6 column-level mappings; the S3 Tables `customers` now has real columns.
### Phase 4 (2026-06-10, completed in v1.0.8) — Governance pages read OM (closing the SoR loop)
- `api/governance/catalog` now queries OM `/api/v1/tables` (mapped to front-end rows + a `type` field);
  - `api/governance/lineage` now queries OM `/api/v1/lineage/table/name/<fqn>` and converts `entity`/`nodes`/`upstream+downstreamEdges` (including `columnsLineage`) into the front-end ReactFlow `{nodes,edges,centerNode}`.
  - Direct queries against Glue/Redshift and the DynamoDB table `bgp-lineage` are demoted to fallbacks (when OM is not configured / unreachable).
  - Measured online: catalog returns the OM tables; lineage renders the full `source→S3 Tables→Redshift` chain.
- Incidentally (v1.0.9): the governance read APIs now use **real Cognito JWT authentication** (`aws-jwt-verify` + `lib/auth/verify-token.ts`: signature/exp/iss/aud verification; the front end sends the ID token and redirects to `/login` on 401); the scope is only the governance read APIs, and the remaining APIs stay at demo level (tracked as follow-up hardening work).

### Phase 2 (2026-06-10, completed: event-driven in v1.0.10 + periodic in v1.0.11) — Automatic onboarding of data sources into OM
- When a data source is created (`POST /api/datasources`), the platform reads the source-database schema fire-and-forget (MySQL via `INFORMATION_SCHEMA`, new `lib/datasource/schema-reader.ts`) and upserts databases/tables/columns into OM (`pushDataSourceToOpenMetadata`, `om-push.ts`) — a new data source appears **immediately** in the governance catalog without first running a sync.
- Reuses the existing `bgp-sources` (CustomDatabase) service + the FQN `bgp-sources.<db>.default.<table>` (consistent with the sync push / Phase 3 lineage, no duplicate entities). Measured: creating the demo MySQL `ecommerce` data source → OM `bgp-sources` grew from 1 to 4 tables (`customers` idempotent, not duplicated), visible in the governance catalog; the test data source was cleaned up and the state restored after verification.
- **Periodic connector (Part B) completed in v1.0.11**: `BgpOmIngestionStack` gains a custom Fargate task (EventBridge every 6 h, `bgp-om-ingest-sources`) that enumerates the DynamoDB table `bgp-datasources` → connects to each MySQL source (password from Secrets Manager) → reads `INFORMATION_SCHEMA` → upserts into the same `bgp-sources` CustomDatabase (same FQN, idempotent PUT).
  - Dedicated least-privilege task role (DynamoDB read on `bgp-datasources` + Secrets Manager read on `bgp/datasource/*`); the OM bot JWT is injected as an ECS secret;
  - Column type mapping is consistent with the event push (variable-length types varchar/char → STRING, avoiding `dataLength`).
  - Purpose: **reconcile drift + back-fill** data sources that were created before the event push went live.
  - Measured `RunTask`: reconciling the demo `ecommerce` (4 tables) into OM, all 200/201, no duplicates (one type-mapping 400 was fixed along the way: VARCHAR/CHAR require dataLength; switching back to STRING passed).
- **Why not the native MySQL connector**: it would register `bgp-sources` with the serviceType `Mysql`, conflicting with the `CustomDatabase` used by the event push / lineage (a service of one name cannot have two types, see section 7); the custom task keeps a single serviceName/FQN.
- Only MySQL has direct schema reading; for other engines the database is created but not the tables, to be completed by sync.

### Stage A (2026-06-11, completed in v1.0.12) — Data quality + Profiler
- `BgpOmIngestionStack` gains a scheduled task `bgp-om-ingest-profiler` (daily): it idempotently seeds a demo data-quality suite for `bgp-redshift.dev.public.customers` (4 test cases: row count / column count / not null / unique) + runs the OM **TestSuite workflow** (`metadata test`, `orm-test-runner`) to execute the cases — pure SELECT, usable on Redshift Serverless. The column-level **Profiler** (`metadata profile`) is best-effort (`|| echo`, does not block the task).
- Platform: new authenticated `GET /api/governance/quality` (reads OM test cases + latest results + table profile summary) + a "Data Quality" tab on the governance page (previously a placeholder). Measured: all 4 cases **Success** and displayed on the platform.
- **Fix**: `omRequest` now sets `cache:"no-store"` — the Next.js fetch Data Cache had been caching OM responses, so catalog/lineage/quality read stale data.
- **Limitation (AWS)**: Redshift **Serverless** forbids access to the `STL_*` system tables (confirmed on AWS re:Post; `SYSLOG ACCESS UNRESTRICTED` has no effect either), so the OM profiler's table-level system metrics fail → column-level profiles are limited on Serverless; the row count is already covered by the DQ `tableRowCountToBeBetween`. Pointing at a non-serverless source yields full column profiles.
