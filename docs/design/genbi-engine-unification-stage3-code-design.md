# Stage 3 Code-Level Design — Strands in the Container + `import core.brain` + Retrieval Moved into the Container (Eliminating Duplicate Source ① · Red-Line Image)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is described in the [module overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> Status: **✅ implemented** (audit calibration of 2026-08-26: the original header read "in design, no code touched"). Stages 0/1/2 are complete, deployed and verified with zero regressions.
> **🔴 Major change of direction (2026-07-21)**: starting with this stage, the GenBI engine-unification effort expands from "converging the two GenBI engines" to
> **unifying the agent framework of the whole platform on Strands Agents**. The requirement from the outset was that the underlying agents be hosted on Strands
> (Anthropic's Claude SDK was evaluated as the alternative); the Copilot planner has already been validated on `@strands-agents/sdk` v1.10.0.
> Stage 3 = the first implemented template: **the GenBI container agent moves from a hand-written Converse loop to being hosted by a Strands Agent**.
> Once it runs end to end, the pattern is rolled out to the netadvisor / paramadvisor containers and to the in-process backend (each as its own red-line stage).
> Following the design-first, no-code-until-approved discipline: this document was submitted for review and sign-off before any work started.

> ⚠️ (documentation audit of 2026-08-26) This implementation plan has been fully implemented; the code is authoritative. The overall design is the [GenBI engine-unification design](./genbi-engine-unification.md). Kept as a historical implementation record.

## 0. New Top-Level Architecture (approved 2026-07-21)

```
┌─ @genbi/core  engine-agnostic [pure-logic building blocks] (stays free of framework dependencies) ────┐
│  systemPrompt / retrieval(selectRelevantTables) / sql-guard /                                         │
│  catalogText / chart / context-format                                                                 │
└────────────────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                                     │ assembled by it (import)
┌─ Strands Agent  platform-wide [standard assembly framework] ──────────────────────────────────────────┐
│  new Agent({ model: BedrockModel, tools:[...], systemPrompt })                                        │
│  takes over: Converse loop / tool dispatch / Bedrock calls / retries / event stream                   │
└────────────────────────────────────────────────────┬──────────────────────────────────────────────────┘
                      hand-written for(iter) loop skeleton → deleted
                                                     │
   genbi container · netadvisor container · paramadvisor container · in-process · Copilot (already done)
   —— all follow this pattern; Strands = the unified platform-wide agent foundation
```

- **core stays free of framework dependencies**: pure-logic building blocks that any framework can assemble. core does not import Strands (this avoids blurring the abstraction layers; the option "core contains a Strands wrapper" was rejected).
- **Strands is the assembly layer**: the container and the in-process backend each call `new Agent(...)`, inject core's systemPrompt plus the tools, and Strands runs the loop.
- **Rollout discipline**: get the genbi container running first → then roll out to the other 3 places. Each place is its own red-line stage; never change several agents at once.

## 1. Factual Baseline (read-only survey plus live tests for this stage; everything verified by `file:line` or by command)

### 1.1 Current State of the Container (4 files, 406 lines)
- `agent.js` (225): **duplicate source ①**. A hand-written Converse loop (`agent.js:186`), systemPrompt (`agent.js:47`), catalogText (`agent.js:17`), dynamic MCP tool discovery plus hot-loading (`agent.js:171-183`). The header comment states explicitly "ported from agent.ts + prompt.ts".
- `index.js` (50): HTTP `/invocations` + `/ping`, port 8080. Stage 0 already fixed the projectId pass-through (`index.js:33`).
- `mcp.js` (105): MCP-over-Gateway client plus SigV4. **The only channel through which the container executes tools.**
- `Dockerfile`: `node:20-slim` + `npm install --omit=dev` + `COPY mcp.js agent.js index.js` (**CJS, no bundle**).
- `package.json`: `"type": "commonjs"`, 6 dependencies.

### 1.2 🟢 The Foundation for Strands in the Container Passed Live Testing (verified this time)
- The Strands SDK is **pure ESM** (`"type":"module"` in `node_modules/@strands-agents/sdk/package.json`), engines node ≥ 20 (the container's node:20-slim ✓).
- **`import("@strands-agents/sdk")` from bare Node (not Next.js) succeeds**: `Agent` / `BedrockModel` / `tool` / `Tool` are all exported, and `new BedrockModel({modelId})` constructs fine.
- Core dependencies are only `@aws-sdk/client-bedrock-runtime` + uuid + yaml; all 22 peerDependencies are **optional** (the container needs just three mandatory ones — zod + mcp + otel-api — the same set as the [unified Copilot plan-and-execute engine](./unified-copilot-plan-execute.md)).
- **The Copilot planner is a mature, live template** (`platform/src/lib/copilot/plan/planner.ts`): `new Agent({model:BedrockModel, tools, systemPrompt})` + `structuredOutput` + a cancelSignal timeout.

### 1.3 🔴 The Only Real Technical Change: Container CJS → ESM
- The container is currently CJS (`require`); Strands is pure ESM. In bare Node, `require()` of a pure-ESM package throws `ERR_REQUIRE_ESM`.
- **Solution**: switch the container's `package.json` to `"type":"module"`, and in `agent.js/index.js/mcp.js` change `require`→`import` and `module.exports`→`export`. The change is mechanical but touches all 3 files (each must be verified individually).
- The core-dist artifact is CJS — `import`ing CJS from ESM is allowed (Node interop direction: ESM→CJS ✓, the reverse ✗). So core-dist does not need to change.

### 1.4 Structural Differences Between the TS Version and the Container Version (they determine the tool set for the Strands assembly; all with line numbers)
| Dimension | Container agent.js | TS agent.ts | How Strands resolves it |
|---|---|---|---|
| retrieval | ❌ none (all tables stuffed into the catalog, `:129`) | ✅ selectRelevantTables (`:129`) | **provided by core**, called before assembly |
| steps[].tool | run_redshift_sql (`:97`) | run_sql (`:200`) | recorded uniformly from the Strands event stream → §4 |
| Tool set | N dynamic MCP tools + hot-loading (`:171`) | fixed run_sql (`:161`) | assembled as the Strands tools array |
| Tool execution | MCP→Gateway (`:206`) | direct connection (`:210`) | goes through MCP inside the Strands tool callback |
| Loop skeleton | hand-written for (`:186`) | hand-written for (`:167`) | **taken over by Strands; deleted** |
| Business skills | ✅ registered skills (`:147`) | ❌ none | assembled as Strands tools (capability preserved) |

### 1.5 Dispatch in execute.ts (`execute.ts:48-109`)
- `GENBI_BACKEND=agentcore` → `invokeGenBiAgent` (the remote container); on failure it **falls back one way** to in-process (`:104`).
- **execute.ts is the orchestration shell; it neither moves into core nor onto Strands** (post-processing: chart / masking / matchedTables recomputation / usedContext).

## 2. Contract Freeze (never violated in stage 3)
- **The wire format does not change by a single character**: the remote side returns `{output:{answer,sql,columns,rows,rowCount,steps,usage}}` (parsed by agentcore-client.ts). After Strands finishes, the container's index.js still assembles and returns exactly this shape.
- **C-A**: normalization of `steps[].tool`, see §4. **C-B**: retrievalNote travels in steps; the wire format is not extended. **C-C**: usage counts only the main loop.
- The abortSignal semantics (the ceiling defined by the [GenBI asynchronous-execution design](./genbi-async-execution.md)), the one-way GENBI_BACKEND fallback, the asynchronous-execution state machine and the frontend page.tsx: zero changes.
- **The three moat gates + maskRows**: today they are embedded in the hand-written loop / execute; after the move to Strands, maskRows stays in execute post-processing (unchanged) and the read-only guard stays on the Lambda tool side (unchanged) — **Strands takes over only "loop scheduling", not governance**.

## 3. Target Shape of the GenBI Container Agent Assembled on Strands (core design)

### 3.1 The Container Agent After the Change (pseudo-code, for review)
```js
// agent.mjs (ESM) —— Strands assembles core's pure logic
import { Agent, BedrockModel, tool } from "@strands-agents/sdk";
import { systemPrompt, catalogText, selectRelevantTables } from "./core-dist/...";
import { MCPClient } from "./mcp.mjs";

async function runAgent(input) {
  // 1) prepare: introspect schema (MCP) + retrieval (core, select the relevant tables) + look up business definitions (MCP)
  //    —— these "preparation steps" are still called explicitly and recorded in steps (keeps the execution chain observable)
  // 2) assemble the Strands Agent:
  const agent = new Agent({
    model: new BedrockModel({ modelId: MODEL_ID }),   // sonnet (also fixes the opus drift)
    systemPrompt: systemPrompt(catalogText(selectedTables,...), ...),  // produced by core
    tools: mcpToolsAsStrandsTools,   // the Gateway MCP tools wrapped as Strands tools
  });
  // 3) Strands runs the loop (replaces the hand-written for(iter)):
  const result = await agent.invoke(input.prompt, { /* maxTokens, signal */ });
  // 4) extract steps + the last SQL result + usage from the Strands events/result and assemble the wire format
  return { answer, sql, columns, rows, rowCount, steps, usage };
}
```
- **Key point**: the wrapper layer from MCP tool → Strands tool (wrapping `mcp.callTool(name,args)` into a Strands `tool(...)`). This is the main piece of new code.
- **retrieval is called explicitly in the prepare phase** (it does not enter the Strands tool loop); it produces the selected tables that feed the systemPrompt — structurally identical to the TS agent.ts.
- **steps extraction**: Strands has an event stream (BeforeToolCallEvent / AfterToolCallEvent and so on, visible among the exports in §1.2); use it to record every tool call → assemble steps[].

### 3.2 Keep mcp.js (the Gateway channel is unchanged)
- Strands has MCP support too, but the container's existing `mcp.js` channel — SigV4 → Gateway (AWS_IAM) — is purpose-built (bedrock-agentcore signing). **Stage 3 keeps mcp.js and only wraps its tools as Strands tools**; it does not introduce the Strands MCP transport (lower risk; that is a later optimization).

## 4. Contract Decision C-A Awaiting Sign-off (normalizing steps[].tool)
- Current state: the container produces `run_redshift_sql`, the TS version produces `run_sql`; history.ts:14 and the Lambda EMF at line 302 depend on them.
- The tool name in the Strands event stream = the name we give the tool when wrapping it. **Recommendation**: use the semantic name `run_sql` uniformly when wrapping (aligned with in-process), and put the engine information into inputSummary. → Requires headless verification that the Observability dashboard and the History page render toolCalls correctly with the new value and that the EMF dimensions do not break.

## 5. Prerequisite Gates (must pass first; otherwise the red-line image is not started)
- **G-Strands** (new, highest priority): Strands in a **real ARM64 container image** — npm install + start + one complete question-and-answer (build the image locally with buildx and run it locally; do not push to ECR). The foundation check in §1.2 only verified the bare-Node import; the container-image layer (ARM64 + npm install resolution of optional peers) still needs verification.
- **G-V3**: container → OpenMetadata reachability (retrieval depends on OpenMetadata descriptions). Adopt **route B** from the first red-team review: implement the OpenMetadata read as a Lambda MCP tool (`fetch_om_descriptions`); the container only does the LLM re-ranking. Zero IAM / network changes. Deploy and verify this tool on its own first.
- **G-V1**: a recall regression corpus at TOPK=6 (moving retrieval into the container must not miss tables). Build a "question → expected hit tables" corpus to quantify recall loss.

## 6. Packaging (Dockerfile + prebuild)
- `package.json` adds Strands plus the mandatory peers (zod / mcp / otel-api); the `npm install` in the `Dockerfile` installs them (on ARM64 verify that optional peers do not pull in heavy packages by mistake — covered by G-Strands).
- core-dist is copied by prebuild into `infra/agent/genbi/core-dist/` (reusing the stage-2 script plus the CI consistency gate added in stage 2). The Dockerfile adds `COPY core-dist ./core-dist`.
- Tree-shaking (an item of the first-phase plan): the container imports only the core sub-modules it uses.

## 7. Step-by-Step Implementation (the red-line image cut down to the minimum)
1. **Step 0** (not red-line): the `fetch_om_descriptions` MCP tool (Lambda) + deployment + verification (G-V3).
2. **Step 1** (not red-line, local): G-Strands — build the ARM64 image locally with buildx and verify that Strands installs and runs one question-and-answer.
3. **Step 2** (not red-line, local): recall regression corpus + baseline (G-V1).
4. **Step 3** (🔴 red-line image): convert the container to ESM + assemble core on Strands + move retrieval into the container + fix the default model to Sonnet + delete dead code. Two-pass buildx deployment, several rounds of verification with zero regressions.
5. **Step 4**: full headless regression (Ask-Your-Data on both backends + retrieval in effect + recall re-test + netadvisor / paramadvisor smoke test + contract-guard).

## 8. Rollback
- Take a checkpoint tag before stage 3. Roll the image back to the previous image tag (the stage-0 image).
- The in-process backend remains (whether to delete or keep it is decided only in stage 4) — the production safety net if the red-line image fails.

## 9. Platform-Wide Rollout (after stage 3; each as its own red-line stage)
- Stage 3 gets the genbi container running → distill the standard recipe "a container agent assembled on Strands" → apply it to the netadvisor / paramadvisor containers → finally the in-process backend (TS side, using the Strands TS SDK as the Copilot does).
- Each with its own tag + contract-guard + headless verification; never several at once.

## Appendix: Anchors for Resuming After Context Compression
1. This document is submitted for review. Decision points: the assembly shape in §3, the C-A tool-name normalization in §4, the order of the three gates in §5.
2. Order of work: step 0 (OpenMetadata tool) → step 1 (G-Strands local image) → step 2 (recall corpus) → step 3 (red-line image) → step 4 (full regression).
3. Tags: the stage-2 checkpoint tag exists already; add a stage-3 checkpoint tag before stage 3.
4. Related notes: the "change of direction" section of the [GenBI engine-unification design](./genbi-engine-unification.md), the [unified Copilot plan-and-execute engine](./unified-copilot-plan-execute.md) (the live Strands template), and the pending agent-framework discussion.
