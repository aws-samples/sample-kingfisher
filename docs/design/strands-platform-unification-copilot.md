# Strands platform unification, stage L4 — Copilot remote-hosting assessment → [Empirical closure: not remote-hosted; stays in the platform process]

> - 📌 **Scope note (reconciled on 2026-10-13)**: this document was written during the single-region stage and records the design as it stood then (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place,
>   execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is tracked in the module index of the engineering documentation; a path
>   mentioned below that no longer exists means that the idea was not implemented as written here or has since been superseded.
> - ⚠️ **Implementation differences**: the `@platform/agent-kit` package was not implemented under this name;
>   the current agent code is distributed as follows: Ask-Your-Data `platform/src/lib/genbi/` + `infra/agent/genbi/`, parameter advisor `platform/src/lib/param-advisor/` + `infra/agent/paramadvisor/`, network advisor `platform/src/lib/network-advisor/` + `infra/agent/netadvisor/`, Copilot
>   `platform/src/lib/copilot/` (including `plan/strands-tools.ts`);
>   `infra/agent/copilot` and `infra/lib/copilot-*` do not exist.

> - Status: **✅ Decided (2026-07-24). Decision: stage L4 does not remote-host the Copilot; only the real gap in the isolation marker (phase 0) is fixed. The Strands platform unification is hereby closed.**
> - Follows the engineering disciplines `design-first-no-code-until-approved` + `global-grade-design-discipline` + `verification-assertion-checklist-first` (verify before acting, to avoid premature solution judgments).
> - This document is a **design decision record**: it preserves in full the chain of reasoning "propose remote-hosting → verify layer by layer → conclude that it should not be remote-hosted", so that the future question "why does the Copilot not run on a remote Runtime" has a traceable answer.

---

## 0. Conclusion first (TL;DR)

**The Copilot is not remote-hosted; it stays in the platform process — this is the correct conclusion of the "capability tiering" design, not unfinished work.**

**Why (verified layer by layer, not an armchair judgment)**: the instruction was "verify before acting; avoid premature solution judgments". Layer-by-layer empirical verification revealed that the Copilot's read-only tools are **by nature a part of the platform itself** (they read the platform's own business tables + reuse the semantic layer / RBAC guard), fundamentally different from the advisors' "self-contained AWS probes". Forcing remote-hosting = tearing something that belongs in-process apart into a distributed system, **and every layer needs extra glue**:
1. The read-only tools are coupled to the platform semantic layer (`getContextForGrounding`) / RBAC (`projectFilter` drags in `next/server`) → they cannot be made esbuild single-source self-contained the way the advisors are (empirical verification in section 1.2);
2. The Lambda option either creates a second copy of the semantic layer (hitting the `business-glossary-semantic-layer` red line) or degenerates the Lambda into a thin HTTP proxy;
3. A thin proxy has to go over the public CloudFront path (the ALB security group allows only CloudFront, `platform-stack.ts:767`) + needs **machine-identity authentication** (the platform endpoints currently accept only logged-in users) — yet another new mechanism;
4. And the benefit is merely "architectural tidiness" — in-process Q&A already runs well, has no real defects, and the 60-second wall was long since bypassed by making the planner asynchronous.

**Cost (distributed glue, heavy) ≫ benefit (architectural tidiness, weak) → violates the global-grade design discipline (do not force things in for the sake of tidiness; choose technology for the long term) → not done.**

**The Strands platform unification is substantively closed**: the four pieces of the framework layer are built + agent-runner **has been proven general by two proofs** (L2 parameter advisor + L3 network advisor) + **3 of 4 AI capabilities have a remote main path** (GenBI / parameter advisor / network advisor). The fourth, the Copilot, because of its "creating + deeply coupled to the platform" nature, **is best served architecturally precisely by staying in the platform process.**

**The only closing action = phase 0: fix the real gap in the Copilot isolation marker** (`triggeredBy="copilot"` was claimed done but never actually implemented + the two exclusions in baseline / finops were never added; see section 7). This is technical debt orthogonal to remote-hosting, an independent small fix.

---

> ⚠️ Sections 1–10 below are the **complete record of the decision process** (Option A as written when remote-hosting was proposed + how the layer-by-layer verification overturned its assumptions). The conclusion is settled (section 0); they are kept so that "why not remote-hosted" can be traced. **Only phase 0 in section 7 is actually executed.**

---

## 0'. (Historical) The formerly proposed Option A and its scope

> Option A was decided on 2026-07-23: remote-host only the stateless "general Q&A ask" (the L-Read form); the planner / state machine / database writes / gates stay in the platform; agent-runner is not changed.
> Its foundation was later overturned by the empirical verification in section 1.2 (the skills handler cannot be made self-contained); on 2026-07-24 the ruling changed to "not remote-hosted".

**The scope boundary Option A defined**:
- ❌ The planner is not remote-hosted (structuredOutput + immediate database write; stateful orchestration)
- ❌ The state machine / createDraft / the four gates do not go into the container (stateful writes + RBAC)
- ❌ agent-runner is not changed (Q&A-type spec: captureSuffix=null + finalize takes the reasoning; empirical verification item 2 confirms that zero changes are feasible)

---

## 1. Survey of the current state (verified first-hand, with file:line)

### 1.1 General Q&A ask — exactly the L-Read form, and the platform-side wiring is already in place

| Dimension | Current state | file:line |
|---|---|---|
| Loop | hand-written `for(iter)` ConverseCommand (**can yield to agent-runner's Strands invoke**) | `lib/copilot/agent.ts:66-115` |
| Tools | `buildTools(canCreate)` = READ_TOOLS(7) ∪ (canCreate? CREATE_TOOLS(4)) | `tools/registry.ts:11-13` |
| systemPrompt | `systemPrompt({memory,canCreate})` | `agent.ts:52` |
| Multi-turn history | `slice(-6)` alternating user/assistant (isomorphic to agent-runner) | `agent.ts:55-59` |
| Return value | `{answer, steps, usage}` (**a one-shot wire format, exactly the shape agent-runner's finalize can produce**) | `agent.ts:31-35` |
| modelId | `COPILOT.modelId`=`resolveModelId()`→ ai-model.json SSOT (already converged; same source as param/net) | `config.ts:14`, `ai/model.ts:19` |
| **Platform-side dual-backend wiring** | `ask/route.ts:48-65` try `invokeCopilotAgent`→catch `runCopilot` (**already in place; L4 changes not a single line**) | `ask/route.ts:48-65` |
| remote client | `invokeCopilotAgent(sessionId, input)` complete (copied from GenBI), returns `{answer,steps,usage}` | `agentcore-client.ts:22-51` |
| config switch | `COPILOT_BACKEND`/`COPILOT_RUNTIME_ARN`/`isAgentCoreConfigured()` (default inprocess) | `config.ts:17,18,40-42` |

**Conclusion**: the platform-side remote wiring (dual-backend route + client + config) **was already laid but never deployed** when the platform-side wiring of the [unified Copilot](./unified-copilot.md) was built (there was no producer of a Runtime ARN). L4 = add the last segment, "container + stack + deployment", and the wiring is powered up naturally.

### 1.2 Deployment infrastructure gaps (compared with what the 3 advisors already have)

| Artifact | Advisor state | Copilot state | L4 |
|---|---|---|---|
| Container directory `infra/agent/<cap>/` | ✅ genbi/netadvisor/paramadvisor | ❌ **no copilot** | 🆕 create (modeled on the paramadvisor skeleton) |
| AgentCore stack `infra/lib/<cap>-agentcore-stack.ts` | ✅ 3, all on the shared base class `agentcore-base.ts` | ❌ **none** | 🆕 create (modeled on paramadvisor; base class unchanged) |
| Skills Lambda source `lib/<cap>/skills-handler.ts` | ✅ net/param (esbuild single source) | ❌ **none** | 🆕 create (read-only skills, see section 3.3) |
| IAM policy `infra/lib/<cap>-iam.ts` | ✅ net/param | ❌ **none** | 🆕 create (read-only discovery permissions) |
| DynamoDB tables bgp-copilot-* | — | ✅ **5 tables already created** (database-stack.ts) | ✅ zero changes |
| Shared base class agentcore-base.ts | ✅ props already parameterized | — | ✅ **unchanged** (pass parameters as paramadvisor does) |
| deploy-all/redeploy/app.ts orchestration | ✅ driven by 3-agent associative arrays | copilot column missing | ✏️ add one column (mechanical) |

---

## 1.5 🔬 Layer-by-layer empirical verification (2026-07-24; instruction: "verify before acting, avoid premature solution judgments") — overturns the foundation of remote-hosting

Each key assumption of Option A was verified at code level; **the results overturned the foundation of remote-hosting**:

| # | Original assumption | Verification method | Result | file:line evidence |
|---|---|---|---|---|
| **1** | The Copilot read-only tools can copy the advisor skills-handler (esbuild single-source, self-contained) | Read the import chain of the READ_TOOLS handler | ❌ **Overturned** | `read-tools.ts:6-8` is coupled to `@/lib/aws/dynamodb`+`@/lib/projects/guard`(projectFilter/envFilter)+`@/lib/genbi/context`(getContextForGrounding = the semantic-layer choke point);<br>by contrast, `network-advisor/skills-handler.ts:21-24` imports only modules inside its own directory = self-contained |
| **1b** | projectFilter can be cleanly bundled into a Lambda | Read the guard.ts imports | ❌ **It cannot**: `guard.ts:7` imports `next/server` (NextRequest/NextResponse) — the Next runtime cannot go into a standalone Lambda; projectFilter/envFilter are pure functions (`:74/:89`) but are dragged down with next/server by living in the same file | `projects/guard.ts:7,74,89` |
| **2** | agent-runner needs zero changes for the Q&A type (captureSuffix=null / finalize takes the reasoning) | Read agent-runner's capture and reasoning-extraction paths | ✅ **Holds**: `:69` captureSuffix is optional (`if(spec.captureSuffix && ...)`), `:102` the reasoning is extracted from lastMessage, `:117` it is passed to finalize. A Q&A spec works; the runner is unchanged | `_runtime/agent-runner.js:69,102,117` |
| **3** | Option ②: the container calls back a platform HTTP endpoint | Read the Gateway target mechanism | ⚠️ **Corrected**: a Gateway target accepts only `Mcp.Lambda.LambdaArn`; it cannot attach arbitrary HTTP; only a "Lambda thin proxy" is possible | `agentcore-base.ts:83` |
| **4** | The remote side can read the database with the caller's identity | Read the identity propagation of the advisor / GenBI tools | ⚠️ **Corrected**: the AgentCore path **propagates only business parameters** (the advisors inject request, GenBI injects projectId) and **does not propagate the caller's identity**; the skills Lambda uses its own role | `network-advisor/skills-handler.ts:179` (uses event.request), `genbi/agent.js:183` (injects projectId) |
| **5** | A Lambda thin proxy can reach the platform over the network | Read the platform topology + the advisor Lambda's network placement | ⚠️ **Added complexity**: the platform ALB security group allows inbound only from CloudFront (`platform-stack.ts:767`); the advisor skills Lambda has no VPC (`netadvisor-agentcore-stack.ts:55`) → a thin proxy can only go over the public CloudFront path + needs machine-identity authentication (the platform endpoints currently accept only logged-in users) | `platform-stack.ts:630,644,767` |

**The cumulative picture from the verification**: every layer verified for Copilot remote-hosting surfaced a new coupling (cannot be self-contained → the Lambda either copies the semantic layer or becomes a thin proxy → the thin proxy goes over the public internet + needs machine authentication → …). **Root cause**: the Copilot read-only tools **are by nature a part of the platform itself** (they read the business tables + reuse the semantic layer / RBAC guard), unlike the advisors, which are "self-contained AWS probes". **Forcing remote-hosting = tearing something that belongs in-process apart into a distributed system**, with glue at every layer (copies / proxies / machine authentication).

**Decision (section 0)**: cost (distributed glue, heavy) ≫ benefit (architectural tidiness, weak) → violates the `global-grade-design-discipline` → **not remote-hosted**. This is a conclusion reached by layer-by-layer verification, not a premature judgment.

---

## 2. (Historical) The core difficulty of the formerly proposed Option A: identity propagation through gate 3 for the create tools

This is the **only place where the Copilot is genuinely harder** than the advisors (which are purely read-only); the detailed design had to nail it down.

- **Problem**: when `canCreate=true`, ask's tool set includes **CREATE_TOOLS (4 draft-creation tools)** (registry.ts:11-13).
- In-process they use **the caller's own token** (`caller.token`) to write DynamoDB drafts + pass RBAC (gate 3).
- But the remote Runtime's `mcp.js` signs its Gateway calls with **the container's own SigV4 credentials** (mcp.js:20-25) and **does not propagate the caller's identity** — if the create tools were moved into the Runtime container's Gateway skills, the container would write the database under its own identity, and **gate 3 (no privilege escalation) would be hollowed out**.

**Solution (nailed down, written into the detailed design) — the remote container carries only read-only tools; create goes "back to the platform"**:

> **Gate 1 is tightened on the remote side to "pure read-only"**: the Copilot remote Runtime's Gateway mounts only **READ_TOOLS (7 read-only discovery tools)** and **does not mount CREATE_TOOLS**. Remote Q&A can "read + answer + suggest", but **the action of creating a draft does not happen remotely**.

Three sub-options; **A1 (recommended)** is chosen:

| Sub-option | When remote Q&A meets a "create" request | Complexity | Gate 3 safety |
|---|---|---|---|
| **A1 (recommended) pure read-only remote + create kept in-process by routing** | Route layer: requests with `canCreate=true` **do not go remote** (they still go in-process, because they may trigger a create tool); `canCreate=false` (viewer / not logged in / pure query) goes remote. The remote container is read-only forever. | Low | ✅ Inherent (remotely there are no write tools and no identity problem) |
| A2 remote read-only + the model steers to the page | The remote container is read-only; the systemPrompt states explicitly "to create, go to the corresponding page or use the Plan Center" (the same approach as the unified Copilot's read-only period). All requests can go remote. | Medium | ✅ (but editor users lose the ability to create drafts directly inside the drawer — a functional regression) |
| A3 remote propagation of the caller's token to the Gateway | Change mcp.js to sign with the caller's token instead of the container credentials — **touches the shared agent-runner/mcp.js components (red line) + whether the AgentCore Gateway supports forwarding user JWTs is doubtful** | High | ⚠️ Needs verification; touches shared components |

**Reasons for choosing A1**:
- Minimal change, zero risk to shared components, gate 3 kept inherently (the remote side simply has no write tools).
- Matches the spirit of "capability tiering": what the remote Runtime carries is **the L-Read half** (Q&A / discovery / read-only); **the L-Create half (creating drafts) belongs in the platform process anyway** (on the same side as the state machine / database writes).
- The route branching is simple: only `useAgentCore && !canCreate` goes remote; everything else is in-process. **Editor users lose none of their create capability** (they go in-process; functionality is completely unchanged); viewer / read-only Q&A goes remote (the bulk of the Q&A volume, which gets the remote main path).
- The honest cost: editor users' **pure Q&A** (creating nothing) also goes in-process because canCreate=true — but this does not affect functional correctness (in-process Q&A is fully usable); that portion simply does not pass through the remote path. Acceptable (the remote benefit was mostly architectural tidiness anyway).

**This A1 routing rule is the only new platform-side code L4 needs** (one `&& !canCreate` added to the backend-selection condition in ask/route.ts); everything else is infrastructure.

---

## 3. Implementation plan (following the L2/L3 paradigm + the Copilot differences)

### 3.1 Container `infra/agent/copilot/` (new, modeled on the paramadvisor skeleton)
- `agent.js`: declares a spec and plugs into `runAdvisorAgent` (agent-runner). The Copilot Q&A spec:
  - `clientName: "bgp-copilot-agent"`
  - `systemPrompt: () => copilotSystemPrompt(...)` — from core-dist (see section 3.2, core extraction)
  - `firstTurnText: (req) => req.prompt` — Q&A uses the prompt directly (unlike the advisors, which assemble a request summary)
  - `inject: (raw, req) => ({ ...raw, projectId: req.projectId, env: req.env })` — injects the project context (**note: no token is injected**; remote read-only needs no identity; isomorphic to GenBI's projectId injection)
  - `captureSuffix: null` — Q&A has no "authoritative one-stop result tool" (unlike the advisors' analyze_connectivity / recommend_parameters); the answer is taken directly from the reasoning
  - `finalize: (reasoning, _captured, steps, usage) => ({ answer: reasoning, steps, usage })` — assembles CopilotAskOutput
  - `maxIters/maxTokens`: from the COPILOT env
- **Verification point**: this tests whether agent-runner is also general for a **"pure Q&A type without captureSuffix"** (all advisors have a captureSuffix; for the Q&A type, answer=reasoning). **If agent-runner needed a change for this = the contract is defective; stop and reassess** (the same iron rule as in L3). Expected: captureSuffix is already optional (agent-runner.js:69 `if(spec.captureSuffix && ...)`), finalize just takes the reasoning, **so zero changes are expected**.
- `index.js`: ESM; `/invocations` validates `input.prompt` (as paramadvisor, with the field swapped).
- `package.json`: type:module + the full Strands family (as paramadvisor).
- `Dockerfile`: COPY _runtime + core-dist (as paramadvisor).
- `mcp.js`: deleted (use the shared _runtime/mcp.js).

### 3.2 Core extraction `lib/copilot/core/` (eliminates the hand-copied Q&A systemPrompt)
- The current `systemPrompt({memory,canCreate})` in `lib/copilot/prompt.ts` → extracted into `core/prompt.ts`; the container imports core-dist (eliminating the hand copy, as in L2/L3).
- **But remote is read-only**: the remote container passes a systemPrompt with `canCreate=false` semantics (read-only wording). In-process still uses the full version. **The systemPrompt must support a readOnly variant** — when extracting the core, make canCreate a parameter (it already is); remote always passes false.
- Scope of the core extraction: only `systemPrompt` + the pure string constants it depends on. **The READ_TOOLS tool definitions are not extracted into the core** (they are platform-side handlers; the remote side reimplements them in the skills Lambda, see section 3.3).
- A reverse re-export keeps the in-process API unchanged (as in L2/L3).
- prebuild: add a copilot row to the core-prebuild.sh registry.

### 3.3 Skills Lambda `lib/copilot/skills-handler.ts` (new, read-only discovery skills)
- The remote Gateway needs an MCP tool backend. Created after the pattern of `network-advisor/skills-handler.ts` (esbuild single source).
- **Maps only the 7 read-only tools of READ_TOOLS** (list_datasources/list_jobs/get_run_detail/... and the other read-only discovery tools), **not CREATE_TOOLS**.
- These tools are currently platform-side handlers (read DynamoDB / call AWS APIs). The skills Lambda runs with **its own read-only IAM role** (no caller identity is needed, since it is purely read; the readable resource surface is bounded by IAM, see section 3.4).
- ⚠️ **Handling of the read-only over-reach surface (decided on 2026-07-23: the skills Lambda adds projectId filtering)**: in-process, the read-only tools use caller.token (seeing only the resources visible to the caller); the remote skills Lambda uses the container role. To shrink the over-reach surface to "read-only metadata within the same project":
  - **Every remote read-only tool's input must carry projectId** (injected by the container's spec.inject, see section 3.1); the skills Lambda **returns only resources of the current projectId** (no cross-project reads).
  - **Metadata only is returned** (table names / job names / status / schema), **never sensitive payloads** (credentials / secrets / data row values).
  - Conclusion: the over-reach surface shrinks to "a viewer can see read-only metadata within their own project" — and a viewer already has read-only rights within the project (the RBAC viewer definition), so **there is almost no real over-reach**. This is an acceptable minimal surface.

### 3.4 CDK stack `infra/lib/copilot-agentcore-stack.ts` (new, modeled on paramadvisor; base class unchanged)
- `class CopilotAgentCoreStack`: its own ECR + skillFn (copilot-skills) + the two Gateway/Runtime roles + IAM (copilot-iam.ts read-only discovery permissions), then calls `buildAgentCoreResources({ capabilityId:"copilot", tools:[read-only tool schemas], ... })`.
- `infra/lib/copilot-iam.ts`: the skills Lambda's read-only policy (Describe/List/Get on datasources/etl/flink/engine/lineage/metrics + DynamoDB read-only on bgp-*).
- Memory: `selfmanaged` (the DynamoDB turns table already exists) or agentcore Memory (as the advisors).

### 3.5 Orchestration wiring (mechanical; add one column, following the 3-agent arrays)
- `infra/bin/app.ts`: import + `new CopilotAgentCoreStack` + add the 4 copilot-* keys to WIRING_KEYS.
- `scripts/deploy-all.sh`: add a copilot column to AGENTS + the 8 associative arrays + platform wiring -c + SSM persistence.
- `scripts/redeploy-platform.sh`: add a copilot column to the 3 arrays.
- `infra/lib/platform-stack.ts`: add COPILOT_BACKEND/RUNTIME_ARN/MEMORY_* to env (currently 0 occurrences; a pure gap).
- **core-prebuild.sh**: add copilot to the registry (core-dist + _runtime distribution).

### 3.6 The only platform-side code change: the A1 routing rule
- `ask/route.ts:53` `if (useAgentCore)` → `if (useAgentCore && !canCreate)` (+ a comment: create-type requests stay in-process to preserve the gate-3 identity).
- **This single line is the only business logic.** Everything else is infrastructure.

---

## 4. Reuse vs. new build (the nature of the L4 work at a glance)

```text
✅ Reused (zero changes / zero duplication):
   agent-runner.js (Strands assembly, 3rd reuse, Q&A-type L-Read)
   mcp.js (shared MCP client)
   agentcore-base.ts (CDK base class; props already sufficient)
   ai-model.json (model SSOT)
   ask/route.ts dual-backend wiring + agentcore-client.ts + config switch (laid by the unified Copilot)
   bgp-copilot-* 5 tables (created by the unified Copilot) + TaskRole bgp-* wildcard IAM
   the two front-end entry points + ExecutionPlanCard (already reused; untouched)

🆕 New (following the advisor paradigm, not duplicating the loop):
   infra/agent/copilot/ (container; declares a spec)
   infra/lib/copilot-agentcore-stack.ts + copilot-iam.ts
   lib/copilot/core/prompt.ts (core extraction, eliminates the hand copy) + skills-handler.ts (read-only skills)

✏️ Changed (one mechanical column + one routing line):
   app.ts / deploy-all.sh / redeploy-platform.sh / platform-stack.ts (orchestration column)
   core-prebuild.sh (copilot row in the registry)
   ask/route.ts (A1 routing, one line: && !canCreate)

❌ Untouched (out of scope):
   planner / executor / state machine / confirm / tick / control / createDraft / the four gates
   agent-runner.js (no structuredOutput added)
```

**L4 = half infrastructure (copy the skeleton from the advisors) + one real design decision (A1 read-only remote routing to preserve gate 3).** No framework-layer changes, no state-machine changes.

---

## 5. Verification checkpoints (strict contract-guard loop + 6 checkpoints, as in L2/L3)
0. **Pre-change snapshot**: take the contract-guard baseline tag (locks the existing functionality — above all, the Copilot's in-process Q&A / planner / Plan Center must not break) + create the rollback tag.
1. After the core extraction: platform tsc 0 + vitest (regression of the existing copilot unit tests; the re-export keeps the API) + a snapshot unit test (the read-only systemPrompt variant contains the key constraint wording).
2. prebuild copilot: core-dist generated + empty git diff for the genbi/param/net core-dist (zero regression) + **zero changes to the agent-runner source** (iron rule).
3. Local docker build of infra/agent/copilot exits 0.
4. Start the container locally: /ping healthy + /invocations cleanly reports GATEWAY_URL not configured (the assembly passes end to end, including agent-runner handling the Q&A type without captureSuffix).
5. After deployment: buildx + create the copilot Runtime + **headless-browser verification**:
   - ① **Remote Q&A works end to end** (a viewer or a pure query → ask in the drawer "which data sources are there" → a real answer + backend=agentcore; cross-check the Runtime log `invoke ok cap=bgp-copilot-agent`).
   - ② **Gate 3 is kept** (an editor user says "create a sync task for me" → goes in-process because canCreate=true → can still create a draft, backend=inprocess; the A1 routing takes effect).
   - ③ **Zero regression in the planner / Plan Center** (one sentence produces a plan → confirm creates a draft → still all green in-process, unaffected by L4).
6. **Post-deployment verify**: contract-guard shows zero regression against the baseline → all green; ask for confirmation before committing.

## 6. Risks and an honest assessment
- **Read-only over-reach surface (section 3.3) — decided: the skills Lambda adds projectId filtering**: remote read-only tools must carry projectId + return only the project's own metadata (no sensitive payloads). The over-reach surface shrinks to "a viewer sees read-only metadata of their own project", and a viewer already has read-only rights in the project → almost no real over-reach. An acceptable minimal surface (no fallback to A2).
- **Generality of agent-runner for the Q&A type**: expected zero changes (captureSuffix optional, finalize takes the reasoning); **the actual integration decides**; if the runner needed a change = a contract defect, stop (the same iron rule as in L3).
- **Marginal benefit**: already honestly characterized (architectural tidiness > fixing real defects). L4 would be done mainly to close out the uniformity of the Strands platform unification + to verify agent-runner's reuse for the Q&A type. **If the marginal benefit is judged insufficient, only the isolation-marker gap fix in section 7 can be done and L4 deferred** (see section 7).
- **Image red line**: copilot is a **new container** (not a change to the GenBI image), so there is no red line of the kind that governs changing the GenBI remote image (see the [Engine Cookbook remote guard](./engine-cookbook-genbi-remote-guard.md)); but it still follows the buildx `--provenance=false --sbom=false` single-platform-manifest discipline.

## 7. A real gap found along the way — fixed incidentally in L4 (decided on 2026-07-23)
A code exploration confirmed a gap that **the design claims was done but was never actually implemented** (currently harmless because the Copilot's L2 (create-only) tier produces no copilot-triggered runs, but it is technical debt):
- `types.ts:188` defines `COPILOT_TRIGGERED_BY="copilot"` but **it is assigned nowhere in the codebase**;
- `baseline/learn.ts:55` excludes only backfill, `finops/anomaly.ts:37` excludes only backfill — **the copilot exclusion was added in neither** (the comment at types.ts:186-187 claims "both places must be kept in sync").
- **Decision: fix it incidentally in L4 as an independent small change** (orthogonal to remote-hosting, a small change, verified together while the contract baseline is already taken):
  - `baseline/learn.ts:55` add `&& r.triggeredBy !== "copilot"`; `finops/anomaly.ts:37` add `|| r.triggeredBy === "copilot"` to the exclusion.
  - The COPILOT_TRIGGERED_BY assignment point: written when the executor's execute step lands a run (the interface is left in place; at the L2 tier it is always a no-op, so today this is "pre-set correctly" rather than "currently in effect" — honestly noted: this fixes "isolation correctness for future delegated execution"; the two exclusions + the assignment point are completed now, and they take effect once the L3 execution tier is enabled, leaving no hidden landmine).
  - As an independent sub-step of L4 (phase 0, or folded into phase 3), committed separately; contract-guard verifies zero regression of the baseline / cost pages.

## 8. Rollback
Tag before the change. The container / core / stack / orchestration changes can be checked out; before the Runtime is created, production is unaffected (COPILOT_BACKEND defaults to inprocess; without a runtime-arn it goes in-process — inherently safe).

## 9. Phased delivery path (each phase: its own tag + contract-guard loop + headless-browser verification)

| Phase | Content | Touches an environment? | Red line / rollback | Acceptance |
|---|---|---|---|---|
| **Phase 0 — isolation-marker gap fix** (section 7; orthogonal, goes first) | Add the copilot exclusion in both baseline and finops + the COPILOT_TRIGGERED_BY assignment point (interface left in place) | Platform deployment | contract-guard baseline (zero regression on the cost page / monitoring baseline) | Unit tests + headless zero regression on /finops · /monitor |
| **Phase 1 — core extraction + skills-handler** (platform side; pure change, no deployment risk) | Extract `lib/copilot/core/prompt.ts` (eliminates the hand-copied Q&A systemPrompt) + reverse re-export; `lib/copilot/skills-handler.ts` read-only skills (projectId filtering); add copilot to the core-prebuild registry | No (local compile) | tsc 0 + vitest + snapshot unit test; empty git diff for the genbi/param/net core-dist | Checkpoints ①② |
| **Phase 2 — container + CDK stack** (new; verified locally up to docker build) | `infra/agent/copilot/` (spec plugged into agent-runner) + `infra/lib/copilot-agentcore-stack.ts` + `copilot-iam.ts`; orchestration columns (app.ts / deploy-all / redeploy / platform-stack env) | No (local docker build + start the container) | Zero changes to the agent-runner source (iron rule); docker build exit 0 | Checkpoints ③④ (including agent-runner handling the Q&A type without captureSuffix) |
| **Phase 3 — deployment + A1 routing + headless verification** (touches an environment; the last step) | buildx push of the copilot image + create the Runtime; add the `&& !canCreate` routing in `ask/route.ts`; redeploy the platform for the wiring | Yes (a temporary test account) | Single-platform manifest red line; the pre-change rollback tag | Checkpoints ⑤⑥ (remote Q&A backend=agentcore + Runtime log invoke ok cap=bgp-copilot-agent; editor draft creation still in-process; zero regression in planner / Plan Center; contract-guard zero regression) |

**Why this order**: Phase 0 is orthogonal and clears the technical debt first (while the baseline is already taken); Phases 1 / 2 are entirely local (zero environment risk, can be iterated repeatedly); only Phase 3 touches an environment, deploying and verifying in one go. Before each phase's commit: headless-browser verification + contract-guard all green + confirmation requested (the loop is strictly kept).

## 10. Relationship to the Strands platform unification as a whole (closure)
Once L4 is complete, **all 4 of 4 AI capabilities** of the [Strands platform unification](./strands-platform-unification.md) have a remote AgentCore + Strands main path:
- GenBI (L-Read; the template; its first construction phase is closed)
- paramadvisor (L-Read, L2, the first user of agent-runner)
- netadvisor (L-Read, L3, the 2nd proof of agent-runner with zero duplication)
- **Copilot Q&A (the L-Read half, L4, the 3rd proof of agent-runner = the Q&A type; create / the state machine stay in the platform = the L-Create half)**

**agent-runner would then be proven general by three proofs** (tool-pipeline type ×2 + Q&A type ×1). The L-Create half of the Copilot (planner / state machine / gates) **explicitly stays in the platform process** — which is itself the correct realization of the "capability tiering" design: stateful orchestration is not forced into a stateless Runtime. With this, the Strands platform unification completes the full loop of "framework layer + 4 users".
