# Real-time CDC extension — DMS Serverless redesign

> 📌 **Scope note (reconciled on 2026-10-13)**: this document was written during the single-region stage and records the design as it stood then (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is tracked in the module index of the engineering documentation; a path mentioned below that no longer exists means that the idea was not implemented as written here or has since been superseded.

> Status: **design pending review** (2026-06-29). Decision: the DMS channel changes from a "fixed replication instance" to **DMS Serverless (no instance, automatic scaling by DCU, pay-as-you-go)**, as a cost optimization and to get closer to real production usage. Work starts only after this document passes review.

> ⚠️ (2026-08-26 documentation audit) This proposal was not implemented; the cost problem of the always-on DMS replication instance has been solved by the lazily-created-instance approach; for the current state see [the real-time CDC design](./realtime-cdc.md) and `infra/lib/realtime-stack.ts`. The content below is kept only as a historical design record.

---

## 1. Background and motivation

### 1.1 Problems of the current state (fixed replication instance)
- The gated stack `infra/lib/realtime-stack.ts` **hard-codes everything**: the DMS replication instance class (`dms.t3.small` / 20 GB / single AZ / engine 3.5.4), the subnet group and the SG. When creating a sync task the user has **no configuration entry at all**, which does not match how DMS is really used (pointed out in person).
- The replication instance is an **always-on billed** resource (billed by the hour whether or not it is syncing), ~10 min to create. In a temporary-account / internal-platform scenario an idle instance keeps burning money.

### 1.2 Why DMS Serverless (rather than a "configurable instance")
- **Clarified fact**: real DMS = one long-lived replication instance running multiple replication tasks, sized by the aggregate workload. "One instance per task" is a wasteful anti-pattern.
- But a more modern option that beats "shared instance + adjustable class" is **DMS Serverless**:
  - **No provisioned instance**: no fixed always-on compute; scales automatically by **DCU (DMS Capacity Unit, 1 DCU = 2 GB RAM)**.
  - **Pay-as-you-go**: pay only for the DCUs actually used; idle capacity is deprovisioned automatically (resources are reclaimed after 48 h without a start).
  - **Operations-free**: no engine version to choose or manage; AWS manages it.
  - The user-configurable items change from "instance class" to **MinCapacityUnits / MaxCapacityUnits + MultiAZ**, which fit the pay-as-you-go model better.

### 1.3 Feasibility (confirmed)
- **Source / target support** (verified against the official AWS documentation): Serverless supports **MySQL-compatible** sources ✅, and **Amazon Redshift** ✅ and **S3** ✅ targets. Both MySQL → Redshift and MySQL → S3 of this project are covered.
- **SDK support** (measured locally with `@aws-sdk/client-database-migration-service@3.1019.0`): `CreateReplicationConfigCommand` / `StartReplicationCommand` / `DescribeReplicationsCommand` / `Modify/DeleteReplicationConfigCommand` are all exported; no upgrade needed.

---

## 2. Key limitations (directly affecting the design; verified against the AWS documentation)

| Limitation | Impact | Response |
|---|---|---|
| **Dependencies must go through VPC endpoints**: S3 / Kinesis / Secrets Manager / Redshift / DynamoDB / OpenSearch | Our Redshift is in private subnets; Serverless access to Redshift + S3 + Secrets **requires the corresponding VPC endpoints** | **Add VPC endpoints in CDK** (the largest new infrastructure of this rework, see section 5) |
| Views are not supported | We sync tables; no impact | — |
| Custom CDC start points are not supported | We do not use them; no impact | — |
| Resources are deprovisioned automatically after 48 h without a start | Cost-friendly; but if it stays stopped for too long it has to be restarted | Explain it in the documentation; show a hint in monitoring |
| Modify only in the CREATED / STOPPED / FAILED state; Delete only in the STOPPED / FAILED state | Lifecycle orchestration must follow the state machine | Stop before modify / delete; add state polling |
| Redshift Serverless as a target does not get the enhanced throughput | We use Redshift Serverless; full-load throughput for large tables is ordinary | Acceptable (not an Oracle source) |
| Requires the DMS service-linked role (SLR) | Serverless requires the SLR to exist | `00-prereqs.sh` creates it idempotently (precedent: the OpenSearch SLR) |

---

## 3. Architecture design

### 3.1 Core concept mapping (instance mode → Serverless)
| Old (instance mode) | New (Serverless) |
|---|---|
| ReplicationInstance (always-on, created by CDK) | **None** (no instance) |
| ReplicationTask (attached to an instance) | **ReplicationConfig** (carries its own compute configuration) |
| `CreateReplicationTask` + `StartReplicationTask` | `CreateReplicationConfig` + `StartReplication` |
| Instance class (class / storage / AZ) | **ComputeConfig**: MinCapacityUnits / MaxCapacityUnits / MultiAZ / ReplicationSubnetGroupId / VpcSecurityGroupIds |
| `DescribeReplicationTasks` | `DescribeReplications` |
| endpoints (source / target) | **Unchanged, fully reused** `ensureSourceEndpoint` / `ensureTargetEndpoint` |
| Table mappings TableMappings | Unchanged |

### 3.2 ReplicationConfig orchestration chain (replacing instance + task)
```
Create sync task (channel=dms) → start (/start-realtime):
  1. ensureSourceEndpoint (MySQL, reused)
  2. ensureTargetEndpoint (Redshift, reused: includes ensureRedshiftDmsUser / Schema / role association)
  3. ensureReplicationConfig(taskId, src, tgt, tableMappings, computeConfig, replicationType)
     - idempotent: look up by ReplicationConfigIdentifier (bgp-rc-<short>) before creating
     - replicationType: full-load | cdc | full-load-and-cdc (derived from syncMode, as today)
     - computeConfig: { MinCapacityUnits, MaxCapacityUnits, MultiAZ,
                        ReplicationSubnetGroupId, VpcSecurityGroupIds, KmsKeyId }
  4. startReplication(configArn, type=start-replication | resume-processing)
  5. Poll DescribeReplications for the Status (initializing → ... → running)
```

### 3.3 Where the subnet group / SG of ComputeConfig come from
- **Subnet group**: Serverless still needs a ReplicationSubnetGroup (private subnets). Created by the gated stack (kept).
- **SG**: reuse the DMS SG of the gated stack (outbound reaches RDS / Redshift / endpoints).
- **Private-network red line**: the subnet group / SG are fixed to the platform's private network; the frontend **mainly displays them, and they cannot be switched to a public network**. The only user-configurable items are DCU / MultiAZ.

---

## 4. Data model (new attributes on `bgp-sync-tasks`)
```ts
// SyncTask 新增(channel=dms 时用)
dmsServerlessConfig?: {
  minCapacityUnits?: number;   // 1..(max),默认 1;DCU,1 DCU=2GB
  maxCapacityUnits?: number;   // 默认 8;autoscaling 上限,建议设大些
  multiAz?: boolean;           // CDC/持续复制建议 true;默认 false(控成本)
};
// 启动后回写(替代旧 replicationTaskArn)
realtimeConfig.replicationConfigArn?: string;
```
- DCU value normalization: min ∈ [1, maxAllowed], max ∈ [min, upper limit], max ≥ min. Common range 1..16 (2..32 GB).

---

## 5. CDK infrastructure changes (`infra/lib/realtime-stack.ts`)

### 5.1 Removed
- The DMS ReplicationInstance (`CfnReplicationInstance`) — not needed by Serverless.

### 5.2 Kept / added
- **Kept**: ReplicationSubnetGroup (private subnets), the DMS SG, `bgp-dms-kinesis-role` (Serverless still needs a SecretsManagerAccessRole / ServiceAccessRole for the Redshift target).
- **Added VPC endpoints (the key of this rework; required for Serverless to reach private dependencies)**:
  | Endpoint | Type | Purpose |
  |---|---|---|
  | `com.amazonaws.us-east-1.s3` | **Gateway** | S3 staging for the DMS → Redshift transfer / S3 target |
  | `com.amazonaws.us-east-1.secretsmanager` | Interface | Read the source / target secrets |
  | `com.amazonaws.us-east-1.redshift-data` or redshift | Interface | Target Redshift |
  | (optional) `kinesis-streams` | Interface | If an S3 / Kinesis target is built |
  - Interface endpoints go in the private subnets + the SG allows 443; the Gateway endpoint is attached to the private route tables.
  - **Reusability**: these endpoints also benefit other components (Glue COPY, Secrets reads); consider moving them to the VpcStack as always-on (not gated) so that other functions are not affected after a destroy. **Review decision point A**.
- **SLR**: `00-prereqs.sh` adds idempotent creation of the service-linked role for `dms.amazonaws.com`.

### 5.3 Gating
- Still gated by `-c enable-realtime=1`, but the stack content changes from "instance" to "subnet group + SG + endpoints + SLR confirmation". Whether the VPC endpoints are gated: see decision point A.

---

## 6. Service-layer changes (`platform/src/lib/realtime/dms-service.ts`)

New (coexisting with or replacing the existing instance-mode functions):
- `ensureReplicationConfig(input, srcArn, tgtArn, type, computeConfig)`: idempotently creates the ReplicationConfig.
- `startServerlessReplication(configArn)`: `StartReplication` (start-replication on the first run / resume-processing to continue).
- `getServerlessReplicationStatus(configArn)`: `DescribeReplications` for the Status / Stats / table statistics.
- `stopServerlessReplication(configArn)` / `deleteReplicationConfig(configArn)`: for teardown.
- `normalizeDmsServerlessConfig(cfg)`: normalizes DCU / AZ into the legal range.
- Removed / deprecated: `getReplicationInstanceArn`, `ensureReplicationTask` (instance-related); the endpoint functions are kept.

`/start-realtime/route.ts`: replace "wait for the instance to be ready + ensureReplicationTask + testEndpoints + startReplication" with the Serverless chain; no longer check that the `bgp-dms` instance is ready, check instead that the subnet group / endpoints / SLR are ready.

---

## 7. Frontend changes (`platform/src/app/sync/SyncTaskModal.tsx`)
- In step 2, target configuration, when `channel===dms` (or syncMode triggers the dms recommendation), add a "DMS Serverless compute configuration" block:
  - Minimum capacity MinCapacityUnits (InputNumber 1..16, default 1)
  - Maximum capacity MaxCapacityUnits (InputNumber min..16, default 8)
  - Multi-AZ (Switch, default off; hint "recommended on for CDC")
  - Subnet group / SG: read-only display (platform private network; hint that it cannot be switched to a public network)
  - Copy: explain billing by DCU, automatic scale-in when idle, automatic reclamation after 48 h
- Written to `task.dmsServerlessConfig`.

---

## 8. Cost and teardown
- **Advantages**: no idle always-on instance; stopping the replication stops billing; automatic deprovisioning after 48 h.
- **Teardown checklist** (after verification):
  ```
  StopReplication(configArn) → wait for stopped → DeleteReplicationConfig
  → delete-endpoint (source / target) → cdk destroy BgpRealtimeStack (-c enable-realtime=1)
  ```
- If the VPC endpoints move to the VpcStack as always-on (decision point A), they are not deleted with the realtime teardown — Interface endpoints have an hourly fee, which needs weighing (decision point A).

---

## 9. Implementation steps (after the review passes)
1. CDK: remove the instance from realtime-stack + add the endpoints + keep the subnet group / SG; add the DMS SLR to prereqs. Local `tsc` + `cdk synth`.
2. Service layer: add the Serverless orchestration functions to dms-service; switch start-realtime to the new chain. Local `tsc` + `next build`.
3. Frontend: add the DCU configuration block to SyncTaskModal.
4. commit + push (red-line scan); sync `/tmp/bgp-deploy` from GitHub and redeploy BgpRealtimeStack (new version) + BgpPlatformStack (and the VpcStack as well if the VPC endpoints go there).
5. **Headless verification**: create DMS Serverless tasks (full load products → RS, CDC orders → RS) → start → DescribeReplications reaches running → check the landed data on the query page → insert a row in the source and watch CDC sync it. Everything leaves a trace in the UI.
6. Teardown after verification (section 8).

---

## 10. Review decision points (work starts only after confirmation)
- **Decision point A**: where do the VPC endpoints go?
  - (A1) In the VpcStack, always-on — other components benefit too, and destroying realtime has no effect; cost: a continuous hourly fee for Interface endpoints (~$0.01/h per AZ per endpoint).
  - (A2) In the gated realtime-stack — starts and stops with realtime, zero idle cost; cost: every bring-up of realtime waits longer for endpoint creation.
  - Recommended: **A2** (cost first, consistent with the temporary-account + gated-teardown philosophy).
- **Decision point B**: keep or delete the old instance-mode code (`ensureReplicationTask` and so on)? Recommendation: **delete** (avoid the confusion of two coexisting sets); the DMS channel goes through Serverless uniformly.
- **Decision point C**: DCU defaults and upper limit (recommended min=1 / max=8 / upper limit 16); MultiAZ off by default.

---

> Related: [the real-time CDC design](./realtime-cdc.md) (the original instance-mode design); the sync channel / target matrix and the current test account are recorded in the internal engineering notes.
