# Part C — Production-grade backfill (bulk backfill instances + dependency chain + concurrency / online isolation + retry of failures)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is summarized in the [modules overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.
> ⚠️ **Implementation differences**: `infra/agent/devopsdiag` was not implemented; the operations diagnosis agent runs inside the platform process at `platform/src/lib/diagnostics/devops-agent.ts` (API `platform/src/app/api/diagnostics/`). The Backfill Center (Part C) was implemented as the `/backfill` page plus `platform/src/lib/backfill/`.

> Revision: 1.0 **✅ implemented** (documentation audit calibration of 2026-08-26: the original status header was out of date) | Created: 2026-07-12 | Priority: P1 | Capability group: backfill
> Upstream master design: [agent-native operations](./agent-native-operations.md) | Reuse: engine SPI `lib/engines/` (`submit(runDate,'backfill')` already supported) · `bgp-task-runs` (triggeredBy isolation) · `bgp-workflows.dagDefinition` (dependency chain) · the [GenBI asynchronous execution](./genbi-async-execution.md) paradigm (submit → poll → heartbeat → re-claim → forced finish) · `version-service`
> **Purely additive `lib/backfill/` + two tables + a new page + a new API segment. Only calls the exported methods of the engine SPI; does not change providers / routes.**

---

## 1. Feature overview

Current state (the roadmap's backfill capability): backfill exists only at the **single-job level** (the EMR and ETL engines of part A of the [multi-engine nodes module](./multi-engine-nodes.md) each have a `backfill` endpoint, `submit(runDate,'backfill')`). What production really needs from backfill is:

- **Bulk dates**: "recompute the 10 days 07-01 ~ 07-10" — generate 10 backfill instances in one click, not 10 manual clicks.
- **Dependency chain**: when an upstream dimension table is backfilled, **every downstream table that depends on it** must be recomputed in topological order.
- **Concurrency control + online isolation**: backfill is bulk recomputation; its concurrency must be capped (do not overwhelm EMR / Redshift), and it **must never pollute the success-rate / SLA statistics of the online scheduled instances** (otherwise baselines and alerts all go wrong).
- **Retry of failures**: when day 6 of 10 fails, rerun only day 6 (and its unfinished downstream); what already succeeded is not redone.
- **Progress view**: a "date × node" matrix that shows backfill progress and bottlenecks at a glance.

These are exactly the semantics of the backfill center of a leading cloud data-development suite that most often cause production incidents — and that lock customers in the most. At the same time, **Part C is the "fix executor" of Part A's compounding loop**: a diagnosis concludes "X needs to be recomputed for certain days" → a backfill is started in one click from the diagnosis dialog → on completion, "fix verified" is written back to `bgp-incidents`.

---

## 2. User stories

- As a **data operations engineer**, after the upstream `dim_channel` has been corrected, I want one click to "backfill 07-01 ~ 07-10 and cascade downstream"; the platform runs everything in dependency order with capped concurrency and gives me a progress matrix, instead of me arranging 60 jobs by hand.
- As a **data developer**, when a backfill fails I want "retry" to retry only the failed instances and skip those that already succeeded.
- As the **platform**, backfill runs must never distort "today's success rate" or the "SLA punctuality rate" — they must be tagged `backfill` and excluded from online statistics.
- As an **architect**, I want backfill to be **controllable and reclaimable**: capped concurrency, pause / cancel, and a ceiling (to prevent a runaway that burns money).

---

## 3. Interaction design

**Entry 1 — new page `/backfill` (Backfill Center)**:
- Start wizard: pick a task / workflow → pick a date range (expansion by cron period is supported: day / hour / week) → whether to cascade downstream (dependency chain) → max concurrency → preview "Will generate N instances" → confirm.
- **Progress matrix**: rows = dates, columns = nodes (workflow scenario); each cell = the state of that (date, node) instance (pending / running / succeeded / failed / skipped), color-coded; click a cell to see that instance's run details / logs.
- Plan-level actions: pause / resume / cancel (cancel only stops the not-yet-started and running instances; succeeded ones are kept) / **retry failed**.

**Entry 2 — one-click backfill from the diagnosis report (Part A linkage)**:
If the diagnosis / knowledge-base fix runbook carries a `backfillHint {taskId, dateRange}` → a "Backfill as suggested" button → the wizard is pre-filled → confirm → on completion, "fix verified" is written back to the incident.

**Entry 3 — a "Backfill" button on the task / workflow detail pages (purely additive; the existing single-job backfill button is not changed)**: opens the `/backfill` wizard with that task pre-selected.

Prototype: antd Table / matrix + hand-drawn status color blocks, consistent with `/monitor`.

---

## 4. API design (new `app/api/backfill/**`)

| Method | Path | Permission | Description |
|---|---|---|---|
| POST | `/api/backfill/plan` | editor | Create a backfill plan: `{targetId, scope, dateRange, cascade, concurrency}` → expanded into an instance set (dry-run preview first, then persisted) |
| GET | `/api/backfill` | viewer | Backfill plan list |
| GET | `/api/backfill/[planId]` | viewer | Plan details + progress matrix (aggregate of instance states) |
| POST | `/api/backfill/[planId]/control` | editor | `{action: "pause"|"resume"|"cancel"|"retry-failed"}` |
| POST | `/api/backfill/[planId]/tick` | internal / front-end refresh | Idempotent advancer: claims pending instances (subject to the concurrency gate) → calls engine submit → writes the state back (see section 6.2) |

---

## 5. Data model (DynamoDB, 2 new tables, `hardened`)

| Table | PK / SK | Purpose | Notes |
|---|---|---|---|
| `bgp-backfill-plans` | `pk="backfill#<projectId>"` / `planId` (ULID) | Backfill plan | Parameters + aggregate progress + state machine + `version` |
| `bgp-backfill-instances` | `pk="<planId>"` / `sk="<date>#<nodeId>"` | One instance per (date, node) | State + runId + dependency-satisfied flag + attempt count, **TTL 90d** |

**Plan row**:
```
planId, projectId, name, createdBy, version,
target: { id, scope: "task"|"workflow", taskType },
dateRange: { start, end, granularity: "day"|"hour"|"week" },
cascade: boolean,                     // whether to cascade to downstream dependencies
concurrency: number,                  // max concurrency (hard gate)
maxInstances: number,                 // ceiling (prevents runaway; creation is refused above it)
status: "planned"|"running"|"paused"|"cancelled"|"succeeded"|"partially-failed",
progress: { total, pending, running, succeeded, failed, skipped },
createdAt, updatedAt
```

**Instance row**:
```
planId, sk, date, nodeId, nodeName, taskType,
status: "pending"|"blocked"|"running"|"succeeded"|"failed"|"skipped",
dependsOn: string[],                  // sk of the predecessor instances within the same plan (dependency chain)
runId?,                               // the run returned by the engine (written to bgp-task-runs, triggeredBy=backfill)
attempts, lastError?, startedAt?, finishedAt?, ttl
```

---

## 6. Backend implementation (`lib/backfill/`)

### 6.1 Plan expansion (`lib/backfill/plan.ts`, a pure function, unit-testable)
- Expands the date sequence from `dateRange` + `granularity` (respecting the task's cron period: an hourly task expands into hourly points).
- If `cascade`: reads `bgp-workflows.dagDefinition` (or cross-task dependencies, if a dependency registry exists) and computes the downstream closure topologically → one instance per (date × node), with `dependsOn` = the instances of the upstream nodes for the same date (**serial within a date, parallel across dates**, or as configured).
- Validates `total ≤ maxInstances` (the ceiling); above it, refuses with 400 and asks the user to narrow the range.
- **First returns the instance set as a dry-run preview**; persists only after confirmation (prevents accidentally creating thousands of instances).

### 6.2 Idempotent advancer (`lib/backfill/runner.ts`, copying the GenBI asynchronous execution paradigm)
- `tick(planId)`: ① compute the runnable instances (`pending` with all `dependsOn` `succeeded`; `blocked` ones are released) → ② claim them subject to the `concurrency` gate → ③ for each, call the **engine SPI** `submit(runDate=date, triggeredBy='backfill')` (already supported by EMR / ETL / workflow) → ④ write back `running` + runId.
- State collection: poll the engine's `poll(runId)` or read the final state from `bgp-task-runs` → write the instance back as `succeeded/failed` → update the plan's `progress` → unblock downstream.
- **Idempotency / self-healing** (following the GenBI asynchronous execution's executeGenBiAsk): conditional writes + a runToken prevent duplicate claims; an instance stuck in `running` past its timeout with no trace in the engine → reconcile marks it failed; the advancer can be triggered many times by front-end refreshes / a scheduled DAG without duplicate submissions (dedupeKey=`planId#sk`).
- **Retry**: `retry-failed` resets `failed` instances to `pending` (attempts+1), and their `blocked` downstream re-enters the game; `succeeded` instances are left untouched.
- **Trigger modes**: the first phase keeps the three options of the alerting module / GenBI asynchronous execution — "triggered by front-end refresh + manual + a reserved MWAA schedule" — to avoid the DAG explosion that building one MWAA DAG per backfill would cause (the engine's submit is called directly, reusing the engine's own execution, without passing through the MWAA scheduling layer).

### 6.3 Online isolation (critical)
- Every backfill run is written to `bgp-task-runs` with `triggeredBy='backfill'` (the engine SPI already supports this parameter).
- **Online statistics / baselines / alerts exclude backfill**: the alerting module's monitoring / success rate, Part B's baseline learning and the SLA punctuality rate **already filter, or must filter, `triggeredBy!='backfill'`** (Part B's section 6.1 explicitly excludes it; if the monitoring page does not yet exclude it, its owner session handles it — this module only guarantees correct tagging and does not change their statistics code).
> This is the mine most easily buried by backfill: if bulk backfill recomputation leaks into the online success rate, baselines and SLAs are all distorted. Tagging is a **hard constraint** of this module, with a dedicated acceptance assertion.

---

## 7. AWS service dependencies

- **DynamoDB** `bgp-backfill-plans` / `bgp-backfill-instances` (hardened).
- **Engine SPI** (EMR Serverless / Glue ETL / Redshift / workflow): reuses `submit/poll/stop`, **zero new permissions** (backfill uses exactly the same execution path as a normal run; only runDate / triggeredBy differ).
- **bgp-task-runs**: backfill runs naturally enter the ledger (triggeredBy=backfill) and can naturally be filtered by trigger mode in monitoring.
- No new external services.

---

## 8. Security considerations

- **Ceiling `maxInstances` + concurrency gate**: prevent one wrong operation from generating a flood of instances that overwhelms the engines / burns money (inheriting the red line "controllable and reclaimable"). The dry-run preview enforces confirmation.
- **RBAC**: start / control editor or above, view viewer; backfill is a write operation, and analysis accounts coming through the gateway are decided by the usual allow-list.
- **Cancel reclaims**: `cancel` stops the not-yet-started instances and attempts `stop(runId)` on the running ones (the engine SPI already has stop), leaving no zombie compute.
- **Idempotent, duplicate-submission-proof**: runToken + conditional writes; high-frequency front-end refreshes / scheduled triggers cannot burn money twice.
- **Online isolation** (section 6.3) is itself a security property: it prevents backfill from polluting the online SLA and raising false alerts.

---

## 9. Acceptance criteria (headless / real; contract-guard once before and once after)

- [ ] **Bulk backfill**: backfill 3 dates of an EMR / ETL task → 3 instances are generated, each really runs `submit(runDate,'backfill')` to succeeded, and `bgp-task-runs` shows 3 runs with `triggeredBy=backfill` (cross-checked on the AWS side with GetJobRun).
- [ ] **Online-isolation hard evidence**: after the backfill completes, today's success rate on `/monitor` and Part B's baselines are **not affected by these backfill runs** (assert that the statistics exclude backfill; the baseline p90 is not raised by the large backfill run).
- [ ] **Dependency chain**: cascading backfill of a workflow (rollup→{roasrank,country}) → the instances are generated in topological order, and the `roasrank/country` instances go `pending→running` only after the `rollup` instance is `succeeded` (timestamp ordering assertion).
- [ ] **Retry of failures**: deliberately make one instance fail → the plan is `partially-failed`; `retry-failed` reruns only the failed item + its `blocked` downstream, and the `attempts` of succeeded instances are unchanged (assertion).
- [ ] **Concurrency gate**: with concurrency=2, the number of simultaneously `running` instances is ≤2 (assertion).
- [ ] **Ceiling**: a request whose range exceeds `maxInstances` → refused with 400.
- [ ] **Idempotency**: concurrent repeated `tick` calls / many front-end refreshes → each instance is submitted exactly once (runToken; cross-checked on the AWS side).
- [ ] **Progress-matrix page**: the `/backfill` matrix renders the date × node status blocks, and the control actions (pause / resume / cancel / retry) take effect.
- [ ] **Part A linkage**: start a backfill in one click from a diagnosis / fix runbook that carries a `backfillHint` → correctly pre-filled → on completion, the `resolution.verified` timeline of that signature in `bgp-incidents` is written back.
- [ ] **contract-guard**: site-wide L1 + core L2 show zero regression (in particular the existing single-job backfill button and `/monitor`).
