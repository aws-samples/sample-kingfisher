# Design — Intelligent Operations / Unified Alerting Center / Ops Dashboard

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is summarized in the [modules overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> - Revision: 1.0 (draft) | Created: 2026-07-04 | Capability groups: intelligent baseline / SLA / data-interruption detection + ops dashboard / unified alerting center
> - Dependent blueprint: [production hardening design](./production-hardening.md), work stream WS6 (alerting center + ops dashboard, already detailed there)
> - Reuse: run ledger `bgp-task-runs` · hand-drawn SVG charts `components/dashboard/charts.tsx` · AI diagnosis ([fault diagnosis design](./devops-agent-diagnostics.md)) · MWAA scheduling
> - **This document is the authoritative design for intelligent operations and alerting; read it before starting work. On completion, write the results back to section 3 of the capability roadmap of 2026-08 (a historical document that is not part of this repository).**

---

## 1. Goals and scope

**North star**: upgrade the platform from "passively watching a monitoring list" to "**proactive operations**" — when a task has a problem, it is pushed proactively to IM / e-mail, and one ops dashboard shows the health of the whole platform at a glance. Benchmarked against the "operations center + alerting" of a leading cloud data-development suite.

### First-phase scope (this module, revision 1.0; decided: the ops dashboard / alerting center group comes first)
- **Unified alerting center**: alert rules (failure / timeout / success-rate threshold / data interruption) + multi-channel notification (DingTalk / WeCom webhook / e-mail) + severity levels (P1/P2/P3) + silencing / de-duplication + an alert event stream.
- **Ops dashboard `/ops`**: real-time task state + N-day trend + top slow tasks + Gantt / timeline + recent alerts + on-time-rate / success-rate cards; dark large-screen layout, auto refresh.
- **AI enrichment (the differentiating moat)**: when an alert hits a task failure, attach the existing AI diagnosis ([fault diagnosis design](./devops-agent-diagnostics.md)) with one click (or automatically), and carry the diagnosis summary in the notification — a capability the benchmark suite does not have.

### Explicitly out of scope (second phase, see section 16)
- Intelligent-baseline dynamic learning / data-interruption prediction (ML), SLO multi-window burn-rate alerts, SNS → SMS / phone (P1). In the first phase, "data interruption" is covered **rule-based** (no run within the expected period) and no prediction is done.
- Upgrading the DevOps diagnosis agent to the AgentCore standard (a separate initiative, see section 16).

---

## 2. Current-state inventory (conclusions of two rounds of code exploration)

| Capability | Current state | Reuse / build new |
|---|---|---|
| Run ledger `bgp-task-runs` (shared by all task types; has startedAt/finishedAt/duration/status/error/metrics) | ✅ strong | **Reuse** (data source for the dashboard / Gantt) |
| Monitor page `/monitor` + `api/monitor/runs` (6 KPIs + table + reconcile-on-read) | ✅ strong | Reuse + extract a shared query |
| Hand-drawn SVG charts Donut/TrendArea/BarList (zero dependencies, hover, CSS-variable theming) | ✅ | **Reuse** for dashboard cards |
| AI diagnosis ([fault diagnosis design](./devops-agent-diagnostics.md), `lib/diagnostics/`, in-process Bedrock call) | ✅ | **Reuse** as alert enrichment |
| Scheduling (MWAA cron + dependency trigger; cronExpression stored on the resource row) | ✅ | Reuse (the "expected period" for interruption / on-time judgment) |
| Quality freshness SLA ([quality rules design](./quality-rules-scoring-sla.md), freshness only) | 🟡 narrow | Extend the concept to a run-SLA |
| **Alerting / notification layer (SNS / e-mail / IM webhook)** | ❌ none | **Build new** `lib/alerting/` |
| **Alert rule / event tables** | ❌ none | **Build new**, 3 tables |
| **Gantt / timeline · `/ops` dashboard · SLO view** | ❌ none | **Build new** |

**Conclusion**: the data plane (run ledger) exists, the chart engine exists, AI diagnosis exists; new construction is concentrated in the **alerting layer + dashboard page**, so the risk is controllable.

---

## 3. Architecture overview

```text
                            ┌──────────────────────────────────────────────────────┐
   Task run final state     │  Alert engine  lib/alerting/evaluate.ts               │
   (bgp-task-runs)    ──▶   │  · watermark scan of recent final-state runs          │
   MWAA cron / dependency   │    (idempotent: ruleId#runId)                         │
                            │  · match rules (failure / timeout / success rate /    │
                            │    no-run)                                            │
                            │  · hit → write event + trigger notification           │
                            │    (+ optional AI diagnosis)                          │
                            └───────────────────────┬──────────────────────────────┘
                                                    │
                      ┌─────────────────────────────┼─────────────────────────────┐
                      ▼                             ▼                             ▼
       Channel: DingTalk webhook       Channel: WeCom webhook          Channel: e-mail (SES)
       (HMAC signature)                (direct post)                   (sender must be verified)
                      │                             │                             │
                      └──────────► bgp-alert-events (delivery result per channel) ◄┘
                                                    │
   ┌────────────────────────────────────────────────┼────────────────────────────────────────┐
   ▼                                                ▼                                        ▼
 Alerting Center /alerting                   Ops Dashboard /ops                      Task Monitor /monitor (existing)
 (rules / channels / events, three tabs)     (read-only dashboard, reuses charts     (adds a "related alerts" entry)
                                              + new Gantt)
```

**Trigger modes (first phase, idempotent design)**:
- (a) **Evaluate on auto refresh of the dashboard / alerting page** (reusing the 5s/10s/30s polling mode of the monitor; the front end triggers `POST api/alerting/evaluate`);
- (b) a manual **"Evaluate now"** button;
- (c) reserved (second phase): a scheduled MWAA DAG / periodic EventBridge trigger, to reach unattended operation.

> 📌 Calibration (2026-11-11): (a) was never wired; (c) is implemented by an **in-process evaluation pump** — the leader replica of the platform service loops back to `POST /api/internal/alerting/tick` once per minute for every project (rule evaluation goes through the same function as "Evaluate now"; the same round also rolls the breach prediction of enabled SLAs' in-flight runs forward), without a separate MWAA / EventBridge trigger.
> The engine is **idempotent**: the event de-duplication key = `ruleId#runId` (or the interruption-window key); triggering several times never alerts twice. The watermark `lastEvaluatedAt` is stored on the rule row, and only final-state runs after the watermark are examined.

---

## 4. Data model (DynamoDB, 3 new tables)

Reuses the `hardened` option of `database-stack.ts` (CMK encryption / PITR / RETAIN). All three hold low-frequency, low-volume configuration data: single logical partition + ULID sort key, isomorphic with `bgp-metrics` / `bgp-approvals`.

| Table | PK / SK | Purpose | Notes |
|---|---|---|---|
| `bgp-alert-rules` | `pk="alertrule"` / `ruleId` (ULID) | Alert rules | `projectId` as an attribute filter; `version` for optimistic locking |
| `bgp-alert-channels` | `pk="alertchannel"` / `channelId` (ULID) | Notification channel configuration | webhook URL / secret (**runtime data, stored CMK-encrypted, never hard-coded in code**) |
| `bgp-alert-events` | `ruleId` / `sk="<ts-iso>#<ulid>"` | Alert event stream | **TTL 90d** (`ttl` attribute); naturally spread by ruleId |

> Consistent with the WS6 blueprint (`bgp-alert-rules` / `bgp-alert-events`), **plus `bgp-alert-channels`** so that several rules can share one channel (otherwise every rule would re-enter the webhook). If 3 tables feel like too many, the channel could be embedded in the rule (down to 2 tables) — this design chooses 3 tables (channel reuse is worth a lot).

**Key fields of a rule row (`bgp-alert-rules`)**:
```text
ruleId, name, projectId, enabled, version,
scope: { taskType?: "sync"|"etl"|"emr-serverless"|"workflow"|"flink"|"all", taskId?: string },
condition: {
  type: "failure"          // alert as soon as the task fails
      | "timeout"          // run duration > thresholdMinutes
      | "success-rate"     // rolling-window success rate < thresholdPercent
      | "no-run",          // interruption: no successful run within the expected period (cron) for > windowMinutes
  thresholdMinutes?, thresholdPercent?, windowMinutes?
},
severity: "P1"|"P2"|"P3",
channelIds: string[],       // which channels to notify on a hit
enrichWithDiagnosis: boolean,  // whether failure-type rules attach an AI diagnosis automatically
silenced: boolean, silenceUntil?: string,   // silencing
lastEvaluatedAt: string,    // watermark
createdAt, updatedAt, createdBy
```

**Key fields of an event row (`bgp-alert-events`)**:
```text
ruleId, sk, eventId, ruleName, severity, projectId,
status: "firing"|"notified"|"partial"|"failed"|"resolved",
dedupeKey: "ruleId#runId" | "ruleId#window#<bucket>",
trigger: { taskId, taskName, runId, taskType, metricValue },
message,
diagnosisId?,                // present when an AI diagnosis was attached
channelResults: [{ channelId, channelType, ok, httpStatus, error, at }],
createdAt, ttl
```

---

## 5. Alert engine `lib/alerting/`

```text
platform/src/lib/alerting/
├── types.ts        # AlertRule / AlertChannel / AlertEvent / Condition types (single source of truth)
├── rules.ts        # rule CRUD (optimistic lock on version)
├── channels.ts     # channel CRUD + "send test" (synchronous delivery, returns the HTTP result)
├── events.ts       # event write / query (Query by ruleId, descending)
├── evaluate.ts     # engine core: watermark scan → match → write event → trigger notification (idempotent)
├── notify.ts       # dispatch orchestration (iterate channelIds, aggregate channelResults)
└── channels/
    ├── dingtalk.ts # DingTalk group-robot webhook + HMAC-SHA256 signing (timestamp&sign)
    ├── wecom.ts    # WeCom group-robot webhook (direct markdown post)
    ├── email.ts    # SES SendEmail (sender / recipient must be verified; mind the sandbox)
    └── generic.ts  # generic JSON webhook (POST to any endpoint, including the platform's own self-test sink)
```

**Matching logic (evaluate.ts)**:
1. Read all rules with `enabled && !silenced`;
2. For `failure` / `timeout` rules: query final-state runs after the watermark (reusing the monitor query) and judge each one by scope + condition;
3. For `success-rate` rules: compute the rolling-window success rate within the scope; for `no-run` rules: check whether the most recent successful run within the scope is older than the window (combined with the cron expectation);
4. On a hit whose `dedupeKey` does not yet exist → write a firing event → `notify()` → update channelResults / status;
5. Update the rule's `lastEvaluatedAt` watermark.
> **Idempotency iron rule**: before writing an event, check for duplicates by `dedupeKey` (conditional write `attribute_not_exists`) so that duplicate alerts are impossible.

**AI enrichment**: when `enrichWithDiagnosis && condition=failure`, call `startDiagnosis()` of the existing `lib/diagnostics/service.ts`, write the `diagnosticId` into the event, and carry the diagnosis summary / link in the notification text. **Nothing new is built; the fault diagnosis capability is reused as is.**

**Self-test loop (verifiable headlessly)**: channels support "Send test" — a `generic` channel pointing at the platform's own `api/alerting/test-sink` (which only records the received payload) verifies "rule hit → delivery → sink received" end to end **without connecting a real DingTalk / WeCom account**. Real DingTalk / WeCom webhooks remain an optional real chain.

---

## 6. Channel adapter notes

- **DingTalk**: group-robot webhook + signing (`timestamp` + `HMAC-SHA256(secret)` → base64 → urlencode, appended as `&sign=`). The secret is entered by the user in the UI and stored CMK-encrypted in DDB.
- **WeCom**: group-robot webhook, direct post with `msgtype=markdown`, no signature required.
- **E-mail**: SES `SendEmailCommand`. **Sandbox restriction**: sender / recipient must be verified first; in the first phase e-mail is marked "identity verification required on the account side", and the demo focuses on webhooks. IAM gets a separate ManagedPolicy (`ses:SendEmail`).
- **Generic webhook**: POST JSON, for the self-test sink and any IM.
- Every channel has a 3s timeout + one retry; failures are written into `channelResults` (without blocking the other channels).

---

## 7. Ops Dashboard `/ops` (read-only, dark large screen)

**Layout**: grid of cards, auto refresh (reusing the monitor polling), dark theme (reusing the theming CSS variables), fit for projection.

| Card | Data | Component |
|---|---|---|
| Real-time task state | running / succeeded today / failed | Reuse `Donut` + KPI |
| 7-day run trend | aggregated per day | Reuse `TrendArea` |
| Top slow tasks | Top N by duration | Reuse `BarList` |
| Success rate / on-time rate | rolling window | **New** `Gauge` (hand-drawn SVG ring gauge) |
| **Gantt / timeline** | start~finish of recent runs | **New** `GanttTimeline` (hand-drawn SVG, zero dependencies, same style as the existing charts) |
| Recent alerts | latest N rows of `bgp-alert-events` | List (severity color coding) |

> The new `Gauge` / `GanttTimeline` are added to `charts.tsx` (continuing the zero-dependency hand-drawn + CSS-variable + hover conventions; independent signatures that do not affect the three existing components).

---

## 8. Alerting Center `/alerting` (management console, three tabs)

- **Rules** tab: list + create / edit (scope / condition / severity / multi-select channels / silencing / AI-enrichment switch) + enable / disable + Evaluate now.
- **Channels** tab: list + create (type / webhook URL / secret / recipients) + **Send test** (immediate HTTP result, verifiable headlessly).
- **Events** tab: alert event stream (filter by time / severity / rule); open an event to see channelResults + the related AI diagnosis.

Menu: under the `g-ops` (Scheduling & Ops) group of `routes.tsx`, add **Alerting Center `/alerting`** + **Ops Dashboard `/ops`** (alongside the existing Scheduling / Task Monitor / Observability entries).

---

## 9. API route list

```text
api/alerting/rules            GET list / POST create
api/alerting/rules/[id]       GET / PUT (optimistic lock) / DELETE
api/alerting/channels         GET / POST
api/alerting/channels/[id]    GET / PUT / DELETE
api/alerting/channels/[id]/test   POST send test
api/alerting/events           GET event stream (filters)
api/alerting/evaluate         POST trigger one evaluation (idempotent)
api/alerting/test-sink        POST self-test collection endpoint (records only; for generic-channel self-verification)
api/ops/summary               GET dashboard aggregate (task state / trend / top slow / on-time rate / Gantt data / recent alerts)
```
> `api/ops/summary` reuses the existing task-runs query in the first phase (a Scan is enough at demo volume); **at scale a GSI (byTime) is needed**, listed for the second phase (see section 16). Uses `apiOk/apiError` (lib/api-response).

---

## 10. CDK / IAM increments

- **Tables**: `database-stack.ts` adds 3 tables (the events table with `timeToLiveAttribute:"ttl"`). PAY_PER_REQUEST, zero standing cost.
- **IAM**: a new separate `ManagedPolicy` (red line: **`taskRole.addToPolicy` is forbidden; the TaskRole has a 10KB limit**) — containing `ses:SendEmail` (e-mail channel) + `cloudwatch:GetMetricData` (on-time-rate / SLO reads, if needed). DingTalk / WeCom / generic go out through `fetch` and need no IAM.
- **env**: `platform-stack.ts` injects the 3 table names (if the code uses constants, changing the `TABLES` constant in `dynamodb.ts` is enough; most table names are hard-coded in the TABLES constant, so no stack env change is needed).
- **No new gated stack**: the first phase does not introduce SNS (SNS e-mail requires manual subscription confirmation, which is bad for a headless demo; SMS / phone are left for the second phase), so **no new `alerting-stack.ts` is created** — a pragmatic simplification of the WS6 blueprint; SNS is listed for the second phase.
- **Outbound network**: webhook egress goes through the NAT of the private subnets where the platform ECS runs (already exists), in line with the "only the web tier is public, compute is private" red line (the platform makes outbound calls; no port is exposed).

---

## 11. i18n (red line: every new Chinese UI string must be added to the dictionary)

All Chinese strings in new pages / components are wrapped in `t("...")`; run `node platform/scripts/i18n-extract.mjs --missing` → add the entries by hand to `lib/i18n/messages/en.ts` → extract again to confirm 0 missing. **Alert message bodies (business data) are not translated**; UI chrome is. Blind spots of the extractor (constants such as condition.label) are added by hand.

---

## 12. Red-line compliance & cost

- ✅ Only `--profile temp-account`; no hard-coded secrets (the webhook secret is user input at runtime, stored CMK-encrypted in DDB, not in code).
- ✅ Every new feature is tested headlessly (section 14); no unauthorized push; communication in Chinese; Bash commands in pure ASCII.
- ✅ **Cost**: 3 PAY_PER_REQUEST tables + no standing compute + no SNS / no new stack = near-zero additional standing charges. Evaluation is triggered by front-end polling (no standing worker).
- ✅ Three-way consistent acceptance (AWS side + platform behavior + what landed in the bucket / table).

---

## 13. Implementation steps (phased; each step verifiable on its own)

1. **Data layer**: `dynamodb.ts` TABLES + `database-stack.ts` 3 tables; `lib/alerting/types.ts`.
2. **Alert engine + channels**: rules/channels/events/evaluate/notify + channels/* (generic + dingtalk + wecom first, email next).
3. **API**: alerting/* + ops/summary + test-sink.
4. **Management console `/alerting`**: three-tab UI + menu.
5. **Dashboard `/ops`**: new `Gauge` / `GanttTimeline` + dashboard page + menu.
6. **AI enrichment**: evaluate attaches `startDiagnosis()`; events / notifications carry the diagnosis.
7. **i18n**: complete all entries, 0 missing.
8. **Deploy** (temporary account; two-way consistency: CFN UPDATE_COMPLETE + ECS rolloutState COMPLETED) → **headless acceptance** → write back to the roadmap → commit (for review).

---

## 14. Acceptance checklist (headless browser, every feature, nothing skipped)

1. Create a channel (generic pointing at test-sink) → "Send test" → the page shows HTTP 200 + test-sink records the payload.
2. Create a rule (scope = a task type, condition = failure, select that channel, enable AI enrichment) → cause one task failure → "Evaluate now" → `bgp-alert-events` gets a firing event + test-sink receives it + the event carries a diagnosisId.
3. **Idempotency**: click "Evaluate now" twice in a row → the same run produces only one event (no duplicate alert).
4. Silence the rule → evaluation produces no event.
5. Cause one hit each for a `success-rate` and a `no-run` rule.
6. `/ops` dashboard: the six cards — task state / trend / top slow / Gantt / on-time rate / recent alerts — render, auto refresh works, dark projection looks right.
7. i18n: in English mode the whole page has 0 residual Chinese (business data excepted); Chinese regression.
8. DingTalk / WeCom (if a real webhook is available) receive one message over the real chain (optional).

> Scheduled / periodic items "run twice then stop"; evaluations triggered by tests leave nothing standing, so no cleanup is needed.

---

## 15. Key design trade-offs (for reference)

- **Why not SNS**: SNS e-mail subscriptions need manual confirmation (anti-headless); SMS / phone are P1 and left for the second phase; in the first phase, posting directly to webhooks / SES is simpler and fully verifiable headlessly. SNS becomes a second-phase item (P1 phone / SMS + DLQ replay).
- **Why front-end polling triggers evaluation instead of a standing worker**: zero standing cost, headlessly verifiable, enough for demos; unattended operation (scheduled MWAA / EventBridge) is listed for the second phase.
- **Why query task-runs directly instead of a GSI**: a Scan is enough at demo volume; a production-grade real-time dashboard adds a `byTime` GSI (second phase).
- **Why the third table `bgp-alert-channels`**: channels are reused across rules (otherwise every rule re-enters webhook + secret).

---

## 16. Second-phase outlook (intelligent baseline + production grade)

- **Intelligent baseline / SLA on-time rate / interruption prediction**: upgrade from rule-based to dynamically learned baselines (historical P50/P90 define the "expected completion time"; alert on deviation); SLO multi-window burn rate (to avoid alert storms).
- **SNS alerting stack**: `alerting-stack.ts` + SNS (SMS / phone, P1) + EventBridge → SQS (DLQ) asynchronous replay.
- **Real-time dashboard**: task-runs `byTime` GSI + pagination cursor + optional embedded CloudWatch Dashboard.
- **Unattended operation**: scheduled MWAA DAG / periodic EventBridge evaluation.
- **Upgrading DevOps diagnosis to AgentCore** (a separate initiative): today it wraps the AWS-managed `aidevops` service (not an in-process Bedrock call).
  - The upgrade = rewrite the diagnosis as a Bedrock Converse tool-use loop → the fourth AgentCore capability (Gateway + Runtime + Memory): clone `infra/agent/paramadvisor/` + `paramadvisor-agentcore-stack.ts` + a two-pass deployment with `-c devopsdiag-runtime=1` + a `bgp-devopsdiag-turns` memory table.
  - **The protocol layer is copy-paste (low effort)**; **the business layer is real work**: refactor the single managed-service call into a Converse loop + stateless evidence tools (reusing the multi-engine evidence gathering of `evidence.ts` — the largest reusable asset);
  - the existing `devops-agent.ts` + `service.ts` orchestration is demoted to the in-process fallback (the degradation-fallback iron rule, rule ② of section 7 of the [AgentCore standard design](./agentcore-standard.md)).
  - The TaskRole is unchanged (InvokeAgentRuntime + Memory + marketplace already granted);
  - the `aidevops` service-linked role + authorization of the managed service can be cleaned up at that point.
