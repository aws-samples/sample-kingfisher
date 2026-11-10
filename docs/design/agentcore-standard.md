# Platform standard — AI capabilities on Amazon Bedrock AgentCore (an independent Gateway + Runtime + Memory per capability)

> - 📌 **Scope note (reconciled on 2026-10-13)**: this document was written during the single-region stage and records the design as it stood then (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place,
>   execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is tracked in the module index of the engineering documentation; a path
>   mentioned below that no longer exists means that the idea was not implemented as written here or has since been superseded.
> - ⚠️ **Implementation differences**: `infra/lambda/netadvisor-skills` does not exist; the network advisor runtime lives in `infra/agent/netadvisor/`, and the three AgentCore agent directories are `infra/agent/{genbi,netadvisor,paramadvisor}`.

> - Status: **standard established (2026-07-01)**. Account `<account-id>` / test-account profile `temp-account` / us-east-1.
> - Positioning: this document is a **platform-level standard (the baseline to copy from)**, not the implementation document of any single capability. It abstracts the approach that GenBI (the AgentCore GenBI module, [design](./agentcore-genbi.md)) has already verified LIVE in this account into a fixed paradigm, contracts, naming, deployment orchestration and reuse checklist that "any AI capability going onto AgentCore follows".
> - Lineage: **GenBI (the AgentCore GenBI module) = the pioneer implementation** (it ran first, but was not abstracted into a reusable standard at the time); **the Network Connectivity Advisor (this round) = the first implementation built to this standard**; every subsequent AI capability (such as the downstream "parameter-assistance agent") is created as a new set in the same way.

## 0. One-sentence conclusion

**Every AI capability = one independent AgentCore trio (Runtime + Gateway + managed Memory) + one thin platform wrapper.** The isolation granularity is **fully independent per capability** (no shared Gateway). All capabilities obey the same fixed set of contracts (HTTP / MCP / SigV4 / sessionId / switch-and-fallback), follow the same naming convention and the same two-pass deployment orchestration, and maximize reuse of the protocol-layer code already verified by GenBI (`mcp.js` / `agentcore-client.ts` / the `memory.ts` skeleton / the `Dockerfile` can be copied almost as is), changing only the "business logic" (system prompt + tool definitions + skill implementation).

## 1. Why a standard (evolution chain + honest trade-off)

**Evolution chain**:
1. **The managed-service parameter exposure work item** (exposing the full parameter set of managed services) → discovered that the network / role / task / resource parameters of Glue / Flink / DMS were hard-coded and not exposed to users.
2. The question was raised: can these parameters be **AI-assisted**? Run it on AgentCore or on the DevOps Agent?
3. After auditing the three existing AI capabilities, the conclusion: the **Network Connectivity Advisor** is the best-fitting carrier for this kind of "beforehand · perceive the environment → give a recommendation + reasons + multi-turn" task (a channel-agnostic contract; `ComputeKind` already covers glue / dms / flink); the DevOps Agent is after-the-fact diagnosis (locating misconfiguration); GenBI is bound to NL→SQL.
4. Decision: **establish "every AI capability = an independent Gateway + Runtime + managed Memory" as the platform standard**, roll out subsequent capabilities the same way, and use the network advisor as the first exemplar.

**Honest trade-off (on record)**: the in-process version of the network advisor itself works well (low latency, read-only, graceful degradation). The benefit of moving onto AgentCore is **not a functional improvement** but: ① a unified architecture standard (observability / X-Ray / managed Memory / per-second billing); ② tool reuse across agents (once a skill is attached to a Gateway, other agents can mount and call it directly in the future); ③ the "family of advisor / assistant agents" is itself a moat. The cost is refactoring a lightweight module into a distributed multi-component system plus one more always-on billed resource. The direction was explicitly requested, so it proceeds; but every exemplar must prove with **three-way verification** that the standard truly holds (section 10).

> The complete design and the phased implementation live in the approved overall plan of this round (an internal planning note, not part of this repository); the quick decision reference is kept in the internal engineering notes.

## 2. Paradigm: the five components

`<cap>` stands for the capability short name (such as `genbi` / `netadvisor`).

| Component | Responsibility | AWS resource type | Naming (see section 4) |
|---|---|---|---|
| **Independent Runtime** | ARM64 container that runs the Bedrock Converse tool-use loop; MCP client that calls the Gateway tools | `AWS::BedrockAgentCore::Runtime` (+ the gated RuntimeEndpoint) | `bgp_<cap>_agent` |
| **Independent Gateway** | MCP tool gateway; **AWS_IAM inbound (SigV4, no OAuth)**; exposes Lambda functions as MCP tools | `AWS::BedrockAgentCore::Gateway` + `GatewayTarget` | `bgp-<cap>-gateway` |
| **Skills Lambda** | Gateway target backend; the capability's **deterministic logic** lives here (pure functions + AWS SDK) | `lambda.Function` (ARM64, Node 20) | `bgp-<cap>-skills` |
| **Managed Memory** | Short-term session events (CreateEvent / ListEvents) + semantic long-term memory (RetrieveMemoryRecords), isolated by actorId | `AWS::BedrockAgentCore::Memory` (SemanticMemoryStrategy) | `bgp_<cap>_memory` |
| **Thin platform wrapper** | `InvokeAgentRuntime` call + **in-process fallback** + memory injection; authentication / workspace isolation / governance stay on the platform side | Next.js lib + API route | `platform/src/lib/<cap>/agentcore-client.ts` |

**Three IAM roles** (measured on GenBI, `agentcore-stack.ts`):
- Gateway outbound role `bgp-<cap>-gateway-role` (`:90-98`): assumed by `bedrock-agentcore` to invoke the target Lambda.
- Runtime execution role `bgp-<cap>-runtime-role` (`:101-115`): assumed by `bedrock-agentcore`; calls the Bedrock model + the Gateway + logs + pulls the ECR image + X-Ray.
- Memory execution role `bgp-<cap>-memory-role` (`:223-230`): lets the Memory service call the embedding / extraction models (required by the semantic strategy).

## 3. Fixed contracts (every capability obeys them; the parentheses give the real GenBI source = the source of the standard)

1. **Runtime HTTP contract** — the container listens on `:8080` and implements `GET /ping` (returns `{status:"healthy"}`) + `POST /invocations`; the input accepts either `{input:{...}}` or a bare `{...}`; the output is always `{output:{...}}`; errors return 4xx / 5xx with `{error}`.
   Source: `infra/agent/genbi/index.js:14-16` (ping), `:17-42` (invocations), `:23-24` (input compatibility), `:36` (output).
2. **Runtime → Gateway: MCP + SigV4** — MCP protocol version `2025-03-26`; SigV4 `service="bedrock-agentcore"` (fixed value); handshake sequence `initialize` → `notifications/initialized` → `tools/list` → `tools/call`; SSE response parsing is supported.
   Source: `infra/agent/genbi/mcp.js:15-20` (SigV4), `:67-76` (initialize, `protocolVersion:"2025-03-26"` at `:70`), `:78-81` (tools/list), `:84-102` (tools/call).
3. **Gateway tool-name encoding** — the Gateway passes the tool name to Lambda as `<targetName>___<toolName>` in `clientContext.Custom.bedrockAgentCoreToolName`; Lambda splits on `___` and dispatches on the last segment.
   Source: `infra/lambda/genbi-skills/index.js:60-66` (`toolNameOf`).
4. **Platform → Runtime call** — `isAgentCoreConfigured()` checks the `<CAP>_RUNTIME_ARN` env; `InvokeAgentRuntimeCommand` carries `runtimeSessionId`, `qualifier="DEFAULT"`, `contentType/accept="application/json"`, `payload={input:{...}}`; the response stream goes through `transformToString` and then `JSON.parse`, and `parsed.output` is taken.
   Source: `platform/src/lib/genbi/agentcore-client.ts:29-31` (configured), `:33-63` (invoke, `qualifier` at `:39`).
5. **runtimeSessionId derivation** — `<cap>-` + `sha256(conversationId).hex.slice(0,48)` = 54 characters (**≥ 33 and stable for the same conversation** → hits the same microVM session and reuses its context).
   Source: `platform/src/lib/genbi/memory.ts:37-40`.
6. **Memory dual-backend switch** — env `<CAP>_MEMORY_BACKEND=selfmanaged|agentcore` + `<CAP>_MEMORY_ID`; `isAgentCoreMemory()` decides between managed Memory (CreateEvent / ListEvents / RetrieveMemoryRecords) and self-managed (DynamoDB TTL + S3 summaries). actorId is the isolation key (GenBI uses projectId); namespace `/<cap>/{actorId}`.
   Source: `platform/src/lib/genbi/memory.ts:24-28` (switch), `:48-77` (self-managed short-term), `:138-201` (agentcore backend).
7. **Switch + fallback on failure (iron rule)** — env `<CAP>_BACKEND=agentcore && isAgentCoreConfigured()` decides whether it is enabled; once enabled, **try the Runtime → catch and fall back to in-process automatically** (never let a function that could work return 500); the `usedBackend` label **must reflect the real backend** (after a fallback it must be set back to `inprocess`).
   Source: `platform/src/app/api/genbi/ask/route.ts:34-35` (switch), `:49` (usedBackend), `:63-86` (try/catch fallback), `:126` (label persisted to history).
8. **The model always comes from `BEDROCK_MODEL_ID`** — no per-capability split of the model configuration; the Runtime container and the platform side read the same env (the default value is defined by `config.ts`).

## 4. Naming convention (including AWS constraint pitfalls)

| Resource | Pattern | GenBI instance (source) |
|---|---|---|
| Runtime | `bgp_<cap>_agent` | `bgp_genbi_agent` (`agentcore-stack.ts:201`) |
| Memory | `bgp_<cap>_memory` | `bgp_genbi_memory` (`:234`) |
| Gateway | `bgp-<cap>-gateway` | `bgp-genbi-gateway` (`:129`) |
| GatewayTarget | `<cap>skills` | `genbiskills` (`:156`) |
| ECR repository | `bgp-<cap>-agent` | `bgp-genbi-agent` (`:31`) |
| Skills Lambda | `bgp-<cap>-skills` | `bgp-genbi-skills` (`:39`) |
| The three roles | `bgp-<cap>-{gateway,runtime,memory}-role` | `bgp-genbi-*-role` (`:91` / `:102` / `:224`) |
| CDK stack | `Bgp<Cap>AgentCoreStack` (or follow the existing naming habit) | `BgpAgentCoreStack` |

> **⚠️ Underscore vs. hyphen pitfall (must remember)**: for the `Name` of **Runtime / Memory**, AWS **accepts underscores only** (no hyphens) → use `bgp_<cap>_agent` and `bgp_<cap>_memory`. All other resources (Gateway / ECR / Lambda / Role / stack) use **hyphens**. The two coexisting styles in GenBI are exactly the result of this constraint, not a typo.

## 5. Deployment orchestration (two passes + buildx)

**The chicken-and-egg problem**: the Runtime references an ECR image tag, but the image can only be pushed after the infrastructure (ECR) exists → **two deployment passes are mandatory, with the image push in between** (the file-header comment of `agentcore-stack.ts:1-8` fixes this order):

1. **Pass 1 (without the runtime context)**: create ECR + skills Lambda + Gateway + GatewayTarget + managed Memory + the three roles. The Runtime is gated by `!!this.node.tryGetContext("<cap>-runtime")` (`:194`) and is not created in this pass.
2. **Push the image**: take the CfnOutputs of pass 1 (ECR URI / MemoryId) → `docker buildx build --builder multiarch --platform linux/arm64 --provenance=false --sbom=false -t <ecr>:<tag> --push`; **tag = `git rev-parse --short HEAD`** (immutable).
   Source: `scripts/deploy-all.sh:44-58`.
3. **Pass 2 (`-c <cap>-runtime=1 -c <cap>-agent-tag=<sha>`)**: create the Runtime (referencing the image) + output the RuntimeArn. Source: `deploy-all.sh:60-62`; gate `agentcore-stack.ts:197-217`.
4. **The platform deployment injects the flags**: `-c <cap>-backend=agentcore -c <cap>-runtime-arn=<arn> -c <cap>-memory-backend=agentcore -c <cap>-memory-id=<id>`; a bare platform deployment (without this set of flags) still falls back to in-process (development profile / one-step rollback). Source: `deploy-all.sh:68-73`.

> - **🔴 buildx attestation pitfall (must observe)**: `docker buildx --push` produces an **OCI image index** by default (with an `unknown/unknown` attestation sub-manifest); when the AgentCore Runtime pulls by tag it may resolve to the index and **fail to create**.
> - **`--provenance=false --sbom=false` is mandatory** to obtain a single-platform arm64 image manifest.
>   The host is usually x86_64; use the `multiarch` buildx builder (QEMU-emulated arm64).
>   Details in the engineering notes of the GenBI AgentCore deployment (comment at `deploy-all.sh:53-56`).

**Chaining points (CfnOutput)**: pass 1 → image → pass 2 → platform are chained through stack outputs: `GenbiEcrRepoUri` (`:251`), `GenbiMemoryId` (`:248`), `GenbiRuntimeArn` (`:216`), `GenbiGatewayUrl` (`:252`). A new capability exports `<Cap>EcrRepoUri` and so on in the same way.

## 6. Reuse checklist (the copy-from baseline table)

When creating a new capability, copy from the GenBI blueprint and adjust according to the "nature of change":

| Blueprint file (GenBI) | New-capability counterpart | Reuse | Nature of change |
|---|---|---|---|
| `infra/agent/<cap>/mcp.js` | same name | **100%** | Copy as is (MCP + SigV4 are generic and business-independent) |
| `infra/agent/<cap>/Dockerfile` | same name | **100%** | Copy as is (ARM64 + Node 20 + `:8080`) |
| `infra/agent/<cap>/index.js` | same name | ~95% | Only change the `runAgent` input field names / validation; the HTTP contract stays |
| `infra/agent/<cap>/agent.js` | same name | **business change** | Replace the system prompt + tool definitions (`toolSpec`) + tool dispatch inside the loop |
| `infra/agent/<cap>/package.json` | same name | ~95% | Only change the package name |
| `platform/src/lib/<cap>/agentcore-client.ts` | same name | **~100%** | Change the env prefix (`<CAP>_RUNTIME_ARN`) + the Input / Output interface fields; the call skeleton stays |
| `platform/src/lib/<cap>/memory.ts` | same name | ~90% | Change the env prefix + namespace `/<cap>/{actorId}`; the dual-backend skeleton stays |
| `infra/lambda/<cap>-skills/*` | same name | **business change** | Replace the tool implementations (the capability's deterministic logic); the `toolNameOf` dispatch skeleton stays |
| `infra/lib/agentcore-stack.ts` | `<cap>-agentcore-stack.ts` | ~85% | Change resource names + tool InlinePayload definitions + Lambda IAM; the two-pass deployment gating skeleton stays |
| `platform/src/app/api/<cap>/*/route.ts` | the corresponding API | **business change** | Change the call parameters + the fallback branch; copy the switch / fallback / label skeleton as is |
| `scripts/deploy-all.sh` (section 3.5) | append a `<cap>` section | new | Copy the GenBI section and change the stack name / output keys / flag prefix |

**Overall principle**: **100% reuse of the protocol layer, rewrite the business layer**. Protocol layer = MCP / SigV4 / InvokeRuntime / sessionId / dual-backend skeleton; business layer = system prompt + tool definitions + skill implementation + resource naming.

## 7. General design constraints (solutions to the three hard problems, applicable to every capability)

The three real difficulties that GenBI and the network advisor ran into are abstracted into standard constraints:

- **① Stateless tools (the most critical)**: Lambda is stateless; multiple tools cannot share one large `state` the way they do in-process. The standard practice = **coarse-grained merged tools** — put the whole "probe → judge → produce" chain inside **a single Lambda invocation of a single tool**; the complete heavy data (such as the full SG rules or the full schema) lives only inside that invocation, and **only conclusions + summaries are returned to the model** (in line with GenBI's "tools self-check and are self-contained" philosophy). Expose finer-grained tools (such as `inspect_*`) only when fine orchestration is needed. A warm instance reuses its local cache (key = session + signature, short TTL); a miss across instances recomputes idempotently.
- **② Degradation safety net (must not be lost)**: the thin platform wrapper uses a **two-level try** — try the Runtime first; if the Runtime fails or times out → **fall back to the in-process implementation** (which, if it still contains a model call, has a deterministic safety net of its own). In other words the "in-process implementation" is both the fallback and the safety net: **one code base serves both purposes and is never deleted**. If the capability has "LLM availability" semantics, **mark the degradation honestly** with fields such as `llmAvailable:false`. (Corresponds to contract 7.)
- **③ Latency (real-time / interactive scenarios)**: the multi-hop `Runtime(HTTP) → Gateway(MCP) → Lambda` is slower than an in-process direct call. The standard practice = keep a **cheap read-only fast path** (purely deterministic, no Runtime / no LLM, the UI returns a preview within a second) + run the full reasoning asynchronously + **staged loading** + reuse the `conversationId` (Memory loads the history automatically).

## 8. The first standard implementation: the network advisor (overview)

The Network Connectivity Advisor (currently in-process at `platform/src/lib/network-advisor/`, three layers: L1 probing / L2 judgment / L3 Converse) is migrated according to this standard. **Migration mapping overview** (the details are in the overall plan and the network-advisor engineering notes — internal, not part of this repository — and are not expanded in this standard document):

| Current in-process | Moves to | Name |
|---|---|---|
| `advisor-agent.ts` + `prompt.ts` + `rules.ts` (rendering) | Runtime container `infra/agent/netadvisor/` | `bgp_netadvisor_agent` |
| **8 deterministic modules**: `environment-probe` / `target-resolver` / `connectivity-judge` / `rules` / `placement` / `remediation` / `prefill-adapters` / `cache` (all pure functions, zero Next coupling) | Skills Lambda `infra/lambda/netadvisor-skills/` | `bgp-netadvisor-skills` |
| `memory.ts` (DynamoDB multi-turn) | AgentCore Memory | `bgp_netadvisor_memory` |
| `index.ts` + `api/network-advisor/advise/route.ts` | Thin platform wrapper (**keeps the in-process implementation as the fallback**) | `bgp-netadvisor-gateway` |
| `types.ts` / `config.ts` | Shared library (referenced once each by the Runtime and the Lambda) | — |
| `NetworkAdvisorPanel.tsx` | **Unchanged** (the advise API signature is kept) | — |

> Note: there are in fact **8** deterministic modules (the early overall design listed 6; the actual inventory also includes `target-resolver` + `cache`). The network advisor is **permanently read-only** (a standing rule) — the skills only perform read-only probing such as `ec2:Describe*` / `rds:Describe*` / `redshift:Describe*` and never write to the network.

## 9. Checklist for landing a new capability (phased according to this standard)

For any AI capability going onto AgentCore, execute in order (each step points to the GenBI file to copy):

- **Phase 1 | Skills Lambda**: `infra/lambda/<cap>-skills/` (implement the capability's deterministic tools; stateless tools, section 7 ①) + an **independent ManagedPolicy** attached to the Lambda role (list every read-only API needed). The tool contract can be unit-tested locally. Copy from `infra/lambda/genbi-skills/`.
- **Phase 2 | Infrastructure stack**: `infra/lib/<cap>-agentcore-stack.ts` (ECR + Lambda + Gateway + GatewayTarget + Memory + the three roles). **Pass 1 deployment** (without the runtime context). Copy from `agentcore-stack.ts`.
- **Phase 3 | Runtime container**: `infra/agent/<cap>/` (`mcp.js` / `Dockerfile` copied as is, `agent.js` with the new prompt + tools). **buildx push of the image** (pitfall in section 5) → **pass 2 deployment** creates the Runtime. Copy from `infra/agent/genbi/`.
- **Phase 4 | Platform wrapper**: `platform/src/lib/<cap>/{agentcore-client,memory}.ts` + the fallback branch in the API route + the env switch. The platform deployment injects the flags. Copy from `platform/src/lib/genbi/` + `api/genbi/ask/route.ts`.
- **Phase 5 | Three-way verification**: see section 10. Passing verification = the standard has landed for that capability.

## 10. Red lines + cost + verification standard

**Red lines**:
- Only `--profile temp-account` (the test account; a standing rule).
- **buildx must use `--provenance=false --sbom=false`** (section 5; otherwise the Runtime pull fails).
- The probing IAM of the skills Lambda goes through an **independent ManagedPolicy** attached to the Lambda role and **never touches the platform TaskRole** (the TaskRole inline-policy 10 KB limit).
- Read-only capabilities of the network-advisor kind are **permanently read-only** (a standing rule).
- No push / commit without explicit approval; no real account ids / secrets in tracked files.
- When `cdk deploy` runs in the background, **always check the real state: CFN `*_COMPLETE` + ECS `rolloutState=COMPLETED`** (a wrapper exit code of 0 is a false success).

**Cost**: one more always-on Runtime (per-second billing, near zero when idle) + Memory (about $0.5 / month) + ECR storage (a few cents / month), the same order of magnitude as GenBI. This model has been accepted (on record; teardown is done manually).

**Verification standard (three-way agreement; missing any one of them does not count as success)**:
1. **AWS side**: the CFN stacks are `*_COMPLETE`; `list-agent-runtimes` shows the Runtime `READY`, `list-gateways` / `list-gateway-targets` show `READY`, `list-memories` shows the Memory `ACTIVE`; the Runtime log group `/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT` has events.
2. **Platform behavior**: the end-to-end call produces real results (headless-browser login → trigger the capability); after adding constraints in a follow-up turn, the recomputation takes effect.
3. **Hard evidence of the real switch-over**: with `<CAP>_BACKEND=agentcore`, the response / history carries the `backend=agentcore` label **and** the Runtime log has the event of that call. **Because of the in-process fallback, HTTP 200 ≠ the Runtime was used** — both the label and the log must be checked (a lesson from the GenBI deployment).
4. **Degradation verification**: temporarily set a wrong `<CAP>_RUNTIME_ARN` → the function still produces a deterministic result (`llmAvailable:false`), proving that the fallback works.
5. **Read-only verification** (for read-only capabilities): no write-operation API call at any point.

---

## 11. The exemplar holds (network advisor · phases 0–5 completed 2026-07-01)

The first standard implementation (the Network Connectivity Advisor) has been fully landed according to this standard and has passed three-way verification — **the standard holds**.

**Landing mapping (actual implementation, compared with the reuse checklist of section 6)**:
- Phase 1 | Skills Lambda: `platform/src/lib/network-advisor/skills-handler.ts` (**esbuild single source** — same directory and same source as the 8 in-process modules; the CDK NodejsFunction entry points to it, and the `@/` alias is resolved through the platform tsconfig);
  - stateless tools landed as 2 merged tools: `analyze_connectivity` (the whole chain probe → judge → remediate) + `inspect_security_group`.
  - Independent read-only ManagedPolicy `infra/lib/netadvisor-iam.ts` (15 actions, all Describe / Get / List).
- Phase 2 | Infrastructure stack: `infra/lib/netadvisor-agentcore-stack.ts` (copied from `agentcore-stack.ts`; the only structural difference = the Lambda is bundled with NodejsFunction esbuild instead of fromAsset).
- Phase 3 | Runtime container: `infra/agent/netadvisor/` (`mcp.js` / `Dockerfile` copied as is; `index.js` / `agent.js` carry the new business — the loop revolves around the 2 merged tools, and the rule text is synchronized from the single source of truth `rules.ts`).
- Phase 4 | Platform wrapper: `agentcore-client.ts` + dual-backend `memory.ts` + two-level try fallback in `index.ts` + env injection in `route.ts` / `platform-stack.ts`. **Approach A (decided)**: the Runtime is a self-contained capability service; the Lambda inside the container already makes the authoritative L2 judgment, and the thin platform wrapper only adds prefill / confidence / questions; on failure it falls back to the in-process `adviseInprocess` (kept as the safety net, one code base serving both purposes).

**Real resource ids (this account, us-east-1)**: Runtime `bgp_netadvisor_agent-<id>`, Memory `bgp_netadvisor_memory-<id>`, Gateway `bgp-netadvisor-gateway-<id>`, ECR `bgp-netadvisor-agent`, image tag = git short SHA.

**Three-way verification result (all five items of section 10 green)**: ① both CFN stacks `*_COMPLETE`, Runtime / Gateway / Target `READY`, Memory `ACTIVE`; ② the platform end to end returns reachable + a follow-up turn adding a least-privilege constraint recomputes correctly; ③ hard evidence of the real switch-over: `backend=agentcore` + a new Runtime log stream; ④ degradation: 4 unit tests prove that a Runtime error → fallback to in-process with an honest label; ⑤ read-only = the Lambda IAM is physically write-free. The network advisor has 35 unit tests passing in total; platform / infra tsc both exit 0.

**Additional lessons for the next capability**:
- **esbuild single-source bundling pitfall**: CDK local bundling runs `npx --no-install esbuild` in **the directory of the entry (platform)**, so esbuild must be installed in that directory's devDependencies (not only infra's); the `projectRoot` / `depsLockFilePath` of `NodejsFunction` must both point to platform, and `bundling.tsconfig` must point to the platform tsconfig to resolve `@/`; the node20 runtime externalizes `@aws-sdk/*` automatically, no manual entry needed.
- **The platform TaskRole already suffices**: AgentCore InvokeAgentRuntime + Memory ops are `resources:["*"]`; new capabilities reuse them and the TaskRole needs no change (no collision with the 10 KB limit).
- **Architectural verdict**: approach A (self-contained Runtime, thin platform wrapper) is the literal fulfilment of the standard — the Runtime produces the final conclusion and the tools are reusable across agents; avoid tearing a capability into "the Runtime produces intermediate state + the platform assembles" (it destroys the moat and leaks implementation details).

---

## Appendix: related notes and documents

- Overall plan: the approved plan of this round (6 major sections + phases 0–5 + three-way verification; an internal planning note, not part of this repository).
- Engineering notes (internal, not part of this repository): the platform-standard decision; the pioneer GenBI implementation (including the attestation pitfall and the three-way verification method); the details of the first exemplar, the network advisor; the permanent read-only rule of the network advisor; the TaskRole inline-policy 10 KB limit; full parameter parity with managed consoles.
- Pioneer implementation documents: AgentCore GenBI [design](./agentcore-genbi.md) / [adding skills](./agentcore-genbi-adding-skills.md) / [IaC schema](./agentcore-genbi-iac-schema.md).
