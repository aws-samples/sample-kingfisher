# GenBI Engine Convergence — Implementation Architecture of the Full-Convergence Plan (✅ implemented)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is tracked in the design index. A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> - Status: **✅ implemented (stages 1–4 of the full-convergence plan complete)** (audit calibration of 2026-08-26: the original read "pure design"). The decision taken: **the full-convergence plan — extract a shared `@genbi/core` and converge to "one AgentCore shell"**.
> - Rollback anchor in place: `git tag pre-genbi-core-unification` (pointing at the commit preceding the refactoring; pushed to the remote).
> - Based on the factual baseline of three read-only surveys (all with `file:line` references), this document gives the target architecture + migration path + contract freeze + review findings.
> - **No product code is written in this round.** Follows the `design-first-no-code-until-approved` discipline.

> ⚠️ (documentation audit of 2026-08-26) This implementation plan has been fully implemented; the code is authoritative. The overall design is [GenBI engine unification](./genbi-engine-unification.md). Retained as a historical implementation record.

---

## 0. Decision and hard constraints

- **Direction decided**: the full-convergence plan — extract `@genbi/core` (TypeScript, the engine-agnostic brain), delete the inprocess shell, and converge to a single chain "platform orchestration shell → container brain → Gateway/MCP → Lambda tools".
- **Red line**: changing the `infra/agent/genbi/*` remote image = high risk (buildx, two deployment passes, `--provenance=false --sbom=false`); it requires several rounds of verification with zero regression and must not affect the other AgentCore capabilities (see the `genbi-runtime-image-change-redline` discipline).
- **Discipline**: a mature design + several review rounds + approval before any work; every stage independently verifiable and reversible.

---

## 1. Factual baseline (conclusions of the three surveys, referenced by this design)

### 1.1 Volume of core logic (survey ①)
- **Pure brain logic that can go into core ≈ 2200+ lines**: `prompt.ts` (45) / the Converse loop skeleton of `agent.ts` (~200 of 250) / `sql-guard.ts` (52) + `athena/sql-guard.ts` (59) / the pure part of `retrieval.ts` (~150 of 192) / the formatting part of `context.ts` (~30 of 192) / `chart.ts` (56) / the pure part of `schema.ts` (~30) / **the cookbook dialect guard chain** (guard / mask / types / seed, ~1300 in total; GenBI only uses `guard()`, which reads the pure constant `SYSTEM_DIALECT_RULES` with zero I/O) / `lineage/sql-lineage.ts` (277, pure functions).
- **Runtime coupling that must be extracted into pluggable interfaces ≈ 900 lines** → 7 interfaces (see section 4).
- **`agent.ts` + `retrieval.ts`** are the two files where "brain and coupling are most intertwined"; injecting the four interfaces **ModelClient + ToolExecutor + SchemaProvider + ContextProvider** is enough to move them into core as a whole.
- **`execute.ts` is the orchestration shell and does not go into core** (it is the caller of core).

### 1.2 Container-side structure (survey ②)
- The container **hand-writes a `for (iter<MAX_ITERS)` Converse loop** (`agent.js:186-220`), **with no AgentCore / Strands / Bedrock Agents primitive whatsoever** → **"AgentCore is only the host; the container runs its own loop" holds naturally — that is already the status quo**. The Runtime contract is only `GET /ping` + `POST /invocations` (`index.js:14,17`).
- The container's header comment states "ported from lib/genbi/agent.ts + prompt.ts" → **this hand-copied duplicate is exactly what the full-convergence plan must eliminate**.
- Business definitions = **deterministically injected into the systemPrompt during the prepare phase (always included)** (`agent.js:132-142,160`), isomorphic with inprocess. (`lookup_business_context` also remains in the model's tool list, but the determinism of the grounding comes from the forced injection in prepare.)
- **Memory lives entirely on the platform side; the container is stateless** (the container only passively receives `input.history` / `input.memory`) → core does not need to carry Memory.
- **The Dockerfile uses no esbuild and no bundling**: `node:20-slim` + `npm install --omit=dev` + `COPY mcp.js agent.js index.js` (CommonJS). → Introducing core requires **a dedicated packaging design** (COPY a compiled CJS artifact, or a `file:` local dependency); watch CJS/ESM interop + `@aws-sdk` version alignment.
- **Default-model drift**: the container hard-codes `opus-4-6-v1` at `agent.js:7` whereas platform `config.ts:15` has `sonnet-4-6` (the CDK env at `agentcore-stack.ts:211` overrides it to sonnet, so a normal deployment is consistent; a bare `docker run` drifts).
- **Broken projectId wiring**: `index.js:28-35` runAgent does not pass projectId through → inside the container it is always `proj-default`, so the per-project filtering of business definitions / skills is ineffective in multi-project setups.
- **`RUN_SQL_TOOL` is dead code** (`agent.js:72-80`, never referenced).

### 1.3 Contract and duplicates (survey ③)
- **Only 6 fields of `GenBiResult` are engine output**: `answer / sql / columns / rows (raw) / steps / usage` (agentcore additionally returns `rowCount` directly).
- **The other 5 items are post-processing in the `execute.ts` orchestration layer and are engine-independent**: `chart` (`suggestChart`) / masking of `rows` (`maskRows`) / `matchedTables` (recomputed with `parseSqlLineage`) / `usedContext` (`contextToUsedItems`) / `retrievalNote` (+ the masked rows + the `rowCount` semantics). → **Extracting core must never push these 5 items into the engine**, or "both backends produce identical output" breaks.
- **6 cross-language duplicates** (see the original table of the freeze list in section 6): sql-guard [verbatim] / SCHEMA_SQL [verbatim] / S3 Tables introspect SQL [approximate] / systemPrompt [approximate] / catalogText [approximate] / business-definition lookup + formatting [logically approximate; `body` ↔ `definition` renamed].
- **The duplicates are spread over two JavaScript runtimes**: the container `infra/agent/genbi/agent.js` (brain copy) + the Lambda `infra/lambda/genbi-skills/{index.js,rs.js}` (tool copy).

---

## 2. Key architectural judgment: after deleting inprocess, the duplicates still live in two JavaScript runtimes — "container + Lambda"

This is the most easily underestimated point of the full-convergence plan and must be nailed down first:

**The agentcore backend is not a monolith; it is distributed**:
```text
platform ECS (execute.ts orchestration shell, TS)
    │  InvokeAgentRuntimeCommand
    ▼
container (agent.js brain = hand-written loop, JS)   ← copy source ① (copied from agent.ts / prompt.ts)
    │  MCP over Gateway
    ▼
Lambda (index.js / rs.js tool execution, JS) ← copy source ② (copied from sql-guard / schema / context)
    │  Redshift Data API / Athena / DynamoDB
    ▼
data sources
```

**Deleting inprocess does not make the cross-language duplicates disappear by itself** — they live on in the two JavaScript runtimes, the container and the Lambda. For truly "one copy of the logic", **both the container and the Lambda must import the compiled `@genbi/core`**. Letting only the container import it and leaving the Lambda alone eliminates only copy source ①; copy source ② (sql-guard / SCHEMA_SQL / business-definition lookup) stays where it is — that is not convergence.

→ **The real scope of the full-convergence plan = extract core (TypeScript) + the container imports core + the Lambda imports core + delete the inprocess branch + unify the contract.** See decision point D1 in section 5.

---

## 3. Target architecture (after convergence)

```text
                    ┌────────────────────────────────────┐
                    │   @genbi/core  (TS, single source) │
                    │  ── brain (engine-agnostic) ──     │
                    │   systemPrompt / Converse loop     │
                    │   skeleton / retrieval / sql-guard │
                    │   / cookbook guard / definition    │
                    │   formatting / catalogText / chart │
                    │   / lineage                        │
                    │  ── interfaces (7 providers) ──    │
                    │   ModelClient / ToolExecutor /     │
                    │   SchemaProvider / ContextProvider │
                    │   / MemoryProvider / PublishedDS / │
                    │   Config                           │
                    └───────┬────────────────┬───────────┘
               compiled CJS │                │ compiled CJS
                            ▼                ▼
              ┌───────────────────────┐   ┌───────────────────────┐
platform ECS  │ container brain       │   │ Lambda tools          │
execute.ts ──▶│ import core.brain     │───│ import core           │
(orchestration│ ToolExecutor = MCP    │MCP│ (sql-guard / schema   │
 shell, TS;   │ ModelClient = direct  │   │  / definition lookup  │
 post-proc.   │                       │   │  use core)            │
 stays out)   └───────────────────────┘   └───────────────────────┘
```

- **The platform orchestration shell (`execute.ts`) is kept and does not go into core**: it still handles backend selection, masking, matchedTables recomputation, chart, usedContext, history, and [asynchronous execution](./genbi-async-execution.md). What is deleted is its `runInprocess` branch (see D2 in section 5).
- **Container**: the brain logic of `agent.js` is replaced by `import { runBrain } from '@genbi/core'`; the ToolExecutor implementation = via MCP (keeping `mcp.js`); the ModelClient implementation = direct Bedrock calls.
- **Lambda**: sql-guard / SCHEMA_SQL / business-definition lookup / formatting in `rs.js` / `index.js` are replaced by `import`s of the corresponding core exports. Tool execution itself (the Redshift Data API calls) stays in the Lambda.

---

## 4. Layering and interfaces of `@genbi/core` (the 7 interfaces from survey ①)

### 4.1 brain (pure logic, zero I/O; imported by the container / the Lambda / [inprocess])
- `systemPrompt` / the Converse loop skeleton (message orchestration / tool-result packaging / step recording / token accumulation / abort checks) / `catalogText` rendering / `sanitizeSelect` (Redshift) + `sanitizeReadOnly` (Athena) / the retrieval brain (catalog building / pre-filtering / tokenize / scoring / JSON parsing / fallback) / `contextToPromptText` + `contextToUsedItems` + label constants / `chart` heuristics / `SCHEMA_SQL` + the `SchemaTable` type / cookbook `guard` + `mask` + the `SYSTEM_DIALECT_RULES` seed / `parseSqlLineage`.

### 4.2 Interfaces (injection points for runtime coupling)

| Interface | Responsibility | inprocess implementation | Container implementation | Lambda side |
|---|---|---|---|---|
| **ModelClient** | Call Bedrock Converse | direct | direct | (not needed; the Lambda does not run the loop) |
| **ToolExecutor** | Execute read-only SQL → `SqlRunResult` | direct Redshift / Athena | via MCP → Lambda | the Lambda is where the executor lands |
| **SchemaProvider** | introspect → `SchemaTable[]` | direct | via MCP → Lambda | lands in the Lambda |
| **ContextProvider** | Read business-definition bodies | direct DynamoDB | via MCP → Lambda (or the container reads DynamoDB directly? see the blind spot in section 7) | lands in the Lambda |
| **MemoryProvider** | Short- / long-term memory read and write | platform side | (not in the container) | — |
| **PublishedDatasetsProvider** | Hints about published result tables | direct DynamoDB | the platform passes `input.published` | — |
| **Config** | maxIters / maxRows / modelId / poll* | env → injected | env → injected | env → injected |

**Unified defaults**: the modelId default in Config converges to `sonnet-4-6` (curing the container's opus drift at the root).

---

## 5. Design decision points awaiting approval

### D1. Should the Lambda also import core? (decides whether the "convergence" is complete)
- **D1-a: both the container and the Lambda import core** [eliminates the duplicates completely; large effort]: the Lambda packaging must also pull in the core artifact. Truly one copy of the logic.
- **D1-b: only the container imports core; the Lambda copies stay for now** [small effort; incomplete convergence]: copy source ② remains, covered by "drift detection".
- **The AI assistant leans to D1-a**: the requirement is "eliminate drift, one architecture"; D1-b leaves half a drift source and is not thorough. But the Lambda packaging effort must be counted honestly.

### D2. What to do with the inprocess branch?
- **D2-a: delete** `runInprocess` in `execute.ts` and the related imports outright [purest; no fallback].
- **D2-b: keep `runInprocess` but have it import core too** (≈ evolves into the shared-core-with-fallback plan) [an almost free fallback, because once core is extracted, inprocess degenerates into a thin shell with a "direct ToolExecutor"; a fallback is no longer a quality downgrade].
- **Note**: the full-convergence plan was chosen (leaning to delete). But the surveys prove that **once core is extracted, the cost of the fallback in the other plan is already very low** (the inprocess shell = a thin layer of direct providers). **Recommendation: make the final delete / keep decision only after core has been extracted and verified** — there is no need to hurry to delete now; deletion is the last step and is reversible.

### D3. Packaging path (how the container / Lambda import the TypeScript core)
- Compile `@genbi/core` to a CJS artifact → the container `COPY`s it and the Lambda packs it into the zip. Requires solving the TS → JS build inside the monorepo + `@aws-sdk` version alignment + CJS/ESM interop. **This is a hard effort item of the full-convergence plan; it is not free**.

---

## 6. Contract freeze list (extracting core must never change these; from survey ③)

1. The 6 engine-output fields of `GenBiResult`: `answer/sql/columns/rows(raw)/steps/usage` (+ agentcore `rowCount`).
2. The `GenBiStep` shape: `sql/ok/rowCount/error/tool/phase/inputSummary/outputSummary/durationMs` (frontend lines 137-166 + observability `summarizeToolCalls` all depend on it).
3. **The 5 execute post-processing items do not move into core**: chart / masked rows / matchedTables recomputation / usedContext / rowCount semantics.
4. The **`abortSignal` pass-through semantics** of `runGenBiAgent` (at every iteration + before every SQL) — the 300 s forced termination of [asynchronous execution](./genbi-async-execution.md) depends on it.
5. The `GENBI_BACKEND` decision + the **one-way fallback try/catch** (an abort is not swallowed; `usedBackend` is rewritten truthfully).
6. **The agentcore wire format**: the remote returns `{output:{answer,sql,columns,rows,rowCount,steps,usage}}` and `agentcore-client.ts:64-72` parses it that way — changing it falls within the image red line.
7. **The asynchronous-execution tasks state machine** (all of `tasks.ts`) + the asynchronous endpoints + the `executeGenBiAsk` signature (shared by synchronous and asynchronous).
8. **The "single read entry point" for business definitions** (`execute.ts:59-61`): core does not query again on its own; the one-read semantics of `getContextForGrounding` are preserved.

---

## 7. Review findings: blind spots / boundaries / potential bugs (continuously extended)

> This section is filled by several rounds of adversarial review. The findings surfaced by the first review are recorded first; the red-team agents then add to them.

### Blind spot — may block the plan: moving retrieval into the container requires network reachability to OpenMetadata + Secrets Manager permission
- agentcore currently **has no retrieval** (introspect stuffs every table into the catalog). The plan moves `selectRelevantTables` into the container; it depends on `fetchOmDescriptions` (reads OpenMetadata through `om-client.ts` = fetch + Secrets Manager credentials).
- **The container currently connects directly to no data source and not to OpenMetadata** (everything goes through the Lambda). Can the container (AgentCore Runtime) reach OpenMetadata over the network? Is OpenMetadata in a private subnet or on the public internet? Does the container have Secrets Manager permission? — **Unknown; must be confirmed first**.
- Alternative: make fetchOmDescriptions an MCP tool (the Lambda reads OpenMetadata; the Lambda is inside the VPC) and let the container do only the LLM re-ranking. But that adds an MCP round trip + yet another tool.
- **Risk level: high** (may decide whether retrieval can enter the container at all, or must go through the Lambda).

### Boundary — the two backends are not equal: inprocess has never had registered skills
- Survey ③: `runRegisteredSkill` / HTTP skills / the SSRF guard are **agentcore-only** (in the Lambda); inprocess has only the single `run_sql` tool.
- If D2 keeps the inprocess fallback, **skills are unavailable after a fallback** (capability downgrade). If deletion is chosen, the problem does not exist. → Strengthens the case for D2-a (delete), but also shows that "the fallback is a complete replacement" is an illusion.

### Potential bug — the Athena guard is misaligned: the JavaScript side uses the Redshift guard for Athena
- Survey ③: on the TypeScript side Athena has its own `sanitizeReadOnly` (allows SHOW / DESCRIBE), but **the JavaScript side reuses `sanitizeSelect` from `rs.js`** (the Redshift version) for Athena. When the guards are unified in core, replacing the Lambda's guard directly with core's Athena guard **changes the allow rules** (SHOW / DESCRIBE go from rejected to allowed) — whether this affects existing Athena query behavior must be confirmed.
- **Risk level: medium** (the behavior change must be covered by regression tests).

### Contract risk — systemPrompt unification: the two prompt versions differ substantively
- The TypeScript title reads "Kingfisher big-data governance platform" whereas the JavaScript one reads "big-data governance platform" (without "Kingfisher"); the JavaScript version adds a skillsBlock, and the published / memory sections are concatenated at different positions. When unifying into core, **one authoritative version must be chosen**, otherwise model behavior drifts. Needs a manual line-by-line diff to finalize.

### Hidden bugs — fix in passing: broken projectId wiring + default-model drift + `RUN_SQL_TOOL` dead code
- When the container entry point is refactored, the projectId pass-through must be fixed at the same time (otherwise per-project filtering of business definitions fails in multi-project setups), the default model unified to sonnet-4-6, and the dead code deleted. **But all of these changes fall within the image red line** and must be included in the image verification.

### Scope — intermediate-state risk: changing the image = red line; must be staged and reversible
- Both the container and the Lambda must change, and changing the image means buildx with two deployment passes. **The intermediate state** (core extracted, but the container / Lambda not yet fully switched) must be independently deployable + verifiable + reversible at every step. See the migration path in section 8.

---

## 8. Migration path (draft; every stage independently verifiable and reversible)

> Ordering principle: **first build core without affecting production → switch the consumers one by one → delete inprocess last**. A contract-guard snapshot + verification at every stage.

- **Migration step 0**: extract `@genbi/core` (a purely additive package: move the brain logic in + define the 7 interfaces). **inprocess is switched first to import core (direct providers in the same process)** — this is the safest first step: it does not touch the image or the production agentcore; only the TypeScript side goes through core, verifiable locally and in a bare deployment. Contract unchanged.
- **Migration step 1**: the Lambda imports the pure-logic part of core (sql-guard / SCHEMA_SQL / business-definition lookup / formatting) — eliminates copy source ②. Changes the Lambda (not the image red line; a Lambda deployment is lighter than a container one), verified separately.
- **Migration step 2**: the container imports core.brain (including retrieval, if the OpenMetadata-reachability blind spot is confirmed reachable) — eliminates copy source ①. **This step is the image red line**; several rounds of verification with zero regression. Fix the hidden bugs (projectId / model / dead code) at the same time.
- **Migration step 3**: final decision on D2 (delete / keep inprocess). If delete: remove the `runInprocess` branch from `execute.ts`.
- The contract freeze (section 6) holds throughout; asynchronous execution and the frontend change by zero.

---

## 7bis. Conclusions of the three-way red-team review (all with evidence, 2026-07-21)

### Red team 1 (container network / permissions) → the OpenMetadata-reachability blind spot downgraded from "high risk, blocked" to 🟡 yellow
- All three AgentCore Runtimes are `NetworkMode:PUBLIC` without a VPC (`agentcore-stack.ts:207`); but **OpenMetadata is exposed through public CloudFront anyway (no WAF / edge authentication, `om-service-stack.ts:105-115`), and the platform itself reaches OpenMetadata through that public URL** → the container's network path to OpenMetadata is **open** (my earlier "cannot reach OpenMetadata" was a misjudgment).
- The only gap: the container's `GenbiRuntimeRole` **has no secretsmanager permission** to read the OpenMetadata bot token (`agentcore-stack.ts:104-118`); the Bedrock re-ranking permission already exists.
- **Recommended route B**: make the OpenMetadata read a Lambda MCP tool (the skills Lambda already has secretsmanager + public egress, `agentcore-stack.ts:69`); the container only does the LLM re-ranking, replicating the existing "privileged I/O in the Lambda, LLM in the container" paradigm.
- **Yellow-light dependency**: the current "public, no edge authentication" topology of OpenMetadata; should OpenMetadata later be put behind WAF or made private, both the container and the non-VPC Lambda would be cut off.

### Red team 2 (packaging dependencies) → 🟡 yellow; the biggest pitfall is "pure and impure mixed in the same file"
- The truly pure logic (`prompt.ts` / `sql-guard.ts` / `chart.ts` / `sql-lineage.ts` / cookbook `guard/mask/types/seed` / business-definition formatting) has **zero third-party dependencies**, compiles cleanly to CJS, and all three parties can require it.
- **But `retrieval.ts:16` constructs `new BedrockRuntimeClient` at module top level, `context.ts` mixes in DynamoDB CRUD, and `registry.ts→store→aws/dynamodb.ts` constructs a DynamoDB client at top level** → naively moving whole files into core would drag in 3 AWS SDKs, and the version conflict (container `^3.700` vs platform `^3.1019`) would become real. **Pure and impure must be separated at function level**.
- Further friction: the `@/` alias is everywhere (every import must be rewritten when extracting); no workspace; the Lambda is a bare zip without node_modules (a new build pipeline is needed).
- **Recommended "option A (lightest start)"**: core stays as TypeScript source inside the platform (`genbi/core`); the platform imports it natively through `@/` with **zero compilation**; a small script for the container + Lambda compiles this one folder to CJS with tsc and copies it in → upgrading today's "manual porting" to "mechanical compile-and-copy", which cures drift at the root. **sql-guard, identical verbatim (`rs.js:43-56` == `sql-guard.ts:8-52`), is the zero-risk first test bed; systemPrompt has already drifted (the container version adds skillsBlock) and must be reconciled before extraction, and because it hits the image red line, both backends must be re-verified headlessly**.

### Red team 3 (adversarial review) → 8 real problems confirmed + the cost-effectiveness of the plan questioned
Real problems (all with line numbers):
- **Finding 1 — the contract freeze omits the value domain of `steps[].tool`**: inprocess = `run_sql` (`agent.ts:213`) vs agentcore = `run_redshift_sql` (`agent.js:116`); the aggregation into storage at `history.ts:14` and the EMF emission in the Lambda at `index.js:302` both key on it. Unification necessarily breaks one of them.
- **Finding 2 — `retrievalNote` collides with the wire-format red line (item 6 of section 6)**: retrieval in the container would produce it, but the wire format has no such field → drop it, or extend the wire format = break the red line we froze ourselves.
- **Finding 3 — changing the Lambda in migration step 1 immediately changes production query behavior**: the Lambda's Athena uses the Redshift guard; switching to the core guard changes the SHOW / DESCRIBE allow rules on the spot while the container has not yet switched → the intermediate state changes production; not "behavior-neutral".
- **Finding 4 — deleting inprocess removes the only path that can "stop the compute"**: only the inprocess abort truly interrupts Bedrock (`agent.ts:208`); the agentcore abort only ends the client's wait and cannot kill the remote compute, so on the only remaining path the 300 s ceiling merely "marks timeout".
- **Finding 5 — the container has no tree-shaking**: the cookbook seed is 863 lines covering 8 engines, GenBI uses only redshift / athena, yet the whole package goes into the image and into memory → core must be split into fine-grained entry points.
- **Finding 6 — the Lambda is a raw directory without node_modules**: "a lighter deployment than the container" is an underestimate; it goes from "zero build" to "has a build".
- **Finding 7 — three runtimes with no atomic deployment and no version alignment**: between migration steps 1 and 2 there is necessarily a skew window where "the Lambda has switched to core while the container is still the hand copy", with no contract test to cover it.
- **Finding 8 — the broken projectId wiring is a production correctness bug**: `index.js:28-35` does not pass it through → in production agentcore, the per-project filtering of business definitions / skills is **currently** ineffective; it should be fixed independently and first, not bundled into the red-line refactoring.

Doubts: **doubt 1 — moving retrieval into the container risks a "recall regression"** (full-table grounding → TOPK=6; the model picking the wrong table does not trigger the fallback; Chinese tokenization is weak; questions answerable today might become unanswerable; needs a regression corpus to quantify); **doubt 2 — cross-language accounting of usage tokens** (whether the tokens of retrieval's Bedrock call are counted must match inprocess); **doubt 3 — container → OpenMetadata reachability + permissions** (= red team 1, already judged yellow).

**Red team 3's overall verdict (the sharpest; it must be faced)**: the drift actually complained about is, per section 1.3 of the survey, **5 of the 6 duplicates being constants / strings / approximate text**. Yet the full plan uses "rewrite the loop skeleton + invent 7 provider interfaces + compile and distribute core across three runtimes + conquer CJS packaging in a container without tree-shaking" — **the heaviest solution** — to solve a problem **mainly caused by constants**. And the most fragile landing point, migration step 2, stacks four high-risk things into the same red-line image deployment (recall regression + OpenMetadata reachability + packaging + several contract adjustments); if any one of them fails, the two buildx passes must be redone.

---

## 10. Overall verdict and recalibration of the plan (for approval)

The three red teams jointly expose an honest conclusion: **"extract core" is the right foundation, but "the full-convergence plan (delete inprocess + retrieval into the container + unified loop skeleton + distribution across three runtimes)" piles a lot of high-risk work on top of that foundation — work that does not necessarily address the actual pain point.** The evidence recalibrates the solution space into three tiers:

| Dimension | **Option A — pure-logic core + keep inprocess** (the lightweight shared-core-with-fallback plan) | **Option B — the full-convergence plan** (delete inprocess + retrieval into the container + unified loop) | **Option C — shared constants only + codegen + CI** |
|---|---|---|---|
| Eliminates drift | ~90% (all pure logic shared · single source) | ~100% | ~90% (constants from one source) |
| "One architecture" | ✅ core = single brain source; both shells reuse the same core | ✅ one shell | ❌ still two shells; only the constants share a source |
| Retrieval into production | not yet (stays inprocess-only, or evolves later) | yes | no |
| Red-line image changes | one (the container imports core's pure logic) | several stacked (core + retrieval + loop rewrite + contract adjustments) | one (the container imports the constants) |
| Availability | **not reduced**; and once core is unified, the inprocess fallback is upgraded from "incomplete old engine" to "full-quality fallback" | **reduced** (more hops; no fallback that can stop the compute — finding 4) | not reduced |
| Effort | medium | high | low |
| Main risk | systemPrompt reconciliation needs headless re-verification of both backends | recall regression (doubt 1) + OpenMetadata reachability (doubt 3) + packaging + findings 1 / 2 / 7 — several contracts stacked into one red-line deployment | treats the symptom; the loop skeleton still exists twice and capabilities remain unequal |
| Evolvability | ✅ once core is stable, deleting inprocess / moving retrieval into the container (the original migration steps 2 and 3) can be done at any time | end state | hard to evolve into true unification |

**The AI assistant recommends: Option A (pure-logic core + keep inprocess).** Reasons:
1. **It genuinely meets your core requirement** — `@genbi/core` becomes the single brain source where "a change in one place takes effect everywhere"; both shells (container / Lambda / inprocess) import it, and "one top-level abstraction" is realized.
2. **It cures ~90% of the drift** (the opus/sonnet defaults, the two sql-guard copies, and the prompt fork you complained about are all in the pure logic), at a cost far below the full plan.
3. **It does not take on the full plan's high risks**: it does not delete inprocess (keeping the only fallback that can stop the compute — finding 4), does not force retrieval into the container (avoiding the recall regression, doubt 1, and the OpenMetadata permission question, doubt 3), and does not stack several contract adjustments into one red-line deployment.
4. **Availability actually improves**: once core is unified, the inprocess fallback is no longer an "incomplete old engine"; a fallback = full quality.
5. **It evolves naturally**: once Option A has landed and core is stable, if you still want the full plan's "one shell", deleting inprocess / moving retrieval into the container is the natural next step (the original migration steps 2 and 3), by which time the risk has been isolated by core and can be verified separately.

**Note**: Option A is in essence "the evidence has led us from the full-convergence plan back to a lightweight version of the plan that keeps the fallback". You originally chose the full plan between the two; the red teams have shown with real code that the other plan (especially this version that extracts only pure logic) has a higher return on investment, lower risk, and does not sacrifice the core goal of "one architecture". This is exactly the value of the request to "review several more times and find the problems" being delivered — I am obliged to report it truthfully rather than execute the full plan blindly because it had been approved.

**Independent item to do first (recommended under any option)**: the broken projectId wiring (finding 8) is a **production correctness bug** with a one-line fix; it is recommended to **fix and verify it independently first**, not bundled into any large refactoring.

**If Option B (the full plan) is insisted upon**: three verifications must be completed before any work — ① a real test of container → OpenMetadata reachability (via red team 1's route B); ② quantification of the TOPK=6 recall regression with a corpus (doubt 1); ③ completing the freeze of the three contracts `steps[].tool` / `retrievalNote` / `usage` and deciding their unification (findings 1 and 2, doubt 2). And migration step 2 must be split into several red-line deployments, not stacked.

---

## 9. Appendix: findings independent of this design, worth handling separately
1. The 81 s question latency = the inherent latency of multi-round model inference, not an engine problem (speeding up is a separate topic).
2. The Athena guard misalignment (an existing bug in its own right; cured in passing by extracting core).
3. netadvisor / paramadvisor / Copilot share the same AgentCore structure — core's ToolExecutor / ModelClient abstraction can become the platform-wide unified template for AI engines (longer term).
