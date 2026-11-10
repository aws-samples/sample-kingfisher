# Stage 4 Design — Disposition of the In-Process Backend (the last step of the complete first construction phase · decision point)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is described in the [module overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> - Status: **✅ implemented** (audit calibration of 2026-08-26: the original header read "in design, no code touched"). Stages 0–3 are all achieved and verified online (duplicate sources ① and ② eliminated, hosted on Strands,
>   prompt / catalog / retrieval all unified in core, both backends return the identical result of 898 persons). This document is the decision design for the last step of the first construction phase.
> - Following the design-first, no-code-until-approved discipline: action is taken only after the decision between a and b.

> ⚠️ (documentation audit of 2026-08-26) This implementation plan has been fully implemented; the code is authoritative. The overall design is the [GenBI engine-unification design](./genbi-engine-unification.md). Kept as a historical implementation record.

## 0. Decision Point (the final choice that stage 4 of the [first-phase implementation plan](./genbi-engine-unification-implementation-plan.md), section 3, leaves open)
**What to do with the in-process backend?** (a) delete it for real / (b) keep it as a thin shell.

## 1. Factual Baseline (surveyed for this stage; everything verified)

### 1.1 What the In-Process Backend Is Now (its real state after stages 1–3)
- **An extremely clean dependency chain**: `agent.ts` (the in-process core) is imported only by `execute.ts`; `runGenBiAgent` has a single call site (execute.ts:75).
- **It fully reuses core**: after stages 1–3, the in-process agent.ts uses **@genbi/core for prompt / catalog / retrieval / sql-guard, all of them** (after the follow-up sub-step of stage 3 that unified catalogText, catalogText also goes through core). → **The in-process backend is no longer "a second engine" but "a direct-connection shell around core"** (it executes directly against Redshift / Athena rather than through MCP).
- **Code size**: agent.ts is about 200 lines, most of which is the loop skeleton plus the direct-connection executors (runSelect / runSelectAthena); the pure logic is already in core.

### 1.2 The Two Irreplaceable Values the In-Process Backend Provides Today
1. **Automatic fallback when agentcore fails** (execute.ts:104-106): on an AgentCore cold start, throttling, or a Gateway / MCP failure, the request falls back automatically to in-process and the user notices nothing. **This is the availability safety net of the production system** (an engineering note recorded occasional fallbacks caused by cold starts — it was exactly this path that caught them).
2. **The only path that can "truly stop compute"** (a red-team finding from the first-phase review): the in-process abortSignal is checked on every iteration and before every SQL statement (agent.ts:152,191), so when the 300-second ceiling of the [GenBI asynchronous-execution design](./genbi-async-execution.md) is reached it can **actually interrupt the Bedrock call and stop consuming compute**. The agentcore abort only ends the client's wait; **it cannot kill the inference still running in the remote container** (for agentcore, 300 seconds only "marks a timeout"; compute keeps burning).

### 1.3 Capability Parity (a red-team review item)
- The in-process backend **has no** registered skills (those are agentcore-only, in the Lambda). When falling back to in-process, run_registered_skill is unavailable — but run_sql querying on its own can still answer the vast majority of questions (skills are only "an accelerator for consistent business definitions", not the only path).
- This means: the in-process fallback is "**degraded but usable**", not "a complete substitute".

## 2. 🟡 An Honest Comparison of the Two Options

| Dimension | (a) Delete in-process for real | (b) Keep a thin shell (recommended) |
|---|---|---|
| Purity of "one shell" | ✅ Maximal (only the agentcore chain remains) | 🟡 Nominally two chains, but in-process is already a direct-connection shell around core |
| Eliminating drift | ✅ (but stages 1–3 already eliminated it; in-process reuses core and has no drift source) | ✅ Same as left (in-process has no independent logic that could drift) |
| **Fallback on agentcore failure** | 🔴 **Gone** (a cold-start / throttling failure → the question fails outright) | ✅ Kept (automatic fallback, invisible to the user) |
| **Truly stopping compute** (red-team finding) | 🔴 **Gone** (300 s can only mark a timeout; compute keeps burning) | ✅ Kept (the in-process abort really interrupts Bedrock) |
| Local development / debugging path | 🔴 Gone (GenBI can only be tested by connecting to AgentCore) | ✅ Kept (GENBI_BACKEND=inprocess runs directly on a local machine) |
| Maintenance cost | Delete ~200 lines | Almost zero (in-process already reuses core; no independent logic to maintain) |
| Risk | Medium (removes the safety net and the compute stop; changes the execute dispatch) | Very low (no running code is touched; this is the current state) |

## 3. Recommendation: (b) Keep the Thin Shell — Rationale (stronger than in the original design)

**The original design already leaned toward b; after stages 1–3 the case for b is even stronger**:
1. **The cost of "keeping in-process" has dropped to almost zero**: it is no longer "a second engine to maintain"; after stages 1–3 it is "a direct-connection shell around core" — all brain logic comes from core, and **no independent logic can drift**. Keeping it is free.
2. **Deleting it has two real costs**: ① losing the automatic fallback on agentcore failure (a regression in production availability; the occasional cold-start fallbacks rely on it) ② losing the only path that can stop compute (the red-team finding: for a pure agentcore setup the 300-second ceiling is an empty marker).
3. **The original goal of "one architecture" has been achieved**: what was asked for was "eliminate cross-language drift; a single source for the brain logic". Stages 1–3 delivered that — **whether or not in-process is kept, there is only one core brain**. Deleting in-process only removes a "shell"; it adds nothing to the "single source" goal while sacrificing two safety values.
4. **Consistent with the red team's warning against "solving a constant problem with the heaviest solution"**: a real deletion is the most aggressive way to close out, but the gain (purity) is formal while the cost (the safety net) is substantive.

## 4. Change List If (a) Delete for Real Is Chosen (for comparison; not recommended)
- execute.ts: delete the runInprocess function + the fallback branch in the agentcore try/catch (change it to throw on failure) + delete the runGenBiAgent import.
- Delete agent.ts (the in-process core) + possibly the parts of redshift.ts runSelect / athena.ts runSelectAthena along with it (if only in-process uses them).
- Simplify the semantics of the GENBI_BACKEND environment variable (no more inprocess option).
- Verification: full-chain headless + the asynchronous-execution ceiling behavior (confirm how 300 s behaves with agentcore only) + contract-guard.

## 5. Close-out If (b) Keep the Thin Shell Is Chosen (recommended · almost zero changes)
- **Zero code changes**: in-process is already a direct-connection shell around core; nothing needs to change.
- **Only a "rename for the record" in the documentation**: update the design documents to redefine the in-process backend from "an old engine awaiting deletion" to "**the direct-connection fallback shell around core + the compute-stop path + the local development path**" — an intentionally retained architectural component, not technical debt.
- **Optional hardening** (not required): add a log line / metric to the in-process fallback path so that "a fallback happened" is observable (helps operations watch agentcore health).
- Verification: none (no running code is touched); or run contract-guard once to confirm the current state is green.

## 6. Impact on "Platform-Wide Strands Unification" (link to follow-on work)
- If b is chosen, the in-process backend can later be brought into the Strands unification too (the [first-phase implementation plan](./genbi-engine-unification-implementation-plan.md) proposed "in-process on the Strands TS SDK, as the Copilot does") — at that point the in-process loop skeleton is also replaced by Strands, making it fully isomorphic to the container. **But that is a separate follow-on stage**, outside the scope of stage 4.
- If a is chosen, there is no such follow-on (in-process is deleted).

## Appendix: The Recommendation in One Sentence
**Recommend b (keep the thin shell)**: stages 1–3 have already reduced in-process to a zero-maintenance direct-connection shell around core; keeping it is free yet preserves three substantive values — "failure fallback + truly stopping compute + local development"; deleting it buys only formal purity at the cost of the production safety net. The core goal of "a single source for the brain" is achieved either way.
