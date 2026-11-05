# Managed-service parameter advisor (the second AgentCore standard implementation)

> 📌 **Scope note (reconciled on 2026-10-13)**: this document was written during the single-region stage and records the design as it stood then (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is tracked in the module index of the engineering documentation; a path mentioned below that no longer exists means that the idea was not implemented as written here or has since been superseded.

> Status: **landed and passed three-way verification (2026-07-01)**. Account `<account-id>` / test-account profile `temp-account` / us-east-1.
> Lineage: the **second AI capability** created according to the platform standard [AI capabilities on Amazon Bedrock AgentCore](./agentcore-standard.md) (the first exemplar = the Network Connectivity Advisor). It copies the entire protocol layer and skeleton of the network advisor and writes only the business layer.
> Product positioning: the AI assistance layer that delivers on the product principle of full parameter parity with managed consoles — the platform exposes the console parameters of Glue / Flink / DMS **in full** (none missing, none hidden), and this advisor **assists with filling them in** on top of that (recommended value + reason + confidence + multi-turn refinement); it does not replace the parameters.

## 1. Capability overview

When a user fills in advanced parameters in the three kinds of forms (Glue workers / timeout, Flink parallelism, DMS / Redshift / Iceberg target parameters), the advisor:
1. **probes the run history** (read-only Glue GetJobRuns / MSAF DescribeApplication / DMS DescribeReplicationTasks) to obtain evidence;
2. runs a **deterministic heuristics engine** that computes the recommended values from the workload characteristics (data volume / table count / shard count / LOB / production grade / join columns …) — **the recommended value always comes from the engine; the model never invents values** (anti-hallucination, the same as the network advisor's "the verdict always comes from L2");
3. has the LLM generate the **plain-language explanation and trade-offs**, with multi-turn refinement ("about 200 GB" / "contains large fields" / "cost first" → translated into a workloadOverride and recomputed);
4. one-click prefill back into the form (prefill in the channel's native shape).

**Four parameter channels**: `glue-etl` (the ETL jobs page), `glue-sync` (the Glue channel of sync, including Iceberg + Redshift targets), `flink` (real-time compute, MSAF), `dms` (real-time sync; the replication instance class belongs to the infrastructure layer → display-level recommendation only, not part of prefill).

## 2. Landing mapping (against the reuse checklist in section 6 of the [standard](./agentcore-standard.md))

| Standard component | This implementation | Notes |
|---|---|---|
| Deterministic core | `platform/src/lib/param-advisor/{types,catalog,heuristics,history-probe}.ts` | catalog = the parameter catalog (single source of truth, aligned with the console creation pages); heuristics = the pure-function recommendation engine; history-probe = read-only probing |
| Skills Lambda | `skills-handler.ts` (esbuild single source, same directory as the deterministic core, zero drift) | 2 merged tools: `recommend_parameters` (the whole chain probe history → recommend → prefill) + `inspect_job_history` (dig into the details). EMF metrics BGP/ParamAdvisor |
| Lambda IAM | `infra/lib/paramadvisor-iam.ts` | Independent ManagedPolicy, 6 actions all Get / Describe, narrowed by a region condition, zero writes |
| Infrastructure stack | `infra/lib/paramadvisor-agentcore-stack.ts` | Copied from the netadvisor stack; two-pass deployment gated by `-c paramadvisor-runtime=1` |
| Runtime container | `infra/agent/paramadvisor/` | mcp.js / Dockerfile copied as is; agent.js with the new prompt + 2 tools (CATALOG_TEXT is synchronized manually with catalog.ts) |
| Platform wrapper | `lib/param-advisor/{agentcore-client,memory,index}.ts` + `api/param-advisor/{advise,recommend}/route.ts` | Approach A: self-contained Runtime; two-level try fallback to in-process; honest `backend` label; `recommendOnly()` = the zero-LLM fast path |
| Frontend | `components/param-advisor/ParamAdvisorPanel.tsx` embedded in three forms | etl-jobs (glue-etl, with jobRef = the name of an already created job) / realtime-compute (flink) / SyncTaskModal step 4 (glue-sync / dms); onPrefill writes back into each form's state |
| Memory | AgentCore Memory (`/paramadvisor/{actorId}`) + the self-managed fallback table `bgp-param-advisor-turns` | Dual-backend skeleton, the same as the network advisor |

**Real resource ids (this account, us-east-1)**: Runtime `bgp_paramadvisor_agent-<id>`, Memory `bgp_paramadvisor_memory-<id>`, Gateway `bgp-paramadvisor-gateway-<id>`, ECR `bgp-paramadvisor-agent`, image tag = git short SHA. The platform TaskDef carries the 4 PARAMADVISOR envs from `:13` on.

## 3. Quick reference of the recommendation engine rules (heuristics.ts; see the code comments for details)

- **Glue workers**: ≤ 20 GB → G.1X × ceil(GB/10) (minimum 2); ≤ 100 GB → G.1X × ceil(GB/15); > 100 GB → G.2X × ceil(GB/40) (capped at 20). The version is always 5.1 (a platform red line).
- **Glue timeout**: with ≥ 3 historical runs → P90 × 1.5 (basedOnHistory=true, confidence 0.9); without history, by data-volume tier.
- **Flink parallelism**: a Kinesis source is anchored 1:1 to the shard count; ≤ 4 shards → 2 subtasks per KPU to save cost; a MySQL CDC source is always 2 (the binlog is single-threaded). Autoscaling is enabled only for production grade.
- **Iceberg**: high-frequency writes → retain 3 days / 50 snapshots / compaction every 30 min; low frequency → 14 days / 100 / 240 min.
- **Redshift**: join columns present → KEY distribution + DISTKEY; a time column present → SORTKEY; otherwise AUTO.
- **DMS instance** (display level): LOB → c5.large; > 100 GB or > 20 tables → c5.large; > 30 GB or > 8 tables → t3.medium; otherwise t3.small.
- Missing key characteristics (data volume / shard count / LOB) → follow-up questions, and the overall confidence drops.

## 4. Three-way verification result (all five items of section 10 of the standard green, 2026-07-01)

1. **AWS side**: CFN `BgpParamAdvisorAgentCoreStack` CREATE_COMPLETE → UPDATE_COMPLETE; Runtime / Gateway / Target all READY; Memory ACTIVE; Lambda arm64; the image is a single-platform docker manifest (not an OCI index).
2. **Platform behavior**: logged-in end-to-end calls on all four channels (flink / glue-etl / glue-sync / dms) return 200 with real recommendations; a follow-up "cost first" refinement takes effect; probing a real Glue job through `jobRef` yields P90 / success-rate evidence; headless-browser verification of the panel rendering in the three forms + the recommendation table + one-click prefill.
3. **Hard evidence of the real switch-over**: the response carries `backend=agentcore` + the Runtime log group has an event at that moment + the managed Memory has session events (list-events = 2).
4. **Degradation**: 5 fallback unit tests (Runtime error → in-process with an honest label; Converse also down → `llmAvailable:false` deterministic text; a double safety net in total).
5. **Read-only**: an audit of every action on the Lambda role = 6 Get / Describe + basic logs permissions, physically zero writes.

45 unit tests in total (heuristics 27 + skills-handler 18; the sum includes 12 fallback tests); platform / infra tsc both exit 0.

## 5. Staged loading (section 7 ③ of the standard; both panels completed in the same round)

- New fast-path API `POST /api/param-advisor/recommend` (recommendOnly, zero LLM, returns within a second).
- `ParamAdvisorPanel` sends recommend + advise in parallel on the first question: the recommendation table appears first ("generating AI explanation…"), and the reasoning is filled in when advise returns. A race guard seqRef ensures the fast path never overwrites a complete result that has already arrived.
- `NetworkAdvisorPanel` gets the same treatment: the first question sends probe in parallel (L1 returns within a second), and an environment overview (N VPCs / subnets / targets) is shown while waiting. The advise API signature is unchanged.

## Appendix: related documents

- Platform standard: [AI capabilities on Amazon Bedrock AgentCore](./agentcore-standard.md) (the copy-from baseline)
- First exemplar: the Network Connectivity Advisor (`lib/network-advisor/`; details in the internal engineering notes)
- Product principle: full parameter parity with managed consoles (internal engineering notes)
