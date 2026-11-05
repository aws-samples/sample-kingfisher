# GenBI Dual-Engine Convergence — Top-Level Design (✅ implemented · retained as the module index)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is tracked in the design index. A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> Status: **✅ implemented (stages 1–4 complete); retained as the module index** (documentation audit calibration of 2026-08-26: the original status header was outdated — it read "pure design-discussion stage / no direction selected yet, no code touched yet").
> This document fixes the conclusions of two in-depth architecture surveys plus the implementation facts, for decision-making and for resuming after a context compaction.

## 0. Origin
Starting from the question "how do business definitions actually get used", the product owner dug all the way down and found that the platform has **two GenBI engines** (a TypeScript in-process engine + a JavaScript remote image), and asked for a top-level design that **converges them into a single architecture**, eliminating drift of the kind "changing a business definition means changing two places". The product owner stressed that this is a global-grade system: before any code is touched, the design must be thought through fully, be mature, and be approved.

## 1. Current state of the two engines (conclusions of survey ①, every item backed by a file:line reference)
- **inprocess**: `platform/src/lib/genbi/{agent.ts,prompt.ts,retrieval.ts,execute.ts,redshift.ts,athena.ts,schema.ts,sql-guard.ts,context.ts,memory.ts,skills.ts}` (TypeScript, runs in the platform ECS container, drives the Bedrock Converse loop directly)
- **agentcore**: `infra/agent/genbi/{agent.js,index.js,mcp.js,Dockerfile}` + `infra/lambda/genbi-skills/{index.js,rs.js}` (JavaScript, a standalone ARM64 Docker image, reached through AgentCore Runtime + Gateway + MCP)
- Switch point: `execute.ts:48-49` `GENBI_BACKEND` (default inprocess); `:85-110` a try/catch that falls back to inprocess when agentcore fails
- **The current production environment = the agentcore backend** (task definition revision 13, `GENBI_BACKEND=agentcore`, `RUNTIME_ARN` pointing at the Runtime `bgp_genbi_agent-<id>`)

### Capability comparison (the key inequalities)
| Capability | inprocess | agentcore |
|---|---|---|
| Tools | only `run_sql` | 7 MCP tools (sql / introspect / business definitions / skills / websearch — extensible) |
| Semantic table retrieval `retrieval.ts` | ✅ present (OpenMetadata descriptions + weighting by published result tables + LLM re-ranking) | ❌ absent (introspect stuffs every table into the catalog) |
| Dialect guard `cookbookGuard` | ✅ present | ❌ absent |
| Registered skills | ❌ absent | ✅ present (Lambda rendering engine) |
| Memory (conversation memory) | ❌ not wired (`memory.ts` exists, but `runInprocess` does not pass it) | ✅ AWS-managed Memory |
| EMF observability | in-process steps | ✅ CloudWatch EMF |
| MCP tool management / permissions | hand-written inside the loop | ✅ unified registration on the Gateway + IAM isolation; adding a tool does not change the image |
→ **Both copies are incomplete and evolve separately**; any convergence must be the union of their capabilities.

### Cross-language duplication (TypeScript ↔ JavaScript copied verbatim; found by survey ②)
sql-guard (`rs.js:43-57` is a literal copy) / `SCHEMA_SQL` (the same statement) / the Converse loop / systemPrompt / catalogText / business-definition formatting. **Known drift bug**: `config.ts:15` defaults to sonnet-4-6 while `agent.js:7` defaults to opus-4-6 — inconsistent (overridden by the stack env, but the source code has drifted).

## 2. AgentCore availability / failure survey (conclusions of survey ②)
- **Measured**: invoking the Runtime directly for one question ("how many tables are there") took **81.5 seconds** end to end and returned the correct answer (12 tables).
- **The truth about the 81.5 seconds** (hard evidence from the logs + the payload steps): **5 steps** (not 8 rounds! `MAX_ITERS=8` is only the ceiling against an endless loop) — introspect (5.7 s) + business definitions (0.3 s) + skills (0.2 s) + 2 × run_sql (1.4 s each). Total tool time ≈ 9 s; **the remaining ~72 s is Bedrock Converse model-inference round trips** (4–5 rounds of model thinking across the 5 steps plus generating the long answer).
- **Cold start is fast**: the log line "genbi-agent listening on :8080" proves that the container starts quickly (hundreds of milliseconds; the product owner's recollection was correct). What is slow is not the cold start and not the tools, but **the inherent latency of multi-round model inference**.
- **The speed bottleneck is unrelated to engine selection**: switching to inprocess is just as slow (same Bedrock). Speeding up is a separate topic (fewer prepare steps / caching introspect / a faster model / parallelism) and is not mixed into the engine convergence.
- **Failure resilience**: no custom timeout or retry anywhere in the chain (SDK defaults). The only resilience = the fallback in `execute.ts` + the SDK's default 3 retries.
- **The only real risk of deleting the inprocess fallback**: a cold-start race on the first call after a deployment (an operations note on the fallback cold start records that in 14 days of logs there was only one inprocess fallback, and it self-healed). It can be cured at the root with "a warm-up ping after deployment + a short timeout on the first call + 1 retry", without maintaining an entire second engine for it.
- **The fallback protects a narrow surface**: when Bedrock is throttled at the account level or has subscription problems, inprocess cannot help either (same Bedrock). The fallback can only rescue the Gateway / MCP layer (failure points #5 / #6), and falling back to the incomplete old engine = a quality downgrade.

## 3. Three convergence directions
- **Direction 1 — all AgentCore (delete inprocess)**: the purest, and isomorphic with netadvisor / paramadvisor / Copilot. Cost: loses retrieval's semantic retrieval + the dialect guard (they must be moved into the container), loses the local-development / bare-platform deployment path, every prompt change needs buildx, no fallback (compensated by a warm-up mechanism).
- **Direction 3 — engine-agnostic core + two shells**: extract `@genbi/core` (TypeScript, runtime-agnostic: systemPrompt / Converse loop / sql-guard / retrieval / business definitions / dialect); the AgentCore container also uses TypeScript and reuses core, and the inprocess fallback shell reuses it too. Key: a pluggable ToolExecutor interface (inprocess connects directly vs. agentcore goes through MCP). Has it both ways but is **the most work** (container JavaScript → TypeScript, designing the tool-executor abstraction). **Can become the template for a platform-wide unified engine abstraction for all AI capabilities** (netadvisor / paramadvisor / Copilot all share the same structure).
- **Direction 2 — all inprocess (delete the image)**: technically feasible (skills / memory are ready-made TypeScript that was never wired) but **betrays the AgentCore platform standard** + splits GenBI from the other AI capabilities. Essentially ruled out already (the requirements — skills / memory / EMF / MCP management / permissions / websearch — all point to AgentCore).

## 4. Requirement anchors (they decide the direction)
The product owner explicitly asked that the following be considered: **registered skills / Memory / EMF observability / tool and MCP management / permission policies / future websearch**. Of these 6, MCP tool management, permissions and websearch are structural strengths of the AgentCore architecture and structural weaknesses of inprocess (websearch in particular — "add a tool without changing the image" is exactly what the Gateway was designed for). → **Points strongly to keeping AgentCore as the unified architecture**; the choice is between direction 1 and direction 3.

## 5. The AI assistant's inclination (for reference; not yet decided)
Leans to **direction 1 + a lightweight warm-up mechanism**: the requirements all point to AgentCore; measurement + history prove that AgentCore almost never fails in steady state and that cold start is fast; the existing fallback protects a narrow surface and is a quality downgrade; the only real risk of deleting the fallback (the first-call race) is cured at the root by a few dozen lines of warm-up ping, so there is no need to maintain an entire second engine for it. Direction 3's "engine-agnostic core" is kept as **a longer-term unified abstraction across all AI capabilities**; it does not need to be built now for the sake of a GenBI fallback.

## 6. Decision points awaiting approval (resume here after compaction)
**Engine convergence direction — one of four**:
- (A) Direction 1 + warm-up mechanism [recommended by the AI assistant]
- (B) Direction 3 — core reuse that keeps the fallback
- (C) First only prevent drift, without a large refactoring (extract the shared parts / build drift detection; eliminate the opus/sonnet default inconsistency and the two sql-guard copies)
- (D) First write the full design document (architecture diagrams / migration path / effort / risks / rollback for directions 1 and 3), then decide

**Open sub-questions**: is it acceptable that GenBI is unavailable in local development / bare-platform deployment (the cost of direction 1)? Are there demo / customer-facing scenarios (which would strengthen the case for a fallback)?

## 7. Hard constraints (every direction must respect them)
- Contract unchanged: the `/genbi` frontend + the `GenBiResult` shape + the two `executeGenBiAsk` endpoints (synchronous + asynchronous — see [GenBI asynchronous execution](./genbi-async-execution.md))
- The 300 s abort ceiling of asynchronous execution is passed through (it can only interrupt the client's wait; it cannot kill the remote container — an honest boundary)
- Changing the `agent.js` remote image = a red line (buildx + two deployment passes, `--provenance=false --sbom=false`; see the `genbi-runtime-image-change-redline` discipline)
- Adding a tool to the Gateway / adding a skill / adding a business definition = zero image change (hot loading / pure data)
- One model setting, `BEDROCK_MODEL_ID` (the default-value drift between config and agent.js must be fixed)

## Appendix: additional findings from the surveys (independent of this design; worth handling separately)
1. **The 81-second question latency** = the inherent latency of multi-round model inference, not an engine problem. Speeding up is a separate topic.
2. **The default-value drift between `config.ts:15` sonnet and `agent.js:7` opus** — living proof that two engines inevitably drift; unify it during convergence.
3. The other AI capabilities (netadvisor / paramadvisor / Copilot) share the same AgentCore structure; the mcp.js / index.js / Dockerfile skeleton is already reused. If the core abstraction of direction 3 is built, it is the platform-wide template.
