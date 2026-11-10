# Stage 3 Red-Line Image Step — Execution Path (fine-grained; work starts only after review)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is described in the [module overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> - Status: **✅ executed and implemented** (audit calibration of 2026-08-26: the original header read "execution-path design, no code touched"). All three prerequisite gates passed (G-Strands / G-V3 / G-V1).
> - This document is the **step-by-step construction plan** for step 3 of stage 3 (Strands in the container + import core + retrieval moved into the container).
> - 🔴 This is a red-line image (the GenBI runtime image change red line): it changes the remote image under `infra/agent/genbi/*`,
>   deploys with two buildx passes using `--provenance=false --sbom=false`, verifies zero regressions over several rounds, and does not affect netadvisor / paramadvisor.
> - Rollback anchors: the checkpoint tag taken after the gates and before the red line, plus the production image tag of stage 0.

> ⚠️ (documentation audit of 2026-08-26) This implementation plan has been fully implemented; the code is authoritative. The overall design is the [GenBI engine-unification design](./genbi-engine-unification.md). Kept as a historical implementation record.

## 0. General Construction Principles (production-grade red-line discipline)
1. **Touch production only after full local verification**: build the new image locally with buildx → run it locally with `docker run` and real credentials through real questions (both engines, Redshift + Athena) → confirm the wire contract matches byte for byte → **only then** push to ECR and deploy.
2. **The wire contract is byte-for-byte unchanged**: the container returns `{output:{answer,sql,columns,rows,rowCount,steps,usage}}`, and agentcore-client.ts parses it accordingly. **Not a single field may be missing or changed.** This is the red line within the red line.
3. **Change only this one thing at a time**: this step does only "Strands in the container + retrieval + fix the model / delete dead code"; it does not touch the Lambda, execute.ts or the frontend.
4. **Failure means rollback**: if any step fails verification, revert to the tag; never deploy with a known defect. The in-process backend is the production safety net (touched only in stage 4).

## 1. agent.js Behaviors That Must Be Preserved (the easiest to lose when moving to Strands; checked one by one)

| # | Behavior | Current location | How the Strands version preserves it |
|---|---|---|---|
| B1 | **Multi-turn conversation**: history(-6) as a prefix of alternating user/assistant messages | agent.js:164-169 | The Strands Agent supports injecting message history; or use conversationManager |
| B2 | **Payload truncation**: when rows > MODEL_ROWS (50), feed the model only the first 50 rows + shown_rows | agent.js:215-217 | Truncate inside the tool wrapper callback before returning to Strands |
| B3 | **last extraction**: the last successful SQL result is used for display (sql/columns/rows/rowCount) | agent.js:212 | Capture res in the tool callback; accumulate last in a closure |
| B4 | **steps execution chain**: every tool call records one step (tool/phase/sql/inputSummary/outputSummary/ok/rowCount/durationMs) | agent.js:110-126 | Record from the Strands event stream (Before/AfterToolCallEvent) or inside the tool callback |
| B5 | **prepare steps**: introspect + lookup_business_context + list_registered_skills are prefetched and recorded as steps | agent.js:129-157 | Keep: call these MCP tools explicitly before assembling the Agent (they do not enter the Strands tool loop) |
| B6 | **retrieval** (new): selectRelevantTables selects tables → catalogText | (none; new) | Call core.selectRelevantTables in the prepare phase (injecting a ModelClient + the OpenMetadata tool from G-V3) |
| B7 | **Hot-loaded tools**: dynamically discover MCP tools, excluding those already prefetched | agent.js:171-183 | listTools → filter → wrap into the Strands tools array |
| B8 | **Errors returned truthfully to the model**: a failed tool records a step and returns the error so the model can self-correct | agent.js:206-207 | catch in the tool callback → return {success:false,error} to Strands |
| B9 | **usage accumulation**: inputTokens/outputTokens | agent.js:190-191 | Extract from Strands result.metrics |
| B10 | **MAX_ITERS fallback when the limit is reached**: returns "maximum number of reasoning steps reached" | agent.js:222 | Strands maxIterations configuration + fallback text |
| B11 | **projectId pass-through** (fixed in stage 0): inject projectId into every tool call | agent.js:206 | Inject in the tool callback (the closure captures input.projectId) |
| B12 | **contextToPromptText business-definition injection**: businessContext goes into the systemPrompt | agent.js:135-141 | Reuse (switch to core's formatter for uniformity) |

## 1bis. 🔬 Deep Review of the Strands API Before Sub-step b (live tests / source verification, 2026-07-21)
> Reason: a deep review was requested to prevent omissions. It surfaced 3 points the original design had missed, all verified to have a solution. These are the exact basis for the construction of sub-step b.

### Verified Real Strands API (live-tested with a local API probe)
- **tool inputSchema = JSON Schema** (not Zod! `function-tool.d.ts`) → **the inputSchema of an MCP tool can be passed straight through** to the Strands `tool()`, zero conversion.
- **tool callback `(input, toolContext)`**: input receives `{sql:...}`; toolContext = {toolUse,agent,invocationState,interrupt}.
- **AgentResult**: `{stopReason, lastMessage, metrics, traces, ...}`. answer = the join of `lastMessage.content[].text`.
- **usage**: `result.metrics.accumulatedUsage={inputTokens,outputTokens,totalTokens}` (live tests show cycleCount and the per-cycle details are available too).
- **Multi-turn history**: `new Agent({messages:[{role,content:[{text}]}]})` — injection verified to work in live tests.
- **model**: accepts a BedrockModel instance or a modelId string.

### The 3 Omissions Found, with Solutions (all verified)
1. **🔴 There is no maxIterations; use `limits.turns` instead**: AgentConfig `limits:{turns?,outputTokens?,totalTokens?}` (types/agent.d.ts:112). turns=8 corresponds to the original MAX_ITERS=8; when a limit is exceeded, **stopReason='limitTurns'/'limitTotalTokens' stops gracefully without throwing**. → Stronger than the original MAX_ITERS (adds a token circuit breaker). B10 = set limits + check stopReason and fill in the fallback text.
2. **🔴 Record steps inside the tool callback (not via the hooks event stream)**: live tests show the callback receives the input arguments, so wrap t0 → mcp.callTool → t1 → push step inside the callback. B2/B3/B4/B11 are all done in this one closure layer — simpler and more reliable than hooks.
3. **🟡 Strands prints `🔧 Tool #N` progress to stdout by default**: pass `printer: false` to the constructor to turn it off (agent.d.ts printer?:boolean). Keeps the container logs clean.

### Exact Implementation of Behaviors B1–B12 (finalized after the deep review)

| # | Behavior | Exact implementation |
|---|---|---|
| B1 | Multi-turn history(-6) | `new Agent({messages})` with alternating user/assistant |
| B2 | Payload truncation when rows > 50 | Truncate inside the tool callback, then return to Strands |
| B3 | Last SQL result | A closure inside the tool callback captures the successful columns/rows/sql/rowCount |
| B4 | steps execution chain | push step inside the tool callback (no hooks) |
| B5 | prepare steps (introspect + business definitions + skills) | Explicit mcp.callTool before assembling the Agent; each records a step |
| B6 | retrieval (new) | core.selectRelevantTables in the prepare phase (injecting bedrockModelClient + fetch_om_descriptions) |
| B7 | Hot-loaded tools | mcp.listTools → filter → map into the Strands tool array |
| B8 | Error return for self-correction | catch in the tool callback → return {success:false,error} (Strands passes it back to the model) |
| B9 | usage accumulation | `result.metrics.accumulatedUsage` |
| B10 | Iteration fallback | `limits:{turns:8}` + check stopReason==='limitTurns' and fill in the fallback text |
| B11 | projectId pass-through | Inject inside the tool callback (the closure captures input.projectId) |
| B12 | Business-definition injection | Look up in prepare → core contextToPromptText → into the systemPrompt |

## 2. File-by-File Change List

### 2.1 package.json (CJS→ESM + add Strands)
- `"type": "commonjs"` → `"type": "module"`.
- Add dependencies: `@strands-agents/sdk` plus the mandatory peers `zod` / `@modelcontextprotocol/sdk` / `@opentelemetry/api` (G-Strands verified this set installs cleanly on ARM64, 126 packages).
- Keep the existing 6 dependencies (bedrock-runtime / signature-v4 / sha256 / protocol-http / undici / credential-provider) — mcp.js still uses them.

### 2.2 mcp.js (CJS→ESM, logic unchanged)
- `require`→`import`, `module.exports`→`export`. **The authentication / signing logic does not change by a single character** (G-Strands verified the SigV4 channel is correct; do not touch it).

### 2.3 index.js (CJS→ESM, logic unchanged)
- `require`→`import`. The HTTP `/invocations` + `/ping` contract is unchanged; it still assembles and returns `{output: runAgent(...)}`.

### 2.4 agent.js (the core rewrite: hand-written loop → core assembled on Strands)
- `require`→`import`; `import` systemPrompt / catalogText / selectRelevantTables / sql-guard / chart from core-dist.
- **prepare phase (kept + extended)**: introspect (B5) → **retrieval selectRelevantTables** (B6, using core + ModelClient + the G-V3 OpenMetadata tool) → lookup_business_context (B5) → list_registered_skills (B5). Each records a step.
- **Assemble the Strands Agent**: model = BedrockModel (Sonnet; fixes default-model drift item B) + systemPrompt (produced by core, including the tables selected by retrieval) + tools = the wrapped MCP tools (B7).
- **The tool wrapper layer** (the core of option ①): each MCP tool → a Strands `tool({name,inputSchema,callback})`; inside the callback: `mcp.callTool` + inject projectId (B11) + truncate the payload (B2) + capture last (B3) + record the step (B4) + return errors (B8).
- **Run Strands**: `agent.invoke(prompt, {maxTokens})`, with the maxIterations fallback (B10).
- **Assemble the wire format**: extract answer from the Strands result + metrics→usage (B9) + the last and steps from the closure → return `{answer,sql,columns,rows,rowCount,steps,usage}`.
- **Delete** the dead RUN_SQL_TOOL code (agent.js:72-80).

### 2.5 Dockerfile
- `COPY core-dist ./core-dist` (the prebuild artifact).
- `COPY *.mjs` (or keep .js with type:module). CMD unchanged.

## 3. Local Verification Matrix (must be all green before pushing to ECR)

| Check | Method | Pass criterion |
|---|---|---|
| V-build | buildx ARM64 --load | The image builds successfully; core-dist is inside the image |
| V-start | docker run + /ping | {status:healthy} |
| V-Redshift question | docker run + real credentials + POST /invocations (engine=redshift) | Returns real figures; steps contain run_redshift_sql |
| V-Athena question | Same as above with engine=athena | Returns real data; steps contain run_athena_sql |
| **V-wire contract** | Compare the key set of the returned JSON | Strictly = {output:{answer,sql,columns,rows,rowCount,steps,usage}} |
| V-retrieval | Check that steps contain select_relevant_tables and that the selected tables are reasonable | retrieval is in effect |
| V-business definitions | Ask a question that uses a business definition | steps contain lookup_business_context; the definition is injected |
| V-multi-turn | A payload carrying history | Context carries over correctly |
| V-skills | When the workspace has registered skills | list_registered_skills + run_registered_skill are usable |
| V-projectId | A payload for a non-default workspace | Tool calls carry the real projectId (no collapse to default) |

## 4. Deployment (two buildx passes; the standard red-line procedure)
- **Prerequisite**: `bash scripts/genbi-core-prebuild.sh` refreshes core-dist (the CI gate already guarantees consistency).
- buildx build + push to ECR, tag = the new commit SHA. Verify a single-platform manifest (avoids the attestation-index trap).
- `cdk deploy BgpAgentCoreStack -c genbi-runtime=1 -c genbi-agent-tag=<newsha>` (with the gate that keeps the Runtime and points it at the new image).
- **Online verification**: pull the ECR image and confirm the contents of /app = the new code; headless web regression of Ask-Your-Data on both backends; contract-guard verify; netadvisor / paramadvisor smoke test (confirm the other AgentCore agents are unaffected).

## 5. Rollback Plan
- Failure in the local phase: the git changes have not been pushed; simply revert the working tree.
- Problem found after deployment: `cdk deploy -c genbi-agent-tag=<stage-0-image-tag>` rolls the image back (the stable stage-0 image) and the Runtime returns to the old version within seconds; or switch `GENBI_BACKEND` to inprocess (the one-way fallback in execute.ts, the production safety net).
- Code rollback: `git reset --hard <checkpoint-tag-before-the-red-line>`.

## 6. Step-by-Step Construction Order (each step verified locally; not written all at once)
1. **Sub-step a**: convert package.json + mcp.js + index.js to ESM (do not touch the agent.js logic; agent.js is converted to ESM as well but its loop stays for now) → local build + start + question, verifying "pure ESM conversion with zero behavior change" (isolates the ESM-migration risk).
2. **Sub-step b**: agent.js brings in Strands to assemble core + the tool wrapper + retrieval, replacing the hand-written loop → the full local verification matrix of §3.
3. **Sub-step c**: fix the default model to Sonnet + delete the dead RUN_SQL_TOOL code.
4. **Sub-step d**: buildx push to ECR + deployment + online verification per §4.
- The value of **verifying sub-step a separately first**: it decouples the two risks "CJS→ESM migration" and "Strands rewrite" — first prove that the ESM conversion by itself does not break existing behavior (still the hand-written loop), then layer Strands on top. A failure in either step can be pinpointed exactly.

## Appendix: Decision Points (all decided on 2026-07-21, based on live tests)
1. ✅ The step order of §6 (verify the pure ESM conversion first, then layer Strands) — approved.
2. ✅ §2.4 retrieval in the prepare phase (approach A; it does not enter the Strands tool loop) — **decided by an A/B comparison in live tests**:
   the same batch of 6 game-domain questions against real Bedrock, approach A (proactive retrieval in prepare) vs. approach B (retrieval as a Strands tool that the model calls on its own):
   **table-selection hits A 6/6 = B 6/6** (equivalent quality); B had **0 blind writes** (the failure mode originally feared — "the model skips retrieval and writes SQL directly" — was disproved;
   Sonnet always called retrieval proactively). The only differences: A costs nothing extra, B spends one more model round trip per question (~1800 tokens per question, 11349 in total for the 6 questions).
   → **The reason for choosing A was corrected from "B risks blind writes" (disproved) to "B has no quality advantage, spends more tokens, and breaks consistency between the two backends (the TS in-process backend already retrieves proactively in prepare)"**.
   Contract-wise, A's retrieval is recorded as a prepare-phase step (frozen as C-B).
3. ✅ B1 multi-turn conversation: inject via Strands messages (isomorphic to the current alternating user/assistant form; low risk) — approved.
