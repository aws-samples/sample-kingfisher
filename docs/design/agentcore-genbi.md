# AgentCore GenBI — Re-platforming Ask-Your-Data (GenBI) on Amazon Bedrock AgentCore

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written in the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. Multi-region behavior — place, execution scope, per-region scheduling and the like — is described in the [multi-region execution specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is tracked in the design index; a path mentioned below that no longer exists means that the idea was not implemented as described here or has since been superseded.

> - Status: **✅ implemented · deployed LIVE** (documentation audit calibration of 2026-08-26: the original status header was outdated — it read "design pending confirmation, 2026-06-15"). Account `<account-id>` / profile `temp-account` / us-east-1.
> - Goal: re-platform the existing GenBI (NL→SQL done in-process in the Next.js API by calling Bedrock Converse) onto **AWS Bedrock AgentCore**: the agent logic is deployed to the **AgentCore Runtime**, and the skills (querying Redshift / Athena / schema) are exposed as **MCP tools** through the **AgentCore Gateway**.

## 0. One-sentence conclusion
Keep the frontend and the request/response contract of `/api/genbi/ask` unchanged; move the "NL→SQL reasoning loop" into the AgentCore Runtime (a containerized agent) and the skills such as "execute SQL / inspect schema" into the AgentCore Gateway (MCP tools implemented as Lambda); the platform side remains responsible for authentication, workspace isolation, governance masking, injection of published tables, chart suggestion and history. A feature flag `GENBI_BACKEND=agentcore|inprocess` provides a one-step rollback.

## 1. AgentCore research findings (authoritative sources, GA 2025-10)
- **Components**: Runtime / Gateway / Memory / Identity / Observability / Browser / Code Interpreter / Policy / Evaluations. This design uses **Runtime + Gateway** (+ Identity, which is free through those two; Observability goes through CloudWatch).
- **Regions**: supported in us-east-1 (one of the 9 GA regions). Control plane `bedrock-agentcore-control`, data plane `bedrock-agentcore`.
- **Runtime contract**: ARM64 container, port 8080, `POST /invocations` + `GET /ping`, image in ECR.
  - Control plane `create_agent_runtime(agentRuntimeName, agentRuntimeArtifact.containerConfiguration.containerUri, networkConfiguration.networkMode=PUBLIC|VPC, roleArn, lifecycleConfiguration)`;
  - Data plane `invoke_agent_runtime(agentRuntimeArn, runtimeSessionId≥33 chars, payload, qualifier=DEFAULT)`.
  - Session isolation in microVMs, up to 8 h;
  - billed per second of active consumption, I/O wait is free.
- **Gateway**: turns Lambda / OpenAPI / Smithy / existing MCP servers into MCP tools; inbound authentication OAuth/JWT (Cognito can be used), outbound authentication IAM/OAuth. MCP protocol 2025-06-18 / 2025-03-26.
- **Framework-agnostic**: Strands / LangGraph / custom are all possible; there is a Python SDK and a **TypeScript SDK** (bedrock-agentcore) + the AgentCore CLI + a starter toolkit.
- **Pricing**: Runtime $0.0895/vCPU‑h + $0.00945/GB‑h (active time only, per second, I/O wait free, from 128 MB); Gateway $0.005 per thousand tool calls; Identity is free through Runtime/Gateway; Bedrock model tokens are billed separately (same as today). GenBI is low-frequency → the incremental infrastructure cost is tiny (active compute per question < $0.001 plus a handful of Gateway calls).

## 2. Feasibility probe (passed)
- `aws bedrock-agentcore-control list-agent-runtimes` → `{agentRuntimes:[]}`; `list-gateways` → `{items:[]}`.
- Conclusion: the `temp-account` profile / `WSParticipantRole` **can call the AgentCore control plane**, the CLI supports it, and the account has no pre-existing resources. The biggest uncertainty (whether the workshop account has the service enabled and the permissions) has been eliminated.

## 3. Inventory of the existing GenBI (what is being re-platformed)
- `lib/genbi/agent.ts`: Bedrock Converse loop + a single `run_sql` tool (by engine: redshift|athena). Two stages: ① introspect the schema (Redshift Data API / Athena information_schema) + `selectRelevantTables` (LLM re-ranking + OpenMetadata descriptions + weighting of published tables; on error, fall back to all tables); ② grounded SQL generation, looping on `run_sql` until `stopReason!=tool_use` or `maxIters`.
- Skills: `redshift.runSelect` (ExecuteStatement→poll→GetStatementResult + the admin SecretArn + the read-only guard `sanitizeSelect`), `schema.introspectSchema`, `athena.introspectS3Tables/runSelectAthena`.
- `api/genbi/ask`: inject `listPublishedDatasets` (published tables) → `runGenBiAgent` → `maskRows` (governance masking; admin / authorized users exempt) → `parseSqlLineage` for the tables hit → `suggestChart` → `recordGenBiHistory`. Authentication goes through the middleware (Cognito); workspace isolation through `x-bgp-project`.
- Key point: the skills use only the Redshift Data API and Athena (public AWS APIs) → the Runtime can run with `networkMode=PUBLIC`, **no VPC connection to Redshift is needed**, which greatly simplifies networking.

## 4. Target architecture

```
Browser ──HTTPS──► CloudFront ──► ECS (Next.js)
  /genbi page (unchanged)   │  /api/genbi/ask (thin orchestration; keeps authentication / workspace isolation / masking / published tables / chart suggestion / history)
                            │     │ invoke_agent_runtime(IAM, payload={prompt,engine,db,published,...})
                            ▼     ▼
                 ┌───────────────────────────────────────┐
                 │ AgentCore Runtime (ARM64 container)   │  ← NL→SQL reasoning loop (Converse)
                 │  /invocations  /ping  :8080           │     two stages: retrieve and select tables → generate and execute SQL
                 └───────────────┬───────────────────────┘
                                 │ MCP (tool discovery / invocation, inbound OAuth/JWT)
                                 ▼
                 ┌───────────────────────────────────────┐
                 │ AgentCore Gateway (MCP endpoint)      │  ← skills catalog
                 │  tools: run_redshift_sql /            │     outbound IAM to invoke Lambda
                 │         run_athena_sql /              │
                 │         introspect_redshift_schema/   │
                 │         introspect_s3tables_schema    │
                 └───────────────┬───────────────────────┘
                                 │ outbound IAM
                                 ▼
                 Lambda (skill implementations) ──► Redshift Data API / Athena (public AWS APIs)
```

## 5. Division of component responsibilities

| Concern | Where it lives | Rationale |
|---|---|---|
| NL→SQL reasoning loop, table selection, prompts | **Runtime agent** | AgentCore hosts the reasoning and isolates sessions; reuses the existing TypeScript logic |
| Executing SQL / inspecting the schema (skills) | **Gateway MCP tools (Lambda)** | Matches the stated requirement that "skills live on the gateway"; read-only, independently governable and rate-limitable |
| Authentication (Cognito), workspace isolation (x-bgp-project) | **Platform `/api/genbi/ask`** | Depends on the Cognito identity + the middleware allow-list; enforced at the edge |
| Governance masking `maskRows`, published-table injection, chart suggestion, history | **Platform `/api/genbi/ask`** | Depends on DynamoDB (classification / authorization / published tables / history) + the caller's identity; keeps the agent stateless and portable |
| Model (Claude Opus, Converse) | Inside the Runtime agent | Same model as today; token billing unchanged |

> Design trade-off: keep "governance masking / published tables / history / authentication" on the platform side; the agent only returns {answer, sql, columns, rows, steps, usage}. Benefits: the agent is stateless and portable and touches neither DynamoDB nor user identity; masking is applied after the result returns to the platform, according to the caller's identity (exactly as today — zero regression).

## 6. Data flow (one question)
1. The frontend POSTs `/api/genbi/ask {question, engine, workgroupName, database}` (contract unchanged).
2. The platform middleware validates Cognito; the route runs `resolveIdentity` + reads `x-bgp-project` + `listPublishedDatasets` (published tables).
3. The platform calls `invoke_agent_runtime(arn, sessionId, payload={input:{prompt:question, engine, database, published, modelRows, maxRows}})`.
4. The Runtime agent: introspect (through Gateway tools) → select tables → Converse loop; every tool call goes through the Gateway MCP `run_*_sql`/`introspect_*`; returns {answer, sql, columns, rows, steps, usage}.
5. On receipt the platform runs `maskRows` (masking) → `parseSqlLineage` (tables hit) → `suggestChart` → `recordGenBiHistory`; the result goes back to the frontend in the existing `GenBiResult` shape.

## 7. Key design decisions (with options; ★ = recommended)

### D1 Agent language / framework
- ★ **A. Custom TypeScript agent**: move the existing `agent.ts/prompt.ts/retrieval.ts` almost unchanged into an ARM64 container, implement `/invocations`+`/ping` with a minimal HTTP server, and keep using `@aws-sdk/client-bedrock-runtime` Converse inside. **Maximizes reuse of proven logic, lowest risk, consistent with the Node/TypeScript code base**.
- B. Python + Strands Agents (the officially promoted path): the whole agent / retrieval / guard / prompt stack would have to be rewritten in Python — a large effort that drifts from the existing TypeScript logic.

### D2 Where the skills live
- ★ **1. Gateway MCP tools (Lambda implementation)**: `run_redshift_sql`/`run_athena_sql`/`introspect_*` are each hosted by a Lambda; the Runtime agent discovers and invokes them through the Gateway MCP. **Matches the explicit requirement that "skills live on the gateway"**; skills can be rate-limited / governed / reused independently.
- 2. Tools built into the Runtime container (the agent calls the Data API / Athena directly), no Gateway: simpler, but does not meet the "on the gateway" requirement.

### D3 IaC approach (this project's aws-cdk-lib ^2.170 may not have AgentCore L1 constructs)
- ★ **b. CDK CfnResource escape hatch**: create `BgpAgentCoreStack` using the raw CloudFormation resources `AWS::BedrockAgentCore::Gateway / GatewayTarget / Runtime / RuntimeEndpoint`; the skill Lambdas, IAM roles and ECR use ordinary CDK constructs. No CDK upgrade needed (the currently supported CDK version is listed in [supported versions](../supported-versions.md)).
- a. Upgrade aws-cdk-lib to a 2026 release containing the `aws-bedrockagentcore` L1: ripples through 11 stacks, high risk.
- c. Out-of-band scripts (boto3 / CLI `create-gateway/create-gateway-target/create-agent-runtime`) checked into the repository under `scripts/` (like the Cognito bootstrap): avoids the CDK risk but is not pure IaC.

> During implementation, verify b first (synth and deploy a minimal Gateway); if the CloudFormation resource types are unstable in this account, fall back to c.

### D4 Authentication
- Platform → Runtime: **SDK `invoke_agent_runtime` + IAM** (ECS TaskRole), no OAuth, simplest.
- Runtime agent → Gateway: the Gateway's inbound side requires OAuth/JWT. Use **Cognito M2M (client credentials)** or an **AgentCore Identity workload identity**; outbound Gateway→Lambda uses IAM.
- The platform middleware's Cognito authentication and analyst allow-list for `/api/genbi/*` are **unchanged**.

### D5 Network
- The skills use only the Redshift Data API and Athena (public AWS service endpoints) → Runtime `networkMode=PUBLIC`, and the Lambdas need not be placed in a VPC. **No VPC / PrivateLink connection to Redshift is needed**, a significant simplification.

### D6 Container image build / deployment
- Reuse the platform's existing Docker + ECR flow; add an ECR repository `bgp-genbi-agent`, build and push with `docker buildx --platform linux/arm64`; `create_agent_runtime` references the image.

## 8. Gateway skills (MCP tools) inventory

| Tool name | Input | Behavior | Reuses existing |
|---|---|---|---|
| `run_redshift_sql` | `{sql}` | Read-only guard (`sanitizeSelect`) → execute via the Redshift Data API → {columns, rows, rowCount} | `lib/genbi/redshift.ts` + `sql-guard.ts` |
| `run_athena_sql` | `{sql}` | Read-only guard → execute on Athena → {columns, rows} | `lib/genbi/athena.ts` + `lib/athena/*` |
| `introspect_redshift_schema` | `{}` | pg_tables/information_schema → table / column catalog | `lib/genbi/schema.ts` |
| `introspect_s3tables_schema` | `{}` | Athena information_schema → tables / columns of the namespace | `lib/genbi/athena.ts` |

- All **read-only**; run_* still goes through `sanitizeSelect` (a single SELECT/WITH statement + forbidden write keywords + a hard row cap). The Lambda uses the admin Redshift SecretArn (same as the platform).

## 9. Migration and rollback
- Feature flag `GENBI_BACKEND` (env): `agentcore` (new) / `inprocess` (old, default). `/api/genbi/ask` chooses the backend accordingly.
- Staged rollout: start with `inprocess` as the safety net, switch to `agentcore` once connectivity is proven; if anything goes wrong, change the env back and you have rolled back (no code rollback needed).
- The frontend `/genbi` page and the `GenBiResult` contract are **completely unchanged**.
- The old in-process `lib/genbi/*` path is retained (the skill Lambdas and the agent container reuse the same TypeScript logic, avoiding drift between two implementations).

## 10. Cost (incremental; GenBI is a low-frequency internal scenario)
- Runtime: per-second active CPU / memory per question, typically < $0.001 per question; I/O wait (waiting for the model / the database) is free.
- Gateway: a few tool calls per question, $0.005 per thousand → negligible.
- Identity: free through Runtime/Gateway. Observability: CloudWatch volume is tiny, close to 0.
- Bedrock model tokens: same as today (no increase, no decrease). ECR image storage: a few cents per month.
- Conclusion: **the incremental infrastructure cost is negligible**; the main cost remains model tokens.

## 11. Risks and mitigations
- The CloudFormation resource types / CDK escape hatch are unstable in this account → verify first with a minimal Gateway synth and deployment; fall back to out-of-band scripts (D3).
- Configuring the Gateway's inbound OAuth is complex → if the Cognito M2M setup is blocked, first get end to end working with "skills built into the Runtime" (D2 option 2), then iterate to add the Gateway; but satisfying the "on the gateway" requirement takes priority.
- Temporary-account credential expiry / AgentCore quotas → follow the existing renewal convention; the probe has already confirmed that the basics work.
- The container build needs ARM64 buildx → supported by Docker on the development machine; CI uses buildx.
- End-to-end latency (Runtime cold start + the MCP hop) → the CloudFront origin read timeout is already 60 s; Runtime session reuse reduces cold starts; tune the lifecycle if necessary.

## 12. Implementation steps (to be executed after confirmation)
1. **Minimal verification**: create a minimal Gateway + one Lambda target with CfnResource, synth and deploy, and confirm that D3 is feasible (otherwise fall back to scripts).
2. **Infrastructure** (`BgpAgentCoreStack`): ECR repository, skill Lambdas (run_redshift_sql/run_athena_sql/introspect_*), Gateway + GatewayTarget, Runtime + RuntimeEndpoint, IAM roles (Runtime role / Gateway egress role / Lambda role), and `bedrock-agentcore:InvokeAgentRuntime` added to the platform TaskRole.
3. **Agent container**: custom TypeScript agent (reusing agent/prompt/retrieval), `/invocations`+`/ping`, tools invoked through the Gateway MCP; buildx ARM64 and push to ECR; create_agent_runtime.
4. **Platform integration**: `lib/genbi/agentcore-client.ts` (invoke_agent_runtime); `/api/genbi/ask` routes by `GENBI_BACKEND`; masking / published tables / chart suggestion / history / authentication retained.
5. **Testing**: headless Playwright (both the Redshift and the Athena engine, published tables, masking, tables hit), with results aligned against the old backend.
6. **Deploy + release**: deploy with `-c openmetadata-url`; update VERSION, CHANGELOG and the project status document, tag and push.

## 13. Open decisions to confirm (before implementation)
- [ ] D1: should the agent be a **custom TypeScript** agent (recommended) or Python + Strands?
- [ ] D2: should the skills live on the **Gateway** (already favored, recommended) or be built into the Runtime first to get things working?
- [ ] D3: IaC via **CDK CfnResource** (recommended) or out-of-band scripts?
- [ ] Keep the old `inprocess` backend as a rollback (recommended: keep)?
- [ ] Scope: does this iteration include Memory (multi-turn memory) and an Observability dashboard? (Recommendation: not in this iteration; get Runtime + Gateway working first.)

## 14. Conversation storage (short-term + long-term) — newly added requirement

### Requirement
- **Short-term storage (temporary)**: keep the "current conversation context" — in a multi-turn session, remember the question-and-answer history of this session so that follow-up questions can build on earlier ones.
- **Long-term storage (permanent)**: **summarize** what was discussed before and **store it in S3**, retrievable and reusable across sessions.

### Approach (decision; ★ = recommended)
Adopt the combination "**platform orchestration + AgentCore session isolation + self-built S3 long-term memory**", without depending on AgentCore managed Memory (because the requirement explicitly calls for the data to land in the account's own S3, where it is controllable, governable and transparently billed):

**Short-term (session-level context)**
- Introduce a `conversationId` (one per conversation on the frontend; the existing genbi history can be reused). The platform calls `invoke_agent_runtime` with a stable `runtimeSessionId = hash(conversationId)` (≥33 characters) → the same conversation hits **the same microVM session**, and AgentCore reuses the context natively.
- At the same time the platform records each turn's {question, answer, sql} for the most recent N turns in **DynamoDB `bgp-genbi-turns`** (pk=conversationId, sk=ts) as reliable short-term memory, and passes a summary of the most recent N turns in the payload when invoking the agent (guarding against session expiry / cross-instance calls). The short-term TTL (for example 24 h) expires entries automatically.

**Long-term (summarize → S3)**
- Add an **S3 prefix `s3://bgp-datalake-<account-id>/genbi-memory/<projectId>/<conversationId>.json`** for long-term memory entries.
- Trigger: when a conversation ends or reaches M turns, the platform uses Bedrock to generate a **structured summary** of the conversation (the definitions the user cares about, frequently used tables, key conclusions) and writes it to S3 (fire-and-forget).
- Retrieval: when a new question arrives, fetch the relevant historical summaries by projectId (simple most-recent / keyword matching first; OpenSearch k-NN can be added later — the infrastructure already exists) and inject them into the agent prompt as "long-term memory".
- Governance: S3 memory is isolated by projectId prefix; only summaries are stored (no sensitive detail rows); a lifecycle policy can be set.

### Integration points
- `lib/genbi/memory.ts` (new): `loadShortTerm(conversationId)` / `appendTurn(...)` / `summarizeToS3(conversationId)` / `loadLongTerm(projectId, question)`.
- `/api/genbi/ask`: accepts `conversationId`; injects short-term + long-term memory before invoking the agent; after the call, `appendTurn` + trigger the long-term summary.
- The agent payload gains `history` (short-term) and `memory` (long-term summary) fields; the agent system prompt gains a "refer to the conversation context / historical memory" section.
- Frontend `/genbi`: maintains / generates the `conversationId` (localStorage or a "new conversation" button); optionally shows "memory loaded".

### Cost / scope
- DynamoDB short-term table + S3 summaries: tiny volume. Long-term summarization costs extra Bedrock tokens (one summary per conversation, negligible).
- This iteration implements short-term (DynamoDB + session reuse) + long-term (writing S3 summaries and injecting the most recent summaries); k-NN semantic retrieval is left as a later enhancement.
