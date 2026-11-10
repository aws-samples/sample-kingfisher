# Big Data Governance Platform — 2-Hour Lecture Edition (High-Density Crib Sheet)

> 🔴 **Scope note (2026-10-13)**: this document is the lecture-notes projection of `deep-dive.md`; like it, it was written in the single-region stage and covers only the components inside the home region.
> For the multi-region architecture, see [`architecture.md`](architecture.md) and the multi-region execution design note [`design/multi-region-execution.md`](design/multi-region-execution.md).

> - **Purpose**: the **on-stage lecture notes** for a 2-hour sharing session with an AWS architect team — for every section, "must-say points + key numbers / APIs + which figure to show + frequent Q&A + source-code anchors".
> - **Depth and source code live in the full manuscript [`deep-dive.md`](deep-dive.md)** (§15 is source-level); this document is its condensed projection and **does not repeat the detail — it only says "what to talk about, how to answer, where to look"**.
>
> **Last updated: 2026-08-02 · Corresponding platform progress: every feature module delivered up to that date (from data integration through the unified Copilot, Engine Cookbook and the Strands framework)**.
>
> Honesty legend: 🟢 runs for real in production / 🔵 code landed, not yet proven in a real environment / 🔒 intentionally left blank.
>
> Priority order: **GenAI ≈ GenBI ≈ AgentCore ≈ observability > big data > everything else**. 🔒 No real account ids / ARNs / URLs / ids (placeholders only).

---

## 1. The 2-Hour Agenda

| Time (min) | Topic | Card | Full manuscript |
|---|---|---|---|
| 0–10 | What the platform is / big-picture architecture / data flow | Card 1 | §1–§2 |
| 10–20 | GenAI capability map (7 user-visible AI capabilities + 3 enabling layers) | Card 2 | §3 |
| 20–45 | **GenBI Ask-Your-Data** (NL→SQL) | Card 3 | §4 / §15.1–15.5 |
| 45–75 | **AgentCore** (Runtime + Gateway + MCP) | Card 4 | §5 / §15.6–15.8 |
| 75–90 | **Context and memory** (dual backend / triggers) | Card 5 | §6 / §15.9 |
| 90–105 | **DevOps Agent diagnosis + observability** | Card 6 | §7–§8 / §15.10–15.11 |
| 105–115 | Big-data foundation (sync / ETL / scheduling / lineage) | Card 7 | §10 / §15.13 |
| 115–120 | Security / IAM / evolvability / Q&A | Card 8 | §12–§13 / §15.12, 15.14 |

---

## 2. One-Page Summary (memorizable in the 3-minute opening)

- **In one sentence**: a one-stop big-data development and governance platform — data ingestion → sync → ETL development and orchestration → scheduling → governance (catalog / lineage / classification / quality)
  → metrics → **Ask-Your-Data** → monitoring / **AI diagnosis**, all converged into a single web platform.
- **Form factor**: a Next.js 14 full-stack application (the version as of this document's date; current versions are listed in [`supported-versions.md`](supported-versions.md)) on **ECS Fargate**;
  all infrastructure in **CDK (TypeScript)**, **21 stacks (17 always-on + 4 context-gated switches)**; everything underneath is **AWS managed services**; governance uses a **self-hosted OpenMetadata**.
- **Data mainline**: source MySQL ─ Glue (full load / incremental watermark) → **S3 Tables (Iceberg)** + **Redshift Serverless**; **MWAA** for scheduling; **Athena** to query the lake;
  control-plane metadata in **DynamoDB** (61 tables).
- **7 user-visible AI capabilities (one shared kernel = Bedrock Converse + Claude Opus + Strands assembly)**: ① GenBI NL→SQL (a tool-use loop with two internal touchpoints — semantic retrieval and long-term memory)
  ② network connectivity advisor ③ parameter advisor ④ DevOps Agent failure diagnosis (`aidevops` managed SRE + memory augmentation) ⑤ AI code generation (requirements / ETL / engines) ⑥ Flink SQL AI generation
  ⑦ unified platform Copilot (may create, never executes).
  - **Plus 3 enabling layers**: AgentCore as the platform standard / Engine Cookbook (a zero-LLM recipe library) / the unified Strands framework.
- **Key numbers**: inference loop `maxIters=8` / `maxTokens=2200` / `50` rows returned to the model / hard cap `200` rows; short-term memory injects the most recent `6` turns;
  self-managed long-term memory summarizes every `6` turns; `runtimeSessionId` ≥ `33` characters; diagnosis is asynchronous (> CloudFront 60 s) and polled every `3s`;
  memory events `EventExpiryDuration=90` days; self-managed short-term DynamoDB TTL `24h`.
- **Key APIs**: `bedrock:Converse`; `bedrock-agentcore:InvokeAgentRuntime` (data plane) / `ListAgentRuntimes…` (control plane); memory `CreateEvent`/`ListEvents`/`RetrieveMemoryRecords`;
  diagnosis `aidevops` `CreateChat`/`SendMessage`; MCP `tools/list` · `tools/call` (**SigV4**, service=`bedrock-agentcore`).
- **Key switches (one-step rollback)**: `GENBI_BACKEND=agentcore|inprocess`; `GENBI_MEMORY_BACKEND=agentcore|selfmanaged`; `GENBI_MEMORY_ID`/`GENBI_RUNTIME_ARN`/`GENBI_HTTP_ALLOWLIST`.
- **The security quartet**: read-only SQL guard (single statement + forbidden words + row cap) / SSRF guard (HTTP skills) / SigV4 instead of OAuth / masking at the return-value layer (administrators exempt).

---

## 3. The Eight Point Cards

### 🃏 Card 1 · Architecture Overview (0–10 min)

- **What to say**: CloudFront (the only entry point) → ALB (security group admits only the CloudFront prefix list) → ECS (Next.js full stack); control plane Cognito / DynamoDB / Secrets;
  data plane source → Glue → S3 Tables + Redshift; MWAA scheduling; OpenMetadata governance; Bedrock / AgentCore / DevOps Agent.
- **Must say**: ① keep **data plane vs. control plane** clearly separated; ② the **single source of truth for governance metadata = OpenMetadata**;
  ③ all private subnets + the TaskRole calls AWS APIs directly, so no long-lived keys are stored.
- **Figures to show**: `docs/diagrams/system-architecture.png` (AWS icons) + `docs/diagrams/deepdive-data-flow-e2e.png` (the §2.2 data flow).
- **Q&A anchor**: why a Next.js full stack? → front end and back end in one repository, the API is the BFF, and a single ECS service is easy to operate.

### 🃏 Card 2 · GenAI Capability Map (10–20 min)

- **What to say**: not one isolated feature but **one Converse kernel + Strands assembly driving 7 user-visible AI capabilities + 3 enabling layers**;
  the model comes from a single source of truth, `ai-model.json` (opus-4-6 at the time of writing; the model generation can be swapped without locking in a family).
- **Must say**: converge "calling the model" into one place (dialect / method / credentials unified); trade **tools (MCP) + data-catalog grounding + iron rules in the system prompt**
  for answers that are **trustworthy / controllable / read-only / explainable**.
- **Figures to show**: `docs/diagrams/genai-architecture.png` (AWS icons; the GenAI / AgentCore / memory / DevOps planes) + the §3 capability-map table.
- **Code anchors**: the §3 table (7 capabilities + 3 enabling layers → files).

### 🃏 Card 3 · GenBI Ask-Your-Data / NL→SQL (20–45 min) ★ key topic

- **What to say**: a business user asks in plain Chinese "customer count by region" → the platform generates **read-only SQL** → Redshift / Athena executes it → a conclusion in Chinese plus a recommended chart.
  **Core promise: 100% of the numbers come from a real query; the model is never allowed to do mental arithmetic**.
- **End to end in 5 steps**: ① inject the materialized tables → ② `introspectSchema` probes the schema → ③ **semantic retrieval selects the tables**
  (OM descriptions + materialized-table weighting + LLM re-ranking at temp=0; on error **fall back to all tables**) → ④ the **Converse tool-use loop** (tool `run_sql`, ≤ 8 rounds, errors are fed back for self-healing)
  → ⑤ post-processing: masking + tables hit + chart recommendation + history.
- **Must say**: `run_sql` first passes the **read-only guard** (a single SELECT/WITH + whole-word forbidden-word scan + wrapped in `LIMIT 200`); **materialized result tables take priority**
  (consistent definitions / faster); **masking happens at the return-value layer** (administrators / authorized users exempt; nothing inside the database is touched).
- **Figures to show**: `docs/diagrams/genbi-nl2sql-loop.png` (sequence) + the §4 / §15.2 toolUse/toolResult JSON.
- **Code anchors**: §15.1 orchestration / §15.2 wire format of the loop / §15.3 retrieval / §15.4 guard / §15.5 chart recommendation and masking.

### 🃏 Card 4 · AgentCore (45–75 min) ★ key topic

- **What to say**: move GenBI's "NL→SQL inference loop" from **in-process** into the **AgentCore Runtime** (ARM64 container, `/invocations` + `/ping`, :8080);
  skills are exposed through the **Gateway** as **MCP tools** (Lambda backend); the front-end contract is unchanged, with **one-step rollback**.
- **Must say**: ① **inbound AWS_IAM (SigV4) instead of OAuth**; ② the agent is **generic and dynamic** — every call runs `tools/list` to discover all tools and forwards generically,
  so **new skills hot-load with zero deployment**; ③ IaC uses the **CfnResource escape hatch** (`AWS::BedrockAgentCore::{Gateway,GatewayTarget,Runtime,Memory}`) + a **two-phase deployment**
  to solve the "image chicken-and-egg" problem; ④ skills use only the public Data API / Athena → Runtime `NetworkMode=PUBLIC`, no VPC needed; ⑤ registered skills (SQL / HTTP templates, data-driven).
- **Must say · cost**: Runtime $0.0895 per vCPU-hour + $0.00945 per GB-hour (billed only for active seconds; I/O wait is free); Gateway $0.005 per thousand tool calls
  → **the incremental infrastructure is negligible; the main cost is still model tokens**.
- **Figures to show**: `docs/diagrams/agentcore-mcp-sigv4.png` (sequence) + the §5 architecture.
- **Code anchors**: §15.6 CfnResource property tree / §15.7 mcp.js SigV4 + JSON-RPC / §15.8 skills Lambda (SSRF / EMF).

### 🃏 Card 5 · Context and Memory (75–90 min) ★ key topic · the architects' favorite question

- **What to say**: context has **four layers** — ① the multi-turn `messages` inside a single inference (native to Converse) ② cross-turn short-term memory ③ cross-session long-term semantic memory
  ④ the business glossary (quasi-memory).
- **Cache or storage?** (must answer): **not a volatile cache — persistent storage plus on-demand read and injection**. Short-term = temporary storage **with a TTL**
  (self-managed DynamoDB `bgp-genbi-turns` TTL 24 h / managed events 90 days); long-term = permanent storage (self-managed S3 summaries / managed semantic memory records).
  The only thing close to a cache is the Runtime microVM session (reused for the same `runtimeSessionId`, ≤ 8 h) — **memory never depends on it; it only speeds things up**.
- **Which APIs are called + triggers** (must say):
  - Short-term write = `CreateEvent` (managed) / `PutItem` (self-managed); **trigger: fire-and-forget after the answer is returned**.
  - Short-term read = `ListEvents` (managed) / `Query` for the most recent 6 turns (self-managed); **trigger: injected before the question is asked**.
  - Long-term read = `RetrieveMemoryRecords` (managed, **vector semantic recall**, topK 3) / S3 `ListObjectsV2` + `GetObject` (self-managed, the 3 most recent summaries);
    **trigger: in parallel before the question is asked**.
  - Long-term consolidation: self-managed triggers a Bedrock summary written to S3 **every 6 turns**; managed = the semantic strategy **extracts asynchronously** (`maybeSummarize` is a no-op).
- **Injection path**: short-term `history[]` → expanded into alternating user/assistant `messages`; long-term `memory` string → system prompt.
- **Switchable + trade-offs**: `GENBI_MEMORY_BACKEND`; managed = strong semantic recall and no self-built vector store (replaces OpenSearch k-NN), but long-term is **asynchronous**;
  self-managed = zero dependencies and immediate, recency first.
- **Figures to show**: `docs/diagrams/genbi-memory-flow.png` (sequence, both backends annotated) + the §6.5 trigger-timing table.
- **Code anchors**: §15.9 (exact inputs and outputs + trigger arithmetic + `runtimeSessionId=sha256` + the cache-vs-storage clarification table).

### 🃏 Card 6 · DevOps Agent Diagnosis + Observability (90–105 min) ★ key topic

- **DevOps Agent (what to say)**: hand a failed or successful task to the **AWS DevOps Agent** with one click (managed SRE, `aidevops`, us-east-1 only); it investigates autonomously
  → a structured report in Chinese.
- **Must say**: ① it uses a real AWS managed service, **not a home-built agent**; ② **evidence-driven** — `buildIncidentContext` assembles real CloudWatch (`/aws-glue/jobs/error`) + `GetJobRun.ErrorMessage` + Data API `DescribeStatement` sub-statement errors; ③ **asynchronous + polling** (an investigation takes 20–40 s > CloudFront 60 s);
  ④ the Agent Space is **reused by name**, not hard-coded; ⑤ two prompts — success goes through a "retrospective", failure through "root cause". Measured on a real Glue failure: a 3,605-character RCA in 42 s.
- **Observability (what to say)**: `/observability` aggregates **four sources** — AgentCore control-plane status + GenBI usage (history) + skills Lambda CloudWatch 24 h + **per-tool / per-skill EMF counters**.
- **Must say · EMF**: on every invocation the skills Lambda writes one EMF JSON line with `console.log` (namespace `BGP/GenBI`, dimensions `ToolName`/`Skill`, metrics `Calls`/`Errors`)
  → CloudWatch extracts it into metrics automatically, **with zero extra latency and no PutMetricData permission needed**.
- **Figures to show**: `docs/diagrams/devops-agent-sequence.png` (sequence) + `docs/diagrams/deepdive-observability.png` (§8 observability).
- **Code anchors**: §15.10 diagnosis / §15.11 observability (EMF queries + ListMetrics discovering the skill dimensions).

### 🃏 Card 7 · Big-Data Foundation (105–115 min)

- **What to say**: source → Glue (Glue 5.1 + Iceberg, see [`supported-versions.md`](supported-versions.md); full load as overwrite / incremental append by watermark column)
  → S3 Tables (Iceberg) + Redshift (Data API); MWAA visual DAG scheduling; Athena queries the lake.
- **Must-say highlights**: ① sync `recommendChannel` (glue / zero-etl / dms) + type mapping (compatibility flagged) + DDL (DISTKEY / SORTKEY);
  ② jobs take a `${ds}` business-date parameter + dry-run (EXPLAIN, nothing is written) + backfill (day by day, ≤ 31) + rerun;
  ③ **"exactly-once" cross-task dependencies** = a DynamoDB conditional write `attribute_not_exists(downstreamFired)` wins the race; ④ lineage = heuristic table-level parsing (best-effort, never throws) + OM column-level;
  ⑤ a unified Redshift admin secret resolves cross-identity ownership.
- **Must say · real pitfalls**: Glue must register the `s3tablescatalog` Iceberg catalog via `--conf` (otherwise `[REQUIRES_SINGLE_PART_NAMESPACE]`);
  the scheduling DAG uses a Python list literal to sidestep the `json.loads` control-character bug.
- **Figures to show**: `docs/diagrams/deepdive-data-flow-e2e.png` (the §2.2 data flow) + `docs/diagrams/deepdive-sync-flow.png` (the §10 sync flow) + `docs/diagrams/data-flow.png`.
- **Code anchors**: §15.13 (`--conf` / control-character fix / `fireDownstreamOnce` / `run-params`).

### 🃏 Card 8 · Security / IAM / Evolvability (115–120 min)

- **What to say**: read-only SQL guard / SSRF guard (HTTP skills) / SigV4 instead of OAuth / return-value-layer masking / five least-privilege roles / no hard-coded credentials
  (Secrets Manager + `fromGeneratedSecret`) / CloudFront prefix list / Cognito site-wide middleware + audit.
- **Evolvability**: two one-step rollbacks (the question-answering backend + the memory backend); registered skills hot-load with zero deployment; CfnResource means no CDK upgrade is required.
- **Must say · project isolation**: the Runtime `index.js` passes `projectId` through, so business glossary entries and registered skills are isolated by real project (workspace),
  consistent with the in-process path (an early version failed to pass it; since fixed).
- **Code anchors**: §13 security table / §15.12 IAM action list / §15.14 failure modes and trade-offs table.

---

## 4. Quick Answers to Architects' Frequent Questions

> Each entry: **question → one-sentence answer → anchor**. When pressed, open the corresponding § of the full manuscript.

1. **How is context managed? Is it a cache?** → Four layers of context; **not a volatile cache but persistent storage + on-demand injection**; short-term has a TTL, long-term is permanent. → §6 / §15.9
2. **What does short-term memory call, and when is it triggered?** → Managed `CreateEvent`/`ListEvents`, self-managed DynamoDB `PutItem`/`Query`;
   **written after the answer is returned (fire-and-forget), read before the question to inject the most recent 6 turns**. → §15.9
3. **How is long-term memory implemented? Is recall semantic?** → Managed `RetrieveMemoryRecords` (**vector semantic**, topK 3, replacing a self-built OpenSearch k-NN);
   self-managed: every 6 turns a Bedrock summary is written to S3 and the 3 most recent are read. → §6.4 / §15.9
4. **Is long-term memory synchronous?** → Managed semantic records are **extracted asynchronously** (minutes); when the result is empty it degrades gracefully and injects nothing; short-term is synchronous and immediate. → §15.9
5. **How does a conversation map to the Runtime?** → `runtimeSessionId = "genbi-"+sha256(conversationId)[:48]` (stable, ≥ 33 characters) → the same conversation hits the same microVM session (≤ 8 h),
   but factual memory does not rely on it. → §15.9
6. **How does the agent call tools securely?** → MCP-over-HTTP + **SigV4** (service=`bedrock-agentcore`); Gateway inbound `AWS_IAM` instead of OAuth; outbound `GATEWAY_IAM_ROLE` invokes Lambda. → §15.7
7. **Does adding a skill require a redeploy or an agent change?** → No. The agent discovers tools dynamically with `tools/list` on every call and forwards generically;
   SQL / HTTP registered skills are DynamoDB data, **hot-loaded with zero deployment**. → §5.6 / §15.8
8. **Why should the numbers be trusted?** → Iron rules in the system prompt (numbers must come from `run_sql` / computations go into the SQL) + a closed tool-use loop + the read-only guard + the row cap;
   the model only explains, the engine computes. → §4.5 / §15.2
9. **How are write operations / injection by the model prevented?** → `sanitizeSelect`: a single statement, must be SELECT/WITH, whole-word forbidden-word scan, wrapped in `LIMIT 200`;
   a DB-level read-only role is recommended in addition. → §15.4
10. **Aren't HTTP skills exposed to SSRF?** → Static checks (https only / placeholder hosts rejected / private networks rejected) + dynamic checks (DNS resolved per address with private ranges rejected
    · `redirect:error` · timeouts · length limits · domain allow-list) + **only platform administrators may register them**. → §15.8
11. **How does observability avoid adding latency?** → EMF: the Lambda writes a log line and the metric appears, **no PutMetricData, zero extra round trips**; control plane read-only + history aggregation. → §15.11
12. **Why is diagnosis asynchronous?** → A DevOps Agent investigation takes 20–40 s > the CloudFront 60 s origin timeout → submitting returns running immediately and the front end polls every 3 s. → §15.10
13. **Does masking change data in the database?** → No. **Only the rows returned to the front end are masked**, by identity / classification / authorization; administrators / authorized users are exempt;
    best-effort, never interrupts the query. → §15.5
14. **Will cost explode?** → The Runtime bills only active seconds and I/O wait is free; Gateway $0.005 per thousand calls; the incremental infrastructure is negligible,
    **the main cost is model tokens (the same as before the refactor)**. → §15.14
15. **What if AgentCore goes down?** → `GENBI_BACKEND=inprocess` / `GENBI_MEMORY_BACKEND=selfmanaged`: change the context and redeploy to fall back to in-process + self-managed; **both code paths are kept**. → §4.2 / §15.14
16. **Why not connect to Redshift through a VPC?** → Skills use only the public Data API / Athena → Runtime `NetworkMode=PUBLIC` and Lambda without a VPC, which greatly simplifies networking. → §5 / §15.6
17. **Can cross-task dependencies fire twice?** → No. `fireDownstreamOnce` wins the race with a DynamoDB conditional write `attribute_not_exists(downstreamFired)`; only the winner fans out. → §15.13

**Supplement · GenAI / GenBI / AgentCore / memory**

18. **Why Claude Opus rather than a cheaper model?** → NL→SQL / retrieval / diagnosis demand high accuracy in reasoning and SQL dialects; the model id comes from the single source of truth `ai-model.json`
    (opus-4-6 at the time of writing), and the generation can be swapped without locking in a family. → §3
19. **Why MCP instead of letting the agent call the Data API directly?** → Skills are standardized, can be rate-limited / governed / reused independently, and **hot-load**;
    the Gateway unifies inbound and outbound authentication. → §5
20. **Which framework does the agent use?** → Unified on the **Strands Agents SDK**: the remote containerized agents (GenBI / advisors) are assembled with Strands `Agent.invoke`,
    converged into a single pure-logic `@genbi/core` + a shared agent-runner; the lightweight in-process path still uses the hand-written Converse loop as a fallback.
    GenBI already runs on Strands for real; the advisors' code has landed but is not deployed remotely. → §5.1 / §11bis (GenBI engine convergence and the Strands unification)
21. **How is a multi-turn conversation kept faithful?** → History is expanded into alternating user/assistant `messages` (not stuffed into one text block), giving high-fidelity context. → §6.6 / §15.9
22. **How are cold starts / latency controlled?** → Runtime session reuse reduces cold starts and I/O wait is free; CloudFront origin 60 s; long tasks go asynchronous. → §5.1 / §15.10
23. **How does the business glossary take effect?** → `lookup_business_context` injects the matching definitions into the system prompt as "must follow"; codegen injects them too. → §5.9
24. **Can registered skills be abused?** → SQL templates pass the read-only guard + parameter validation; HTTP is platform-administrator-only + the SSRF guard; isolated by project / global. → §15.8
25. **Can memory leak sensitive detail?** → Self-managed summaries store only definitions / key points, never row-level detail; masking is at the return-value layer; memory is isolated by `projectId`. → §6 / §15.9
26. **Why does AgentCore need no VPC?** → Skills use only the public Data API / Athena → Runtime `NetworkMode=PUBLIC` and Lambda without a VPC, simpler networking. → §5 / §15.6
27. **How are new AI capabilities added?** → Add an MCP tool (change Lambda + Gateway, the agent is untouched) or a registered skill (pure data, zero deployment). → §5.6 / §15.8

**Supplement · big data / sync / ETL / scheduling**

28. **How are full and incremental loads implemented?** → Full = whole-table overwrite; incremental = read only rows where "watermark column > last watermark" and append (Glue PySpark). → §10.2 / §15.13
29. **Why dual-write S3 Tables (Iceberg) + Redshift?** → Lake (open table format / Athena / low cost) and warehouse (strong consistency / BI performance) both, with unified lineage governance. → §2 / §10
30. **What about incompatible types?** → The MySQL/PG → Redshift mapping registry flags compatibility (compatible / converted / may truncate) and preserves lengths. → §10.2
31. **Why MWAA for scheduling instead of building our own?** → Managed Airflow; visual DAG → generated Python; native cron + cross-task dependencies. → §10.3
32. **How does dry-run avoid writing?** → Redshift `EXPLAIN` (only for queries / DML; pure DDL is skipped). → §10.4 / §15.13
33. **Can we backfill / rerun?** → `${ds}` business-date parameter + day-by-day range backfill (≤ 31 days) + rerun for the same business date. → §10.4
34. **Why must Glue register the catalog via `--conf`?** → Otherwise `spark.table("s3tablescatalog…")` fails with `[REQUIRES_SINGLE_PART_NAMESPACE]` (a real diagnosed root cause). → §15.13

**Supplement · governance / OpenMetadata / lineage / quality / classification**

35. **Why self-host OpenMetadata instead of Glue Catalog / DataZone?** → OM is the open single source of truth for "catalog + column-level lineage + business descriptions + quality";
    the platform treats OM as authoritative. → §10.8
36. **How is lineage parsed? Why not an AST library?** → Heuristic table-level parsing (Redshift-dialect AST coverage is poor and throws on unsupported syntax); best-effort, never throws. → §10.6 / §15.13
37. **How does metadata get into OM?** → Two paths: EventBridge → periodic ECS connector ingestion + the platform pushes `source → S3 Tables → Redshift` column-level lineage at sync time. → §10.8
38. **Where do classification / masking take effect?** → A classification table (column FQN → policy); masking at the query **return-value layer**, administrators / authorized users exempt,
    nothing inside the database is touched. → §11.2 / §15.5
39. **How is data quality scored?** → 6 templates run checks against Redshift → weighted pass rate + dimension scores + freshness SLA breaches. → §11.3
40. **How does the metrics store prevent injection?** → No free-form SQL; identifier allow-list + double quoting; executed uniformly through the admin credential, read-only. → §11.4

**Supplement · multi-tenancy / RBAC / multi-environment / versions**

41. **How are resources isolated?** → By `(project, env)`; every API passes `requireProject(role)` (viewer / editor / owner). → §11.1
42. **How is dev → prod promotion done?** → promote takes the portable definition (stripping runtime bindings such as glueJobName / airflowDagId); dev → staging is direct, → prod goes through approval. → §11.6
43. **Can a bad configuration change be rolled back?** → Every save leaves a version snapshot in `bgp-resource-versions`, which can be rolled back. → §11.5

**Supplement · infrastructure / security / cost / operations / evolvability**

44. **How many stacks? Deployment order?** → **21 stacks** (17 always-on + 4 gated: realtime / flink / emr / om-ingestion); OM before Platform (URL injection avoids a hard dependency);
    AgentCore in two phases (the three advisor stacks reuse the same protocol base class); MWAA depends on Platform. → §12
45. **How are credentials / secrets managed?** → All in Secrets Manager; RDS `fromGeneratedSecret`; a unified Redshift admin secret (consistent ownership); nothing hard-coded. → §13
46. **How large is the public exposure?** → CloudFront only; the ALB security group admits only the CloudFront prefix list; the Runtime is `PUBLIC` but only IAM may invoke it. → §13
47. **Where does the cost go?** → The main cost is Bedrock tokens; AgentCore Runtime / Gateway / memory / EMF add negligible increments. → §15.14
48. **How is the AI refactor canaried / rolled back?** → `GENBI_BACKEND`/`GENBI_MEMORY_BACKEND`: change the context and redeploy to roll back; both paths are kept. → §4.2 / §15.14
49. **What are the honest boundaries?** → The Strands container code for paramadvisor / netadvisor has landed but the **remote Runtime is not deployed** (production defaults to inprocess);
    Copilot **L3 step-by-step execution on the user's behalf is left blank** (in practice it only reaches draft creation); the remote GenBI Engine Cookbook guard **still awaits online verification**.
    → §11bis / §15.14
50. **Authentication along the whole chain?** → Cognito site-wide middleware validates every `/api/*` (ID token); resource-level RBAC + approvals; platform → Runtime via IAM; agent → Gateway via SigV4. → §11.7 / §13

---

## 5. One-Page Cheat Sheet (API · Method · Trigger)

| Capability | Key method / API | Trigger point | Storage / object | Anchor |
|---|---|---|---|---|
| NL→SQL | `Converse` (tool `run_sql`, ≤ 8 rounds) | POST `/api/genbi/ask` | — | §15.2 |
| Table selection | `Converse` (temp=0, JSON) | Phase one, before the question | OM descriptions / materialized tables | §15.3 |
| Read-only guard | `sanitizeSelect` | Before every `run_sql` | — | §15.4 |
| Invoke Runtime | `InvokeAgentRuntime` (qualifier DEFAULT) | agentcore backend | `runtimeSessionId` | §15.1 |
| Invoke tools | MCP `tools/list` · `tools/call` (SigV4) | Inside the agent loop | Gateway / Lambda | §15.7 |
| Short-term memory write | `CreateEvent` / DynamoDB `PutItem` (TTL 24h) | After the answer is returned | Events / `bgp-genbi-turns` | §15.9 |
| Short-term memory read | `ListEvents` / DynamoDB `Query` (6 turns) | Before the question | Same as above | §15.9 |
| Long-term memory read | `RetrieveMemoryRecords` (topK 3) / S3 `ListObjectsV2` + `GetObject` | Before the question | Semantic records / `genbi-memory/<proj>/` | §15.9 |
| Long-term consolidation | `Converse` summary → S3 `PutObject` (self-managed) | Every 6 turns / managed asynchronous | S3 / semantic strategy | §15.9 |
| Business glossary | `lookup_business_context` | Grounding before the question | `bgp-genbi-context` | §5.9 |
| Registered skills | `list/run_registered_skill` + `renderTemplate` | On demand by the model | `bgp-genbi-skills` | §15.8 |
| Skill counters | EMF `console.log` (BGP/GenBI) → `GetMetricStatistics`/`ListMetrics` | Every tool call | CloudWatch | §15.11 |
| Failure diagnosis | `aidevops`: `CreateChat`/`SendMessage` + `DescribeStatement`/`GetJobRun`/`GetLogEvents` | POST `/api/diagnostics` (asynchronous) | `bgp-diagnostics` | §15.10 |
| Glue jobs | `CreateJob/UpdateJob` + `--conf s3tablescatalog`, `StartJobRun` (`--ds`) | Run now / scheduled | `bgp-etl-jobs` | §15.13 |
| Scheduling dependencies | `fireDownstreamOnce` (conditional write) → `start_job_run` / MWAA `CreateCliToken` | Upstream succeeded | `bgp-task-runs` | §15.13 |

> For the full source code, IAM, the CfnResource property tree and the failure modes, see [`deep-dive.md` §15](deep-dive.md).

---

## 6. Platform Capability Overview (the later single-region feature wave; expand on demand during the talk)

The main body of this brief focuses on the GenAI mainline; the platform already covers every feature module of the single-region stage.
Below are the differentiating crib notes (details in [`deep-dive.md`](deep-dive.md) §10 / §11 / §11bis):

- **Data integration**: offline batch sync + three real-time CDC channels (DMS / Zero-ETL / Flink CDC) + a data-source SPI with four paradigms (the four JDBC siblings / S3 / DynamoDB / Kinesis · MSK; 8 providers).
  → §10.9 / §10.12
- **Compute engines**: Glue + **EMR Serverless** (a pluggable engine SPI, an independent application per job) + Athena + Redshift SQL + **MSAF Flink** (multiple source × sink combinations,
  including the MSK → S3 Tables path completed in this round). → §10.10 / §10.11
- **Warehouse modeling**: ODS / DWD / DWS / ADS layering + domains / standards / code tables + dimensions and facts + a metrics system (safe DDL / SQL with zero injection surface). → §11.8
- **Governance deepening**: a sensitive-data scanner (SPI-based + globalized; sampled values are never persisted) + a governance health score weighted over four dimensions. → §11.9
- **Data consumption**: BI dashboards (QuickSight-style; every data fetch passes through masking; the Data Service API was retired on 2026-09-05). → §11.10
- **Scheduling and operations**: a production-grade Backfill Center + smart baselines / SLA breach prediction + Incident Knowledge Base with memory-augmented diagnosis. → §11.13–11.15
- **FinOps**: task- / run-level cost attribution (beyond service level; engine metering truth × unit price as an estimate, not a real-time bill). → §11.12
- **AI-native moat (differentiators over traditional data platforms)**: the unified Copilot (three gates: may create, never executes) / Engine Cookbook (a zero-LLM recipe library) / GenBI dual-engine convergence
  / the unified Strands framework. 🔵 Honest boundaries: Copilot L3 execution on the user's behalf is left blank, the advisors are not deployed remotely,
  and the remote Engine Cookbook guard still awaits online verification. → §11bis
