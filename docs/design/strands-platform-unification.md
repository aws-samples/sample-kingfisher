# Strands Platform Unification — Unifying the AI Agent Framework of the Whole Platform on Strands (Top-Level Design)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is tracked in the design index. A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.
> ⚠️ **Implementation differences**: the `@platform/agent-kit` package was not implemented under that name;
> the agent code is currently distributed as follows: Ask-Your-Data (GenBI) in `platform/src/lib/genbi/` + `infra/agent/genbi/`, the parameter advisor in `platform/src/lib/param-advisor/` + `infra/agent/paramadvisor/`, the network advisor in `platform/src/lib/network-advisor/` + `infra/agent/netadvisor/`, and Copilot in `platform/src/lib/copilot/` (including `plan/strands-tools.ts`);
> `infra/agent/copilot` and `infra/lib/copilot-*` do not exist.

> Status: **pure design; no code has been touched**. Follows the engineering discipline `design-first-no-code-until-approved`: work starts only after the design has been approved.
> Origin: the explicitly stated original intent — "build a unified architecture on AgentCore + Strands Agents, keeping the early capabilities as a disaster-recovery fallback" —
> with a scope of **every AI capability on the platform** (not only GenBI). GenBI has already walked this path (the first construction phase of the GenBI engine unification) and is the template.
> Related: the GenBI engine unification design ([genbi-engine-unification.md](./genbi-engine-unification.md)), the AgentCore platform standard ([agentcore-standard.md](./agentcore-standard.md)), the pending agent-framework discussion (an internal engineering note),
> the engineering disciplines `global-grade-design-discipline` and `genbi-runtime-image-change-redline`, and the engine cookbook as platform knowledge ([engine-cookbook.md](./engine-cookbook.md)).

---

## 0. The goal in one sentence

Every AI capability on the platform converges on **the same architecture**:

> **A single pure-logic brain (the core: TypeScript source, compiled into core-dist for cross-language reuse) + standard Strands Agent assembly (which takes over the loop, tool dispatch, retries and Bedrock) + the AgentCore Runtime as the remote main path + the early in-process / hand-written implementation kept as a disaster-recovery fallback**.

This is exactly the shape GenBI reached when the first construction phase of the GenBI engine unification was closed out. The Strands platform unification = rolling this "template" out to the remaining three AI capabilities.

---

## 1. Factual baseline (all verified first-hand, with file:line evidence)

### 1.1 Status matrix of all AI capabilities on the platform

| Capability | Loop framework | Remote Runtime (AgentCore) | In-process / hand-written fallback | Container vs core duplicate source |
|---|---|---|---|---|
| **GenBI** | ✅ **Strands** (container `infra/agent/genbi/agent.js:6,208`) | ✅ Independent stack `BgpAgentCoreStack` · gated behind `-c genbi-runtime=1` (`agentcore-stack.ts:208`) | ✅ `execute.ts:81` runInprocess fallback shell | ✅ **Eliminated** (`agent.js:10-12` imports core-dist; prebuild + CI prevent drift) |
| **Copilot** | 🔶 planner = **Strands** (`copilot/plan/planner.ts:16,109`, but **runs inside the platform process**); Q&A agent = **hand-written loop** (`copilot/agent.ts:66-115`) | ❌ **Has a client (`copilot/agentcore-client.ts`) but no CDK stack** (`bin/app.ts` has no Copilot AgentCore stack) → never deployed | ✅ In-process is **the only backend actually running today** (`config.ts:16` defaults to inprocess) | — (no container, so no duplicate problem) |
| **netadvisor** | ❌ **Hand-written for loop** (`infra/agent/netadvisor/agent.js:17,139` ConverseCommand) | ✅ Independent stack `BgpNetAdvisorAgentCoreStack` · gated behind `-c netadvisor-runtime=1` (`bin/app.ts:133`) | ✅ `network-advisor/advisor-agent.ts` (in-process, 4 tools) | 🔴 **Hand-copied**: `RULES_TEXT` (`agent.js:28-49`) is synchronized manually from `lib/network-advisor/rules.ts` (the comment literally says "keep the two places in sync") |
| **paramadvisor** | ❌ **Hand-written for loop** (`infra/agent/paramadvisor/agent.js:13,163`) | ✅ Independent stack `BgpParamAdvisorAgentCoreStack` · gated behind `-c paramadvisor-runtime=1` (`bin/app.ts:138`) | ✅ `param-advisor/` (in-process) | 🔴 **Hand-copied**: `CATALOG_TEXT` (`agent.js:26`) + the prompt are synchronized manually from `lib/param-advisor/catalog.ts` + `prompt.ts` |

### 1.2 Key conclusions (these determine how the engineering is split)

**The unification is a "two-part kit", not one single thing:**

1. **The framework part**: hand-written `for(iter)` ConverseCommand loop → Strands `Agent.invoke()` (which takes over the loop, tool dispatch, retries and multi-turn handling).
2. **The duplicate part**: hand-copied TypeScript text (rules / catalog / prompt) in the container's plain JavaScript → extracted into a core (TypeScript source) → prebuild compiles core-dist → the container imports it → CI prevents drift.

- **GenBI** (the GenBI engine unification) has walked **both** parts to completion and is the only complete template: Strands as the carrier + the compiled `@genbi/core` artifact + a CI diff gate.
- **netadvisor / paramadvisor**: **both** parts are missing (hand-written loop + hand-copied duplicate source).
- **Copilot**: a special case — the planner already uses Strands (but runs in-process, not on the remote Runtime), the Q&A agent still has a hand-written loop, and **there is no AgentCore remote stack at all** (only a client that was never deployed).

### 1.3 Platform standards already established (distilled from the AgentCore platform standard and the GenBI engine unification)

- **Every AI capability = an independent Gateway + Runtime + Memory + three roles** (the AgentCore platform standard, [agentcore-standard.md](./agentcore-standard.md); GenBI / net / param each have an independent CDK stack, Copilot has none).
- **Two-pass deployment (DRY orchestration)**: `scripts/deploy-all.sh:66-74` uses associative arrays to give the three agents one deployment shape: first create ECR + Lambda + Gateway (phase 3, without the gating flag) → **a single buildx loop** pushes the three images (phase 4, `deploy-all.sh:156-165`) → a second deployment with `-c <cap>-runtime=1 -c <cap>-agent-tag=<sha>` creates the Runtime (phase 5, `:170-174`). The three capabilities are **isomorphic word for word**.
- **Red-line image publishing** (distilled from the GenBI engine unification; the engineering discipline `genbi-runtime-image-change-redline`): buildx `--provenance=false --sbom=false` for a single-platform manifest (`deploy-all.sh:159-160`, avoiding the OCI index trap); push to ECR only after full local verification. **All three agents share this one code path**; there is no per-agent script.
- **`redeploy-platform.sh` + SSM self-healing** (the engineering note on the silent wiring-degradation fix): a bare `cdk deploy BgpPlatformStack` silently wipes the AI wiring → the only safe entry point is `redeploy-platform.sh` (read the real ARNs from the CFN outputs → check that they are non-empty → write SSM `/bgp/wiring/*` → deploy with the complete `-c` set). `WIRING_KEYS` (`app.ts:38-43`) **contains only genbi / net / param, no copilot**.
- **contract-guard**: snapshot before a change, verify after deployment (the engineering discipline `contract-guard-before-after-every-change`).
- **The core-dist cross-language mechanism** (distilled from the GenBI engine unification): TypeScript core → compiled to CJS with `tsconfig.core.json` → copied to the two core-dist locations (Lambda and container) → a `{"type":"commonjs"}` sub-package.json resolves ESM / CJS interop → CI `git diff --exit-code` prevents "changed the source, forgot the prebuild".
- **Skill Lambda packaging comes in two flavors (this affects how stages A / B extract the core)**: GenBI = hand-written JavaScript with `Code.fromAsset`;
  - **the two advisors = esbuild `NodejsFunction` from a single source** (the entry points directly at `platform/src/lib/{network,param}-advisor/skills-handler.ts`).
  - → **The advisors' Lambda side therefore has no duplicate at all** (it shares the same TypeScript source with the in-process path); the duplicate exists only in **the hand-copied text of the container's agent.js**.
  - This makes extracting a core for the advisors lighter than for GenBI (only one problem to solve: "the container importing TypeScript").

---

## 2. Why it is worth doing (benefits) and what it costs (an honest assessment)

### 2.1 Benefits (in order of importance)

1. **Eliminating real duplicate sources of truth (the hardest benefit)**: netadvisor's `RULES_TEXT` and paramadvisor's `CATALOG_TEXT` + prompt are **synchronized manually between two places** today — exactly the trap GenBI fell into before stage 3 of its unification (change one place, forget the other → the model's "knowledge" drifts from the engine's logic → anti-hallucination pillar 2 fails). This is a **correctness risk**, not tidiness.
2. **Strands taking over the loop = less maintenance, fewer bugs**: a hand-written for loop has to manage the iteration cap, tool dispatch, multi-turn messages, error feedback and token accounting itself. The official Strands SDK provides all of these for free (verified in stage 3 of the GenBI unification: the hand-written loop was deleted, behavior stayed identical and became more stable). Four hand-written loops → one framework usage.
3. **Architectural consistency = understandable and self-installable for users worldwide** (the engineering discipline `global-self-install-architecture`): four isomorphic capabilities, one mental model, unified documentation / operations / troubleshooting.
4. **Closing Copilot's missing remote main path**: Copilot today **has only in-process**, with no AgentCore dual-engine fallback — contrary to the original intent "AgentCore as the main path, the early implementation as fallback". And Copilot is **the heaviest consumer of engine dialects** (it creates Spark / Redshift / Flink tasks), the capability that most deserves a robust remote architecture.

### 2.2 Costs (honest, not prettified)

1. **Three red-line image operations** (one container change each for netadvisor and paramadvisor; Copilot needs a **new** container + stack). Each requires two buildx passes + full local verification + online headless-browser regression + contract-guard. Neither the workload nor the risk is small.
2. **Taking Copilot remote is "from nothing"**, not a refactor: a new container agent.js, a new CDK stack, a new Gateway + tool mapping, a new ECR repository must all be written. It is the largest piece of the four capabilities. Moreover Copilot has **creating tools** (it creates tasks), so once remote, the authorization contracts of gate 2 / gate 3 must be reproduced isomorphically on the container side — more complex than the read-only advisors.
3. **The advisors' stateless `request` injection contract** (netadvisor injects `request` into every tool on every call, `agent.js:169`) must be preserved carefully when moving to Strands tool callbacks — GenBI injects a projectId, the advisors inject the whole request object, a heavier shape.
4. **Diminishing marginal returns**: the GenBI round yielded the most (dual-language engine, high frequency, dialects); the advisors are read-only consultants whose duplicated text is relatively stable; taking Copilot remote yields a lot but also costs the most.

### 2.3 Red-team counterarguments (they must be on the table)

- **"The advisors' duplicated text rarely changes; manual synchronization is good enough"**: partly true. But one missed synchronization is a silent anti-hallucination failure that is hard to diagnose in production environments around the world. It is "low frequency, high severity".
- **"Copilot in-process runs fine; why take it remote"**: in-process is constrained by the CloudFront 60-second wall (comment at `agent.ts:44`), and complex planning already works around it through the planner's asynchrony; the main value of a remote Runtime is **architectural consistency + isolation of future heavy loads**, not a bug that exists today. This item's **benefit leans toward "architectural tidiness" rather than "fixing a real defect"**, and that must be stated honestly.

---

## 3. Phased path (ordered by rising risk; each stage has its own red line, its own verification and its own rollback)

> Same principle as the GenBI engine unification: **from low risk to high**, starting with the "low-risk, high-benefit" items as practice and leaving Copilot (largest and hardest) for last. Each stage first produces a detailed implementation design before any code is touched, and work pauses between stages for confirmation.

### Stage A — paramadvisor: extract the core + move onto Strands (the smallest replica of the template)
- **Why first**: paramadvisor is the simplest (2 tools, read-only, `CATALOG_TEXT` is highly structured and easy to extract). Use it to prove the "advisor edition of the two-part kit" at the lowest cost.
- **The two parts**: ① extract the parts of `param-advisor/catalog.ts` + `prompt.ts` that the container needs into core-dist (or reuse the existing TypeScript compilation directly); ② the container's hand-written agent.js loop → Strands.
- **Red line**: changes the paramadvisor container image (two buildx passes + local verification + online headless-browser acceptance + contract-guard).
- **Rollback**: tag `pre-strands-paramadvisor`.

### Stage B — netadvisor: extract the core + move onto Strands (a replica with heavier rules text)
- Copy the approach once paramadvisor works. netadvisor's `RULES_TEXT` is longer and its `request` injection contract heavier, but the path is isomorphic.
- **Red line**: changes the netadvisor container image.
- **Rollback**: tag `pre-strands-netadvisor`.

### Stage C — Copilot Q&A agent onto Strands (in-process, not a red line)
- Copilot's hand-written Q&A loop in `agent.ts` → Strands (**in-process**; no container image involved, so not a red line). The planner is already Strands; this step unifies the Q&A side too.
- **Not a red line**: a platform-stack deployment, low risk. But the gate 2 / gate 3 authorization and the 60-second-wall wrap-up logic must be preserved.
- **Rollback**: tag `pre-strands-copilot-inprocess`.

### Stage D — Copilot remote Runtime (largest, hardest, built from nothing)
- A new `infra/agent/copilot/` container (Strands) + a new CDK stack `BgpCopilotAgentCoreStack` + Gateway + tool mapping + ECR + gating.
- **Difficulties**: reproducing the authorization contract of the creating tools isomorphically on the container side; how the two-phase planner + executor maps onto a remote runtime; the Memory backend.
- **Red line + a large project**: a separate full design round of its own (similar to the architecture document of the first construction phase of the GenBI engine unification, [genbi-engine-unification-architecture.md](./genbi-engine-unification-architecture.md)).
- **Optional**: this stage's benefit leans toward "architectural tidiness"; if the cost / risk is not worth it, do only A / B / C and stop at "advisors unified + Copilot on Strands in-process", leaving D as a separate project.

### Notes on stage boundaries
- A / B / C / D are **fully independent**: they can be done in batches, or only the first few. **This is not one indivisible big bang**.
- Every stage follows the discipline of the first construction phase of the GenBI unification: tag → full local verification → red-line image (where applicable) → online headless-browser regression → contract-guard with zero FAIL → commit + push stage by stage.

---

## 4. Relationship to the GenBI AgentCore dialect-guard addition

- **The two are orthogonal**: the Strands platform unification is about "how the agent framework is carried"; the dialect-guard addition ([engine-cookbook-genbi-remote-guard.md](./engine-cookbook-genbi-remote-guard.md)) is about "completeness of dialect-guard coverage".
- It has been decided that the dialect-guard addition is **done by closing it out in the Lambda** (no hand copying, no touching the image red line, reusing core-dist) — see decision 7 of the engine cookbook design ([engine-cookbook.md](./engine-cookbook.md)) and the clarification of this round.
- **Recommended order**: the dialect-guard addition is small and independent (closing out in the Lambda, roughly one change + deployment + verification) and can be done first to wrap up the engine cookbook; the Strands platform unification is a large project whose stage A starts only after the phased path has been approved.
- The two do not conflict: the dialect-guard addition touches the Lambda execution function, stage A of the platform unification onward touches containers / the framework; they are physically separated.

---

## 5. Decision points pending approval

1. **Should the Strands platform unification be started as a project?** (Or first only finish the dialect-guard addition to wrap up the engine cookbook and defer the unification?)
2. If started, **how far should the scope go**: A + B (the two advisors unified; real benefit, low cost)? + C (Copilot on Strands in-process)? + D (Copilot remote; a large project)?
3. **Order between the dialect-guard addition and the platform unification**: first the dialect-guard addition to wrap up the engine cookbook, then start the unification? (Recommended.)
4. If Copilot remote (stage D) is done, does it need **a project of its own** (it is essentially "the unfinished remote-Runtime item of the unified Copilot design" and may belong to the unified Copilot ([unified-copilot.md](./unified-copilot.md)) rather than to this unification)?

---

## Appendix: list of verified evidence this design is based on (re-checkable)

- `infra/agent/genbi/agent.js:6,10-12,208` — GenBI uses Strands + imports core-dist
- `infra/agent/netadvisor/agent.js:17,28-49,139,169` — netadvisor hand-written loop + hand-copied RULES_TEXT + request injection
- `infra/agent/paramadvisor/agent.js:13,24-26,163` — paramadvisor hand-written loop + hand-copied CATALOG_TEXT
- `platform/src/lib/copilot/plan/planner.ts:16,109` — Copilot planner uses Strands (in-process)
- `platform/src/lib/copilot/agent.ts:66-115` — Copilot Q&A agent hand-written loop
- `platform/src/lib/copilot/agentcore-client.ts` + `platform/src/lib/copilot/config.ts:16` — a client exists, defaults to inprocess, no stack
- `infra/bin/app.ts:128,133,138` — three AgentCore stacks (GenBI / Net / Param), no Copilot stack
- `infra/lib/agentcore-stack.ts:208` — GenBI Runtime gated behind `-c genbi-runtime`
- 6 dialect consumers: `copilot/plan/planner.ts`, `copilot/plan/step-handlers/handlers.ts`, `etl/job-service.ts`, `realtime/flink-sql-ai.ts`, `realtime/flink-service.ts`, `genbi/agent.ts`
