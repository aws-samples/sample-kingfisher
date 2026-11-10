# GenBI Engine Convergence — Implementation Plan for Full Convergence (✅ implemented)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is tracked in the design index. A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> - Status: **✅ implemented (the full-convergence plan is complete)** (audit calibration of 2026-08-26: the original read "pure design"). The decision taken: **the full-convergence plan** (extract `@genbi/core` + delete inprocess + retrieval into the container + unified loop skeleton, converging to one AgentCore shell), with the explicit instruction "**produce the detailed implementation design before any work starts**".
> - This document is the final blueprint submitted for review before work starts: every risk exposed by the three red teams is designed into a mitigation and a verification gate.
> - Rollback anchor: `git tag pre-genbi-core-unification` (pointing at the commit preceding the refactoring; pushed to the remote).
> - Accompanying standing orders: contract-guard must run before and after every change; tag before big changes; verify only through the web pages; the i18n scanner must run before any frontend change; the red line on changing the GenBI runtime image.

> ⚠️ (documentation audit of 2026-08-26) This implementation plan has been fully implemented; the code is authoritative. The overall design is [GenBI engine unification](./genbi-engine-unification.md). Retained as a historical implementation record.

---

## 0. Overall implementation principles (responding to red-team finding 7: no atomic deployment)
1. **Burn down risk in reverse order**: tackle the hardest first (container + retrieval + packaging), keep inprocess untouched as the production safety net, and **delete inprocess as the last step**. (Corrects the mistake of the original migration path in section 8 of the architecture document, which put the safe, low-value core-extraction step first — a red-team finding.)
2. **Every stage independently deployable, verifiable and reversible**; contract tests cover version skew across stages.
3. **Red-line image deployments (the container) are split as finely as they can possibly be**; never stack several high-risk changes into the same buildx.
4. **A contract-guard snapshot before and a verify after every stage**; any GenBI change requires headless re-verification of both backends (inprocess + remote agentcore).

---

## 1. The definite form of `@genbi/core` (responding to red team 2 on packaging + finding 5 on tree-shaking)

### 1.1 Location and artifacts (adopting red team 2's "option A, lightest start")
- **Location**: `platform/src/lib/genbi/core/` (TypeScript source, kept inside the platform).
- **Platform consumption**: native `@/lib/genbi/core/*` imports, **zero compilation step** (the platform already consumes TypeScript source directly; `tsconfig noEmit:true`).
- **Container / Lambda consumption**: a new standalone `tsconfig.core.json` (`module:commonjs, target:ES2020, declaration:true`) that **compiles only the core directory** to CJS + `.d.ts`; the artifacts are copied into `infra/agent/genbi/core-dist/` and `infra/lambda/genbi-skills/core-dist/`.
- **Upgrading today's "manual porting" to "mechanical compile-and-copy"** — this is precisely the mechanism that cures drift at the root.

### 1.2 core contains only truly pure logic (red team 2's iron rule: no AWS SDK dragged in)
Included in core (**zero third-party runtime dependencies**, all verified):
- `systemPrompt` (`prompt.ts`, zero imports)
- `sanitizeSelect` (Redshift) + `sanitizeReadOnly` (Athena) (the two guard versions, zero imports)
- `suggestChart` (`chart.ts`, type-only import)
- `parseSqlLineage` (`sql-lineage.ts`, pure function, zero dependencies)
- cookbook `guard` / `mask` / `types` / `SYSTEM_DIALECT_RULES` (all type-only)
- business-definition formatting `contextToPromptText` / `contextToUsedItems` / `CONTEXT_KIND_LABEL` / `CONTEXT_SECTION_TITLE`
- `catalogText` rendering, the `SCHEMA_SQL` constant, the `SchemaTable` type
- the Converse loop skeleton (engine-agnostic once ModelClient / ToolExecutor are injected)

**Not in core** (I/O adapters; left with each consumer): the Bedrock call body of `selectRelevantTables`, `fetchOmDescriptions`, DynamoDB CRUD, memory / history, the dynamic recipes of cookbook `store` / `registry`.

### 1.3 Fine-grained entry points (responding to finding 5: the container has no tree-shaking)
core **has no single barrel index**. Sub-entry points are exposed on demand, and the container requires only what it uses:
- `core/prompt`, `core/sql-guard`, `core/dialect` (exports only the rules of the two engines redshift + athena; **does not re-export the entire 863-line seed**), `core/loop`, `core/context-format`, `core/catalog`, `core/lineage`, `core/chart`.
- **Splitting the cookbook seed**: `core/dialect` statically imports only the redshift / athena rule files; the glue / flink / emr / sync / s3tables rules **are not reached from the GenBI entry points** → the container image contains no unrelated recipes.
- Verification: after compilation, test that the transitive closure of `require('core/dialect')` contains no glue / flink text.

---

## 2. Completing the contract freeze (responding to findings 1 and 2 + doubt 2)

Before work starts, these three unification decisions (omitted from the original section 6) are fixed:

### C-A. Value domain of `steps[].tool` (finding 1)
- **Current state**: inprocess = `run_sql` (`agent.ts:213`), `select_relevant_tables`; agentcore = `run_redshift_sql` / `run_athena_sql` (`agent.js:116`). `history.ts:14 summarizeToolCalls` + the Lambda EMF (`index.js:302`) both aggregate on it.
- **Unification decision (final)**: the core loop uniformly produces the **semantically stable tool name** `run_sql` (engine-neutral); the engine information goes into `steps[].inputSummary` or a new read-only metadata field. **The history and EMF sides are adapted at the same time**: `summarizeToolCalls` and the Lambda EMF dimensions are changed to read the unified name. → Aligned in one go; nothing left half new, half old.
- **Verification**: headless re-verification of the continuity of toolCalls in the observability dashboard / history pages; confirm that the EMF metric dimensions are not broken.

### C-B. `retrievalNote` and the wire format (finding 2; avoiding breaking our own red line)
- **Problem**: retrieval in the container produces a retrievalNote, but the remote wire format (the red line — item 6 of section 6 of the architecture document) has no such field.
- **Decision (final)**: **do not extend the top-level wire fields**. The retrieval result is recorded as one `steps[]` entry (phase=`prepare`, tool=`select_relevant_tables`, outputSummary = matched tables + fallback marker), passed through the already frozen steps channel. If the execute side wants to display retrievalNote, it extracts it from that step. → The wire format `{answer,sql,columns,rows,rowCount,steps,usage}` **does not change by a single character**; the wire part of the image red line is not touched.

### C-C. Accounting of usage tokens (doubt 2)
- **Problem**: do the tokens of retrieval's Bedrock re-ranking call (`retrieval.ts:161`) count toward `usage`? inprocess currently **does not** count them.
- **Decision (final)**: the usage of the core loop **accumulates only the main question-answering loop**; the retrieval re-ranking tokens are listed separately (or not counted), **consistent with the current inprocess behavior**, so that the usage figures of the two backends do not drift for the same question.

### Contract freeze list (section 6 of the architecture document plus C-A / B / C) — snapshot the baseline before work starts.

---

## 3. Staged implementation (every stage = an independently verifiable and reversible unit)

### [Stage 0 — fix the independent production bug first] Broken projectId wiring (approved: fix and verify independently first)
- **Change**: `infra/agent/genbi/index.js:28-35` — add `projectId` pass-through to the runAgent arguments.
- **Blast radius**: 1 place in the container entry point; **but it falls within the image red line** — buildx with two deployment passes + headless verification.
- **Verification gate**: multi-project scenario — seed one business definition / skill for a non-default project, ask a question headlessly and confirm that the project filter takes effect (currently ineffective); the default project does not regress.
- **Rollback**: the change is tiny; the image can be rolled back to the previous tag.
- **Independence**: decoupled from the core extraction; done and verified first, outside the blast radius of the later large refactoring.

### [Stage 1 — extract the pure logic of core + switch the platform side first (no image / no production agentcore touched)]
- **Change**: create `platform/src/lib/genbi/core/` and move the pure logic of section 1.2 into it (separating pure from impure at function level, especially cutting the pure parts out of `retrieval.ts` / `context.ts`); platform inprocess + execute switch to importing core.
- **Untouched**: the container, the Lambda, the wire format, the production agentcore backend.
- **Verification gate**: contract-guard all green; zero diff in the `GenBiResult` shape; headless question regression on the inprocess backend (real multi-table metrics on the game dataset); unit tests (new core tests + the existing `context-injection.test` and others) all pass; the i18n scanner reports zero missing.
- **Value**: the core logic is verified correct first in the safest TypeScript runtime, locking the contract. **inprocess still exists at this point (it is the safety net)**.
- **Rollback**: pure TypeScript change; `git revert`.

### [Stage 2 — the Lambda imports core (eliminating copy source ②)]
- **Change**: sql-guard / SCHEMA_SQL / business-definition lookup / formatting in `infra/lambda/genbi-skills/{rs.js,index.js}` are replaced by requiring `core-dist`; a new prebuild copy script (red team 2's option A); the CDK asset packaging includes core-dist.
- **⚠️ Risk — red-team finding 3**: the Lambda's Athena currently uses the Redshift guard; switching to core's Athena guard changes the SHOW / DESCRIBE allow rules; **the container is still the old hand copy at this point**.
  - **Mitigation**: stage 2 **replaces only the parts that are identical verbatim** (`sanitizeSelect` Redshift version, SCHEMA_SQL, kindLabel, business-definition lookup — the red team confirmed verbatim / near-verbatim, zero behavior change); **the Athena guard's allow-rule difference is pulled out separately** as the independent behavior-change item of section 5, explicitly verified before switching, not mixed into stage 2.
- **Verification gate**: headless question regression on the agentcore backend (real queries on both engines, Redshift + Athena/S3 Tables); regression of the SQL-guard reject / allow sample set (constructed boundary-SQL assertions); EMF metrics not broken.
- **Rollback**: the Lambda deployment is light and can be reverted in seconds.

### [Stage 3 — the container imports core.brain + retrieval into the container (the hardest step · red-line image)]
- **Prerequisite gates (must pass first, otherwise this stage is not entered)**:
  - **OpenMetadata-reachability gate**: a real test of container → OpenMetadata reachability + permissions. Adopt red team 1's **route B** — the OpenMetadata description read becomes a Lambda MCP tool (the skills Lambda already has secretsmanager + public egress) and the container does only the LLM re-ranking, **zero IAM / network change**. First deploy this new MCP tool on its own and verify that OpenMetadata descriptions can be fetched.
  - **Recall-regression gate**: the TOPK=6 recall regression. Build a small "question → expected matched tables" regression corpus (covering the 7 tables of the game dataset + cross-table metric phrasings) and quantify the recall loss of retrieval relative to full-table grounding; if tables are missed significantly, tune TOPK / PREFILTER or add a Chinese-tokenization fallback before proceeding.
- **Change**: the brain logic of the container's `agent.js` is replaced by requiring `core-dist` (loop / prompt / catalog / dialect); retrieval runs as "LLM re-ranking in the container + Lambda MCP fetching the OpenMetadata descriptions"; at the same time fix the default model to sonnet-4-6 and delete the `RUN_SQL_TOOL` dead code; systemPrompt unification (see section 4).
- **Red line**: buildx with two deployment passes (`--provenance=false --sbom=false`), several rounds of verification with zero regression, no effect on the other AgentCore capabilities (netadvisor / paramadvisor).
- **Verification gate**: full headless question regression on the agentcore backend (including retrieval taking effect — usedContext / matchedTables / steps correct); the recall corpus re-tested and passing; container image size check (no unrelated engine seed); smoke tests of the other two advisors unaffected.
- **Rollback**: the image is rolled back to the previous tag (tag `pre-genbi-container-core` before this stage).

### [Stage 4 — delete inprocess (converge to one shell · the last step)]
- **Prerequisite gate**: stages 1–3 all green + an observation period of stable operation on the agentcore backend (several days recommended; compare with the historical fallback logs).
- **⚠️ Red-team finding 4**: deleting inprocess = the only fallback that can "stop the compute" disappears (the agentcore abort only ends the client's wait and cannot kill the remote compute).
  - **Decision point (final decision to be taken before stage 4)**: (a) really delete (the purest single shell; accept that the 300 s ceiling can only mark timeout and cannot stop the compute); (b) **keep a thin inprocess shell that also imports core** (≈ evolves into the shared-core-with-fallback plan; the fallback = full quality at very low cost, because once core is extracted, inprocess degenerates into a thin "direct ToolExecutor" layer).
  - **I still recommend choosing (b) at stage 4**: once core is extracted, keeping inprocess is almost free, yet it preserves the compute-stopping fallback + the local-development path. But this is your choice at stage 4; it is not locked now.
- **Change**: if (a) — remove the `runInprocess` branch of `execute.ts` + the related imports + inprocess-only files such as `agent.ts`.
- **Verification gate**: full-chain headless regression; asynchronous question-answering + the 300 s ceiling behavior confirmed; the contract freeze all green.

---

## 4. systemPrompt unification (responding to red team 2 + the contract-risk finding of the architecture document)
- The two versions have drifted: the TypeScript title reads "Kingfisher big-data governance platform" vs the JavaScript "big-data governance platform"; the JavaScript version adds a skillsBlock, and the published / memory sections are concatenated at different positions.
- **Unification steps**: before work starts, a line-by-line diff of the two versions → finalize the authoritative version (with the Kingfisher brand + skillsBlock + the published / memory positions) → into core `prompt`. Because changing the prompt affects model behavior, **both backends must be re-verified headlessly after extraction for no regression in answer quality** (compare the answers before and after extraction on real game-domain questions).

---

## 5. Independent behavior-change items (not mixed into the stages; verified separately)
- **Athena guard allow-rule difference** (finding 3 / the Athena-guard misalignment): once core unifies the Athena guard, SHOW / DESCRIBE on the Lambda Athena path go from rejected to allowed. Build a SQL sample set separately to verify that the allow change does not affect safety and does not break existing queries; only after it passes do the Lambda / container switch to core's Athena guard.

---

## 6. Hard contracts that hold throughout (snapshot baseline; a violation at any stage = rollback)
Carry over all 8 items of section 6 of the architecture document + C-A / C-B / C-C added in section 2 of this document. Highlights:
- The 6 engine-output fields of `GenBiResult` + the division of the 5 execute post-processing items unchanged.
- The wire format `{answer,sql,columns,rows,rowCount,steps,usage}` **does not change by a single character** (retrievalNote goes through the steps channel).
- The `abortSignal` pass-through semantics, the `GENBI_BACKEND` decision + one-way fallback, the [asynchronous-execution](./genbi-async-execution.md) state machine, the single read of business definitions.
- The frontend `page.tsx`, the asynchronous-execution endpoints, and the i18n dictionary — zero regression.

---

## 7. Verification matrix (items every stage must pass)

| Stage | contract-guard | Headless, both backends | Unit tests | i18n scan | Image red line | Special gate |
|---|---|---|---|---|---|---|
| 0 projectId | ✓ | ✓ (multi-project filter) | — | — | ✓ buildx | multi-project seed verification |
| 1 extract core + platform | ✓ | ✓ (inprocess) | ✓ core unit tests | ✓ | exempt | zero contract diff |
| 2 Lambda switches to core | ✓ | ✓ (agentcore) | ✓ guard samples | — | exempt | verbatim parts first · Athena difference deferred |
| 3 container + retrieval | ✓ | ✓ (agentcore, full) | ✓ | — | ✓ buildx | recall-regression + OpenMetadata-reachability gates pass first |
| 4 delete / keep inprocess | ✓ | ✓ (full chain) | ✓ | — | depends on the choice | 300 s ceiling behavior + observation period |

---

## 8. Tagging plan (rollback anchors)
- Already tagged: `pre-genbi-core-unification` (pointing at the commit preceding the refactoring).
- Added before stage 3: `pre-genbi-container-core` (before the container image changes).
- Each stage commits independently with the stage number in the message, so that stages can be reverted individually.

---

## 9. Points awaiting review and confirmation (design first, then work; approval pending here)
1. Is the **stage order** of this implementation plan (0→1→2→3→4, burning down risk in reverse order) accepted?
2. Are the three contract unification decisions of section 2 accepted (C-A: unified tool name `run_sql` / C-B: retrievalNote through steps without extending the wire / C-C: usage counts only the main loop)?
3. Is **route B** for retrieval in stage 3 accepted (the Lambda MCP fetches OpenMetadata, the container only re-ranks)? Or should it be route A (the container connects to OpenMetadata directly, with added IAM)?
4. Stage 4, deleting inprocess: (a) really delete / (b) keep a thin fallback shell — decide now, or leave it until just before stage 4?
5. Should stage 0 (projectId) **start immediately** (the independent fix is already approved), or be scheduled together with stage 1?
