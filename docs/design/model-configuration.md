# Model Configuration — Runtime-configurable Bedrock models (replacing install-time hard-coding)

> - Revision: **2.3** (🆕 2026-10-20, probe-budget correction: the D5 probe budget follows the vendor profile (Kimi K3 45 s / all others 10 s) + the tiny probe and the tool-use probe run in parallel + a timeout is classified separately as Timeout (no longer folded into Throttle) + saving accepts a
>   probe that passed in the same region within the last 10 minutes and does not probe a second time;
>   based on real measurements of Kimi probes in a temporary test account, 8 samples of 3.0–39.4 s; see [the specification](./model-configuration-spec.md) (revision 2.5), section 3.2, and [the interaction design](./model-configuration-interaction.md) (revision 1.7), item F8) · **2.2** (2026-10-14,
>   after the first real-environment run of the page-driven acceptance segment: 🆕 **D17 transient stream errors are retried once and must leave a log line** — under Kimi K3, the sixth model call of a GenBI container run intermittently (1 in 3) received "Stream ended without completing a message",
>   and the container's catch block used to swallow the error silently;
>   single author `lib/ai/core/transient.ts`, compiled into the three containers) · **2.1** (2026-10-14, after construction: the status in section 12 changed to "code landed; awaiting **page-driven** real-environment acceptance";
>   D12 adds the Strands planner factor and the real function names;
>   D14 adds base-model derivation from real values / failure traces / fallback;
>   🆕 D16 the GenBI answer card shows the model and backend used for this answer;
>   section 12.4 marked "landed; the actual change list is in the specification, section 7.8") · **2.0** (🆕 2026-10-14 **multi-vendor model channel: GLM 5 / Kimi K3**, decided the same day: "everything through Bedrock, everything through the same model channel";
>   new section 12: real-environment survey (real `converse` calls in a temporary test account) + decisions D3′ / D10–D15 + change scope + risks + construction phases 5 and 6) · **1.6** (🔴 2026-09-09 the scope parameter of model-config renamed `scope` → `settingScope`; rationale in [the
>   specification](./model-configuration-spec.md) (revision 1.5) and in [the multi-region specification](./multi-region-execution-spec.md) (revision 3.34), section 2.6.0) 1.5 (🔴 2026-08-29 **external-audit remediation**: two audit items — the probe key gains the target dimension; the sequence
>   becomes a pure pointer;
>   details in [the multi-region design](./multi-region-execution-design.md), section 20.8) 1.4 (🔴 2026-08-29 **convergence-review back-fill**: ① **D8 dimension settled** — the model key and the second parameter of `resolveModelIdRuntime` unified from `region` to **`targetId`** (long since settled
>   in the multi-region specification, sections 1.3a-S2 and 6, but the four documents of this module plus the feature map — **10 key names + 8 signatures — had never been back-filled**);
>   three hard reasons: Bedrock model enablement is **account × region** scoped (a region key would cross accounts and pick up a model that is not enabled = risk P0-2), the platform identity is already unified on `targetId` (keeping a region key = a second identity), and two blue/green targets in
>   the same region each need their own configuration;
>   ⚠️ if implemented by region, activating the multi-region per-target phase would mean a **key migration** of `bgp-settings`, which conflicts with the zero-migration promise of D2 ⇒ **the table shape is fixed on targetId from phase 1**;
>   ② **`gpt-oss-*` "pending" status removed** — the phase-1 hard gate judges by family, and the `openai.` prefix cannot be saved anyway, so leaving it "pending" was a false openness;
>   whether to include it is decided together with the transport gate of construction phase 2) 1.3 (review item: D2 adds the factory-default clarification — construction phase 1 does not change the SSOT [still opus-4-6, keeping zero migration]; opus-4-8-global is the recommended global default that
>   an administrator sets after deployment once a probe passes, which removes the apparent mismatch between D2 zero migration and the D3/D9 default.
>   1.2 review refinement of the D9 Mantle wording [OPENAI_PATH_MODEL_PREFIXES is a sub-path selector; gpt-oss also goes through Mantle; the load-bearing conclusion that Claude does not use it is unchanged] + paths gain the platform/ prefix;
>   the closing sentence of D8 "section 3 sk supported in phase 1" corrected to phase 2, construction phase 3;
>   section 10 adds the acceptance item for quota back-off and degradation (risk P0-4).
>   1.1: review: D9 probe gate + per-capability overrides deferred to phase 2 (construction phase 4) + per-region key unified as #<region>#global + the AI-path gap accepted;
>   1.0 two-family selection, see D3/D4) | Date: 2026-08-26 (revision 1.2: 2026-08-28) | Status: ⬜ in design, not started
> - Requirement origin: raised on 2026-08-26: "the underlying model must be selectable, only models on Bedrock are supported, and the scope is every place a model is used. Today it is hard-coded in the installation code, which is not acceptable."
> - Upstream roadmap: the platform roadmap of 2026-08 (historical), which placed this work in the platformization track (priority 2) and reserved this module.
> - 🔴 Red line: this document is pure design; no code is written without an explicit instruction.

---

## 0. Background and goals

### 0.1 Current state (one sentence)

The model ID of every AI capability on the platform has already converged on a **single source of truth**, `platform/ai-model.json` (an outcome of the foundation layer of the [Strands platform unification](./strands-platform-unification.md)), but it is a **build/deploy-time constant**: at runtime it can only be overridden through the environment variable `BEDROCK_MODEL_ID`, and changing that variable means changing the CDK injection and redeploying ECS and the AgentCore Runtimes. **There is no path of any kind to "pick a model on a page and have it take effect immediately."**

### 0.2 Goals

1. **An administrator selects the platform's default large model on a page**, and after saving it **takes effect at runtime** (no redeployment).
2. **Only models on Bedrock may be selected** (including inference profiles); no third-party model endpoint is connected.
3. **Cover every place a model is used**: GenBI (Ask-Your-Data) querying, Copilot Q&A / planner, the network advisor, the parameter advisor, Flink SQL generation, requirement / ETL code generation, GenBI memory summarization, retrieval re-ranking — 9 consumption points (see section 1).
4. **(Phase 2, construction phase 4, optional) per-capability overrides** (for example a large model for querying and a mid-size one for code generation), defaulting to the global value — **not built in phase 1; all 9 capabilities uniformly use the global default** (decided 2026-08-28, see D3).
5. Reserve for requirement one (multi-region): an extension slot so that **model configuration carries a region dimension** (each region uses its own model, as explicitly stated).

### 0.3 Non-goals (explicitly excluded from phase 1)

- ❌ **External** OpenAI API / self-hosted endpoints — the requirement is explicit: "only models on Bedrock". ⚠️ **Clarified 2026-08-28**: **OpenAI models on Bedrock (`openai.gpt-5.6-*`) are in scope** — they are a Bedrock-native provider ("OpenAI"), called through **Bedrock's OpenAI-compatible endpoint (OpenAI protocol)**, they run in the local region, and they do not conflict with "Bedrock only / data stays in the jurisdiction"; what is excluded is **external** openai.com / Azure endpoints (those would leave the jurisdiction).
- ❌ Model selection per workspace / per user (platform level + capability level first; a workspace-level hook is left for phase 2).
- ❌ Tuning parameters such as maxTokens / iteration count on the page (still through env; avoids form explosion in phase 1).
- ❌ Advanced strategies such as model A/B testing or cost-based routing.

---

## 1. Current-state survey (completeness survey before the change; everything anchored with file:line evidence)

### 1.1 SSOT and resolution chain (A1)

| Layer | Location | Mechanism | When it takes effect |
|---|---|---|---|
| SSOT file | `platform/ai-model.json` (`defaultModelId: us.anthropic.claude-opus-4-6-v1`) | JSON constant | changing the file = changing code |
| Runtime-side outlet | `platform/src/lib/ai/model.ts:13-19` | `import json` (inlined by the bundler) + `resolveModelId() = env.BEDROCK_MODEL_ID \|\| DEFAULT_MODEL_ID` | inlined at **build time**; env read at runtime |
| Deployment-side outlet | `infra/lib/shared/model.ts:16-25` | `readFileSync` + `props.modelId > env > SSOT` | at cdk synth |
| ECS injection | `infra/lib/platform-stack.ts:765` | `BEDROCK_MODEL_ID: resolveModelId()` | fixed at deployment |
| AgentCore Runtime injection | `infra/lib/shared/agentcore-base.ts:100` (the genbi / netadvisor / paramadvisor stacks all go through it) | Runtime `EnvironmentVariables.BEDROCK_MODEL_ID` | fixed at deployment |
| Container fallback literal (⚠️ already drifted) | `infra/agent/genbi/agent.js:21`, `infra/agent/_runtime/agent-runner.js:18`, `infra/agent/netadvisor/_runtime/agent-runner.js:18`, `infra/agent/paramadvisor/_runtime/agent-runner.js:18` | `\|\| "us.anthropic.claude-sonnet-4-5-20250929-v1:0"` (the SSOT value is now opus-4-6; the comment claims it "must equal the SSOT") | when env is missing |

### 1.2 Panorama of model consumption points (A2 blast radius: 9 features × 13 call sites)

**Group A: inside the platform process (ECS), all through `resolveModelId()`:**

| # | Feature | Call site | How modelId is obtained | ⚠️ Evaluation time |
|---|---|---|---|---|
| 1 | GenBI query main loop | `lib/genbi/agent.ts:154-159` | `GENBI.modelId` ← `genbi/config.ts:16` | **module load** (config object literal) |
| 2 | GenBI table-retrieval re-ranking | `lib/genbi/retrieval.ts:49-54` (maxTokens=700 at `genbi/core/retrieval-core.ts:118`) | `GENBI.modelId` | module load |
| 3 | GenBI memory summarization | `lib/genbi/memory.ts:122-126` (maxTokens=400 hard-coded) | `resolveModelId()` @ `memory.ts:17` | **module load** (top-level constant) |
| 4 | Copilot Q&A | `lib/copilot/agent.ts:69-74,121-125` | `COPILOT.modelId` ← `copilot/config.ts:14` | module load |
| 5 | Copilot planner (Strands) | `lib/copilot/plan/planner.ts:105-109` | `COPILOT.modelId` | module load |
| 6 | Network advisor | `lib/network-advisor/advisor-agent.ts:106-111` | `NET_ADVISOR.modelId` ← `network-advisor/config.ts:20` | module load |
| 7 | Parameter advisor | `lib/param-advisor/index.ts:99-100,121` | `resolveModelId()` @ `index.ts:25` | **module load** (top-level constant) |
| 8 | Flink SQL AI generation | `lib/realtime/flink-sql-ai.ts:88-92` (maxTokens=1600 hard-coded) | **reuses `GENBI.modelId`** :89 | module load |
| 8b | ⚠️ (added in review) Flink SQL return-value metadata | `lib/realtime/flink-sql-ai.ts:101` `model: GENBI.modelId` | same as above (**not a call site, but an additional reader of `GENBI.modelId`**) | — |
| 9 | Requirement / ETL / multi-engine code generation | `lib/requirements/codegen.ts:150-154` (maxTokens=3000 hard-coded) | **reuses `GENBI.modelId`** :151 | module load |

> ⚠️ Key engineering fact: all 9 points **freeze modelId into a constant at module load** (a config object literal or a file-level `const`). "Changeable at runtime" requires changing these to **evaluation on every call** — this is the largest real change surface of this module and the easiest place to introduce a regression (changing the shape of a config object ripples into all code that reads `GENBI.*` / `COPILOT.*`).

**Group B: AgentCore containers (separate processes, outside the platform):**

| # | Feature | Call site | Source of modelId |
|---|---|---|---|
| 10 | GenBI container agent | `infra/agent/genbi/agent.js:220` (+ :35-36 re-ranking) | Runtime env (baked in at deployment) |
| 11-13 | netadvisor / paramadvisor / shared runner | each `_runtime/agent-runner.js:76` | same as above |

**Group C: not affected (to avoid confusion; surveyed as out of scope):**
- AgentCore data-plane invoke (`genbi/agentcore-client.ts:46` and the other 3 of the 4 places) — carries no modelId; the model lives inside the Runtime.
- Fault diagnostics ([DevOps-agent diagnostics](./devops-agent-diagnostics.md)) uses the **AWS DevOps Agent managed agent**, not a Bedrock model, and is **not within the scope of "selectable model"** (its model is decided by the AWS managed service).
- Cookbook guard (pure rules, zero LLM); governance / metrics / FinOps (no model calls).
- ⚠️ (added in review) **The semantic-extraction model of AgentCore managed Memory**: `agentcore-base.ts:113-116` grants `bedrock:InvokeModel` to the memoryRole, i.e. SemanticMemoryStrategy uses Bedrock on the AWS side for long-term memory extraction — **the model is decided by the managed service and cannot be configured through this feature**; same category as the DevOps Agent, explicitly out of scope (not mentioned in the first draft; prevents the claim "covers every model point" from being challenged as incomplete).

### 1.3 IAM today (good news: zero changes)

- ECS TaskRole: `bedrock:InvokeModel/Converse/ConverseStream + GetInferenceProfile/ListInferenceProfiles + GetFoundationModel/ListFoundationModels`, resources `["*"]` (`platform-stack.ts:657-669`) — **not tightened per model ARN, so switching models does not touch IAM; the permissions for a "selectable model list" API are already in place**.
- The 3 Runtime roles are granted equally broadly (`agentcore-stack.ts:113-123` etc.).
- ⚠️ Known pitfall: `aws-marketplace:Subscribe` (`platform-stack.ts:674-681`) — **third-party-billed models such as the Opus family fail to enable in accounts whose SCP forbids Subscribe** (a lesson from an earlier deployment incident). The selectable-model feature must treat "can this model really be used in this account?" as a first-class citizen (see probing, section 6.4).

### 1.4 Existing configuration infrastructure

- The `/settings` page is **read-only** (`app/settings/page.tsx`; `app/api/settings/route.ts:4-14` has only a GET that echoes env), and currently does not even show BEDROCK_MODEL_ID.
- **No runtime key-value configuration table of any kind** (none of the bgp-* tables in database-stack.ts is a settings-type table).
  - An early platform design card for settings (2026-07, historical) planned a `bgp-settings` table (PK `system` / SK configKey) but it was **never implemented** — this module is its first real landing scenario.
- The closest precedent: the SSM `/bgp/wiring/*` deployment self-healing mechanism (`infra/bin/app.ts:38-77`) — but that takes effect at **deployment time** and does not satisfy "takes effect as soon as the page is changed".

---

## 2. Design principles and key decisions

### D1. Configuration storage: DynamoDB (`bgp-settings` table), not SSM

| Candidate | Verdict |
|---|---|
| **DynamoDB `bgp-settings`** (selected) | ✅ Hot reads at runtime with zero deployment;<br>the platform's DynamoDB read/write patterns are mature;<br>already planned by the early settings design card;<br>audit / optimistic locking are easy;<br>reusable for more runtime configuration later.<br>⚠️ Correction from the architecture review: this **refers only to "the region dimension of model configuration"** (the `ai-model#<targetId>#global` key, see D8 and the cross matrix in [the multi-region design](./multi-region-execution-design.md), section 15) reusing this table;<br>the **"execution-environment registry" of requirement one is a separate new table `bgp-execution-envs` of the multi-region design** (holding the bag of real named resources: buckets / Redshift / MWAA etc.) and **does not reuse this table** — the first draft's wording "the region registry reuses the same table" was imprecise and could mislead the two modules into merging the two tables |
| SSM Parameter Store | ❌ The existing `/bgp/wiring/*` is for deployment-time self-healing; hot reads at runtime would also be feasible, but the platform has no SSM read wrapper and IAM would need `ssm:GetParameter`; it also does not fit the direction of "more platform configuration moves to pages" |
| Only change env + restart ECS | ❌ Does not satisfy "select on a page"; a restart means a minute-level outage |

### D2. Resolution precedence (backward compatible; does not break existing deployments)

```text
resolveModelId(ctx?) =
  ① bgp-settings runtime configuration (per-capability override > global default)   ← new; editable on the page
  ② env BEDROCK_MODEL_ID                                                            ← kept (deployment-time override)
  ③ ai-model.json SSOT default value                                                ← kept (factory default / last resort)
```

- **When ① is empty, behaviour is byte-identical to today** → zero migration, revertible (delete the configuration item and you are back to today).
- The role of ai-model.json is demoted from "sole decider" to "factory default"; its `$comment` is rewritten accordingly.
- 🔴 **Clarification of factory SSOT vs. global default (review item; keeps D2 zero migration)**: construction phase 1 **does not change the `ai-model.json` file** — the factory SSOT **remains `us.anthropic.claude-opus-4-6-v1`** (the current value), guaranteeing that "with layer ① empty, behaviour is **byte-identical** to today" (the D2 zero-migration / revertibility invariant);
  - the **global default `global.anthropic.claude-opus-4-8`** named by D3/D9 is the recommended runtime value that "**an administrator sets in /settings after deployment once the probe passes**" (written into layer ①, bgp-settings), **not** a change of the SSOT file to that value (which would both break D2 zero migration and could collide with the `$modelPolicy` record that opus-4-8 was once "not enabled").
  - That is: on day one of construction the SSOT is untouched and the current opus-4-6 keeps running;
  - after go-live, once an administrator's probe of opus-4-8 passes, it is set as the global default.
  - The exact model ID strings (`-v1:0` suffix / `global.` prefix) are whatever the catalog API (ListFoundationModels / ListInferenceProfiles) returns at runtime.

### D3. Configuration model: two-family selection + global default (decided 2026-08-28)

🔴 **Model selection decision (2026-08-28)**: the selector **offers only two families** — **all versions of Claude Opus + all versions of the OpenAI GPT-5.6 family** (through Bedrock, `openai.gpt-5.6-*`); the other Bedrock models (sonnet / haiku / titan / other providers) **are not offered for selection**. **One global default = `claude-opus-4-8`** (changeable within the two families); **"all models follow the global setting" — all 9 capabilities inherit the global default, with no per-capability differentiation in phase 1**.

- **Exact candidates (verified on 2026-08-28 with a one-off read-only `ListFoundationModels` in a developer account; ≠ the platform account; catalogs are broadly identical across accounts, so this is for reference only; the platform account must enable models itself and probe them for real at implementation time — ACTIVE is not trustworthy)**:
  - **Claude Opus**: `anthropic.claude-opus-4-1 / 4-5 / 4-6 / 4-7 / 4-8 / opus-5`;
  - **GPT-5.6**: `openai.gpt-5.6-terra / -luna / -sol`.
    - 🔴 **Open-weight `gpt-oss-*`: explicitly not included in phase 1 ("pending" status removed 2026-08-29)** — the reason is mechanism, not preference: the hard gate of risk item P0-5 judges by **family** (`isOpenAIFamily(modelId)` → 400 `NotAllowedFamily`), and `gpt-oss-*` shares the `openai.` prefix ⇒ **it cannot be saved in phase 1 anyway**, so leaving it "pending" was a false openness.
    - Whether to include it is **decided together with the transport gate of construction phase 2** (at that point the tool-use behaviour of `gpt-oss` and `gpt-5.6` must each be probed for real and never inferred from one another; see D9).
- **The capability-key allow-list is kept** (prevents spelling drift; aligned with section 1.2): `genbi | genbi-retrieval | genbi-memory | copilot | copilot-planner | net-advisor | param-advisor | flink-sql | codegen`; but **per-capability overrides are demoted to an optional phase 2** (the phase-1 UI has no "override per capability" collapsible section; everything uses the global default).
- **flink-sql and codegen** are still decoupled from "reusing GENBI.modelId" into independent capability keys (the current borrowing is historical inertia); they inherit the global default and behaviour is unchanged.
- **Call transport: see D9** (probe gate: if GPT-5.6 supports Converse tool-use, both families use Converse; otherwise GPT goes through the OpenAI-compatible endpoint as a second transport; it is not "one set of clients").

### D4. How "Bedrock only" is enforced

- The model list **comes only from** `ListFoundationModels` + `ListInferenceProfiles` (the real response for this account and this region); no free-text input of arbitrary endpoints; **then filtered to the two families of D3 (Claude Opus + `openai.gpt-5.6-*`)**, presenting only the available entries of these two families.
- Before saving, validate the modelId format (an allow-list check for Bedrock IDs / profile ARNs at the level of `^([a-z]{2,5}\.)?[a-z0-9-]+\.[a-z0-9.:-]+$`) + **a probe must have passed first** (D5).

### D5. "ACTIVE is not trustworthy" → mandatory real probe before saving

Lesson already learned (an earlier Bedrock model-availability incident and the `$modelPolicy` in ai-model.json): `list-foundation-models` reporting everything ACTIVE is not trustworthy; **a real converse probe is mandatory**. The design:
- Every model in the list carries a status "not probed / available / unavailable (reason)";
- **A probe is mandatory before saving the default model** (a tiny converse, maxTokens=24, timeout = the vendor profile's `probeTimeoutMs`: Kimi K3 45 s / all others 10 s; the tiny probe and the tool-use probe run in parallel; a timeout is classified separately as Timeout, not folded into Throttle — corrected 2026-10-20, see [the specification](./model-configuration-spec.md) (revision 2.3), section 3.2; a probe that just passed on the page is not repeated when saving within 10 minutes): a failure (AccessDenied / not available / Marketplace SCP) rejects the save outright and shows the reason;
- The probe result is cached in the settings item (`probedAt` / `probeOk` / `probeError`), and the list page shows the historical probe conclusion.
- 🔴 **(D9 branch B) The probe transport splits by family**: Claude probes use a tiny Converse call; **GPT-5.6 probes must use the equivalent tiny request on Bedrock's OpenAI-compatible endpoint** (otherwise the probe does not exercise the real call path and would be a false green). Under branch A both families probe with Converse. In addition, the GPT family must also **probe "whether tool-use is available under Converse"** (not merely whether it can generate text) — this is the basis for the D9 branch decision.
- **The probe gains a "quota headroom" dimension (mitigation of risk P0-4)**: besides pass / fail, the probe reads back, where obtainable, the account-level quota / rate-limit signals for the model and shows a yellow hint for "callable but quota very low" (avoiding a **cold cliff** at peak after switching); at runtime, throttling gets **exponential back-off retries**, and consecutive failures **degrade to the previous layer of the resolution chain** (connects to section 6 / D6), so the platform's AI does not collapse all at once.

### D6. Module-load constants → evaluation on every call (convergence strategy for the largest change surface)

Leave the **other fields** of the `GENBI` / `COPILOT` / `NET_ADVISOR` objects untouched (region / maxTokens / … remain startup-time env with unchanged semantics); change only **how the single field modelId is consumed**:

> 🔴 **D9 probe-gate precondition**: this strategy of "changing only the modelId field" **holds only under D9 branch A (GPT-5.6 supports Converse tool-use and both families use Converse)**. If the probe lands on branch B (dual transport), the GPT family additionally needs dispatch by family at the call outlet plus a rewritten tool-use protocol adapter (see D9 / section 6 / section 9.3 risk P0-3), and the GPT path is then **not "one field"**. The Claude main path is always "one field".

- `lib/ai/model.ts` gains an **async `resolveModelIdRuntime(capability?)`**: reads `bgp-settings` (with a **60 s in-process TTL cache**, so that not every request hits DynamoDB) → falls back to env when empty → then SSOT. The original synchronous `resolveModelId()` is kept, not deleted (deployment-time / fallback consumers keep using it).
- The change at the 9 consumption points is uniform: **`await resolveModelIdRuntime("<capability>")` inside the function body that issues the Bedrock call**, replacing the reference to `XXX.modelId` / the top-level constant. The `modelId` field in the config objects **is kept but marked deprecated** — ⚠️ the review grep found an **additional reader of `GENBI.modelId`, `flink-sql-ai.ts:101` (a return-value metadata field)**: if only the call at :89 is changed and :101 is missed, the model name returned by the API will disagree with the model actually called; it must be changed to the runtime value as well (section 1.2 #8b).
- Cache invalidation (**mandatory in phase 1, finalized in the second review**): after the write-configuration API succeeds, **bump a version item**; `resolveModelIdRuntime` compares the version on read and refreshes this instance's cache when it differs — **active invalidation**, honouring the promise of section 0.2 #1 "takes effect at runtime after saving". The TTL (60 s) is only a safety net (no broadcast is needed between the two ECS instances; worst-case convergence 60 s), not the primary convergence mechanism (users / acceptance must not depend on waiting for the TTL to expire naturally).
  - 🔴 **Refinement from the specification revision 1.0 (risk P0-1; "immediate" → "within seconds"):** the version check itself sits behind a short ~5 s TTL (otherwise every AI call would hit the single hot partition `pk="system"`, which gets throttled under high concurrency) ⇒ the convergence window after saving is **seconds (≤ 5 s)**, not literally "immediate"; still far below 60 s, and acceptance does not wait for the 60 s TTL (see [the specification](./model-configuration-spec.md), section 3.1). The acceptance item "takes effect immediately after saving" in section 10 is read accordingly as "within ≤ 5 s".

### D7. AgentCore containers (group B) use "request-level pass-through", not UpdateAgentRuntime

| Candidate | Verdict |
|---|---|
| **Pass modelId through the request payload** (selected) | When the platform invokes a Runtime (`genbi/agentcore-client.ts` etc.) it includes `modelId` in the payload (taken from `resolveModelIdRuntime`); the container's `agent.js` reads `payload.modelId \|\| env.BEDROCK_MODEL_ID \|\| fallback`. ✅ Takes effect immediately, no deployment; the container change is one line; env remains the fallback |
| UpdateAgentRuntime to change env | ❌ Minute-level propagation; requires the platform to hold the UpdateAgentRuntime permission (privilege expansion); availability jitter while the Runtime rolls |

> ⚠️ **Two fact checks from the review (must be aligned before implementation)**:
>
> 1. **The copilot container is not in this repository** — `infra/agent/` contains only the four entries `genbi/netadvisor/paramadvisor/_runtime`, **no copilot directory, and infra/lib has no copilot stack**;
>    `COPILOT_RUNTIME_ARN` points to an externally deployed Runtime.
>    So among the "4 AgentCore client call sites", the **container-side pass-through for the copilot client cannot be implemented in this repository** — copilot's model configuration can rely only on the group-A in-process path (planner / agent are already covered in group A); AgentCore pass-through is a no-op for copilot, which must be stated clearly as not an omission.
> 2. **The shared runner is the prebuild distribution source**: `_runtime/agent-runner.js` is the source, and the copies inside the netadvisor / paramadvisor directories are **replicas** — making "payload.modelId wins" requires **changing the shared source + redistributing** (core-prebuild); changing only the replicas would create a new round of drift (the 4 drifted fallback literals already known from section 1.1 are precisely the historical product of this mechanism).

- Fix the drift of the 4 container fallback literals from section 1.1 (sonnet-4-5, proven to have drifted from the SSOT opus-4-6): **lock them to "read the SSOT value injected at build time" (automatic)**, not the weak option of "someone remembers to keep them in sync with the SSOT" — eliminating the manual synchronization burden (finalized in the second review). Low weight (it only matters for local bare runs with env missing; production is injected by CDK), but directionally it should be automated.

### D8. Reserving the dimension for requirement one (multi-region) (hook only, not implemented)

- The settings key is designed as `ai-model#<scope>`, where scope **in phase 1 = `global`** (a single global default; a capability-name scope belongs to phase 2, construction phase 4); **in phase 2 (when multiple targets land) it extends to `<targetId>#global`** (one default per target, consistent with the last line of this D8 and with section 3); `resolveModelIdRuntime(capability, targetId?)` just gains a second parameter; the table structure needs no migration.
- It was stated explicitly that querying executes in a single region and each region uses its own model — at that point GenBI's modelId resolution reads the configuration by "**the target execution target**" (details in [the multi-region design](./multi-region-execution-design.md), querying section).
- The per-target override key = `ai-model#<targetId>#global` (all capabilities of that target share one model), surfaced on the execution-environment detail page as the "AI model for this region" card (see [the multi-region interaction design](./multi-region-execution-interaction.md); **the sk of section 3 is activated in phase 2, construction phase 3 — the table structure is ready from phase 1, zero migration**; the earlier "supported in phase 1" conflicted with section 3 / the first line of D8 / the phase-2 classification of construction phase 3 and was corrected in review).

> - 🔴 **Dimension settled: the key and the second parameter of the resolution function always use `targetId`, not `region` (back-filled 2026-08-29 from the convergence review)**.
> - The multi-region documents had already fixed this key as **`ai-model#<targetId>#global`** in **the specification, sections 1.3a-S2 and 6 (change comparison), and the design, section 10 line 511 and section 15 line 678**, but the four documents of this module plus the feature map — **10 key
>   names + 8 function signatures in total — had never been back-filled** and still said `<region>`.
> - **Why it must be target and not region (three reasons, all hard facts, not preferences)**: ① **Bedrock model enablement (Marketplace subscription / model access) is "account × region" scoped**, while `targetId` carries `accountId` + `region` ⇒ two targets in **the same region but different
>   accounts** may well have different models enabled, and a region key would **cross accounts** and pick up a model that is not enabled (exactly risk P0-2 "switch to the wrong model and everything is down");
>   ② the whole platform's identity is already unified on `targetId` (multi-region design, section 20.1-1); keeping an extra region-keyed entry = **a second identity**, the very disease the multi-region work introduced targetId to eliminate;
>   ③ when **blue/green or primary/standby targets coexist in the same region**, a staged model switch must be configurable per target, which a region key cannot do.
> - ⚠️ **If implemented as `<region>`, activating the multi-region per-target phase would be a key migration of `bgp-settings`** — in direct conflict with this module's "zero table migration" promise (D2); therefore **the table shape must be fixed on targetId from phase 1** (the key value is not
>   written in phase 1, but the shape is fixed).

### D9. Call transport = probe-gated (Converse-only or dual transport); phase 1 uses `global.*` profiles, phase 2 region-pins (decided 2026-08-28)

> - 🔴 **Correction from review (2026-08-28, confirmed by grep)**: the first draft's "both families use the same OpenAI-compatible endpoint client" **does not hold and is withdrawn**.
> - Evidence: ① all 9 current consumption points (section 1.2) **use the Bedrock Converse API + the Claude tool-use loop** (`genbi/agent.ts:170` `stopReason!=="tool_use"`, `:180` `"toolUse" in blk`, `:210` `toolResult`);
>   ② Bedrock's OpenAI-compatible endpoint is implemented by the Strands Mantle adapter (`platform/node_modules/@strands-agents/sdk/dist/src/models/openai/mantle.js:23` `OPENAI_PATH_MODEL_PREFIXES=['openai.gpt-5.']`, :52) — ⚠️ review refinement: that constant is the **sub-path selector** between
>   `/openai/v1` and `/v1` (`openai.gpt-5.*` takes the former; `openai.gpt-oss-*` also goes through Mantle and takes the latter),
>   **not "routes only gpt-5"**;
>   the load-bearing conclusion is unchanged = **Mantle as a whole is an endpoint dedicated to OpenAI-family models (baseURL `bedrock-mantle…`, the OpenAI SDK, token-generator), and Claude cannot use that endpoint** (Claude uses Converse / BedrockModel);
>   ③ the two packages `openai` / `@aws/bedrock-token-generator` **are currently not installed** (absent from both `platform/node_modules` and `platform/package.json`).
> - Hence "one client for both families" is wrong: Claude can only use Converse, and if GPT is to use the OpenAI-compatible endpoint, that is **another transport**.

- **Decision = probe first, then choose one of two (the implementation is not locked before the probe)**:
  - The key unknown = **whether GPT-5.6 supports tool-use under the Bedrock Converse API** (querying / copilot / planner among the 9 points rely on the tool loop). This probe can only be settled by **a real invoke in the platform account**, and **cannot be done now** (the one-off read-only permission in the developer account has been used up and will not be touched again).
  - **Branch A (probe = supported)**: both families **use Bedrock Converse**, and only the `resolveModelIdRuntime` outlet swaps the modelId (D6 "only one field changes" holds; the smallest change). No OpenAI-compatible endpoint is introduced and no new packages are installed. **Preferred; adopted if the probe passes**.
  - **Branch B (probe = not supported)**: **dual transport** — Claude uses Converse;
    - GPT-5.6 uses Bedrock's OpenAI-compatible endpoint (Mantle), which requires **(a)** installing `openai` + `@aws/bedrock-token-generator`, **(b)** dispatching two client sets at the call outlet by model family (`openai.*` vs `anthropic.*`), **(c)** rewriting an OpenAI-protocol adapter for the **tool-use loops** of querying / copilot / planner / codegen (tool schema / tool_calls / tool-result back-fill formats differ from Converse).
    - In that case D6 "only one field changes" **does not hold**, and onboarding the GPT family = a call-layer rework (effort and regression surface significantly larger than branch A; see section 9.3 risk P0-3).
- 🔴 **Phase-1 delivery is not blocked on this probe**: the phase-1 **default model = `global.anthropic.claude-opus-4-8` (Claude, via Converse, supported today)**; GPT-5.6 is the "optional second family, opened once the probe gate authorizes it". The selector may show both families, but **the real availability of the GPT family is determined by the probe in the platform account (D5)**; until the probe passes, GPT entries show the unavailability reason in the F8 presentation (interaction design, scenario 2) without blocking the Claude main path.
- 🔴 **Inference-profile prefix = the residency key (verified 2026-08-28)**: these models are offered with both **`us.*` and `global.*`** geographic inference profiles (for example `us.openai.gpt-5.6-sol` / `global.openai.gpt-5.6-sol`, `us.anthropic.claude-opus-4-8` / `global.`). `global.*` = global routing (the worst case for residency); `us.*` = multi-region routing within the United States.
- **Phase 1 uses `global.*` profiles (the global default is `global.anthropic.claude-opus-4-8`); phase 2 optimizes to region-pinned** (decided, with an explicit to-do).
  - 🔴 **Honest boundary (A4) + phase-2 to-do**: `global.*` global routing → **residency of the pure data path (SQL / Athena / BI results through regional data APIs, see the multi-region design, section 8.5) is still achieved;**
    - **but the model calls of querying / Copilot route the prompt (including schema + query results = business data) globally = residency of that AI path is not achieved in phase 1**.
    - Hence **`global` → `region-pinned` is "a prerequisite before cross-jurisdiction querying truly closes residency", not a pure optimization**.
    - ⚠️ **Phase-1 decision (decided 2026-08-28, option b: accept the gap)**: until region-pinning is done, **querying in cross-jurisdiction regions stays open as usual and this AI-path egress gap is accepted** (pure SQL / BI is unaffected);
    - region-pinning closes it as a later optimization (construction phase 3), **not gated off in phase 1**.
    - This decision is synchronized with the multi-region design, section 8.5.

---

## 3. Data model (new table `bgp-settings`)

| Attribute | Description |
|---|---|
| `pk` | Constant `"system"` (single partition; the volume of platform configuration is tiny) |
| `sk` | **Phase 1**: `"ai-model#global"` (single global default); **phase 2**: 🔴 **`"ai-model#<targetId>#global"`** (per-**target**, D8 / construction phase 3; back-filled in revision 1.4, originally written `<region>`), `"ai-model#<capability>"` (per-capability, construction phase 4) |
| `modelId` | Bedrock model ID or inference profile ID |
| `probedAt` / `probeOk` / `probeError` | Result of the most recent real probe (D5) |
| `updatedBy` / `updatedAt` / `version` | Audit + optimistic lock (following the bgp-budgets convention) |

- CDK: appended to **`DatabaseStack`** (`infra/lib/database-stack.ts:11`; ⚠️ the specification revision 0.1 and an older draft of this document mistakenly called it `BgpDatabaseStack`, a class name that does not exist — verified and corrected 2026-08-28). Pure append, zero migration; one generic configuration table does not merit its own stack.
- The ECS TaskRole already has broad DynamoDB permissions; no IAM change.

## 4. API design

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/admin/model-config` | **bgp-admin** (through the `/api/admin` gateway, already enforced at `middleware.ts:104`) | Current effective configuration (per capability: runtime value + source layer ① ② ③) + all override items |
| PUT | `/api/admin/model-config` | bgp-admin | Save the global / capability-level modelId; **the server enforces a probe first** (D5); 400 with the reason on failure; writes an audit entry on success |
| DELETE | `/api/admin/model-config?settingScope=` | bgp-admin | Delete an override (falls back to the next layer); writes an audit entry. 🔴 The parameter was renamed from `scope` on 2026-09-09 ([the multi-region specification](./multi-region-execution-spec.md), revision 3.34, section 2.6.0) |
| GET | `/api/admin/model-config/catalog` | bgp-admin | Merged list of `ListFoundationModels` (filtered to `outputModalities` containing TEXT and by `inferenceTypesSupported`) + `ListInferenceProfiles`, each with its most recent probe state |
| POST | `/api/admin/model-config/probe` | bgp-admin | Real tiny converse probe of the given modelId; returns ok / error class (AccessDenied / NotFound / Marketplace / Throttle) |

## 5. Interaction design

> 🔴 **The complete interaction design is a separate chapter: [the interaction design](./model-configuration-interaction.md)** (added after a deep review: 4 scenarios [switching the global model with impact preview + medium-level confirmation / probe failure F8 / visualization of per-capability overrides / model-failure alert + the "restore factory default" lifeline] + error states + wireframes + interaction acceptance). This section lists only the placement essentials.

- Placement: a new "AI model" card on the `/settings` page (visible and editable for admins; non-admins see the current effective model read-only). No new page, no menu change (zero changes to routes.tsx).
- Card content: the current effective model (with a source tag: runtime configuration / env / factory default) → "Change" opens a modal: model dropdown (from the catalog, with probe-status badges) → "Test this model" button (probe) → saving is allowed only after the probe passes. **The advanced collapsible section (override per capability, nine items) = phase 2, construction phase 4; not in phase 1** (see D3 / section 11).
- i18n: entries appended to en.ts (per convention).

## 6. Backend implementation plan (essentials)

1. `lib/ai/model.ts`: + `resolveModelIdRuntime(capability?)` (DynamoDB read + 60 s TTL cache + three-layer fallback); the original `resolveModelId()` is untouched.
2. `lib/settings/store.ts` (new): bgp-settings read/write + optimistic lock + audit hooks (reusing the existing bgp-audit write pattern).
3. Rework of the 9 consumption points (section 1.2 group A): the call sites change to `await resolveModelIdRuntime("<cap>")`; **a PR checklist item per point, each independently revertible**.
4. The 4 AgentCore client call sites (the `agentcore-client.ts` of genbi / copilot / network-advisor / param-advisor): add `modelId` to the payload; on the container side `agent.js` / `agent-runner.js` read `payload.modelId` first (one line in each of 4 files) + fix the fallback-literal drift.
5. Prober `lib/ai/probe.ts` (new): tiny converse + error classification; shared by the API and the pre-save check. The GPT-family probe must include "tool-use availability under Converse" (the D9 branch criterion).
6. **(D9 probe gate) GPT-5.6 transport adaptation — untouched until the probe concludes**: before implementing, probe in the platform account whether GPT-5.6 supports Converse tool-use.
   - **Branch A (supported)** → no additional transport work; the `resolveModelIdRuntime` outlet sends both families through Converse (merged with item 1 above).
   - **Branch B (not supported)** → add an OpenAI-compatible endpoint client (install `openai` + `@aws/bedrock-token-generator`), dispatch by model family (`openai.*` / `anthropic.*`) at the call outlet, and write an OpenAI-protocol adapter layer for the tool-use loops;
   - under branch B this item is **a separate PR**; effort / regression surface in section 9.3 risk P0-3.

## 7. AWS service dependencies

- Bedrock: `ListFoundationModels` / `ListInferenceProfiles` / `Converse` (all permissions already in place, section 1.3).
- 1 new DynamoDB table. **Zero new standing charges.**

## 8. Security considerations

- Only bgp-admin may change it (two layers: gateway + route); every change goes to bgp-audit (old value → new value).
- Allow-list format validation of model IDs prevents injection of arbitrary ARNs; no custom endpoints are supported (Bedrock only).
- Probe calls use maxTokens=8 and a fixed harmless prompt; the cost is negligible; probe rate limit = **6 per minute per administrator** (counter `ratelimit#probe#<adminSub>#m#<bucket>`, reusing the shape of `data-service/ratelimit.ts`; [the specification](./model-configuration-spec.md), section 3.4a).

## 9. Change scope · impact scope · risk register (🌐 production-grade change review)

> This module is a **platform-wide cross-cutting change to a globally deployed production system**: "pick a model on a page and it takes effect immediately" means one wrong operation affects **all tenants and all AI features at once** (a global single point). This section therefore follows the production change-review format and breaks change scope / blast radius / risk register down to a reviewable, revertible granularity. **Everything is anchored to the real current state of the code** (calibrated by the documentation audit of 2026-08-26; it does not rely on drifted older documents).

### 9.1 Change scope (new vs. modified existing, file:line anchored)

**A. New (pure additions, no regression risk to existing code):**

| Item | Location | Description |
|---|---|---|
| `bgp-settings` table | appended to the CDK `DatabaseStack` (`database-stack.ts:11`) | ⚠️ The audit confirmed this table **was never implemented** (zero hits in a repository-wide grep 🔵); pure append, zero migration; class-name correction in section 3 |
| `lib/settings/store.ts` (new) | — | bgp-settings read/write + optimistic lock + audit hooks |
| `lib/ai/probe.ts` (new) | — | tiny converse probe + error classification |
| `resolveModelIdRuntime(capability?)` | added to `lib/ai/model.ts` | the original synchronous `resolveModelId()` is **neither deleted nor changed** (deployment-time / fallback use continues) |
| 3 groups of API routes | `/api/admin/model-config` (GET/PUT/DELETE), `/catalog`, `/probe` | bgp-admin gateway already enforced (middleware.ts:104) |
| /settings "AI model" card | `app/settings/page.tsx` | no new page; zero changes to routes.tsx |

**B. Modifications of existing code (regression risk, point by point):**

| Item | Location (file:line) | Risk points |
|---|---|---|
| Evaluation rework of the 9 consumption points | agent.ts:154 / retrieval.ts:49 / memory.ts:122 / copilot/agent.ts:69,121 / planner.ts:105 / advisor-agent.ts:106 / param-advisor/index.ts:99 / flink-sql-ai.ts:88 / codegen.ts:150 | see the first item of the blast radius in section 9.2 |
| flink-sql-ai.ts:101 metadata reader | same file, :101 | hidden reader found in review (`model: GENBI.modelId`); if missed, the model name reported by the API disagrees with the model actually called |
| config `modelId` marked deprecated | genbi/config.ts:16, copilot/config.ts:14, net-advisor/config.ts:20 | **keep the field, do not change the object shape** (changing the shape = the largest regression surface) |
| AgentCore container payload pass-through | genbi/agentcore-client.ts etc. | ⚠️ the copilot container is not in this repository; for it this is a no-op (not an omission) |
| Drift fix of the 4 container fallback literals | agent.js:21, _runtime×3 agent-runner.js:18 | must change the **shared source + redistribute** (core-prebuild); changing only the replicas creates new drift |
| ai-model.json `$comment` | — | role demoted to "factory default" wording |

### 9.2 Impact scope / blast radius (based on the verified current code)

- **The largest regression surface = every reader of the config objects**: all 9 consumption points **freeze modelId into a constant at module load** (a config object literal or a top-level `const`). The change must "only change evaluation at the call site and never touch the shape of the config objects" — otherwise it ripples into all code reading `GENBI.*` / `COPILOT.*` / `NET_ADVISOR.*`. Mitigation = unchanged shape + an independent commit per point + a contract-guard snapshot before and after + headless verification of the 9 features one by one.
- **The hidden reader `flink-sql-ai.ts:101`** (found in review): changing only the call at :89 and missing :101 makes the model name reported in the return value disagree with the model actually called. It must be changed together.
- **The copilot container is not in this repository** (found in review): `infra/agent/` has only genbi / netadvisor / paramadvisor / _runtime, and there is no copilot stack. Payload pass-through is a no-op for copilot; copilot's model configuration can rely only on the group-A in-process path (planner / agent already covered) — this must be stated clearly; it is not an omission.
- **The shared runner is the prebuild distribution source**: `_runtime/agent-runner.js` is the source and the copies in the netadvisor / paramadvisor directories are replicas; the 4 drifted fallback literals already known from section 1.1 are the historical product of "changing the replicas but not the source". Changes must go to the source + redistribution.
- **Cross-module coupling (with the multi-region work)**: the bgp-settings table of this module is reused by the multi-region work for its **region dimension** (the `ai-model#<targetId>#global` key, one default per region); but the multi-region execution-environment registry is **a separate table, bgp-execution-envs**, and the two tables are not merged (corrected in the first review). This module lands the table and the resolution function with the region hook but does not activate it; the multi-region per-target phase activates it with zero table migration.
- **Unaffected surface (to avoid collateral damage; explicitly out of scope)**: AgentCore data-plane invoke (carries no modelId), fault diagnostics through the managed AWS DevOps Agent (not Bedrock), AgentCore managed-Memory semantic extraction (model decided by the managed service), Cookbook guard / governance / metrics / FinOps (no model calls).

### 9.3 Risk register (P0 / P1 / P2)

| # | Risk | Level | Trigger | Impact | Probability | Mitigation | Rollback |
|---|---|---|---|---|---|---|---|
| P0-1 | Reworking the 9 consumption points to "evaluate on every call" introduces a regression | **P0** | the config object shape was changed / a reader was missed | the affected AI feature fails | medium | change only call sites, not the shape; one independent commit per point; contract-guard before and after; headless verification of the 9 features | revert the single point (each point is an independent commit) |
| P0-2 | Switching to an unavailable model → platform-wide AI outage | **P0** | an admin saved a model that is not enabled / not permitted in this account | **all tenants × all AI features** (global single point) | medium | mandatory real converse probe before saving (D5), rejecting on failure; "one-click restore factory default" | delete the configuration item to fall back to env / SSOT |
| P0-3 | (D9 branch B) defects in the GPT tool-use protocol adapter → the tool loops of querying / copilot / planner break | **P0** | D9 lands on branch B; OpenAI-protocol tool_calls / result back-fill semantics differ from Converse; a tool loop is missed | querying / copilot / planner / codegen when the GPT family is selected | medium | the probe gate decides the branch first; under branch B the tool-use adapter is a separate PR and each of the 4 tool loops is verified headlessly; the Claude main path is unaffected | switch that capability back to Claude (the Converse main path) |
| P0-4 | **Quota cold cliff** after switching models → throttling avalanche at peak | **P0** | the probe passed at save time, but the new model's account-level quota is far below the old one's, and volume brings Throttle | all AI calls of all tenants on that model | medium | the D5 probe gains the "quota headroom" hint; exponential back-off on runtime Throttle + degradation to the previous layer of the resolution chain; show the estimated volume before switching | delete the configuration to fall back to env / SSOT |
| P1-1 | DynamoDB (bgp-settings) read failure → all AI down | P1 | table throttling / failure / accidental deletion | all AI features | low | three-layer fallback: DynamoDB error → env → SSOT (the catch takes the original path; **never worse than today in any case**) | natural fallback, no manual action |
| P1-2 | Marketplace SCP forbids Subscribe → the Opus family fails to enable | P1 | a third-party-billed model is selected and the account SCP forbids Subscribe (a lesson from an earlier deployment incident) | that model is unavailable | medium (common in cross-account installs) | the prober classifies this error separately and states it explicitly; documentation lists the available models | switch back to an already-subscribed model |
| P1-3 | **Provider drift**: behavioural differences across providers (anthropic / openai) cause hidden regressions | P1 | GPT and Claude differ in stopReason / token counting / tool schema / maxTokens semantics | capabilities switched to the GPT family | medium | headless regression of the 9 points before making GPT the global default; also check metadata readers such as `flink-sql-ai.ts:101`; capability defaults inherit the global one (per-capability only in phase 2) | switch back to Claude |
| P2-1 | Cache inconsistency across two instances | P2 | within the 60 s TTL after saving, the two ECS instances hold different values | intermittent hits on the old model | high but low impact | the write side bumps the version for immediate invalidation; the page says "**effective within ≤ 5 s**" (bump-version + 5 s short TTL; 60 s is only the safety net, specification section 3.1) | wait for the TTL to converge naturally |
| P2-2 | Container payload contract change | P2 | an old container version does not recognize payload.modelId | the agentcore path falls back to env | low | the field is optional; without payload.modelId = today's behaviour | the field is optional; naturally compatible |

**🔄 Rollback principle (the core guarantee of this module's revertibility)**: when layer ① of the resolution precedence (runtime configuration) is empty, behaviour is **byte-identical to today** (D2) — deleting all runtime configuration items returns to "before the change"; reads of the whole bgp-settings table can be stopped (code catch → env → SSOT). Hence at any stage this module can safely revert to the current production state, which is what makes "hot model switching" on a globally deployed system defensible.

## 10. Acceptance criteria (headless + real state sources; contract-guard before and after)

- [ ] An admin changes the default model on `/settings` (probe passed) → **without a restart, a query immediately after saving uses it** (the D6 bump-version active invalidation is mandatory in phase 1); ask GenBI one question, and the response body's `_meta.modelId` proves the new model ID was used ([the specification](./model-configuration-spec.md), section 3.3a; **CloudTrail is withdrawn as immediate hard evidence because of its delivery lag**). Acceptance **needs no sleep for the TTL** (active invalidation guarantees immediacy); the TTL is only a safety net.
- [ ] A model whose probe fails (for example an Opus model that is not enabled) is rejected with 400 on save and the reason is shown.
- [ ] **(Phase 2, construction phase 4)** per-capability override: with only `codegen` overridden to model B → codegen uses B while GenBI still uses the global A (double proof in logs). **Not verified in phase 1 (there is no per-capability override UI in phase 1; everything uses the global default).**
- [ ] Deleting all runtime configuration → behaviour returns to env / SSOT (identical to before the change).
- [ ] On the AgentCore path (GENBI_BACKEND=agentcore) querying uses the model selected on the page (container logs prove payload.modelId took effect).
- [ ] Non-admin users do not see the edit entry and PUT returns 403.
- [ ] DynamoDB table fault injection (**point the `SETTINGS_TABLE` env at a non-existent table**, non-production deployment only; specification section 3.4a ②) → AI features still work (fallback to env / SSOT).
- [ ] [Covers **P0-1**, a missed reader] **Hard evidence that each of the 9 consumption points "uses the new model"** (not just a smoke test): switch the global default to a model **clearly different from the SSOT** → trigger the 9 consumption points one by one (GenBI / retrieval / memory / copilot-agent / planner / advisor / param-advisor / flink-sql-ai / codegen); each one's **`_meta.modelId`** (asynchronous paths via `result._meta`; retrieval / memory via `_meta.invocations[]`) = the new model;
  - **separately verify the hidden reader flink-sql-ai.ts:101** (the model name reported by the API == the model actually called, guarding against "changed :89 but missed :101") — ⚠️ review grep addition: the `r.model` at `:101` **flows further downstream** to `flink/ai-sql/route.ts:22` (recordAudit) and `:23` (the API response envelope), so this acceptance item must check **down to the ai-sql route layer** (both the audit record and the response-body model name == the new model), not just inside flink-sql-ai.ts.
  - Any point still using the old model = FAIL.
  - ⚠️ A smoke test (the feature did not crash) is necessary but **cannot replace** this item (when a reader is missed, the feature still does not crash; it just uses the old model).
- [ ] [Covers **P0-4**, the quota cold cliff] After switching models, on runtime Throttle / insufficient quota, **exponential back-off retries + degradation to the previous layer of the resolution chain** (verified with **`FAULT_THROTTLE_MODEL`**, a runtime env gate for non-production only: no avalanche under high concurrency, AI features do not fail as a whole), rather than "the probe passed, so peak is assumed safe"; **P0-3 (the branch B tool-use protocol adapter) is verified later once the construction-phase-2 branch is settled**.
- [ ] contract-guard verify with zero FAIL (the existing regression net is **necessary but not sufficient** — the `ai_wiring` contract only asserts the presence of the wiring card and the Tag counts, **it does not read modelId**, so it stays green with a wrong model; the item above must cover that).

### 10bis. Test scaffolding to add this time (added in review)

> The existing `ai_wiring` contract (`contracts.py:231`) only inspects that the "AI Wiring Health" card on `/settings` exists and its OK/DOWN counts; **it does not assert the currently effective modelId** — a blind spot for the core risks of this module (wrong model / missed reader). To add this time:
> - **A `model_config_effective` L2 contract**: after changing and saving the model on `/settings`, read **a real state source that echoes the currently effective modelId** (read **`effective[]` of GET `/api/admin/model-config`** (the specification, section 2, explicitly **does not build** `/effective`; CloudTrail is withdrawn)) and assert == the new value. Guards P0-2 (a wrong model takes down platform-wide AI) in its "the switch really took effect and is visible" aspect.
> - **A 9-point modelId probe scaffold** (headless + logs): the reusable script for the acceptance item above, asserting **`_meta.modelId`** point by point along the consumption-point list.
> - Both follow the rule that acceptance scripts stay on the developer machine and are never committed (reused locally, not checked in).

## 11. Construction phases

> - ✅ Decided (2026-08-26): **phase 1 = construction phases 1 + 2**.
> - 🔴 **The sole authority for the implementation order = [the multi-region design](./multi-region-execution-design.md), section 17** (corrected in revision 1.4: the original text said "the three-module order (model configuration → project isolation → multi-region execution), with the cross matrix
>   in section 15 of the multi-region design as authority" — **the old module-granularity order has been superseded by the batch-granularity settled order**, and that cell of section 15 was itself the same stale text and has been changed to point at section 17).
> - 🔴 **The sequence is in the multi-region design, section 17, and is not restated here** (revision 1.5: restating is a source of drift; section 17 explicitly includes construction phases 1, 2 and 3 of this module).
> - **This module's position in it: it is still the first functional module to be touched**, but **it comes after the standalone IDOR security fix for the production environment and after the shared-foundation batch** — the security fix has no prerequisite and the highest priority;
>   the shared-foundation batch first aligns the `bgp-task-runs` write points / naming SSOT / ledgers and other shared foundations in one go, so that the modules after this one are not repeatedly overturned.
> - 🔴 **Revision of 2026-08-28 (decided; overrides the 08-26 "per-capability overrides in phase 1" above)**: **per-capability overrides are demoted to phase 2 (construction phase 4)**; in phase 1 all 9 capabilities uniformly use the global default (see D3); hence phase 1 (construction phases 1 + 2)
>   **does not include** the per-capability override UI.

- **Construction phase 1 (core)**: bgp-settings table + resolveModelIdRuntime + global default + /settings card + probe + rework of the 9 group-A points.
- **Construction phase 2**: AgentCore payload pass-through + container fallback drift fix + **D9 probe gate settling the GPT transport branch** (probe supported = branch A, no extra work; not supported = branch B dual transport, separate PR).
- **Construction phase 3 (together with the multi-region per-target activation phase)**: activation of the region dimension — per-region model overrides (the "AI model for this region" card on the execution-environment page, the `ai-model#<targetId>#global` key, D8) + 🔴 **`global.*` → region-pinned call rework (D9; closes the residency of the AI path of cross-jurisdiction querying; phase 1's `global.*` leaves an AI-path egress gap)**.
- **Construction phase 4 (phase 2, optional)**: per-capability override UI (`ai-model#<capability>` key; inherit / override badges + tooltips for the 9 capabilities, see the interaction design, scenario 3).

> **Finalization note from the second review (2026-08-27)**: the special review "should be automatic but is manual" confirmed that this module has no multi-region-style directional error (it is itself the labour-saving fix from "change model = change env + redeploy" to "hot switch on the page"). The 2 improvement points the review found **have been back-filled into the body**: ① the container fallback literals are locked to "the SSOT injected at build time" (see D7); ② the bump-version active invalidation of the 60 s TTL is promoted to mandatory in phase 1 (see D6 / section 10 acceptance). The transitional to-do block has been cleaned up.

---

## 12. 🆕 Revision 2.0 multi-vendor model channel: GLM 5 / Kimi K3 (2026-10-14)

> **Status (revision 2.1, 2026-10-14)**: all code has landed on the multi-vendor feature branch (full unit-test suite of 375 files / 4,944 tests green, type check clean, redline scan passed); the real-environment segment was changed to **page-driven** per the acceptance rule set that day, and its conclusion is **pending back-fill**. The implementation-level change list is in [the specification](./model-configuration-spec.md), section 7.8.

### 12.1 Requirement and the decisions as stated

Stated on 2026-10-14: "adapt the existing large-model module to GLM models, such as GLM 5.3 / K3"; after follow-up questions, four decisions: ① **both go through Bedrock** (model ids `zai.glm-5.3`, `moonshotai.kimi-k3`; "whether the prefix needs an inference profile, verify it yourself; in theory it should be added"); ② K3 = **Kimi K3** (Moonshot AI), GLM 5.3 = **Z.AI GLM 5.3**; ③ verification environment = a temporary test account; ④ **everything through the same model channel**. Also: "the task must keep a high standard, as required of a production application; the design document and all necessary documentation must be updated".

Background: in the customer production account (`customer-prod`, Singapore) the Anthropic models are **denied at account level** ("not allowed from unsupported countries"; see [the deployment guide](../deployment.md), section 8), so all 9 AI capabilities are unusable there; neither of the "two families" of phase 1 of this module (D3: Claude Opus + GPT-5.6) can be used in that account. Multi-vendor support is not a preference; it is the only path that makes the AI features **usable** in accounts of this kind.

### 12.2 Real-environment survey (2026-10-14 02:5x–03:0xZ, a temporary test account, us-east-1, all real `converse` calls, maxTokens ≤ 1200; ad-hoc local probe scripts, not in the repository)

**Catalog facts** (`ListFoundationModels` / `ListInferenceProfiles`; identical in us-east-1 and us-west-2):

| Base model id | Vendor | inferenceTypesSupported | Inference profiles |
|---|---|---|---|
| `zai.glm-5.3` | Z.AI | **INFERENCE_PROFILE** (bare id on demand not supported) | `us.zai.glm-5.3` · `global.zai.glm-5.3` |
| `moonshotai.kimi-k3` | Moonshot AI | **INFERENCE_PROFILE** | `us.moonshotai.kimi-k3` · `global.moonshotai.kimi-k3` |
| `zai.glm-5` · `zai.glm-4.7` · `zai.glm-4.7-flash` | Z.AI | ON_DEMAND (bare id; `us.zai.glm-5` does not exist ⇒ ValidationException) | — |
| `moonshotai.kimi-k2.5` | Moonshot AI | ON_DEMAND | — |
| `anthropic.claude-opus-4-5-20251101-v1:0` | Anthropic | INFERENCE_PROFILE | `us.` / `global.` (as today) |

⇒ **The prefix is mandatory**: GLM 5.3 and Kimi K3 have the same shape as Claude Opus 4.5; calling the bare id returns `ValidationException: Invocation of model ID … with on-demand throughput isn't supported`. Usable ids are always the inference-profile ids from the account's real values (the catalog mechanism already derives the prefix from `ListInferenceProfiles`; D4 and the corresponding production-readiness acceptance item are unchanged).

**Call behaviour** (✓ = passes; ✗ = the request is rejected; parentheses give the gist of the service message):

| Model id | ping | system prompt | `temperature` | `topP` | `stopSequences` | tool-use without / with toolChoice | Assistant message pushed back as-is / with reasoning stripped | `reasoningContent` blocks | Latency (small prompt) |
|---|---|---|---|---|---|---|---|---|---|
| `zai.glm-5.3` (all three id forms) | ✗ **AccessDeniedException: zai.glm-5.3 is not available for this account** (asks to contact AWS Sales) | — | — | — | — | — | — | — | — |
| `us.moonshotai.kimi-k3` | ✓ | ✓ | ✗ (This model doesn't support the temperature field) | ✗ same | ✗ same | ✓ / ✓ | ✓ / ✓ | **always present**: all 16 tokens consumed by reasoning, no text block; on a query-style prompt 560 characters of reasoning + 275 characters of body | 1.4–3.3 s |
| `global.moonshotai.kimi-k3` | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ / ✓ | ✓ / ✓ | always present | 2.6–5.6 s |
| `zai.glm-5` (stand-in for the GLM 5 family) | ✓ | ✓ | ✓ | ✓ | ✗ (doesn't support the stopSequences field) | ✓ / ✓ | ✓ / — | none | 1.0–16.8 s (query-style prompt 7.1 s) |
| `zai.glm-4.7` / `-flash` | ✓ | — | — | — | — | — | — | none | 1.0–1.2 s |
| `us.anthropic.claude-opus-4-5-…` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ / ✓ | ✓ / — | none | 2.1–3.5 s |

- Additional measurements: ① the three ways of disabling reasoning for Kimi K3 through `additionalModelRequestFields` (`thinking.type=disabled` / `reasoning_effort=none` / `enable_thinking=false`) **are all silently accepted, but reasoning remains** (379 / 419 / 181 characters) ⇒ no known switch turns it off;
- ② output tokens for the same query-style prompt (write one Redshift aggregation SQL, maxTokens 1200): **Kimi K3 240 (560 characters of reasoning + 275 of body) · GLM 5 89 · Claude Opus 4.5 112** ⇒ Kimi's output budget is about **2.1×** Claude's;
- ③ handling of reasoning blocks by the platform and by Strands 1.10: all 8 text-extraction sites in the platform have the form `"text" in b ? b.text : ""` (reasoning blocks are naturally skipped), and Strands `models/bedrock.js` natively sends and receives `reasoningContent`;
- ④ IAM: the platform task role, the three agent Runtime roles and the Memory role all have resource `*` for `bedrock:InvokeModel / Converse`; **no change needed**.

### 12.3 Decisions

- **D3′ (replaces the "two families" of D3)**: the selectable set widens to **four families**, still only from Bedrock and still always Converse (D4 / D9 branch A unchanged): **Claude Opus** (anthropic, all versions) · **GPT-5.6** (openai, still behind the D9 transport gate) · **the GLM 5 family** (`zai.glm-5*`: `zai.glm-5.3` is the named target; `zai.glm-5` is the same generation and family, and the only zai model that could actually run in the temporary test account in this wave) · **the Kimi K3 family** (`moonshotai.kimi-k3*`).
  - sonnet / haiku / glm-4.x / kimi-k2.5 / other vendors are not offered.
  - The 9 capabilities continue to use the global default (the "one global" of phase-1 D3 is unchanged).
- **D10 vendor profile = single author**: `platform/src/lib/ai/core/vendors.ts` (zero dependencies; compilable by core-prebuild into the three containers' `core-dist/ai/`), one record per family: `family` · display name · selectable-id test (regex) · `toolUse: "assumed" | "probe"` · the `inferenceFields: { temperature, topP, stopSequences }` support matrix · `reasoningBlocks` · `maxTokensFactor`.
  - The geographic-prefix regex `GEO_PREFIX_RE` is **generated** from the vendor keys (it used to be hand-written as `anthropic|openai`, so every added vendor was one more omission — `us.zai.glm-5.3` would be judged "not any family" by the current code).
  - `capabilities.ts` / `model-catalog.ts` / the UI / the containers all import it; family tests and wording are no longer written separately in each place.
- **D11 the tool-use gate follows model evidence, not family guesses**: families with `toolUse: "probe"` (openai · zai · moonshotai) **must** receive the second probe when probed (offer one harmless tool and require it to be called; check whether a `toolUse` block is produced; today this is done only for openai);
  - when PUT saves the global default and `toolUseOk !== true` ⇒ **400 `ToolUseUnavailable`** (querying / Copilot / both advisors depend on the tool loop; a model without tool-use as global default = those capabilities go mute, by the same logic as D5 "ACTIVE is not trustworthy").
  - GPT's D9 transport gate **is kept and stacks on top** (it solves the Mantle dual-transport problem, which is a different matter from this gate).
- **D12 request shaping: strip unsupported fields, learn at runtime, never guess**: new `converse-shape.ts` (single author, next to `vendors.ts`; real functions `shapeInferenceConfig(modelId, cfg) → { config, stripped, boosted }` and `shapeConverseInput(input) → { input, stripped, boosted }`, [the specification](./model-configuration-spec.md), section 7.2).
  - ① Strip the `inferenceConfig` fields the family does not support according to the vendor profile (measured: Kimi K3 rejects temperature / topP / stopSequences; GLM 5 rejects stopSequences);
    - ② `maxTokens × maxTokensFactor` (moonshotai = 2, based on 12.2 ②; all others 1);
    - ③ if at runtime a `ValidationException: This model doesn't support the <field> field` still arrives ⇒ remember process-wide that "this model does not support this field" and **retry once immediately on the same layer** (not counted as throttling, no degradation, no swallowing of other errors).
  - Only two landing points: the platform-side `invokeConverse` (all 8 consumption points go through it; it shapes the `input` after `build(modelId)` produces the command) + the container-side genbi `ModelClient` (which assembles its own `ConverseCommand`); Strands `BedrockModel` never passes temperature / topP in the first place and only needs the maxTokens factor (three places: genbi `agent.js`, `_runtime/agent-runner.js`, and the platform's `copilot/plan/planner.ts`).
  - Learned fields hang on globalThis (shared even across the multiple module instances of the Next.js build output); `InvokeOutcome.shaped` echoes what was stripped on the successful attempt.
- **D13 reasoning blocks are transparent to callers**: ① text extraction accepts only `text` blocks (already so today; unit tests pin it); ② history is pushed back **as-is** (measured: Kimi passes whether or not the reasoning blocks are pushed back; Strands handles it natively; no "strip reasoning before pushing back", which would be one more path); ③ `_meta` does not echo the reasoning text; ④ the budget consumed by reasoning is covered by the D12 factor, and the factor is **measured** (12.2 ②), not guessed.
- **D14 deployment-time default model = an ordered candidate chain**: `platform/ai-model.json` gains `candidateModelIds` (ordered: Claude Opus 4.5 → `zai.glm-5.3` → `moonshotai.kimi-k3`; `defaultModelId` remains the factory default and the first candidate);
  - `scripts/resolve-home-model.sh` goes candidate by candidate: the base model is **derived from the real values** of the home region's `list-inference-profiles` `modelArn` (if the candidate is a profile id of this region ⇒ take its modelArn; if it is a profile id of another region ⇒ derive from this region's base-model set; if neither ⇒ the candidate is the base id itself; only when nothing can be listed is the first segment stripped by shape as a last resort, **with no vendor regex**), expands it (the candidate itself → this region's geographic inference profile → `global.` → bare id) and runs a real converse on each; **the first one that passes** becomes the deployment-time `BEDROCK_MODEL_ID`;
  - every failure leaves a trace on stderr "✗ candidate → id — service message" (so even on success you can see what was tried before);
  - item 7 of `01-preflight-account.sh` uses the same wording (reports "which candidate is usable" instead of only saying the factory default is unavailable);
  - an explicitly given `BEDROCK_MODEL_ID` is still adopted directly (as today).
  - Accounts like `customer-prod`, where Anthropic is denied at account level, automatically fall to GLM / Kimi at deployment and no longer stop at step 2.
  - **Revision 2.2**: the probe uses `maxTokens=16` (Kimi K3's lower bound; 1 is rejected as "unavailable", proven in the page-driven acceptance run).
- **D15 "not available for this account" is a fact and is shown as such**: the probe error classification gains `NotAvailableForAccount` (matching "not available for this account" / "contact AWS Sales"), with the F8 wording "This model is not enabled for this AWS account; ask AWS to enable it, or choose another family"; the catalog shows `available=false` + `lastProbe.error` as usual. GLM 5.3 in the temporary test account is exactly this class (12.2); **this wave's real-environment verification of the zai family uses `zai.glm-5` as a stand-in**, and GLM 5.3 itself is left for when an account with it enabled is available (construction phase 6).
- **D16 the GenBI answer card shows "model used · backend" (revision 2.1)**: `/genbi` adds a line under every answer: "Model used: <id> · Backend <agentcore|inprocess> (· degraded to fallback)" (`data-testid=genbi-model-used`; the value comes from the `_meta` reported by the execution layer, not from "what was intended"). Two reasons: ① after an administrator changes the global default, users can see on the page who answered this time; ② the acceptance rule set on 2026-10-14, "acceptance of every page feature only through a headless browser driving the page" ⇒ the truth the criterion needs must be exposed on the page by the product (same logic as `_meta.ranIn`, "where this SQL actually ran").

- **D17 transient stream errors: recognize them, retry once, log, never swallow (revision 2.2)**: on 2026-10-14 in a temporary test account (page-driven acceptance), after switching to Kimi K3 the GenBI container ran 5 tool calls in a row and the sixth model call received `Stream ended without completing a message` (the HTTP event stream of Bedrock ConverseStream was closed by the peer in the middle of a frame; wording from @smithy/eventstream-codec), and the whole query ended with the "query execution failed" message;
  - **the same question asked twice more right afterwards succeeded both times**.
  - The SDK-level `retryStrategy` only covers "request not sent / 5xx response" and cannot cover "200 already returned, stream broke midway" ⇒ it can only be handled at the agent-loop layer.
  - Single author `platform/src/lib/ai/core/transient.ts` (zero dependencies, compiled into the three containers' `core-dist/ai`): a closed transient list `TRANSIENT_MODEL_ERROR_RE` (stream broke midway / ModelStreamErrorException / Throttling / ServiceUnavailable / InternalServer / ModelNotReady / socket-level) + 429 / 503;
    - `TRANSIENT_MAX_RETRIES = 1` (more would treat the occasional as normal, doubling cost and masking real faults);
    - `transientBackoffMs` with full jitter, capped at 2.4 s;
    - `describeModelError` gives the log one line of fact.
  - Two landing points: `infra/agent/genbi/agent.js` and `_runtime/agent-runner.js` (the two distributed copies are byte-identical to the source): the Agent is built by a **factory** (rebuilt on retry — the previous round may have left a half-written assistant message; the `messages` history is shallow-copied and not mutated); the catch first calls `describeModelError` to print one structured log line (genbi: `{tag:"agent-error", capability, modelId, attempt, …}`), retries with back-off only if the error is transient and under the cap, and other errors take the existing fallback unchanged;
    - a `phase: "retry"` entry is pushed into `steps[]`, so the "Reasoning steps" on the page show that a retry happened.
  - Not done: rejected fields (the kind D12 learns) and account-level unavailability (D15) are not counted as transient — pinned by unit tests; the same retry is not added to the platform-side `invokeConverse` (it uses non-streaming Converse, where this class of error has never occurred; if it does, it gets added, importing this one list only).
  - Criteria: `core/__tests__/transient.test.ts` (fixtures with the real-environment wording) + `model-config-guard.test.ts` (h) D17 (both places import the same list, factory, constant cap, logging, the `transient.js` artefact in the three containers, tsconfig include). Real-environment criterion: an `agent-error` line in the container log + the answer card no longer shows "query execution failed: Stream ended…".

### 12.4 Change scope (file:line based on the design baseline of 2026-10-14; **all landed in the implementation of 2026-10-14**; the actual change list is in [the specification](./model-configuration-spec.md), section 7.8)

**A. New**

| Item | Location | Description |
|---|---|---|
| Vendor profile + request shaping | `platform/src/lib/ai/core/vendors.ts` · `platform/src/lib/ai/core/converse-shape.ts` | D10 / D12; zero `@/` dependencies, zero SDK dependencies (plain objects only), compilable into the containers |
| Shared container core | `platform/tsconfig.ai-core.json`; the capability registry of `scripts/core-prebuild.sh` gains `ai` → `infra/agent/{genbi,netadvisor,paramadvisor}/core-dist/ai` | same mechanism as the cookbook pure subset (CAP_DESTS with multiple destinations) |
| Unit tests | `lib/ai/core/__tests__/vendors.test.ts` · `converse-shape.test.ts`; `invoke.test.ts` gains "learned unsupported field ⇒ one retry on the same layer" | includes the real error wording of 12.2 as fixtures |

**B. Modifications of existing code**

| Item | file:line | Risk points |
|---|---|---|
| Family test / prefix regex | `lib/ai/capabilities.ts:60-77` (`Family` · `GEO_PREFIX_RE` · `familyOf` · `isOpenAIFamily`) | changed to re-export from `core/vendors.ts`; signatures unchanged, `Family` widens to four values — every `switch` / `Record<Family,…>` site (`AiModelCard.tsx:40`, catalog sorting) must follow |
| Catalog allow-list | `lib/settings/model-catalog.ts:63-66` (`isSelectableSeries`) | changed to profile-driven; the "two families" assertions in the unit test `model-catalog.test.ts:36-44 / 115-120` change to four families |
| Probe | `lib/ai/probe.ts:118-137` | the second tool-use probe for `toolUse:"probe"` families; `classifyProbeError` gains `NotAvailableForAccount` (placed before AccessDenied, because its error body is also an AccessDeniedException) |
| Save gate | `app/api/admin/model-config/route.ts:146-157` | add ToolUseUnavailable after step ③; the NotInCatalog wording drops "two families" |
| Call channel | `lib/ai/invoke.ts:139-153` (`invokeConverse`) | shape `cmd.input` after build; the catch recognizes "unsupported field" ⇒ learn + retry once on the same layer; other classes unchanged |
| Settings page | `components/settings/AiModelCard.tsx:445-468` (grouped dropdown) · `:227-228` (error-code wording) · `:304-311` (tour wording) · i18n `messages/en.ts:2638-2696` | groups generated from the profile; two new F8 entries; every "two families" literal removed |
| Containers | `infra/agent/genbi/agent.js:45-56` (ModelClient assembles `inferenceConfig` with `temperature ?? 0` — a guaranteed 400 under Kimi) · `:297` and `_runtime/agent-runner.js:89` (Strands `BedrockModel maxTokens`) | shaped through `core-dist/ai`; change the shared source + core-prebuild redistribution (D7 discipline) |
| Deployment time | `platform/ai-model.json` · `scripts/resolve-home-model.sh:23-45` · `scripts/01-preflight-account.sh:123-134` · `infra/lib/shared/model.ts` (reads the json only; new fields are compatible) | D14; the script is testable: `BGP_MODEL_CANDIDATES` explicitly overrides the candidates (testing / troubleshooting only, documented) |
| Documentation | the four documents of this module · the AI tools index `AGENTS.md` · [the deployment guide](../deployment.md) section 1 items 1 / 5, section 2 ③, section 8 · [the architecture document](../architecture.md) section 8 · [the modules overview](../modules.md) sections 6 / 7 / 8 · `README.md` · `CHANGELOG.md` | wording changed from "Claude Opus 4.5" to "four-family candidate chain" |

### 12.5 Risk register

| Level | Risk | Mitigation |
|---|---|---|
| P0 | An `inferenceConfig` field unsupported by a family is not stripped ⇒ all 9 capabilities return 400 under that family (under Kimi, flink-sql / codegen / retrieval re-ranking all pass temperature) | D12 double insurance: profile stripping + runtime learning + same-layer retry; unit tests use the real error wording |
| P0 | GLM 5.3's account-level unavailability is mistaken for "the model is broken", probed repeatedly / misreported as a product defect | D15 separate class + wording; at deployment D14 automatically falls to the next candidate |
| P1 | Kimi's reasoning blocks eat maxTokens ⇒ truncated answers / the tool loop stops midway on max_tokens | D12 factor 2 (measured 2.1×); the headless acceptance segment asserts `stopReason ≠ max_tokens` and a non-empty answer |
| P1 | GLM 5 takes 7–17 s per call; multi-round tool loops may approach the ALB 60 s / querying 300 s ceilings | querying goes through AgentCore asynchronously (not subject to the 60 s wall); synchronous routes (flink-sql / codegen) are single-round; the acceptance segment records latency as evidence and over-budget cases are logged truthfully |
| P2 | Residency gap of `global.*` global routing (the existing D9 position) | unchanged: accepted in phase 1; the catalog shows the local geographic prefix first (`us.` / `apac.`) |
| P2 | Four families make the dropdown long | grouping + searchable (showSearch as today), `available` entries sorted first |

### 12.6 Acceptance

> **Conclusion (2026-10-14, temporary test account, fourth run of the page-driven acceptance segment)**: 27 / 27 green; the three things caught in the first run (D17 transient stream errors, the maxTokens lower bound of the candidate chain, drift of the stand-in path list) were fixed in the implementation on 2026-10-14. The list of conclusions is in the acceptance record (revision 1.6), section 8.

- See the acceptance record, section 8 (the acceptance items plus the headless acceptance segment, **page-driven**: on /settings the "AI model" card select → test → save → confirm; on /genbi the answer card `genbi-model-used`; on /realtime-compute "AI Generate"; on /etl-jobs "AI Generate Code"; the Copilot drawer; API / DynamoDB only as debugging truth);
- real environment = a temporary test account (pre-deployed at the development HEAD; this wave's code was raised with `redeploy-agents.sh` (the agent redeploy script, needed because the platform redeploy script does not refresh the agents) + `redeploy-platform.sh`), real Kimi K3 model + GLM 5 stand-in;
- real verification of GLM 5.3 itself is attached to construction phase 6.
- **Conclusion pending back-fill from the page-driven segment (2026-10-14).**

### 12.7 Phases

- **Construction phase 5 (this wave)**: all code for D3′ / D10–D15 + documentation + unit tests + the real-environment acceptance segment; after merging back to the development branch, it enters the full acceptance gate.
- **Construction phase 6**: once an account with `zai.glm-5.3` enabled is available (the customer account, or a temporary account after AWS enables it), run the same acceptance segment against GLM 5.3 itself (including the field matrix / tool-use / reasoning blocks) and replace the GLM 5.3 row in the 12.2 table from "account denied" with measurements; if its field support differs from `zai.glm-5`, only one line of the profile changes.
