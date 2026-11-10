# Stage 2 Code-Level Design — The Lambda Imports core (Eliminating Copy Source ②)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is tracked in the design index. A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> - Status: **✅ implemented** (audit calibration of 2026-08-26: the original read "in design, no code touched"). Stage 1 is complete and pushed (the 8 core files are in `platform/src/lib/genbi/core/`).
> - The stage 1 review passed, and an i18n empty-translation bug was fixed in passing. This document is for resuming stage 2 after a context compaction.
> - Integration approach decided: **a prebuild script compiles core to CJS + copies it into the Lambda (red team 2's option A; zero CDK change)**.

> ⚠️ (documentation audit of 2026-08-26) This implementation plan has been fully implemented; the code is authoritative. The overall design is [GenBI engine unification](./genbi-engine-unification.md). Retained as a historical implementation record.

## 0. Stage 2 goal
Make `infra/lambda/genbi-skills/{rs.js,index.js}` use the compiled core, eliminating copy source ② (the JavaScript duplicates in the Lambda that repeat core verbatim).

## 1. Factual baseline (read-only survey of this round; all verified)
- **Lambda directory**: `infra/lambda/genbi-skills/` contains only `index.js` (16 KB) + `rs.js` (6 KB), **no package.json, no node_modules** (it relies on the `@aws-sdk` bundled with the NODEJS_20_X runtime).
- **CDK packaging**: `agentcore-stack.ts:41-46` = `lambda.Function` + `lambda.Code.fromAsset(path.join(__dirname,"..","lambda","genbi-skills"))` — **raw-directory packaging, no bundling**, handler = `index.handler`.
- **Duplicate list (what stage 2 eliminates; all verbatim / near-verbatim)**:
  - `rs.js:43` FORBIDDEN + `:46` sanitizeSelect (= core/sql-guard verbatim)
  - `rs.js:82` SCHEMA_SQL (= core/catalog verbatim)
  - `index.js:92` kindLabel (= core/context-format CONTEXT_KIND_LABEL verbatim)
  - `index.js:70` lookupBusinessContext (business-definition lookup; `body` → `definition` renamed; the query / filter / sort logic is near-verbatim)
  - `rs.js:112` sanitizeSelect in module.exports is reused by `index.js:20`

## 2. 🔴 Key probe finding (exposed by an actual trial compilation in this round; must be solved first)
**core currently cannot be compiled standalone to CJS**:
- `core/types.ts:72` has `export type { ChartSpec, ChartType, GenBiStep, MatchedTable, UsedContextEntry } from "@/types/genbi";`
- A standalone tsc compilation (detached from the platform tsconfig paths) fails with `TS2307: Cannot find module '@/types/genbi'`.
- Although the type is erased in the `.js` artifact, **the compilation itself fails**, and the `.d.ts` retains the alias.
- **Root cause**: core relies on an alias re-export for the contract types → it is not self-contained → blocks standalone compilation (the stage 1 design already flagged "the alias must be handled in stages 2 / 3"; now is the time).

**Everything else is favorable**: the core directory has **zero non-type imports** (zero external runtime dependencies); compiled artifacts such as `sql-guard.js` are clean, requirable CJS; only the alias dependency in `types.ts` needs to be solved.

## 3. ✅ Decision on where the contract types live (decided 2026-07-21 = option ①)
**Option ①: sink the types into core, with `@/types/genbi` re-exporting in reverse**. Move the **physical definitions** of the contract types from `platform/src/types/genbi.ts` into `core/types.ts` and let `@/types/genbi` re-export them in reverse. → core is truly self-contained and compiles standalone; the import paths of the 6 consumers do not change; the single source of the contract = core.

### 3.1 🔴 Implementation verification (the original design corrected after a read-only check of the real structure of both files in this round)
- **Pitfall 1 — it is 5 types, not 4**: `types.ts:72` actually re-exports **5** (`ChartSpec, ChartType, GenBiStep, MatchedTable, UsedContextEntry`).
- `ChartSpec.type: ChartType` (`genbi.ts:20→17`) depends on `ChartType`, and `GenBiHistoryItem.chartType: ChartType` (`genbi.ts:66`), **which stays in place**, depends on it too.
- → **ChartType must sink together with ChartSpec**, otherwise both places fail to compile.
- Sunk = 5: `ChartType/ChartSpec/GenBiStep/MatchedTable/UsedContextEntry`.
- Staying in place (not core; produced by the orchestration layer) = `GenBiResult/GenBiHistoryItem`.

**Pitfall 2 — the reverse re-export must be two steps, import + export**: `@/types/genbi` cannot just write `export type {...} from "core/types"` — a re-export does not bring the names into local scope, so `GenBiResult` (which uses ChartSpec / GenBiStep / MatchedTable / UsedContextEntry) and `GenBiHistoryItem` (which uses ChartType) in the same file would fail with TS2304 (name not found). The correct form:
```typescript
// @/types/genbi.ts 顶部
import type { ChartType, ChartSpec, GenBiStep, MatchedTable, UsedContextEntry } from "@/lib/genbi/core/types";
export type { ChartType, ChartSpec, GenBiStep, MatchedTable, UsedContextEntry }; // 对外路径不变
// GenBiResult / GenBiHistoryItem 定义照旧(现在本地能拿到上面 import 的名字)
```

**Pitfall 3 — core already has a structurally identical `TableMatch`**: `TableMatch` at `core/types.ts:39-44` and `MatchedTable` (`genbi.ts:28`) have identical fields, but they serve different boundaries (TableMatch = retrieval's internal result; MatchedTable = the external contract). **Stage 2 does not force-merge them** (a hard merge would couple retrieval to the external contract and widen the change surface); after sinking, the two coexist, with a TODO for later evaluation.

**No-circular-dependency check**: after sinking, `core/types.ts` no longer imports `@/types/genbi` (the alias dependency is cut); `@/types/genbi` → `core/types.ts` is a one-way reference; no cycle. ✓

### 3.2 Consumer verification (paths unchanged after the reverse re-export)
Apart from `core/types.ts` itself, `@/types/genbi` has **6 external consumers**: `app/genbi/page.tsx`, `lib/genbi/execute.ts`, `lib/bi/types.ts`, `lib/genbi/tasks.ts`, `lib/genbi/history.ts`, `lib/genbi/agent.ts` — all import paths unchanged, zero change. Inside core, only `core/chart.ts` references ChartSpec through the relative path `./types` (correct; unaffected).

## 4. Stage 2 implementation steps (refined after the decision)
- **Prerequisite**: solve section 3 (core compiles standalone).
- **Step 0 — prebuild script**: on the `platform` side, or a standalone `tsconfig.core.json` (module:commonjs, target:ES2020, declaration:true), compiles `core/` → the artifacts are copied into `infra/lambda/genbi-skills/core-dist/`. The script is idempotent and re-runnable.
- **Step 1 — the Lambda switches the verbatim-identical parts** (sql-guard / SCHEMA_SQL / kindLabel first; the red team confirmed zero behavior change): `rs.js` / `index.js` change to `require('./core-dist/...')`.
- **Step 2 — business-definition lookup** (the `body` → `definition` rename folded into core's formatter) — the field-name difference must be handled; verified separately.
- **⚠️ Risk — red-team finding 3**: the Athena guard allow-rule difference (the Lambda's Athena currently uses the Redshift-version sanitizeSelect; if core unifies it, the allow rules may change) — **pulled out and verified separately before switching; not mixed into step 1**.
- **Verification**: headless question regression on the agentcore backend (real Redshift + Athena queries) + SQL-guard boundary samples + EMF metrics not broken + contract-guard. The Lambda deployment is light and reverts in seconds.

## 5. Hard constraints (unchanged)
- The fromAsset raw-directory packaging stays (core-dist is packaged as files inside the directory; zero CDK change).
- The Lambda's returned wire contract stays (`body` → `definition`: the external field name is kept).
- No container change (stage 3); inprocess not deleted (stage 4).

## 6. Rollback
- Tag `pre-genbi-stage2` before stage 2.
- core-dist is a generated artifact (whether to .gitignore or commit it — leaning to commit, so that the artifact is in place when CDK fromAsset deploys; the prebuild script guarantees it can be regenerated).

## Appendix: resumption anchors after compaction
1. First obtain the decision of section 3 on where the contract types live (① / ② / ③).
2. After the decision: first make core compile standalone → build the prebuild script → switch the Lambda → verify.
3. Stage 1 rollback tag: pre-genbi-stage1; add pre-genbi-stage2 before stage 2.
