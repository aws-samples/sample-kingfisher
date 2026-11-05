# FinOps Asset and Cost Governance (developer-first, task-level cost view)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is summarized in the [modules overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> Revision: **2.0 (fully isolated architecture, pending confirmation)** | Created: 2026-07-13 | Priority: high | Capability group: platform and openness — asset and cost governance
> Upstream master plan: the 2026-08 product roadmap (historical, single-region stage), phase "platform and openness"
> **Architecture red line (raised 2026-07-13): FinOps is a large feature and must be built as a fully independent module — directories / code / tables / infra stack all independent, with zero impact on existing features.**

---

## 0. Isolation architecture (the core of revision 2.0; read this section first)

### 0.1 Isolation principles

| Principle | How it is done |
|---|---|
| **Independent directories** | All new code lands in only 4 new directories: `lib/finops/**` (core logic) · `app/api/finops/**` (API) · `app/finops/**` (pages) · `components/finops/**` (dedicated components). Table-name constants live inside the module in `lib/finops/constants.ts`; the shared `lib/aws/dynamodb.ts` TABLES is **not touched** |
| **One-way dependencies** | Only **finops → existing stable exports** imports are allowed (docClient, apiOk/apiError, requireProject, the alerting `dispatch`, the incident-memory `store` functions, the baseline `stats`, the `charts.tsx` components); **no existing file imports finops**. Verified by a machine gate (see 0.4) |
| **Zero hooks, pull mode** | The revision-1 design's "immediate hook accounting on reaching a terminal state" is **abandoned** (it would change 4 state machines). Replaced by **pull-mode scanning**: the collector incrementally and **read-only** scans `bgp-task-runs` / the EMR run record + the engine APIs from a watermark and writes the costs into its own tables. Existing state machines / ledgers are **not changed by a single line** |
| **Independent infra stack** | A new `BgpFinOpsStack` (3 tables), deployed / destroyed independently, not part of DatabaseStack. **Unconditionally instantiated (installed by default; decided 2026-07-13)**: isolation relies on the "independent stack" itself (changing it touches no other stack; decommissioning = `cdk destroy BgpFinOpsStack`), and **no gating switch is added** — gating is for stacks with standing cost (DMS/MSAF/Kinesis), whereas this stack is only 3 on-demand DynamoDB tables with zero standing cost, and turning it off would only produce "a platform installed with a broken feature" (menu present, tables missing, page errors) |
| **Fault isolation** | Next.js route-level code splitting: a crash of the `/finops` page affects no other page; all APIs live in the `/api/finops/**` namespace; the tables are independent, so corrupt writes pollute no existing table |
| **Integration on the data plane, not the code plane** | The loop with the incident knowledge base runs on the **data plane**: finops brings its own cost signature function and directly calls the incident store's `upsertMaster`/`putOccurrenceIfNew` (already exported general-purpose functions) to write `bgp-incidents`, and the `/incidents` page naturally shows cost events — `lib/incidents/` has zero changes, so the 19 signature unit tests have zero regression by construction |

### 0.2 All changes to existing files (only 5 places, all purely additive, about ~30 lines in total)

| File | Change | Why unavoidable | Risk |
|---|---|---|---|
| `components/layout/routes.tsx` | +1 menu item line ("FinOps" in the g-ops group) | Every new page needs an entry; contract-guard L1 is generated from this file → the new page is automatically covered by the patrol | Very low (pure array append) |
| `lib/i18n/messages/en.ts` | Append the FinOps entries at the end (~60 entries) | The i18n hard rule: new Chinese UI copy must have dictionary entries | Very low (dictionary append) |
| `infra/bin/app.ts` | +2 lines (unconditional instantiation of `BgpFinOpsStack`, following the DatabaseStack pattern) | The single stack-assembly point | Very low (pure append) |
| `infra/lib/platform-stack.ts` | +1 independent ManagedPolicy block (CE read-only, `roles:[taskRole]`) | The TaskRole inline-policy 10 KB limit red line: new IAM must go in an independent ManagedPolicy; placing it in FinOpsStack would require a cross-stack reference to taskRole → hitting the CDK cross-stack export deadlock lesson; appending a block in the same stack is safer | Low (pure appended block, touches no existing statement) |
| `scripts/deploy-all.sh` | Append the word `BgpFinOpsStack` to the base-stack batch deployment line (line 117) | Installed by default on a from-scratch deployment (decided: out of the box, no second installation step required of the user) | Very low (deployment-list append) |

**Apart from these 4 places, not a single existing file is touched.** In particular: `charts.tsx` zero changes (import only), `lib/incidents/**` zero changes, `lib/alerting/**` zero changes, `lib/baseline/**` zero changes, `dynamodb.ts` zero changes, all existing pages zero changes (the revision-1 design's "append a cost row to the task detail page" is **cut**; run-level detail is viewed only inside the `/finops` page).

### 0.3 New files (all newly created)

```
infra/lib/finops-stack.ts                    # 3 tables (hardened, dataKey encryption)
platform/src/lib/finops/
  constants.ts        # table names / service categories / switches (single source of truth inside the module; the shared TABLES is untouched)
  types.ts            # all types
  pricing.ts          # built-in price list (us-east-1, auditable priceVersion)
  store.ts            # read/write of the 3 tables (in the style of incidents/store.ts)
  collector.ts        # L1: daily cost collection per service from CE (watermark increments + rolling re-collection of the last 3 days)
  attribution.ts      # L3: run-level attribution pure function (engine metering × price list)
  sweep.ts            # pull-mode scanner: read bgp-task-runs from the watermark → attribute run by run (idempotent conditional write)
  anomaly.ts          # anomaly detection (reuses the baseline stats MAD/EWMA) + writes bgp-incidents + pushes through the alerting channels
  advice.ts           # deterministic optimization advice (registry pattern; adding a rule changes one line)
  cost-signature.ts   # cost-event signature normalization (own implementation; the incident signature.ts is not changed)
  __tests__/          # pure-function unit tests for pricing/attribution/anomaly/advice
platform/src/app/api/finops/{overview,collect,tasks,tasks/[taskId],anomalies,detect,budgets,budgets/[id],advice}/route.ts
platform/src/app/finops/page.tsx             # 4-tab page
platform/src/components/finops/*.tsx         # page components (overview cards / ranking table / anomaly list / budget form)
```

### 0.4 Isolation machine gates (run at acceptance; following the "two machine gates" pattern of the [BI report / dashboard builder](./bi-report-dashboard.md))

1. **Diff allow-list gate**: every path in `git diff --name-only` falls within the allow-list {the 4 new directories + the 5 files of section 0.2}, otherwise FAIL.
2. **Dependency-direction gate**: `grep -rn "lib/finops\|components/finops" platform/src --include="*.ts*" | grep -v "^platform/src/\(lib\|app\|components\)/finops\|app/api/finops"` must return nothing (proving that no existing code depends on finops in reverse).
3. **contract-guard**: snapshot before the change, verify after deployment; 30 pages of L1 + 6 contracts (anchor lineage_column=24) with zero regression.

---

## 1. Feature overview and positioning

**Pain point**: the native AWS cost view is "service dimension + T+1 bill" (Cost Explorer can only tell you "Glue cost $1.11 yesterday") and cannot answer the questions data-platform users really ask: **"Which task / which pipeline / which project spent it? Why did it go up this week?"** A leading cloud data-development suite likewise lacks a developer-first, integrated cost view.

**Positioning (a platform moat)**: take cost attribution down to the **task / run level**, and deposit "cost regressions" as a class of **operations events** into the incident knowledge base ([incident memory](./agent-native-operations-incident-memory.md); via the data plane, zero code coupling), extending the compounding loop from "incidents" to "cost". Three layers of view:

| Layer | View | Data source | Freshness |
|---|---|---|---|
| L1 account overview | Full picture of spend per AWS service / day + foundation / engine categorization | Cost Explorer API (verified available) | T+1 |
| L2 engine usage | Usage and converted cost of the four engines (Glue/EMR/Athena/Redshift) | Native engine metering APIs (all verified available) | Near real time |
| L3 task attribution | **Cost per task / per run**, rankings, trends, spike localization | Engine per-run metering × built-in price list, anchored on `bgp-task-runs` (**read-only**) | Near real time (scan watermark) |

### Data-source feasibility (hard evidence measured in a temporary test account on 2026-07-13)

- `ce:GetCostAndUsage` DAILY×SERVICE×USAGE_TYPE ✅ (07-11: MWAA $10.81 / OpenSearch $4.50 / ECS $3.39 / Glue USE1-ETL-DPU-Hour 2.53h=$1.11); **cost allocation tags ❌** (no permission in a linked account) → tag-based attribution is not feasible, which confirms the platform-side attribution route.
- Glue `GetJobRun.DPUSeconds` ✅ (measured 370s×G.1X) · EMR Serverless `GetJobRun.billedResourceUtilization` ✅ (vCPUHour/memoryGBHour/storageGBHour) · Athena `GetQueryExecution.DataScannedInBytes` ✅ · Redshift Serverless `sys_serverless_usage.charged_seconds` ✅ (requires the admin secret, which the platform already uses; measured 51360 RPU-s on 07-11).
- AWS Budgets is limited by the linked account + account rotation → budgets / history retention are entirely built inside the platform (DynamoDB).

---

## 2. User stories

- As a **platform administrator**, I want to see this month's / this week's spend overview at a glance: which part is the platform's standing foundation (MWAA/OpenSearch/ECS/RDS), which part is workload (Glue/EMR/Athena/Redshift), and how it trends.
- As a **data developer**, I want to know **which of my tasks burns the most money**: task cost ranking, cost per run (e.g. "a 9.02-million-row sync costs $0.05 per run").
- As **data operations**, I want an automatic alert when a task's cost **spikes relative to its own history** (e.g. COPY degrading to slow INSERT and doubling DPU), and I want the event **deposited into the incident knowledge base** for the diagnostics agent to learn from.
- As an **architect**, I want budget guardrails (push at 80%/100% of the monthly budget) + deterministic savings advice (idle standing resources / over-provisioning / stoppable but not stopped).

---

## 3. Interaction design (new page `/finops`, menu item "FinOps" under g-ops)

Four tabs (following the three-tab pattern of `/alerting`, with a collapsible `FeatureGuide` explanation at the top — FeatureGuide is a shared component, and importing it does not count as a change):

1. **Cost overview**: month-to-date / yesterday's spend / period-over-period MetricCard + daily service trend TrendArea + foundation / engine share Donut + top services BarList (all imported from the existing `charts.tsx` components, zero changes).
2. **Task costs**: task cost ranking (task / engine / run count / total cost / average per run) + drill into run-level detail (runId / duration / usage / converted cost / priceVersion). Filters: project / engine / time window.
3. **Cost anomalies**: spike detection list (baseline vs actual / deviation multiple / suspected cause); items already deposited into the knowledge base show a link to `/incidents`.
4. **Budgets**: budget CRUD (scope = whole account / service / project, monthly limit, 80%/100% thresholds, channels reused from alerting) + burn progress bar + optimization advice list.

**Data-freshness interaction (replacing a scheduled job; zero new scheduling infrastructure)**: when the page loads and the watermark lags (>6 h), collection is **triggered in the background, fire-and-forget** (following the detached pattern of [GenBI asynchronous execution](./genbi-async-execution.md)); the read path is always a pure read that answers within seconds — learning from the incident-memory lesson where reconcile-on-read was 23× slower, **never do heavy work on the read path**. There is also a manual "Collect now" button. CE data is T+1 and the watermark catches up automatically, so no data is lost even if nobody visits for days.

---

## 4. API design (all within the `app/api/finops/**` namespace)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/finops/overview` | viewer | L1 overview aggregation (pure read of `bgp-cost-daily`, including category subtotals / period-over-period / watermark time) |
| POST | `/api/finops/collect` | editor | Trigger collection (CE rolling last 3 days + sweep task attribution; idempotent conditional writes; detached, returns within seconds) |
| GET | `/api/finops/tasks` | viewer | L3 task cost ranking (time window / project / engine filters, pure read) |
| GET | `/api/finops/tasks/[taskId]` | viewer | Run-level detail + trend of one task (pure read) |
| GET | `/api/finops/anomalies` | viewer | Anomaly list (pure read of detection results + deposit status) |
| POST | `/api/finops/detect` | editor | Trigger anomaly detection + budget evaluation (chained automatically after collection; can also be manual) |
| GET/POST/PUT/DELETE | `/api/finops/budgets` `[id]` | **project owner writes** / viewer reads | Budget CRUD (optimistic lock version). ⚠️ (audit calibration of 2026-08-26) the write permission is not "platform administrator" but the **project owner**: `budgets/route.ts:34` uses `requireProject(req, "owner")` — decided by the project RBAC owner, not by a platform-level admin group |
| GET | `/api/finops/advice` | viewer | List of deterministic optimization advice |

---

## 5. Data model (DynamoDB, 3 new tables, independent `BgpFinOpsStack`, hardened)

| Table | PK / SK | Purpose |
|---|---|---|
| `bgp-cost-daily` | `pk="cost#<yyyy-MM>"` / `sk="<date>#<service>"` | L1 daily cost snapshot per service (amount/usageQty/category); a meta item additionally records the collection watermark |
| `bgp-cost-runs` | `pk="taskcost#<taskId>"` / `sk="<runId>"` | L3 run-level attribution (engine / usage detail / costUsd / priceVersion / startedAt); TTL 180 d; idempotent conditional writes |
| `bgp-budgets` | `pk="budget#<projectId|global>"` / `sk=budgetId` | Budget definition + month-to-date consumption + latest alert state (version optimistic lock; threshold alerts idempotent by dedupeKey) |

The price list is not stored in a table: `lib/finops/pricing.ts` holds built-in us-east-1 unit prices (Glue $0.44/DPU-h, EMR vCPU $0.052624/h + memory $0.0057785/GB-h, Athena $5/TB, Redshift $0.375/RPU-h) with a `priceVersion`, so that every attribution record is auditable; they are compared automatically against the actual CE payment / usage, and a deviation >10% raises a reminder (in the advice list).

---

## 6. Back-end implementation (`lib/finops/`, entirely inside the module)

### 6.1 Collector collector.ts (L1)
`collectDailyCosts()`: CE GetCostAndUsage with rolling re-collection of the last 3 days (covering late-arriving bills) → service categorization (foundation / engine / other; constants.ts is the single source of truth) → idempotent upsert into `bgp-cost-daily` + advance the watermark. Triggers: detached on page stale detection + the manual button (see §3; no MWAA DAG is built — zero new scheduling infrastructure; if unattended alerting is needed later, it is added as a standalone DAG file that likewise touches no existing code).

### 6.2 Attribution sweep sweep.ts + attribution.ts (L3, pull mode, zero hooks)
- `sweepTaskCosts()`: from the watermark, **read-only scan** `bgp-task-runs` (finishedAt > watermark, bounded pagination) + the EMR run record → for every terminal run, fetch the metering by engine (Glue GetJobRun / EMR GetJobRun / Athena GetQueryExecution) → the `attribution.ts` pure function converts it to cost → **conditional write** into `bgp-cost-runs` (attribute_not_exists, idempotent; a repeated sweep does not double-count) → advance the watermark.
- Precise attribution in the first phase: **Glue** (sync + ETL, DPUSeconds) / **EMR Serverless** (billedResourceUtilization) / **Athena** (DataScannedInBytes). **Redshift in the first phase gets workgroup-level daily cost only** (daily aggregation of sys_serverless_usage into the overview; the admin secret goes through the existing read path); approximate query-level apportionment is explicitly left to phase 2 — an approximation must not pose as a precise value.
  <br>⚠️ (audit calibration of 2026-08-26) differs from the implementation: ① **Athena run-level attribution is not implemented** — `fetchUsage` in `sweep.ts` handles only the **Glue + EMR Serverless** engine branches, and everything else (including Athena) is `return null` (sweep.ts:36-62); there is no `GetQueryExecution`/`DataScannedInBytes` attribution; ② **the Redshift `sys_serverless_usage` daily aggregation is not implemented** — the whole finops module has no occurrence of `sys_serverless_usage`; the overview's Redshift cost comes from **Cost Explorer dimension categorization** (collector.ts), not from querying the Redshift system view.
- Historical backfill: `POST /api/finops/collect?backfill=1` turns the watermark back 30 days and rescans (idempotent; runs already recorded are skipped by the conditional write).

### 6.3 Anomaly detection anomaly.ts + the incident-memory data-plane loop
- Reuses **`lib/baseline/stats.ts` of the [baseline / SLA design](./agent-native-operations-baseline-sla.md)** (imports pure functions, zero changes): a task's single-run cost deviating from its own baseline by > k×MAD (k=3) with ≥7 samples → anomaly; the same for daily service cost (relative to the last 30 days). Cold-start lowConfidence does not report; runs with `triggeredBy=backfill` are excluded from the baseline (a hard constraint of the baseline design).
- Confirmed anomaly → ① import the alerting `dispatch` to push (dedupeKey=`cost#<scope>#<date>`, idempotent; writes `bgp-alert-events` with the existing alerting helper);
  - ② the **own `cost-signature.ts`** normalizes the signature (task + engine + anomaly-class dimensions) and directly calls the incident store's `upsertMaster`/`putOccurrenceIfNew` to write `bgp-incidents` (engine field = the real engine, title = a masked symptom template, inheriting the "never store table names / paths / secrets" red line) → naturally visible on the `/incidents` page and in diagnostics grounding, with **zero changes to `lib/incidents/`**.
- Budget evaluation: runs alongside detect; exceeding the 80%/100% thresholds pushes through the alerting channels (dedupeKey=`budget#<id>#<month>#<threshold>`, once per month per tier).

### 6.4 Optimization advice advice.ts (deterministic rule registry; AI not involved)
First-phase rules (each = detection function + copy + estimated monthly saving, following the detector SPI pattern of [governance deepening](./governance-deepening.md)): idle standing resources (a DMS instance with no running task / Flink RUNNING for more than N days) · over-provisioning (actual Glue/EMR usage <30% of what was requested) · known degradation (SYNC_DEGRADED records in task-runs) · price-list deviation reminder (§5). **AI interpretation is left to phase 2** (following option A of the incident-memory design's AI-interpretation section: reuse the existing chain, no new AgentCore Runtime).

---

## 7. AWS service dependencies and IAM

- New read-only permissions: `ce:GetCostAndUsage` (+ optional `ce:GetCostForecast`) — a **purely appended** independent ManagedPolicy block inside platform-stack (section 0.2); the Glue/EMR/Athena run query permissions already exist, and the Redshift admin-secret read path already exists.
- `BgpFinOpsStack`: 3 DynamoDB tables (hardened, dataKey); deployment order = FinOpsStack first, then PlatformStack.
- **Zero new standing cost**; CE is a control-plane API, keeps the network-privacy red line, and adds no new external surface.

---

## 8. Security considerations

- Cost data is visible inside the platform: the overview / budgets are written by administrators + operations, viewers read only; task costs follow project RBAC (`requireProject`).
- No hard-coded secrets / account ids (the admin secret goes through the existing Secrets Manager path; the account id is obtained at run time via STS).
- Collection / detection / accounting are all idempotent (conditional writes), preventing refresh storms; alert dedupeKey idempotency; writing `bgp-incidents` inherits the masking red line.

---

## 9. Acceptance criteria (real headless web verification; contract-guard once before and once after)

- [ ] **All 3 isolation machine gates pass** (section 0.4: diff allow-list / dependency direction / contract-guard zero regression) — the first-priority acceptance item of this module.
- [ ] **L1 overview truth**: yesterday's total on `/finops` matches an independent `aws ce get-cost-and-usage` query (±$0.01); categorization correct (MWAA = foundation, Glue = engine).
- [ ] **L3 attribution hard evidence**: rerun an EMR job (dim_channel) → after the sweep, `bgp-cost-runs` contains that runId with cost = billedResourceUtilization × unit price (checked by hand); the ranking includes the real tasks of the game verification dataset (the 9.02-million-row player_events sync, 3 EMR jobs).
- [ ] **Backfill**: after backfill, the completed Glue/EMR runs of the last 30 days have cost records; a repeated backfill produces no duplicate rows (hard evidence of conditional writes).
- [ ] **Anomaly → knowledge-base loop hard evidence**: construct a cost spike (rerun with 10 workers a Glue job that normally runs with 2) → detection hits (correct multiple) → exactly one item in the alerting self-test sink → a cost event appears in `bgp-incidents` → visible on the `/incidents` page (zero diff in `lib/incidents` throughout).
- [ ] **Budget guardrail**: set a monthly budget below the current consumption → the 100% alert arrives at the self-test sink; a repeated detect does not push again.
- [ ] **Optimization advice**: the corresponding advice appears for known facts (such as a stopped DMS instance).
- [ ] **Read-path performance**: the overview/tasks endpoints are pure reads <100 ms (no reconcile-on-read, learning from the incident-memory phase-2 lesson).
- [ ] **Unit tests**: pricing conversion / attribution / anomaly (a large backfill run does not pollute the baseline) / budget thresholds / cost-signature normalization.

---

## 10. Implementation order (start after confirmation, commit step by step)

1. **contract-guard snapshot** (mandatory; the baseline before the change).
2. **infra**: `finops-stack.ts` + unconditional assembly in `bin/app.ts` + the platform-stack ManagedPolicy block + the deploy-all.sh list line → deploy FinOpsStack (independent stack, touches no other stack).
3. **lib/finops core + unit tests** (the constants/types/pricing/store/attribution/cost-signature pure functions first; write collector/sweep/anomaly/advice after the unit tests pass).
4. **API routes** (9 endpoints).
5. **Page + i18n** (page.tsx + components/finops + en.ts entries + the routes.tsx menu line).
6. **Deploy PlatformStack** → backfill → the 9 headless acceptance items → the 3 isolation machine gates → contract-guard verify → commit + push after each verified block.

## 11. Explicitly excluded (first phase)

- ❌ Immediate hook accounting on reaching a terminal state (the revision-1 approach; it intrudes on 4 state machines and violates the isolation red line — replaced by pull mode).
- ❌ Appending cost display to existing task detail pages (the revision-1 approach; it would change existing pages — run-level detail is gathered into the `/finops` page).
- ❌ Precise query-level Redshift attribution (approximate apportionment left to phase 2).
- ❌ AWS Budgets / cost allocation tags (no permission in a linked account; built inside the platform).
- ❌ A FinOps AgentCore Runtime / AI interpretation (left to phase 2, and then following option A of the incident-memory design to reuse the existing chain).
- ❌ An MWAA collection DAG (the page stale trigger + manual button already cover it; add it when an unattended alerting need arises, again without touching existing code).
