# Realtime Compute — Flink (Flink SQL Streaming Jobs + Unified Stream and Batch): Detailed Design

> 📌 **Scope (reconciled on 2026-10-13)**: this document was written in the single-region stage and records the design of that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the behavior of places / execution scope / per-region scheduling under multi-region operation, see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of the module is recorded in the design index. A path mentioned in the text that no longer exists means that the idea was not implemented in that form or has been superseded.

> - Revision: 1.0 (design draft) | Date: 2026-06-27 | Status: in implementation
> - Benchmark: the realtime compute feature (Flink SQL / stream processing) of a leading cloud data-development suite. Capability groups **realtime compute with Flink / unified stream and batch** (the second batch of the differentiating-capabilities phase, the second step of the real-time mainline).
> - Master plan: the platform roadmap of 2026-08 (historical, single-region stage); upstream: realtime CDC data integration ([`realtime-cdc.md`](./realtime-cdc.md)).
>
> - 🔴 Red lines: use only `--profile temp-account` (the account is always verified live), no hard-coded secrets / account ids / ARNs (everything derived at runtime +
>   Secrets Manager), every new feature verified for real in a headless browser, no pushing without permission.
> - 💰 **Cost red line: MSAF bills by KPU running time, Kinesis bills by shard. After verification you must follow the checklist in section 10:
>   StopApplication + DeleteApplication + `cdk destroy BgpFlinkStack`, otherwise money keeps burning.**
>
> 📎 **Companion details**: JAR assembly (the single runner has evolved into several "connector bundles" base / s3t / s3t-kafka plus modular on-demand assembly) is described in
> [`realtime-compute-connector-runtime-modular.md`](./realtime-compute-connector-runtime-modular.md); the snapshot and state-recovery semantics of start / stop are described in [`realtime-compute-flink-s3tables-412-root-fix.md`](./realtime-compute-flink-s3tables-412-root-fix.md).
> Where this document conflicts with either of them, they take precedence.

---

## 1. Goals and Scope

Upgrade the platform from "batch computing only (Glue PySpark / Redshift SQL / Athena)" to **genuine real-time stream computing**:
users define streaming jobs on the platform in **Flink SQL** → consume a **Kinesis stream** (the landing stream of realtime CDC integration / the data-generator stream) →
**event-time tumbling-window aggregation (TUMBLE)** → land in real time into **S3 (Iceberg / JSON)** for verification by Athena / the platform.

**Delivered by this module**:
- A generic **Flink SQL Runner** (fat JAR): reads multi-statement Flink SQL from the MSAF runtime properties and executes it (DDL immediately,
  INSERTs into a long-running StatementSet). **No stream name / bucket name / account is hard-coded** — everything comes from the SQL text (derived per account by the platform).
- Engine: **Amazon Managed Service for Apache Flink (MSAF)**, Flink 1.19 runtime, running from a JAR in S3.
  <br>⚠️ (audit calibration, 2026-08-26) the runtime is actually **Flink 1.20** (single source of truth flink-config.ts:16 `FLINK-1_20`;
  platform-stack.ts injects `FLINK_RUNTIME_ENVIRONMENT` with default FLINK-1_20; flink-sql-runner/pom.xml `flink.version=1.20.0`; the currently supported versions are listed in [`supported-versions.md`](../supported-versions.md)),
  and every later "1.19" in this document is calibrated the same way.
- Gated infrastructure `BgpFlinkStack` (`-c enable-flink=1`): the source Kinesis stream + the MSAF service role + reuse of the existing S3 buckets.
- Backend orchestration `lib/realtime/flink-service`: each streaming job = one MSAF application (idempotent ensure → start → status →
  stop + delete as cost stop-loss).
- UI: the Data Development > Stream Compute page (create / manage Flink SQL streaming jobs, view status, view aggregation results).

**Not in this module**: self-managed Flink clusters (EMR on EKS), Flink CEP, state-backend tuning, exactly-once end-to-end transactional sinks.

---

## 2. Feasibility Probe Conclusions (2026-06-27, measured live with the temp-account profile)

| Item | Conclusion |
|---|---|
| Build toolchain | ✅ JDK 17 (Corretto) + Maven 3.8.4 available; Maven Central reachable |
| Flink SQL Runner fat JAR | ✅ Flink **1.19.1** + `flink-sql-connector-aws-kinesis-streams:5.0.0-1.19` (`KinesisDynamicTableFactory` = source + sink) + `flink-connector-files` (S3 sink) + `flink-json` / debezium-json + `aws-kinesisanalytics-runtime:1.2.0`, shade output 12.5 MB<br>⚠️ (audit calibration, 2026-08-26) current version: Flink **1.20.0** + Kinesis connector **`5.0.0-1.20`** (flink-sql-runner/pom.xml:13-14) |
| MSAF (`kinesisanalyticsv2`) | ✅ API reachable (already recorded by the realtime CDC probe; this module's list-applications passed) |
| Kinesis | ✅ creating / deleting streams was already measured live in the realtime CDC module |

**Key finding**: connector `4.3.0-1.19` registers only the **Sink** SQL factory; only from **`5.0.0-1.19`** upward is there a
`KinesisDynamicTableFactory` (source + sink in one, `connector='kinesis'`). Flink core / table are marked `provided`
(supplied by the MSAF runtime); the connectors are `compile` (bundled).

---

## 3. Architecture

```
Data generator / CDC ──► Kinesis Data Streams (bgp-flink-source, 1 shard, KMS)
                     │  format=json
                     ▼
   Amazon Managed Service for Apache Flink (MSAF, Flink 1.20 ← the original diagram said 1.19, audit calibration)
     · application code = flink-sql-runner.jar on S3 (generic SQL runner)
     · runtime property bgp.sql = multi-statement Flink SQL generated by the platform / edited by the user
     · DDL: CREATE TABLE src(connector=kinesis) / sink(connector=filesystem)
     · compute: INSERT INTO sink SELECT ... FROM TABLE(TUMBLE(src, event time, window))
                     │
                     ▼
            S3 (bgp-datalake-<ACCOUNT>/flink-out/<job>/, JSON)
                     │
                     ▼
        Athena / the platform's Athena Query page (headless verification of the aggregation results)
```

### 3.1 Engine Selection (MSAF vs EMR Serverless vs EMR on EKS)
- **MSAF (selected)**: fully managed Flink, billed by KPU, `CreateApplication/Start/Stop/Delete` exposed as APIs, start / stop within seconds,
  friendly to temporary accounts, consistent with the "control plane orchestrates + data plane executes" decoupling principle.
- EMR Serverless (Flink): also possible, but submitting SQL to Flink on EMR Serverless requires a self-managed SQL Gateway — heavier.
- EMR on EKS: heavy cluster operations; rejected.

### 3.2 Why "One MSAF Application per Job"
One MSAF application = one Flink job. Because the platform must "manage several streaming jobs", each job maps to one MSAF application (physical name
`bgp-flink-<jobId suffix>`), created on demand by the backend with `CreateApplication` (idempotent) and `Delete`d at cost stop-loss. The durable infrastructure (source stream,
role, JAR) lives in the gated stack, **consistent with the "infrastructure in the stack, tasks in the service layer" pattern used for DMS replication tasks / endpoints**.

---

## 4. Data Model (new DynamoDB table `bgp-flink-jobs`)

| Field | Description |
|---|---|
| userId (PK) | reuses `default-user` (consistent with sync) |
| jobId (SK) | ULID |
| name | job name |
| sql | the Flink SQL edited by the user (multi-statement) |
| sourceStream | source Kinesis stream name (default bgp-flink-source) |
| outputPath | S3 output prefix (derived: `s3://bgp-datalake-<ACCOUNT>/flink-out/<jobId>/`) |
| status | draft / starting / running / stopping / stopped / error |
| appName | physical name of the MSAF application |
| createdAt / updatedAt | |

> The account id is never stored: `outputPath` / `appName` are derived at runtime from `AWS_ACCOUNT_ID`, which has the same source as `cdk.Stack.of`.

---

## 5. Orchestration Flow (`lib/realtime/flink-service.ts`, fully idempotent)

1. **createJob**: validates that the SQL contains an INSERT; stores the job in `bgp-flink-jobs` (status=draft).
2. **startJob**:
   - Gate check: `process.env.FLINK_RUNTIME_ROLE_ARN` and the source stream must exist (otherwise 503 "deploy BgpFlinkStack first").
   - `ensureApplication`: if `DescribeApplication` reports that the application does not exist, `CreateApplication` (Runtime=FLINK-1_19,
     CodeContent=S3 JAR, ServiceExecutionRole=bgp-flink-role, PropertyGroups=[{bgp:{sql}}],
     SnapshotsEnabled=false, Parallelism=1). If it exists, `UpdateApplication` refreshes the sql property.
     <br>⚠️ (audit calibration, 2026-08-26) the Runtime is actually **FLINK-1_20** (configuration-driven, flink-config.ts:16);
     and **CodeContent (the code JAR) is chosen by sinkType**: the base runner / s3t (Iceberg) / s3t-kafka
     three "connector bundles" (flink-config.ts:20,27-31 `runnerFor`), not a single flink-sql-runner.jar.
   - `StartApplication` (without snapshot). Status set to starting.
3. **statusJob**: `DescribeApplication` → ApplicationStatus mapping (STARTING/RUNNING/STOPPING/...).
4. **stopJob** (cost stop-loss): `StopApplication(Force=true)` → `DeleteApplication`. Status set to stopped.
   <br>⚠️ (audit calibration, 2026-08-26) in practice this is split into two independent actions (as decided): **"Stop" = `pauseFlinkJob`** —
   only `StopApplication` (for jobs with snapshots enabled, `Force=false`: graceful stop + automatic snapshot, so the job can be started again and recover its state),
   **keeping the MSAF application and the log group** (flink-service.ts:1138-1162); **"Delete" = `deleteFlinkApp`** is what
   really calls `DeleteApplication` + deletes the log group (flink-service.ts:1165-1185). Stop no longer equals delete.
5. Result verification: read the JSON under `outputPath` (create an external table on the platform's Athena page and query it, or browse S3).

---

## 6. Flink SQL Template (platform default, editable by the user)

```sql
CREATE TABLE orders_src (
  region STRING, amount DOUBLE, ts TIMESTAMP(3),
  WATERMARK FOR ts AS ts - INTERVAL '5' SECOND
) WITH (
  'connector'='kinesis',
  'stream'='bgp-flink-source',
  'aws.region'='us-east-1',
  'source.init.position'='TRIM_HORIZON',
  'format'='json'
);

CREATE TABLE region_agg_sink (
  window_start TIMESTAMP(3), region STRING, total_amount DOUBLE, order_cnt BIGINT
) WITH (
  'connector'='filesystem',
  'path'='s3://bgp-datalake-<ACCOUNT>/flink-out/<jobId>/',
  'format'='json',
  'sink.rolling-policy.rollover-interval'='30 s',
  'sink.rolling-policy.check-interval'='10 s'
);

INSERT INTO region_agg_sink
SELECT window_start, region, SUM(amount) AS total_amount, COUNT(*) AS order_cnt
FROM TABLE(TUMBLE(TABLE orders_src, DESCRIPTOR(ts), INTERVAL '1' MINUTE))
GROUP BY window_start, region;
```

> At injection time the platform replaces `<ACCOUNT>` / `<jobId>` / `aws.region` / `stream` with runtime values (no hard-coding).
> The rolling policy is set short (30 s) so that the headless verification sees output files as early as possible.

---

## 7. Gated CDK Stack `BgpFlinkStack` (`-c enable-flink=1`)

> ⚠️ (audit calibration, 2026-08-26) this stack now **does not create the fixed source stream** `bgp-flink-source` (the cost rework of 2026-07-07 removed the stream;
> option B, decided on 2026-07-26, restored multiple sources): the stack only creates the near-zero-cost MSAF service role and **grants it read permission to "consume any platform stream"**
> (resources restricted to `stream/*` in this account and region, flink-stack.ts:35-44); streams are created on demand by data-source provisioning. Hence even though this stack is enabled by default
> (deploy-all `DEPLOY_FLINK=1`) it incurs almost no standing charges. The "source Kinesis stream" item below is the original design and is no longer created.

- **Source Kinesis stream** `bgp-flink-source` (1 shard, KMS=dataKey, RemovalPolicy.DESTROY).
- **MSAF service role** `bgp-flink-role` (trusts `kinesisanalytics.amazonaws.com`):
  - read the source stream (kinesis:Get*/Describe*/List*/SubscribeToShard);
  - read the JAR (s3 get `bgp-glue-scripts-<ACCOUNT>/flink/*`);
  - write the output (s3 rw `bgp-datalake-<ACCOUNT>/flink-out/*`);
  - CloudWatch Logs (create / write log groups and log streams); KMS (decrypt the source stream + the output bucket).
- **JAR upload**: `flink-sql-runner.jar` is uploaded to `s3://bgp-glue-scripts-<ACCOUNT>/flink/` (a deployment step,
  same bucket as the Glue scripts; not a CDK asset, to keep the 12 MB out of the stack).
- Platform env (derived deterministically in platform-stack, avoiding cross-stack dependencies): `FLINK_RUNTIME_ROLE_ARN`=
  `arn:aws:iam::<ACCOUNT>:role/bgp-flink-role`, `FLINK_SOURCE_STREAM`=bgp-flink-source,
  `FLINK_CODE_BUCKET`=bgp-glue-scripts-<ACCOUNT>, `FLINK_CODE_KEY`=flink/flink-sql-runner.jar.
- Incremental grants on the platform TaskRole: `kinesisanalytics:*` (applications in this account), `iam:PassRole` (bgp-flink-role),
  `kinesis:PutRecord*` (data-generation demo, optional), with the corresponding resources narrowed.

---

## 8. UI (Data Development > Stream Compute)

- List: job name / status (Badge) / source stream / actions (Start · Stop · Delete · Details).
- New: task name + Flink SQL editor (pre-filled with the template of section 6) + source-stream selection.
- Details: status card (MSAF ApplicationStatus + a running hint), SQL preview, output location, result-verification guidance
  (jump to the Athena Query page to query `flink-out/<jobId>`).

---

## 9. Acceptance (headless browser, end to end, really running)

1. Deploy `BgpFlinkStack` (-c enable-flink=1) + upload the JAR.
2. Create a Flink SQL streaming job on the platform (default window-aggregation template) → start → MSAF application RUNNING.
3. **Generate data**: keep putting order JSON (region/amount/ts) into `bgp-flink-source` for several minutes (a data-generation script, not part of the verification).
4. Flink tumbling-window aggregation → lands in `s3://bgp-datalake-<ACCOUNT>/flink-out/<jobId>/`.
5. **Verification (headless)**: on the platform's Athena Query page, create a table over the output and query it; seeing "total_amount / order_cnt per region per minute"
   consistent with the generated data → hard evidence.
6. Cost stop-loss (section 10).

---

## 10. Cost Stop-Loss Checklist (mandatory after verification)

1. "Stop" the job on the platform → backend `StopApplication(Force)` + `DeleteApplication` (stops KPU billing).
2. `cdk destroy BgpFlinkStack` (with `-c enable-flink=1`, otherwise the gated stack is not in the synth → no-op) → deletes the source stream (stops shard billing) + the role.
3. Verify: `aws kinesisanalyticsv2 list-applications` is empty and `aws kinesis list-streams` has no bgp-flink-source.
4. Clean up S3 `flink-out/<jobId>` (optional, not billed) and data-generation leftovers.

---

## 11. Red Lines in Brief
- Only `--profile temp-account`; JAR / SQL / role / bucket names are all derived at runtime, **no account id / ARN hard-coded into tracked files** (documents use the `<ACCOUNT>` placeholder).
- The whole verification runs in a headless browser (except data generation); MSAF / Kinesis bill continuously, so stop-loss immediately after verification; commits exclude binaries / `*.local.md`, pushing requires permission.
