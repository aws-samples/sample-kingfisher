# Stream Compute Patch Design — Root Fix for the HTTP 412 on the First Frame After a Flink S3 Tables Sink Starts

> 📌 **Scope note (reconciled on 2026-10-13)**: this document was written during the single-region stage and records the design as it stood then (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. Multi-region behavior — place, execution scope, per-region scheduling and the like — is described in the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is tracked in the module index; a path mentioned in this document that no longer exists means that idea was not implemented as described or has since been superseded.

> ## 🆕 Section 13 — SQL splitting robustness (2026-07-26): hardening splitStatements rather than switching to the Calcite parser
>
> **Background**: after the trailing-orphan-`)` incident, "switch the runner to the official Flink / Calcite parser for multi-statement splitting" was evaluated as a root fix.
>
> **Conclusion: not feasible; keep the hand-written splitStatements and harden it.** Basis (verified in the real environment, not by reasoning):
> - Flink 1.20's `flink-table-planner-loader` **does not expose `org.apache.calcite.*` to the user JAR** — Calcite is
>   encapsulated in the internal nested JAR `flink-table-planner.jar` plus a separate class loader (the top level only has `org/apache/flink/table`).
>   User code cannot import `SqlParser`; forcing a `calcite-core` dependency conflicts with its internal version (class-loading hell),
>   violating "no new bugs while fixing".
> - Flink's user layer exposes only `TableEnvironment.executeSql(a single String)` + `createStatementSet()`; **it provides no multi-statement splitting API**.
>   Multi-statement splitting must be done at the application layer → the hand-written `splitStatements` is an architectural decision, not laziness.
>
> - **Hardening** (both runners in step): `splitStatements` completes the SQL-standard escape lexing — `''` inside a single-quoted string and ``` `` ``` inside a backquoted identifier
>   do not terminate the literal (otherwise `'it''s; x'` would be mis-split at the semicolon inside the string). A standalone Java lexing verification in the real environment passed 7/7 (escaped quote + semicolon inside the string,
>   a comment containing a semicolon, a semicolon inside backquotes, consecutive escapes, a block comment containing a semicolon, and so on).
> - **The root cure remains on the input side**: normalizeFlinkSql + the guard dialect rules (section 12) guarantee that the SQL entering the runner is already normalized; splitStatements only needs to handle clean input correctly.
>
> **Same-source normalization on the save path**: PUT / POST run `guardCode("flink", normalizeFlinkSql(sql))` before persisting, so DynamoDB / page / MSAF are consistent in all three places,
> and the editor no longer accumulates dirty formatting.
>
> ---
>
> ## 🆕 Section 12 — Follow-up root cause (2026-07-26): SQL injection hits the MSAF PropertyValue 2048-byte limit
>
> **Background**: after the 412 root fix, it was found that **a newly created CDC job could not start at all**. Ground truth was taken layer by layer (everything was triggered through headless-browser page operations; CloudTrail / logs were used for troubleshooting only):
>
> **Symptom chain (hard evidence)**: click Start on the page → MSAF `ver` unchanged, `bgp.sql` empty → a job started with empty SQL necessarily fails and falls back to READY.
> Three-way cross-check: ① CloudTrail shows **0** `UpdateApplication` calls for that start; ② `ApplicationVersionId` is constant; ③ the platform log has only the "start-restore decision" and no trace of an Update → the code returned / was swallowed before `UpdateApplicationCommand`.
>
> **Two stacked root causes**:
> 1. **`ensureApplication` returns early**: `RUNNING_LIKE` includes `"STARTING"`; when Start is clicked and the application is briefly in STARTING, triggering again simply `return`s, and **not a single Update is sent** → the start uses the old / empty SQL. → Fix: first wait for the transitional state to settle; skip the update only when it is truly `RUNNING`.
> 2. **🔴 The real roadblock — the hard MSAF PropertyValue ≤ 2048-byte limit** (stated plainly in the AWS `PropertyGroup` API: PropertyMap value / key each ≤ 2048, ≤ 50 keys per group).
> `buildPropertyGroups` stuffs the entire SQL into a single `bgp.sql` value;
> the CDC template, bloated by Monaco's **progressive indentation** to 2007 bytes, reached ≈ 2052 > 2048 after credential injection → `UpdateApplication` threw `ValidationException` (client-side parameter validation; the request never reached the service → no CloudTrail record) → **silently swallowed by the old `catch{}`** → the start used empty / old SQL.
> **Same source as the 412: yet another catch{} disguising a failure as success.**
>    - Counter-evidence: the working sample job `bgp-flink-2eymfkk71pc81vyw` had `bgp.sql` = 1661 bytes (< 2048) and therefore passed; this job exceeded the limit and crashed.
>
> **Root fix (top-level design, generic for all Flink jobs, not CDC-specific)**:
> - **Normalization** (`normalizeFlinkSql`): before injection, strip leading / trailing whitespace, blank lines and whole-line comments line by line (never touching literals); the CDC template goes from 2007 to 1013 bytes. This blocks Monaco's progressive-indentation bloat at the source.
> - **🔴 Unlimited sharding** (`buildSqlGroups`): if the SQL is still too long, split it at **UTF-8-safe boundaries** into shards of ≤ 1800 bytes keyed `sql.N`; if the shard count exceeds the 48 keys of a single group, **roll over to the bgp1 / bgp2 / … groups** → the length ceiling moves to 50 groups × 48 shards × 1800 B ≈ 4 MB (effectively unlimited, satisfying the red line "there must be no 2048 limit"). Short SQL still uses the old single `bgp.sql` value (**backward compatible**; zero impact on old jobs).
> - **Dual read in the runner** (`assembleSql` in both JARs): collect `sql` / `sql.N` from every `bgp*` group and reassemble them losslessly in order.
> - **Eliminate the silent swallow**: a failed `UpdateApplication` is no longer `catch{}`-ed; the SQL currently stored in MSAF is read back (reassembled across shard groups) and compared with the target; on mismatch, `throw` and abort the start — never run old SQL and produce silently wrong results.
>
> - **Quality gate**: tsc 0 errors; **all 33 flink-service unit tests green** (new: normalization idempotence / literals untouched, every shard value ≤ 2048, lossless encode ↔ restore round trip, 200 KB unlimited roll-over, multi-byte UTF-8 boundaries); `javap` confirms that both runner JARs
>   contain `assembleSql`.
> - **Position-expiry hardening (section 9) done in the same pass**: the `failure-advisor` regex gains the MySQL server-side variants (`replication from ... position > file size`, `Could not find first log file name`); unit tests fully cover the original text from the real environment plus the
>   variants.
>
> **Rollback anchor**: a `git tag` on the pre-change commit. **Not committed.**
>
> ---
>
> Revision: **1.1 (implemented + verified)** | Date: 2026-07-25 | Status: **✅ the 412 is fixed at the root (measured: 30 occurrences → 0); the remaining independent problem is in section 9**
>
> ## ✅ Section 11 — Implementation and verification conclusion (2026-07-25, authoritative backfill)
>
> **The 412 is fixed at the root.** Before / after comparison in the real environment (the same job `bgp-flink-2eymfkk71pc81vyw`):
>
> | Metric | Before the fix | After the fix |
> |---|---|---|
> | Number of 412 log entries | **30** (09:00–13:00) | **0** (from 13:07 on) |
> | `ListApplicationSnapshots` | AccessDenied | SUCCESS |
> | `ApplicationRestoreType` actually sent | `SKIP_RESTORE_FROM_SNAPSHOT` | **`RESTORE_FROM_LATEST_SNAPSHOT`** |
> | Flink restore log | None | **`Restoring job from Savepoint 11`** |
>
> **Live** (task definition revision 2 → 5, **not committed**, rollback anchor = a `git tag` on the pre-change commit):
> - L1: CDK adds the 4 snapshot permissions (reusing the existing PolicyStatement to stay clear of the TaskRole 10 KB limit; the `pauseFlinkJob` graceful stop is fixed from the same source);
> - L2: `SnapshotProbe` with four states + probe failures leave a trace + `FlinkDecisionRequired`;
> - infrastructure: `seed_*.py` sets `binlog retention hours=72` (the RDS default is **None**);
> - new `failure-advisor.ts` (a failure-pattern table, data-driven); `api-response.ts` gains `DECISION_REQUIRED` + `detail`;
> - front end: 409 → a `Modal.confirm` decision dialog; the dialect library's 412 rule **now has the correct root-cause description** and is synced to the GenBI remote Runtime.
>
> - **Quality gate**: tsc 0 / **all 538 unit tests green (48 files)** / next build passes / contract-guard baseline snapshot (29 pages + 7 contracts all green).
> - **⚠️ Not finished**: contract-guard `verify` not run; the V1 / V6 headless assertions are not fully green (V1 once failed spuriously because of a script bug, since fixed; V6 could not detect anything because the section 9 pre-check never took effect).
>
> - **🔴 Section 9 — remaining independent problem (unsolved; a separate task is recommended)**: CDC binlog position expiry causes a crash loop.
> - **The "pre-check before start" route has been proven impassable by measurement** — the platform has no reliable way to tell "whether the position inside the snapshot is still readable" (all three criteria were refuted: ① snapshot age < retention window → wrong, a snapshot only 2.5 h old was
>   already unrecoverable; ② compare against the oldest binlog time on the source → wrong, `SHOW BINLOG EVENTS` **does not return a Timestamp field**; ③ parameter binding `IN ?` → wrong, MySQL accepts only literals in that position).
> - **Recommendation: switch to "recognize after the first crash"**: `failure-advisor` can already identify `CDC_BINLOG_POSITION_EXPIRED` precisely from real stack traces (7 unit tests verified against the original text from the real environment); wire the diagnosis + user confirmation into the
>   error area of the detail page, with zero guessing.
>
> **🔴 Red line (made explicit on 2026-07-25)**: **major decisions must be confirmed by the user personally; the platform may at most advise, and the action must be performed by the user.** No automatic downgrade to a cold start / automatic restart / automatic configuration change — discarding progress recomputes history and may write duplicates; that is a business decision.
>
> ---
>
> Revision: 1.0 (root-cause relocation revision) | Status: design decided and implemented
>
> - 🟢 Requirement: a Flink real-time job restarts briefly after starting; a **root fix** is required — global users must not be the ones to hit the error.
> - 🟢 Instruction (2026-07-25): this is a **global-grade application**; it needs top-level design, a high level of abstraction, objectivity, no impact on other features / interfaces, and no new bugs created while fixing.
>
> 🔴 Red lines observed: ① AWS is used only through the explicit `--profile` of the temporary test account (`temp-account-1`); ② **nothing is installed or built on the local machine**; ③ feature acceptance **recognizes only headless-browser page results** (CLI / CloudTrail serve only to take ground truth for troubleshooting, not as acceptance evidence); ④ design first; code moves only after the decision; ⑤ `git tag` + contract-guard snapshot before touching the core chain; ⑥ no pushing without approval; ⑦ stop the job after verification to cap cost.
>
> Related: the earlier record that the 412 was not yet fixed; the lesson that an S3 sink and an S3 Tables sink are different sink types; the lesson that the log window mixes runs; the "wired but not persisted" class of bugs; the TaskRole inline-policy 10 KB limit; the dialect library of the [engine cookbook](./engine-cookbook.md); the operations knowledge base of [agent-native operations (incident memory)](./agent-native-operations-incident-memory.md).

---

## Section 0 — One-sentence conclusion (rewritten in revision 1.0)

The root cause of the 412 is **not** the "external, uncontrollable fact" that Iceberg manifest naming lacks entropy, but **one permission gap plus one silently swallowed error of the platform's own**:

**The platform TaskRole lacks the `kinesisanalytics:ListApplicationSnapshots` permission → the `try{...}catch{}` in `startFlinkJob` silently swallows the AccessDenied → `hasSnapshot` is always `false` → every start sends `SKIP_RESTORE_FROM_SNAPSHOT` → the Flink checkpointId resets to 1 → the delta manifest file name is byte-for-byte identical to the previous run's leftover → S3 Tables write-once refuses the overwrite → HTTP 412.**

Root fix = **add the permission + eliminate the silent swallow + stop letting "the probe failed" masquerade as "probed and found nothing"**. This is a deterministic fix 100% within the platform's control: no runner JAR change, no manifest path change, no new file-cleanup responsibility.

> ⚠️ This revision **voids all root-cause claims of revision 0.3 and its "next direction: a unique subdirectory"**. The reason is in section 2: the "second round of measurement" on which revision 0.3 relied to overturn itself never actually happened — CloudTrail proves that in all three starts the platform sent `SKIP_RESTORE`; `RESTORE_FROM_LATEST` was never sent even once.

---

## Section 1 — Measured evidence chain (all from the real test-account environment, not reasoning)

Job `bgp-flink-2eymfkk71pc81vyw` / `GameFlink-RT-GMV-byProduct`, sink = S3 Tables `s3t.realtime.rt_gmv_by_product`.

### E1 — Failures increase run after run; not "one blip, then self-heal" (CloudWatch logs)

| Run | Failed checkpoints | Failure count |
|---|---|---|
| v1 07:43 (**first start, which created the table**) | None | **0** |
| v1 09:20 | cp1 | **1** |
| v2 11:09 | cp1, cp2 | **2** |
| v3 11:18 | cp1, cp2, cp3 | **3** |

**This is progressive degradation, not a one-off blip.** The explanation of revision 0.3, "attemptNumber increments → new name → self-heal", cannot explain three consecutive collisions.

### E2 — Zero 412s on the first run proves the "collision with leftovers" direction is right, but revision 0.3 got the trigger condition wrong

Table `createdAt = 07:43:45`; in that run cp1–cp4 **all succeeded** (`Committing append for checkpoint 1 ... dataFilesCount=1, dataFilesRecordCount=9`). A brand-new empty table has no leftovers → no collision. The 412 appears only from the **second** run on.

### E3 — 🔴 Decisive: all three starts by the platform sent SKIP_RESTORE (CloudTrail)

```text
2026-07-25T09:17:42Z StartApplication req={"applicationRestoreType":"SKIP_RESTORE_FROM_SNAPSHOT"}
2026-07-25T11:05:43Z StartApplication req={"applicationRestoreType":"SKIP_RESTORE_FROM_SNAPSHOT"}
2026-07-25T11:14:52Z StartApplication req={"applicationRestoreType":"SKIP_RESTORE_FROM_SNAPSHOT"}
```

→ **`RESTORE_FROM_LATEST_SNAPSHOT` was never sent.** The experiment that revision 0.3, section 10 called "second round: snapshot present, RESTORE_FROM_LATEST → still 412 → thought to be iron proof against the root fix" **was never executed**; it tested the same cold-start path. **The refutation in revision 0.3 is itself wrong.**

### E4 — 🔴 Decisive: why it degraded to SKIP — the AccessDenied was silently swallowed (CloudTrail)

```text
2026-07-25T11:14:51Z ListApplicationSnapshots err=AccessDenied
  User: arn:aws:sts::<ACCOUNT>:assumed-role/BgpPlatformStack-TaskRole30FC0FBB-lmquXBEmuvpS
  is not authorized to perform: kinesisanalytics:ListApplicationSnapshots
2026-07-25T11:14:52Z StartApplication  → SKIP_RESTORE_FROM_SNAPSHOT     ← 1 秒后
```

The same AccessDenied also appears at `11:05:42Z`. Compare `flink-service.ts:615-620`:

```ts
if (snapshotsOn) {
  try {
    const ls = await kda.send(new ListApplicationSnapshotsCommand({ ApplicationName: name, Limit: 1 }));
    hasSnapshot = (ls.SnapshotSummaries?.length || 0) > 0;
  } catch { /* 查询失败保守回退 SKIP,不阻断启动 */ }   // ← AccessDenied 在这里被吞
}
```text

**`catch {}` squashed "I have no permission to query" and "I queried and there really is none" into the same `false`.** This is the true mechanism of this case, and a reusable architecture lesson (section 4.1).

### E5 — Ruling out every other explanation

| Alternative hypothesis | Measured basis for ruling it out |
|---|---|
| The snapshot was never created | `list-application-snapshots` returns 2 **READY** snapshots (`flink412-verify-snap` 11:11:51, `STOP-...` 11:13:06) |
| snapshotsEnabled stored as false in the DB | DynamoDB `bgp-flink-jobs` actually read = `{"BOOL": true}` |
| The snapshot switch is off on the MSAF side | `ApplicationSnapshotConfigurationDescription = {"SnapshotsEnabled": true}` |
| Timing race (the snapshot still CREATING) | The snapshot became READY at 11:11:51; the start was at 11:14:52; 3 minutes apart |
| `Hadoop FS is not available` is a fault | Level = **INFO**, logger = `HadoopFSDelegationTokenProvider`; harmless noise (already in the dialect library) |

→ All five alternative hypotheses are ruled out by data from the real environment; only the E3 + E4 explanation remains.

### E6 — The increment mechanism (Iceberg 1.9.1 source code; the predicted values match E1 exactly)

The pending-commit buffer of `IcebergFilesCommitter` is `NavigableMap<Long,byte[]> dataFilesPerCheckpoint`; `writeToManifestUptoLatestCheckpoint(checkpointId)` **iterates over every uncommitted checkpointId and writes one manifest for each**. After cp1 fails, its entry is not cleared → cp2 has to write {1,2} → cp3 has to write {1,2,3}.

→ The predicted failure-count sequence = 1, 2, 3 …, **matching the measured E1 sequence 0 → 1 → 2 → 3 item by item**. The only file name that is truly stuck is **cp1's**; the later ones are dragged down by it.

### E7 — Manifest naming is deterministic (verified in the source code; explains "why resetting to 1 must collide")

`ManifestOutputFileFactory.generatePath()`: `String.format("%s-%s-%05d-%d-%d-%05d", flinkJobId, operatorUniqueId, subTaskId, attemptNumber, checkpointId, fileCount.incrementAndGet())` + `.avro`, **no UUID**.

Measured: MSAF always reuses the same Flink JobID `2dd04c3a17d9a825151c2d3268ede996` (identical across v1 / v2 / v3), the opUID `57c004f5ada35552ab46620344b00093` is constant, subTaskId = 0. **The only variable is checkpointId** — as long as it does not reset to 1, a collision is impossible.

### E8 — The full extent of the permission gap (IAM actually inspected; the fix must be made as a group)

`BgpPlatformStack-TaskRole30FC0FBB-lmquXBEmuvpS` currently has 10 `kinesisanalytics:*` actions (`infra/lib/platform-stack.ts:207-219`), **and not a single one of the snapshot family**:

| Action | Present? | Already used by the platform | Consequence of absence |
|---|---|---|---|
| `ListApplicationSnapshots` | ❌ | ✅ `flink-service.ts:617` | **The 412 of this case** |
| `DescribeApplicationSnapshot` | ❌ | Not used (needed by section 3.2) | Cannot verify that the snapshot is READY |
| `DeleteApplicationSnapshot` | ❌ | Not used | Snapshots accumulate without bound (quota / cost) |
| `CreateApplicationSnapshot` | ❌ | Not used (MSAF takes one automatically on stop, not through the platform) | Cannot take a snapshot proactively |
| Create/Delete/Update/Start/Stop/Describe/ListApplications/AddApplicationCloudWatchLoggingOption/TagResource/CreateApplicationPresignedUrl | ✅ | ✅ | — |

**Same-source risk**: `pauseFlinkJob` (`:659-664`) uses `SnapshotsEnabled` to decide `Force`; the graceful stop relies on MSAF taking a snapshot automatically. If the snapshot-family permissions are incomplete, the "graceful stop" silently degrades into a forced stop → no snapshot at the next start → back to SKIP_RESTORE. **Therefore the permissions must be added as a complete group, not one action.**

---

## Section 2 — Where revision 0.3 went wrong (kept on record to prevent recurrence)

| Claim in revision 0.3 | Measured verdict |
|---|---|
| "MSAF reuses the jobId; the checkpointId continued by RESTORE still collides with the history left under the same jobId" | **Void**. RESTORE was never executed (E3). The claim is an interpretation of an experiment that never happened |
| "Continued checkpointIds never collide only for brand-new empty tables" | **Void**. Continuation was never tested; E7 proves that after continuation checkpointId increases monotonically and is never 1, so it cannot collide with the cp1 leftover |
| "One blip, then self-heal (attemptNumber increments, new name)" | **Void**. E1 measured three consecutive collisions; E6 gives the real mechanism (the uncommitted set only grows) |
| "Next direction: a unique `flink.manifests.location` subdirectory" | **Downgraded to unnecessary**. It solves a problem fabricated by a platform bug; and it would move manifests out of the S3 Tables managed bucket, beyond the reach of AWS's 3-day orphan auto-cleanup → the platform takes on new file-governance debt (trade-off in section 5) |

**Methodological lesson** (written into section 4.1 and into the project memory): **when "the change was made but behavior did not change", the first step must be to verify "did the change actually execute" (CloudTrail / the audit layer), not to overturn the root-cause hypothesis immediately.** Revision 0.3 skipped that step, used reasoning to negate a direction that was in fact correct, and then proposed the next, more complex plan on top of the wrong conclusion — exactly the "endless loop of creating bugs while fixing" that had been warned about.

---

## Section 3 — Root-fix design (top level: three layers of defense, each standing on its own)

### Section 3.0 — Design principles (aligned with the instruction)

1. **Fix the cause, not the effect**: the 412 is the effect; the `catch{}` swallowing the AccessDenied is the cause. Adding the permission + making the failure visible is the root fix.
2. **No special-case branch for a single sink**: the `snapshotsEnabled` / restore semantics are correct for **every stateful Flink job** (Kinesis / CDC / mysql / custom sink alike); no `if (sinkType==='s3table')` is introduced.
3. **Zero new external responsibility**: no runner JAR change, no manifest path change, no new file-cleanup task, no deletion of any S3 object (deleting S3 Tables managed objects is irreversible).
4. **Observability over fallbacks**: a failed capability probe must **leave a trace** and **alert**; it never silently degrades into "looks normal".
5. **Zero interface breakage**: no API contract / response structure / DB field semantics change; everything added is **optional and backward compatible**.

### Section 3.1 — Three layers of defense (L1 mandatory, L2 mandatory, L3 safety net)

```
L1 capability layer: add the kinesisanalytics snapshot-family permissions (CDK)
   → makes the existing "restore from snapshot" chain genuinely usable for the first time
L2 semantic layer: eliminate the silent swallow — a three-state probe result + trace and alert on failure
   → even if a permission goes missing again in the future, it "fails loudly" instead of quietly degrading into a 412
L3 resilience layer: convergent behavior when restore is genuinely unavailable (no new cleanup debt)
   → explicit boundary: a blip may still occur once, but it is visible, diagnosable and self-healing
```text

#### L1 — Add the permissions (`infra/lib/platform-stack.ts:207-219`, appending 4 actions)

```ts
"kinesisanalytics:ListApplicationSnapshots",      // startFlinkJob 判定是否有可恢复快照(本案根因)
"kinesisanalytics:DescribeApplicationSnapshot",   // 核验快照 READY(避开 CREATING 竞态)
"kinesisanalytics:CreateApplicationSnapshot",     // 未来主动打快照(升级前/编辑前)
"kinesisanalytics:DeleteApplicationSnapshot",     // 快照生命周期治理(防无限累积)
```

- Reuse **the same existing PolicyStatement** (the same `resources:["*"]` + the same region condition); **no new statement, no new ManagedPolicy** → stays clear of the TaskRole inline-policy 10 KB limit.
- Deployment surface: only the TaskRole policy of `BgpPlatformStack` changes; **the ECS service is not re-created and no other stack is touched**.

#### L2 — Three states + trace (`flink-service.ts`, the core abstraction)

Upgrade the boolean `hasSnapshot` to **three states**, so that "don't know" no longer impersonates "none":

```ts
/** 快照可恢复性探测结果(三态,不可用 boolean 表达):
 *   "available"   —— 确认存在 READY 快照,可恢复
 *   "none"        —— 确认查过、确实没有(首启/空表,冷启动是正确选择)
 *   "unknown"     —— 探测本身失败(无权限/限流/网络),【不等于没有】
 * 关键:unknown 必须留痕告警,绝不静默当成 none —— 那正是 412 的成因。 */
export type SnapshotProbe = "available" | "none" | "unknown";

/** 启动恢复类型决策(纯函数,可测,零 AWS 依赖)。 */
export function pickRestoreType(snapshotsOn: boolean, probe: SnapshotProbe):
  "RESTORE_FROM_LATEST_SNAPSHOT" | "SKIP_RESTORE_FROM_SNAPSHOT" {
  if (!snapshotsOn) return "SKIP_RESTORE_FROM_SNAPSHOT";   // 高级用户显式关快照
  if (probe === "none") return "SKIP_RESTORE_FROM_SNAPSHOT"; // 确认无快照:首启,冷启动安全
  // available 或 unknown → 一律 RESTORE_FROM_LATEST。
  // unknown 也选 RESTORE 的依据(AWS 明文语义,§3.2 待现场复核):
  //   RESTORE_FROM_LATEST_SNAPSHOT 在无快照时【不报错,自动全新启动】,
  //   故它是严格更安全的默认 —— 有快照则续编 checkpointId(不撞名),无快照则退化成冷启动。
  return "RESTORE_FROM_LATEST_SNAPSHOT";
}
```typescript

Probe side (the single exit; a failure always leaves a trace):

```ts
async function probeSnapshots(name: string): Promise<SnapshotProbe> {
  try {
    const ls = await kda.send(new ListApplicationSnapshotsCommand({ ApplicationName: name, Limit: 50 }));
    const ready = (ls.SnapshotSummaries || []).some((s) => s.SnapshotStatus === "READY");
    return ready ? "available" : "none";
  } catch (e: any) {
    // 🔴 绝不静默:留痕 + 可观测,让"能力缺失"响亮暴露(本案 412 正因这里曾是 catch{})
    console.error("[flink] 快照探测失败,按 unknown 处理(不退化为 none)", { app: name, err: String(e?.name || e) });
    return "unknown";
  }
}
```

**Why three states is the right abstraction** (rather than adding another boolean): the failure mode has three semantics and a boolean can express only two; squeezing the third into `false` is this case's bug. The abstraction holds for **any scenario that "probes an external capability and then decides on it"** (the same family of pitfalls: the "wired but not persisted" class of bugs, the agent-runner silent swallow).

#### L3 — Resilience boundary (an honest declaration; no new debt)

If L1 / L2 are both in place but restore is still unavailable (for example: the user explicitly turned snapshots off, snapshot incompatibility across a Flink version upgrade, `AllowNonRestoredState` refusing), the job cold-starts → checkpointId resets to 1 → **a table with existing leftovers may still collide once with a 412**. In that case:

- The behavior is **visible** (the L2 trace + the dialect-library rule explaining the 412), **diagnosable** (the operations knowledge base of agent-native operations), and **Flink's own retry converges** (E1 shows the commit succeeds once the cp number advances);
- **No** unique subdirectory and **no** proactive deletion of leftovers are introduced: the former creates orphans outside the managed bucket (AWS's 3-day auto-cleanup cannot reach them; the platform would have to build its own cleanup = new operations debt + a new failure mode), and the latter is irreversible (AWS states plainly: "Deletes of noncurrent objects are permanent with no way to recover").

> **Honest boundary**: this design is a **deterministic root fix** for the "main path (stop → start, update, scale, failure restart)"; for the explicitly chosen combination "the user turns snapshots off + the table has leftovers", one visible blip is kept, and the user's choice is not implicitly overridden. This is a trade-off, not an omission.

### Section 3.2 — One external fact that must be re-verified on site before going live (no betting on documentation)

`pickRestoreType` chooses `RESTORE_FROM_LATEST_SNAPSHOT` for `unknown`, relying on "**that type does not error when no snapshot exists; it starts fresh automatically**". The conclusion comes from the AWS documentation, **but the very lesson of revision 0.3 is that unverified external behavior must not be used as a foundation**.

**Verification method (after the L1 deployment and before formal acceptance; one real start to establish it)**: for a newly created Flink job with **no snapshot at all**, start it once **from the platform page** and assert: ① the start succeeds and enters RUNNING; ② CloudTrail shows that `RESTORE_FROM_LATEST_SNAPSHOT` was sent; ③ the log shows `No checkpoint found during restore` and the job runs normally.
**If the assertion fails** (i.e. RESTORE errors when no snapshot exists), the `unknown` branch changes to **first calling `DescribeApplication` to read `SnapshotsEnabled` on the MSAF side as a second confirmation, then choosing**; this is the reserved Plan B and does not affect the L1 / L2 body.

### Section 3.3 — Blast-radius self-check (ensuring "no impact on other features / interfaces")

| Affected surface | Changed? | Notes |
|---|---|---|
| API contract (`/api/flink/jobs/*`) | **No** | No input / response structure change |
| DB field semantics (`bgp-flink-jobs`) | **No** | `snapshotsEnabled` semantics unchanged; no migration |
| Front-end UI | **No** (this round) | The snapshot switch and its default stay as shipped in the previous round |
| Other sink types (s3 / mysql / custom) | **Benefit only** | The restore semantics are generic for all stateful jobs; no sink branch |
| Other Flink job types (Kinesis / CDC) | **Benefit only** | Same as above |
| Runner JARs (both) | **No** | No rebuild, no POM change, no JAR rollback surface |
| Other CDK stacks | **No** | Only 4 actions appended to the BgpPlatformStack TaskRole policy |
| `pauseFlinkJob` graceful stop | **Fixed** | Once L1 adds the permissions, the snapshot-dependent graceful-stop path becomes genuinely usable (the same-source risk of E8) |
| The single normalization exit `normalizeResources` | **Unchanged** | Still the only exit for `snapshotsEnabled` |

**New tests** (extending the `__tests__/flink-service.test.ts` created in the previous round; pure functions, no AWS calls):
`pickRestoreType` × {snapshotsOn: T/F} × {probe: available/none/unknown} = 6 cases, full coverage, **including the key regression assertion `(true,"unknown") → RESTORE_FROM_LATEST`** (i.e. "a failed probe must not degrade into a cold start" — the guard against this case's 412).

---

## Section 4 — Distillation (so that the same class of problem does not recur)

### Section 4.1 — Architecture lessons → dialect library + operations knowledge base

1. **`catch {}` swallowing a capability-probe exception = disguising "don't know" as "none"**, which lets the upper layer make a catastrophic downgrade decision. Every "probe, then decide" must use three states + a trace on failure. (Goes into the operations knowledge base of agent-native operations + the platform coding conventions.)
2. **When "the change was made but behavior did not change", the first troubleshooting step is "did the change actually execute"** — check the actual request parameters in CloudTrail / the audit layer rather than overturning the root-cause hypothesis. (Goes into the operations knowledge base; had CloudTrail been checked in the first round of this case, an entire round of wrong design would have been saved.)
3. **An IAM permission gap can masquerade as a business bug**: whenever the platform calls a new AWS API, the TaskRole permissions must be checked at the same time; it is suggested that `redline-scan.sh` gain a drift check "AWS actions used in the code vs actions authorized in CDK" (**this design only proposes it; it is not implemented in this round**, to avoid widening the change surface).

### Section 4.2 — Correction of the dialect-library rules (engine cookbook)

The previous round added 2 rules (`hadoop-fs-info-noise`, `s3tables-checkpoint-412`). This round must **correct the root-cause description of the 412 rule** — the original description pointed at "manifest naming lacks entropy; a unique subdirectory is needed", which contradicts the measurements; it should read: "**first-frame 412 = a cold start (SKIP_RESTORE) resets checkpointId to 1 and collides with a same-named leftover manifest; first check whether the start was really sent as RESTORE_FROM_LATEST and whether the platform has the ListApplicationSnapshots permission**". Otherwise the wrong conclusion would be repeated by AI diagnosis indefinitely (a contamination surface larger than the code).

---

## Section 5 — Alternatives compared (why not the unique subdirectory)

| Dimension | **This design (add permissions + three states)** | The direction left over from revision 0.3 (a unique subdirectory) |
|---|---|---|
| Solves the real root cause? | ✅ Hits the iron evidence of E3 / E4 directly | ❌ Solves a problem fabricated by a platform bug |
| Change surface | 4 CDK actions + 1 pure function + 1 probe function | SQL DDL generation + run sequence-number state + a cleanup task |
| New external responsibility | **Zero** | Manifests leave the managed bucket → AWS's 3-day orphan cleanup cannot reach them → **the platform must build its own cleanup** |
| New failure modes | None | The cleanup task itself (missed cleanup = garbage accumulates; wrong cleanup = table corruption) |
| Sink-specific? | No (generic restore semantics) | Yes (an S3 Tables-only path) |
| Effect on other jobs | Benefit only (the graceful stop is fixed as well) | No benefit |
| Reversibility | High (policy append + pure function) | Medium (path data already written stays in the bucket) |

→ **The unique subdirectory is no longer needed.** Even if the on-site check of section 3.2 overturns the AWS semantics assumption, Plan B (second confirmation) comes first, not the unique subdirectory.

---

## Section 6 — Acceptance assertion checklist (🔴 all evidence is taken by **operating the page in a headless browser**; the CLI serves only for auxiliary reconciliation)

| # | Assertion | Page evidence method |
|---|---|---|
| V1 | **Root fix for an existing table with leftovers**: start `GameFlink-RT-GMV-byProduct` (the table already holds the conflicting leftovers from 07:43) from the page → **fullRestarts = 0 throughout** | Start on the Stream Compute page → status / restart count on the detail page; reconcile with CloudWatch |
| V2 | **Main path for a new job**: create an S3 Tables job on a **brand-new table** from the page and start it → stable RUNNING ≥ 5 min, fullRestarts = 0 | Page creation wizard → detail page |
| V3 | **Stop → start reproduces the original trigger condition without a 412** | Click Stop on the page → click Start again → no restart on the detail page, no 412 in the log |
| V4 | **Data really lands**: the Athena query page independently finds the aggregated data (not the result card on the Flink detail page — the lesson that an S3 sink and an S3 Tables sink are different) | SELECT on the Athena query page |
| V5 | **The permission gap is closed**: after the start, CloudTrail shows **no AccessDenied** for `ListApplicationSnapshots`, and `StartApplication` actually sends `RESTORE_FROM_LATEST_SNAPSHOT` | CLI auxiliary reconciliation (not primary acceptance evidence, but mandatory in this case — it is the root cause) |
| V6 | **Zero regression**: the other Flink job types (Kinesis source / mysql sink / custom sink) start normally from the page | Start / stop each type from the page |
| V7 | **contract-guard verify shows zero regression** | The headless contract-guard check |
| V8 | **All unit tests green**, including the `(true,"unknown") → RESTORE_FROM_LATEST` guard | `flink-service.test.ts`, 6 cases |
| V9 | **The dialect library's 412 rule is corrected** (it no longer points at a unique subdirectory); AI diagnosis gives the correct root-cause direction | Check the output on the diagnosis page |

> V1 is the **core assertion** of this design: it is the only experiment that can prove "an existing table with leftovers was really cured". Revision 0.3 failed precisely because it took an experiment that "did not actually restore" as V1.

---

## Section 7 — Rollback anchors and execution order

1. A `git tag` on the pre-change commit (revision 0.3 already has its own anchor; this round sets a separate one) + a contract-guard **snapshot**;
2. L1: CDK adds the permissions → deploy `BgpPlatformStack` (the TaskRole policy only; the service is not re-created);
3. Section 3.2: on-site check of the AWS `RESTORE_FROM_LATEST` no-snapshot semantics (1 real start);
4. L2 code (three states + probe trace + unit tests) → `redeploy-platform.sh`;
5. Section 4.2: dialect-library rule correction;
6. V1–V9 headless-browser acceptance → **stop the job after verification to cap cost**;
7. Not committed; confirm before pushing.

**Disposition of the previous round's live but uncommitted changes**: `snapshotsEnabled` defaulting to true (semantically correct; the basis of L1 / L2), the 2 dialect-library rules (descriptions to be corrected per section 4.2), `flink-service.test.ts` (the first unit test of the core chain) — **all kept**; the signature of `pickRestoreType` is reshaped to the L2 three states (boolean → SnapshotProbe).

---

## Section 8 — Honest boundaries (no exaggeration)

1. **"S3 Tables enforces write-once on the service side" is still a strong inference**: the Iceberg client sends no `If-None-Match` yet receives a 412, leaving service-side enforcement as the only explanation; the AWS documentation has no directly quotable statement. **But it does not affect this design** — the design removes the precondition "duplicate file name", which holds regardless of why the service refuses the overwrite.
2. **The AWS semantics of section 3.2 await on-site confirmation**; Plan B is prepared.
3. **L3 boundary**: "the user explicitly turns snapshots off + the table has leftovers" may still blip once (visible, self-healing, no data loss); the user's choice is not implicitly overridden.
4. The job in question is currently stopped (READY); this root fix targets the experience and predictability for global users, not a live firefight.
