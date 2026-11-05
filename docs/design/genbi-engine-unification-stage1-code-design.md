# Stage 1 Code-Level Design — Extract the Pure Logic of `@genbi/core` + Switch the Platform Side

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is tracked in the design index. A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> **✅ Stage 1 is complete and pushed (the 8 core files are in place).** Authorization to "start" was given; scope = stage 1. This document is the last design confirmation before code is written (file / function / interface level).
> Stage 1 iron rules: **pure TypeScript, no image touched, no production agentcore touched, zero contract change**. inprocess remains the safety net.
> Rollback anchors: `pre-genbi-core-unification` (the commit preceding the refactoring) + `pre-genbi-stage1`, added before this stage.

> ⚠️ (documentation audit of 2026-08-26) This implementation plan has been fully implemented; the code is authoritative. The overall design is [GenBI engine unification](./genbi-engine-unification.md). Retained as a historical implementation record.

## 0. Stage 1 goals and boundaries
- **Do**: extract GenBI's engine-agnostic pure logic into `platform/src/lib/genbi/core/`; switch the platform's existing consumers (`agent.ts` / `execute.ts` / retrieval and so on) to import core; define the pluggable interfaces (only `ModelClient` lands in this stage; the other interfaces are needed only in stages 2 / 3).
- **Do not**: do not touch `infra/agent/genbi/*` (the container), do not touch `infra/lambda/genbi-skills/*` (the Lambda), do not change the wire format, do not delete inprocess, do not touch deployment.
- **Verification**: `npm test` (vitest) all green + contract-guard verify with zero FAIL + headless question regression on the inprocess backend.

## 1. core directory structure (fine-grained entry points, responding to the finding that the container has no tree-shaking)
```
platform/src/lib/genbi/core/
  index.ts            # optional barrel (platform only; the container / Lambda use the sub-entry points in stages 2 / 3)
  types.ts            # engine-agnostic types: SchemaTable / SchemaColumn / CatalogEntry / TableMatch /
                      #   RetrievalResult / PublishedHint / the GenBiStep shape / ContextKind / ContextEntry
  model-client.ts     # the ModelClient interface (the only interface that lands in this stage) + types
  prompt.ts           # systemPrompt (moved from genbi/prompt.ts, zero change)
  sql-guard.ts        # sanitizeSelect (Redshift) — moved from genbi/sql-guard.ts
  dialect.ts          # re-exports only the redshift + athena dialect rules (without glue / flink / emr)
  catalog.ts          # catalogText rendering + buildCatalogText
  retrieval-core.ts   # buildSemanticCatalog / tokenize / prefilter / entryBrief / extractJson
                      #   + selectRelevantTables (ModelClient injected; no longer calls bedrock directly)
  context-format.ts   # contextToPromptText / contextToUsedItems / CONTEXT_KIND_LABEL /
                      #   CONTEXT_SECTION_TITLE (the formatting part moved from context.ts)
  chart.ts            # suggestChart (moved from genbi/chart.ts)
  lineage.ts          # parseSqlLineage (moved or re-exported from lineage/sql-lineage.ts)
```
**Zero third-party dependencies** (verified by red team 2): all of the above import only one another + `import type`. **Not included**: `@aws-sdk/*`, `ulid`, `@/lib/aws/dynamodb`, `@/lib/openmetadata/*`.

## 2. The only interface: `ModelClient` (decoupling `bedrock.send`)
```typescript
// core/model-client.ts —— 引擎无关的模型调用抽象
export interface ModelConverseInput {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
  temperature?: number;
}
export interface ModelConverseOutput {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}
export interface ModelClient {
  converse(input: ModelConverseInput): Promise<ModelConverseOutput>;
}
```
- **Inside core**: `selectRelevantTables(question, tables, published, omDesc, model: ModelClient)` — the original `bedrock.send(new ConverseCommand(...))` is replaced by `model.converse(...)`.
- **Platform-side adapter** (stays in `retrieval.ts` or a new `retrieval-adapter.ts`): implements `ModelClient`; internally it is today's `new BedrockRuntimeClient` + `ConverseCommand`. **Zero behavior change** (the same bedrock call, just wrapped in an interface).
- **Stage 1 extracts only retrieval's model call**; whether the `bedrock.send` of the main loop in `agent.ts` also goes through ModelClient **is left to stage 3** (that is the loop the container will reuse) — stage 1 does not touch the `agent.ts` loop, reducing risk.

## 3. File-by-file migration list (lowest risk first; each block verified independently)

### Sub-step 1a — sql-guard (zero-risk test bed, recommended first by red team 2)
- **Basis**: `genbi/sql-guard.ts` and the Lambda's `rs.js:43-56` are **identical verbatim**; pure regular expressions, zero dependencies.
- **Action**: move the content of `sql-guard.ts` to `core/sql-guard.ts`; the original `genbi/sql-guard.ts` becomes `export * from "./core/sql-guard"` (the re-export keeps the old import path intact, so `agent.ts:206` and the others need no change).
- **Verification**: `sql-guard.test.ts` passes unchanged (it tests the same logic).
- **Value**: first run the complete mechanical cycle "extract → re-export → tests green" to confirm that vitest + tsconfig resolve core without problems, then roll it out.

### Sub-step 1b — pure strings / types (prompt / chart / context-format / catalog / lineage)
- Move each to the corresponding core file; the original files re-export.
- `prompt.ts` **is simply moved** (stage 1 does not reconcile the difference with the container version — that is stage 3's job; stage 1 only moves the platform's current authoritative version).
- Split `context.ts`: the formatting part (lines 163-192) moves to `core/context-format.ts`; **the read / write part (DynamoDB CRUD) stays in `context.ts`**, which re-exports core's formatters.
- **Verification**: `context-injection.test.ts` passes.

### Sub-step 1c — retrieval (introducing ModelClient; needs the most care)
- The pure logic (buildSemanticCatalog / tokenize / prefilter / entryBrief / extractJson + the body of selectRelevantTables) moves to `core/retrieval-core.ts`; the `selectRelevantTables` signature gains a `model: ModelClient` parameter.
- `fetchOmDescriptions` **stays in the platform** (reads OpenMetadata; impure).
- The platform-side `retrieval.ts` becomes a thin adapter: it keeps `fetchOmDescriptions` + one `bedrockModelClient` implementation + one wrapper `selectRelevantTables(q,t,p,om)` that injects that client and calls core (**keeping the old signature, so the `agent.ts` call site changes by zero**).
- **Verification**: a new `core/retrieval-core.test.ts` unit test (the pure functions prefilter / extractJson / buildSemanticCatalog + the selection / fallback logic of selectRelevantTables with a fake ModelClient).

### Sub-step 1d — dialect fine-grained entry point
- `core/dialect.ts` only `export { the redshift + athena entries of SYSTEM_DIALECT_RULES }` or provides a pure function `dialectRulesFor(engine)`. The cookbook `guard` **is not moved in this stage** (it spans the cookbook module; stage 1 only moves what is inside the genbi directory; reusing guard is left for stages 2 / 3 when the container needs it).
- **Judgment**: if the `cookbookGuard` call in `agent.ts` is hard to decouple, stage 1 may **leave cookbook alone** and extract only the pure logic inside the genbi directory. The cookbook extraction is evaluated separately (reducing the scope of stage 1).

## 4. Import rewriting strategy (responding to red team 2's `@/` alias pitfall)
- Files inside core reference one another with **relative paths** (`./types`, `./model-client`), not the `@/` alias — ensuring the alias does not fail to resolve when core is compiled to standalone CJS for the container / Lambda in stages 2 / 3.
- Inside core, importing `@/lib/*` from outside core is **forbidden** (except `import type`) — this is the machine-checkable constraint for "core has zero runtime dependencies".
- Platform consumers keep importing `@/lib/genbi/core/*` or the old re-exported paths — the platform's own webpack resolves the alias; no problem.
- **Old-path re-exports are kept**: `genbi/sql-guard.ts` / `prompt.ts` / `chart.ts` and the others become `export * from "./core/xxx"`, so that every existing import site (`agent.ts` / `execute.ts` / ...) **needs no change at all**, shrinking the regression surface to a minimum.

## 5. Stage 1 verification matrix
| Verification | Command / method | Pass criterion |
|---|---|---|
| Unit tests | `cd platform && npm test` | all green (including the new core tests + the original sql-guard / context-injection tests) |
| Type check | `npx tsc --noEmit` (platform) | zero errors |
| core zero-dependency constraint | grep the core/ directory for `@aws-sdk` / `@/lib` (non-type) | no violations |
| contract-guard | snapshot (before-stage1) → … change … → verify | zero FAIL |
| Headless question regression | real game-domain questions on the inprocess backend (switch back to the default project and ask about ROAS / retention and so on) | correct answers; execution chain normal |
| i18n | `node platform/scripts/i18n-check-missing.mjs` | zero missing (stage 1 should add no UI copy) |

## 6. What stage 1 does not introduce (explicit boundaries against scope creep)
- No change to the main Converse loop in `agent.ts` (extracted only in stage 3, for container reuse)
- No change to `memory.ts` / `history.ts` / `tasks.ts` (orchestration layer, not core)
- The cookbook guard is not moved (cross-module; evaluated separately)
- No change to the container / Lambda / wire format / deployment
- inprocess is not deleted

## 7. Rollback
- Tag `pre-genbi-stage1` before stage 1.
- Pure TypeScript throughout + re-exports keep the old paths; if any sub-step goes wrong, `git revert` suffices, with no effect on production (production runs the agentcore container, which stage 1 does not touch at all).

## 8. Delivery order (commit + verify at every step)
1. Tag `pre-genbi-stage1` + contract-guard snapshot
2. Sub-step 1a sql-guard → tests green → commit
3. Sub-step 1b pure strings / types → tests green → commit
4. Sub-step 1c retrieval + ModelClient → new unit tests green → commit
5. Sub-step 1d dialect (if included) → commit
6. tsc + contract-guard verify + headless question regression → all green → stage 1 closing commit
7. Wait for confirmation before pushing
