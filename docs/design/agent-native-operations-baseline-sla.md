# Part B — Intelligent baseline learning + SLA critical-path prediction (early warning before the breach)

> - 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior —
>   place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is summarized in the [modules overview](../modules.md). A path mentioned
>   in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.
> - ⚠️ **Implementation differences**: `infra/agent/devopsdiag` was not implemented; the operations diagnosis agent runs inside the platform process at `platform/src/lib/diagnostics/devops-agent.ts` (API `platform/src/app/api/diagnostics/`). The Backfill Center (Part C) was implemented as the
>   `/backfill` page plus `platform/src/lib/backfill/`.

> - Revision: 1.0 **✅ implemented** (documentation audit calibration of 2026-08-26: the original status header was out of date) | Created: 2026-07-12 | Priority: P1 | Capability group: intelligent baselines / SLA / stall prediction (phase two)
> - Upstream master design: [agent-native operations](./agent-native-operations.md) | Reuse: `bgp-task-runs` (learning data source) · `bgp-workflows.dagDefinition` (topology) · the [alerting module](./intelligent-ops-alerting.md)'s channel dispatch (push) · MWAA (learner DAG + cron expected period)
>   · `charts.tsx` (dashboard cards)
> - **Purely additive `lib/baseline/` + independent API + independent tables + independent events. Does not change the alerting module's rule engine (only imports its channel dispatch functions).**

---

## 1. Feature overview

The first phase of the [alerting module](./intelligent-ops-alerting.md)'s "stall / punctuality" detection is **rule-based with fixed thresholds**: alert when no success has arrived within the expected period, alert when the duration exceeds a hard-coded number of minutes. The problems: ① the thresholds have to be set by hand — set too high they miss, set too low they false-alarm; ② you only know **after the breach**, and the window for operational intervention is lost.

The real trump card of a leading cloud data-development suite is **baseline early warning (baseline)**: learn a dynamic baseline from **historical run durations**, derive the **estimated time of completion (ETA)** along the **dependency critical path**, and predict **while the task is still running** that "at the current pace, tonight's output will be delayed; expected completion 02:15, while the SLA is 02:00" — an alert **before the breach**, giving an intervention window. This is precisely a capability for which AWS natively has no counterpart, and one that needs calendar time to accumulate history before it becomes accurate.

This design delivers:
1. **Dynamic baseline learning** (B.1): every task learns its p50 / p90 / EWMA duration, punctuality distribution and success-rate baseline from the `bgp-task-runs` history; duration anomalies (relative to the task's own history, not to a fixed value) raise an early warning.
2. **SLA critical-path prediction** (B.2): compute the critical path from the workflow DAG topology, and roll a prediction of the end-point ETA from each node's baseline plus the actual elapsed time of the nodes already completed; define SLAs (committed completion time), and push an alert as soon as a breach is predicted **while the run is in progress**. A multi-window burn rate (a short window for urgency, a long window for stability) reduces false positives.

---

## 2. User stories

- As a **data operations engineer**, I want to receive, while the overnight batch is still running, "GameAds-Analytics-WF is expected to complete at 02:15, SLA 02:00, breach very likely, currently stuck at B_channel_roas_rank (already beyond p90)", so that I have 40 minutes to act instead of discovering at 02:01 that the output is not there.
- As a **data developer**, I want duration alerts to be "relative to this task's own history" (a task that normally takes 20 s should alert only when it takes 300 s today), not one threshold shared by all tasks.
- As an **architect**, I want a "today's SLA attainment forecast" block on the dashboard that shows at a glance which chains are at risk of breaching, together with the historical punctuality trend.

---

## 3. Interaction design

**Additional cards on the Ops Dashboard `/ops` (existing cards unchanged; purely additive)**:
- "SLA risk board": lists the workflows / tasks that have an SLA configured; each row shows committed deadline / current ETA / risk (green = margin left, yellow = close, red = breach predicted) / the current bottleneck on the critical path.
- "Top baseline deviations": the tasks with the largest deviation from their own p90 today.

**Additional blocks on the task / workflow detail pages (purely additive)**:
- "Baseline" panel: the task's p50 / p90 / EWMA duration trend (reusing `TrendArea`), with the current run marked on it.
- Workflow: the critical path highlighted + a "baseline vs. actual" progress bar per node + rolling ETA.

**Baseline / SLA configuration (a new page `/sla`, or a new tab on `/alerting` — a new page is recommended to avoid touching the alerting pages)**:
- SLA definition: pick a task / workflow → committed completion time (an offset relative to the scheduled trigger, such as "90 min after trigger", or an absolute "02:00") → warn lead time (such as alert as soon as a breach is predicted 30 min ahead) → channels (reusing the alerting module's channels).
- Read-only baseline display + a "Re-learn" button (manually triggers the learner).

---

## 4. API design (new `app/api/baseline/**` and `app/api/sla/**`)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/baseline/[taskId]` | viewer | The baseline learned for a task (p50 / p90 / EWMA / punctuality distribution / success rate / sample count) |
| POST | `/api/baseline/learn` | editor | Manually trigger one learning pass (single task or all); the learner DAG also calls it periodically |
| GET | `/api/sla` | viewer | SLA definition list + today's attainment forecast |
| POST/PUT/DELETE | `/api/sla` `/api/sla/[id]` | editor | SLA CRUD (optimistic lock `version`) |
| POST | `/api/sla/predict` | internal / front-end refresh | Rolling ETA prediction + breach decision for in-progress runs (idempotent; the event dedupe key is described in section 6.3) |
| GET | `/api/sla/risk-board` | viewer | Aggregate for the dashboard's "SLA risk board" |

---

## 5. Data model (DynamoDB, 2 new tables, `hardened`)

| Table | PK / SK | Purpose | Notes |
|---|---|---|---|
| `bgp-baselines` | `pk="baseline#<projectId>"` / `taskId` | The baseline snapshot learned per task | Upserted periodically by the learner; includes the algorithm version |
| `bgp-slas` | `pk="sla#<projectId>"` / `slaId` (ULID) | SLA definition + the most recent prediction state | `version` optimistic lock; `targetType: relative\|absolute` |

**Baseline row (`bgp-baselines`)**:
```
projectId, taskId, taskType,
durationSec: { p50, p90, p95, ewma, stdev, samples, windowDays },
startDelay: { p50Sec, p90Sec },       // queueing delay from the scheduled trigger to the actual start (used for ETA)
punctuality: { onTimeRate, samples },  // historical punctuality rate (relative to this task's SLA)
successRate: { value, samples },
learnedAt, algoVersion,
// robust statistics: outlier removal (IQR / MAD), cold start (samples < N flagged lowConfidence)
lowConfidence: boolean
```

**SLA row (`bgp-slas`)**:
```
slaId, projectId, name, enabled, version,
target: { taskId|workflowId, scope: "task"|"workflow",
          type: "relative", offsetMinFromTrigger: number
        | "absolute", clockTime: "02:00", tz },
warnLeadMin: 30,                 // how many minutes ahead a predicted breach triggers the alert
channelIds: string[],            // reuses the alerting module's channels
lastPrediction: { runId, etaAt, willBreach, riskLevel, criticalPathNode, at },
createdAt, updatedAt, createdBy
```

> Prediction events get no new table: they are pushed through the **alerting module's channel dispatch** (the message carries predicted-breach semantics) and may optionally write one `bgp-alert-events` row (status=`firing`, dedupeKey=`sla#<slaId>#<runId>#predicted`) — **by importing the alerting module's channel functions and event-write helper**, without changing its rule engine.

---

## 6. Backend implementation (`lib/baseline/`)

### 6.1 Learner (B.1)
- `lib/baseline/learn.ts`: `learnBaseline(taskId?)` — pulls the duration / startDelay of the task's successful runs over the last `windowDays` (default 30) from `bgp-task-runs` → **robust statistics** (MAD outlier removal, so that one large backfill run does not pollute the baseline) → computes p50 / p90 / p95 / EWMA → upserts `bgp-baselines`. With fewer than N samples (default 7) the row is flagged `lowConfidence` (no false alarms during cold start).
- **Trigger**: an MWAA learner DAG (runs once a day at off-peak, following the alerting module's "reserved EventBridge / MWAA schedule" idea) + manual `POST /api/baseline/learn`. **Pure reads of `bgp-task-runs`, zero writes back to the ledger**; does not interfere with online operation.
- **Duration early warning**: an in-progress run whose elapsed > `k × p90` (k default 3, configurable) and that is not a backfill (`triggeredBy!='backfill'`) → a "run duration anomaly" is pushed through the alerting module's channels. **Complementary to, not in conflict with**, the alerting module's fixed timeout rule (the alerting module uses an absolute threshold; this uses the task's own baseline).

### 6.2 Critical-path ETA (B.2)
- `lib/baseline/critical-path.ts` (a pure function, unit-testable): input `bgp-workflows.dagDefinition` (nodes / edges) + the baseline duration of each node → topological sort → longest path (taking the `retryCount` / `timeout` upper bounds into account) = the critical path + the theoretical total duration.
- `lib/baseline/predict.ts`: for an in-progress workflow run — completed nodes use their **actual** elapsed time, nodes not yet started or in progress use their **baseline** → the remaining critical path is recomputed on a rolling basis → `etaAt = now + remaining`. Compared with the SLA's committed time → `willBreach` + `riskLevel` (margin > warnLead = green, < warnLead = yellow, etaAt > slaAt = red) + the current bottleneck node.
- **Data source**: the state of each workflow node can be obtained from MWAA (the task instances of the `bgp_<taskId>` DAG, which the alerting module / ETL already read) or from the `bgp-task-runs` sub-items; the existing read path is reused, with no new MWAA permissions.

### 6.3 Multi-window burn rate + idempotency
- The push of a predicted breach uses **multi-window confirmation** (a 5-minute short window decides "urgent", a 30-minute long window decides "stable") to reduce jitter-induced false positives, borrowing from SRE burn-rate practice.
- The predicted-breach for each `(slaId, runId)` is pushed only once (dedupeKey); recovery (the ETA returns within the SLA) may optionally push a resolve — reusing the alerting module's event deduplication.

---

## 7. AWS service dependencies

- **DynamoDB** `bgp-baselines` / `bgp-slas` (hardened).
- **MWAA**: the learner DAG (daily) + reading workflow task instances for progress (reusing the existing read path, no new permissions).
- **The alerting module's channels** (DingTalk / WeCom / SES / webhook): import their dispatch functions to push prediction alerts; their code is not changed.
- **CloudWatch**: learner run logs.
- No new external services; no heavyweight ML such as SageMaker is introduced (robust statistics + EWMA are sufficient for the first phase; ML prediction is left for later).

---

## 8. Security considerations

- Baselines / SLAs are operational configuration data: `bgp-*` key-based project isolation + RBAC (read viewer, write editor).
- The learner **only reads** `bgp-task-runs` and never writes back; it does not affect the online ledger or the run records of other sessions.
- Prediction pushes reuse the alerting module's existing redaction (secrets are not echoed back) and idempotency; no new outbound surface.
- `POST /api/sla/predict` is idempotent + deduplicated, so that high-frequency front-end refreshes cannot cause an alert storm.

---

## 9. Acceptance criteria (headless / real; contract-guard once before and once after)

- [ ] **Baseline learning**: for a task with ≥7 historical successful runs (such as GameAds-Analytics-WF), after `POST /api/baseline/learn` the `bgp-baselines` row shows p50 / p90 / EWMA, and MAD outlier removal is effective (injecting one very long backfill run does not significantly raise p90 — assertion).
- [ ] **Cold start**: a task with <7 samples is flagged `lowConfidence` and does not trigger the duration early warning (prevents false alarms on new tasks).
- [ ] **Critical-path unit test**: `critical-path.ts` computes the correct critical path and total duration for a known DAG (rollup→{roasrank,country}) (checked against a hand calculation).
- [ ] **Breach-prediction hard evidence**: construct / replay a workflow run that "slows down midway" with an SLA set slightly below the historical total duration → **while the run is in progress** (not after it ends) `predict` returns `willBreach=true`, riskLevel = red and the correct bottleneck node, and one predicted-breach is **really pushed through the alerting module's channels** (received by the self-test sink; dedupe yields exactly one).
- [ ] **Multi-window false-positive reduction**: a brief jitter (a single point slows down and then recovers) does not trigger a breach alert; only a sustained slowdown does.
- [ ] **Dashboard**: the new SLA risk board card on `/ops` renders (red / yellow / green) without changing the existing cards (screenshot comparison shows zero regression against the alerting module's first-phase dashboard).
- [ ] **Complementary, not conflicting**: the alerting module's fixed timeout rule and this module's relative-baseline early warning can coexist without duplicate alerts (different dedupeKey, different semantics).
- [ ] **contract-guard**: site-wide L1 + core L2 show zero regression (in particular `/ops`, `/monitor`, `/alerting`).
