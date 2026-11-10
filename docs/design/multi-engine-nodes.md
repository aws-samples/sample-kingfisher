# Multi-Engine Nodes — Batch Multi-Engine Support + Rich Node Types (Two Phases, A and B): Detailed Design

> 📌 **Scope note (reconciled on 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For behavior under multi-region operation — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of this module is tracked in the design-document index. Paths mentioned in this document that no longer exist indicate that the idea was not implemented as written here or has since been superseded.

> - Revision: 1.0 (Phase A; **✅ implemented and verified in production (Phase A complete)**) (document audit calibration on 2026-08-26: the original status header was out of date — it read "code not yet started, awaiting the go signal") | Created: 2026-07-03 | Maintainer: Architecture
> - Parent roadmap: the 2026-08 roadmap that benchmarks the platform against a leading cloud data-development suite (historical, single-region stage; not part of this repository), section 3, the row for this module (roadmap items B1 / B4)
> - Related reference implementations: `lib/versions/version-service.ts` (table-driven registry) · `lib/network-advisor/prefill-adapters.ts` (factory adapter; `emr` already reserved)
> - Related lessons learned (engineering notes): `taskrole-inline-policy-10kb-limit` · `cdk-cross-stack-export-deadlock` · `full-param-parity-with-managed-consoles` · `network-private-only` · `glue-version-5.1` · `keep-reusable-resources`

---

## 0. Decisions made on 2026-07-03 (this design is based on them)

| # | Decision | Outcome | Impact on the design |
|---|---|---|---|
| ① Data model | **New table `bgp-engine-jobs`** | EMR jobs are stored in their own table | Zero pollution of the existing etl-jobs table |
| ② Front-end entry point | **Merged into the ETL jobs page; EMR = one more engine** | From the user's point of view, "batch jobs gain one more engine option" | The etl-jobs front-end page gets an incremental "engine routing" change (details in section 8) |
| ③ Parameter exposure | **Expose everything + connection information up front** | Wherever connection information exists (VPC / subnets / security groups / data sources) it must be exposed and filled in completely **at job creation time**; the network advisor validates it up front; errors must not wait until run time ("no littering") | Section 7: all parameters exposed + section 8: the form embeds the network advisor for up-front validation |
| ④ Application | **One dedicated application per job, never shared** | Sharing causes resource contention and head-of-line blocking ("the tail-latency lock-up is unacceptable"); applications are **created / deleted dynamically per job by the back end** (deleting the job deletes the application; zero leftovers) | Section 6: CDK does not create a shared application; section 7.2: per-job lifecycle |
| ⑤ Isolation granularity | **Per job** (one dedicated application per job) | Confirmed | The most thorough isolation, zero contention, deleting the job deletes the application (zero leftovers). **Note**: the platform's `userId` is always `default-user`, so a literal "per user" would degrade into global sharing; hence per job |

---

## 1. Goals and scope

**Two phases; this design covers only Phase A:**

| Phase | Theme | This design | Notes |
|---|---|---|---|
| **Phase A** | **Batch multi-engine (engine integration)** | ✅ This document | Engine SPI as a plug-in mechanism + integration of **EMR Serverless** (application + job run); the job form is **Spark only (PySpark scripts)** |
| Phase B | Rich node types (branch / loop / assignment / merge …) | ❌ Scheduled for later | **Requires a refactor of `dag-generator`; it is not a pure increment and is done separately** (not touched in this phase) |

**Phase A hard boundaries (red lines):**
- **The only engine is EMR Serverless**: the application + job-run form; **no classic EMR clusters, no EMR on EKS**.
- **The only job form in this phase is Spark (PySpark scripts)**; Hive / Presto (Trino) are left for later (the SPI reserves capability slots for them).
- **Engines are plug-ins through an SPI**: registry + adapter; a new engine = **a separate directory as a pure increment + one line in the registry**.
- **Zero-change boundary (adjusted according to decision ②)**:
  - **Zero changes to the execution layer**: `lib/etl/job-service.ts`, the execution sub-routes of `app/api/etl-jobs/[id]/*` (run / logs / …), `app/api/sync/**`, and the seven hard-coded dispatch points of section 3.1 — **not a single line is touched**. EMR goes entirely through the brand-new `lib/engines/**` + `app/api/engines/**`.
  - **Incremental change in the front-end fusion layer**: because decision ② says "merge into the ETL jobs page", `app/etl-jobs/page.tsx` (list + create) gets an incremental **engine routing** change — choosing EMR calls `/api/engines` + the new table; choosing Glue / Redshift goes through the old API unchanged. This is a new dispatch in the UI orchestration layer and **does not alter the old execution logic**.

**Non-goals (not in this phase)**: node-type extensions (Phase B); converting the old engines (Glue / Redshift / Flink) into SPI providers (left as a gradual adapter; non-blocking).

---

## 2. Design principles (copied from the two SPI reference implementations in the repository)

### 2.1 Reference one · table-driven registry (`lib/versions/version-service.ts:16-37`)
```ts
export type ResourceType = "workflow" | "etl-job" | "sync" | "redshift-task";
const RESOURCES: Record<ResourceType, ResourceMeta> = { workflow: {...}, ... };
export function isResourceType(v: unknown): v is ResourceType { return typeof v === "string" && v in RESOURCES; }
```
→ **Borrowed**: `Record<EngineType, EngineProvider>` + an `isEngineType` guard + `getProvider(type)`. **Adding an engine = adding one row to the table**.

### 2.2 Reference two · factory adapter switch (`lib/network-advisor/prefill-adapters.ts:44-56`)
```ts
export function prefillFor(kind: ComputeKind, p): Prefill { switch (kind) { ... case "emr": case "generic": default: return toGeneric(p); } }
```
→ `ComputeKind` in `network-advisor/types.ts:17` **already reserves `emr`**; the up-front EMR connection information (section 8) reuses the network advisor directly, with no new discriminator needed.

### 2.3 A third isomorphic confirmation
`CATALOGS: Record<ParamChannel, ParamDef[]>` in `lib/param-advisor/catalog.ts:169` is likewise "table-driven + discriminated union". The EMR parameter advisor adds an `emr` channel following this pattern (section 7.4, done in this phase).

---

## 3. Findings of the current-state survey (hard evidence from four read-only exploration agents, 2026-07-03)

### 3.1 Zero abstraction in the execution layer; seven hard-coded engine dispatch points (**none of them touched in this phase**)

| # | file:line | Discriminator | Notes |
|---|---|---|---|
| 1 | `lib/etl/job-service.ts:350` | `job.type === "glue"` | Main entry point of ETL submit |
| 2 | `lib/etl/job-service.ts:120,127` | `run.glueJobRunId&&glueJobName` / `run.statementId` | ETL reconcile dispatch |
| 3 | `app/api/etl-jobs/[id]/logs/route.ts:50,89` | Same as above | ETL log dispatch |
| 4 | `app/api/sync/[id]/start/route.ts:103,106` | `channel` | Sync start dispatch |
| 5 | `app/api/sync/[id]/start-realtime/route.ts:48,51` | `channel!=="dms"`+`syncMode` | DMS start |
| 6 | `app/api/sync/[id]/stop/route.ts:26,34` | `channel`/`glueJobName` | Sync stop dispatch |
| 7 | `lib/sync/reconcile.ts:15` | `channel!=="glue"` | Sync reconcile |

### 3.2 Five method semantics already exist (the source from which the SPI interface is induced)

| Semantics | Glue / Redshift (`job-service.ts`) | Flink (`flink-service.ts`) |
|---|---|---|
| submit | `runGlueScriptJob:223` / `runRedshiftSqlJob:282` → `RunResult` | `startFlinkJob:490` |
| poll | `pollGlueRun:253` / `pollRedshiftRun:353` (private; in-process polling, 15 s × N) | `describeFlinkJob:624` |
| stop | **Missing on the ETL side** (sync does `BatchStopJobRun` in the route layer) | `pauseFlinkJob:543` |
| readLogs | Engine branch in the route layer `logs/route.ts` | `readFlinkLogs:700` |
| reconcile | `reconcileEtlJob:114` (reconcile on read; writes task-runs + etl-jobs) | `reconcileFlinkStatus:651` (writes flink-jobs) |

- Types to replicate: `RunOpts` (`job-service.ts:41`), `RunResult` (`:46`), `createRunRecord` (`:54`), `finishRunRecord` (`:77`).
- Pattern for landing Glue scripts in S3 (`ensureGlueJob:151-160`): bucket `bgp-glue-scripts-<acct>` (env `GLUE_SCRIPTS_BUCKET`), `PutObjectCommand` with Key=`glue-scripts/etl/<jobId>.py`. EMR follows the same pattern with its own prefix `emr-scripts/<jobId>.py`.

### 3.3 Contract of the unified run-record table `bgp-task-runs`
- Table `TABLES.TASK_RUNS` (`dynamodb.ts:17`); CDK `database-stack.ts:31` with PK=`taskId` / SK=`runId`; **no GSI, no TTL**; the monitoring page uses `Scan` (`monitor/runs/route.ts:36`).
- **Unified status vocabulary of 4 values**: `running/succeeded/failed/stopped` (there is no central enum file; it is a convention).
- **Minimal Item**: `taskId,runId(ulid),taskType,status,startedAt,triggeredBy`; terminal states add `finishedAt,duration(seconds),error`.
- **Reserved words**: Updates to `status/duration/error/metrics/result` must use `ExpressionAttributeNames` aliases.
- **⚠️ Correction to the earlier handover note**: it is not the case that "Flink / DMS / Zero-ETL are all absent from task-runs" — **only Flink is absent** (it writes its own table `bgp-flink-jobs`; evidence `evidence.ts:137`); **DMS / Zero-ETL are already written** (`taskType:"sync"` + `channel`). The handover note has been corrected.
- **Where EMR belongs**: EMR is a "batch job with a terminal state", isomorphic to Glue / Redshift (Put running → poll to the terminal state → Update). The EMR provider writes task-runs directly → it naturally appears in monitoring / the ops dashboard.

### 3.4 API route and front-end conventions
- First line `dynamic="force-dynamic"`;
- `requireProject(req,viewer/editor)` at collection level, `guardResourceAccess` at resource level;
- Unified `apiOk/apiError` + `ApiErrorCode` (carry a code as flink does; do not imitate the bare json of sync/[id]);
- `USER_ID="default-user"`;
- Creation writes all tenant fields;
- Side effects use `.catch(()=>{})`;
- DynamoDB reserved-word aliases.
- Dynamic segment `[engine]` → `params.engine` (a natural fit for the SPI).
- The front end uses bare `fetch` + `d.success`; the token / project / env headers are injected by the global interceptor.
- The advisor panels `ParamAdvisorPanel` / `NetworkAdvisorPanel` follow the `request/onPrefill` contract.

### 3.5 CDK / IAM placement
- **Gated leaf-stack pattern**: `FlinkStack` / `RealtimeStack` are gated by `-c enable-xxx=1`, take `{env,vpc,dataKey}`, are referenced by nothing, and can be destroyed on their own.
- **Execution role**: the six permission blocks in `flink-stack.ts:34-93` ≈ the full set for an EMR execution role, with the trust principal changed to `emr-serverless.amazonaws.com`.
- **10 KB red line** (`taskrole-inline-policy-10kb-limit`): the IAM permissions for the platform to call EMR **must** be a new, separate `ManagedPolicy(roles:[taskRole])` (following `platform-stack.ts:353-371`); **`taskRole.addToPolicy` is forbidden**.
- **Avoid pinned stacks** (`cdk-cross-stack-export-deadlock`): no CloudFormation exports; the back end discovers applications by tag / name.
- The SDK `@aws-sdk/client-emr-serverless` **is not installed** (add `^3.1019.0`); the CDK `aws-cdk-lib/aws-emrserverless.CfnApplication` is ready.

---

## 4. SPI architecture design (the core of this phase)

### 4.1 Engine type discriminator (`lib/engines/types.ts`)
```ts
export type EngineType = "emr-serverless";   // 未来 emr-hive/emr-presto/(回补)glue/redshift 顺势加

export interface EngineJob {
  userId: string;            // "default-user"（物理分区键）
  jobId: string;             // ulid
  engine: EngineType;        // 判别式
  name: string; projectId: string; env: string;
  script: string;            // PySpark 源码
  entryPoint?: string;       // 主脚本 S3 路径（默认由 script 落 S3 派生）
  entryPointArguments?: string[];
  sparkConf?: Record<string, string>;   // 追加 --conf（保留键黑名单，§7.3）
  spec: EmrSpec;             // driver/executor 规格（§7.3，全暴露）
  network: EmrNetwork;       // 连接信息（VPC/子网/SG/数据源）——创建时前置填清（§8，"别乱丢垃圾"）
  applicationId?: string;    // 本作业专属 application（per-作业动态创建，§7.2）
  status: EngineJobStatus;
  lastRunId?: string; lastRunStatus?: string; lastRunAt?: string;
  createdBy: string; createdBySub: string; createdAt: string; updatedAt: string;
}
export type EngineJobStatus = "draft" | "ready" | "running" | "succeeded" | "failed";
```

### 4.2 The EngineProvider interface (`lib/engines/spi.ts`; semantics derived from section 3.2)
```ts
export interface RunOpts { runDate?: string; triggeredBy?: string; }        // 复刻 job-service.ts:41
export interface RunResult { runId: string; nativeRunId?: string; runDate?: string; }
export interface EngineCapabilities { canStop: boolean; logsSource: "s3"|"cloudwatch"|"managed"; supportsDryRun: boolean; }

export interface EngineProvider {
  type: string;
  capabilities: EngineCapabilities;
  ensureResource(job: EngineJob): Promise<string>;          // per-作业 application：CreateApplication 幂等，返回 applicationId
  destroyResource(job: EngineJob): Promise<void>;           // 删作业时 StopApplication+DeleteApplication（零垃圾）
  submit(job: EngineJob, opts?: RunOpts): Promise<RunResult>;   // 建 running 记录 + StartJobRun + 起后台 poll
  poll(job: EngineJob, runId: string, nativeRunId: string): Promise<void>;   // 轮询终态 → finishRunRecord
  stop(job: EngineJob, runId: string, nativeRunId: string): Promise<void>;   // CancelJobRun + 收口 stopped
  readLogs(job: EngineJob, runId: string, nativeRunId: string): Promise<{time?:string;level?:string;msg:string}[]>;
  reconcile(job: EngineJob): Promise<EngineJob>;            // 读时对账（照 reconcileEtlJob:114）
}
```
> `ensureResource/destroyResource` are the two methods this design **adds** relative to the old engines (the old engines' applications are static and do not need them) — because decision ④ requires a dynamic per-job application.

### 4.3 Registry (`lib/engines/registry.ts`, copied from version-service.ts)
```ts
const PROVIDERS: Record<EngineType, EngineProvider> = { "emr-serverless": emrServerlessProvider };  // 加引擎只加一行
export function isEngineType(v: unknown): v is EngineType { return typeof v === "string" && v in PROVIDERS; }
export function getProvider(type: EngineType): EngineProvider { return PROVIDERS[type]; }
export function listEngines(): EngineType[] { return Object.keys(PROVIDERS) as EngineType[]; }
```

### 4.4 EMR provider (`lib/engines/emr/**`)
```
lib/engines/emr/
  provider.ts      # implements the seven EngineProvider methods
  application.ts   # per-job CreateApplication / DeleteApplication / ensureStarted (GetApplication STOPPED → StartApplication)
  spec.ts          # single source of truth for the EMR spec (section 7.3, everything exposed)
  network.ts       # EmrNetwork type + resolution of subnets / SGs from data sources / advisor prefill
  script.ts        # lands the PySpark script in S3 (following ensureGlueJob; prefix emr-scripts/<jobId>.py)
  run-record.ts    # createRunRecord / finishRunRecord (replicated from job-service.ts:54-94; writes bgp-task-runs)
```

---

## 5. Data model

### 5.1 EMR job definition table → **new table `bgp-engine-jobs`** (decision ①)
- Add `ENGINE_JOBS:"bgp-engine-jobs"` to `TABLES` in `dynamodb.ts`; add one row to `tables[]` in `database-stack.ts` with PK=`userId` / SK=`jobId`, reusing `hardened` (CMK / PITR / RETAIN / on-demand).
- Zero pollution of the old etl-jobs table; `reconcileEtlJob` cannot misjudge an EMR run.

### 5.2 Run records (written to the shared table `bgp-task-runs`, with status mapping)
Native EMR JobRun states → the 4 values: `SUBMITTED/PENDING/SCHEDULED/RUNNING→running`; `SUCCESS→succeeded`; `FAILED→failed`; `CANCELLING/CANCELLED→stopped`.
Item written: `taskId=jobId, runId=ulid, taskType="emr-serverless", status, startedAt, triggeredBy, nativeRunId(=jobRunId), applicationId, runDate`; terminal states add `finishedAt, duration(=totalExecutionDurationSeconds), error(=stateDetails), logS3Key`.

### 5.3 Parameter semantics
- `sparkConf` appends `--conf` entries, with a **platform reserved-key blacklist** (`spark.emr-serverless.*` and the items derived from the spec are generated by the platform; user conf cannot override them; aligned with item ① of `full-param-parity`).
- `spec` → `sparkSubmitParameters` is generated deterministically by `spec.ts` (section 7.3).

---

## 6. CDK infrastructure (new `infra/lib/emr-stack.ts`, a gated leaf stack; **no shared application is created**)

### 6.1 Gated instantiation (appended at the end of `bin/app.ts`, following `:97-99`)
```ts
if (app.node.tryGetContext("enable-emr") === "1") {
  new EmrStack(app, "BgpEmrStack", { env, vpc: vpc.vpc, dataKey: kms.dataKey });
}
```

### 6.2 EmrStack builds only the "shared foundation" (applications are created dynamically per job by the back end, decision ④)
CDK statically creates only 3 things (reusable by every per-job application, in line with `keep-reusable-resources`):
1. **EMR execution role** `bgp-emr-serverless-role` (copied from `flink-stack.ts:34-93`, trusting `emr-serverless.amazonaws.com`; six permission blocks: read on the scripts bucket / read-write on the data-lake bucket / `s3tables:*` limited to `bgp-table-bucket` / `glue:*` + `lakeformation:*` / Logs / `dataKey.grant` / VPC ENI). All through `emrRole.addToPolicy` (a new role; the 10 KB limit does not apply).
2. **Default security group** `bgp-emr-sg` (following `realtime-stack.ts:53-58`; the egress foundation for private subnets; users can choose other or additional security groups in a job).
3. Output `EmrRoleArn` (for display only; not exported as a dependency).

> **The application is not created in CDK** — because each job has its own application and they are created and deleted dynamically, static CDK is unsuitable. CDK only prepares the "role + network foundation"; the back end uses them to CreateApplication.

### 6.3 Platform-side IAM (**a separate ManagedPolicy; addToPolicy forbidden**)
Added to `platform-stack.ts` (following `:353-371`):
```ts
new iam.ManagedPolicy(this, "EmrServerlessOrchestration", {
  roles: [taskRole],
  statements: [
    new iam.PolicyStatement({ actions: [
      "emr-serverless:CreateApplication","emr-serverless:DeleteApplication",   // ④ per-作业动态增删
      "emr-serverless:StartApplication","emr-serverless:StopApplication",
      "emr-serverless:GetApplication","emr-serverless:ListApplications",
      "emr-serverless:StartJobRun","emr-serverless:CancelJobRun","emr-serverless:GetJobRun",
      "emr-serverless:ListJobRuns","emr-serverless:GetDashboardForJobRun","emr-serverless:TagResource"],
      resources: ["*"], conditions: { StringEquals: { "aws:RequestedRegion": region } } }),
    new iam.PolicyStatement({ actions: ["iam:PassRole"], resources: [`arn:aws:iam::${acct}:role/bgp-emr-serverless-role`],
      conditions: { StringEquals: { "iam:PassedToService": "emr-serverless.amazonaws.com" } } }),
  ],
});
```
- Environment variables (appended at `platform-stack.ts:530-608`; derived from the account to avoid cross-stack dependencies): `EMR_EXECUTION_ROLE_ARN`, `EMR_DEFAULT_SG_ID` (or Describe at run time), `EMR_CODE_BUCKET`, `EMR_OUTPUT_BUCKET`, `EMR_LOG_BUCKET`, `EMR_RELEASE_LABEL`.
- **Risk**: the first CreateApplication may require the EMR Serverless service-linked role (`AWSServiceRoleForAmazonEMRServerless`) — drawing on the service-linked-role experience recorded in the engineering note `bedrock-marketplace-devops-slr`, if verification reports a missing SLR, add `iam:CreateServiceLinkedRole` (limited to `emr-serverless.amazonaws.com`).

---

## 7. Back-end services and specification

### 7.1 File locations: see section 9.

### 7.2 Application lifecycle (per job, decision ④)
- **Create job**: `ensureResource` → `CreateApplication` (name=`bgp-emr-<jobId>`, `networkConfiguration` taken from the job's connection information of section 8, autoStart / autoStop managed), writing back `job.applicationId`. **Tags**: `bgp:jobId`, `bgp:managed=true` (for discovery / audit / orphan prevention).
- **Run**: `ensureStarted` (STOPPED → StartApplication) → `StartJobRun` (executionRole=`bgp-emr-serverless-role`).
- **Stop a run**: `CancelJobRun`.
- **Delete job**: `destroyResource` → `StopApplication` + `DeleteApplication` (**zero leftovers**, echoing "no littering").
- Idle cost: after autoStop (idleTimeoutMinutes) an application is not billed (many applications do not burn money); the next run autoStarts it.

### 7.3 Single source of truth for the EMR spec (`lib/engines/emr/spec.ts`; everything exposed, decision ③)
Following the `worker-types.ts` pattern, expose the core items the EMR Serverless console offers when submitting a Spark job:
```ts
export const EMR_RELEASE_LABELS = ["emr-7.5.0","emr-7.2.0","emr-6.15.0"];  // 默认最新(对齐 glue-version-5.1 精神)
export const EMR_ARCH = ["ARM64","X86_64"];                                 // 架构
export const EMR_CPU = ["1 vCPU","2 vCPU","4 vCPU","8 vCPU","16 vCPU"];
export interface EmrSpec {
  releaseLabel: string; architecture: "ARM64"|"X86_64";
  driver:   { cpu: string; memory: string; disk: string };
  executor: { cpu: string; memory: string; disk: string };
  executorCount: number;                 // spark.executor.instances
  preInitDriverCount?: number;           // 预热容量(降冷启动，可选)
  preInitExecutorCount?: number;
}
export const EMR_SPEC_DEFAULT: EmrSpec = { releaseLabel:"emr-7.5.0", architecture:"ARM64",
  driver:{cpu:"4 vCPU",memory:"16 GB",disk:"20 GB"}, executor:{cpu:"4 vCPU",memory:"16 GB",disk:"20 GB"}, executorCount: 2 };
export function toSparkSubmitParameters(s: EmrSpec): string { /* 确定性拼 --conf spark.driver.*/executor.* */ }
```
+ custom `sparkConf` additions + `entryPointArguments`. Of the application-level `architecture` / `imageConfiguration` (custom image), this phase exposes only architecture; custom images are left for later.

### 7.4 Advisors (decision ③: expose everything + connection information up front)
- **Network advisor up front (key point)**: the create-EMR-job form **must embed** `NetworkAdvisorPanel` (`computeKind:"emr"` is already reserved); the targets are assembled from the data sources / destinations the user entered; `onPrefill` fills `EmrNetwork.subnetIds/securityGroupIds`. **Connection information is validated completely at creation time**; an unreachable target is flagged on the spot instead of waiting for a run ("no littering"). Staged: `probe` returns the L1 facts within seconds → `advise` adds the verdict / explanation (text is fast).
- **Parameter advisor**: add an `emr` channel to `param-advisor` (`ParamChannel` in `types.ts:15` + EMR entries in `catalog.ts` + deterministic recommendations in `heuristics.ts` + an emr branch in `ParamPrefill` + synchronizing `CATALOG_TEXT` in `agent/paramadvisor/agent.js` — see the engineering note `full-param-parity`, item ⑦, the two places that must be synchronized by hand). The form embeds `ParamAdvisorPanel`; `onPrefill` writes back `spec`. Recommended values always come from the deterministic engine; the model only explains.

---

## 8. Front end (decision ②: merged into the ETL jobs page as one engine)

### 8.1 API routes `app/api/engines/[engine]/**` (the execution layer is independent; api/etl-jobs and api/sync are untouched)
```
engines/[engine]/route.ts          GET list (filtered by project + env + engine) / POST create (→ ensureResource creates the application)
engines/[engine]/[id]/route.ts     GET / PUT / DELETE (→ destroyResource deletes the application)
engines/[engine]/[id]/run/route.ts POST → getProvider(engine).submit()
engines/[engine]/[id]/stop/route.ts POST → provider.stop()
engines/[engine]/[id]/runs/route.ts GET run history (Query bgp-task-runs)
engines/[engine]/[id]/logs/route.ts GET → provider.readLogs()
engines/generate/route.ts          POST AI-generated PySpark (reuses Bedrock)
```
Inside the routes, an `isEngineType(params.engine)` guard → `getProvider` dispatch. Everything follows section 3.4.

### 8.2 Front end merged into `app/etl-jobs/page.tsx` (incremental engine routing; old execution logic unchanged)
- **Create dialog**: the engine / type selector grows from `[glue, redshift]` to `[glue, redshift, emr-serverless]`. Choosing EMR → the form switches to the EMR fields (PySpark editor + the spec of section 7.3 + a **connection-information area** (VPC / subnets / security groups / data sources) + an embedded `NetworkAdvisorPanel` (up-front validation) + `ParamAdvisorPanel`).
- **Submit routing**: the front end dispatches by the chosen engine — `emr-serverless` → `fetch("/api/engines/emr-serverless",…)`; `glue/redshift` → `fetch("/api/etl-jobs",…)` as before. (A new dispatch in the UI layer; zero changes to the old API calls.)
- **Merged list**: the list fetches `/api/etl-jobs` + `/api/engines/emr-serverless` concurrently and shows them merged (run / logs / stop for EMR rows go through the engines sub-routes).
- **Change footprint**: only `etl-jobs/page.tsx` (+ the job-type enum in `types/etl-job.ts` or a new engine constant). **Untouched**: `job-service.ts` and the back-end execution logic of `api/etl-jobs`.

---

## 9. File inventory

**Entirely new (execution layer fully independent):**
```
docs/design/multi-engine-nodes.md
platform/src/lib/engines/{types,spi,registry}.ts
platform/src/lib/engines/emr/{provider,application,spec,network,script,run-record}.ts
platform/src/lib/engines/__tests__/*.test.ts
platform/src/app/api/engines/[engine]/**
infra/lib/emr-stack.ts
```
**Existing files touched (incremental; old execution logic unchanged):**
```
platform/src/lib/aws/dynamodb.ts       # add one ENGINE_JOBS row to TABLES
infra/lib/database-stack.ts            # add one bgp-engine-jobs row to tables[]
infra/bin/app.ts                       # add the gated EmrStack
infra/lib/platform-stack.ts            # add the separate ManagedPolicy + env (no addToPolicy)
platform/src/app/etl-jobs/page.tsx     # ② engine routing: create dropdown + EMR form + merged list + submit dispatch
platform/src/types/etl-job.ts          # add emr-serverless to the job-engine enum (or a new constant)
platform/src/lib/param-advisor/{types,catalog,heuristics}.ts + infra/agent/paramadvisor/agent.js  # ③ emr advisor channel (+ CATALOG_TEXT sync)
platform/package.json                  # add @aws-sdk/client-emr-serverless
```
> The old engines' execution logic (`job-service.ts` / `flink-service.ts` / the execution sub-routes of `api/etl-jobs` / `api/sync` / the seven hard-coded dispatch points) is **unchanged**.

---

## 10. Implementation steps (each step: local verification → deploy → real-environment verification → local commit, no push)
1. **SPI skeleton**: `types/spi/registry` + `emr/spec` + `emr/network` (pure types / pure functions; unit tests for `toSparkSubmitParameters` / `isEngineType`).
2. **CDK**: `emr-stack.ts` (role + SG) + the `bin/app.ts` gate + the `platform-stack.ts` ManagedPolicy / env + the new table in `database-stack.ts`; `cdk synth`.
3. **Provider**: `emr/{application,script,run-record,provider}.ts` (including the per-job application lifecycle of ensureResource / destroyResource).
4. **API**: `app/api/engines/[engine]/**`.
5. **Parameter advisor emr channel**: the four param-advisor files + the agent.js CATALOG_TEXT sync.
6. **Front-end merge**: engine routing in `etl-jobs/page.tsx` + the EMR form (embedding the network / parameter advisors) + the merged list.
7. **Deploy** (foreground inline-parameter method): deploy `BgpEmrStack` (`-c enable-emr=1`) → roll `BgpPlatformStack`; judge completion only by CloudFormation `*_COMPLETE` + ECS `rolloutState=COMPLETED`.
8. **Headless acceptance** (section 11) → local commit (message reviewed, no push) + write back the roadmap row for this module and the engineering notes.

## 11. Acceptance criteria (red line: real verification with a headless browser)
- On the **ETL jobs page**, choose engine = EMR Serverless and create a job → fill in the connection information up front (network advisor validation passes) → write PySpark → submit a run → **AWS `GetJobRun`=SUCCESS** + platform list / detail = succeeded + `bgp-task-runs` holds a terminal record with taskType=emr-serverless (all three agree).
- **Per-job application**: create a job → `GetApplication` on the AWS side exists (tag `bgp:jobId`); **delete the job → the application is removed by DeleteApplication (no orphaned leftovers)**.
- **Connection information up front**: given a private source that cannot be reached → the network advisor judges it unreachable at creation time and prompts, **without producing a junk task that can run but is bound to fail**.
- **stop**: a long run → click Stop → `GetJobRun`=CANCELLED + platform = stopped.
- **Reconcile on read**: kill the process to simulate lost polling → the list still backfills the real terminal state.
- The spec takes effect: `sparkSubmitParameters` in `GetJobRun` contains the driver / executor spec entered in the form (hard evidence).
- Regression of existing features: Glue / Redshift ETL jobs, sync and the flink page behave unchanged; EMR and Glue / Redshift jobs in the list do not get mixed up.

## 12. All decision points settled (2026-07-03)
① new table ② merged into the ETL page as one engine ③ all parameters exposed + connection information up front + both advisors ④ no sharing ⑤ per-job isolation — see the table in section 0. **Coding has not yet started; awaiting the "go" signal.**

> Key technical note on ⑤: the platform is a logical multi-tenant system; the physical partition key `userId` of every resource is always `"default-user"` (confirmed by `version-service.ts:14`), and real users are distinguished by the Cognito `createdBySub`. Building the application per `userId`, as a literal "per user" would, degrades into "one globally shared application" (= exactly the contention / tail-latency lock-up that was rejected in the decisions). Hence **per job**: each job has its own `bgp-emr-<jobId>` application, with no contention at all, and deleting the job issues `DeleteApplication`.

## 13. Phase B outlook (scheduled for later)
Rich node types (branch / loop / assignment / merge / virtual / iteration / HTTP trigger / cross-cycle) **require a refactor of `lib/workflow/dag-generator.ts`** (not a pure increment); it is a separate project and is not touched in this phase.
