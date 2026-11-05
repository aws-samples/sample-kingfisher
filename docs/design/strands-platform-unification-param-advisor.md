# Strands Platform Unification, Stage L2 — paramadvisor onto Strands + Eliminating the Hand-Copied Duplicate (Implementation Design)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is tracked in the design index. A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.
> ⚠️ **Implementation differences**: the `@platform/agent-kit` package was not implemented under that name;
> the agent code is currently distributed as follows: Ask-Your-Data (GenBI) in `platform/src/lib/genbi/` + `infra/agent/genbi/`, the parameter advisor in `platform/src/lib/param-advisor/` + `infra/agent/paramadvisor/`, the network advisor in `platform/src/lib/network-advisor/` + `infra/agent/netadvisor/`, and Copilot in `platform/src/lib/copilot/` (including `plan/strands-tools.ts`);
> `infra/agent/copilot` and `infra/lib/copilot-*` do not exist.

> Status: **✅ implemented** (documentation audit calibration of 2026-08-26: the original status header was outdated — it read "design"). Follows the engineering disciplines `design-first-no-code-until-approved` + `verify-to-docker-build-not-tsc` (verify down to the docker build layer).
> Decision: do all of stage L2 for paramadvisor in one go (extract the core + CJS→ESM + Strands).
> Preliminary test done: the `@/` dependencies of catalog.ts (worker-types / the EMR spec) are all [zero-import pure constants], so extracting a core is clean and feasible.

## 0. Goal (the two-part kit)

| Part | Current state (hand-written / hand-copied) | Target |
|---|---|---|
| Duplicate part | The container's `CATALOG_TEXT` (6,401 characters, hand-copied from catalog.ts) + `systemPrompt` (hand-copied from prompt.ts) | Extract into core-dist, have the container import it, eliminate hand-copy drift |
| Framework part | Hand-written `for(iter)` ConverseCommand loop (agent.js:166-197) | Strands `Agent.invoke` (following the GenBI template) |

**Benefit**: eliminates the silent anti-hallucination failure of "changed catalog.ts, forgot the container's CATALOG_TEXT" (correctness). **Risk**: touches the container-image red line.

## 1. Core extraction plan (evidence-driven)

paramadvisor's `catalog.ts` / `prompt.ts` **already have functions** (not constants): `renderCatalogForPrompt(channel)` and `systemPrompt(channel)`.
The container's CATALOG_TEXT / systemPrompt are simply hand-copied outputs of those functions. → **No new logic is built; the container only needs to import the compiled artifacts of these two functions**.

Dependency chain (explored, clean):
```
prompt.ts → catalog.ts(renderCatalogForPrompt) + types.ts(ParamChannel)
catalog.ts → types.ts(type) + etl/worker-types.ts(zero-import pure constants) + engines/emr/spec.ts(zero-import pure constants)
```

**Core directory** `platform/src/lib/param-advisor/core/` (modeled on genbi/core, **zero `@/` dependencies** — tsconfig.core.json uses moduleResolution:node + rootDir to confine it, compiling outside the alias):
- `prompt.ts` — move `systemPrompt(channel)` + `CHANNEL_NAMES`
- `catalog.ts` — move `renderCatalogForPrompt` / `catalogFor` / the 5 ParamDef arrays / CATALOGS
- `types.ts` — ParamChannel / ParamDef and the other pure types (moving from param-advisor/types.ts what the core needs)
- In the reverse direction: the original catalog.ts / prompt.ts re-export the core (the 6 in-process consumers change nothing; the API is preserved)

**Handling the `@/` dependencies (key decision)**: catalog.ts currently imports `@/lib/etl/worker-types` (GLUE_WORKER_VALUES / GLUE_MAX_WORKERS)
+ `@/lib/engines/emr/spec` (6 constants). These two are referenced in 6–8 places across the platform; moving them into the core would pull in too much (rejected). The core must have zero `@/`, therefore:
**core/catalog.ts inlines the values of these constants** (the Glue worker list / the EMR specification options). Rationale: they are **objective facts of AWS services**
(G.1X / G.2X …, emr-7.5.0 …), not platform business logic; new tiers are added extremely rarely, and when one is added every place has to be updated anyway — a different order of drift risk from "the entire structured CATALOG_TEXT
hand-copied". The inlined site carries a comment marking the source (`// source: @/lib/etl/worker-types, AWS fact constants`).
**Trade-off**: accept "one copy of the AWS fact constants in the core" (low severity) in exchange for "the 6,401-character business parameter catalog CATALOG_TEXT is no longer hand-copied" (high severity eliminated). The net benefit is positive.

## 2. Generalizing the prebuild (echoing the core-build piece of the framework layer)

Today `genbi-core-prebuild.sh` hard-codes genbi. Generalize it to be manifest-driven, or add a paramadvisor branch:
- Compile `param-advisor/core` → CJS → copy to `infra/agent/paramadvisor/core-dist/` (+ `{"type":"commonjs"}`, or module if the container is ESM)
- Note: the container is being converted to ESM (see section 3), so whether core-dist uses ESM or CJS must match the container's type (GenBI's core-dist is CJS with an ESM container, relying on the `{"type":"commonjs"}` interop — copy that as is)

## 3. Container side — extract the ② runtime piece, `agent-runner.js` (not a replica of agent.js!)

> ⚠️ **Correction to this section on 2026-07-23**: the earlier revision of this section said "write paramadvisor's agent.js following the GenBI template",
> which **falls back into replication and departs from the top-level design of the ② runtime piece in the framework-layer design ([strands-platform-unification-framework-layer.md](./strands-platform-unification-framework-layer.md))**. That is withdrawn in favor of extracting the framework layer.
> The point raised was "refer to the original design" — section 2.1 of the framework-layer design already planned the ② piece as a Strands assembly template; it should not be replicated.

**Measured evidence (2026-07-23, against replication)**:
- The `runAgent()` loop skeleton, netadvisor vs paramadvisor: **65 of 89 lines are identical word for word (73%)**; after normalization (removing capability names / tool names / full-width vs half-width punctuation), **the only real difference = which fields finalize returns** (net: verdict / rulings / remediations … vs param: recommendations / prefill / questions …). The remaining 73% is pure copying. → Replicating = copying that 73% once more, and L3 / L4 would copy it twice more — exactly the same disease as the scattered modelId.
- **The Strands container is already verified in production**: GenBI's Strands image (90 MB, tagged with its git short hash) is live with the Runtime at `status=READY`. Putting net / param on Strands = using a framework already verified in this account in this very container, not a new technology. That concern is resolved.

**Approach**: extract `infra/agent/_runtime/agent-runner.js` (the ② piece: one source, distributed into each container by the prebuild, the same mechanism as core-dist),
converging the 73% word-for-word duplicated loop skeleton; each capability's container agent.js slims down to "declare the differences + call the runner".

```js
// agent-runner.js —— 顾问型 Agent 容器运行时装配模板(②runtime 件)
// 内置(零参数,收敛自 net/param 逐字相同的 65 行):
//   MCP 连接/工具热加载/多轮 history 拼装/Strands Agent.invoke/tool() 包装/
//   step 记录/错误回传/token 统计/达上限兜底
export async function runAdvisorAgent(input, spec) {
  // spec = 各能力声明的差异点(证据:唯一真冲突就这几个):
  //   spec.systemPrompt(req)   —— 来自 core-dist(消手抄)
  //   spec.firstTurnText(req)  —— 来自 core-dist
  //   spec.inject(raw, req)    —— 硬冲突1:上下文注入。advisor={...raw,request:req} / GenBI={...raw,projectId}
  //   spec.captureSuffix       —— 权威结果工具名后缀(param:"recommend_parameters" / net:"analyze_connectivity")
  //   spec.finalize(reasoning, lastX, steps, usage) —— 唯一真差异:组装各自 wire 结构
}
```

- The paramadvisor container `agent.js` → slims down to:
  ```js
  import { runAdvisorAgent } from "./_runtime/agent-runner.js";
  import { systemPrompt, firstTurnText } from "./core-dist/prompt.js"; // 消 CATALOG_TEXT 手抄
  export const runAgent = (input) => runAdvisorAgent(input, {
    systemPrompt, firstTurnText,
    inject: (raw, req) => ({ ...raw, request: req }),
    captureSuffix: "recommend_parameters",
    finalize: (reasoning, lastX, steps, usage) => ({ reasoning,
      recommendations: lastX?.recommendations || [], prefill: lastX?.prefill || null,
      questions: lastX?.questions || [], historyFacts: lastX?.historyFacts || null,
      confidence: typeof lastX?.confidence === "number" ? lastX.confidence : 0.3,
      steps, llmAvailable: true, usage }),
  });
  ```
- package.json: `"type":"module"` + add `@strands-agents/sdk` / zod / @mcp / otel (following genbi); index.js / mcp.js require → import
- Dockerfile: add `COPY _runtime ./_runtime` + `COPY core-dist ./core-dist` (following genbi's COPY core-dist)
- **Where firstTurnText belongs**: the firstTurnText at the current container's agent.js:123-131 is pure string assembly; move it into core/prompt.ts (same source as systemPrompt, eliminating that hand copy at the same time).
- **Reach**: the runner is reused by net (L3) / Copilot remote (L4), each declaring only its own spec, **zero replication**. GenBI is not migrated for now (image red line + the complex prepare special case for retrieval + already closed out as the template / fallback in its first construction phase; when its image must be touched anyway in the future, for example for the GenBI AgentCore dialect-guard addition, it is migrated along the way).

## 4. Verification checkpoints (each must pass; lesson learned from stage L0: verify down to docker build)

1. **After extracting the core**: platform tsc with 0 errors + in-process param-advisor unit tests / no regression (the core re-export preserves the API) + a **drift unit test** (a machine assertion that the AWS constants inlined in the core === the platform's true source, upgrading "manual synchronization" into a "machine guard")
2. **After generalizing the prebuild**: the paramadvisor core-dist is generated + **the genbi core-dist `git diff` must be empty** (machine proof that the generalization has zero regression)
3. **After extracting agent-runner and wiring it in**: not relevant in-process (a container piece); first pass `node --check` for syntax
4. **After the container change (the most critical)**: local `docker build infra/agent/paramadvisor` must exit 0 (reproducing the deployment build; stage L0 failed precisely for not verifying this step)
5. **Start the container locally**: it can import _runtime / core-dist + Strands can `new Agent` (even without connecting to the Gateway it reaches the "GATEWAY_URL missing" error, proving that module loading passes)
6. **After deployment**: buildx pushes the image + the paramadvisor Runtime is rebuilt + **headless-browser verification that the parameter advisor really produces recommendations** (values from the engine, explanations from the model), compared for consistency with pre-change behavior (the EMR channel catalog text going from 3 to 14 versions corrects hand-copy drift; it is not a regression)

## 5. Rollback

Tag `pre-strands-paramadvisor` (already created). The container / core / runner changes can all be restored by checkout; production is unaffected until the Runtime is rebuilt.

## 6. Relationship to stage L1 + position within the framework layer's four-piece kit

Independent. L1 touches the CDK stacks (pieces ① / ③, the protocol layer); L2 touches the containers (① core-build generalization + the ② runtime piece agent-runner + a core that eliminates hand copying). Physically separated.
This stage L2 = implementing **① core-build generalization + the ② runtime piece** of the framework-layer design ([strands-platform-unification-framework-layer.md](./strands-platform-unification-framework-layer.md)), with paramadvisor as the first "consumer" validating the framework's self-consistency;
L3 (net) / L4 (Copilot remote) reuse the same runner and declare only their own spec.
