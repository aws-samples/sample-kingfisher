# Unified Copilot — Plan-Execute-Confirm engine design

> - 📌 **Scope note (reconciled on 2026-10-13)**: this document was written during the single-region stage and records the design as it stood then (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place,
>   execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is tracked in the module index of the engineering documentation; a path
>   mentioned below that no longer exists means that the idea was not implemented as written here or has since been superseded.
> - ⚠️ **Implementation differences**: the AgentCore flavor of the Copilot described in this document (`infra/agent/copilot`, `infra/lib/copilot-agentcore-stack.ts`, `infra/lambda/copilot-skills`) was never implemented; the current Copilot runs inside the platform process
>   (`platform/src/lib/copilot/`, API `platform/src/app/api/copilot/`); the Plan Center's "create only, never execute" guardrail is documented in the [endpoint inventory](./unified-copilot-endpoint-inventory.md).

> - Status: **✅ implemented (the planner uses the official Strands SDK)** (design finalized on 2026-07-18 with three decisions) (documentation audit calibration of 2026-08-26: the original status header was outdated; it read "no product code written yet").
> - Positioning: on top of the existing Copilot skeleton (the read-only tools, the draft-creation tools, the three gates and the multi-turn memory of the [Copilot design](./unified-copilot.md)), add a layer of
>   agentic orchestration: **"a one-sentence request → automatic discovery of the current state → an execution plan table → step-by-step human confirmation"**.
> - Target scenario: the user only says "compute the advertising ROI for me"; the Copilot investigates on its own (where the data is / whether a ready-made metric exists /
>   whether the source data has been synchronized), reasons out an execution path, and produces an **execution plan table** for the user to confirm.
> - Lineage: follows the global-grade design discipline (plan first, abstract highly), the global self-install architecture
>   (single self-contained directory, zero hard-coding), the [AgentCore platform standard](./agentcore-standard.md), and the three-gate safety contract of the [Copilot design](./unified-copilot.md).
> - Prerequisite already in place: multi-turn conversation (the `bgp-copilot-turns` table + the agent's high-fidelity history, already committed).
>
> **Three decisions made on 2026-07-18**:
> 1. **The plan-table UI is needed in both places**: a standalone `/copilot/plans` page (the Plan Center: list + detail + step matrix),
>    and an embedded, expandable card inside the Copilot drawer — the same `ExecutionPlanCard` component, reused in both places (section 9).
> 2. **Adopt Strands Agents in this phase**: the planner is rewritten with the Strands **official TypeScript SDK** (`@strands-agents/sdk`),
>    no longer a hand-written Bedrock Converse loop (sections 3 and 11).
> 3. **Commit first**: once this design passes review it is committed to the repository first (after a pre-implementation rollback-anchor tag has been created).
>
> - **Key facts verified (2026-07-18, against authoritative sources)**: Strands has an official **TypeScript SDK** (npm `@strands-agents/sdk`,
>   currently v1.10.0, released on 2026-07-17; repository `strands-agents/harness-sdk` with 6.6k stars and actively maintained, Apache-2.0, Node ≥ 20,
>   **first-class support for Amazon Bedrock**, depending on `@aws-sdk/client-bedrock-runtime`).
>   → Significance: the planner can be written with Strands **directly inside the Next.js / TS process**, in the same language and with the same Bedrock client as the existing `agent.ts`,
>   **with no Python container and no cross-language RPC**. "Adopting Strands in this phase" is therefore **low-risk and deliverable**, not a gamble.

---

## 0. One-sentence conclusion

**Copilot = planner (a read-only agent that produces plans) + executor (a deterministic state machine that goes through the existing gated APIs) + confirmation gating (human authorization for every step).**
The three are **physically separated**: the planner only ever has read-only and draft-creation tools (no execution tools, so the capability surface for overreach is eliminated at the root); execution always goes through the platform's
**already built and verified** gated APIs (`/sync/start`, `/etl-jobs/run`, `/engines/*/run`), invoked by the deterministic engine rather than by the
agent; **every step requires human confirmation before it executes** — "the AI never executes on its own" is an architectural iron rule, not a prompt-level promise.

**This design describes the complete architecture in one pass, but enables it in stages** (see section 8): the plan-and-execute phase **only goes as far as "produce the plan table + create drafts automatically +
guide the user to the page to execute"**; the executor (tick-driven delegated execution) is a **pluggable module with its interfaces reserved and disabled by default**, so that when
"step-by-step automatic execution" is approved in the future it plugs in with zero refactoring.

---

## 1. Safety contract: a stepped evolution (the soul of the whole design)

On 2026-07-15 it was decided that "AI execution is permanently forbidden, with no approval-based bypass"; on 2026-07-18 the vision was restated as "execute after step-by-step confirmation".
Reconciling the two = **grading the word "execution" by the source of authorization**, expressed uniformly as one configurable **authorization ladder** whose levels are never skipped:

| Level | What the Copilot may do | Who pulls the execution trigger | Status |
|---|---|---|---|
| **L0 read-only** | Discover the current state, answer questions | — | ✅ live |
| **L1 create drafts** | Produce a plan + create drafts automatically (sync / job drafts) | No execution happens (drafts do not run) | ✅ live (create-tools) |
| **L2 plan table** (the focus of this phase) | Produce a **structured execution plan table**, annotating for every step "which page to go to and what to click" to execute it | **A human** goes to the corresponding page and clicks | 🎯 this phase |
| **L3 step-by-step delegated execution** (interface reserved, off by default) | After the user explicitly confirms **each step**, the deterministic engine calls the gated API **on the user's behalf** to execute it | **A human confirms step by step** + the engine executes on their behalf | 🔒 interface reserved; enabled only with explicit approval |

**Constant invariants (hold at every level)**:
1. **The planner (the agent) never has execution tools** — at most it produces plans and creates drafts. L3 execution is done by an **independent deterministic engine**, not by the agent calling a tool.
2. **There is no "fully automatic one-click run"** — even L3 confirms **step by step**; a single confirmation never releases everything at once.
3. **Execution only goes through the existing gated APIs**; no execution endpoint is added and no execution endpoint's behavior is changed (a decision of the parent Copilot design).
4. **RBAC + audit throughout**: the engine carries the caller's identity and its capabilities never exceed the caller's workspace role; every step writes a `copilot.plan.*` audit record.

> The current implementation (create-service.ts + the action-guard hard block on `.run/.start/...`) = L1. This design moves the system to **L2**
> and reserves the **disabled-by-default** interfaces for L3. Turning L3 on is an **explicit configuration + written approval** action, never a code default.

---

## 2. Architecture overview

```
The user's one sentence ("compute the advertising ROI for me")
        │  POST /api/copilot/plan  (with the Bearer identity, reusing the existing authentication)
        ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Planner  [Strands Agents TS SDK, read-only]                                                                                 │
│  - Strands Agent (model = Bedrock, reusing COPILOT.modelId/region)                                                           │
│  - Tools declared with Strands tool() + Zod schema (read-only discovery + draft creation)                                    │
│    · Reuses the semantics of the existing 7 read-only tools: list_datasources/list_sync_tasks                                │
│      /list_etl_jobs/list_engine_jobs/lookup_business_context                                                                 │
│    · New read-only discovery tools: discover_catalog/find_metric/                                                            │
│      introspect_source_tables/get_lineage (section 4)                                                                        │
│  - Produces a structured [ExecutionPlan] = the strongly constrained tool emit_execution_plan                                 │
│    (N heterogeneous StepSpecs, with dependsOn)                                                                               │
│  - Optional: for non-destructive draft steps, calls create-tools to create drafts (L1)                                       │
│  ⚠ Capability surface eliminated: the tool set contains [no execution tool at all] — however                                 │
│     autonomous Strands is, it cannot call a .run/.start that does not exist (gate 1 still holds inside the framework)        │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
        ▼  plan produced → persisted in bgp-copilot-plans / bgp-copilot-steps
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Execution plan table ExecutionPlan                                                                                          │
│  ── the same <ExecutionPlanCard> component, rendered in two places (decision ①) ──                                           │
│  · /copilot/plans standalone page: the Plan Center (list + detail + full step matrix)                                        │
│  · Embedded card in the Copilot drawer: shown in place once the plan is produced; "Expand full view" jumps to the page       │
│  L2: every step shows an execHint such as "go to the /sync page and click Start" → the user executes on the page             │
│  L3 (interface reserved): the user clicks "Confirm and execute" per step → the deterministic engine executes on their behalf │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
        ▼  enabled only at L3 ↓ (off by default)
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Executor  [hand-written deterministic state machine, reusing the backfill runner core]                                      │
│  - StepHandler registry (SPI): sync-glue/redshift-sql/emr/...                                                                │
│  - idempotent tick advancement + conditional-write claim + runToken against zombies                                          │
│  - reconcile reads terminal states from bgp-task-runs and writes them back (long tasks, reused from backfill)                │
│  - gated: only steps with status=confirmed may go claim→running                                                              │
│  - every step goes through the existing gated APIs (/sync/start, /etl-jobs/run, /run)                                        │
│  ⚠ The executor is [never handed to any framework] — fully auditable deterministic code                                      │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Layering rationale (which is also the isolation boundary for Strands)**: the Strands agent loop has black-box components; but the planner **only runs read-only discovery and
plan production**, so however black-box it is, it cannot cause damage (the worst case is a wrong plan, which does not execute unless confirmed), and **the tool set simply contains no execution tool** —
gate 1 (capability-surface elimination) still holds inside the framework. The dangerous execution part is **our own hand-written deterministic code** (reusing the backfill core), fully auditable,
**never handed to the framework**. → The planning productivity of a framework plus the execution safety of hand-written code: both are secured. This is precisely the root reason why the "physical separation of planner and executor"
makes introducing Strands safe (see section 11 and the agent-framework selection discussion).

---

## 3. The planner: a Strands TS agent, one sentence → execution plan

### 3.0 Strands instead of a hand-written Converse loop (decision ②)
In this phase the planner is implemented with the **Strands Agents official TypeScript SDK** (`@strands-agents/sdk`), replacing the hand-written Bedrock Converse tool-use loop in the existing `agent.ts`.
Reasons (consistent with the long-term planning of the global-grade design discipline):
- **Same language, in-process**: the Strands TS SDK runs in the Next.js Node runtime, the same language as the platform; the model provider points directly at Bedrock
  (reusing `COPILOT.modelId` / `COPILOT.region`), **with no Python container and no cross-language call**.
- **The framework takes over the agentic skeleton**: the tool-use loop, multi-turn message orchestration, parallel tool calls and retries are handled by the SDK; we only write
  **tool definitions (Zod schemas) + the system prompt + the structured output**, dropping the hand-written loop / wall-clock / wrap-up fallback boilerplate that `agent.ts` carries today.
- **Capability-surface safety unchanged**: Strands can only call **the tools we register with it**; registering no execution tool → gate 1 holds inside the framework (section 2).

> - **Relationship to the existing `agent.ts`**: `agent.ts` (hand-written Converse) serves the **general Q&A Copilot** (the first Copilot phase, read-only question answering) and
>   **stays untouched**. The new `planner.ts` (Strands) is the **dedicated planning brain**, used only on the "produce an execution plan" path (`/api/copilot/plan`).
> - The two share the same tool semantics and the same `COPILOT` configuration, but are physically separate with different responsibilities. Whether to migrate the general Q&A to Strands as well is evaluated separately
>   once Strands has proven stable on the planning path (out of scope for this phase, to avoid changing too much at once).

> **AgentCore deployment form**: following the [AgentCore platform standard](./agentcore-standard.md), the planner first runs **inprocess** in this phase (Strands TS
> inside the platform process, zero new stacks, reusing the existing Bedrock IAM). Should a standalone Runtime be needed later, Strands officially supports deployment to Bedrock
> AgentCore Runtime — left to be evaluated together with L3 in the delegated-execution phase; it does not block this phase.

### 3.1 Responsibilities
Decompose the user's request into two stages, **discovery → planning** (purely read-only):
1. **Discovery**: call the read-only tools in parallel to establish the current state — which table holds the advertising data? Is there a ready-made ROI metric? Has the source data been synchronized over?
   Is it in the data lake or in the warehouse? (Strands supports parallel tool calls, so the discovery stage can invoke several tools concurrently at once.)
2. **Planning**: based on the discovery results + the business definitions (the ROI definition in lookup_business_context), reason out the **minimal execution path** and
   produce an `ExecutionPlan` (see section 5). If a ready-made metric or dataset already exists, the plan may have only 1 step (query directly) or even 0 steps (answer directly).

### 3.2 Output form (strongly constrained, structured)
The planner uses a **dedicated structured-output tool** `emit_execution_plan` (Strands `tool()` + Zod schema, rather than free text),
forcing the model to produce JSON that conforms to the `ExecutionPlan` schema. The plan can thus be persisted, rendered as a card and validated (for example, the step type must be
a registered handler type, and dependsOn must point to steps within the same plan). The Zod schema also serves Strands for input validation — a double safeguard.

### 3.3 Key principles
- **The planner has no execution tools**: the tool set contains only read-only discovery + `emit_execution_plan` + (L1) draft creation. Even if the model wanted to "start
  EMR", there is no such tool in the Strands tool set (capability-surface elimination, as safe as the hand-written implementation).
- **No hard-coded e-commerce / gaming**: discovery goes entirely through real APIs (the lesson of the user re-test findings of 2026-07-14); table names / metrics
  are filled in from discovery results, never hard-coded.
- **Honest gaps**: when no source data can be found, the plan must say truthfully "there is no advertising data in the source database; cannot continue" and never fabricate steps.
- **Wall-clock safety**: the planning path is equally bound by the CloudFront 60 s hard timeout (see the [GenBI asynchronous execution design](./genbi-async-execution.md)). The Strands agent is given
  `maxIters` / a soft timeout; if discovery + planning might exceed the limit, the planning path uses **asynchronous submission + polling** (reusing the GenBI asynchronous pattern) instead of blocking synchronously.

---

## 4. Read-only discovery tools (used by the planner; all backed by existing real APIs)

| Discovery tool | Underlying real API | What it answers |
|---|---|---|
| list_datasources (existing) | `GET /api/datasources` | Which data sources exist |
| introspect_source_tables (new) | `GET /api/datasources/[id]/tables` | Which tables + columns the source database has (is the advertising data present at the source?) |
| discover_catalog (new) | `GET /api/governance/catalog` / `GET /api/bi/schema` | Which tables the data lake / warehouse has (has it been synchronized over, and where?) |
| find_metric (new) | `GET /api/modeling/model-metrics` | Whether a ready-made ROI / ROAS metric exists |
| get_lineage (new) | `GET /api/governance/lineage?fqn=` | The upstream / downstream of a table; where the data comes from |
| list_sync_tasks (existing) | `GET /api/sync` | Which sync tasks exist and whether they have run |
| list_etl_jobs / list_engine_jobs (existing) | `GET /api/etl-jobs` / `/api/engines/emr-serverless` | Which batch jobs exist |
| lookup_business_context (existing) | Reads bgp-genbi-context | The business definition of ROI / ROAS |
| check_run_status (new) | `GET /api/monitor/runs?taskId=` | Whether a task's most recent run succeeded (the unified run table) |

> All new tools are thin wrappers over **existing read-only endpoints**; zero new back-end capability. Authentication reuses the caller's Bearer token (no privilege escalation).

---

## 5. ExecutionPlan data model (reusing the backfill plan / instance, generalized to heterogeneous steps)

**Design decision: reuse the plan / tick / reconcile engine skeleton of the Backfill Center** — it is a production-proven
"persistent state machine + idempotent advancer", and the parts orthogonal to the "step type" (advancement / concurrency / reclamation / dependencies / progress) can be reused almost 1:1.
Backfill's hard-wired "date × node" expansion is generalized into "heterogeneous steps produced by the agent".

### 5.1 Two separate tables (copying the backfill layout at dynamodb.ts:90-92)

| Table | Primary key | Description |
|---|---|---|
| `bgp-copilot-plans` | pk=`copilot#<projectId>`, sk=`planId` (ULID) | The plan: request + aggregated progress + status + version optimistic lock |
| `bgp-copilot-steps` | pk=`planId`, sk=`stepId` (sequence number / ULID) | One row per step, heterogeneous, TTL 90 d |

> Table creation copies the bgp-*-turns pattern in `infra/lib/database-stack.ts`; the TaskRole's `bgp-*` wildcard grant covers it automatically
> (same as the wiring silent-degradation fix: adding a table needs zero IAM changes).

### 5.2 Plan entity (reusing the backfill BackfillPlanRow structure)
```
CopilotPlanRow {
  pk, planId, projectId, createdBy
  prompt: string            // the user's original request ("compute the advertising ROI for me")
  summary: string           // the planner's one-sentence description of the plan
  version: number           // optimistic lock (reusing the setPlanStatus pattern)
  status: PlanStatus        // planned|awaiting|running|paused|cancelled|succeeded|partially-failed
  progress: {...}           // aggregateProgress aggregated counters (reused)
  autoExecute: boolean      // L2=false (guidance only); L3=true (the engine executes on the user's behalf). Default false
  createdAt, updatedAt
}
```

### 5.3 Step entity (generalizing the backfill BackfillInstanceRow — the core generalization point)
```
CopilotStepRow {
  planId(pk), stepId(sk), seq
  // —— generalization: backfill's date/nodeId/nodeType replaced by a heterogeneous step description ——
  stepType: StepType        // "sync-glue"|"sync-dms"|"redshift-sql"|"glue"|"emr"|"query-only"
  title: string             // shown to the user ("Create a MySQL→Redshift sync task")
  rationale: string         // why this step is needed (the reason given by the planner)
  params: Record<string,any>// heterogeneous per-step input (the fields used to create the draft; see the mapping in section 6)
  // —— execution guidance (L2) / execution locator (L3) ——
  execHint: { page: string, action: string }  // L2: "go to the /sync page and click Start"
  draftResourceId?: string  // id of the draft resource already created (created by create-tools)
  // —— generic fields reused from backfill (zero changes) ——
  dependsOn: string[]       // stepIds of the prerequisite steps (dependency chain, reusing resolveBlocked)
  status: StepStatus        // see the state machine in section 7
  runTaskId?, runId?        // long-task locator (used by reconcile, reused)
  runToken?                 // idempotency / anti-zombie token (reused)
  attempts, lastError, startedAt, finishedAt, ttl
}
```

### 5.4 Summary of the generalization points (backfill → Copilot)

| Backfill (hard-wired date × node) | Copilot (heterogeneous steps) |
|---|---|
| Mechanical expansion by expandDates × analyzeDag | The agent produces `StepSpec[]` directly (the expander degenerates to "persist the plan array") |
| nodeType hard-coded as a 3-branch if/else | **StepHandler registry SPI** (section 6); a new step type = registering a handler |
| Every instance is an asynchronous long task | A handler returns `{done:true}` (instantaneous) or `{runTaskId,runId}` (a long task that goes through reconcile) |
| After the dry run, everything runs automatically in one go | **New gated confirmation state** (section 7); each step advances only once confirmed |
| Core: tick / claim / runToken / reconcile / resolveBlocked / timeout fallback / progress derivation / optimistic lock | **Reused as a whole, zero changes** |

---

## 6. StepHandler registry (an SPI modeled on engines/registry.ts)

Generalize the three hard-wired branches of the backfill execute.ts into **registrable step handlers** — adding a step type = registering one handler,
without touching the advancer. This is the core of "high abstraction" and a requirement of the global self-install pluggability.

```ts
interface StepHandler {
  stepType: string
  // L1: produce a draft (no execution). Returns the draft resource id.
  createDraft(step, caller): Promise<{ draftResourceId: string }>
  // L2: tell the user where to execute (pure copy, no execution API call).
  execHint(step): { page: string, action: string }
  // L3 (interface reserved; the engine does not call it by default): call the gated execution API on the user's behalf.
  execute?(step, caller): Promise<{ runTaskId?, runId? } | { done: true }>
  // L3: reclaim the terminal state of a long task (reads bgp-task-runs). Reuses the backfill reconcile.
  reconcile?(step): Promise<TerminalStatus | null>
  ceilingMs?: number        // timeout ceiling per step type (reusing the INSTANCE_CEILING_MS idea)
}
registerStepHandler(syncGlueHandler)   // stepType="sync-glue"
registerStepHandler(redshiftSqlHandler)
registerStepHandler(emrHandler)
...
```

### 6.1 Step type → real API mapping (all verified to exist)

| stepType | Create draft (L1) | Execute (L3, interface reserved) | Status query (reconcile) |
|---|---|---|---|
| sync-glue | `POST /api/sync` (channel=glue) | `POST /api/sync/[id]/start` | `GET /api/sync/[id]/glue-status` |
| sync-dms | `POST /api/sync` (channel=dms) | `POST /api/sync/[id]/start-realtime` | `GET /api/sync/[id]/realtime-status` |
| redshift-sql | `POST /api/etl-jobs` (type=redshift) | `POST /api/etl-jobs/[id]/run` | `GET /api/etl-jobs/[id]/runs` |
| glue | `POST /api/etl-jobs` (type=glue) | `POST /api/etl-jobs/[id]/run` | `GET /api/etl-jobs/[id]/runs` |
| emr | `POST /api/engines/emr-serverless` (network required) | `POST /api/engines/emr-serverless/[id]/run` | `GET /api/engines/emr-serverless/[id]/runs` |
| query-only | — (no resource to create) | `POST /api/redshift/execute` (read-only SELECT) | Returned synchronously |

> The unified run table is `bgp-task-runs`; the reconcile-on-read mechanism already exists in three places (sync / etl / emr), and L3 reuses it directly.
> If an execution step produces a run, it is tagged with the isolation marker `triggeredBy="copilot"` (as backfill does, so that it does not pollute online monitoring / SLA / cost).

---

## 7. State machine (the backfill state machine + a new gated confirmation state)

**StepStatus**: `awaiting-confirmation | confirmed | blocked | pending | running | succeeded | failed | skipped`

```
                 ┌─ produced by the planner ─┐
                 ▼                           │
blocked ──(all upstream succeeded)──> awaiting-confirmation   ← [core addition: backfill has no such state]
   │                                          │ the user clicks "Confirm this step"
   │(upstream failed)                         ▼
   └──> skipped                           confirmed
                                              │ L2: stops here; guides the user to the page to click (the engine does not advance)
                                              │ L3: the engine claims
                                              ▼
                                          pending ──(conditional-write claim)──> running
                                                                                    │(reconcile reads the terminal state / timeout)
                                                                                    ▼
                                                                           succeeded / failed
```

**Key gating**: the claim phase of the tick gains one check — **only steps with `status=confirmed` are allowed to go
`claim→running`**; a step in `awaiting-confirmation` is **not advanced automatically** even when its dependencies are satisfied. This is the iron rule "the AI never executes on its own"
landed at the state-machine layer. After resolveBlocked unlocks a step, it lands in `awaiting-confirmation` (rather than directly in `pending` as in backfill).

**PlanStatus** (reusing the backfill derivePlanStatus + the new awaiting): `planned|awaiting|running|paused|cancelled|succeeded|partially-failed`.

**New control action** `confirm-step` (`awaiting-confirmation → confirmed`, a conditional write under the optimistic lock, writing the audit record
`copilot.plan.confirm-step`). **Under L2**: confirm-step merely marks "the user has acknowledged"; the engine does not execute, and the UI shows the execHint.
**Under L3**: only after confirm-step does the engine claim and execute. The same state machine; the behavior is switched by the `plan.autoExecute` flag.

---

## 8. Staged implementation (designed in one pass, enabled in stages)

| Stage | Scope | Safety level | Enabled? |
|---|---|---|---|
| **Stage A** | Planner (read-only discovery tools + emit_execution_plan) + ExecutionPlan persistence + the plan-table UI card | L2 | ✅ this phase |
| **Stage B** | Automatic draft creation (the plan's steps call create-tools to create drafts) + execHint guidance "which page to go to and what to click" | L1+L2 | ✅ this phase |
| **Stage C** | Executor skeleton (StepHandler registry + tick/reconcile, reusing the backfill core) | — | 🔧 **code written; `autoExecute` defaults to false; the engine does not claim** |
| **Delegated-execution phase** | L3 step-by-step delegated execution: turn on autoExecute; the engine executes after confirm-step | L3 | 🔒 **enabled only with written approval** |

> - **The value of Stage C**: the executor, as a **pluggable module**, gets its interfaces and skeleton written first (sharing the core with backfill), but `autoExecute`
>   defaults to false → the engine exists but executes no step. When L3 is approved in the future, only the flag needs flipping + the `execute()` of each handler needs implementing,
>   **with no architectural refactoring**. This is "plan ahead, think long-term" made concrete: today's L2 and tomorrow's L3 are two configuration states of the same code.

---

## 9. Directory structure (single self-contained directory, following the global self-install architecture)

```
platform/package.json             // + dependency @strands-agents/sdk (Node≥20, Apache-2.0)
platform/src/lib/copilot/
  plan/
    types.ts            // ExecutionPlan/Step data model + state-machine constants + Zod schema
    planner.ts          // planner [Strands TS Agent]: discovery→emit_execution_plan (pure planning, read-only)
    plan-service.ts     // persistence / lifecycle / progress derivation (reusing the backfill service pattern)
    executor.ts         // executor [hand-written]: tick/claim/reconcile (reusing the backfill runner core, gated by autoExecute)
    step-handlers/
      registry.ts       // StepHandler registry (an SPI modeled on engines/registry.ts)
      sync-glue.ts      // per-step handlers (createDraft/execHint/execute?/reconcile?)
      redshift-sql.ts
      emr.ts
      ...
  tools/
    discovery-tools.ts  // new read-only discovery tools (thin wrappers over existing endpoints; wrapped by Strands tool())
    strands-tools.ts    // adapts the discovery/create tool semantics into Strands tool()+Zod (planner only)
    (the existing read-tools/create-tools/registry + agent.ts stay untouched — the general Q&A Copilot is kept)
platform/src/app/api/copilot/
  plan/route.ts         // POST produce a plan (Strands planner) / GET list plans
  plan/[planId]/route.ts        // GET plan detail (step matrix)
  plan/[planId]/confirm/route.ts// POST confirm-step (gated confirmation)
  plan/[planId]/tick/route.ts   // POST advance (L3; a no-op under L2)
  plan/[planId]/control/route.ts// pause/resume/cancel/retry
platform/src/app/copilot/
  plans/page.tsx        // [decision ①-A] the Plan Center standalone page: plan list + detail + full step matrix
platform/src/components/copilot/
  ExecutionPlanCard.tsx // the core plan-table UI component (steps/dependencies/status/confirm button/execHint)
                        //   —— embedded in the drawer and on the /copilot/plans page [the same component, reused] (decision ①, prevents drift between the two)
  (the CopilotDrawer embeds <ExecutionPlanCard compact> + "Expand full view" → jumps to /copilot/plans/[id])
infra/lib/database-stack.ts     // + the two tables bgp-copilot-plans / bgp-copilot-steps
```

**Key points of the dual-UI reuse (decision ①)**: `ExecutionPlanCard` is the single source of truth, its form controlled by `compact?: boolean` —
`compact` inside the drawer (a compact step strip + an expand-and-jump button), fully expanded on the `/copilot/plans/[id]` page (the full matrix). Both places consume
**the same plan data** (`GET /api/copilot/plan/[planId]`) and the same confirmation actions. Two sets of UI logic are never written (prevents drift).

---

## 10. Safety / contract / verification (to be followed during implementation)

- **Global-grade design discipline**: this design comes first; code is written only after it passes review.
- **Tag before big changes**: create a pre-implementation rollback-anchor tag before implementing.
- **Contract guard before and after every change**: take a snapshot before changing platform/src; verify zero regression after deployment.
- **Headless-web-only verification + the headless existence-check guide-pollution lesson**:
  verification goes through the headless UI, cross-confirmed against the authoritative sources DynamoDB / Redshift ("text in body" checks are forbidden).
- **RBAC**: planning / confirmation / execution all carry the caller's identity and never exceed the caller's workspace role; everything is written to the `copilot.plan.*` audit records.
- **L3 enablement red line**: autoExecute=true is an explicit configuration + written approval action, never a code default; and it **always confirms step by step —
  there is no one-click release of everything**.

---

## 11. Relationship to the agent-framework selection (see the agent-framework selection discussion)

The planner / executor separation of this architecture is precisely the isolation boundary that makes introducing **Strands Agents** safe:
- **The planner** is written in this phase with the Strands official **TypeScript SDK** (read-only discovery + plan production); however black-box the framework is, it cannot cause damage
  — there is no execution tool in the tool set; the worst case is a wrong plan.
- **The executor** is always a hand-written deterministic gated pipeline (reusing the backfill core), **never handed to any framework**.
- **Strands rather than a model vendor's proprietary agent SDK** (the settled rationale; the decisive factor is global self-installation):
  - **License**: Strands is Apache-2.0 and can be distributed with the platform to users worldwide without concern; a commercially licensed vendor SDK burdens distribution.
  - **Model / region freedom**: Strands is model-agnostic (Amazon Bedrock as well as other model providers), so users worldwide choose
    Bedrock models in their own region; a vendor SDK is biased toward that vendor's own models and is constrained by region.
  - **Native AgentCore fit**: Strands is AWS open source, of the same origin as Bedrock AgentCore, with an officially supported deployment path.
  - **Language fit**: Strands has a first-class **TS SDK** (verified: npm `@strands-agents/sdk` v1.10.0, actively maintained),
    the same stack as this platform's Next.js / TS; it runs in-process, with no Python or coding-assistant-lineage baggage.
- **Deployment form in this phase**: an inprocess Strands TS agent (zero new stacks, reusing the existing Bedrock IAM). No "PoC first, then adopt" is needed any more
  — the fact that the TS SDK supports Bedrock first-class has been verified, the risk is controlled, and it lands directly in Stage A. Standalone AgentCore Runtime deployment is left for the delegated-execution phase.

---

## 12. Decision points (all decided on 2026-07-18)

| # | Decision point | Conclusion |
|---|---|---|
| 1 | Safety level for this phase | **L2** (produce the plan + create drafts + guide; a human goes to the page to execute); the L3 interface is reserved and off by default |
| 2 | Where the plan-table UI lives | **Both places**: the standalone `/copilot/plans` Plan Center page + an embedded, expandable card in the Copilot drawer; **the same `ExecutionPlanCard` component is reused** (section 9) |
| 3 | Whether the planner adopts Strands in this phase | **Yes, in this phase**: write `planner.ts` with the Strands official TS SDK (`@strands-agents/sdk`), physically separate from the existing `agent.ts`, which is kept (section 3.0) |
| 4 | Whether a Strands PoC is needed beforehand | **Not needed**: the TS SDK's first-class Bedrock support has been verified; it lands inprocess directly and does not block Stage A |
| 5 | When to create drafts (decided during implementation, 2026-07-18) | **Deferred creation**: the planner only produces the plan table (purely textual steps); create-tools is called to create the corresponding draft only when the user clicks "Confirm this step". Safer and cheaper on resources, and it gives confirm-step under L2 a substantive action (create the draft + give the execHint). |
| 6 | Handling of query-only steps in this phase (decided 2026-07-18) | **A plan-endpoint placeholder only**: the execHint guides the user to the /query or /genbi page to query by themselves; the engine never runs SQL (avoiding the write risk of redshift/execute, which has no read-only validation and runs with admin privileges). |

> **Key API constraints verified during implementation (established by a code-exploration pass; to be respected when writing each StepHandler)**:
> - `redshift/execute` has **no read-only validation, executes as admin, and has no RBAC** → the planner is not given this tool; query-only only guides a human to query.
> - `monitor/runs` **does not support filtering by taskId** → check_run_status uses the `/api/{sync,etl-jobs,engines}/[id]/runs` sub-endpoints instead (take the latest in descending order and judge succeeded).
> - EMR `network={subnetIds[],securityGroupIds[]}` is not mandatory at creation, but a job that needs outbound network access times out without it → the emr StepHandler must prompt the user to fill in the network.
> - Among the discovery endpoints, `datasources/[id]/tables`, `monitor/runs` and `redshift/execute` have **only the gateway token and no workspace-level RBAC** (the others have requireProject).

> The three decisions have all been folded into the body (the decision block at the top + sections 2 / 3 / 9 / 11). This design is hereby **finalized** and moves into implementation:
> create the pre-implementation rollback-anchor tag → commit this design → implement in stages per section 8 (starting with Stage A).

---

## 13. Pre-implementation checklist (check off item by item when starting)

- [ ] Create and push the pre-implementation rollback-anchor tag (the tag-before-big-changes rule; the rollback anchor for this large change).
- [ ] Contract-guard snapshot of L1 + L2 (the contract-guard-before-and-after-every-change rule).
- [ ] Add `@strands-agents/sdk` to `platform/package.json`, lock the version with `npm install`, and confirm the build passes on Node ≥ 20.
- [ ] Minimal Strands TS agent connectivity: run Bedrock in-process (reusing `COPILOT.modelId`), register 1 read-only tool and verify tool use.
- [ ] Create the tables `bgp-copilot-plans` / `bgp-copilot-steps` (copying the turns pattern; the TaskRole's `bgp-*` wildcard grants access automatically).
- [ ] Land `plan/*` + `discovery-tools` + the `/copilot/plans` page + `ExecutionPlanCard` per the directory layout in section 9.
- [ ] Headless UI verification (headless-web-only verification): one sentence → the plan table appears → the drawer and the standalone page agree;
      **"text in body" existence checks are forbidden** (the headless existence-check guide-pollution lesson); check the authoritative count in `bgp-copilot-plans`.
- [ ] Deploy only with `scripts/redeploy-platform.sh` (the wiring silent-degradation fix); zero contract-guard regression after deployment.
