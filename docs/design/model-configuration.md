# Model Configuration

> Multi-vendor large-language-model channel on Amazon Bedrock, configured at runtime from the web console.
> Related designs: [Multi-region execution](./multi-region-execution.md) and [Project isolation](./project-isolation.md).
> Model families, factory defaults and deploy-time candidates are listed in [Supported versions](../supported-versions.md).

---

## 1. Summary

Every AI capability of the platform (natural-language querying, Copilot, the network and parameter advisors,
Flink SQL generation, code generation, retrieval and memory summarisation) calls a model through one channel.
The channel is Amazon Bedrock only. The model in use is a **runtime setting**: an administrator picks it in
"System settings", the platform probes it for real, and the change takes effect within seconds without redeploying.

Four vendor families are selectable. Each family has a **vendor profile** that states how it must be called:
which inference fields it accepts, whether tool use must be proven by a probe, whether it emits reasoning blocks,
and how much output budget it needs. The profile has one author and is compiled into the agent containers as well.

Failures are classified and shown to users as "why and what to do". Long model calls never hit the 60-second edge
timeout: requests that exceed a wait budget switch to a polled background task.

---

## 2. Goals and non-goals

### 2.1 Goals

1. Administrators change the platform default model from the console; the change is live within seconds.
2. Only Bedrock models and inference profiles are selectable; the catalogue comes from the account's own Bedrock listing.
3. A model is saved only after a real invocation succeeded, and, for families that need it, only after tool use was proven.
4. One channel for all nine capabilities, inside the platform process and inside the three agent containers.
5. Vendor differences (rejected fields, reasoning blocks, latency, token budget) are absorbed by the channel, not by call sites.
6. Deployment on an account where the factory default is unavailable still ends with a working model.

### 2.2 Non-goals

- Model endpoints outside Bedrock.
- Per-project or per-user model selection.
- Exposing tuning parameters (max tokens, iterations) in the console.
- A/B routing or cost-based routing between models.
- Per-capability overrides (the key shape is reserved; the console does not offer it).

---

## 3. Concepts

| Term | Meaning |
|---|---|
| Capability | one of nine AI call sites: `genbi`, `genbi-retrieval`, `genbi-memory`, `copilot`, `copilot-planner`, `net-advisor`, `param-advisor`, `flink-sql`, `codegen` |
| Resolution layer | where the effective model id came from: `runtime` (console setting), `env` (deployment variable), `ssot` (factory default) |
| Vendor family | `anthropic`, `openai`, `zai`, `moonshotai`; the family is derived from the model id after stripping the geographic prefix |
| Vendor profile | per-family record of call constraints; single author `platform/src/lib/ai/core/vendors.ts` |
| Inference profile | a Bedrock routing id with a geographic prefix (for example `us.` or `global.`) in front of the base model id |
| Probe | a tiny real invocation plus, when required, a tool-use invocation |
| Transport gate | an explicit, evidence-backed switch that allows the OpenAI family to be saved as default |
| Candidate chain | ordered list of models tried at deployment time to pick the home default |

---

## 4. Vendor families

| Family | Tool use | Inference fields accepted | Reasoning blocks | Output factor |
|---|---|---|---|---|
| Claude Opus (anthropic) | assumed | temperature, topP, stopSequences | no | 1 |
| OpenAI GPT via Bedrock (openai) | must be probed; also behind the transport gate | temperature, topP, stopSequences | no | 1 |
| Z.AI GLM via Bedrock (zai) | must be probed | temperature, topP | no | 1 |
| Moonshot AI Kimi via Bedrock (moonshotai) | must be probed | none of the three | always | 2 |

Additional profile fields:

- `selectable`: a pattern applied to the id without geographic prefix; other model lines of the same vendor are not offered.
- `probeTimeoutMs`: the probe budget per family; the reasoning family gets a longer budget because its first token can take tens of seconds.
- `label`: the group title shown in the console dropdown; the console reads it from the catalogue response and never hard-codes family names.

The geographic-prefix pattern is generated from the family keys, so adding a family cannot leave a prefix unrecognised.
The exact model ids and prefixes available depend on the account and region and are read from Bedrock at runtime.

---

## 5. Resolution precedence and caching

```
effective model =
  1. runtime setting   (bgp-settings, pk "system", sk "ai-model#global")
  2. BEDROCK_MODEL_ID  (deployment-time environment variable)
  3. factory default   (platform/ai-model.json, defaultModelId)
```

- When no runtime setting exists, behaviour is byte-identical to a deployment without this feature. Deleting the setting is the rollback.
- The runtime value is cached in-process for 60 seconds. A version counter row (`ai-model#__version`) is read with a 5-second cache; any save bumps it, so a change converges on every instance within about 5 seconds.
- If the settings table cannot be read, the resolver returns the last good value, then the environment variable, then the factory default. The hot path never throws because of configuration.
- The resolver signature already takes a capability and a `targetId`; today both resolve to the global setting. The reserved key shapes are `ai-model#<targetId>#global` and `ai-model#<capability>`.
- Every response of an AI capability reports the model actually used in its `_meta`, not the one that was configured.

---

## 6. Probing

### 6.1 Probe profile

A probe is a real Converse call with a minimal prompt and a small token budget (24 tokens before the output factor). The request goes through the same
shaping as production calls, so the probe exercises the real path.

The probe budget is the family's `probeTimeoutMs`. The tiny call and the tool-use call run in parallel, so the wall time is the longer of the two.

### 6.2 Tool-use probe

Families marked `probe` receive a second call that offers one harmless tool and asks for it to be used. The result is `toolUseOk = true` only if the
response contains a tool-use block.

The Claude family is marked `assumed` and is not double-probed. A second probe that times out is reported separately ("tool-use probe timed out, test
again"), not as "tool use unavailable".

### 6.3 Failure classification

| Class | Detection | Message to the user |
|---|---|---|
| `NotAvailableForAccount` | "not available for this account" or "contact AWS Sales" | account-level restriction; ask the AWS account team or pick another family |
| `MarketplaceSCP` | marketplace, subscription or service control policy wording | the account policy blocks subscribing; use a first-party model or ask the account admin |
| `AccessDenied` | access denied, not authorised, HTTP 403 | request model access in the Bedrock console or pick an enabled model |
| `Timeout` | local abort or SDK time-out | no answer within the family budget; retry later or choose another inference profile |
| `Throttle` | throttling exception or HTTP 429 | rate limited; retry shortly |
| `NotFound` | model or profile not found | not available in this region; choose a model listed for the region |

Classification order matters: account-level and marketplace messages are themselves access-denied exceptions and are matched first.

### 6.4 Probe cache and rate limit

- Results are stored per target and model in `bgp-settings` under `ai-model#probe#<targetId>#<modelId>` and are considered known for 24 hours.
- The catalogue never probes on its own; it only reads the cache.
- Probes are limited to 6 per minute per administrator; the seventh returns 429 with `retryAfterSec`.
- A probe that passed within the last 10 minutes is reused when saving, so the console does not probe twice.

---

## 7. Saving the global default

`PUT /api/admin/model-config { scope: "global", modelId, expectVersion? }` runs the following server-side steps.

1. Require the platform admin group (gateway and route).
2. Reject ids that fail a cheap format check.
3. Reject ids that are not in the selectable catalogue (`NotInCatalog`); the catalogue is the only whitelist.
4. For the OpenAI family, reject while the transport gate is closed (`NotAllowedFamily`).
5. Probe the model, or accept a fresh cached probe (`ProbeFailed` with the class and detail on failure).
6. For families that require a tool-use probe, reject when `toolUseOk` is not true (`ToolUseUnavailable`).
7. Write the setting with an optimistic lock (`VersionConflict`, 409, on a stale `expectVersion`).
8. Bump the version counter and record an audit entry with old and new values.

`DELETE /api/admin/model-config?settingScope=global` removes the runtime setting and reports the layer now in effect.
The parameter is `settingScope`; `scope` is reserved for the execution scope and returns 400 `ScopeParamRenamed`.
`GET /api/admin/model-config` returns the effective model per scope with its source layer and the stored overrides.
`GET /api/admin/model-config/catalog` returns the selectable models with family, kind (base model or inference profile), availability and last probe.

---

## 8. Transport gate for the OpenAI family

Claude models are called through the Bedrock Converse API with a tool loop. Whether OpenAI models on Bedrock support
the same tool loop through Converse is decided by evidence, not assumed.

- The gate is a settings row `ai-model#__transport` holding `gptReady`, the probed model id and the probe time.
- `PUT /api/admin/model-config/transport { gptReady: true }` is accepted only after an OpenAI-family probe with `toolUseOk = true` (`TransportNotVerified` otherwise).
- Evidence older than 24 hours no longer counts. Any read error counts as closed.
- In the current code the gate function returns closed unconditionally; the OpenAI family is listed but cannot be saved as default.

---

## 9. Request shaping and runtime fallback

### 9.1 Shaping

All platform-side Converse calls go through `invokeConverse`, which shapes the request before sending:

- strip inference fields the family does not accept, plus any field learned at runtime;
- multiply `maxTokens` by the family's output factor.

If Bedrock answers "This model doesn't support the X field", the field is recorded for that model and the call is retried once on the same layer.
Learned fields are kept process-wide and forgotten on restart; the profile is the baseline.

Shaping only removes fields and only enlarges the token budget; it never adds fields or touches messages. For the Claude family shaping is the
identity.

### 9.2 Throttle back-off and layered fallback

`invokeWithFallback` wraps every capability call.

| Rule | Value |
|---|---|
| Candidate layers | runtime, env, factory default, deduplicated |
| Retries per layer | 2, exponential back-off from 200 ms |
| On throttling | retry, then fall to the next layer |
| On model unavailable | fall to the next layer |
| On other errors | rethrow unchanged |
| On caller abort | stop immediately |

The outcome records the model used, its layer, the attempt count, whether a downgrade happened and which fields were stripped.
A fault seam (`FAULT_THROTTLE_MODEL`) forces throttling for one model id in non-production deployments so the fallback can be exercised.

### 9.3 Transient stream errors in agents

Streaming calls inside the agent containers can end mid-message. The agent loop recognises a closed list of transient errors (stream ended early,
throttling, service unavailable, internal error, socket errors, HTTP 429 and 503), waits with full-jitter back-off capped at 2.4 seconds, rebuilds the
agent and retries once.

Rejected-field errors and account-level denials are not transient and are not retried this way. The retry is visible as a step in the reasoning trace.

---

## 10. Deployment-time candidate chain

`platform/ai-model.json` carries `defaultModelId` and an ordered `candidateModelIds`.
At installation `scripts/resolve-home-model.sh <profile> <home-region>` picks the home default:

1. List the inference profiles of the home region once.
2. For each candidate, find its base model from the profile listing; expand to the candidate itself, the region's geographic profiles, the global profile and the bare id.
3. Invoke each expansion once with a 16-token budget; the first success is printed and becomes `BEDROCK_MODEL_ID`.
4. Every failure is written to stderr with the candidate, the expanded id and the service message.
5. If nothing succeeds the script exits non-zero and the deployment stops before any stack is created.

An explicit `BEDROCK_MODEL_ID` always wins and is not re-validated. `BGP_MODEL_CANDIDATES` overrides the chain for troubleshooting only.
The preflight script reports the same result so that an account with a blocked family is diagnosed before deploying.

---

## 11. Runtime switch in system settings

The "AI model" card on the system settings page is the only place where the default changes.

1. The card shows the effective model and its source layer (runtime setting, deployment variable, factory default).
2. "Change" opens a dialog with a searchable dropdown grouped by family; groups and order come from the catalogue response.
3. The selected entry shows two optional tags from the family profile: "needs tool-use probe" and "always emits reasoning blocks".
4. "Test this model" runs the probe and prints "probe passed (n s)" or the classified failure with its advice.
5. Saving opens a danger-level confirmation with an impact preview: the nine capabilities affected, all projects, effective within seconds.
6. After saving, the card refreshes to the new model and the source "runtime setting".

Other behaviours:

- Non-administrators see the card read-only.
- When the current model fails its probe, a red banner offers "Restore factory default" (no probe required) and "Choose another model".
- Catalogue loading failure shows a retry and states that the current model keeps working.
- The query page prints "Model used: <id> - backend <agentcore|inprocess>" under every answer, taken from the execution meta.

---

## 12. Asynchronous behaviour for long calls

Seven model-calling requests may run longer than the 60-second edge timeout: Copilot questions, the network advisor,
the parameter advisor, offline-job code generation, EMR code generation, requirement implementation and Flink SQL generation.
They use the platform's long-operation protocol.

1. The server runs the call and waits in-process up to `LONG_OPS_SYNC_WAIT_MS` (default 45 seconds).
2. If the call finishes in time, the response is the normal synchronous response.
3. Otherwise the server returns 202 `{ taskId, kind, label, protocol: "long-op/1" }` and keeps running.
4. The client's global fetch interceptor recognises the protocol marker, polls `GET /api/long-ops/[taskId]` and reshapes the final result into the same response the caller expected.
5. The page shows "running in background: <label> (n s)" meanwhile; page code is unchanged.

Natural-language querying has its own asynchronous task path with a 300-second ceiling and reports the model and backend in its meta.

---

## 13. Agents and containers

The three agent containers (query, network advisor, parameter advisor) receive the model id in the invocation payload and fall back to their
environment only when no payload value is present. The vendor profile, request shaping and transient-error helpers are compiled into each container as
a shared core, so a change to the shared core requires redeploying the agents.

The Copilot runtime is not part of this repository; Copilot resolves its model in-process. Agent and platform roles already allow listing and invoking
Bedrock models; no IAM change is needed per model.

---

## 14. Security and audit

- Only the platform admin group can read or change model configuration (gateway and route checks).
- Model ids are validated against the account catalogue; free-text endpoints are impossible.
- Every change is audited with the previous and the new value.
- The settings table is retained on stack deletion, has point-in-time recovery and is encrypted with the platform CMK.
- Probe cost is negligible (tiny prompts, small budgets) and rate-limited per administrator.

---

## 15. Acceptance criteria

- [ ] The dropdown groups models by family, offers only the selectable lines, and hides other lines of the same vendors.
- [ ] Testing an unavailable model shows the classified message; the save button stays disabled; nothing is written.
- [ ] Saving a probed model refreshes the card within 5 seconds; the next query, Copilot answer, Flink SQL generation and code generation all report the new model.
- [ ] A family that rejects an inference field still succeeds on every capability; no "doesn't support the ... field" error reaches a page.
- [ ] A model that fails the tool-use probe cannot be saved; the page shows the tool-use explanation.
- [ ] Deleting the runtime setting restores the deployment or factory default and reports which layer applies.
- [ ] With the settings table unreachable, AI features keep working on the last good or default model.
- [ ] With throttling injected on the current model, calls back off and then report a downgraded model in their meta.
- [ ] The seventh probe within one minute returns 429.
- [ ] The catalogue request completes without triggering any model invocation.
- [ ] The deploy-time script picks the first working candidate, logs each rejected expansion and exits non-zero when none works.
- [ ] A long Copilot or code-generation request returns the same result whether it finished synchronously or through the background task.

---

## 16. Limits and roadmap

### 16.1 Limits

- One global default for all capabilities; per-capability and per-target overrides are reserved key shapes only.
- The OpenAI family stays behind the transport gate until tool use over Converse is proven in the account.
- Account-level availability of a family is outside the platform's control; the console reports it as such.
- Reasoning models consume roughly twice the output tokens and respond more slowly; the platform compensates with the output factor and longer probe budgets.
- Global inference profiles route prompts outside the region of the data; see the residency note in the multi-region design.
- Bedrock exposes no real-time quota headroom; the quota hint is best effort and never blocks saving.

### 16.2 Roadmap (as stated in the design)

- Per-target default models (`ai-model#<targetId>#global`) configured on the execution environment page.
- Region-pinned inference profiles for targets in another jurisdiction.
- Opening the OpenAI family once the tool-use evidence exists.

---

## Appendix A. Where the facts live

| Topic | Path |
|---|---|
| Vendor profiles | `platform/src/lib/ai/core/vendors.ts` |
| Request shaping | `platform/src/lib/ai/core/converse-shape.ts` |
| Transient errors | `platform/src/lib/ai/core/transient.ts` |
| Resolution chain | `platform/src/lib/ai/model.ts` |
| Fallback and retries | `platform/src/lib/ai/invoke.ts` |
| Probe and classification | `platform/src/lib/ai/probe.ts` |
| Transport gate | `platform/src/lib/ai/transport-gate.ts` |
| Catalogue | `platform/src/lib/settings/model-catalog.ts` |
| Admin API | `platform/src/app/api/admin/model-config/` |
| Capability keys | `platform/src/lib/ai/capabilities.ts` |
| Deploy-time candidate chain | `platform/ai-model.json`, `scripts/resolve-home-model.sh` |
| Long-operation kinds | `platform/src/lib/long-ops/kinds.ts` |
