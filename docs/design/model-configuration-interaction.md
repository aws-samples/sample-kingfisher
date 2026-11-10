# Model Configuration — Interaction Design Chapter: Runtime-Configurable Bedrock Models

> - Revision: **1.7** (🆕 2026-10-20, after the probe budget was overrun by Kimi K3's first-token latency (the 10 s budget collided with a 3–39 s first-token delay, so the model could not be switched to in Settings): F8 gains a `Timeout` text (timeout ≠ throttling; prescription "test again shortly /
>   switch to a global. inference profile");
>   a second-probe timeout shows "tool-use probe timed out; test again" instead of "tool-use unavailable";
>   the "Probing" row of the state table: budget per family (Kimi K3 45 s / all others 10 s, both probes in parallel), timeout listed separately as Timeout) · **1.6** (2026-10-14, after construction, section 7 corrected against the code that landed: the two F8 texts and the two family tags follow
>   the implemented wording;
>   the save button is not disabled up front; the server-side step ③′ rejects and the page shows the text;
>   the Ask-Your-Data result card gains a "Model used · backend" row;
>   the unimplemented hover hint on the source tag was removed;
>   the acceptance wording switched to page-driven) · **1.5** (🆕 2026-10-14 multi-vendor: section 7 four-family grouping, two new F8 texts (not enabled for the account / tool use unavailable), reasoning blocks transparent to the user;
>   based on the design document, revision 2.3, section 12) · **1.4** (🔴 2026-08-29 feedback from the convergence verification: the per-region model override key of section 1bis **`ai-model#<region>#global` → `ai-model#<targetId>#global`**, and made explicit that "**the UI copy still says 'this
>   region', while keys and parameters always use `targetId`**;
>   when several targets coexist in one region, the card renders them per target and does not merge them" — rationale in the design document, decision D8 on the dimension) 1.3 (a design-review finding: the "capability-level override" item of the section 6 interaction acceptance is marked [phase 2,
>   not verified in phase 1], symmetric with the design document, section 10;
>   1.2 a design-review finding: section 1bis transport changed to probe gating + the residency gap accepted in phase 1, not gated off;
>   1.1 + section 1bis, interaction impact of the model-selection decision) | Date: 2026-08-27 (revision 1.3: 2026-08-28) | Status: ⬜ In design, pending review
> - Positioning: the **authoritative page-interaction landing** of the model-configuration module; follows the platform-wide interaction principles (group A whole-platform / B reasonable / C friendly, the F series / D safe), to the same specification as the interaction chapters of the [multi-region
>   execution](./multi-region-execution-interaction.md) and [project isolation](./project-isolation-interaction.md) modules.
> - 🔴 Red line: pure design; no code is written without an explicit instruction.

---

## 0. Why the model-configuration module needs its own interaction chapter (origin)

A deep design review found that this module's interaction so far consisted only of the 4 bullets in section 5 of the design document (card / change modal / probe / advanced collapse), **with no dedicated chapter, no danger-confirmation tier, no impact preview, no error states and no restore-default interaction**. Yet the module itself classifies "pick a model on the page, takes effect immediately" as its **top-priority (P0) risk: a global single point across all tenants × all AI features** (section 9.3), and it is the module **landed first in the implementation order** — the interaction handed to users first was the thinnest, disconnected from principles D1 (second confirmation for high-risk actions), B2/D2 (impact preview), F8 (friendly refusal) and F1 (per-page guidance) alike. This chapter fills the gap.

**The core contradiction**: switching one rule (light-tier Popconfirm) and switching the global default model (affects everyone's every AI feature) currently carry the same interaction "confidence level" — both are just a click on save. This violates A3 (critical scope as a first-class citizen) and the principles' ruling D (danger confirmation tiered by blast radius). **Changing the global model has a far larger blast radius than deleting a single region, yet its danger tier is lighter — an inversion that must be fixed.**

---

## 1. General interaction rules (anchored on the principles)

| Principle clause | Landing in this module |
|---|---|
| **A2 Safe by default** | The model dropdown defaults to the **currently effective model** and preselects no new model; capability-level overrides all default to "inherit global", with no override preset |
| **A3 Scope as a first-class citizen** | The AI model card permanently shows **which model each capability actually uses right now + the source layer** (runtime config / env / factory default), eliminating "I thought I changed it but it never took effect" |
| **A4 Honest boundary** | The copy does not claim "switched" until the probe has passed and active invalidation has taken effect; the Copilot container is not in this repository, its model configuration goes through the in-process path, and the UI labels this honestly (it does not pretend the AgentCore pass-through covers it) |
| **B2/D2 Impact preview** | Before switching the global default, preview "the 9 capabilities that will be affected + takes effect for all tenants" (see section 2, scenario one) |
| **D1 + ruling D Danger tier** | Switching the **global default** = medium tier `Modal.confirm danger` (affects the whole platform but is reversible); switching a single-capability override = light tier; "Restore factory default" = self-rescue from a broken state, no friction |
| **F1 Per-page guidance** | The AI model card on /settings carries a `FeatureGuide`: "This is where the LLM used by every AI feature of the platform is configured; changes take effect for everyone immediately" |
| **F8 Friendly refusal** | A failed probe explains "why + what to do" per error class (especially Marketplace SCP, see section 2, scenario two) |
| **Ruling D-2 Status color palette** | The three-state probe badge uses the unified palette: available = green, unavailable = red, not probed = default gray, probing = processing blue |

---

## 1bis. 🔴 Impact of the model-selection decision on the interaction (decided 2026-08-28; see the design document, decisions D3 / D9)

Decided on 2026-08-28; the following **overrides the related details further down in this chapter** (the model names inside the wireframes below are early illustrations; this section prevails):
- **The dropdown contains only two families**: **every Claude Opus version + the OpenAI GPT-5.6 family** (`openai.gpt-5.6-terra/-luna/-sol`, through the Bedrock OpenAI-compatible endpoint); no other Bedrock model enters the selection surface. **Global default = `claude-opus-4-8`** (read `opus-4-6` in the wireframes below accordingly).
- **No per-capability differentiation in phase 1** ("all models go through the global setting"): **scenario three (per-capability override) is demoted to phase 2** (the phase-1 UI does not show the "Per-capability overrides" collapsible area); the capability-key allow-list stays (anti-drift). Scenario one's "impact preview lists 9 capabilities" still holds (all 9 capabilities are affected by the global default); phase 1 just cannot change them one by one.
- **The per-target model override** (an execution target using its own model; 🔴 key **`ai-model#<targetId>#global`** — 2026-08-29 feedback, originally written `<region>`, rationale in [the design document](./model-configuration.md), decision D8 on the dimension) has its configuration UI **on the "AI model for this region" card of the execution-environment detail page of the multi-region execution module** (see [its interaction design](./multi-region-execution-interaction.md)), not on /settings;
  - /settings manages only the global default.
  - **The UI copy still says "this region"** (region is an attribute users understand), but **keys and parameters always use `targetId`**;
  - when several targets coexist in one region, the card renders them per target and does not merge them.
- **Transport is transparent to the user**: the user only sees "pick Claude Opus or GPT-5.6" and does not perceive the underlying transport difference; the actual call transport of the two families **is decided by the probe gating of design decision D9** (if GPT-5.6 supports Converse tool use, both families go through Converse; otherwise GPT goes through the Bedrock OpenAI-compatible endpoint). Before the probe verdict, **GPT-family availability is determined by a probe from the platform account**; until it passes, that entry shows the unavailability reason per F8 (see scenario two) without blocking the Claude main path.
- 🔴 **Residency gap (in sync with [the multi-region execution design](./multi-region-execution-design.md), section 8.5)**: phase-1 models go through `global.*` profiles → **Ask-Your-Data / Copilot model calls from a cross-jurisdiction region have a data-egress gap** (pure SQL / BI is unaffected). **Decided on 2026-08-28: phase 1 accepts this gap** — Ask-Your-Data in cross-jurisdiction regions **stays open as usual** (not gated off, not grayed out); region pinning closes it as a follow-up optimization. In the interaction, an F4 info label next to the Ask-Your-Data entry states "Ask-Your-Data model calls currently go through global routing" as an informational notice that does not block the operation.

## 2. Core interaction scenarios

### Scenario one: switching the global default model (highest risk; B2 impact preview + medium-tier confirmation)

**Trigger**: an admin clicks "Change global default" on the "AI model" card of /settings.

**Flow**: pick a model (catalog dropdown with probe badges) → "Test this model" (probe, must pass) → click save → **medium-tier danger confirmation dialog + impact preview** → confirm → active cache invalidation → the card refreshes and shows the new model in effect.

**Why medium tier rather than light**: switching the global default = changing **all 9 capabilities** (GenBI / Copilot / codegen / modeling advisor, and so on) in one stroke, effective for **all tenants**. Per the principles' ruling D, "affects the whole scope" calls for at least the medium tier; because it is reversible (deleting the setting falls back) it does not reach the heavy "type the name" tier.

```
┌─ Change global default model ─────────────────────────────────────────┐
│ Effective now: anthropic.claude-opus-4-6 (source: runtime config)     │
│ Change to:     [anthropic.claude-sonnet-5      ▼] 🟢 available        │
│                [🧪 Test this model]  → ✓ Probe passed (1.2s)          │
│ ───────────────────────────────────────────────────────────────────── │
│ ⚠ Impact preview (takes effect platform-wide immediately):            │
│   Affected capabilities (9): Ask-Your-Data / Copilot / codegen /      │
│     retrieval / memory / modeling advisor / network advisor /         │
│     parameter advisor / Flink SQL generation                          │
│   Scope: all tenants, all projects                                    │
│   Takes effect: immediately after saving (active invalidation,        │
│     no restart / no waiting)                                          │
│ ───────────────────────────────────────────────────────────────────── │
│                                  [Cancel]  [Confirm change (danger)]  │
└───────────────────────────────────────────────────────────────────────┘
```

### Scenario two: friendly presentation of a failed probe (F8, especially Marketplace SCP)

**Trigger**: a model was selected and "Test" clicked; the probe returns a failure (classification per design decision D5: AccessDenied / NotFound / Marketplace SCP forbids Subscribe / Throttle / NotAvailableForAccount / 🆕 Timeout).

**Requirement**: no bare error codes; explain "why + what to do" per class (F8); the save button stays disabled (D5: a passing probe is mandatory before saving).

| Error class | Friendly text (why + what to do) |
|---|---|
| AccessDenied | "This account cannot invoke this model. Request access in the Bedrock console or pick an enabled model." |
| NotFound / not available | "This model is unavailable in the current region. Pick one that is live here (the list is region-filtered; it may have just been retired)." |
| **Marketplace SCP forbids Subscribe** | "This model requires an AWS Marketplace subscription, but your account policy (SCP) forbids subscribing to third-party models. Use a first-party Anthropic model or ask your account admin to allow subscriptions." (anchored on the design document's P1 risk "Marketplace SCP forbids Subscribe → Opus-family enablement fails", a lesson learned from an earlier incident) |
| Throttle | "The probe was throttled; please retry shortly." |
| 🆕 Timeout (revision 1.7, 2026-10-20, Kimi K3 first-token latency overran the probe budget) | "Probe timed out: the model did not respond within this family's budget (reasoning models can take tens of seconds to start; this is not throttling). Test again shortly; if it keeps timing out, switch to the global. inference profile or contact your AWS account team." (when the second probe times out, the probe still passes; the result line reads "Probe passed (N s) · tool-use probe timed out; test again" and does not say "unavailable") |

### Scenario three (⚠️ phase 2, not in phase 1 — see section 1bis): capability-level overrides (inherit / override visualization + meaning of the 9 capabilities)

**Trigger**: an admin expands the "Per-capability overrides" advanced area of the card (the advanced collapsible area of design document section 5, 9 items).

**Requirement**: the 9 capability keys are jargon to users and need visualization: each item shows the **current value + a badge (🔵 inherits global / 🟡 overridden)** + an F4 tooltip explaining what the capability is. Overriding a single capability = light tier (small impact, reversible).

```
┌─ Per-capability overrides (default: inherit global: opus-4-6) ──────┐
│ Capability           Current model          Status                  │
│ Ask-Your-Data (i)    opus-4-6               🔵 inherited            │
│ Copilot       (i)    sonnet-5               🟡 overridden [Reset]   │
│ codegen       (i)    opus-4-6               🔵 inherited [Override] │
│ … (the other 6 items)                                               │
│ (i) hover explanation, e.g. "codegen = SQL / script generation in   │
│     the Requests workbench"                                         │
└─────────────────────────────────────────────────────────────────────┘
```
> Keys such as `retrieval` / `memory` / `net-advisor` / `param-advisor` / `flink-sql-ai` all get a tooltip saying which page / feature they land on, so that an admin facing jargon knows which one to change.

### Scenario four: model-failure alert + restore factory default (the sole lifeline for the P0 risk; F6 recoverable failure)

**Trigger / background**: the pre-save probe can only block models that are "already broken at save time"; when **the model fails only after saving** (account quota change / SCP change / model retirement), AI across the whole platform goes down — then "Restore factory default" is the only self-rescue. The deep design review found that this path had **only been mentioned in the risk table, with no interaction at all**.

**Requirements**:
- The AI model card **permanently shows the live probe state of the current model**; when the currently effective model is detected to fail its probe, a **conspicuous red alert banner** appears at the top of the card: "⚠ The current model X is no longer available; all AI features of the platform may be failing. [Restore factory default now] [Choose another model]".
- "Restore factory default" = delete all runtime overrides and fall back to env / SSOT (last item of the acceptance list in the design document, section 10). **This operation recovers from a broken state and does not require a passing probe** (otherwise the button would be dead in the broken state = deadlock); it does need one light confirmation against accidental clicks.

```
╔═ ⚠ AI model problem ════════════════════════════════════════════════╗
║ Current model anthropic.claude-xxx failed its probe: model retired  ║
║ All AI features of the platform may be unavailable.                 ║
║   [🔧 Restore factory default now]   [Choose another model]         ║
╚═════════════════════════════════════════════════════════════════════╝
```

---

## 3. States and empty / loading / error states (entirely missing before)

| State | Interaction |
|---|---|
| Catalog loading | Dropdown in loading state; does not block the rest of the card |
| Catalog fetch failed | F2 empty-state exit: "Failed to load the model list (Bedrock ListFoundationModels error), [Retry]; the effective model is unaffected and still running" |
| Probing | "Test" button in loading state + processing blue badge; the timeout budget is per family (vendor profile `probeTimeoutMs`: Kimi K3 45 s / all others 10 s; the tiny probe and the tool-use probe run in parallel, wall time ≈ max), and a timeout is listed separately as the **Timeout** class (revision 1.7; the former "10 s timeout counts as Throttle" is withdrawn) |
| Non-admin access | The card is **read-only**: it shows the effective model per capability + source (no change / override buttons; PUT gets 403 from the middleware, the frontend offers no entry) |
| First use (no runtime configuration at all) | The card shows "Not customized: using the factory default (SSOT)" and offers a "Customize" lead — this is A2 safe by default: nothing is changed proactively |

---

## 4. Anchors in existing interaction conventions (reuse, do not invent)

| Interaction of this module | Existing convention reused | Evidence |
|---|---|---|
| /settings card as carrier | Existing card layout of the settings page | `app/settings/page.tsx` 🔵 (design document, section 5: no new page, zero change to routes.tsx) |
| Danger confirmation (medium tier) | `Modal.confirm{okButtonProps:{danger}}` | Medium tier of the principles' ruling D, anchored on `realtime-compute askDecision` 🔵 |
| Probe-state badge | `Badge` / `Tag` with three states, unified palette | Ruling D-2 of the principles; analogous to `VerdictBadge` 🔵 |
| Per-page guidance | `FeatureGuide` | `components/common/FeatureGuide.tsx` 🔵 (gap against principle E2: the card of this module must add it) |
| Read-only degradation | Existing admin gateway + button show / hide | `middleware.ts:104` 🔵 |

**Needs new design (not covered by conventions)**: ① the impact-preview dialog (9 capabilities / all tenants preview when switching the global model) — a platform-wide gap against principles B2/D2, and this module is the first landing point; ② the model-failure alert banner + the restore-default self-rescue entry; ③ capability-level inherit / override badges + tooltips for the 9 capabilities.

---

## 5. Friendliness (where the F series lands in this module) and consistency

- **F1 Per-page guidance**: FeatureGuide on the AI model card (the number-one gap in the principles; mandatory for this module).
- **F3 Most common as default**: the dropdown defaults to the currently effective model; capability level defaults to inherit everywhere.
- **F4 Help close at hand**: tooltips right next to the 9 capability keys and terms such as Marketplace / SCP.
- **F5 Immediate feedback**: the probe has a loading state + a result message; after saving, the card refreshes the source tag immediately (echoing "active invalidation, effective immediately", so the user does not doubt whether it took effect).
- **F6 Recoverable failure**: restore factory default (scenario four); deleting an override falls back to the next layer (design document, section 10).
- **F8 Friendly refusal**: classified texts for failed probes (scenario two); non-admins get read-only rather than a hard refusal.

**Consistency with the multi-region execution and project isolation modules**: danger-confirmation tiers all follow ruling D of the principles (deleting an execution environment = heavy tier, type the name; deleting a workspace = heavy tier; switching the global model = medium tier danger — tiered by impact and reversibility, self-consistent); status badges use the unified palette; friendly refusal uses F8 throughout. **This module is no longer the "outlier"** (before the deep design review it had none of these mechanisms).

---

## 6. Interaction-layer acceptance (complementing the interaction side of the design document, section 10)

- [ ] Switching the global model must open the impact preview (listing 9 capabilities + all tenants) + the medium-tier danger confirmation; the headless assertion checks that the dialog fields are non-empty.
- [ ] Each of the four probe-failure classes shows its own friendly text (no bare error codes); the save button is disabled until the probe passes.
- [ ] When the current model fails, a red alert banner with a "Restore factory default" button appears at the top of the card; after clicking, the configuration is cleared and AI falls back to env (headless + real state source: the DynamoDB configuration item has been deleted).
- [ ] A non-admin opening /settings: the AI card is read-only, there are no change / override buttons, PUT returns 403.
- [ ] **(Phase 2 of this module, not verified in phase 1)** capability-level override items show the inherited / overridden badge; each of the 9 capabilities has a tooltip.
- [ ] The AI model card has a FeatureGuide (F1).

---

## 7. 🆕 Revision 1.5: impact of multi-vendor support (GLM 5 / Kimi K3) on the interaction (2026-10-14, design document section 12; **corrected in revision 1.6 against the landed code**)

- **Section 1bis "the dropdown contains only two families" is withdrawn**, replaced by **four-family grouping**: Claude Opus · OpenAI GPT-5.6 (via Bedrock) · GLM 5 (Z.AI, via Bedrock) · Kimi K3 (Moonshot AI, via Bedrock).
  - Group titles and their order are **read only** from `families[]` of `GET /catalog` (the `label` of the server-side vendor profile `vendors.ts`, through i18n);
  - when an older server does not return `families[]`, the page degrades to grouping by the family keys that appear in the catalog, with title = key name (nothing is invented).
  - Placeholder "Select a model (grouped by vendor series: <the four titles>)";
  - the first tour step and the hint bar switch to the four-family wording; the page no longer contains the literals "two series" or "Claude Opus / GPT-5.6 only".
  - The catalog as a whole is sorted with `available` = true first (sorted server-side, see [the specification](./model-configuration-spec.md), section 7.5).
- **The transport-gate line for the GPT family is unchanged** (its options are still disabled by the gate and labeled "not open in phase 1"); GLM / Kimi have no transport gate, only "probe + tool-use" evidence.
- **The description line of the selected entry** gains two tags (from `families[]`): families with `toolUse = probe` show "tool-use probe required" (hover: this series must pass the tool-use probe before saving; Ask-Your-Data / Copilot / advisors all rely on tool calls; `data-testid=ai-model-family-tooluse`);
  - families with `reasoningBlocks` show "always reasoning blocks" (hover: every reply emits a reasoning block first, output tokens are about 2× Claude's, the platform already scales maxTokens by a factor, the reasoning block is transparent to pages; `data-testid=ai-model-family-reasoning`).
- **Scenario one (change global default)**: the "Test this model" result line shows "Probe passed (x s) · tool-use unavailable" for a model that failed the second probe. 🔴 **The save button is not disabled up front by the frontend on the basis of tool use** (the frontend only looks at probe ok); clicking save ⇒ the server-side step ③′ returns 400 `ToolUseUnavailable` ⇒ the page shows the text "This model cannot call tools under Converse (tool-use probe failed); GenBI / Copilot / advisors would go silent, so it cannot be the global default", and the configuration is unchanged.
- **Scenario two (F8) gains two classes** (texts are the implemented wording):

| Error class | Friendly text (why + what to do) |
|---|---|
| **NotAvailableForAccount** (probe failed) | "This model is not enabled for this account (Bedrock says "not available for this account" — an account-level restriction unrelated to region / IAM / Marketplace). Ask your AWS account team to enable it, or pick another version of the same family or another vendor." |
| **ToolUseUnavailable** (save rejected) | "This model cannot call tools under Converse (tool-use probe failed); GenBI / Copilot / advisors would go silent, so it cannot be the global default" |

- **The Ask-Your-Data result card gains a "Model used" row** (design decision D16): below the answer, "Model used: <id> · backend agentcore|inprocess (· degraded to fallback)", with values taken from the `_meta` reported by the execution layer; it sits next to the existing "This SQL actually ran in". Other AI entry points (the Copilot drawer / Flink "AI generate" / job "AI generate code" / the two advisors) get no model label in this wave; their page evidence is "the action succeeded and no error about a rejected field".
- **Reasoning blocks are transparent to the user**: Kimi K3 answers do not display `reasoningContent` (each page renders only `text`); response time may be longer than Claude's; the existing processing state is sufficient and no new state is added.
- The "hover hint on the `source = env` source tag showing the deploy-time candidate chain" mentioned in revision 1.5 **was not implemented in this wave** (the candidate chain is explained in [the deployment guide](../deployment.md), section 2, step ③, and in [the operations guide](../operations.md); the page does not repeat it); if it is ever done, it belongs to a later phase.
- **Acceptance** (interaction layer, page-driven; see section 8 of the module's acceptance criteria): ① the dropdown group titles match `families[].label` verbatim and include "GLM 5" and "Kimi K3";
  - ② select Kimi K3 → Test → the result line says "Probe passed" without "tool-use unavailable" → Save → Confirm change → the card's "Effective model" = that model, source = runtime config;
  - ③ select `us.zai.glm-5.3` (not enabled for the account) → Test → the result line says "Probe failed: NotAvailableForAccount" + the F8 text contains "This model is not enabled for this account", save disabled;
  - ④ the literal "two series" cannot be found anywhere on the page;
  - ⑤ after asking a question on /genbi, the result card's "Model used" = the model just saved, backend = agentcore.
