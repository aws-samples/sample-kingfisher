# Appendix — platform-wide API endpoint classification (basis for the Copilot permission boundary)

> 📌 **Scope note (reconciled on 2026-10-13)**: this document was written during the single-region stage and records the design as it stood then (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is tracked in the module index of the engineering documentation; a path mentioned below that no longer exists means that the idea was not implemented as written here or has since been superseded.
> ⚠️ **Implementation differences**: the AgentCore edition of the Copilot described in the [design document](./unified-copilot.md) (`infra/agent/copilot`, `infra/lib/copilot-agentcore-stack.ts`, `infra/lambda/copilot-skills`) was never implemented; the current Copilot runs inside the platform process (`platform/src/lib/copilot/`, API `platform/src/app/api/copilot/`), and the "create only, never execute" guardrails of the Plan Center are documented in this endpoint inventory.

> Source: exhaustive verification by a code-survey agent (2026-07-15) scanning `platform/src/app/api/**/route.ts`.
> Purpose: the authoritative basis for the "may create / must not execute" allow- and deny-lists of the [unified platform Copilot](./unified-copilot.md).
> Classification anchors: **the audit-action suffix** (`.create` permitted / `.run·.start·...` blocked) + **a path deny-list** (covering the execution endpoints that have no audit record).

## Unified authentication / audit infrastructure

- Guard `lib/projects/guard.ts`: `requireProject(req,min,projectId?)` (L46), `guardResourceAccess(req,item,min)` (L62). Role ladder `owner(3)⊇editor(2)⊇viewer(1)` (`constants.ts:50-62`). Semantics: **read = viewer; write / create / modify = editor; publish externally / delete a workspace / budgets / approvals = owner**.
- `requireAdmin`: **not in the shared library**; inlined at `admin/users/route.ts:12`, it checks `identity.isPlatformAdmin` (the `bgp-admin` group).
- **Independent authorization path**: a large number of governance / modeling "land / apply / compute / scan / classify" endpoints go through `resolveIdentity` + a manual `isPlatformAdmin` check and **recognize only the platform administrator, not the workspace role**.
- Middleware `middleware.ts`: validates the Cognito token uniformly (except `/api/public/*`); `/api/admin/**` requires `bgp-admin` (L104); the operations-analyst account `bgp-analyst` is limited to the allow-list `genbi` / `requirements` (POST) / `redshift/connections|databases` (GET) / `projects` (GET) (L61-67).
- Audit `lib/audit.ts:53`: `recordAudit(req,action,{resourceType,resourceId,detail})`, fire-and-forget. **Action naming `<resource>.<action>`**: create-class actions end in `.create/.issue/.upload`; execute-class actions end in `.run/.start/.stop/.trigger/.backfill/.rerun/.schedule/.apply/.land/.compute/.scan/.execute` — a natural anchor for allow- and deny-lists.

## Recommendations for the Copilot implementation (conclusions of the endpoint survey)

1. **The most stable deny-list anchor = the audit-action suffix**: block `*.run/*.start/*.stop/*.trigger/*.backfill/*.rerun/*.schedule*/*.apply/*.land/*.compute/*.scan/*.execute/*.produce/*.evaluate/promote.*/approval.decide/resource.rollback/*.delete/*.publish`;
   - permit `*.create/*.ai-generate/*.issue(with caution)/*.upload/*.bind/*.seed/classification.set`.
2. **A path-level deny-list covers the "execution endpoints without an RBAC guard"** (which the action anchor cannot catch): `POST /api/redshift/execute`, `POST /api/sync/execute-ddl`, `POST /api/schedule/enable`, `POST /api/datasources/test` (has write side effects), `POST /api/governance/sync-redshift-schema`, `GET /api/workflow/airflow` (direct pass-through to the console).
3. **Different methods on the same route have different privilege levels**: `DELETE` is always dangerous (the datasources / flink DELETE also destroys cloud resources); the publish action of `data-apis/[id]/lifecycle` is owner-level external exposure and is not permitted even though it is a "create".
4. **The "create / run separation" is a natural handle**: creating a job (`POST`) only creates a draft; actually running it requires a separate call to `/run·/start·/publish·/trigger·backfill/tick` — the Copilot takes only the former.

---

## Classification by module (method + path + effect; line numbers refer to the handler / guard)

### 1. datasources — data sources
- Create: `POST /api/datasources` (create, `:54` editor; audit `datasource.create:135`); `PUT /[id]` (modify, editor).
- Execute / dangerous: `DELETE /[id]` (delete + cascading deletion of the Glue Connection / Secret / SG, `:99-114` editor); `POST /[id]/heartbeat` (liveness probe that changes status, **no guard**).
- Borderline: `POST /test` (test connection, **no guard**; the datasourceId branch writes status back → **leans toward execute**); `GET /[id]/schemas|tables|discover` (read-only, permitted).

### 2. sync — data sync
- Create: `POST /api/sync` (`:59` editor; `sync.create:104`).
- Execute / dangerous: `POST /[id]/start` (starts Glue / activates Zero-ETL, `:85`); `POST /[id]/start-realtime` (starts DMS CDC); `POST /[id]/stop` (stop; for Zero-ETL this performs DeleteIntegration + drops the target database); `PUT/[id]`, `DELETE/[id]` (editor).
- Borderline: `POST /execute-ddl` (**creates tables in Redshift + GRANT ALL TO PUBLIC, entirely without guard → execute / dangerous**); `POST /generate-ddl` (generates text + probes, read-only → leans toward create); `POST /recommend-channel`, `/type-mapping` (pure functions, permitted).

### 3. etl-jobs — batch compute
- Create: `POST /api/etl-jobs` (`:39` editor; `etl-job.create:77`); `POST /generate` (AI generation, **neither creates nor executes**, permitted); `PUT/[id]`.
- Execute / dangerous: `POST /[id]/run` (run now); `/backfill`; `/rerun`; `POST /[id]/schedule` (publishes a cron DAG to MWAA + unpause); `DELETE /[id]/schedule` (takes the schedule offline); `DELETE /[id]`.
- Borderline: `POST /[id]/deps` (uploads a JAR to S3; writes but does not execute → leans toward create).

### 4. engines — multi-engine (EMR)
- Create: `POST /api/engines/[engine]` (`:45` editor); `POST /generate` (AI generation, permitted); `PUT /[engine]/[id]`.
- Execute / dangerous: `POST /[engine]/[id]/run|backfill|rerun|stop|schedule`; `DELETE /[engine]/[id]/schedule`; `DELETE /[engine]/[id]`.

### 5. flink/jobs — stream compute
- Create: `POST /api/flink/jobs` (`:40`; `flink.create:128`); `POST /connectors` (uploads a JAR, leans toward create); `POST /ai-sql` (NL → SQL, permitted); `PUT /jobs/[id]`.
- Execute / dangerous: `POST /jobs/[id]/start`; `/stop`; `/produce` (**injects generated sample data into Kinesis — really writes to the stream**); `DELETE /jobs/[id]` (delete + destroy the MSAF application); `DELETE /connectors/[id]`.
- Borderline: `POST /jobs/[id]/diagnose` (DevOps Agent diagnosis, **viewer only**, starts a background task → light execution).

### 6. workflow — ETL orchestration
- Create: `POST /api/workflow` (`:57`; `workflow.create:79`); `PUT /[id]`.
- Execute / dangerous: `POST /[id]/publish` (generates the DAG, uploads it to MWAA + unpause); `/unpublish`; `/trigger` (manually triggers a run); `DELETE /[id]`.
- Borderline: `POST /api/schedule/enable` (generic schedule switch: changes the cron + regenerates the DAG + unpause, **entirely without guard → execute**); `GET /api/workflow/airflow` (exchanges for an MWAA sign-in URL; read-only, but a direct pass-through to the console → sensitive).

### 7. backfill — backfill
- Create: `POST /api/backfill/plan` (`dryRun!=false` is preview only; `dryRun:false` persists and creates the plan, `:65` editor).
- Execute / dangerous: `POST /[planId]/tick` (**really submits instance runs**); `POST /[planId]/control` (pause / resume / cancel / retry; cancel stops runs that are in progress).

### 8. bi — reports
- Create: `POST /api/bi/reports|dashboards|analyses` (editor); `PUT /[id]`.
- Execute / dangerous: `DELETE /[id]`.
- Borderline (read-only data retrieval, viewer, permitted): `POST /api/bi/query`, `/analysis-query`, `/export`.

### 9. governance / modeling / knowledge (mostly via isPlatformAdmin)
- governance create / metadata writes: `PUT /classification` (sets the classification, admin); `POST /quality-rules` (admin); `PUT/DELETE .../[id]`.
- governance execute / dangerous: `POST /quality-run` (runs full-table validation against Redshift); `/sensitive-scan` (a scan that produces suggestions, light execution); `/sensitive-scan/adopt` (adopt → writes the classification); `/sync-redshift-schema` (back-fills OM, writes to an external system); `/lineage/backfill-om` (back-fills lineage). Read-only catalog / lineage / impact / columns / health are permitted.
- modeling create: `POST /{codetables,dimensions,domains,layers,standards,model-metrics}` (admin); `/layers/seed` (preset, upsert); `PUT /assets` (binding).
- modeling execute / dangerous (touches the real database): `POST /codetables/[id]/land` (creates dim_code_* and loads values); `POST /dimensions/[id]/apply` (creates dimension / fact tables).
- modeling borderline: `GET /dimensions/[id]/ddl` (preview only, does not touch the database, permitted); `POST /model-metrics/[id]/compute` (read-only Redshift aggregation; a POST but read-only → may be permitted, with caution).
- genbi / knowledge create: `POST /genbi/context` (global requires admin); `/skills`; `/context/seed`, `/skills/seed` (presets, admin); `PUT/DELETE`.
- genbi borderline (permitted): `POST /genbi/ask` (Ask-Your-Data, read-only query); `GET /genbi/tasks/[taskId]` (polling that drives execution, read-only).

### 10. alerting — alerts
- Create: `POST /rules` (editor); `POST /channels` (editor); `PUT/DELETE .../[id]`.
- Execute / dangerous: `POST /evaluate` (triggers an evaluation that produces events / pushes); `POST /channels/[id]/test` (**sends a test message to the real channel**). Read-only events / rules / channels are permitted.

### 11. data-service — Data Service (🔴 decommissioned on 2026-09-05: the endpoints below have been removed; only `/api/public/data/**` remains and returns 410; this section is kept as history)
- Create: `POST /api/data-apis` (editor); `POST /api/data-api-keys` (**issues a key, owner**, `data-api-key.issue`).
- Execute / dangerous: `POST /data-apis/[id]/lifecycle` (**publish requires owner = external exposure**; deprecate / offline editor); `POST /data-apis/[id]/test` (a trial call that really executes the query); `DELETE /data-apis/[id]` (editor); `DELETE /data-api-keys/[id]` (owner, revoke); `GET/POST /api/public/data/[...slug]` (**the real external call entry point**).

### 12. projects / admin — platform administration
- Create: `POST /api/projects` (create a workspace); `POST /[id]/members` (add a member, owner).
- Execute / dangerous: `PUT /[id]`, `DELETE /[id]` (delete a workspace, owner); `DELETE /[id]/members/[username]`; `POST /api/admin/users` (creates a Cognito user / sets a password, admin); `PUT /api/admin/users` (disable / enable / **changeRole = privilege escalation**, admin).

### 13. Approvals / promotion / versions (cross-cutting; high risk for the Copilot)
- `POST /api/promote` (**cross-environment promotion**; creates an approval when promoting into prod, otherwise runs executePromote immediately, editor).
- `POST /api/approvals/[id]` (approval decide; **approve materializes the side effect**: adds members / executes the promote / grants authorization, owner).
- `POST /api/approvals` (submits an approval request, leans toward create).
- `POST /api/versions` (**rolls back to a given version**, editor); `GET` (lists versions, viewer).

### 14. requirements — requests
- Create: `POST /api/requirements` (submit a request, viewer); `POST /[id]/create-job` (**one-click creation of an ETL draft; the comment says "never auto-executed" → permitted**, editor + assignee); `POST /[id]/generate` (AI generation, permitted).
- Workflow: `POST /[id]/assign` (assign); `/transition` (state machine); `/comment` (comment, viewer).

### 15. FinOps / SLA / baseline / incidents / diagnostics
- Create: `POST /api/finops/budgets` (owner); `POST /api/sla` (editor); `POST /api/metrics` (editor).
- Execute / dangerous: `POST /finops/collect` (collection scan);
  - `/finops/detect` (detection + push);
  - `POST /baseline/learn`;
  - `POST /sla/predict` (may push breach alerts);
  - `POST /metrics/[id]/compute`, `/compute-all` (computes metrics against Redshift and writes snapshots, admin);
  - `POST /diagnostics`, `flink/jobs/[id]/diagnose` (starts DevOps Agent);
  - `POST /incidents/[sig]/silence` (suppress, editor);
  - `PUT /incidents/[sig]` (maintains the runbook);
  - `GET /incidents/export` (owner).

### 16. redshift / athena — query execution (key area)
- Execute / dangerous: `POST /api/redshift/execute` (**runs arbitrary SQL as admin, entirely without guard — one of the highest risks**); `/redshift/cancel` (no guard); `POST /athena/query/[id]/stop`.
- Create: `POST /api/redshift/tasks` (creates a Redshift task, editor); `PUT/DELETE .../[id]`.
- Borderline / read-only: `POST /athena/query` (**sanitizeReadOnly read-only allow-list**, viewer, permitted); `GET /redshift/{connections,databases,schemas,result/[id]}` (read-only, permitted); `GET/POST /redshift/history` (the POST only records history).

### 17. advisor — advisors (suggestion vs. one-click execution)
- Permitted: `POST /network-advisor/probe`, `/advise` (read-only); `POST /param-advisor/advise`, `/recommend` (read-only); `POST /role-advisor/recommend` (recommendation only).
- Execute / dangerous: `POST /network-advisor/apply` (**one-click fix: really creates the VPC DNS / S3 Gateway Endpoint**, admin); `POST /role-advisor/create` (**one-click creation of an IAM role**, admin).

### 18. Other read-only (all permitted)
- `GET /api/audit`, `/ops/summary`, `/monitor/{runs,tasks/[id]/logs}`, `/observability/genbi`, `/openmetadata/url`, `/s3/buckets`, `/settings`, `/versions`, `/finops/{overview,advice,anomalies,tasks}`, `/sla/risk-board`, and every `/logs` / `/status` / `/runs` / `/results` / `/output` / `/dashboard`;
- `POST /api/lineage/parse` (pure parsing), `POST /api/incidents/lookup` (read-only lookup);
- `/api/public/*` (config / locale / data / alerting-sink).
