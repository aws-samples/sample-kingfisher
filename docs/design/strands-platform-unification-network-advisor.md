# Strands Platform Unification, Stage L3 — netadvisor onto Strands + Eliminating the Hand-Copied Text (Implementation Design)

> - 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For multi-region behavior — place,
>   execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is tracked in the design index. A path mentioned in this document that no longer
>   exists means that the idea was not implemented as described here or has since been superseded.
> - ⚠️ **Implementation differences**: the `@platform/agent-kit` package was not implemented under that name;
>   the agent code is currently distributed as follows: Ask-Your-Data (GenBI) in `platform/src/lib/genbi/` + `infra/agent/genbi/`, the parameter advisor in `platform/src/lib/param-advisor/` + `infra/agent/paramadvisor/`, the network advisor in `platform/src/lib/network-advisor/` +
>   `infra/agent/netadvisor/`, and Copilot in `platform/src/lib/copilot/` (including `plan/strands-tools.ts`);
>   `infra/agent/copilot` and `infra/lib/copilot-*` do not exist.

> - Status: **✅ implemented** (documentation audit calibration of 2026-08-26: the original status header was outdated — it read "design, pending approval"). Follows the engineering discipline `design-first-no-code-until-approved` + a strict contract-guard closed loop.
> - Goal: verify that the ② runtime piece (agent-runner) extracted in stage L2 can really be reused by a second capability with [zero replication].
> - Prerequisite: L2 is fully live with its contract loop closed (agent-runner / mcp / core-prebuild all in place).

## 0. Similarities and differences with L2 (in one sentence)

L3 = **follow L2's route** (extract a core to eliminate hand copying + wire into the same agent-runner), but with **one extra layer of complexity** over L2:
the netadvisor container's systemPrompt and the in-process prompt.ts **do not share a source** (different tool granularity) and must be handled separately.

## 1. Survey of the current state (with file:line, verified)

| Dimension | netadvisor today |
|---|---|
| Loop | Hand-written `for(iter)` ConverseCommand (`infra/agent/netadvisor/agent.js:142-181`), 73% identical word for word with paramadvisor |
| Hand-copied sources | `RULES_TEXT` (agent.js:34, hand-copied from rules.ts renderRulesForPrompt) + `TROUBLESHOOTING_ORDER` (agent.js:54, hand-copied) |
| Container systemPrompt | Wording for **2 merged tools** (analyze_connectivity / inspect_security_group, stateless) |
| In-process prompt.ts | Wording for **4 fine-grained tools** (probe_environment / adjudicate_path / list_remediations, stateful) → **not the same source as the container** |
| mcp.js | Word for word identical with _runtime/mcp.js (only clientInfo.name differs) |
| `@/` dependencies of rules.ts | Only `import type {...} from "./types"` (0 runtime imports, clean) |

**Key difference (vs L2)**: the paramadvisor container and in-process path share one systemPrompt; netadvisor does not
(2 tools in the container / 4 in-process). So the systemPrompt shell **cannot be unified blindly**; only the rules part can be moved into the core.

## 2. Core extraction plan

> **First-hand verification before starting (2026-07-23, with file:line)**:
> - `rules.ts` has 3 consumers, all importing specific symbols: `prompt.ts:6` (renderRulesForPrompt / TROUBLESHOOTING_ORDER), `remediation.ts:7` (RULE_BY_ID), `connectivity-judge.ts:7` (RULE_BY_ID / ruleApplies) → re-exporting preserves the API, so zero regression.
> - `rules.ts:12` only has `import type { ComputeKind, RemediationType, RuleStatus, Target } from "./types"` (0 runtime imports, clean).
> - The in-process `prompt.ts` really does have **4 tools** (probe_environment / adjudicate_path / list_remediations / inspect_security_group, prompt.ts:15/23/24/25) vs the container agent.js's **2 tools** (analyze_connectivity / inspect_security_group) → **the systemPrompt really is not shared**, so the decision "the shell stays in the container" holds.
> - 🔴 **The hand-copied RULES_TEXT has really drifted** (the same disease as the EMR version drift found in L2, confirming that extracting the core is not tidiness):
>   · AZ_MATCH: the true source, rules.ts:32, says "the job does not fail at connection time but only [at runtime]"; the container, agent.js:35, keeps only "the job fails at runtime" (the contrast is lost).
>   · PRIVATE_EGRESS: the true source, rules.ts:42, says "private subnets (pulling scripts / writing results / staging) … free, and does not leave the AWS backbone"; the container, agent.js:36, lost the parenthetical and "does not leave the backbone".
>   The hand-copy comment literally says "keep both places in sync when changing a rule", and a synchronization has already been missed → the rule text the model sees has drifted from the rules the engine executes.

`network-advisor/core/` (following the param-advisor/core pattern, zero `@/`):
- `types.ts` — **[Decision: push down only the 4 types the rules need]** move only `RuleDef` + `ComputeKind` / `RemediationType` / `RuleStatus` / `Target` (the 4 that rules.ts actually imports); the large advisor-contract types (ConnectivityRequest / Recommendation / EnvironmentFacts / Prefill and so on) stay in network-advisor/types.ts. The core = the minimal kernel of rule data shared by the model and the engine (following the L2 core/types.ts pattern of only 1.8 KB).
- `rules.ts` — move the `RULES` array + `renderRulesForPrompt()` + `TROUBLESHOOTING_ORDER` + `RULE_BY_ID` / `ruleApplies`
  (**inlining** the deterministic content of the current rules.ts; RULES is pure data with no `@/`, clean)
- In the reverse direction: the original `rules.ts` re-exports the core (the 3 in-process consumers connectivity-judge / remediation / prompt keep an unchanged API)

**`@/` handling**: rules.ts only `import type`s from ./types (erased at compile time, 0 runtime dependencies), **cleaner** than L2's catalog (which inlined the worker / EMR constants) — the core only needs to push down RuleDef plus the 4 types above, with no external constants inlined.

**[Decision: drift guard = re-export + snapshot unit test]**: once the rules are extracted into the core they are naturally single-sourced (the original file re-exports; there is only one RULES), so the L2-style double-source comparison "core constants === platform true source" is unnecessary (netadvisor is single-sourced to begin with). Add one lightweight snapshot unit test on top: assert that the output of `renderRulesForPrompt()` contains all 18 rule ids + the key hard / soft markers, guarding against a future accidental deletion of a rule or a broken rendering.

**Where systemPrompt belongs (key decision)**:
- The container's systemPrompt (2-tool wording) is **specific to the netadvisor container** and does not share a source with the in-process 4-tool version → **it stays inside the container's agent.js** (not moved into the core, because the in-process path does not use it). It imports the core's `renderRulesForPrompt()` + `TROUBLESHOOTING_ORDER` for assembly (eliminating the hand-copied RULES_TEXT / TROUBLESHOOTING_ORDER).
- This differs from L2: L2 moved the whole systemPrompt into the core (because container and in-process shared a source); L3 moves only the rules data, and the systemPrompt shell stays in the container. **Honest trade-off**: netadvisor's container systemPrompt wording remains one copy (inside the container), but it no longer hand-copies RULES_TEXT (it imports the core instead) — the hand-copy drift risk (high severity) is eliminated, and keeping the systemPrompt shell (a description of the 2-tool workflow, rarely changed) in the container is acceptable.

## 3. Wiring the container into agent-runner (reusing L2's ② runtime piece, zero replication)

The netadvisor container agent.js slims down and declares its spec:
```js
import { runAdvisorAgent } from "./_runtime/agent-runner.js";
import { renderRulesForPrompt, TROUBLESHOOTING_ORDER } from "./core-dist/rules.js"; // 消手抄
// systemPrompt 外壳留容器(2工具措辞,进程内不用);内部拼 core 的 rules
function systemPrompt() { return [ ...(2工具工作流), renderRulesForPrompt(), TROUBLESHOOTING_ORDER, ... ].join("\n"); }
function firstTurnText(req) { return [`计算类型: ${req.computeKind}`, `目标: ${JSON.stringify(req.targets)}`, ...].join("\n"); }

export const runAgent = (input) => runAdvisorAgent(input, {
  clientName: "bgp-netadvisor-agent",
  systemPrompt: () => systemPrompt(),            // 无参(netadvisor systemPrompt 不依赖 channel)
  firstTurnText,
  inject: (raw, req) => ({ ...raw, request: req }),   // 同 L2:注入整个 request
  captureSuffix: "analyze_connectivity",              // netadvisor 的权威结果工具
  maxIters: NETADVISOR_MAX_ITERS, maxTokens: NETADVISOR_MAX_TOKENS,
  finalize: (reasoning, lastAnalysis, steps, usage) => ({
    reasoning,
    verdict: lastAnalysis?.verdict || "unknown",
    rulings: lastAnalysis?.rulings || [],
    remediations: lastAnalysis?.remediations || [],
    candidates: lastAnalysis?.candidates || [],
    chosenPlacement: lastAnalysis?.chosenPlacement || null,
    facts: lastAnalysis?.facts || null,
    steps, llmAvailable: true, usage,
  }),
});
```
**This proves that the agent-runner spec contract is general enough**: netadvisor differs only in its finalize fields + a parameterless systemPrompt +
a different captureSuffix; the loop / MCP / Strands / fallback are all reused. **Not a single line of agent-runner.js changes** (if it had to change, the contract design would be flawed, and that would have to be faced).

- Prebuild: add a netadvisor row to the core-prebuild.sh registry (CAP_TSCONFIG / CAP_CORE_SRC / CAP_DESTS / CAP_RUNTIME_DEST);
  deploy-all already runs `all`, so it is covered automatically.
- Container CJS→ESM (package.json type:module + add Strands / zod / mcp / otel; index; delete mcp.js and use the shared one; Dockerfile adds COPY _runtime + core-dist) — following L2.

## 4. Verification checkpoints (a strict contract-guard closed loop + the 5 checkpoints, same as L2)

0. **Snapshot before the change**: contract-guard baseline tag `before-l3-netadvisor` (locking existing functionality)
1. After extracting the core: platform tsc 0 + vitest (regression of the existing network-advisor unit tests; re-export preserves the API) + drift guard (core rules === platform true source)
2. Prebuild netadvisor: core-dist generated + the genbi / paramadvisor core-dist git diff is empty (zero regression)
3. Local `docker build infra/agent/netadvisor` exits 0
4. Start the container locally: /ping healthy + /invocations cleanly reports GATEWAY_URL not configured (the whole assembly passes)
5. After deployment: buildx + rebuild the netadvisor Runtime + **headless-browser verification that the network advisor really produces a verdict** (verdict / rulings / candidates) + cross-check the Runtime / Lambda logs (agent.invoke ok, not degraded)
6. **Verify after deployment**: contract-guard shows zero regression against the baseline → all green, then prompt for confirmation of the commit

## 5. Rollback
Tag `pre-strands-netadvisor` before the change. The container / core / runner changes can be restored by checkout; production is unaffected until the Runtime is rebuilt.

## 6. Risks and honest assessment
- **The real test of agent-runner's generality**: if wiring netadvisor in requires changing agent-runner, the spec contract has missed a dimension — then stop and redesign the contract (do not force it in). The current judgment is that the three points finalize / systemPrompt / captureSuffix suffice, but **the actual wiring is the arbiter**.
- **Keeping the systemPrompt shell in the container** is a real difference from L2 and is not forcibly unified (forcing it would push netadvisor's 2-tool wording into the in-process 4-tool scenario and break the in-process path). This embodies the spirit of "capability tiers" — the commonality is extracted (rules data + loop), the individuality (tool granularity → systemPrompt shell) is kept.
- netadvisor's `analyze_connectivity` tool may return larger payloads than paramadvisor's (candidates + rulings + facts); feeding them back over two turns → the response may also be slower (see the backlog item on framework-level unified optimization; not changed in L3).
