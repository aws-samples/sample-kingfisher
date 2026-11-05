# Real-time data integration CDC (whole-database real-time ingestion into the warehouse and the lake) — detailed design

> 📌 **Scope note (reconciled on 2026-10-13)**: this document was written during the single-region stage and records the design as it stood then (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is tracked in the module index of the engineering documentation; a path mentioned below that no longer exists means that the idea was not implemented as written here or has since been superseded.

> Version: revision 1.0 (design draft) | Date: 2026-06-24 | Status: pending review
> Benchmark: the real-time sync / data integration (whole-database real-time CDC) capability of a leading cloud data-development suite. Capability group: real-time integration — the first step of the real-time mainline.
> Overall roadmap: the platform roadmap of 2026-08 (historical, single-region stage; archived and not part of this repository).
>
> 🔴 Red lines: use only `--profile temp-account` (the account facts are what the account actually reports), no hard-coded secrets (everything in Secrets Manager),
> new features verified headless / for real, no push without approval.
> 💰 **Cost red line: real-time components (Kinesis shards / DMS instances / Flink KPUs) are billed continuously for as long as they run;
> after verification they must be destroyed according to the checklist in section 9, otherwise they keep burning money.**

---

## 1. Goal and scope

Deliver "source-database changes" to the lakehouse within **seconds**: `MySQL binlog → CDC → real-time ingestion into Redshift (+ probe-style ingestion into S3 Tables)`.
Upgrade the platform from "offline batch sync only (Glue full / incremental)" to "capable of real-time data integration".

**Deliverables of this module**:
- Real-time sync task model (reuse the existing `bgp-sync-tasks`, adding `syncMode: "realtime"` + `channel: "dms"`).
- DMS orchestration: replication instance + source / target endpoints + CDC replication task (`full-load-and-cdc`).
- Warehouse main path: MySQL → DMS → **Redshift Serverless** (stable, no LF restrictions).
- Lake probe sub-goal: → **S3 Tables (Iceberg)**; verify the LF write permission first — adopt it if it works, detour if it does not (see section 5).
- UI: a new "Real-time (CDC)" mode for sync tasks + real-time task monitoring (latency / status / replicated rows).

**Not in this module** (left to [real-time compute](./realtime-compute.md)): Flink real-time computation / aggregation / unified stream-batch processing. This module only does "real-time transport".

---

## 2. Feasibility probe conclusions (2026-06-24, measured in the test account `<account-id>`)

| Service | Conclusion |
|---|---|
| Kinesis | ✅ Measured: create a stream with 1 shard → ACTIVE → delete the stream, all passed |
| DMS | ✅ Replication instance quota 0/60, API available |
| Managed Flink | ✅ API reachable (used by [real-time compute](./realtime-compute.md)) |
| S3 Tables | ✅ `bgp-table-bucket` exists |
| **Lake Formation administrators** | ⚠️ **Empty** — writing to S3 Tables carries an LF permission risk (a historical pitfall), so lake ingestion is listed as a probe sub-goal |

**Key architecture decision (based on the probe)**: **warehouse ingestion into Redshift is the stable main path, lake ingestion into S3 Tables is a probe sub-goal** —
this guarantees that the real-time mainline can definitely be opened while being honest about the LF risk.

---

## 3. Architecture

### 3.1 Technology choice (fully managed / pay-as-you-go / fast start and stop — fits a temporary account + an internal platform)

```
MySQL (RDS bgp-source-mysql; binlog enabled? see section 6)
   │  binlog CDC
   ▼
AWS DMS (replication instance + source endpoint + target endpoint + replication task full-load-and-cdc)
   ├──► Target A: Redshift Serverless (main path, stable)                      ← must be reached by this module
   └──► Target B: Kinesis Data Streams ──► (real-time compute Flink / lake ingestion)  ← probe / extension
```

> ⚠️ (2026-08-26 audit calibration) The "Target B: Kinesis" path of the original draft **was not implemented**: the cost rework (decided on 2026-07-07)
> deleted the Kinesis stream (`realtime-stack.ts:14`, comment "delete the Kinesis stream"), and the
> `realtimeConfig.target` written back by `start-realtime` is **always "redshift"** (`start-realtime/route.ts:111`); no Kinesis target branch exists.
> If real-time lake ingestion is needed, it goes through [real-time compute](./realtime-compute.md) (Flink CDC direct connection) or a Glue detour, not through DMS → Kinesis.

> DMS was chosen over self-hosted Debezium: managed CDC, no cluster operations, the SDK is already a dependency (`@aws-sdk/client-database-migration-service`).
> Kinesis was chosen over MSK: fully managed and pay-as-you-go, start / stop within seconds, friendly to a temporary account. The SPI abstraction guarantees that a future switch to MSK + EMR is not locked out.

### 3.2 Two landing paths

- **Path 1, warehouse ingestion (main, must be reached)**: the DMS target endpoint connects directly to Redshift Serverless. DMS natively supports
  a Redshift target; full load + CDC are applied continuously. No LF restrictions, mature and stable.
- **Path 2, lake ingestion (probe sub-goal)**: DMS target = Kinesis (or S3), and the consumer side writes to S3 Tables (Iceberg).
  Verify the LF write permission with a minimal test first; **if it does not work, detour**: `Kinesis/S3(Parquet) → a Glue job MERGEs in batches into Iceberg`
  (reusing the Iceberg write mode of the existing glue-script-generator), recorded as "near-real-time lake ingestion".

### 3.3 Reuse of the existing system (no reinventing)

| Reused | Source |
|---|---|
| Sync task model / channel recommendation (the dms channel + isCDC are already modeled) | `lib/sync/sync-service.ts` (recommendChannel) |
| Sync task table `bgp-sync-tasks` (add realtime attributes, no new table) | database-stack |
| Source database credentials (Secrets Manager) | the data source system |
| Iceberg write mode (detour path) | `lib/sync/glue-script-generator.ts` |
| Workspace RBAC / audit / structured logging | guard / audit / logger (the platform foundation layer) |
| The control plane only emits intent events; the data plane executes | the engine-SPI philosophy (this module can serve as the first real-time plugin of the engine SPI) |

---

## 4. Data model (reuse `bgp-sync-tasks`, new attributes)

```
bgp-sync-tasks (existing table), new / enabled attributes:
  syncMode: "full" | "incremental" | "realtime"   ← realtime added
  channel:  "glue" | "zero-etl" | "dms"            ← dms enabled
  realtimeConfig:
    replicationInstanceArn   DMS replication instance (reused / created by name)
    sourceEndpointArn, targetEndpointArn
    replicationTaskArn
    target: "redshift" | "kinesis" | "s3tables"
    status: provisioning | running | stopped | error
    cdcLatencySec (backfilled), fullLoadRows (backfilled), cdcChanges (backfilled)
```
> No new table. The real-time run state (latency / rows) is backfilled by the monitoring API from DMS `describe-replication-tasks`,
> consistent with the existing run-status backfill pattern of workflow runs.

---

## 5. CDK infrastructure (new realtime-stack, gated creation)

```
infra/lib/realtime-stack.ts (conditionally instantiated; not created by default, only with -c enable-realtime=1, to control cost):
  - DMS replication instance (dms.t3.micro, the smallest class) + replication subnet group (private subnets)
  - DMS VPC role (dms-vpc-role, account level, idempotent)
  - Target Kinesis Data Stream (on-demand or 1 shard)
  - Least-privilege role for DMS to access Kinesis / Redshift / Secrets
  - Security groups: DMS → RDS 3306, DMS → Redshift 5439 (inside the VPC)
Reason for gating: real-time components are billed continuously; zero cost when not deployed, one command brings them up when needed, destroy after verification.
```

> ⚠️ (2026-08-26 audit calibration) This box has been superseded by the cost rework (decided on 2026-07-07); in reality:
> ① the replication instance class is **dms.t3.small** (dms.t3.micro cannot be ordered in this region), and it is now **lazily created** —
>    the stack no longer carries an always-on instance; when a sync task is created, the service layer calls `CreateReplicationInstance` only if `bgp-dms` does not exist
>    (`dms-service.ts:43-44` "dms.t3.small"; `dms-service.ts:90-117` `getReplicationInstanceArn` lazy creation).
> ② **The Kinesis stream has been deleted** (`realtime-stack.ts:14`); the stack keeps only the ≈ zero-cost durable infrastructure (subnet group / SG / roles).
> ③ The gated stack is **enabled by default** (deploy-all.sh deploys with `DEPLOY_REALTIME=1` by default, `-c enable-realtime=1 -c skip-dms-roles=1`),
>    not "not created by default"; since only near-zero-cost infrastructure is created, enabling it by default costs almost nothing in always-on billing.

> IAM follows the platform's least-privilege style: the DMS role is restricted to the platform's own resource ARNs. Encryption at rest for Kinesis / DMS uses the platform
> data CMK (where DMS supports KMS target encryption).

---

## 6. Prerequisites and known risks

| Item | Description | Handling |
|---|---|---|
| **RDS binlog** | DMS CDC requires `binlog_format=ROW` + a retention period on the source database. The current RDS parameter group may not have it enabled | Check / modify the RDS parameter group and reboot before deployment (or use a new parameter group); record it in the runbook |
| **LF write to S3 Tables** | The LF administrators are empty; writing Iceberg may return AccessDenied | Lake ingestion is a probe sub-goal; on failure take the Glue detour (section 3.2) |
| **DMS target Redshift** | DMS → Redshift Serverless needs endpoint configuration + credentials | Use Secrets Manager credentials, reusing the managed-secret identity concept of Redshift |
| **Cost** | Real-time components are billed continuously | Gated deployment + destroy checklist after verification (section 9) |

---

## 7. Implementation steps (each step: local verification + deployment + real verification + local commit without push)

```
Step 1  RDS binlog prerequisite: check / enable binlog_format=ROW + the retention period; confirm that DMS can read the binlog.
Step 2  realtime-stack (gated): DMS replication instance + Kinesis + roles / SG. Verify with cdk synth; deploy with -c enable-realtime=1.
Step 3  Service layer lib/realtime/: dms-service (create / start / stop / query replication tasks, reuse the instance by name) + task model extension.
Step 4  Warehouse main path: DMS task MySQL → Redshift (full-load-and-cdc), end-to-end verification (change one row in the source database → reaches Redshift within seconds).
Step 5  Lake probe: DMS → Kinesis → S3 Tables write-permission verification; adopt if it works, otherwise Glue detour + record the limitation.
Step 6  Management-plane API + UI: "Real-time (CDC)" mode for sync tasks + real-time monitoring (latency / rows / status); RBAC + audit.
Step 7  Release documentation + local commit.
```

---

## 8. Acceptance criteria (red line: real real-time verification)

- **Warehouse main path (must be reached)**: the DMS task is running; `INSERT/UPDATE/DELETE` one row in the source MySQL →
  the change is visible in Redshift **within seconds** (true real-time, not a polling simulation). The CDC latency is visible.
- **Lake probe**: either S3 Tables is written successfully (adopted), or the LF limitation is clearly recorded + the Glue detour is usable.
- Management plane: creating / starting / stopping real-time tasks is RBAC-controlled (editor and above); monitoring shows the latency / replicated rows; visible in the audit log.
- Site-wide headless regression: 0 console errors / 0 5xx; real-time does not affect the existing offline sync.
- **Cost**: run the section 9 destroy after verification and confirm that the DMS / Kinesis / Flink billed resources are down to zero.

---

## 9. Cost and destroy checklist (mandatory after verification)

```bash
# 验证完毕销毁实时计费资源(只销毁 realtime-stack,不动核心栈):
cd infra && npx cdk destroy BgpRealtimeStack --profile temp-account
# 确认无残留:
aws dms describe-replication-instances --profile temp-account --region us-east-1 --query 'ReplicationInstances[].ReplicationInstanceIdentifier'
aws kinesis list-streams --profile temp-account --region us-east-1 --query 'StreamNames'
# (复制实例、Kinesis 流、Flink 应用均应为空或不含 bgp-*)
```

---

## 9b. Measured results of steps 3 and 4 (2026-06-24, true real-time achieved)

**The warehouse main path passed end-to-end verification**: source MySQL `ecommerce.realtime_demo` → DMS (full-load-and-cdc)
→ Redshift `ecommerce.realtime_demo`. Full load of 3 rows + **real-time CDC**: one row INSERTed in the source database appeared in Redshift **within about 10 s**
(3 → 4 rows; the 4th row carries the values "CDC real-time order" / "Southwest" / 999.99). This indirectly and authoritatively verifies that the binlog=ROW of step 1 is in effect.

**DMS pitfall list (measured; all are real constraints, recorded for reproduction / as a coding reference for the service layer in step 5)**:
1. **The DMS account-level roles must be pre-created and propagated**: `dms-vpc-role` / `dms-cloudwatch-logs-role` (already in 00-prereqs.sh).
2. **The access role an endpoint uses for Secrets must trust the regionalized service principal** `dms.us-east-1.amazonaws.com` (not only `dms.amazonaws.com`).
3. **IAM policies / roles have propagation delay**: creating an endpoint right after adding permissions may return a transient AccessDenied; wait ~25 s and retry.
4. **The Redshift managed admin secret cannot be fed to DMS directly**: ① it lacks the host / port / database fields; ② the password contains characters that DMS forbids `{},;`.
   → Solution: create a **dedicated Redshift user `dms_ingest`** (password under our own control, no forbidden characters, created through the Redshift Data API `CREATE USER`),
   stored in a dedicated secret `bgp/dms/redshift-target` with the full set of fields (the password never touches disk).
5. **The target schema must be pre-created**: DMS uses the source schema name (ecommerce) as the target schema by default but does not create it automatically →
   run `CREATE SCHEMA ecommerce AUTHORIZATION dms_ingest` first.
6. **★ The IAM role for the DMS → Redshift COPY must be associated with the namespace**: Redshift COPY reports
   `role ... is not associated to cluster` → `redshift-serverless update-namespace --iam-roles <role>`,
   and that role's trust policy must include `redshift.amazonaws.com`. This is the step most easily missed and with the most obscure error message.
7. **The SG of the Glue data-generation job must have a self-referencing all-ports inbound rule** (a Glue NETWORK connection constraint).
8. **★ The DMS instance ARN drifts whenever the stack is destroyed / recreated**: the replication instance ARN cannot be injected through a static env (it expires on every rebuild).
   Solution: the service layer discovers the ARN at run time with `DescribeReplicationInstances` by the stable id `bgp-dms` (see `dms-service.ts`
   `getReplicationInstanceArn`). Likewise the DMS role ARN / Redshift host are derived from account / region rather than passed as deployment context.
9. **★ Connectivity tests must not blindly retest both ends every round**: calling `TestConnection` again on an endpoint that is already successful knocks it back to
   `testing`, so the two ends never both reach successful at the same time → the task stays in ready. Solution: read the snapshot first each round and trigger a test only for endpoints that are neither successful nor
   testing, so the state converges monotonically (see `testEndpoints`). Give the window enough time (the Redshift cold start is slow, ≥ 5 min).
10. **★ A newly created replication task is still in creating when the call returns; starting it immediately reports "invalid state"**: first poll with `waitTaskStartable`
    until the task reaches ready / stopped, then `StartReplicationTask`; if it is already running / starting, skip idempotently (see `dms-service.ts`).
11. **★ The source endpoint cannot be fed the data-source secret directly**: a platform data-source secret usually contains only `{username,password}` and lacks
    host / port → DMS Secrets mode reports "The 'port' parameter in the secret string is missing". Solution: the source endpoint
    uses explicit connection parameters instead (ServerName / Port / Username / Password; the credentials come from the data-source secret and host / port from the data-source record).
12. **★ Starting a real-time task must resolve the source-database information from the datasourceId as a fallback**: the creation flow (SyncTaskModal) stores only the datasourceId
    and does not redundantly store secret / database / host; start-realtime must resolve from the linked data-source record when the task fields are missing, otherwise every real-time task created normally
    through the UI fails to start.
13. **Do not add a `PassedToService` condition to the TaskRole `iam:PassRole`**: there are many consuming services (dms / regionalized dms / redshift /
    redshift-serverless / glue), the condition values are hard to enumerate, and missing one means PassRole is denied at run time. Narrowing by restricting the resource to the specific roles is sufficient.
14. **The DMS account-level roles must be pre-created** (dms-vpc-role / dms-cloudwatch-logs-role, in `00-prereqs.sh`); the stack is deployed with
    `-c skip-dms-roles=1` to skip them (IAM eventual consistency: creating and using them in the same stack fails).
15. **★ The channel recommendation recommendChannel must recognize realtime**: the original logic `isCDC = syncMode==="incremental"` missed
    "realtime", so real-time tasks were wrongly recommended to the glue channel (the UI showed "Glue ETL" and the data was distorted). Fix: realtime mode directly locks
    DMS as the only recommended + supported channel, and the backend of `/api/sync` POST / PUT enforces it as a safety net (syncMode===realtime → channel="dms")
    to prevent any frontend path from storing it wrongly. The channel of realtime is always dms.

**Cost red line**: real-time components (DMS instance dms.t3.small + Kinesis) are billed continuously. **By the latest agreement: reusable resources that have been made to work
are kept by default** (reused in the next verification, avoiding delete-and-recreate); `cdk destroy BgpRealtimeStack` only when explicitly stopping cost or wrapping up. The gating design
(`-c enable-realtime=1 -c skip-dms-roles=1`) is verified effective: bring it up when needed.

**Remaining work for steps 5 and 6 (to be done the next time real-time is brought up)**: harden the endpoint / task orchestration above into `lib/realtime/dms-service.ts`
(currently a probe opened manually through the CLI); add the "Real-time (CDC)" sync mode + real-time monitoring (latency / rows) to the UI. The S3 Tables lake-ingestion
probe sub-goal (LF risk) has not been done yet; it can go DMS → Kinesis → Flink ([real-time compute](./realtime-compute.md)) or a Glue detour.

## 10. Hand-off to what follows

- [Real-time compute](./realtime-compute.md) (Flink): consumes the DMS → Kinesis stream of this module, runs Flink SQL aggregation → writes back; unified stream-batch processing.
- Engine SPI: the DMS orchestration of this module is the first real-time instance of a "data-plane worker" and can feed back into the engine-SPI abstraction.
- Observability / alerting: CDC latency and replication-task failures are the key metrics for real-time alerting.
