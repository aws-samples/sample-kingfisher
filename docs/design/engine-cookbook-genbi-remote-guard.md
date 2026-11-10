# Engine Cookbook — Adding the Cookbook Dialect Guard to the GenBI AgentCore Remote Runtime Container (Top-Level and Detailed Design)

> - 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For multi-region behavior — place,
>   execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is tracked in the design index. A path mentioned in this document that no longer
>   exists means that the idea was not implemented as described here or has since been superseded.
> - ⚠️ **Implementation differences**: `platform/src/app/api/cookbook` and `platform/src/components/cookbook` were not implemented as described here; the recipe guard and the capability vocabulary live in `platform/src/lib/cookbook/`, and the recipe texts ship with the Ask-Your-Data agent image
>   under `infra/agent/genbi/core-dist/cookbook/`.

> - Status: **✅ implemented (decision 3 — extracting the pure core — was adopted)** (documentation audit calibration of 2026-08-26: the original status header was outdated — it read "design, pending approval"). Follows the engineering disciplines `design-first-no-code-until-approved` + `global-grade-design-discipline` (global grade: a thorough top-level design + a complete detailed design) + 🔴 `genbi-runtime-image-change-redline` (the hard red line on changing the GenBI remote image).
> - Prerequisites completed: phase 1 foundation / phase 2 recipes / phase 3 batch ETL integration / phase 4 realtime Flink integration / the two Athena dialect sub-steps of phase 5 / **phase 5a: in-process GenBI wired to the guard** (`lib/genbi/agent.ts:189`).
> - This design is based on first-hand code verification on 2026-07-24 (a deep exploration of the cookbook dependency chain + the container's SQL generation / execution points + the core-dist mechanism), not on memory.

---

## 0. One-sentence goal and boundaries

> **Add to the GenBI AgentCore remote Runtime container (`infra/agent/genbi/agent.js`) a cookbook dialect guard that is fully isomorphic to the in-process one,
> eliminating the 🟡 H blind spot found in the revision-2 self-review of the design (SQL generated inside the remote container does not go through this repository's guard), without touching any existing production path and without touching any other AgentCore capability.**

**The essence of the blind spot** (why this is needed): GenBI has two backends —
- ✅ **inprocess** (the platform process): at `agent.ts:189`, after the model produces SQL and before execution, the SQL goes through `cookbookGuard(engine, rawSql).code`, which corrects the dialect (backticks → double quotes, and so on).
- 🔴 **AgentCore remote Runtime** (the container): the SQL is generated inside the container and executed through Gateway → skills Lambda, and **never goes through the cookbook guard**. Production defaults to agentcore (the GenBI AgentCore deployment note), so this is a blind spot **on the main path**, not an edge case.

**Explicit boundaries (red-line scope; if any is violated, do not proceed)**:
- ✅ Add only one guard step "after the remote SQL is generated, before it is executed", isomorphic word for word to the in-process one.
- ❌ **Do not touch** retrieval (table selection) / the read-only sql-guard (sanitizeSelect / sanitizeReadOnly) / asynchronous submit + poll / heartbeat claiming / result persistence / the Strands loop — none of the existing paths.
- ❌ **Rebuild only the single GenBI Runtime image**; do not touch the network advisor / parameter advisor / Copilot.
- ❌ The guard corrects **dialect syntax only** (no semantic change, idempotent, pure CPU) and **coexists with, does not replace,** the existing read-only safety guard (dialect correction first; the skills Lambda then applies its read-only sanitize before execution).

---

## 1. Survey of the current state (first-hand verification, file:line)

### 1.1 Guard status of the two backends

| Backend | SQL generation point | Guard status | Execution point |
|---|---|---|---|
| inprocess | `agent.ts:184` the model calls the `run_sql` tool, `tu.input.sql` | ✅ `agent.ts:189` `cookbookGuard(engine, rawSql).code` | `agent.ts:193` runSelect / runSelectAthena |
| **Remote container** | `agent.js:188` the model calls `run_redshift_sql` / `run_athena_sql`, `args.sql` | 🔴 **None** | `agent.js:186` `mcp.callTool` → skills Lambda → Redshift Data API / Athena |

### 1.2 Purity of the cookbook guard (verification that core-ization can succeed)
- `guard(engine, code)` (`guard.ts:48`) depends on: `types` (pure types + the pure function targetOfRule) + `mask` (`mask.ts`, zero imports, pure string handling) + `dialectRulesFor` (`registry.ts:26`).
- **A pure function at runtime**: `(engine, code) → {code, fixed, violations, blocked}`, no IO, no side effects, pure CPU (mask → regex match → interval fix → fixpoint ≤ 6 rounds).
- **Dialect rules come only from the seed constants** (the comment at `registry.ts:4-6` states explicitly that "dialects come only from the system-embedded seed and are not open to administrator changes"; `dialectRulesFor` is just `SYSTEM_DIALECT_RULES.filter(byEngine)`, **zero DB reads**).
- 🔴 **The only blocker (a static import edge, not a runtime one)**: `guard.ts:18 → registry.ts:13 (import store) → store.ts:8 (@/lib/aws/dynamodb)`. tsc does no tree-shaking and will compile this edge into the CJS output → `@/lib/aws/dynamodb` fails to resolve inside the container. inprocess goes through the `@/lib/cookbook` barrel (whose re-exports include store), which drags in the whole package — **the container must never go through the barrel**.

### 1.3 The core-dist mechanism (the template for extracting the cookbook)
- `core-prebuild.sh`: genbi is registered as `CAP_CORE_SRC[genbi]=src/lib/genbi/core`, `CAP_DESTS[genbi]="infra/lambda/genbi-skills/core-dist infra/agent/genbi/core-dist"`.
- The container already imports `./core-dist/{retrieval-core,prompt,catalog}.js` at `agent.js:10-12` (the compiled output of @genbi/core).
- genbi/core already has `sql-guard.ts` (**the read-only guard sanitizeSelect / sanitizeReadOnly, not the dialect guard**; the two sit side by side).
- The genbi-skills Lambda = `lambda.Code.fromAsset` raw-dir (not esbuild), already wired to core-dist (same mechanism).

---

## 2. 🔴 Key architecture decisions (3, each must be nailed down for a global-grade design)

### Decision 1: how the cookbook gets into the container — a new standalone `cookbook-core` compilation unit (not merged into genbi/core)

**Option comparison**:

| Option | Approach | Trade-off |
|---|---|---|
| **A (recommended): a standalone cookbook-core compilation unit** | New `tsconfig.cookbook-core.json` (rootDir=`src/lib/cookbook`, includes only the pure guard subset) + a `[cookbook]` registration line in core-prebuild; the output is copied into `agent/genbi/core-dist` | Matches the positioning "the cookbook is platform-level shared, not GenBI-private"; fits the core-prebuild paradigm "adding a capability = adding one line"; Copilot / other containers can later reuse the same cookbook-dist |
| B: merge into genbi/core | Put the guard into `src/lib/genbi/core/` | ❌ Violates the cookbook's positioning (it is platform-level, shared by 4 outlets); and `tsconfig.core.json` has rootDir=genbi/core and cannot include files outside the cookbook directory |

**Option A is chosen**. Output directory: `infra/agent/genbi/core-dist/cookbook/` (isolated in a subdirectory, not mixed with the genbi/core output).

### Decision 2: how to eliminate the static import blocker — **a standalone entry for the core version of the guard; never change the guard.ts that inprocess uses**

This is **the core protection of red line 2, "do not touch existing paths"**. The exploration pass suggested "change guard.ts to read from the seed directly" — but `guard.ts` is shared by **four production consumers**: in-process GenBI + Copilot + ETL + Flink; changing it = touching existing paths, which violates the red line.

**The more isolated solution (recommended)**: inside the core compilation unit, **create a thin entry** `cookbook/core-guard.ts`:
```ts
// 只为容器 core 化存在:重导出纯 guard,但方言规则直接取 seed(不经 registry→store)。
// guard() 本体逻辑零改(mask/fixpoint/区间fix 全复用),只是规则来源从 dialectRulesFor 换成
// 直接 filter SYSTEM_DIALECT_RULES —— 二者本就等价(registry.ts:26-28 就是这个 filter)。
import { SYSTEM_DIALECT_RULES } from "./seed";
import { runGuardWithRules } from "./guard-core"; // guard.ts 抽出的纯核(见决策3)
export function guard(engine, code) {
  const rules = SYSTEM_DIALECT_RULES.filter(r => r.engine === engine || !r.engine);
  return runGuardWithRules(rules, engine, code);
}
```text
- **Not a single line of the inprocess `guard.ts` / `@/lib/cookbook` barrel changes** → zero regression for the four outlets.
- tsconfig.cookbook-core includes only `{core-guard, guard-core, mask, types, seed/**}`, **excluding registry / store** → a clean static graph, zero `@/`, zero DynamoDB.

### Decision 3: how to reuse the guard's core logic — extract a pure `guard-core.ts` core (shared by inprocess and core, eliminating hand-copied drift)

**If core-guard copied the guard logic, that would be a hand-made copy** (exactly the disease that the Engine Cookbook and the [Strands platform unification](./strands-platform-unification.md) set out to eliminate). Therefore:
- Extract the **pure core** of `guard.ts` (the mask → match → fix → fixpoint part, without the registry import) into `runGuardWithRules(rules, engine, code)` in `guard-core.ts`.
- The `guard()` of the original `guard.ts` becomes `runGuardWithRules(dialectRulesFor(engine), engine, code)` — **behavior identical word for word** (dialectRulesFor already returns the seed filter), and the API for inprocess consumers does not change.
- The `guard()` of `core-guard.ts` becomes `runGuardWithRules(SYSTEM_DIALECT_RULES.filter(...), engine, code)`.
- **Both entries share the same pure core `guard-core.ts`** → zero hand-copied drift (this is the only place where "guard.ts is changed", but it is a **pure refactor**: core extraction + delegation, behaviorally equivalent, locked down by unit tests).

> ⚠ **Honest assessment**: decision 3 does touch `guard.ts` (in use by inprocess). But it is a **core-extraction refactor, not a logic change** — the external signature / behavior of `guard.ts` stays 100% unchanged, **locked down byte for byte** by the existing `guard.test.ts` + `guard-fuzz.test.ts` + the per-engine dialect unit tests. If that is a concern, the fallback (decision 3′) = core-guard fully standalone, not touching guard.ts (accept one copy of the guard core and rely on dual-run unit tests asserting identical output on identical input to prevent drift). **The preference is decision 3 (core extraction, zero drift), with 3′ as the downgrade if the red line is triggered**.

---

## 3. Detailed implementation (step by step, each step independently verifiable)

### Step 1 — Extract the pure guard core (platform side, pure refactor, remote side untouched)
- New `cookbook/guard-core.ts`: `runGuardWithRules(rules: DialectRule[], engine, code): GuardResult` (the pure mask + fixpoint + fix logic moved out of guard.ts).
- Change `guard.ts`: `guard()` = `runGuardWithRules(dialectRulesFor(engine), engine, code)` (delegation, behavior unchanged).
- New `cookbook/core-guard.ts`: the container-only entry; rules come from `SYSTEM_DIALECT_RULES.filter`.
- **Verification**: `guard.test.ts` + `guard-fuzz.test.ts` + the per-engine dialect unit tests all green (proving zero behavior change from the extraction) + a new `core-guard` unit test asserting "core-guard and the inprocess guard produce the same output for the same input" (dual-run consistency, against drift). tsc 0.

### Step 2 — The core-ized compilation unit (core-dist mechanism)
- New `platform/tsconfig.cookbook-core.json` (rootDir=`src/lib/cookbook`, include `core-guard.ts` + `guard-core.ts` + `mask.ts` + `types.ts` + `seed/**`, exclude registry / store / retrieve / prompt / capability-vocab).
- Register `[cookbook]` in `core-prebuild.sh`: CAP_TSCONFIG / CAP_CORE_SRC / CAP_DESTS=`infra/agent/genbi/core-dist/cookbook` (subdirectory).
- **Verification**: `core-prebuild.sh cookbook` generates → the output contains no `@/` and no `require("@aws-sdk")` (grep assertions) → `node -e "require('./core-dist/cookbook/core-guard.js').guard('redshift','SELECT ...')"` runs locally (pure function, no IO). The existing genbi / param / net core-dist directories show an empty git diff (zero regression).

### Step 3 — Instrumenting the container (change agent.js, minimal intrusion)
- Add at the top of `agent.js`: `import { guard as cookbookGuard } from "./core-dist/cookbook/core-guard.js";`
- In the tool callback at `:186`, insert before `mcp.callTool`:
```js
// P45.5b:远程生成 SQL 后、执行前过 cookbook 方言 guard(与 inprocess agent.ts:189 同构)。
// 仅拦 SQL 执行工具;纯 CPU 幂等只纠方言不改语义;与 skills Lambda 内既有只读 sanitize 并存。
if ((t.name.endsWith("run_redshift_sql") || t.name.endsWith("run_athena_sql")) && args.sql) {
  args.sql = cookbookGuard(t.name.endsWith("run_athena_sql") ? "athena" : "redshift", String(args.sql)).code;
}
```
- The Dockerfile already COPYs core-dist (including the new cookbook subdirectory; no Dockerfile change is needed — it COPYs the whole core-dist).
- **Verification**: `node --check agent.js`; start the container locally, /ping healthy + /invocations clean (the whole assembly passes, including the new import); docker build arm64 exit 0.

### Step 4 — Deployment (red line: rebuild only the single GenBI Runtime)
- Tag the pre-change commit `pre-genbi-guard-runtime` (red line 1, rollback anchor).
- Contract snapshot `before-genbi-remote-guard` (lock the existing features before the change).
- buildx ARM64 single-platform manifest (`--provenance=false --sbom=false`) pushed to the GenBI ECR repository, tag = git SHA.
- **Only** `cdk deploy BgpAgentCoreStack -c genbi-runtime=1 -c genbi-agent-tag=<sha>` (do not touch the net / param / copilot stacks).
- Keep the previous image / TaskDef so that rollback is possible (red line 5).

---

## 4. 🔴 Multi-round independent verification matrix (red line 3; a global-grade design must be exhaustive)

| Round | Layer | What is verified | Pass criterion |
|---|---|---|---|
| **Round 1** | Unit tests | Zero behavior change from the guard core extraction + core-guard and inprocess produce the same output for the same input | guard.test / fuzz / all dialect tests green + the dual-run consistency assertion green |
| **Round 2** | core-dist purity | The output has no `@/` and no aws-sdk import; a local node require runs | grep zero hits + node execution returns {code} |
| **Round 3** | Container build | docker build arm64 + the started container's assembly passes fully | exit 0 + /ping healthy + /invocations clean |
| **Round 4** | Live real question · dialect-prone | Headless `/genbi` asks a real question that triggers backticks (for example one involving special column names), remote backend=agentcore | Correct result + the SQL contains no backticks (the guard took effect) + cross-check in the Runtime logs that the guard executed |
| **Round 5** | Live real question · normal | Headless `/genbi` asks an ordinary question (the gold-standard `orders` query returns data) | Result identical to before the change (no collateral damage) |
| **Round 6** | Live real question · edge cases | Multi-table joins / multi-turn follow-ups / complex aggregations | All succeeded, behavior identical to before the change |
| **Round 7** | Fallback safety net | Temporarily set GENBI_BACKEND=inprocess (or simulate a Runtime failure) and verify that the fallback still works | inprocess questions work (the phase-5a guard is present there too) |
| **Round 8** | Zero impact on other AI capabilities | Headless verification of the network advisor / parameter advisor / Copilot, one run each | All three work (proving that only the GenBI image was touched) |
| **Round 9** | contract-guard | verify against before-genbi-remote-guard shows zero regression | 🔴 0 items + the column-level lineage anchor does not degrade + ai_wiring 5/5 |

**Every round keeps its own evidence** (screenshots / logs / cross-checks); if any round fails → trigger the fallback (section 5).

---

## 5. 🔴 Fallback downgrade (red line 6)

**If any verification round finds that the guard damages an existing path / affects another AgentCore capability → immediately stop the phase-5b remote change** and downgrade to:
- Keep the existing in-process guard (phase 5a is live; the main path can be switched to inprocess).
- **Document the remote blind spot explicitly** (section 0 of this design + the roadmap + finding 🟡 H of the [Engine Cookbook design](./engine-cookbook.md)).
- List the remote change as a separate task; do not risk polluting production GenBI.

**Better to keep a documented, known blind spot than to risk polluting production GenBI.** (The red line, verbatim.)

## 6. Rollback
- Tag `pre-genbi-guard-runtime` (before the change).
- The container / core / guard changes can be reverted with git checkout.
- Production is unaffected until the Runtime is rebuilt; if a problem is found after the rebuild, `cdk deploy BgpAgentCoreStack -c genbi-agent-tag=<previous sha>` rolls the image back (the TaskDef is kept).
- If the guard.ts core extraction introduces any regression, the `guard-core` delegation can be reverted to the original guard.ts (decision 3′).

## 7. Honest risks and costs
- **Decision 3 touches guard.ts** (shared by the four inprocess outlets) — although it is a pure core-extraction refactor, it is still the only place where this design touches an existing production file. Mitigation = the existing unit tests lock it down byte for byte + the round-1 dual-run consistency assertion + the fallback 3′. **This point must be acknowledged and decided explicitly** (accept the core extraction, or go with 3′, the fully standalone copy).
- **Qualitative benefit**: eliminating the dialect blind spot on the main path (production defaults to agentcore) is a **correctness gain** (the model's occasional dialect errors such as backticks fail directly against the database in the remote path, or fail silently; inprocess is already protected, remote is not). This is not pedantry.
- **Image red line**: this touches the production GenBI image, the highest risk tier; hence the 9-round verification matrix + the fallback downgrade + rebuilding only one Runtime.
- **i18n**: the guard is a pure library without UI; the frontend only has the dialect echo that etl-jobs already has (whether the GenBI question page should echo the guard result is optional; no UI is added in this phase, keeping the intrusion minimal).

## 8. Decision points pending approval
1. **Decision 3 (extract the pure guard-core: zero drift but touches guard.ts) vs decision 3′ (a fully standalone copy in core: does not touch guard.ts, but one copy that relies on dual-run unit tests against drift)** — which one? (The recommendation leans toward 3, because eliminating hand-made copies is a consistent principle of the Engine Cookbook and the Strands platform unification, and the risk is controllable with unit tests locking it down; but 3′ is more conservative and touches no existing file at all.)
2. Are 9 verification rounds enough (more may be added for a global-grade design)?
3. Do it in this phase, or store the design first and start only after it has been evaluated?
