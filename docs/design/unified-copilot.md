# Unified platform Copilot (agentic data development · may create, must not execute)

> 📌 **Scope note (reconciled on 2026-10-13)**: this document was written during the single-region stage and records the design as it stood then (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is tracked in the module index of the engineering documentation; a path mentioned below that no longer exists means that the idea was not implemented as written here or has since been superseded.
> ⚠️ **Implementation differences**: the AgentCore edition of the Copilot described in this document (`infra/agent/copilot`, `infra/lib/copilot-agentcore-stack.ts`, `infra/lambda/copilot-skills`) was never implemented; the current Copilot runs inside the platform process (`platform/src/lib/copilot/`, API `platform/src/app/api/copilot/`), and the "create only, never execute" guardrails of the Plan Center are documented in the [endpoint inventory](./unified-copilot-endpoint-inventory.md) that accompanies this document.

> Status: **✅ implemented (in a form different from this document: an in-process Copilot, no AgentCore edition — see "Implementation differences" above)** (design baseline 2026-07-15) (documentation audit calibration of 2026-08-26: the original status header was out of date; it read "design draft / no product code written yet").
> Rollback anchor: a pre-change `git tag` (= the head of the main branch at that time; live task definition revision 13) has been pushed.
> Positioning: supplement the AI capabilities scattered across individual pages with **one conversational entry point that spans the whole platform (a centralized Copilot)** and supports **cross-module agentic orchestration**;
> constrain it with one hard security line — **"create / generate / suggest" actions are allowed; "execute / run / publish / delete" actions are forbidden**.
> Lineage: follows the platform standard [AI capabilities on Amazon Bedrock AgentCore](./agentcore-standard.md) (every AI capability = an independent Runtime + Gateway + Memory + a thin platform wrapper).
> Related working notes: the AgentCore platform standard · the network advisor is read-only by design · tag before large changes · run the contract guard before and after every change

---

## 0. One-sentence conclusion

**The unified Copilot = one more AgentCore trio (cap=`copilot`)**, but its tool set **contains only "create / generate / suggest" tools and no "execute" tool of any kind**;
even if the model wants to run a job, the tool it would need simply does not exist in the tool set → privilege escalation is eliminated at the "capability surface" rather than by after-the-fact interception. **Per-page inline AI stays unchanged**;
the Copilot "adds a central brain", it does not "replace the inline advisors".

---

## 1. Background and decisions (2026-07-15)

Three points were made explicit during the review of the AI architecture (recorded in the working notes):
1. **AI diagnostics stays on AWS DevOps Agent** and is not migrated to AgentCore (diagnosis = a managed brain; wrapping it in a Runtime would degrade it / nest one agent inside another). ✅ This is already the case; no change.
2. **The network advisor and the parameter advisor already run on AgentCore underneath** (not on DevOps Agent) and **stay as they are, not migrated** — they are "before-the-fact: a deterministic engine produces the values + a large model explains them", a different class of task from the DevOps Agent's "after-the-fact diagnosis"; each stays where it belongs.
3. **Per-page inline AI must be preserved** (it appears where it is used; the user is not sent elsewhere); **one additional centralized entry point** is added for cross-module orchestration, with **the permission boundary = may create, must not execute**.

> The underlying implementation of the three AI functions has been verified in code: diagnostics = `@aws-sdk/client-devops-agent`; network / parameter advisors = `InvokeAgentRuntimeCommand` (AgentCore) + an in-process `BedrockRuntime` fallback.

**This module delivers only the "centralized entry point" of point 3**; points 1 and 2 are "confirmed unchanged".

---

## 2. Design goals and non-goals

**Goals**
- G1 One global conversational entry point (mounted in `Header.tsx`, can be opened from any page), multi-turn, with memory.
- G2 Agentic orchestration: able to break "help me sync table X from MySQL to Redshift in real time and set up quality rules for it" into **a chain of create actions** and perform the **creation** (create a data source draft / create a sync task draft / create a quality rule), leaving the **run** to a person who clicks on the corresponding page.
- G3 **Hard security line**: the Copilot never triggers any execute / run / publish / delete / land-to-warehouse / touch-the-real-database / expose-externally action.
- G4 Reuse of existing assets: the AgentCore standard skeleton, the read-only tools of the 6 existing agents (Ask-Your-Data, the network advisor and the parameter advisor can be referenced as "sub-capabilities" of the Copilot), and the platform RBAC / audit.

**Non-goals (not in this phase / never)**
- N1 Do not touch the per-page inline advisors (they keep working as before).
- N2 **The architecture permanently forbids AI from executing / running / publishing any task** (decided 2026-07-15: execution is permanently prohibited, **and no approval bypass is added**). Anything that must run is started by a person on the corresponding page. This is not "deferred to a later phase"; it is the permanent security contract of this module.
- N3 No multi-agent mutual-invocation orchestration (for now the Copilot does not sub-invoke the Runtimes of the network / parameter advisors; the first phase uses their **skill Lambdas** as read-only tools, which is sufficient).
- N4 Do not change the behavior of any existing execution endpoint.

---

## 3. Architecture (following the AgentCore platform standard, cap = `copilot`)

```
User (any page) ──opens──> global Copilot drawer (mounted in the Header)
   │  POST /api/copilot/ask  (Next.js; platform-side auth = current signed-in identity / workspace / env)
   ▼
Thin platform wrapper lib/copilot/agentcore-client.ts ──InvokeAgentRuntime──> bgp_copilot_agent (Runtime)
   │(not configured / failed → in-process fallback lib/copilot/agent.ts, calling Bedrock Converse directly)
   ▼ tool_use loop
bgp-copilot-gateway (MCP) ──> bgp-copilot-skills (Lambda, deterministic tools)
   │
   ├─ read-only tools: list_datasources / introspect_schema / list_jobs / get_lineage / lookup_business_context …
   └─ create tools: create_datasource_draft / create_sync_task_draft / create_etl_job_draft /
                create_quality_rule / create_flink_job_draft / generate_code …
        (every create tool = a call back into a platform "create-class" API, carrying the caller's identity; there is no execute tool whatsoever)
   ▼
Managed Memory bgp_copilot_memory (actorId=projectId; multi-turn context)
```

**The key point: the security boundary lives at the "tool set" layer.** The Copilot's Gateway mounts only create and read-only tools; execute actions **do not exist in the tool list**,
and the model cannot call a tool that does not exist. This is a stronger guarantee than "runtime interception" (following the "read-only capability surface" approach the network advisor already applies).

---

## 3.5 Top-level design principles (global users install it themselves — highly abstract · self-contained in one directory · zero hard-coding)

> This platform is meant to be **downloaded and installed by users worldwide on their own** (the global self-install architecture principle). As a new module, the Copilot's top-level design must satisfy the four principles below and be **isomorphic** with existing modules such as flink / finops / platform — switch AWS account / region, change the env, and it runs, without changing a single line of code.

### Principle 1 — Self-contained in one directory (clear module boundary; can be enabled / disabled as a whole)
All Copilot code lives only in its own directories and is not scattered into shared files (shared files get only a one-line "registration"):

| Layer | Directory | Responsibility |
|---|---|---|
| Platform logic | `platform/src/lib/copilot/` | config / agentcore-client / memory / agent (in-process fallback) / tools (tool registry) / action-guard |
| API | `platform/src/app/api/copilot/` | `ask/route.ts` (+ a later `tools` metadata endpoint) |
| Page / entry point | `platform/src/components/copilot/` | `CopilotDrawer.tsx` (global drawer, mounted in the Header) |
| Infra — stack | `infra/lib/copilot-agentcore-stack.ts` (+ `copilot-iam.ts`) | Independent CDK stack, following the netadvisor / paramadvisor precedent |
| Infra — container | `infra/agent/copilot/` | Runtime container (index / agent / mcp) |
| Infra — skills | `infra/lambda/copilot-skills/` | Gateway target Lambda (deterministic tool implementations) |

**Shared files receive append-only registrations** (the same specification as the "5 pure appends" of finops): `infra/bin/app.ts` (+1 line `new Stack`), `scripts/deploy-all.sh` (+1 entry each in A_STACK / A_RT_CTX / A_TAG_CTX), `components/layout/Header.tsx` (+1 entry icon), `lib/i18n/en.ts` (strings), `platform-stack.ts` (+ pass-through of the `-c copilot-*` context, reusing the same switch as genbi). **No existing module logic is changed.**

### Principle 2 — Zero hard-coding (account / region / resource names / model all come from env, with neutral defaults)
A new `lib/copilot/config.ts`, **copied from the shape of `lib/genbi/config.ts`**:
```ts
export const COPILOT = {
  region:  process.env.AWS_REGION || "us-east-1",
  modelId: process.env.BEDROCK_MODEL_ID || <中性默认 Opus id>,   // 与全平台同一模型 env(标准契约 8)
  backend: (process.env.COPILOT_BACKEND || "inprocess"),          // agentcore|inprocess
  runtimeArn: process.env.COPILOT_RUNTIME_ARN || "",
  memoryBackend: process.env.COPILOT_MEMORY_BACKEND || "selfmanaged",
  memoryId: process.env.COPILOT_MEMORY_ID || "",
  maxIters: int("COPILOT_MAX_ITERS", 8), maxTokens: int("COPILOT_MAX_TOKENS", 2400),
};
```
Resource names are always `bgp_copilot_*` / `bgp-copilot-*` (standard naming), with **no account ids, region literals or secrets whatsoever** (they pass `redline-scan.sh`). Table names (if any) are `process.env.COPILOT_*_TABLE || "bgp-copilot-*"`.

### Principle 3 — Abstraction: tools are a "capability registry", not hard-coded branches
The actions available to the Copilot are abstracted into one **tool registry** (`lib/copilot/tools/registry.ts`); each tool is described declaratively:
```
{ name, kind: "read"|"create", description, inputSchema, actionCode: "datasource.create", handler }
```
- **Adding a Copilot capability = adding one row to the registry** (the same "table-driven" approach consistently used by the FinOps recommendation registry, the sensitive-data detector registry and the engine SPI registry), without changing the loop / dispatch core.
- A tool with `kind:"create"` **can by nature reference only create-class actionCodes**; `action-guard` uses the actionCode prefix for the gate-2 check (see section 4). **`kind:"execute"` never exists** — the prohibition is at the type level.
- The Runtime container and the in-process fallback **share one and the same set of tool declarations** (one definition used twice, which rules out drift between two copies; the GenBI isomorphic / heterogeneous setup has already proven this approach).

### Principle 4 — Pluggable gating (one-line registration in deploy-all, off by default)
- The Copilot stack is added to the AgentCore capability arrays of `deploy-all.sh` (`A_STACK[copilot]=BgpCopilotAgentCoreStack` and so on) and is thereby automatically included in the two-pass deployment orchestration.
- On the platform side `COPILOT_BACKEND` defaults to `inprocess`; `agentcore` requires an explicitly configured runtime-arn (the same switch-and-fallback rule as genbi / netadvisor, contract 7 of the standard). **Not deploying the Copilot stack does not affect any other platform function** (the drawer can work in-process, or the entry point can be hidden entirely by flag).
- The heavy resource (the Runtime image) is gated behind `-c copilot-runtime=1` with two-pass deployment, which solves the image chicken-and-egg problem.

> In one sentence: **to the platform the Copilot is "a pluggable block"; to a global installer it is "a block that runs once the env is changed"**. Every account / region / model difference lives in env; the code changes by zero lines.

---

## 4. Permission model — three gates (defense in depth)

No single point is relied on. Even if the tool set were designed wrongly, the two remaining gates still hold.

### Gate 1 (primary): the tool set contains only create / read-only tools (eliminated at the capability surface)
The Copilot's skill Lambda implements only "create / generate / suggest / read-only" tools; it **does not implement** any run / start / stop / trigger / publish / backfill / schedule / delete / land-to-warehouse / execute-sql tool.

### Gate 2 (depth): platform-side action allow- / deny-list guard
`lib/copilot/action-guard.ts` — before every create tool calls back into a platform API, the call passes an **allow-list** check. The anchors are the two yardsticks confirmed by the endpoint survey:

**(a) Audit-action suffix allow-list (permitted)**: `*.create` · `*.ai-generate` · `*.generate` · `*.issue` (with caution, see below) · `*.upload` · `*.bind` · `*.seed` · `classification.set` · `requirement.create-job` (creates a draft only, does not run it).

- **(b) Suffix deny-list (hard block, even if a tool is added by mistake in the future)**: `*.run` ·
- `*.start` ·
- `*.stop` ·
- `*.trigger` ·
- `*.backfill` ·
- `*.rerun` ·
- `*.schedule*` ·
- `*.apply` ·
- `*.land` ·
- `*.compute` ·
- `*.scan` ·
- `*.execute` ·
- `*.produce` ·
- `*.evaluate` ·
- `promote.*` ·
- `approval.decide` ·
- `resource.rollback` ·
- `*.delete` ·
- `*.publish` ·
- `data-api-key.issue` (grants external trust; downgraded to forbidden).

**(c) Path-level deny-list (covers the "execution endpoints without audit" that the action anchor cannot catch — a key finding of the endpoint survey)**:
`POST /api/redshift/execute` (bare execution of arbitrary SQL with no guard) · `POST /api/sync/execute-ddl` (DDL against the real database) ·
`POST /api/schedule/enable` (equivalent to publishing a schedule, no guard) · `POST /api/datasources/test` (has write side effects) ·
`POST /api/governance/sync-redshift-schema` · `POST /api/governance/quality-run` · `*/land` · `*/apply` ·
`POST /api/network-advisor/apply` · `POST /api/role-advisor/create` (creates IAM, high risk) · `GET /api/workflow/airflow` (direct pass-through to the console) ·
`data-apis/[id]/lifecycle` (publish = external exposure).

### Gate 3 (depth): the caller's real identity + workspace / env isolation + audit
When the Copilot calls back into platform APIs it **must carry the identity of the currently signed-in user** (no privilege escalation through a service account), reusing `requireProject` / `guardResourceAccess` —
so the create actions the Copilot can perform **never exceed the user's own workspace role** (a viewer cannot even create; only an editor can).
Every creation initiated by the Copilot is recorded through `recordAudit` with the action prefixed by `copilot.` (for example `copilot.datasource.create`), so that audit trails can be followed and mistaken operations traced back.

> **The "create / run separation" is a natural handle (conclusion of the endpoint survey)**: in the platform, creating a job (`POST`) only produces a draft; actually running it requires a separate call to `/run` · `/start` · `/publish` · `/trigger` · `backfill/tick`.
> The Copilot takes only the former path; the latter is never within its capabilities. This aligns completely with the platform's existing semantics and requires no change to existing endpoints.

---

## 5. Platform-wide endpoint classification (authoritative basis, exhaustively verified by the endpoint survey on 2026-07-15)

> The complete list is in the [endpoint inventory](./unified-copilot-endpoint-inventory.md) (appendix). This section gives the classification principles plus high-risk examples.

| Category | Copilot policy | Representative endpoints |
|---|---|---|
| Create | ✅ permitted (constrained by the caller's editor role) | `POST /api/datasources` · `POST /api/sync` · `POST /api/etl-jobs` · `POST /api/flink/jobs` · `POST /api/engines/[e]` · `POST /api/workflow` · `POST /api/bi/*` · `POST /api/alerting/rules` · `POST /api/genbi/context` · `POST /api/modeling/*` (creating objects) |
| Generate / suggest | ✅ permitted (no side effects) | `*/generate` · `*/ai-sql` · `network-advisor/advise` · `param-advisor/recommend` · `role-advisor/recommend` (recommendation only) · `sync/recommend-channel` |
| Read-only | ✅ permitted | every `GET`, `bi/query`, `athena/query` (read-only allow-list), `genbi/ask` (read-only query), `incidents/lookup`, `lineage/parse` |
| Execute / run | ❌ hard block | `*/run` `*/start` `*/stop` `*/trigger` `*/backfill` `*/rerun` `*/schedule` `flink/*/produce` `backfill/[id]/tick` `alerting/evaluate` `finops/collect` `sla/predict` |
| Touch the real database / land | ❌ hard block | `redshift/execute` `sync/execute-ddl` `modeling/*/land` `modeling/*/apply` `metrics/*/compute` `governance/quality-run` `governance/sensitive-scan/adopt` |
| External exposure / trust grant | ❌ hard block | `data-apis/[id]/lifecycle` (publish) `data-api-keys` (issue) `network-advisor/apply` `role-advisor/create` |
| Delete / rollback / promote / approve | ❌ hard block | every `DELETE` · `promote` · `approvals/[id]` (decide) · `versions` (rollback) |
| Platform administration | ❌ hard block | `admin/users` (create users / change roles) · `projects` (delete / change members) |

**Rulings on the borderline items (flagged by the endpoint survey, each classified individually)**:
- `datasources/test` (test connection): **forbidden** — the `{datasourceId}` branch writes status back; it has side effects and no guard.
- `sync/generate-ddl` (generate DDL text): **permitted** — reads only information_schema to produce text; does not touch the database.
- `requirements/[id]/create-job`: **permitted** — the comment states explicitly "never auto-executed here"; it only creates a draft.
- `modeling/dimensions/[id]/ddl` (GET preview): **permitted**; `.../apply` (touches the database): **forbidden**.
- `genbi/ask` / `bi/query`: **permitted** — read-only analysis, already masked.

---

## 6. Agentic orchestration example (illustrating the "may create, must not execute" user experience)

On any page the user tells the Copilot: "Sync the players table of the gamedata database to Redshift in real time, and create a not-null quality rule for the target table."

The Copilot plans and performs (all create-class):
1. `create_datasource_draft` (if the source is not registered yet) → data source draft created ✅
2. `create_sync_task_draft(channel=dms, source=players, target=redshift)` → real-time sync task draft created ✅
3. `create_quality_rule(table=players, rule=not_null)` → quality rule created ✅
4. **Stops here** and replies to the user: "I have created for you: data source X, real-time sync task Y (draft), quality rule Z.
   **To run the sync task you need to click Start on the Data Sync page** (I will not start a run on your behalf). [deep link]"

If the model tries to call "start sync" — **that tool does not exist in the tool set** (gate 1); even if it did, the action deny-list blocks it (gate 2);
even if that were bypassed, the user's role and the audit trail still constrain it (gate 3). **Any one of the three gates is enough to block it.**

---

## 7. UI form

- **Centralized entry point**: `Header.tsx` gets a Copilot icon (in the same row as the 🌐 language switch); clicking it opens a **drawer** on the right that is available globally and does not interrupt the current page.
- **Conversation area**: multi-turn bubbles + the Copilot's "execution plan" presented as a **list of cards** (each step: action name / target / status = created · waiting for you to run); successfully created resources get a **deep link** (click to go straight to the corresponding page).
- **Relationship to inline AI**: the inline advisors (parameter / network / role / diagnostics / Ask-Your-Data) are **kept as they are**; the Copilot drawer is "cross-module orchestration + fallback Q&A". The two share the same AgentCore standard and do not implement the protocol layer twice.
- **Permission notice**: a permanent line of gray text at the bottom of the drawer: "The Copilot can help you create and configure, but it will not run / publish / delete tasks — please confirm and execute those on the corresponding page", making the security boundary transparent to the user.

---

## 8. Reuse checklist (following the AgentCore platform standard; copy as much as possible)

| Reused item | Source | Change |
|---|---|---|
| Runtime container skeleton (ping / invocations / tool_use loop) | `infra/agent/genbi/{index,agent,mcp}.js` | Copied almost as is; change the system prompt + tool definitions |
| Thin platform wrapper (invoke + in-process fallback) | `lib/genbi/agentcore-client.ts` | Change the env prefix to `COPILOT_*` |
| Managed Memory with dual backends | `lib/genbi/memory.ts` | Change the prefix; actorId=projectId |
| CDK trio (Runtime / Gateway / Memory + 3 roles) | `infra/lib/agentcore-stack.ts` | Add one `bgp_copilot_*` set, gated by flag |
| Skill Lambda dispatch skeleton | `infra/lambda/genbi-skills/index.js` | New create / read-only tool implementations |
| RBAC guard | `lib/projects/guard.ts` | Called directly, unchanged |
| Audit | `lib/audit.ts` | Called directly; action gets the `copilot.` prefix |
| Read-only tool logic | the existing `list*/introspect*/get*` service layer | Called directly |

---

## 9. Phased implementation (each phase independently verifiable + zero regression under contract-guard)

> **Before starting**: the pre-change tag has been created (✅ done). After each phase is deployed, run contract-guard verify; the `lineage_column` anchor must not regress.

- **Phase 1 — skeleton + read-only Q&A (minimum closed loop)**: the AgentCore trio `copilot` + Header drawer + read-only tools (list / introspect / lineage / Q&A). **No create tool is connected yet**; verify the centralized entry point + multi-turn + memory + in-process fallback. **Headless verification**: the drawer opens, works across pages, and Q&A has memory.
- **Phase 2 — create tools + three-gate permissions**: connect the create-class tools (datasource / sync / etl / flink / quality-rule drafts) + the `action-guard.ts` allow- / deny-lists + the path deny-list + caller-identity pass-through + `copilot.*` audit.
  - **Headless verification (mandatory)**: ① have the Copilot create a sync task draft → it succeeds and the draft is not running (confirm on the Data Sync page that status = draft / not run);
  - ② have the Copilot "start / delete / publish" → **refused** (tool does not exist + guard intercepts; no execute action in the audit log);
  - ③ have the Copilot create as a viewer → 403 (role constraint, gate 3);
  - ④ the created resources carry `copilot.*` audit records.
- **Phase 3 — orchestration + deep links + UI plan cards**: multi-step plan orchestration + resource deep links + plan-card status. **Headless verification**: multi-step create orchestration + every step lands + deep links navigate.

**Before each phase is pushed**: contract-guard verify with zero FAIL + real headless UI verification (API responses are not accepted as evidence). If a phase's change is large, tag the pre-change commit first (tag before large changes).

---

## 10. Decision record and open questions

**Decided (2026-07-15)**
1. ✅ **`data-api-key.issue` forbidden** (grants external trust); **`classification.set` permitted** (writes metadata, no external side effect).
2. ✅ **AI execution permanently forbidden, with no approval bypass** (see N2). The Copilot can only create / suggest; execution is always left to a person clicking on the page. **No "submit for approval to execute" channel is provided.**

**Cost (verified; corrects the earlier wording)**
3. AgentCore billing verified against the official pricing page (`aws.amazon.com/bedrock/agentcore/pricing`, 2026-07-15):
   - **Runtime / Gateway / short-term Memory = purely per-call billing, zero cost when idle** (Runtime I/O wait and idle time are free; Gateway $0.005 per 1,000 calls; short-term Memory $0.25 per 1,000 events).
   - **The only cost that "accrues even when idle" = long-term semantic Memory storage** ($0.75 per 1,000 records per month, accumulated hourly, independent of calls) — but the magnitude is tiny (about $0.75 per month for a thousand memories).
   - **Conclusion**: the earlier statement "one more always-on charge" was inaccurate and has been withdrawn. The Copilot costs ≈ zero when not called; the real cost is incurred at call time (Runtime compute + Bedrock tokens + Gateway calls) — pay for what you use. **The gating flag is therefore not required** (optionally kept for staged rollout); to save even that small long-term storage fee, the Copilot could reuse genbi's Memory or use short-term Memory only, but it is not worth making a trade-off over a few cents.

**Still open (to be decided during implementation; non-blocking)**
4. **Compensation when a multi-step orchestration fails midway**: the recommendation is **no automatic rollback** (drafts have no side effects; the user deletes them on the page); the plan card marks the failed step truthfully.
5. **The operations-analyst account `bgp-analyst`**: the Copilot entry point is **visible, but the tool set automatically degrades to read-only Q&A** (not even creation; consistent with its middleware allow-list + viewer role).
