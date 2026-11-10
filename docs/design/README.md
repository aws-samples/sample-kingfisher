# Design documents (docs/design)

> - This page is navigation only: one line per module saying what it is, what state it is in and which document to read. The implementation is defined by the code; what every module does today is in [`docs/modules.md`](../modules.md); the index written for AI tools is [`AGENTS.md`](../../AGENTS.md)
>   at the repository root.
> - Status legend: ✅ implemented and in use in the multi-region version · ✅🕰 implemented in the single-region stage, design document not updated since (multi-region behaviour is defined by the multi-region execution design and the code) · 🆕 design written, implementation planned.
>
> In the engineering repository every module lives in a numbered directory with one or more design documents; in this repository each document is published as one file named by topic, and the Chinese originals are translated in full. Acceptance criteria, work-package lists, roadmaps, research notes and review records are engineering-process documents and are not published here.

## Multi-region version (current architecture)

| Module | Covers | Status | Documents |
|---|---|---|---|
| Multi-region execution | One control plane × N data planes: execution-environment lifecycle, first-class place, per-region scheduling, zero egress, jurisdictions, cross-region overview, cost by region | ✅ released in 2.0.0 / 2.0.1 | [`multi-region-execution.md`](multi-region-execution.md) (overview with figures) · [`multi-region-execution-design.md`](multi-region-execution-design.md) (architecture) · [`multi-region-execution-spec.md`](multi-region-execution-spec.md) (contract) · [`multi-region-execution-interaction.md`](multi-region-execution-interaction.md) (interaction design) |
| Runtime-configurable models | System Settings → "AI model": three-layer resolution, probe gate, rate limiting, invalidation banner; revision 2.0 adds the multi-vendor model channel (GLM 5 / Kimi K3, 2026-10-14) | ✅ · the multi-vendor channel was released on 2026-10-27 | [`model-configuration.md`](model-configuration.md) · [`model-configuration-spec.md`](model-configuration-spec.md) · [`model-configuration-interaction.md`](model-configuration-interaction.md) |
| Workspace isolation and copy | Independent credentials per workspace and per region, pre-checks before deleting a workspace, cross-workspace sharing / copy | ✅ | [`project-isolation.md`](project-isolation.md) · [`project-isolation-spec.md`](project-isolation-spec.md) · [`project-isolation-interaction.md`](project-isolation-interaction.md) |
| Operation guide | Interactive onboarding tour, a ❓ help panel on every page, role-based getting started | ✅ | [`operation-guide.md`](operation-guide.md) |
| Ask-Your-Data session cards | Save / resume / scheduled refresh, at most 100 cards per user | ✅ | [`genbi-session-cards.md`](genbi-session-cards.md) |
| Long-running-operation framework | The single primitive and gate behind "a request that has not settled after 45 s turns into 202 and the global fetch interceptor polls"; one cure for the four incidents of the same disease (column sync, workspace deletion, model-calling routes, modeling landing); includes the partial refresh of the modeling page | ✅ first batch of 15 kinds, second batch of 14 kinds and two further kinds implemented and released from 2026-10-27 onward | [`long-running-operations.md`](long-running-operations.md) (five documents in one) |
| Execution role binding | Four kinds of task (offline Glue / EMR, sync, real-time) can bind any IAM role in the account that the service may assume (as in AWS); three-group picker + in-page refresh + manual ARN fallback; save-time preflight measures the external buckets a job references | ✅ revision 1.2 (2026-11-03), verified by headless-browser acceptance in a test account; ships with 2.2.0 | [`execution-role-binding.md`](execution-role-binding.md) (requirements + design in one) |
| Offline job node in workflow orchestration | A new `job` node references an offline job (Glue / Redshift) or an EMR job and chains freely with data-sync nodes; execution = the same core as the job's "Run now" (per-region job name / job lock / business date / run-row write-back); both carriers (serverless YAML + classic runtime library) are published completely; publish-time place is fail-closed (the sync node is fixed in the same change); backfill; delete guard for referenced jobs | 🆕 design revision 1.0 (2026-11-03), implementation planned for 2.2.0 | [`workflow-job-node.md`](workflow-job-node.md) (requirements + design in one) |
| Lake table-bucket routing | Lake route table (alias / tier / namespace ownership / writable; no new table); a job declares several buckets ⇒ one Spark catalog per bucket is registered automatically plus a default catalog; preflight measures `s3tables` per bucket; home-region EMR / Flink roles are allowed on any bucket in the region; the whole read side follows the routes and never falls back | 🆕 revision 1.0-en (2026-11-03) authoritative design; core routing and read side planned for 2.2.0, the governance phase for the release after | [`lake-bucket-routing.md`](lake-bucket-routing.md) (requirements + design in one) |

## Capability modules (designed in the single-region stage, carried into the multi-region version)

| Module | Covers | Status | Documents |
|---|---|---|---|
| OpenMetadata ingestion | Catalog / lineage / profiler ingestion into OpenMetadata | ✅🕰 | [`openmetadata-ingestion.md`](openmetadata-ingestion.md) |
| GenBI | Natural-language analytics foundation | ✅🕰 (the current line is AgentCore GenBI / GenBI engine unification / session cards) | [`genbi.md`](genbi.md) |
| Offline jobs | Glue / EMR / Redshift jobs | ✅🕰 | [`etl-jobs.md`](etl-jobs.md) |
| Multi-tenancy RBAC | Workspaces and roles | ✅ (read together with workspace isolation) | [`multitenancy-rbac.md`](multitenancy-rbac.md) |
| Versioning and rollback | Resource versions | ✅🕰 | [`versioning-rollback.md`](versioning-rollback.md) |
| Multi-environment release | Release / promotion | ✅🕰 | [`multi-environment-release.md`](multi-environment-release.md) |
| Job run parameters | Date variables and the like (unified in 2026-10 into a single author of 15 keys) | ✅🕰 | [`etl-run-parameters.md`](etl-run-parameters.md) |
| SQL lineage and impact | Table- and column-level lineage | ✅🕰 | [`sql-lineage-impact.md`](sql-lineage-impact.md) |
| Classification and masking | Sensitive-data classification, masking | ✅🕰 | [`classification-masking.md`](classification-masking.md) |
| Quality rules / scoring / SLA | Quality checks really run per region, SLA | ✅ | [`quality-rules-scoring-sla.md`](quality-rules-scoring-sla.md) |
| Metrics store | Metrics and their values | ✅ | [`metrics-store.md`](metrics-store.md) |
| GenBI requirement pipeline · semantic retrieval | Requirements workbench, semantic retrieval | ✅🕰 | [`genbi-requirement-pipeline.md`](genbi-requirement-pipeline.md) · [`genbi-semantic-retrieval.md`](genbi-semantic-retrieval.md) |
| Athena / S3 Tables | Direct lake query (federated catalog) | ✅🕰 | [`athena-s3tables.md`](athena-s3tables.md) |
| DevOps-agent diagnostics | AI analysis of run logs | ✅🕰 | [`devops-agent-diagnostics.md`](devops-agent-diagnostics.md) |
| AgentCore GenBI | Ask-Your-Data running on Bedrock AgentCore (including adding skills and the IaC schema) | ✅ | [`agentcore-genbi.md`](agentcore-genbi.md) · [`agentcore-genbi-adding-skills.md`](agentcore-genbi-adding-skills.md) · [`agentcore-genbi-iac-schema.md`](agentcore-genbi-iac-schema.md) |
| Production hardening | Security / observability / passwords | ✅🕰 (the multi-region production rules are in the [deployment guide](../deployment.md), sections 6 / 8) | [`production-hardening.md`](production-hardening.md) |
| AgentCore standard | Agent base class / deployment standard | ✅🕰 | [`agentcore-standard.md`](agentcore-standard.md) |
| Parameter advisor | Agent that recommends job parameters | ✅🕰 | [`param-advisor.md`](param-advisor.md) |
| Real-time CDC | DMS (including the DMS Serverless study) | ✅🕰 | [`realtime-cdc.md`](realtime-cdc.md) · [`realtime-cdc-dms-serverless.md`](realtime-cdc-dms-serverless.md) |
| Real-time compute | Managed Flink SQL, the S3 Tables connector, tri-engine verification | ✅🕰 | [`realtime-compute.md`](realtime-compute.md) · [`realtime-compute-connector-runtime-modular.md`](realtime-compute-connector-runtime-modular.md) · [`realtime-compute-flink-s3tables-412-root-fix.md`](realtime-compute-flink-s3tables-412-root-fix.md) · [`realtime-compute-tri-engine-s3tables-verification.md`](realtime-compute-tri-engine-s3tables-verification.md) |
| Multi-engine nodes | Workflow node types (including rich nodes) | ✅ | [`multi-engine-nodes.md`](multi-engine-nodes.md) · [`multi-engine-nodes-rich-nodes.md`](multi-engine-nodes-rich-nodes.md) |
| Intelligent operations and alerting | Alert rules / channels / operations wall | ✅🕰 | [`intelligent-ops-alerting.md`](intelligent-ops-alerting.md) |
| Data modeling | Layers / data domains / standard code tables / dimensions and facts (multi-region: code and dimension tables can land in non-home regions) | ✅🕰 | [`data-modeling.md`](data-modeling.md) |
| Governance deepening | Governance workbench | ✅🕰 | [`governance-deepening.md`](governance-deepening.md) |
| BI report builder | BI reports / dashboards (the early revision 2–4 drafts are archived) | ✅ | [`bi-report-dashboard.md`](bi-report-dashboard.md) |
| GenBI asynchronous execution | 202 + polling | ✅ | [`genbi-async-execution.md`](genbi-async-execution.md) |
| Metrics consolidation | One definition per metric | ✅ | [`metrics-consolidation.md`](metrics-consolidation.md) |
| FinOps | Cost governance (multi-region: attribution by region) | ✅ | [`finops.md`](finops.md) |
| Data-source ecosystem | Data-source SPI, multiple sources (JDBC / S3 / DynamoDB / streams) | ✅🕰 | [`datasource-ecosystem.md`](datasource-ecosystem.md) |
| Agent-native operations | A: incident memory · B: baselines / SLA · C: backfill center (an overview plus three design documents) | ✅ | [`agent-native-operations.md`](agent-native-operations.md) · [`agent-native-operations-incident-memory.md`](agent-native-operations-incident-memory.md) · [`agent-native-operations-baseline-sla.md`](agent-native-operations-baseline-sla.md) · [`agent-native-operations-backfill.md`](agent-native-operations-backfill.md) |
| Unified Copilot | Plan center (the "plan only, never execute" guardrail), endpoint inventory, plan-execute design | ✅ | [`unified-copilot.md`](unified-copilot.md) · [`unified-copilot-endpoint-inventory.md`](unified-copilot-endpoint-inventory.md) · [`unified-copilot-plan-execute.md`](unified-copilot-plan-execute.md) |
| Engine cookbook | Recipes for generating job scripts | ✅ | [`engine-cookbook.md`](engine-cookbook.md) · [`engine-cookbook-genbi-remote-guard.md`](engine-cookbook-genbi-remote-guard.md) |
| GenBI engine unification | The Ask-Your-Data engine and its staged plan | ✅ | [`genbi-engine-unification.md`](genbi-engine-unification.md) · [`genbi-engine-unification-architecture.md`](genbi-engine-unification-architecture.md) · [`genbi-engine-unification-implementation-plan.md`](genbi-engine-unification-implementation-plan.md) · [`genbi-engine-unification-stage1-code-design.md`](genbi-engine-unification-stage1-code-design.md) · [`genbi-engine-unification-stage2-code-design.md`](genbi-engine-unification-stage2-code-design.md) · [`genbi-engine-unification-stage3-code-design.md`](genbi-engine-unification-stage3-code-design.md) · [`genbi-engine-unification-stage3-execution.md`](genbi-engine-unification-stage3-execution.md) · [`genbi-engine-unification-stage4-design.md`](genbi-engine-unification-stage4-design.md) |
| Strands platform unification | The agent framework layer and its three agents | ✅🕰 | [`strands-platform-unification.md`](strands-platform-unification.md) · [`strands-platform-unification-framework-layer.md`](strands-platform-unification-framework-layer.md) · [`strands-platform-unification-param-advisor.md`](strands-platform-unification-param-advisor.md) · [`strands-platform-unification-network-advisor.md`](strands-platform-unification-network-advisor.md) · [`strands-platform-unification-copilot.md`](strands-platform-unification-copilot.md) |

The retired data service (`/api/public/data/*` returns 410 Gone) and the 2026-07 feature cards are historical and are not published.

## Conventions for a new module

A new module gets at least one design document (feature overview / user stories / interaction / API / data model / implementation / AWS dependencies / security / acceptance); a feature that touches several regions must state its place and execution scope; when the design lands, its status on this page is updated.
