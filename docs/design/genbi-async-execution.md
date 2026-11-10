# GenBI Asynchronous Execution (root fix for the 60-second synchronous timeout)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is summarized in the [modules overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> - Revision: 1.0 **✅ implemented and deployed (GENBI_ASYNC end to end)** (audit calibration of 2026-08-26: the original status header was outdated; it read "design draft, awaiting the go-ahead to start") | Created: 2026-07-06 | Maintainer: architecture
> - Related: [AgentCore GenBI](./agentcore-genbi.md), the [AgentCore platform standard](./agentcore-standard.md), and the deployed AgentCore GenBI runtime
> - **This file is design only and contains no implementation. Whether to start was to be decided when instructed.**

---

## 0. In one sentence

Change Ask-Your-Data from a **synchronous long request** (the browser waits 60 s+) to an asynchronous **submit → poll → fetch result** model,
escaping the CloudFront 60-second origin timeout wall once and for all; **the behavior and output of every existing capability stay unchanged** — only "how the result is obtained" changes.

---

## 1. Problem and root cause (verified in production)

### 1.1 Symptom
When a user submits a complex question on `/genbi`, the front end reports `JSON.parse: unexpected character at line 1 column 1`.

### 1.2 Root-cause chain (evidence layer by layer)

| Layer | Fact | Evidence |
|---|---|---|
| Front end | `const data = await res.json()`; when the response is not JSON it throws a JSON.parse error (caught and shown as turn.error) | `app/genbi/page.tsx:225` |
| Back-end route | `/api/genbi/ask` runs the full agentic loop **synchronously** before returning; the normal path always returns JSON | `app/api/genbi/ask/route.ts` |
| Agent loop | `maxIters=8` rounds of tool calls; each round = Bedrock Opus inference (seconds) + warehouse query (polling cap `40×800ms=32s`) | `lib/genbi/config.ts:24-27` |
| AgentCore | `InvokeAgentRuntime` is a **blocking** data-plane call; the runtime container's `/invocations` is synchronous HTTP with no native async job API | `lib/genbi/agentcore-client.ts:39`, `infra/agent/genbi/index.js`; the SDK only has `InvokeAgentRuntimeCommand` |
| **CloudFront** | origin `readTimeout` **hard cap 60 s** (>60 s requires a quota increase); on timeout it returns a **504 HTML error page** | `infra/lib/platform-stack.ts:723` (the comment records this earlier pitfall) |

**Conclusion**: simple questions pass in ~19 s (measured); complex questions (multi-step SQL / multi-turn follow-ups) accumulate >60 s → CloudFront 504 HTML → the front end's `res.json()` hits `<` → error. **The intermittency is driven by question complexity**, not by a logic bug.

### 1.3 Why "raising the timeout" is not a root fix
- The CloudFront origin timeout has a hard cap of 60 s (unless an AWS quota increase is requested — not under our control and not portable across account deployments).
- Even at 180 s, agentic question answering has no upper bound (tool loop + LLM) and would hit the wall again sooner or later.
- Synchronous long connections occupy ECS connections / threads; under amplified concurrency they drag the service down before the timeout even fires (an availability risk).
- **A synchronous request–response should never have carried minute-scale agentic workloads in the first place** — this is an architecture problem, not a parameter problem.

---

## 2. Design goals and constraints (red lines)

### 2.1 Goals
1. **Root fix**: question answering is no longer bound by any gateway's synchronous timeout; results come back at any complexity.
2. **Zero behavioral regression**: answers, SQL, charts, execution chain, masking, matched tables, memory, history — **the output is byte-for-byte identical to today**; only "when / how" it is obtained changes.
3. **Global production grade**: idempotent, re-entrant, deterministic terminal states on timeout / failure, no orphan tasks, controllable cost (TTL), no hard-coding.
4. **Revertible**: if something goes wrong, switch back to the synchronous path with one flip (feature flag) without sacrificing current availability.

### 2.2 Constraints (mandatory; violating any of them is a failure)
- **C1 Single process, no worker**: the platform is a monolithic Next.js on ECS with **no independent worker / queue**; "background" today is only a fire-and-forget promise inside a request (`fireDownstreamOnce` is exactly that). → **Where the asynchronous executor lives** is the core difficulty of this design (see §4).
- **C2 Do not break existing consumers**: the `GenBiResult` type, `/api/genbi/ask`, `recordGenBiHistory`, `appendTurn/maybeSummarize`, masking `maskRows`, matched tables `parseSqlLineage` — all stay unchanged or **purely additive**.
- **C3 Follow the existing paradigm**: asynchronous polling already has a mature precedent — **workflow runs** (`trigger` records `running` → `runs/[runId]/status` idempotently back-fills the terminal state → the front end polls). GenBI asynchrony **copies this mental model** to lower cognitive and maintenance cost.
- **C4 Tables and IAM follow existing conventions**: the new table goes through the `hardened` loop of `database-stack.ts` + `timeToLiveAttribute:"ttl"` (see `bgp-alert-events`/`bgp-genbi-turns`); registered in the TABLES constants; if new IAM is needed it goes in an **independent ManagedPolicy** (`addToPolicy` is forbidden; see the TaskRole inline-policy 10 KB limit lesson).
- **C5 Verifiable headlessly**: the whole submit / poll / fetch chain can be verified by really operating the web page with a headless browser (mandatory).

---

## 3. Option selection (three paths; B chosen)

| Option | Where the executor lives | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A. Pure front-end long polling + back-end flush** | Still runs inside the request, but flushes in chunks to keep the connection alive | Small change | Treats the symptom: CloudFront has a timeout on the **first byte**, and SSE / chunking is unreliable behind a CDN; still occupies a connection | ✗ |
| **B. Task table + in-app background execution + polling** (chosen) | Executes inside the Next.js process via `after()` / a detached promise; state lands in DynamoDB | No new infrastructure, fits the existing workflow paradigm, revertible, low cost | Decoupling the executor from the request needs care (see §4, C1) | ✓ |
| **C. Introduce SQS + Lambda / an independent worker** | An independent worker consumes the queue | Most thorough, scales naturally | New infrastructure (SQS+Lambda+IAM+VPC), higher cross-account deployment complexity, a break from the "monolith" status quo, over-engineering | ✗ (recorded as the phase-2 evolution direction) |

**Why B**: the AgentCore runtime **is itself that "independent worker"** — the real 60 s+ work happens in the runtime container, not in the Next.js process. The Next.js side only needs to issue the invoke and write the result into the task table. Option B, with the smallest change, moves "initiate + wait" from the **request lifecycle** to the **task lifecycle**.

---

## 4. Core difficulty: where the executor lives (the direct answer to C1)

Single process, no worker, and `InvokeAgentRuntime` is a blocking call of 60 s+. Three implementation shapes; **B2 recommended**:

### B1. Next.js `after()` / detached promise (smallest change)
- `POST /ask` creates the task immediately (status `running`) and returns `taskId`; with `import { after } from "next/server"` it continues running `invokeGenBiAgent` **after the response has been sent** and writes the task table on completion.
- **Risk**: execution in `after()` is not guaranteed to survive ECS rolling deployments / scale-in; detached work lasting 60–120 s is **lost** if the task is reclaimed (it becomes an orphan `running`).
- **Mitigation**: ① lengthen ECS `stopTimeout`/`deregistrationDelay` to allow draining; ② `startedAt` in the task table + a **timeout backstop** (see §5.4) that marks overdue `running` tasks `failed`, so the front end never spins forever.
- Suitable for: the smallest change; can land first to verify the loop.

### B2. Poll-driven execution (recommended, most stable, truly stateless)
- **Key insight**: AgentCore `InvokeAgentRuntime` uses a **stable `runtimeSessionId`** (`runtimeSessionId(conversationId)` already exists). The **polling request itself** can carry the execution:
  - `POST /ask`: create the task as `pending`, do **not** run the agent, return `taskId` immediately.
  - The front end polls `GET /ask/[taskId]`: the **first** polling request uses a conditional write to move `pending`→`running` (claim, idempotent), then runs `invokeGenBiAgent` **inside that polling request**. But a single polling request is equally subject to the 60-second gateway limit…
  - → So B2 needs **AgentCore asynchronous sessions** or **segmentation**, which raises complexity.
- Verdict: pure B2 does not resolve the fundamental "single request, 60 s" contradiction **unless the runtime side supports task-style execution** (the current SDK does not). **Downgraded to B1 + backstop**.

### B3. Self-persistence on the runtime side (most thorough; changes the AgentCore image)
- Make the `/invocations` of `infra/agent/genbi/index.js` **submission-style**: on request → start background execution → return `jobId` immediately; add `/result?jobId=` for queries. State is kept in the runtime container's memory or in DynamoDB.
- Truly puts the long execution into "that worker" (the runtime); the Next.js side answers within seconds.
- **Drawbacks**: the runtime container may have several instances (state must be externalized to DynamoDB); the AgentCore image must be refactored + deployed in two passes (see the [AgentCore platform standard](./agentcore-standard.md)); the in-process fallback path (`runInprocess`) must change too. The largest change surface, but the most correct.

### Recommended landing order
**Phase one = B1 (in-app detached + timeout backstop)**: smallest change, fits the status quo, loop verifiable headlessly, revertible.

**If load testing shows an unacceptable detached-task loss rate → phase two upgrades to B3** (runtime submission-style); the task-table contract stays unchanged and only the executor location changes.
> This way the task table / front end / API contract is designed once and the executor location can evolve smoothly — **a stable top-level design with a replaceable bottom layer**.

---

## 5. Detailed design (based on B1, phase one)

### 5.1 Data model: new table `bgp-genbi-tasks`
```
pk: taskId (ULID)              # one question-answering task
attributes:
  userId, projectId, conversationId
  question, engine, workgroup, database
  status: pending|running|succeeded|failed|timeout
  result: GenBiResult (JSON, present only when succeeded)   # field-for-field identical to the existing type
  error: string (only for failed/timeout)
  backend: agentcore|inprocess                    # records the backend actually used
  createdAt, startedAt, finishedAt, ttl           # ttl=createdAt+7d, automatic cleanup
```
- Goes through `database-stack.ts` `hardened` + `timeToLiveAttribute:"ttl"`; `TABLES.GENBI_TASKS="bgp-genbi-tasks"`.
- **Single partition key taskId**: tasks are independent and the key is naturally idempotent; no sk is needed.
- **`result` stores the whole `GenBiResult`**: once the front end has it, the rendering path is **exactly the same** as today (reusing `TurnResult`).

### 5.2 API contract (purely additive; the old endpoint is kept)

| Endpoint | Behavior |
|---|---|
| `POST /api/genbi/ask` | **Remains**; the feature flag `GENBI_ASYNC` decides: off = the existing synchronous behavior (zero regression); on = create a task and return `{ taskId, status:"pending" }` (202) |
| `GET /api/genbi/tasks/[taskId]` | Polling: returns `{ status, result?, error? }`; **on the first hit while pending**, a conditional write claims it as `running` and triggers execution (B1: runs inside `after()`; or runs in `after()` of the POST, and GET is read-only) |
| (internal) executor | Reuses **all the logic of the existing `ask/route.ts`** (agentcore→inprocess fallback, masking, matched tables, history, memory), only replacing "return apiOk(result)" with "write succeeded to the task table" |

**Key**: the execution logic is **extracted into one pure function** `executeGenBiAsk(params): Promise<GenBiResult>`, and the synchronous endpoint and the asynchronous executor **share that same function** — guaranteeing zero behavioral difference; this is the structural guarantee of "no effect on other features".

### 5.3 Front end (`app/genbi/page.tsx`)
- `ask()`: POST to get `taskId` → start polling `GET /tasks/[taskId]` (2 s interval, reusing the polling mental model of workflow runs).
- Turn state machine: `loading` (polling; shows elapsed time / step heartbeat) → `result` (succeeded) / `error` (failed/timeout).
- **Zero change to the `TurnResult` component**: the `result` it receives is today's `GenBiResult`.
- After the polling cap (e.g. 5 min) an explicit `timeout` message is shown; it **never spins forever**, and **never shows `JSON.parse` gibberish** (the response is always JSON).
- With the flag off, the existing synchronous call stays untouched (gradual rollout / fallback).

### 5.4 Resilience (global production-grade essentials)
- **Idempotent claim**: `pending→running` uses a DynamoDB conditional write (`attribute_not_exists` / status equality) to prevent duplicate execution (copying the ConditionExpression idempotency of `fireDownstreamOnce`).
- **Timeout backstop**: when a poll reads `running` and `now-startedAt > MAX (e.g. 180s)` → mark `timeout` and write it back (reconcile-on-read, copying the read-time reconciliation of the task-status-truthfulness rule). Eliminates orphan `running` tasks.
- **Failure is terminal**: the executor catches every exception and writes `failed`+error; the front end shows it clearly and offers "retry" (creating a new task).
- **Cost**: TTL 7 d automatic cleanup; the size of `result` is bounded by `maxRows=200`, so a single item is far below the DynamoDB 400 KB limit (truncation protection for extreme results).
- **Memory / history**: still written by the executor after success via `recordGenBiHistory`/`appendTurn`/`maybeSummarize` — **same place, same timing**, only moved from "inside the request" to "inside the task".

### 5.5 Observability & compatibility
- The task table is naturally an audit trail (question / backend / duration / terminal state).
- The old `bgp-genbi-history` is kept untouched (it is the "recent questions" list, a different responsibility from the task table).
- correlationId runs through POST→GET (for troubleshooting).

---

## 6. Impact inventory (proving "no effect on other features")

| Existing asset | Changed? | Notes |
|---|---|---|
| `GenBiResult` type | **No** | The task table's result stores it directly |
| `TurnResult` rendering component | **No** | Same rendering path once the result is received |
| `lib/genbi/agent.ts` (inprocess) / `agentcore-client.ts` | **No** | Called by the executor; signatures unchanged |
| `maskRows`/`parseSqlLineage`/`suggestChart` | **No** | Called inside the executor in the original order |
| `recordGenBiHistory` / memory memory.ts | **No** | Called by the executor after success; same timing |
| `POST /api/genbi/ask` | **Flag-gated increment** | Flag off = as is; on = returns taskId. Can default to off first and be enabled gradually |
| CloudFront/ALB/ECS infrastructure | **No** | Once asynchronous, the 60 s wall is naturally no longer hit (responses within seconds) |
| DynamoDB | **+1 table** | `bgp-genbi-tasks`, following the existing hardened paradigm |
| IAM | To assess | Read/write on the new table is added to the Platform TaskRole's existing DynamoDB ManagedPolicy (no new policy; if the resource is a wildcard, no change is needed) |

**Other AI capabilities (network advisor / parameter advisor)**: this design **does not touch** them (they respond quickly and have no timeout problem). But the same asynchronous paradigm **can be reused later** — the way `executeGenBiAsk` is abstracted can serve as the template for "making long agentic calls asynchronous" (an extension of the [AgentCore platform standard](./agentcore-standard.md)).

---

## 7. Acceptance (headless web, mandatory)
1. Flag on, ask a **complex question** (forced >60 s, e.g. multi-table joins + multiple turns): POST returns a taskId within seconds → the front end keeps polling → finally succeeded, with answer / chart / SQL / execution chain **item-for-item identical to the synchronous path**.
2. **Control**: for the same question, the result with the flag off (synchronous) and with the flag on (asynchronous) are **field-for-field equal** (hard evidence of zero regression).
3. Timeout backstop: simulate a hung executor → after MAX the poll shows timeout; no endless spinning, no JSON.parse error.
4. Idempotency: several concurrent polls of the same pending task execute it only once (the task table has exactly one running→succeeded).
5. Fallback: with the flag off, the existing synchronous question answering works completely normally (simple questions pass in ~19 s).
6. Memory / history: after an asynchronous success, `bgp-genbi-history` has a record and the multi-turn follow-up context is correct (consistent with today).

---

## 8. Phasing
- **Phase 0 (the first delivery of this module)**: B1 + task table + flag + front-end polling + timeout backstop + headless acceptance. Revertible.
- **Phase 1**: load-test the detached loss rate; if it does not meet the bar → upgrade to B3 (runtime submission-style); task table / front-end contract unchanged.
- **Phase 2 (optional)**: option C (SQS+worker), considered only if the platform as a whole moves to a multi-worker architecture; **not done** for now.

---

## 9. Decisions made (2026-07-06)

| # | Decision point | Decision | Notes |
|---|---|---|---|
| 1 | Starting option | **B1+** (in-app detached + **heartbeat** + **re-claim self-healing on poll**) | On top of bare B1, add a heartbeat and "if a poll finds the heartbeat stale, re-claim and rerun", so orphan tasks heal themselves while the tab stays open; zero new infrastructure, flag-revertible; the contract matches §8, and a future upgrade to C needs no rework. **B3 excluded** (the most expensive and it does not actually buy persistence — the container is reclaimed just the same — and it misses the inprocess fallback path). C (SQS+worker) is recorded as phase 2, only if the platform heads toward high concurrency / frequent deployments. |
| 2 | Flag default | **On by default after verification** | Deploy after implementing; first run headless acceptance in the deployed environment with the flag on; once all green, default on (fixing the live bug + zero regression), with the flag kept for one-flip fallback. |
| 3 | Timeout backstop MAX | **300 s (5 min) · active forced termination** | It was stated explicitly: if no answer in 5 minutes, **kill it forcibly**. **Not passive marking** — see the §5.4 revision below: ① the executor hangs an `AbortController` and aborts at 300 s (inprocess really stops computing; the agentcore abort stops the client wait + disconnects, and the container's own bounded loop winds down naturally — an honest boundary);<br>② the reconciliation backstop independently judges the 300 s ceiling by `startedAt` (so the ceiling holds even if the task that owned the timer died), and at the ceiling it **never reruns**. |
| 4 | Real-time step push | **True step-by-step push = phase 1; heartbeat liveness indicator = included in this phase** | True step-by-step push on the default agentcore backend requires changing the runtime container (sliding toward B3), so it is phase 1. But the B1+ heartbeat provides a free "still running · elapsed N s" liveness indicator that removes the anxiety of staring at a blank screen for 5 minutes, so it is included in this phase. |

### Revision of §5.4 (two-layer guarantee of forced termination + self-healing)
While the executing process is alive: `AbortController` reaches 300 s → active abort (inprocess really stops; agentcore stops waiting + disconnects) → catch writes `timeout`.
When the executing process is dead (orphan): the poll independently judges `now-startedAt ≥ 300s` and `running` → force `timeout`, **never rerun**.
Self-healing rule (three branches): heartbeat fresh → leave it; heartbeat stale (>30 s) and before 300 s → re-claim and rerun; at the 300 s ceiling → force timeout, never rerun.
Heartbeat fields are written with the task item as `heartbeatAt` + optional `progress` (elapsed time / estimated step); the polling GET exposes them for the front end's liveness display.

> Decisions made; moving into implementation (phase one = B1+).
