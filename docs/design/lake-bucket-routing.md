# Lake Table-Bucket Routing

Decoupling execution environments from a single S3 Tables table bucket.

Status: design, authoritative; decisions in section 13 are proposed and await product-owner sign-off.

Related: [Execution role binding](execution-role-binding.md) (per-job execution role and save-time IAM preflight, which this design extends), [Long-running operations](long-running-operations.md), [Supported versions](../supported-versions.md).

Vocabulary follows the multi-region execution design:

- An **execution target** (`targetId`; home is `tgt_home`) is one region's data plane.
- A **place** is the explicit target a request runs against.
- A **scope** is the page-level "all regions / one region" view filter.

## 1. Summary

- Today the platform treats "the lake of a region" as "the one platform table bucket of that region".
- Customer-owned S3 Tables buckets are second-class: they can be registered for visibility and for sync writes, but nothing else knows them.
- Every injected Spark catalog, every IAM preflight and every read-side component (catalog, BI, NL2SQL, lineage) assumes one bucket per region.
- A job that must read bucket A and write bucket B needs the user to hand-type ten Spark `--conf` lines.

This design replaces the single binding with a **lake route table** per execution target.

- A route is `bucket -> alias / tier / namespace ownership / writable`.
- The platform table bucket becomes the implicit default route (alias `s3tablescatalog`).
- Jobs use all routes of their region unless they declare a subset.
- The platform injects one Spark catalog per route, probes IAM per bucket at save time, and resolves namespaces to buckets without falling back.
- Routes are shown in the settings, job, sync and query pages.
- Zero new tables, zero new environment variables, IAM only (no Lake Formation).

Phases 1 and 2 (core routing plus read-side routing) ship together; Phase 3 (permission matrix, least-privilege role generator, Flink writes to customer buckets) ships in the following release.

![Current one-bucket binding vs. target multi-route binding](../diagrams/lake-binding-current-vs-target.png)

## 2. Problem statement and customer scenario

### 2.1 Customer scenario (anonymised)

- A customer stores data tiers in separate S3 Tables table buckets because compliance requires bucket-level IAM isolation between tiers.
- Detail data lives in one bucket, aggregates in another, published results in a third.
- A single Spark job must read the detail bucket and write the aggregate bucket.

```sql
INSERT OVERWRITE TABLE agg.orders_daily
SELECT dt, sum(amount) AS total, count(*) AS cnt
FROM detail.orders_detail
GROUP BY dt
```

- Here `agg` and `detail` are different buckets.
- The customer wants the schema (namespace) to route to the bucket.
- The customer has no mature isolation model and no notion of a "project space".
- Therefore the execution environment itself must not be hard-bound to one bucket.
- Paraphrased: "The platform should let us specify the storage bucket, instead of binding one by default and not letting us change or specify it."

### 2.2 What happens today

- Each execution region owns exactly one platform table bucket; every Spark job receives one injected catalog, `s3tablescatalog`, pointing at it.
- Customer buckets can be registered under "System settings -> Lake external table buckets".
- Registration makes them visible in the query tree, the governance catalog and NL2SQL, and writable by sync tasks.
- Registration is not routing: no alias, no tier, no namespace ownership.
- A cross-bucket job needs a `--conf` job parameter with five Spark properties per bucket (Appendix B).
- Two-part names fail with `TABLE_OR_VIEW_NOT_FOUND`; only three-part names work.
- The save-time IAM preflight for custom execution roles does not probe `s3tables` at all; a role lacking a bucket permission saves fine and fails at run time with 403.
- The home-region EMR role and both Flink roles can only touch the platform bucket.
- Governance "create table", the BI builder, NL2SQL seeds, lineage FQNs and the non-home governance catalog are hard-wired to the platform bucket.

### 2.3 Why this is a product defect, not a documentation gap

- The no-code workaround (Appendix B) works but violates three platform principles.
- It requires hand-typed technical identifiers (account id, region, bucket ARN).
- The permission model cannot be reasoned about per bucket.
- The read side cannot see what the write side produced.
- Bucket-level isolation is the customer's compliance control, so the platform must model buckets as first-class routes.

## 3. Current state

Facts were re-verified against the working tree. Paths are relative to the repository root; `platform/src/` is omitted for platform files.

| Layer | Fact | Gap |
|---|---|---|
| Bucket provisioning | One platform bucket per region, created by the platform stack (home) and the core stack (others) | "One target = one bucket" is the base assumption |
| Spark landing resolver | `lib/exec-env/target-clients.ts` returns a single `tableBucket` | No notion of additional buckets |
| Athena / catalog resolver | `lib/athena/s3tables.ts` has a one-bucket resolver and a namespace resolver that falls back to the platform bucket | Two resolvers and a silent default |
| External bucket registry | `lib/lake/external-table-buckets.ts`, one settings row per bucket | Visibility and sync write only; no alias, tier, ownership, writable flag |
| Registry API | `app/api/admin/lake-buckets` GET / POST / DELETE and `candidates` | No update verb; no alias or tier fields |
| Read-side consumers | Query tree, NL2SQL, home governance push | Non-home regions never reach the catalog; namespace lookup may pick the wrong bucket |
| Sync write guard | `lib/sync/table-bucket.ts` | Home accepts any bucket; non-home requires registration; registry is not the single truth |
| Offline Glue jobs | `lib/etl/job-service.ts` injects exactly one catalog and appends user `--conf` unchecked | Cross-bucket needs hand-typed configuration; alias collisions undetected |
| EMR Serverless | `lib/engines/emr/spec.ts` injects one catalog with the S3 Tables catalog implementation | Home EMR cannot reach a second bucket; recipe differs from Glue |
| Flink | Home and per-target Flink roles grant the platform bucket only | Real-time writes reach only the platform bucket |
| IAM, other roles | Region Glue / EMR roles already cover any bucket in the region; home Glue role covers `*` | Permission surface is wide enough; declare-and-measure is missing |
| Execution-role preflight | Glue baseline probes the data-lake bucket, not the real `--TempDir`; never probes `s3tables` | Missing bucket permission passes save and fails at run |
| Read-side hard binding | Create-table, BI builder, NL2SQL seeds, lineage FQN, plan discovery, codegen, prompts, GenBI agent | Customer-bucket tables are absent or resolve to the wrong bucket |
| Lake query page | SQL passed through without catalog injection; writes forbidden | Read-only is by design and stays |
| Redshift | No S3 Tables carrier; `CREATE EXTERNAL SCHEMA` is banned | Out of scope |
| Upgrade script | Has steps for stacks that must follow HEAD | No step for data migration of settings rows |
| Synth gate | Numbered IAM-shape assertions exist | A new assertion is needed for the widened roles |

Details per layer:

- Bucket provisioning: the home bucket name and `S3TABLES_BUCKET` / `S3TABLES_CATALOG` / `S3TABLES_NAMESPACE` come from the platform stack; non-home buckets come from the descriptor field `tableBucket`, a mandatory core probe item in `lib/exec-env/component-contract.ts`.
- Athena resolver: `resolveS3TablesPlaces` = platform bucket plus registered rows with a 15-second `globalThis` memo; `resolveS3TablesPlaceForNamespace` probes `ListNamespaces` per bucket and falls back to the platform bucket when nothing matches.
- Registry row: `pk="system"`, `sk=lake-ext-bucket#<targetId>#<bucket>`, fields `{ targetId, bucket, region, label?, addedBy, addedAt }`; registration checks name grammar, "not the platform bucket" and `GetTableBucket` in the target region; no IAM or Lake Formation action.
- Glue injection: five properties with the `GlueCatalog` implementation; `--bgp_table_bucket` is a single value; `--TempDir` is `s3://<scriptsBucket>/temp/`; a reserved-argument set exists.
- EMR injection: three properties with the S3 Tables catalog implementation plus a shared `--jars` and `spark.sql.extensions`; home reads `EMR_S3TABLES_WAREHOUSE_ARN`; the home EMR role is limited to the platform bucket.
- Flink: `lib/realtime/flink-place.ts` carries one `s3tablesBucket`; the template catalog `s3t` substitutes `${TABLE_BUCKET_ARN}`.
- Federated catalog: `s3tablescatalog` is created with `Identifier=arn:aws:s3tables:<region>:<account>:bucket/*` and `IAM_ALLOWED_PRINCIPALS` in `lib/aws/s3tables-catalog.ts`; no Lake Formation API call exists anywhere.
- Read-side hard binding, write path: create-table in `lib/governance/catalog-ddl.ts`; lineage in `lib/openmetadata/om-push.ts`.
- Read-side hard binding, query path: BI in `lib/bi/query-builder.ts`; NL2SQL seeds in `lib/genbi/global-skills-seed.ts`; the GenBI agent takes one `catalogRef` from the place wire.
- Read-side hard binding, generation path: discovery in `lib/copilot/plan/discovery-tools.ts`; codegen in `lib/requirements/codegen.ts`; cookbook in `lib/cookbook/seed/emr.ts`.

In short:

- The platform equates "this region's lake" with "this region's one platform table bucket".
- Customer buckets are second-class.
- Cross-bucket work needs hand-typed Spark configuration.
- Permissions are not measured per bucket.
- The read side does not recognise the buckets.

## 4. Goals and non-goals

### 4.1 Goals

| # | Goal |
|---|---|
| G1 | A job reads bucket A and writes bucket B with no hand-typed configuration, using `<alias>.<namespace>.<table>` names |
| G2 | Buckets are declared per execution target with alias, tier, namespace ownership and writable flag, by a platform admin, in the UI |
| G3 | Permissions are measured per bucket at save time, with the exact missing action and ARN in the error |
| G4 | The read side resolves every table to its bucket through the same route table, never falling back |
| G5 | Existing jobs, sync tasks, registrations and hand-typed configuration keep working after upgrade |
| G6 | Zero new DynamoDB tables, zero new environment variables, no Lake Formation dependency |

G4 covers the query tree, the governance catalog including non-home regions, create-table, BI, NL2SQL and lineage.

### 4.2 Non-goals (explicit)

| # | Not in scope | Reason |
|---|---|---|
| N1 | Cross-account table buckets | Production shape is single account x multiple regions; the registry already states this |
| N2 | Redshift reading S3 Tables through external schemas | No carrier; banned DDL |
| N3 | Writes from the lake query page | Read-only is the page's design |
| N4 | Lake Formation fine-grained permissions | IAM mode already satisfies bucket-level isolation (section 7) |
| N5 | Project space x bucket two-dimensional authorisation | Routes belong to the target, not to a project; matches the customer's shape |
| N6 | Routing a Spark two-part name to a bucket by namespace inside Spark | Cross-catalog access needs three-part names; a per-job default catalog is offered instead (R3) |

## 5. Requirements with acceptance criteria

Acceptance is page-driven: every criterion is performed in a headless browser against the pages; API, CLI and DynamoDB reads are cross-checks only.

| # | Requirement | Acceptance (page-driven) | Cross-check |
|---|---|---|---|
| R1 | Route table per execution target | Register two buckets with alias and tier; the table lists both | `GET /api/admin/lake-routes?targetId=` lists three routes |
| R2 | Job-level multi-bucket | Glue job with no parameters and a cross-bucket script runs `succeeded` | Glue `--conf` contains both catalog groups |
| R3 | Optional default catalog | Default catalog `agg`, two-part name, run succeeds | `--conf` contains `spark.sql.defaultCatalog=agg` |
| R4 | Permissions measured per bucket | Role with `agg` only: save 400 names the `detail` ARN; grant; save 200; run succeeds | Preflight `gaps[]` |
| R5 | IAM alignment | Home EMR job across two customer buckets succeeds | Synth gate green; single-bucket mutation red |
| R6 | Read side resolves by route | NL2SQL answers on an `agg` table with a three-part name; create-table offers `agg` | OpenMetadata database per bucket; Athena text |
| R7 | Explicit namespace ownership | Second bucket with the same namespace returns 409 naming both buckets | `LAKE_ROUTE_NAMESPACE_CONFLICT` |
| R8 | Sync and real-time follow the same rule | Wizard option reads `bucket · alias · tier`; sync writes into the customer bucket | Glue `--conf`, bucket listing |
| R9 | Compatibility and migration | After upgrade, existing jobs, tasks and the query page behave as before | Byte-identical `--conf` without external routes |
| R10 | Observability and audit | Permission matrix shows role B denied on the `detail` bucket (Phase 3) | `bgp-audit` rows |
| R11 | Explicit non-goals | See section 4.2 | — |

Requirement details:

- R1: Each target holds routes `bucket -> alias / tier / namespaces / writable`. The platform bucket is the implicit default route with the fixed alias `s3tablescatalog`. Registering a customer bucket creates a route. A route's bucket must exist in the target's region and account (fail-closed).
- R2: Glue and EMR jobs may declare the routes they use; the default is all routes of the region.
- R2: The platform registers one Spark catalog per declared route with alias = route alias; scripts use `<alias>.<namespace>.<table>` without any `--conf`.
- R2: The declaration is saved with the job and applies to scheduled, orchestrated and backfill runs.
- R3: A job may mark one declared route as default (`spark.sql.defaultCatalog`) so single-bucket jobs use two-part names. Cross-bucket still needs the alias prefix; the page states this.
- R4: The custom-role preflight probes each declared route: read actions always, write actions when the declaration is `write`; Glue jobs also probe the federated Glue catalog.
- R4: The Glue baseline probes the real TempDir (scripts bucket `temp/`) instead of the data-lake bucket. Gaps reject save with 400 and name action and ARN.
- R5: The home EMR role and both Flink roles grant `s3tables:*` on any bucket of their region, like the execution-region Glue and EMR roles. The synth gate pins the shape.
- R6: The query tree shows alias and tier tags; the governance catalog syncs every route of every ready target including non-home; create-table offers a bucket choice.
- R6: BI builder, NL2SQL, plan discovery and codegen resolve namespace to bucket via the route table; no match means 400 naming the namespace; lineage FQNs carry the bucket.
- R7: If the same namespace exists in two routes, registration requires `namespaces[]` ownership (409). Namespace-only lookups that match two routes without ownership fail with 400 naming both buckets.
- R8: The sync wizard bucket dropdown shows `bucket · alias · tier`, lists only writable routes, and home and non-home both require "must be a route entry".
- R8: Existing home tasks' buckets are auto-registered by the upgrade step. Phase 3: Flink jobs choose a route as the lake sink.
- R9: Existing rows get `alias` (derived from the bucket name) and `writable=true` on first read; existing jobs are untouched; hand-typed `--conf` keeps being appended.
- R9: A hand-typed alias colliding with a generated alias on a different bucket rejects save with 400; `S3TABLES_BUCKET` remains the source of the platform route only.
- R10: Register, update, revoke and job route declarations are audited. Phase 3 adds a settings-page "bucket permission matrix" (route x role -> reachable or not, via `SimulatePrincipalPolicy`).

## 6. Architecture

### 6.1 Concepts

| Term | Definition |
|---|---|
| Lake route | One `(targetId, bucket)` pair with routing metadata; the unit of declaration, injection, preflight and resolution |
| Alias | The Spark catalog name for the route; grammar `^[a-z][a-z0-9_]{0,31}$`; unique per target |
| Tier | Closed list `detail · agg · result · ods · dim · other`; display and compliance label only |
| Namespace ownership | Optional explicit `namespaces[]` on a route; required when two routes contain the same namespace |
| Writable | Boolean; `false` blocks sync target, Flink sink, create-table target and `write` declarations; a product guard, not IAM |
| Platform route | Implicit default route: alias `s3tablescatalog`, bucket from the Spark landing, tier `other`, writable; never stored |
| Declaration | A job's chosen subset of routes with an access mode per entry (`read` or `write`); undeclared = all routes |

Reserved aliases: `s3tablescatalog` (platform route), `spark_catalog` (Spark's session catalog), `glue_catalog`, `default`.

### 6.2 Data model (zero new tables)

Routes reuse the existing settings row; the key is unchanged and fields are added.

```ts
// lib/lake/routes.ts — row shape of pk="system", sk="lake-ext-bucket#<targetId>#<bucket>"
export type LakeTier = "detail" | "agg" | "result" | "ods" | "dim" | "other";

export interface LakeRouteRow {
  targetId: string;            // existing
  bucket: string;              // existing
  region: string;              // existing
  label?: string;              // existing
  addedBy: string;             // existing
  addedAt: string;             // existing (ISO 8601)
  alias: string;               // NEW  Spark catalog name, ^[a-z][a-z0-9_]{0,31}$, unique per target
  tier: LakeTier;              // NEW  default "other"
  namespaces?: string[];       // NEW  explicit ownership, absent = discover live
  writable: boolean;           // NEW  default true
  updatedBy?: string;          // NEW
  updatedAt?: string;          // NEW
}

export interface LakeRoute extends LakeRouteRow {
  platform: boolean;           // derived: true only for the implicit platform route
  catalogRef: string;          // derived: "s3tablescatalog/<bucket>" for Athena
  bucketArn: string;           // derived: arn:aws:s3tables:<region>:<account>:bucket/<bucket>
}

export interface LakeRouteSet {
  targetId: string;
  region: string;
  platform: LakeRoute;
  external: LakeRoute[];       // registration order
  all: LakeRoute[];            // [platform, ...external]
  fetchedAt: string;
}
```

Job-side declaration fields (closed, validated):

```ts
// types/etl-job.ts GlueJobConfig  and  lib/engines/emr/types.ts EmrEngineJob
export interface LakeBucketDeclaration { bucket: string; access: "read" | "write" }
lakeBuckets?: LakeBucketDeclaration[];   // undefined = all routes of the region
defaultCatalogAlias?: string;            // must be the alias of a declared (or, if undeclared, any) route
```

- Sync tasks keep `s3Config.tableBucket` (string); the value must be a writable route.
- Flink jobs gain `lakeRoute?: string` (bucket) in Phase 3.

![Data model](../diagrams/lake-data-model.png)

### 6.3 Single author `lib/lake/routes.ts`

- All route knowledge lives in one module.
- `lib/athena/s3tables.ts` and `lib/lake/external-table-buckets.ts` become thin wrappers that import it.
- A source-literal ratchet test asserts that `spark.sql.catalog.` appears only in this file.

```ts
// Errors — one class, five codes, status chosen by the caller's context
export type LakeRouteErrorCode =
  | "LAKE_ROUTE_NOT_FOUND"          // 400: alias / bucket / namespace matches no route of the target
  | "LAKE_ROUTE_AMBIGUOUS"          // 400: namespace matches >= 2 routes and no route owns it
  | "LAKE_ROUTE_ALIAS_CONFLICT"     // 409 on register/update, 400 on job/sync save
  | "LAKE_ROUTE_NOT_WRITABLE"       // 400 on save, 409 on start
  | "LAKE_ROUTE_NAMESPACE_CONFLICT";// 409 on register/update
export class LakeRouteError extends Error {
  constructor(readonly code: LakeRouteErrorCode, readonly status: 400 | 409, message: string, readonly detail?: unknown);
}

// Reading
export async function resolveLakeRoutes(targetId: string, opts?: { fresh?: boolean }): Promise<LakeRouteSet>;
export async function routeByAlias(targetId: string, alias: string): Promise<LakeRoute>;      // throws NOT_FOUND
export async function routeByBucket(targetId: string, bucket: string): Promise<LakeRoute>;    // throws NOT_FOUND
export async function routeForNamespace(targetId: string, namespace: string): Promise<LakeRoute>; // section 6.4
export function selectRoutes(set: LakeRouteSet, declared?: LakeBucketDeclaration[]): SelectedRoute[];
export type SelectedRoute = LakeRoute & { access: "read" | "write" };

// Writing (platform admin only, called by the routes API and the upgrade migration)
export async function registerLakeRoute(input: RegisterLakeRouteInput): Promise<LakeRoute>;
export async function updateLakeRoute(input: UpdateLakeRouteInput): Promise<LakeRoute>;
export async function revokeLakeRoute(targetId: string, bucket: string): Promise<boolean>;

// Grammar and derivation
export const LAKE_ALIAS_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const LAKE_RESERVED_ALIASES: ReadonlySet<string>;   // s3tablescatalog, spark_catalog, glue_catalog, default
export function assertAlias(alias: unknown): string;
export function aliasFromBucket(bucket: string, taken: ReadonlySet<string>): string;

// Injection (section 6.5) — the only place that spells Spark catalog properties
export function sparkCatalogConf(
  routes: readonly LakeRoute[],
  opts: { engine: "glue" | "emr"; account: string; defaultAlias?: string }
): string[];
export function lakeCatalogsArgument(routes: readonly LakeRoute[]): string;    // "alias=bucket,alias=bucket"
export function rejectUserCatalogConf(
  userConf: string | undefined,
  routes: readonly LakeRoute[]
): { drop: string[]; notices: string[] };                                      // throws ALIAS_CONFLICT

// Preflight (section 6.6)
export function lakeRouteProbes(
  routes: readonly SelectedRoute[],
  ctx: { engine: "glue" | "emr" | "flink"; account: string }
): PreflightNeed[];
```

Fail-closed semantics:

- No function returns the platform route as a substitute for a missing match.
- `resolveS3TablesPlaceForNamespace` loses its first-route fallback and throws `LAKE_ROUTE_NOT_FOUND`.
- `selectRoutes` rejects any declared bucket that is not a route of the target, and any `write` declaration on a route with `writable=false`.
- `resolveLakeRoutes` throws when the target is not ready or its descriptor lacks `tableBucket`, as the one-bucket resolver does today.
- Write-side guards (sync save and start, job save) call with `fresh: true` and bypass the cache, as the sync guard reads the registry directly today.

### 6.4 Resolution algorithm, ambiguity and caching

![Route resolution flow](../diagrams/lake-route-resolution.png)

`routeForNamespace(targetId, namespace)`:

1. Load the route set (cached, section 6.4.1).
2. If the set has exactly one route, return it; namespace existence is not probed here, and downstream Athena or Spark reports a missing schema as today.
3. If exactly one route lists the namespace in `namespaces[]`, return it; two or more is a registration-guard failure reported as `LAKE_ROUTE_NAMESPACE_CONFLICT` (defensive).
4. Otherwise probe `ListNamespaces` on every route whose `namespaces[]` is absent, using that region's S3 Tables client; results are cached 15 seconds per `(targetId, bucket)`.
5. Zero hits: `LAKE_ROUTE_NOT_FOUND` (400) with "namespace `<ns>` is in none of the N routes of `<targetId>`".
6. One hit: that route.
7. Two or more hits: `LAKE_ROUTE_AMBIGUOUS` (400) with `detail.buckets[]` and the fix "declare ownership of `<ns>` on one route".

Registration and update guard (R7):

- Before writing a row, the author computes `live(new bucket) ∩ (union of live-or-declared namespaces of existing routes)`.
- A non-empty intersection without `namespaces[]` on the new route covering those names raises `LAKE_ROUTE_NAMESPACE_CONFLICT` (409) listing each namespace with both buckets.
- Two routes declaring the same namespace raise the same error.
- Ownership affects namespace-only lookups only; a three-part Spark name is always explicit.

#### 6.4.1 Caching

- Route set: 15-second process cache on `globalThis` under `Symbol.for("bgp.lake.routes.memo")`, replacing the existing memo.
- The `globalThis` anchor is required because the Next.js build duplicates module instances across route bundles.
- Namespace discovery: 15-second cache per `(targetId, bucket)` under a second symbol.
- Invalidation: register, update and revoke clear both caches in-process; other ECS tasks converge within 15 seconds.
- Write-side guards read fresh: "registered one second ago" must pass immediately on every task.

### 6.5 Injection into Glue ETL, EMR Serverless, sync and Flink

![Job submission sequence](../diagrams/lake-job-submit-sequence.png)

#### 6.5.1 Glue ETL jobs (`lib/etl/job-service.ts#ensureGlueJob`)

`sparkCatalogConf(selected, { engine: "glue", account, defaultAlias })` emits, per route, the five properties below (today's recipe with alias and bucket substituted), joined by ` --conf `:

```text
spark.sql.catalog.<alias>=org.apache.iceberg.spark.SparkCatalog
spark.sql.catalog.<alias>.catalog-impl=org.apache.iceberg.aws.glue.GlueCatalog
spark.sql.catalog.<alias>.glue.id=<account>:s3tablescatalog/<bucket>
spark.sql.catalog.<alias>.io-impl=org.apache.iceberg.aws.s3.S3FileIO
spark.sql.catalog.<alias>.warehouse=arn:aws:s3tables:<region>:<account>:bucket/<bucket>
```

When `defaultCatalogAlias` is set, `spark.sql.defaultCatalog=<alias>` follows.

Additional `DefaultArguments`:

- `--bgp_table_bucket` unchanged (= platform bucket) so existing scripts keep working.
- `--bgp_lake_catalogs=<alias>=<bucket>,<alias>=<bucket>,...` (new, reserved), read via `getResolvedOptions(sys.argv, ["bgp_lake_catalogs"])`; platform route first, then external routes in registration order.
- The reserved-argument set gains `--bgp_lake_catalogs`.

User `--conf` (`cfg.jobParameters["--conf"]`) passes through `rejectUserCatalogConf` first:

- Entries `spark.sql.catalog.<alias>*` whose alias equals a platform-generated alias and whose `glue.id` or `warehouse` point at the same bucket are dropped with a notice ("taken over by the platform").
- Same alias on a different bucket raises `LAKE_ROUTE_ALIAS_CONFLICT` (400).
- Aliases unknown to the route table are appended untouched; hand-typed catalogs for non-route buckets stay allowed (section 7).
- A user `spark.sql.defaultCatalog` is dropped with a notice when the job declares a default.

Byte budget:

- With a 6-character alias and an 18-character bucket name one route costs about 430 bytes of `--conf`; with maximal names about 610 bytes.
- The author computes the real size of the value and rejects save (`VALIDATION_FAILED`, message states bytes and the Glue ceiling) when it would exceed the per-value limit of `DefaultArguments`.
- The UI warns above 10 declared routes (section 12).

Regions with no external routes produce a `--conf` value byte-identical to today's.

#### 6.5.2 EMR Serverless (`lib/engines/emr/spec.ts#s3TablesCatalogParameters`, `provider.ts`)

EMR uses the S3 Tables catalog implementation, not `GlueCatalog`; the author emits a different property set for `engine: "emr"`:

```text
--jars <EMR_S3TABLES_JAR>                                                        (once)
spark.sql.extensions=org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions   (once)
spark.sql.catalog.<alias>=org.apache.iceberg.spark.SparkCatalog                  (per route)
spark.sql.catalog.<alias>.catalog-impl=software.amazon.s3tables.iceberg.S3TablesCatalog
spark.sql.catalog.<alias>.warehouse=arn:aws:s3tables:<region>:<account>:bucket/<bucket>
spark.sql.defaultCatalog=<alias>                                                 (optional)
spark.bgp.lakeCatalogs=<alias>=<bucket>,...                                      (reserved, per job)
```

- The provider stops reading `EMR_S3TABLES_WAREHOUSE_ARN`; home and non-home both derive the platform route from the landing.
- The env key stays in the task definition for one release (the environment-key guard pins the key list) and is removed in the next.
- The reserved Spark conf set gains `spark.bgp.lakeCatalogs`; user `sparkConf` goes through `rejectUserCatalogConf` as for Glue.

#### 6.5.3 Sync tasks (`lib/sync/start-run.ts`, `lib/sync/glue-script-generator.ts`)

- `effectiveTableBucket` must resolve to a writable route of the landing target; the home bypass is removed.
- Save returns 400 `LAKE_ROUTE_NOT_WRITABLE` or `LAKE_ROUTE_NOT_FOUND`; start returns 409 with the same code.
- The injected `--conf` is produced by `sparkCatalogConf([route], { engine: "glue" })` for the single target route; the alias is the route alias (platform route keeps `s3tablescatalog`).
- `S3T_CATALOG` in the generated script becomes a parameter equal to the route alias.
- The federated-catalog self-heal (`lib/aws/s3tables-catalog.ts`) is unchanged: one catalog per region covers every bucket.

#### 6.5.4 Flink (Phase 3)

- Flink jobs gain `lakeRoute?: string` (bucket); `${TABLE_BUCKET_ARN}` resolves to that route's ARN; absent means the platform route (byte-identical to today).
- `writable=false` routes are rejected at job save (400) and start (409).
- The SQL template keeps catalog name `s3t`; it is inside user SQL, not a platform alias.

### 6.6 Preflight by bucket

- `lib/execution-role/preflight.ts#preflightExecutionRole` gains `lakeRoutes: SelectedRoute[]`.
- All call sites (`job-service.ts`, `start-run.ts`, `flink-service.ts`, `emr/provider.ts`, `emr/schedule-fanout.ts`) pass the job's selected routes.
- `lib/role-advisor/lake-probes.ts#lakeRouteProbes` adds, per route, the probes below.

| Access | Actions | Resource form |
|---|---|---|
| read | `s3tables:GetTableBucket`, `ListNamespaces`, `GetNamespace`, `ListTables` | bucket ARN |
| read | `s3tables:GetTable`, `GetTableMetadataLocation`, `GetTableData` | `<bucket ARN>/table/*` |
| write (adds) | `s3tables:CreateNamespace`, `CreateTable` | bucket ARN |
| write (adds) | `s3tables:PutTableData`, `UpdateTableMetadataLocation` | `<bucket ARN>/table/*` |
| read, Glue only | `glue:GetDatabase`, `GetTable`, `GetTables` | federated catalog, database and table forms |
| write, Glue only (adds) | `glue:CreateTable`, `UpdateTable`, `CreateDatabase` | same forms |

Resource forms:

- Bucket ARN: `arn:aws:s3tables:<region>:<account>:bucket/<bucket>`.
- Federated Glue catalog forms: `arn:aws:glue:<region>:<account>:catalog/s3tablescatalog/<bucket>`, `...:database/s3tablescatalog/<bucket>/*`, `...:table/s3tablescatalog/<bucket>/*/*`.

Probe metadata and baseline change:

- Each probe carries `sid = LakeRoute:<alias>:<read|write>` and a `why` of the form "job declares route `<alias>` (`<bucket>`) for `<access>`; without this the run fails with 403 on the first table access".
- The Glue federated-catalog resource forms must be confirmed by the IAM-manifest test that evaluates them with `SimulatePrincipalPolicy`.
- The EMR S3 Tables catalog path does not call Glue and skips those probes.
- The Glue baseline probe on `<datalakeBucket>/temp/probe` is removed and replaced by `s3:PutObject` on `arn:aws:s3:::<scriptsBucket>/temp/probe`, matching the real `--TempDir`.
- A job that only touches customer buckets no longer needs write access to the platform data-lake bucket.
- The gap text's fourth remedy reads: "grant the role these `s3tables` actions on `<bucket>`, or remove `<alias>` from the job's lake bucket declaration, or change its access to `read`".
- Platform default roles already hold `s3tables:*` in their region (after section 6.7), so the preflight is only decisive for custom roles.
- The task role needs no new actions; `SimulatePrincipalPolicy` and `s3tables:ListNamespaces` are already in the IAM manifest.
- A mutation test that deletes the `lakeRouteProbes` call turns the wiring test red.

### 6.7 IAM changes per role

| Role | Today | Target |
|---|---|---|
| Home EMR job role (`infra/lib/emr-stack.ts`) | `s3tables:*` on the platform bucket and its tables | `s3tables:*` on `bucket/*` in the home region |
| Home Flink role (`infra/lib/flink-stack.ts`) | same as above | same target form |
| Per-target Flink role (`infra/lib/exec-env/flink-stack.ts`) | `s3tables:*` on the target's own bucket | any bucket in the region |
| Per-target Glue / EMR roles (`core-stack.ts`) | already `bucket/*` in region | unchanged |
| Home Glue role (`platform-stack.ts`) | `s3tables:*` on `*` | unchanged |
| Platform task role | `s3tables:*` plus named actions in region | unchanged |

- The single author of the ARN form moves to `infra/lib/shared/table-bucket-arn.ts` (`anyTableBucketArn(partition, region, account)`), imported by the three stacks above and by `exec-roles.ts`.
- `bucket/*` matches both `bucket/<name>` and `bucket/<name>/table/<id>`; the region segment still pins the region, so cross-region access is not widened.

Synth-gate assertion (new, dedicated number):

- For templates `BgpEmrStack`, `BgpFlinkStack` and every `BgpExecEnv-*-flink`, each statement containing an `s3tables:` action must have every `Resource` match `^arn:aws:s3tables:[^:]+:[^:]+:bucket/\*$` after token resolution and must not contain a literal bucket name.
- The gate also asserts the statement exists; a missing statement is red, not green.
- Mutation: reverting one stack to the single-bucket form turns the assertion red.

Upgrade note: execution regions obtain the new Flink IAM only after "Execution environments -> Redeploy" (same procedure as the earlier Glue / EMR widening); the home stacks follow the platform upgrade script.

### 6.8 Read-side routing (Phase 2)

| Surface | Change |
|---|---|
| Query tree API `app/api/athena/tables/route.ts` | `catalogs[]` entries gain `alias`, `tier`, `writable`; namespace nodes gain `alias`, `tier`; existing fields stay |
| Governance catalog push `om-push.ts` | Signature `({ targetId })`; the "sync columns" long operation iterates every ready target |
| Lineage FQN `om-push.ts` | Bucket from the sync task's effective route (write side) or `routeForNamespace` (read side), never from env |
| Governance create-table `catalog-ddl.ts` | `targetBucket` mandatory; must be a writable route; page shows a dropdown of writable routes |
| BI builder `query-builder.ts` | `tableRef` takes the resolved route via `routeForNamespace(targetId, schema)` |
| NL2SQL `genbi/athena.ts`, `place.ts`, `agent.ts` | Namespace resolver fail-closed; place wire's Athena leg gains `routes[]`; agent builds three-part names per route |
| Seeds `global-skills-seed.ts` | Keep env for the demo platform route only; comment states the limitation |
| Plan discovery and codegen | Introspect every route's namespaces; catalog text groups tables by alias and states the three-part form |
| Prompts and cookbook | Teach `<alias>.<namespace>.<table>`; aliases from `--bgp_lake_catalogs` / `spark.bgp.lakeCatalogs` |
| `S3TABLES_NAMESPACE` env | Only a hint for the platform route's default namespace; no longer implies a bucket |

Governance push details:

- One OpenMetadata instance and one service `bgp-s3tables` (platform mandate); database = bucket name; schema = namespace.
- Columns are introspected through that target's Athena place; `introspectS3Tables(ns, { targetId, catalogRef })` already supports this.
- Create-table without `targetBucket` returns 400; a non-writable route returns 400 `LAKE_ROUTE_NOT_WRITABLE`.
- The NL2SQL place wire gains `routes[] = { alias, bucket, catalogRef, tier }`; the agent image must be rebuilt with the agents redeploy script.
- `s3tablescatalog` remains the alias of the platform bucket in prompts.

### 6.9 UI

| Page | Element | `data-testid` |
|---|---|---|
| Settings card "Lake table buckets and routes" | Route table; platform route is the first, non-removable row | `lake-route-table`, `lake-route-row`, `lake-route-alias`, `lake-route-tier`, `lake-route-writable` |
| Same card | Register form | `lake-route-bucket`, `lake-route-alias-input`, `lake-route-tier-select`, `lake-route-writable-switch`, `lake-route-namespaces-input`, `lake-route-add` |
| Same card | Row actions edit / revoke; 409 messages verbatim | `lake-route-edit`, `lake-route-revoke` |
| Same card (Phase 3) | "Bucket permission matrix" sub-card | `lake-perm-matrix`, `lake-perm-cell` |
| Offline compute job, advanced properties | Block "Lake table buckets" | `job-lake-buckets`, `job-lake-access`, `job-default-catalog`, `job-lake-catalogs-hint`, `job-lake-copy-example` |
| EMR job panel | Same block | same testids |
| Sync wizard bucket picker | Option label `bucket · alias · tier`; only writable routes selectable | `table-bucket-option` with `data-alias`, `data-tier`, `data-writable` |
| Lake query page tree | Namespace prefix tag `alias · tier` for every route | `lake-ns-route` (kept `lake-ns-external`) |
| Governance create-table | Bucket dropdown of writable routes | `catalog-create-bucket` |
| "How to use this page" help | One sentence per page on routes, aliases and three-part names | — |

Element details:

- The settings card is today's "Lake external table buckets" card (`settings-lake-ext-buckets`); the old table testid `lake-ext-bucket-table` is kept as an alias.
- Route table columns: bucket, alias, tier, namespaces, writable, label, added by.
- Register form: bucket (`TableBucketPicker`), alias (pre-filled from the bucket name, editable), tier select, writable switch, namespaces tag input, label.
- Permission matrix: routes x (platform roles plus roles used by jobs of this target) -> reachable, denied or unknown.
- Job block: multi-select of routes (default all; chips show `alias · tier`; per-chip access toggle read / write), "Default catalog" select, a read-only list "catalogs available to this job", and a "copy three-part example" button.
- Non-route buckets in the sync wizard keep the existing "unregistered" hint and link.
- English dictionary entries ship in the same commit as the pages.

Friendliness rules:

- No field requires an account id, region or ARN.
- Alias and tier are pre-filled.
- Every rejection names the object and the next action.
- The job block offers a copy-ready example.

### 6.10 HTTP API contracts

- All responses use the platform envelope: success `{ "success": true, "data": ... }`; error `{ "success": false, "error": { "message", "code", "detail"? } }`.
- The five codes of section 6.3 are added to `ApiErrorCode`.
- Every route requires an explicit `targetId`; missing means 400 `PLACE_UNDECIDABLE`.
- Write verbs require a platform admin (403 `RBAC_DENIED` otherwise).

#### 6.10.1 `GET /api/admin/lake-routes?targetId=<id>` (list; any signed-in user)

```json
{ "success": true, "data": {
  "targetId": "tgt_usw2_a", "region": "<region>", "fetchedAt": "<iso-timestamp>",
  "routes": [
    { "bucket": "bgp-table-bucket-tgt-usw2-a", "alias": "s3tablescatalog", "tier": "other",
      "writable": true, "platform": true,
      "catalogRef": "s3tablescatalog/bgp-table-bucket-tgt-usw2-a" },
    { "bucket": "demo-detail-bucket", "alias": "detail", "tier": "detail", "writable": true, "platform": false,
      "namespaces": ["detail"], "label": "raw tier", "addedBy": "admin", "addedAt": "<iso-timestamp>",
      "catalogRef": "s3tablescatalog/demo-detail-bucket" },
    { "bucket": "demo-agg-bucket", "alias": "agg", "tier": "agg", "writable": true, "platform": false,
      "addedBy": "admin", "addedAt": "<iso-timestamp>", "catalogRef": "s3tablescatalog/demo-agg-bucket" }
  ] } }
```

#### 6.10.2 `POST /api/admin/lake-routes` (register)

Request:

```json
{ "targetId": "tgt_usw2_a", "bucket": "demo-agg-bucket", "alias": "agg", "tier": "agg", "writable": true,
  "namespaces": ["agg"], "label": "aggregate tier" }
```

| Status | Code | When |
|---|---|---|
| 201 | — | Route created; `data` = the route |
| 400 | `VALIDATION_FAILED` | Bucket name or alias grammar invalid, tier not in the closed list, alias reserved |
| 404 | `NOT_FOUND` | No such table bucket in the target's region |
| 409 | `CONFLICT` | Bucket already a route of this target, or bucket is the platform bucket |
| 409 | `LAKE_ROUTE_ALIAS_CONFLICT` | Alias already used by another route; `detail = { alias, bucket }` |
| 409 | `LAKE_ROUTE_NAMESPACE_CONFLICT` | Namespace overlap without ownership; `detail.conflicts[]` lists namespace and buckets |

Example 409:

```json
{ "success": false,
  "error": { "code": "LAKE_ROUTE_NAMESPACE_CONFLICT",
             "message": "Namespace dw exists in both demo-detail-bucket (alias detail) and demo-agg-bucket. Declare which route owns dw in namespaces[] and retry.",
             "detail": { "conflicts": [ { "namespace": "dw",
                                          "buckets": ["demo-detail-bucket", "demo-agg-bucket"] } ] } } }
```

#### 6.10.3 `PATCH /api/admin/lake-routes` (update)

- Request `{ "targetId", "bucket", "alias"?, "tier"?, "writable"?, "namespaces"?, "label"? }`.
- `bucket` and `targetId` identify the route and are immutable.
- An alias change is accepted only with `"confirmAliasChange": true` because scripts reference aliases.
- Without it the response is 409 `DECISION_REQUIRED` listing jobs that declare the route.
- Other statuses are as in 6.10.2.
- The platform route accepts no update (400).

#### 6.10.4 `DELETE /api/admin/lake-routes?targetId=<id>&bucket=<name>` (revoke)

| Status | Code | When |
|---|---|---|
| 200 | — | `{ "removed": true }`; bucket and tables untouched |
| 404 | `NOT_FOUND` | Not a route |
| 409 | `CONFLICT` | A sync task writes to it or a job declares it; `detail = { syncTasks: [...], jobs: [...] }` |
| 400 | `VALIDATION_FAILED` | Attempt to revoke the platform route |

The revoke conflict deliberately does not reuse the data-source in-use code; references must be removed first.

#### 6.10.5 Compatibility alias

- `/api/admin/lake-buckets` (GET / POST / DELETE) stays for one release as a thin alias.
- GET returns the external routes as an array, new fields included.
- POST registers with a derived alias, tier `other`, `writable=true`.
- DELETE revokes.
- `/api/admin/lake-buckets/candidates` is unchanged and additionally reports `alias` / `tier` on registered candidates.

#### 6.10.6 Job declaration fields

`POST|PUT /api/etl-jobs[/{id}]` body `glueConfig`:

```json
{ "lakeBuckets": [ { "bucket": "demo-detail-bucket", "access": "read" },
                   { "bucket": "demo-agg-bucket", "access": "write" } ],
  "defaultCatalogAlias": "agg",
  "executionRoleArn": "arn:aws:iam::<account>:role/customer-agg-job" }
```

EMR jobs carry the same two fields at the top level of the job body. Validation per bound target:

| Status | Code | When |
|---|---|---|
| 400 | `LAKE_ROUTE_NOT_FOUND` | A declared bucket is not a route of a bound target; `detail = { targetId, bucket }` |
| 400 | `LAKE_ROUTE_NOT_WRITABLE` | `access: "write"` on a read-only route |
| 400 | `VALIDATION_FAILED` | `defaultCatalogAlias` not among the job's catalogs; `--conf` byte budget exceeded |
| 400 | `LAKE_ROUTE_ALIAS_CONFLICT` | Hand-typed alias collides with a generated alias on a different bucket |
| 400 | `VALIDATION_FAILED` with `detail.reason = "exec-role-preflight"` | Custom role lacks a probed action; `detail.gaps[]` names action, resource, why |

- The alias conflict detail is `{ alias, userBucket, routeBucket }`.
- Success responses carry `_meta.notices[]` when user `--conf` entries were taken over by the platform.
- Sync tasks (`POST|PUT /api/sync[/{id}]`): `s3Config.tableBucket` must be a writable route, otherwise 400 `LAKE_ROUTE_NOT_WRITABLE` or `LAKE_ROUTE_NOT_FOUND`.
- Sync start (`POST /api/sync/{id}/start`) returns 409 with the same codes.

## 7. Security model

| Principle | Statement |
|---|---|
| IAM only | Bucket-level isolation is enforced by IAM on S3 Tables ARNs; the platform never calls Lake Formation |
| Per-job least privilege | Isolation between jobs comes from the execution role bound to the job; a declaration narrows what the preflight demands and grants nothing |
| Platform roles stay broad within the region | Platform default roles hold `s3tables:*` on `bucket/*` in their region; job-level isolation needs custom roles |
| Hand-typed catalogs allowed and unprobed | A user may register a Spark catalog for a non-route bucket; the platform appends it and IAM decides |
| `writable=false` is a product guard | It stops platform-produced writes; it does not alter IAM or stop a script whose role allows writing |
| What the platform never does | Create, delete or configure customer buckets; change bucket policies or encryption; copy data; grant IAM |
| Audit | Register, update and revoke are audited with before and after; job saves include the declaration; upgrade registrations carry actor `upgrade` |
| Data residency | Routes are per target and must be in the target's region; cross-region injection is impossible by construction |
| Secrets | None involved; route rows contain no credentials |

Details:

- The federated Glue catalog is created with `IAM_ALLOWED_PRINCIPALS` and `Identifier=bucket/*`.
- Audit actions: `lake.route.register`, `lake.route.update`, `lake.route.revoke` (resource `s3-table-bucket`; detail: targetId, region, alias, tier, writable, namespaces, before/after for update).
- The platform creates namespaces or tables in a route only through an explicit user action (sync task target, create-table, job script).
- The platform is not a policy enforcement point for arbitrary Spark configuration.

## 8. Compatibility and migration

| Item | Behaviour after upgrade |
|---|---|
| Existing registry rows | Alias, tier and writable derived on first read and written back once, idempotently |
| Existing Glue / EMR jobs | No declaration means all routes; `--conf` byte-identical without external routes; `--bgp_table_bucket` unchanged |
| Jobs with hand-typed `--conf` | Same alias and bucket: taken over with a notice; same alias, different bucket: 400 on next save; unknown aliases appended |
| Home sync tasks writing to an unregistered bucket | Upgrade step auto-registers each such bucket as a route; runtime start of an unregistered bucket is 409 |
| Non-home sync tasks | Already required registration; unchanged |
| `/api/admin/lake-buckets` clients | Alias kept for one release (section 6.10.5) |
| Audit action names | `lake.external-bucket.register` / `.unregister` replaced by `lake.route.register` / `.revoke`; no consumer parses them |
| Environment variables | None added; `EMR_S3TABLES_WAREHOUSE_ARN` becomes unread, stays one release, then is removed |
| DynamoDB | No new tables; rows gain attributes under the same key |
| Deployment | Home: platform upgrade script (platform ECS, EMR and Flink stacks, migration step); regions: page "Redeploy" for Flink IAM; agents: redeploy after Phase 2 |
| Rollback | Previous image ignores new attributes; `--conf` returns to one catalog; injected-route jobs fail until hand-typed `--conf` is restored |

Migration details:

- Alias derivation: lower-case; characters outside `[a-z0-9_]` become `_`; prefix `b_` when the first character is not a letter; truncate to 32; `_2` suffix on collision.
- Write-back uses a conditional update (`attribute_not_exists(alias)`) so concurrent tasks stay idempotent.
- The upgrade script gains a dedicated step that runs `scripts/lib/lake-routes-migrate.mjs`.
- The step scans home sync tasks and registers each unknown `s3Config.tableBucket` as a route through the author's row shape.
- Auto-registered routes get a derived alias, tier `other`, writable `true`, the label `auto-registered by upgrade`, and an audit row with actor `upgrade`.
- A golden test asserts the migration fixture mirrors a real settings row.
- The runtime safety net is 409 `LAKE_ROUTE_NOT_FOUND` with the fix "register it"; there is no silent runtime registration.
- The post-deploy truth script gains the check "no home sync task references an unregistered bucket".
- Rollback failures for jobs that relied on injected routes surface as `TABLE_OR_VIEW_NOT_FOUND` and are documented in the release notes.

## 9. Observability and failure modes

| Failure | User-visible result | Recovery |
|---|---|---|
| Declared bucket no longer a route | Save / run 400 `LAKE_ROUTE_NOT_FOUND` naming target and bucket; scheduled run row `failed` | Re-register or edit the declaration |
| Namespace in two routes, no ownership | 400 `LAKE_ROUTE_AMBIGUOUS` listing both buckets | Declare ownership on one route |
| Namespace in no route | 400 `LAKE_ROUTE_NOT_FOUND` | Register the bucket or fix the namespace |
| Custom role lacks a bucket action | Save 400 with `gaps[]` (action, ARN, why, remedy) | Grant, use the role advisor, or drop the route |
| Policy evaluation unavailable (SCP, throttling) | Preflight `unverifiable`; save proceeds; shown as "could not verify" | Retry "check permissions"; runtime 403 shown verbatim |
| `ListNamespaces` throttled or slow | Waits on the SDK budget, then 502 `UPSTREAM_ERROR` naming the bucket | Retry; declare `namespaces[]` |
| Hand-typed alias collides with a generated alias | Save 400 `LAKE_ROUTE_ALIAS_CONFLICT` with both buckets | Rename or remove the lines |
| `--conf` exceeds the Glue ceiling | Save 400 `VALIDATION_FAILED` with byte count and limit | Declare a subset |
| Sync task targets a read-only route | Save 400 / start 409 `LAKE_ROUTE_NOT_WRITABLE` | Pick a writable route or flip the flag |
| Route row half-written | Read derives alias again; write-back retried; reads never block | None needed |
| Cache staleness across ECS tasks | A new route may be missing from a read-side list for up to 15 seconds; write guards unaffected | Wait or refresh |
| Governance push for a non-home target fails | Long-operation result lists the target and error; other targets still pushed | Fix the target and rerun "sync columns" |

Metrics and logs:

- The author logs one line per resolution failure with code, target, value and candidate buckets.
- The long-operation framework already surfaces governance push outcomes.
- Audit rows cover every write.
- No new dashboards are required for Phases 1 and 2; Phase 3's permission matrix is the operator view.

## 10. Rollout plan

| Phase | Scope | Exit criteria |
|---|---|---|
| 1 — Core routing | Data model, author, resolution, Glue / EMR / sync injection, preflight by bucket, IAM and synth gate, settings card, job block, sync dropdown, migration, API | Local gates green; page scenarios LR-1 to LR-8 pass on two regions; contract snapshot unchanged |
| 2 — Read side | Query tree tags, governance push per target, create-table bucket choice, BI builder, NL2SQL, plan discovery / codegen, lineage FQN, prompts | LR-9 to LR-12 pass; agents redeploy check clean; contract snapshot unchanged |
| 3 — Governance (next release) | Permission matrix, least-privilege role generator for routes, Flink `lakeRoute` sink and role IAM | LR-13 to LR-14 pass; matrix cells agree with `SimulatePrincipalPolicy` cross-checks |

- Local gates: type check, unit tests, naming parity, synth gate, red-line scan, IAM manifest.
- Each phase ends with the full headless gate on a test account (both regions), the contract-guard before/after comparison, and release notes stating the home-sync behaviour change.

## 11. Test plan

### 11.1 Unit tests

| Area | Assertions |
|---|---|
| Author grammar | Alias regex accepts `detail`, `agg_2`; rejects `Detail`, `1a`, 33 characters, reserved names; derivation with collision suffix |
| Author resolution | Three outcomes of `routeForNamespace` (0 / 1 / 2+); ownership short-circuits probing; single-route fast path; a miss rejects with `LAKE_ROUTE_NOT_FOUND` |
| Registration guard | Namespace overlap, alias reuse, platform bucket each produce their code |
| `sparkCatalogConf` | Glue output for the platform route equals today's five lines byte for byte; EMR output equals today's; per-route multiplication; default line only on request |
| `rejectUserCatalogConf` | Same alias and bucket dropped with notice; same alias other bucket throws; unknown alias untouched |
| Byte budget | Size computed from the real string; rejection at the ceiling only |
| Ratchets | `spark.sql.catalog.` literal only in `lib/lake/routes.ts`; call sites import the author (source-literal wiring, not only the import) |
| Preflight | Read set for `read`, read plus write for `write`; Glue adds catalog probes, EMR does not; TempDir baseline targets the scripts bucket; one gap per missing action |
| Sync guard | Home unregistered rejected; registered writable passes; registered read-only rejected |
| Migration script | Fixture row shape equals a real settings row (golden); idempotent rerun; audit actor `upgrade` |
| Read side | Query tree fields; push called once per ready target; create-table without bucket 400; BI uses the resolved bucket; codegen groups by alias |
| Routes API | Status matrix of section 6.10; compatibility alias shapes |
| Components | Server render of settings card, job block, sync picker, Athena tag with the listed testids; form id passthrough |
| Environment keys | Key list unchanged this release |

### 11.2 Mutation tests (each must turn a test red)

1. Remove the ambiguity branch in `routeForNamespace` (return the first hit).
2. Restore the first-route fallback.
3. Delete the `lakeRouteProbes` call in `preflightExecutionRole`.
4. Revert the home EMR stack to the single-bucket ARN (synth gate).
5. Remove `--bgp_lake_catalogs` from the reserved arguments.
6. Skip `rejectUserCatalogConf` in `ensureGlueJob`.

### 11.3 Synth gate

- New IAM-shape assertion for `BgpEmrStack`, `BgpFlinkStack`, `BgpExecEnv-*-flink` (section 6.7).
- Existing `PassRole` shape assertions from the execution-role binding design are unchanged.
- IAM manifest: no new task-role calls; the manifest test additionally evaluates the federated-catalog probe ARN forms.

### 11.4 Page-driven end-to-end scenarios (headless browser, two regions)

| # | Scenario | Pass condition |
|---|---|---|
| LR-1 | Settings: register two buckets as `detail` / `agg` with tiers | Table shows alias, tier, writable; audit rows exist |
| LR-2 | New Glue job, no parameters, cross-bucket script | Run `succeeded`; `--conf` holds both catalogs; `--bgp_lake_catalogs` present |
| LR-3 | Default catalog `agg`, two-part name | `succeeded` |
| LR-4 | Custom role with `agg` only; declaration `detail: read`, `agg: write` | Save 400 names `s3tables:GetTableData` on the detail ARN; grant; refresh; save 200; run `succeeded` |
| LR-5 | Home EMR job across both customer buckets | `succeeded` |
| LR-6 | Sync wizard on home picks a non-route bucket | Rejected with register link; register; rerun writes into the customer bucket |
| LR-7 | Negative: second bucket with the same namespace | 409 with both bucket names; declare ownership; 201 |
| LR-8 | Negative: hand-typed `--conf` alias `detail` to a third bucket | Save 400 `LAKE_ROUTE_ALIAS_CONFLICT` |
| LR-9 | Lake query page tree | Namespace tags `detail · detail`, `agg · agg` visible |
| LR-10 | Governance: "sync columns" on the second region, then create-table into `agg` | Catalog lists that region's customer tables; table created in the chosen bucket |
| LR-11 | NL2SQL question on a table in the `agg` bucket | Answer returned; SQL three-part name points at the agg bucket |
| LR-12 | Existing job (no declaration) and existing sync task after upgrade | Save without change keeps identical values; run `succeeded` |
| LR-13 (Phase 3) | Permission matrix | Role B denied on the detail bucket, allowed after grant |
| LR-14 (Phase 3) | Flink job with `lakeRoute` = `agg` | Rows land in the agg bucket |
| LR-T | Teardown | Scenario objects removed; showcase objects untouched |

- Judges read user-visible text and `data-testid`s, never antd internals.
- Locale is pinned by the shared helper.
- Every object created is deleted at the end.

## 12. Risks and limits

| Risk / limit | Mitigation |
|---|---|
| Spark three-part names | Page copy and handbook state it; copy-ready examples; `defaultCatalogAlias` covers single-bucket jobs |
| Glue `DefaultArguments` value ceiling | Author measures real bytes and rejects over-budget declarations; UI warns above 10 routes; subsets for many buckets |
| `ListNamespaces` latency and quotas | 15-second cache per bucket; explicit `namespaces[]` skips discovery; single-route fast path |
| Behaviour change for home sync tasks | Upgrade step auto-registers with audit; post-deploy check; release notes; runtime 409 names the fix |
| Alias rename breaks scripts | Alias immutable without explicit confirmation; confirmation lists affected jobs |
| Same namespace in two tiers is normal | Ownership declaration is a required, cheap step; three-part names unaffected |
| Two regions, same bucket name | Open question Q1; interim: suffix non-home databases with the region |
| EMR S3 Tables catalog needs public API reachability | Unchanged; documented limitation of the EMR path |
| Preflight ARN forms for the federated Glue catalog | Confirmed by the IAM manifest test before Phase 1 exit |
| Platform roles broad within a region | Documented; job-level isolation requires custom roles |
| Hand-typed catalogs bypass product guards | By design (section 7); IAM remains the control |

Notes:

- Cross-catalog access requires `<alias>.<namespace>.<table>`; a two-part name resolves inside the default catalog only.
- One route costs about 430 to 610 bytes of `--conf`; under a 10 KB ceiling that is roughly 16 to 23 routes per job.
- The exact ceiling must be confirmed against the Glue API reference before implementation (Q7).
- Live discovery costs one paginated call per route per resolution.
- OpenMetadata database names are bucket names, which is why same-named buckets in two regions collide.

## 13. Decisions (proposed, pending product-owner sign-off)

| # | Decision | Rationale |
|---|---|---|
| D1 | Phases 1 and 2 ship together; Phase 3 ships in the following release | Core routing without the read side leaves customer-bucket tables invisible in catalog and NL2SQL |
| D2 | Default declaration = all routes of the region, access derived from `writable` | Zero configuration gives cross-bucket for free; subsets only for least privilege or byte budget |
| D3 | Declarations carry an access mode per bucket (`read` / `write`) | Without it the preflight would demand write on a bucket the job only reads |
| D4 | Home sync tasks must target a route; the upgrade step auto-registers existing targets | One source of truth for writable external buckets; no silent runtime registration |
| D5 | The platform route is implicit (never a row), alias fixed `s3tablescatalog` | Byte-identical behaviour for existing scripts and regions without external routes |
| D6 | Routes belong to the execution target, not to a project | Matches the customer's shape and the residency model |
| D7 | IAM only; no Lake Formation | Bucket isolation is already expressible in IAM; Lake Formation adds a second model and a dependency |
| D8 | Engine-specific catalog implementations emitted by one author: Glue `GlueCatalog`, EMR S3 Tables catalog | Both recipes exist and are proven; unifying them is a separate risk |
| D9 | Canonical API `/api/admin/lake-routes`; `/api/admin/lake-buckets` kept one release as an alias | The list shape changes; a new path avoids breaking clients |
| D10 | Hand-typed Spark catalogs for non-route buckets remain allowed and unprobed | Preserves the documented workaround; IAM is the enforcement point |
| D11 | Alias change requires explicit confirmation listing affected jobs | Aliases appear in scripts; a silent rename breaks runs |
| D12 | Tier is a closed six-value list, display-only | Compliance labelling without inventing permission semantics; extensibility is Q3 |
| D13 | The synth gate gains a dedicated assertion and the upgrade script a dedicated step | Existing identifiers are taken; new ones avoid collisions |

## 14. Open questions

| # | Question | Proposed answer |
|---|---|---|
| Q1 | Two regions may hold same-named buckets; the OpenMetadata database is named after the bucket | Suffix non-home databases with the region only on collision; decide before Phase 2 |
| Q2 | Should `writable=false` make the preflight refuse a role that could write the bucket? | No; intent is unknowable; keep `writable` as a product guard and show the matrix (Phase 3) |
| Q3 | Should the tier list be customer-extensible? | Not in the first release; collect demand |
| Q4 | Should a revoked route's jobs be auto-edited? | No; revoke is blocked while references exist (409 listing them) |
| Q5 | Should EMR move to the `GlueCatalog` implementation for parity with Glue? | Separate evaluation; both recipes stay |
| Q6 | Should the Flink SQL template expose one catalog per route (Phase 3)? | Start with one sink route; extend if asked |
| Q7 | Exact Glue `DefaultArguments` per-value ceiling | Confirm against the API reference; encode as a constant with a test |
| Q8 | Should the permission matrix include roles of jobs in other targets? | No; a matrix is per target, like the routes |

## Appendix A — Spark catalog property templates

### A.1 Glue (Iceberg `GlueCatalog`), per route

Supported Glue versions are listed in [Supported versions](../supported-versions.md).

```text
spark.sql.catalog.<alias>=org.apache.iceberg.spark.SparkCatalog
spark.sql.catalog.<alias>.catalog-impl=org.apache.iceberg.aws.glue.GlueCatalog
spark.sql.catalog.<alias>.glue.id=<account>:s3tablescatalog/<bucket>
spark.sql.catalog.<alias>.io-impl=org.apache.iceberg.aws.s3.S3FileIO
spark.sql.catalog.<alias>.warehouse=arn:aws:s3tables:<region>:<account>:bucket/<bucket>
```

- Optional once per job: `spark.sql.defaultCatalog=<alias>`.
- Reserved job argument: `--bgp_lake_catalogs=s3tablescatalog=<platform-bucket>,detail=<bucket-a>,agg=<bucket-b>`.

### A.2 EMR Serverless (Iceberg S3 Tables catalog)

```text
--jars <EMR_S3TABLES_JAR>
--conf spark.sql.extensions=org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions
--conf spark.sql.catalog.<alias>=org.apache.iceberg.spark.SparkCatalog
--conf spark.sql.catalog.<alias>.catalog-impl=software.amazon.s3tables.iceberg.S3TablesCatalog
--conf spark.sql.catalog.<alias>.warehouse=arn:aws:s3tables:<region>:<account>:bucket/<bucket>
--conf spark.bgp.lakeCatalogs=s3tablescatalog=<platform-bucket>,detail=<bucket-a>,agg=<bucket-b>
```

### A.3 Flink SQL (Phase 3, one sink route)

```sql
CREATE CATALOG s3t WITH (
  'type' = 'iceberg',
  'catalog-impl' = 'software.amazon.s3tables.iceberg.S3TablesCatalog',
  'warehouse' = '${TABLE_BUCKET_ARN}'   -- resolved to the job's lakeRoute, else the platform route
);
```

### A.4 Reading the route map from a script

```python
# Glue
args = getResolvedOptions(sys.argv, ["JOB_NAME", "bgp_lake_catalogs"])
catalogs = dict(kv.split("=", 1) for kv in args["bgp_lake_catalogs"].split(","))
# catalogs == {"s3tablescatalog": "<platform-bucket>", "detail": "<bucket-a>", "agg": "<bucket-b>"}
spark.sql(
    "INSERT OVERWRITE TABLE agg.agg.orders_daily "
    "SELECT dt, sum(amount), count(*) FROM detail.detail.orders_detail GROUP BY dt"
)

# EMR
catalogs = dict(kv.split("=", 1) for kv in spark.conf.get("spark.bgp.lakeCatalogs").split(","))
```

## Appendix B — Today's no-code workaround and how this design supersedes it

The customer handbook for the current release ("one offline job reading and writing several S3 Tables buckets") documents a procedure that needs no platform change:

1. Create the two table buckets and their namespaces with the AWS CLI in the job's region and account.
2. Optionally register both buckets under "System settings -> Lake external table buckets" (per execution environment, chosen through the scope selector) so the query tree, governance catalog and NL2SQL list their tables.
3. Create a Glue PySpark job; write every table as a three-part name `<catalog>.<namespace>.<table>`.
4. Under "Advanced properties -> Job parameters" add one `--conf` parameter whose value chains five Spark properties per bucket (template A.1 with account id, region and bucket names typed by hand; ten properties for two buckets).
5. Keep a supported Glue version, save, run, and verify in the lake query page with `"s3tablescatalog/<bucket>"."<namespace>"."<table>"`.
6. Known failure modes listed there:
   - two-part names fail with `TABLE_OR_VIEW_NOT_FOUND`;
   - an unregistered catalog name fails with `REQUIRES_SINGLE_PART_NAMESPACE`;
   - a custom role without `s3tables` permissions fails at run time with 403 naming `s3tables:GetTableBucket`;
   - upper-case names fail in the federated catalog;
   - the lake query page rejects `INSERT`.
7. Permissions: the platform Glue role already reaches any bucket in its region, so the workaround needs no IAM change, but jobs are not isolated from each other.

What this design changes:

| Workaround step | After this design |
|---|---|
| Hand-typed `--conf` with account, region, ARNs | Register the bucket once as a route; the platform injects the catalog for every job of the region |
| Catalog name chosen in the `--conf` | Alias chosen at registration, shown on the job page, copy-ready example |
| Registration = visibility only | Registration = route: visibility, writability, alias, tier, ownership |
| 403 at run time | 400 at save time naming the action and the bucket ARN |
| Platform Glue role for everything | Per-job custom role with a declaration of exactly which buckets are read and written |
| Only Glue | Glue, EMR (home included), sync; Flink in Phase 3 |
| Customer-bucket tables absent from create-table, BI, NL2SQL seeds, lineage, non-home catalog | All resolve through the route table |
| Existing hand-typed jobs | Keep working; identical entries are taken over by the platform with a notice |

The handbook remains valid for the current release and for any catalog that a customer deliberately keeps outside the route table.
