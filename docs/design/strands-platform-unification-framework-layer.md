# Strands Platform Unification · Top-Level Design of the Platform-Level Agent Framework Layer (`@platform/agent-kit`)

> - 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For multi-region behavior — place,
>   execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is tracked in the design index. A path mentioned in this document that no longer
>   exists means that the idea was not implemented as described here or has since been superseded.
> - ⚠️ **Implementation differences**: the `@platform/agent-kit` package was not implemented under that name;
>   the agent code is currently distributed as follows: Ask-Your-Data (GenBI) in `platform/src/lib/genbi/` + `infra/agent/genbi/`, the parameter advisor in `platform/src/lib/param-advisor/` + `infra/agent/paramadvisor/`, the network advisor in `platform/src/lib/network-advisor/` +
>   `infra/agent/netadvisor/`, and Copilot in `platform/src/lib/copilot/` (including `plan/strands-tools.ts`);
>   `infra/agent/copilot` and `infra/lib/copilot-*` do not exist.

> - Status: **✅ implemented (the runtime piece of the framework layer, F0→F3, is live)** (documentation audit calibration of 2026-08-26: the original status header was outdated — it read "pure design, no code touched"). Follows the engineering discipline `design-first-no-code-until-approved`.
> - Origin: it was pointed out that the "A / B / C / D — replicate the GenBI template three times" path of the original top-level design ([strands-platform-unification.md](./strands-platform-unification.md)) would produce 4 near-identical, separately maintained code bases —
>   **the same disease as "the model ID scattered across 9 places, a wrong assumption copied 9 times"** (duplicated effort is the opposite of a global-grade architecture).
> - Decision: **route ② — first extract a platform-level agent framework layer, and make each capability a consumer of it**; the first step is to deliver this top-level design (documentation only).
> - Evidence baseline: three file:line-level surveys (the 3 container agent.js files / the 3 CDK stacks / Copilot's special characteristics), see the appendix at the end.

---

## 0. One-sentence goal

> **Distill every mechanism GenBI has proven into a platform-level agent assembly kit, `@platform/agent-kit`;
> each AI capability (including the N-th one in the future) declares only "what is different about me" (core brain + tools + injector + result adapter),
> while loop assembly / core-dist compilation / the CDK stack / the model SSOT / the deployment shape all go through the same kit.**

Adding a new AI capability ≈ filling in one configuration, not copying code once more. The model ID naturally lives in the framework layer's SSOT, so the "scattered across 9 places" problem is eliminated structurally.

---

## 1. Why the framework layer must be extracted first (evidence)

Hard evidence from the three surveys:

| Layer | Current state | Conclusion |
|---|---|---|
| **Protocol layer** (mcp.js / the index.js HTTP contract / SigV4) | netadvisor's and paramadvisor's mcp.js are **byte-for-byte identical**; the HTTP entry points of the three containers are isomorphic | 100% built-in, **zero parameters** |
| **CDK protocol resources** (Gateway / Runtime / Memory + 3 roles) | The Gateway / Runtime / Memory structure of the three stacks is identical; **the Runtime role and the Memory role are byte-for-byte identical** | Built in as base-class constants |
| **Container loop** | GenBI = Strands `Agent.invoke`; the 2 advisors = hand-written `for(iter)` ConverseCommand | Unify on Strands (GenBI has verified it: behavior unchanged, more stable) |
| **Knowledge source** | GenBI = import core-dist (single source of truth); the 2 advisors = hand-copied `RULES_TEXT` (3,514 characters) / `CATALOG_TEXT` (6,401 characters) | Hand copying = a live drift risk; extract a core to eliminate it |
| **Model ID** | GenBI defaults to `sonnet-4-6`; the 2 advisors default to `opus-4-6-v1`; **the same contract written separately by each, and already drifting** | Converge on an SSOT |

**No shared base class / construct exists at all** (confirmed by grep). Today there are "3 highly similar, independently maintained copies"; replicating again would only make it 4 / 5. That is the hard reason to extract the framework layer first.

---

## 2. Framework-layer architecture: a four-piece kit + capability tiers

### 2.1 The four-piece kit (horizontal layering; each layer reusable on its own)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ① @platform/agent-kit/core-build   ── core-dist build mechanism                      │
│    any capability declares its core source dir → one tsc→CJS → copy to Lambda +      │
│    container (generalizes genbi-core-prebuild.sh, drops the genbi hard-coding)       │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ② @platform/agent-kit/runtime      ── Strands assembly template (container)          │
│    buildAgent({core, tools, inject, capture, adapt, prepare?})                       │
│    built in: MCP connection / tool hot-loading / loop / retries / step records /     │
│    error feedback                                                                    │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ③ AgentCoreStackBase (CDK construct) ── deployment shape                             │
│    takes 6 kinds of parameters (naming / model SSOT / packaging / permission         │
│    callback / tools / env)                                                           │
│    built in: ECR / Gateway / Runtime gating / Memory / 3 roles (the byte-for-byte    │
│    identical ones)                                                                   │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ④ @platform/agent-kit/model        ── single source of truth (SSOT) for the model ID │
│    DEFAULT_MODEL_ID + env fallback; ② and ③ both read from here. 9 places → 1        │
└──────────────────────────────────────────────────────────────────────────────────────┘
         ↑ across the build boundary: one copy on the platform side, one on the infra side
           (a physical constraint), same value + comments pointing at each other
```

### 2.2 Capability tiers (vertical; the key insight) — not "one big unification"

The three surveys prove that **AI capabilities come in two tiers, and forcing one unification would drag the simple capabilities into complexity**:

| Tier | Capabilities | Contract | Framework support |
|---|---|---|---|
| **L-Read (read-only agents)** | GenBI, netadvisor, paramadvisor | One invoke → a structured return; pure reads; safe for anyone with read permission | The four-piece kit is **sufficient** |
| **L-Create (creating agents)** | Copilot | Two phases (planner → executor), a state machine (8 states), writes DynamoDB drafts, four gates (capability surface / allow-list / RBAC / confirmation), audit + isolation marker | The four-piece kit **+ an extension contract** |

**Framework-layer design principle**: the four-piece kit covers L-Read completely; L-Create **layers** a "creating-capability contract extension" (`agent-kit/create-contract`) on top of it, rather than forcing Copilot's complexity into every capability. GenBI and the advisors should never carry the baggage of action-guard / the state machine.

---

## 3. Interface design of the four-piece kit (evidence-driven parameterization points)

### ① core-build (generalizing the build mechanism)
Today `genbi-core-prebuild.sh` hard-codes `genbi`. Generalize it into a declarative form:
```
# agent-kit.manifest.json（每能力一份）
{ "capabilityId": "paramadvisor",
  "coreSrc": "platform/src/lib/param-advisor/core",     // 抽出的纯逻辑
  "coreDist": ["infra/agent/paramadvisor/core-dist",     // 容器
               "platform/src/lib/param-advisor/... "] }  // (advisor Lambda 已 esbuild 单源，无需)
```
One script iterates over all manifests → tsc → copy → write `{"type":"commonjs"}` → CI `git diff --exit-code` prevents drift. **Migrating GenBI back onto it verifies that the mechanism is self-consistent**.

### ② runtime (the Strands assembly template) — takes 3 hard conflicts + 8 soft hooks
The **only 3 hard conflicts** confirmed by the survey must be parameterized; everything else gets a default implementation:
```js
buildAgent({
  // 硬冲突 1:上下文注入器（flat-scalar vs nested-object 语义冲突）
  inject: (rawArgs, input) => finalArgs,   // GenBI:{...raw,projectId} / advisor:{...raw,request:req}
  // 硬冲突 2:循环引擎 = Strands（统一，手写循环退场）
  // 硬冲突 3:模型 = 从 ④ model SSOT 取（不再各写默认值）
  core: { systemPrompt, buildCatalog },    // import core-dist（消手抄）
  tools,                                    // Gateway 发现 → 包装
  capture: (toolName, res) => captured,    // GenBI:columns/rows→last / advisor:按suffix→lastX
  adapt:   (agentOut, captured) => wire,    // GenBI:{answer,sql,rows} / advisor:{verdict,...}
  prepare?: (input) => {extras,messages},  // 可选:GenBI 独有(检索/口径预取);advisor 无
  memory?, steps?, toolNameStrategy?,       // 软钩子:默认实现覆盖多数
})
```
Built in (zero parameters): MCP connection / tool hot-loading / iteration cap / multi-turn history / error feedback / token accounting.

### ③ AgentCoreStackBase (the CDK base class) — takes 6 kinds of parameters
```ts
new AgentCoreStackBase(scope, id, {
  capabilityId,                    // A. 命名派生:所有资源名+context key+Memory namespace 自动生成
  // B. modelId 从 ④ SSOT 取（默认不再写在栈里）
  skill: { packaging: "asset"|"esbuild", ... },  // C. 打包策略(GenBI asset / advisor esbuild)
  attachSkillPolicy: (role)=>void, // D. Lambda 探测权限回调(最不可抽象) + dataKey?
  tools: InlinePayload[],          // E. Gateway 工具 schema(纯业务)
  runtimeEnvironment,              // F. Runtime env(*_MAX_ITERS 等)
})
```
Built in (byte-for-byte identical across the three stacks): ECR, Gateway (`AWS_IAM` + `MCP`), GatewayTarget (`GATEWAY_IAM_ROLE`), Runtime (`PUBLIC` / `HTTP` / gating / dependency chain), Memory (`EventExpiry:90` + semantic strategy), **all permissions of the three Gateway / Runtime / Memory roles**, every CfnOutput. 751 lines × 3 → a base class of ~300 lines + ~40 lines of configuration per capability.

### ④ model (SSOT) — 9 places → 2
```ts
// platform/src/lib/ai/model.ts（运行时侧唯一源）
export const DEFAULT_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"; // 实测开箱可用
export const modelId = process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID;
// infra/lib/shared/model.ts（部署期侧唯一源，跨构建边界无法 import，同值+注释指向）
```
All 9 places (4 platform configs + 5 infra stacks / containers) import one of these two. **Changing the model = touching 1 line**. The default changes to `sonnet-4-5` (verified to work out of the box), correcting the wrong comment that "sonnet-4-6 needs no subscription".

### L-Create extension contract (`agent-kit/create-contract`, used only by Copilot)
Layered on top of the four-piece kit and distilled in the framework layer as the "standard for creating capabilities":
- **Four gates**: gate 1, no `execute` at the type level (`CopilotToolKind="read"|"create"`); gate 2, the action-guard allow-list that denies by default; gate 3, editor RBAC + audit; the 4th gate, human confirmation through the state machine's `awaiting-confirmation` / `confirmed`.
- **Two-phase orchestration**: planner (Strands structuredOutput / Zod) → executor (the claimStep / reconcile / runToken state machine).
- **Write authorization**: write DynamoDB drafts with the caller's own token (no privilege escalation), isomorphic across the remote and in-process paths.
- **Isolation markers**: `createdByCopilot` / `triggeredBy="copilot"`, mandatorily excluded from baseline / learn and finops / anomaly.

---

## 4. Implementation path (revising A / B / C / D of the original top-level design)

The original path "replicate the template" → becomes "**build the framework layer first and migrate the template back onto it, then onboard the remaining capabilities**":

| Stage | Content | Red line | Benefit |
|---|---|---|---|
| **F0 framework-layer MVP** | Extract ④ the model SSOT + ③ the CDK base class + ② the Strands template + ① core-build; **verify the framework's self-consistency by migrating GenBI back onto it** (feed the already-verified template back in; zero behavior change = the framework is right) | GenBI image red line (but behavior is unchanged, so the risk is controllable) | Framework established + the 9 model places converged + no GenBI regression |
| **F1 = former stage A** | paramadvisor onboarded onto the framework (declared configuration, not a replica): hand-written loop → ②, CATALOG_TEXT → ① core, model → ④ | paramadvisor image | Hand-copied duplicate eliminated + the first "consumer" validates the framework |
| **F2 = former stage B** | netadvisor onboarded (same as F1; RULES_TEXT → core, the request injector reuses ②'s inject hook) | netadvisor image | Hand-copied duplicate eliminated |
| **F3 = former stage C** | Copilot Q&A agent onto Strands (in-process, not a red line) + distill the L-Create extension contract | None (platform deployment) | Q&A unified + the creating-capability contract takes shape |
| **F4 = former stage D** | Copilot remote Runtime (a new stack built with ③ the base class + the L-Create extension) — largest and hardest | New image + stack | Copilot's remote main path completed |

**The key change**: F0 builds the framework layer first (the original design had no such step and replicated directly). With F0 in place, F1–F4 are "onboarding" rather than "copying". **Every stage still has its own red line, its own verification and its own rollback** (tag `pre-F<n>`).

---

## 5. Honest costs and counterarguments

- **F0 is a net new investment**: the original design skipped it and replicated directly, which is faster in the short term — but that is borrowing technical debt. F0 is front-loaded; F1–F4 then save a great deal of effort and leave no 4 near-identical code bases behind.
- **The risk of over-abstracting the framework layer**: forcing L-Create into the four-piece kit → the simple capabilities get dragged into complexity. **Hence the explicit tiering** (L-Read on the four-piece kit / L-Create layered on top), not one big God framework.
- **The risk of migrating GenBI back**: F0 touches the already-verified template. Mitigation = zero behavior change as the acceptance criterion (the Strands assembly stays the same; it merely moves into the framework layer), with the image red-line discipline throughout + headless-browser regression.
- **"Diminishing returns for the advisors" still holds**: but **eliminating the hand-copied duplicate source** is a correctness benefit (a missed synchronization = a silent anti-hallucination failure), not tidiness; and once onboarded onto the framework the cost is very low (configuration-driven).

---

## 6. Decision points pending approval

1. Is the **architectural direction — the four-piece framework-layer kit + the capability tiers (L-Read / L-Create)** — approved?
2. Is the **implementation path F0→F4** approved (F0 builds the framework first and migrates GenBI back, replacing the original "replicate directly")?
3. Should **the detailed implementation design for F0 be produced now** (down to which files are created, how GenBI is migrated back, and the acceptance checklist)?
4. The model default `sonnet-4-5` lands together with F0's ④ model SSOT (no longer changed separately in 9 places) — confirmed?

---

## Appendix · Evidence baseline (summary of the conclusions of the three file:line surveys)

- **Container agent.js**: the protocol layer (mcp) is 100% isomorphic; 3 hard conflicts = the injector (flat-scalar vs nested-object) / the loop (Strands vs hand-written) / the model default (drift between sonnet-4-6 and opus-4-6-v1); 8 soft differences = knowledge source / tool names / result adaptation / capture / prepare / steps / env / module system.
- **CDK stacks**: Gateway / Runtime / Memory + 3 roles are isomorphic across the three stacks (the Runtime role and the Memory role are byte-for-byte identical); 6 parameterization points = naming derivation / model / packaging strategy (asset vs esbuild) / Lambda permission callback / tool schema / runtime-env; GenBI is the asset flavor and the only one with `s3:PutObject`.
- **Copilot**: the only capability without a remote stack; creating tools (creates drafts); two agents — planner (Strands structured output) + Q&A (hand-written loop); four gates + an 8-state state machine + human confirmation; a heavy three-layer consumer of dialects; going remote needs the L-Create extension contract (write authorization / two phases / gates isomorphic on the remote side).
