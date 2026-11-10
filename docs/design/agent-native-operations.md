# Agent-Native moat (incident knowledge base + intelligent baselines / SLA prediction + production-grade backfill)

> - 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior —
>   place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is summarized in the [modules overview](../modules.md). A path mentioned
>   in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.
> - ⚠️ **Implementation differences**: `infra/agent/devopsdiag` was not implemented; the operations diagnosis agent runs inside the platform process at `platform/src/lib/diagnostics/devops-agent.ts` (API `platform/src/app/api/diagnostics/`). The Backfill Center (Part C) was implemented as the
>   `/backfill` page plus `platform/src/lib/backfill/`.

> - Revision: 1.0 **✅ A / B / C all implemented (the AgentCore upgrade item of Part A was not adopted)** (documentation audit calibration of 2026-08-26: the original status header was out of date) | Created: 2026-07-12 | Capability groups: backfill + intelligent baselines / SLA / stall prediction +
>   diagnosis agent upgraded to AgentCore + governance compounding
> - Blueprints this design depends on: [fault diagnosis with AWS DevOps Agent](./devops-agent-diagnostics.md) · [AgentCore standard](./agentcore-standard.md) · [Alerting Center / Ops Dashboard](./intelligent-ops-alerting.md) · engine SPI / EMR (part A of the [multi-engine nodes
>   design](./multi-engine-nodes.md)) · GenBI semantic layer ([GenBI](./genbi.md) / [AgentCore GenBI](./agentcore-genbi.md))
> - Reuse: run ledger `bgp-task-runs` · diagnosis records `bgp-diagnostics` · alerting engine `lib/alerting/` · engine SPI `lib/engines/` · business definitions `bgp-genbi-context` · MWAA scheduling · hand-drawn SVG charts `charts.tsx`
> - **This document is the authoritative master design of the agent-native operations module. Three sub-designs: [incident knowledge base + diagnosis upgraded to AgentCore](./agent-native-operations-incident-memory.md) (Part A), [intelligent baselines / SLA
>   prediction](./agent-native-operations-baseline-sla.md) (Part B), [production-grade backfill](./agent-native-operations-backfill.md) (Part C). Read this document first before starting work.**
>
> - ⚠️ **Red lines (inherited from the global constraints)**: ① use only `--profile temp-account`; ② no hard-coded secrets (channels / credentials go through runtime encrypted storage); ③ never push without authorization; ④ run `contract-guard snapshot` before changing any platform code and
>   `verify` after deployment; ⑤ every capability must be verified by headless-browser or real calls.
> - ⚠️ **Isolation of this module from in-flight development**: the agent-native operations module is **purely additive** — new directories `lib/{incidents,baseline,backfill}/`, new tables, new pages, new API segments. **It does not rewrite any existing file of the fault-diagnosis, alerting or
>   multi-engine modules**; it reuses their exported functions only by "reading / calling" them. It can therefore be developed and deployed in parallel with other development sessions, with zero file conflicts.

---

## 0. Why these three: the strategy in one sentence

By platform revision 1.29 and later, the breadth of features already covers more than half of the main chain of a leading cloud data-development suite (25+ pages, seven capability groups). But **breadth is not a moat; breadth is a liability** — it is exactly the direction that Amazon SageMaker Unified Studio is converging on, and it is the part that a skilled team using AI-assisted coding can most easily replicate.

There is only one kind of thing that is truly "hard to overtake in a short time": **a capability that compounds as customers use it and that grows on a data asset nobody else has**. Measured against that standard, the existing platform already contains two raw materials nobody else has; they simply have not been treated as the protagonists:

1. **Semantic layer + business definitions** (`bgp-genbi-context`, the [GenBI](./genbi.md) and [AgentCore GenBI](./agentcore-genbi.md) modules) — already grounding GenBI's SQL generation;
2. **AI fault diagnosis** (`bgp-diagnostics`, the [fault-diagnosis module](./devops-agent-diagnostics.md)) — every failure produces a structured RCA, but it is **used once and thrown away: never accumulated, never reused, never fed back to the agent**.

What the agent-native operations module does is to connect these two raw materials into a **compounding closed loop** and to fill in the two execution / prediction links the loop is missing. The leading cloud data-development suite has a copilot (it only generates code and does not understand governance definitions); AWS DevOps Agent understands infrastructure (but not data-pipeline semantics) — **"a data platform where every output is grounded by governance semantics, that learns from its own failure history, that proactively predicts SLA breaches, and that repairs with one-click backfill"** — neither that vendor nor AWS is telling this story today, and it happens to grow on the skeleton you have already built. Copying 25 pages takes somebody else only a few months; what cannot be copied is the **incident knowledge base** this loop accumulates every day and that compounds with each customer.

---

## 1. The compounding loop (the organizing principle of the agent-native operations module)

```text
   ┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
   │                                        Compounding Loop                                                  │
   └──────────────────────────────────────────────────────────────────────────────────────────────────────────┘

  Run final state          Alert hit                 AI diagnosis               [Part A, new]
  bgp-task-runs   ──▶   lib/alerting      ──▶   lib/diagnostics      ──▶  persisted as a structured incident
  (existing)            (alerting module,         (fault-diagnosis            bgp-incidents
                         existing)                 module, existing)          symptom · root cause · fix · verification
                                                                                     │
        ┌────────────────────────────────────────────────────────────────────────────┘
        │  Signature merge → recurrence count of the same failure class ↑ + verified (symptom → fix) pairs accumulate
        ▼
  [Part A, new] Diagnosis agent upgraded to the AgentCore standard
   Independent Gateway + Runtime + Memory (copied from the AgentCore standard), new MCP skills:
     · lookup_incident_history(signature)  ← look up this deployment's historical "verified fixes"
     · lookup_business_context(...)        ← reuse the GenBI semantic layer (semantic retrieval)
   ⇒ the diagnosis prompt goes from "evidence gathering with zero context" to "this is how this customer fixed it last time"
     ⇒ more accurate RCA, shorter MTTR
        │
        │ if the fix action suggested by the diagnosis is "recompute X for 07-08 ~ 07-10"
        ▼
  [Part C, new] Production-grade backfill  ◀── doubles as the "fix-action executor" (start a backfill from the diagnosis in one click)
   Bulk backfill instances (date × node) + dependency-chain backfill + concurrency / online isolation + retry of failures + progress matrix
        │
        │ backfill completes → writes "fix verified" back to bgp-incidents → the loop thickens the knowledge base
        ▼
  [Part B, new] Intelligent baselines / SLA prediction (phase two of stall prediction)  ◀── independent branch feeding the dashboard and alerting
   Learn dynamic baselines from historical runs (p50 / p90 / EWMA) + critical-path ETA → predict SLA breaches **in advance**
   (the signature "baseline early warning" of a leading cloud data-development suite: alert before the breach, not after)
   + multi-window burn rate to reduce false positives
        │
        └──▶ reuse the alerting module's channel dispatch for push + a new "Breach predicted" card on the dashboard

  ┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
  │ Compounding point: for every day a customer runs, bgp-incidents holds more "verified fix pairs" → the agent  │
  │ understands this customer's pipelines better; a competitor gets an empty framework, its knowledge base      │
  │ starts at zero and cannot catch up. This is the DataOps version of the "data flywheel".                      │
  └──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Sub-module map and status

| Sub-module | Capability (roadmap group) | Roadmap status | Delivered by this design | Priority |
|---|---|---|---|---|
| **Part A: incident knowledge base + diagnosis upgraded to AgentCore** | diagnosis agent on AgentCore + governance compounding | Fault-diagnosis module: "AI diagnosis of task failures; **not yet on the AgentCore standard**", and diagnoses are not accumulated | `bgp-incidents` table + signature merge + verified fix pairs + diagnosis agent upgraded to AgentCore + `lookup_incident_history` skill | **P0** (core of the moat) |
| **Part B: intelligent baselines / SLA prediction** | phase two of intelligent baselines / SLA / stall prediction | Alerting module: "first phase is rule-based stall detection + fixed thresholds; **dynamic baseline learning / SLA prediction / multi-window burn rate are left for phase two**" | `lib/baseline/` dynamic baseline learning + critical-path ETA breach prediction + multi-window burn rate + learner DAG | **P1** |
| **Part C: production-grade backfill** | backfill | Roadmap: "ETL-job level; **missing bulk backfill instances + dependency-chain backfill + progress view**" | `lib/backfill/` bulk backfill instances + dependency chain + concurrency / online isolation + retry of failures + progress-matrix page | **P1** |

> **Why Part A is P0**: B and C improve the "experience of the moment" (more accurate prediction, less tedious backfill), and competitors can catch up by stacking features; only the knowledge base accumulated by A compounds over time and binds to the customer — it is the thickest strand of "what you would lose by leaving": every verified fix a customer maintains is something no competitor can take away. Build A first to establish the entry point of the data asset; B and C layer value on top of it and feed each other.

---

## 3. Inventory of the current state (based on a code-exploration pass and a real headless-login check in this round)

| Asset | Current state | How the agent-native operations module reuses it |
|---|---|---|
| Run ledger `bgp-task-runs` (shared by all task types; startedAt / finishedAt / duration / status / error / metrics / triggeredBy) | ✅ strong | Part B's learning data source; Part C writes backfill instances back to it (triggeredBy=backfill provides online isolation) |
| Diagnosis `lib/diagnostics/` + `bgp-diagnostics` (DevOps Agent, in-process fire-and-forget, asynchronous polling) | ✅ strong | Part A attaches a purely additive hook `recordIncident()` **after** diagnosis completes, without changing the main diagnosis flow |
| Alerting engine `lib/alerting/` (watermark scan + idempotency + 4-channel dispatch + AI enrichment) | ✅ strong | Part B reuses the **channel dispatch functions** to push "breach predicted"; it does not change the rule engine |
| Engine SPI `lib/engines/` (seven methods including `submit(runDate, triggeredBy)`; EMR has proven backfill / rerun support) | ✅ strong | Part C's backfill instance executor calls `submit(runDate,'backfill')` directly, with zero privilege expansion |
| AgentCore standard (`infra/agent/{genbi,netadvisor,paramadvisor}`, "each capability = an independent Gateway + Runtime + Memory") | ✅ strong | Part A copies that directory structure to add `infra/agent/devopsdiag/`, upgrading the diagnosis agent to the standard |
| Semantic layer / business definitions `bgp-genbi-context` + skills `bgp-genbi-skills` + semantic retrieval ([GenBI semantic retrieval](./genbi-semantic-retrieval.md)) | ✅ strong | Part A's diagnosis agent reuses `lookup_business_context`; `lookup_incident_history` is built on the same pattern |
| Workflow DAG definitions `bgp-workflows` (dagDefinition.nodes / edges, including retryCount / timeout) | ✅ | Topology source for Part B's critical-path ETA; topology source for Part C's dependency-chain backfill |
| Scheduling (MWAA cron + cronExpression stored on the resource row) | ✅ | Part B's learner DAG + the "expected period" decision; Part C expands date instances by period |
| Asynchronous execution paradigm ([GenBI asynchronous execution](./genbi-async-execution.md) executeGenBiAsk: submit → poll → heartbeat → re-claim → forced finish) | ✅ | Part C's backfill controller copies this idempotency / self-healing paradigm (avoids MWAA DAG explosion) |
| Version service `version-service` (table-driven registry) · generic drawer `VersionHistoryDrawer` | ✅ | Each new resource type of this module gets versioning / rollback by adding one row to the registry |
| contract-guard skill (snapshot before a change / verify after deployment, regression protection) | ✅ | Mandatory before and after every change of this module, to hold the line of "never break what exists" |

**Conclusion**: the data plane (ledger), the execution plane (engine SPI), the notification plane (alerting channels) and the AI plane (AgentCore + diagnosis + semantic layer) are **all already in place**. The new construction of the agent-native operations module concentrates on: **the persistence layer (bgp-incidents) + the prediction layer (lib/baseline) + the orchestration layer (lib/backfill) + three new pages**. The risk is controllable, and each piece can be canaried and accepted independently.

---

## 4. Phased route (a suggestion, not a fixed order)

| Batch | Content | Deliverables | Acceptance anchor |
|---|---|---|---|
| **A.1** | Foundation of the incident knowledge base | `bgp-incidents` table + signature merge + `recordIncident()` hook + `/incidents` knowledge-base page | After one real failure diagnosis, a structured incident appears in the store; when the same kind of failure recurs, the recurrence count is incremented instead of a new record being created |
| **A.2** | Diagnosis upgraded to AgentCore + retrieval reuse | `infra/agent/devopsdiag/` + `lookup_incident_history` MCP skill + historical fixes injected into the diagnosis prompt | For a failure with the same signature that "has been fixed before", the diagnosis report cites the historical "verified fix" and MTTR shortens (compared with the baseline before A.1) |
| **C.1** | Production-grade backfill | `lib/backfill/` + two tables + backfill controller + `/backfill` progress-matrix page | Bulk backfill of one task over 3 days generates 3 instances, concurrency is throttled, a failure retries only the failed items, and the online SLA is not polluted |
| **C.2** | Dependency-chain backfill + fix linkage | Dependency-chain expansion + a "one-click backfill" entry on the diagnosis report | Backfilling one upstream node automatically chains its downstream; a backfill is started in one click from the diagnosis dialog and writes "fix verified" back to the incident |
| **B.1** | Dynamic baseline learning | `lib/baseline/` + `bgp-baselines` table + learner DAG | Every task learns p50 / p90 / EWMA duration and its punctuality distribution; duration anomalies (>3×p90) raise an early warning |
| **B.2** | SLA critical-path prediction | Critical-path ETA + `bgp-slas` + "Breach predicted" alert + dashboard card | A workflow run is predicted to breach **while it is still running** and the alert is pushed **ahead of time** (before the breach); multi-window burn rate reduces false positives |

> **Suggested starting point**: A.1 — it is the data entry point of the moat, it has zero dependencies (it only hooks in after diagnosis completes), and it is the fastest way to see "the knowledge asset going from 0 to 1".

---

## 5. Boundaries with existing modules (conflict-prevention statement)

- **The fault-diagnosis module is not changed**: not a single line of the main diagnosis flow (`startDiagnosis` / the DevOps Agent call) is touched. Part A only reads the report and writes `bgp-incidents` through a **new function** `recordIncident()` once `getDiagnostic` reaches the `done` state. The upgrade to AgentCore is an **addition** — `infra/agent/devopsdiag/` and a new provider; the old in-process path is kept as the fallback (isomorphic to the "in-process / AgentCore dual path" used when GenBI moved to the cloud in the [AgentCore GenBI module](./agentcore-genbi.md)).
- **The alerting module is not changed**: Part B does not add or modify any rule type of the alert rule engine; it stands on its own as `lib/baseline/` + an independent API + an independent event table, and **calls** (imports) the existing channel dispatch functions to push "breach predicted". If the alerting engine should later "absorb" that event as an `sla-breach-predicted` rule type, that is for a later session of the alerting module to decide; this module does not pre-empt the change.
- **The multi-engine module / engine SPI is not changed**: Part C only **calls** exported methods such as `submit(runDate,'backfill')`; it does not change providers or routes. The backfill controller is a new orchestration layer.
- **All new tables use the `hardened` option of `database-stack.ts`** (CMK / PITR / RETAIN), isomorphic to `bgp-metrics` / `bgp-alert-*`; the infrastructure session adds the tables purely additively, without touching existing table definitions.

---

## 6. Write-back suggestions (for the development session to adopt; **this document does not modify the roadmap**)

Once the agent-native operations module has landed, the following write-backs are suggested for the capability roadmap of 2026-08 (historical, single-region stage; to be performed by the session responsible for that document — recorded here only as a suggestion, so that several sessions do not race to write the same file):

- Section 1, capability overview: `backfill` 🟡→✅, `intelligent baselines / SLA / stall prediction` 🟡→✅, `DevOps diagnosis agent` 🟡→✅ (upgraded to AgentCore).
- Section 1, one new row: **`Incident knowledge base (Incident Memory, a compounding data asset)` ✅** — a differentiator that neither the leading cloud data-development suite nor AWS offers natively.
- Section 3, progress-tracking table: add the three rows of the agent-native operations module (A / B / C) and write back the completion dates and the headless-acceptance hard evidence.

---

## 7. Long-term extension: DataOps-Bench (turning the knowledge base into industry authority)

Once `bgp-incidents` has accumulated to scale, it is a **corpus of real failures** nobody else has. It can be exported in redacted form as a reproducible set of evaluation scenarios (each scenario = one "broken pipeline" + the expected diagnosis / fix) and published externally as **DataOps-Bench** — in the spirit of SWE-bench: the benchmark itself contains little code, yet it defines the yardstick of the whole field, and competitors' agents end up advertising your benchmark. This extension is outside the delivery scope of this module, but **the data structure reserves room for it from day one of Part A** (see the export contract in section 8 of the [incident-memory design](./agent-native-operations-incident-memory.md)). This is the path that upgrades a "product moat" into "industry-standard authority".
