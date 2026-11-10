# API reference (HTTP API)

| Item | Description |
|---|---|
| Audience | Platform admins and data engineers who call the platform from scripts / the command line, or who troubleshoot why a page request failed |
| Estimated time | About 20 minutes to read §1; look up §2–§3 as needed |
| Prerequisites | You can already sign in to the platform in a browser; you know the platform address (the domain of the login page); you have an account that belongs to a workspace |
| What you get | You can obtain a token and call any endpoint; you understand the uniform success / error envelope; you know the endpoints behind every page, which context they need (target · scope · project · environment) and when they are refused |

> Every platform capability is on the pages; the API is the same set of HTTP routes the pages use, there is no separate "public API". This chapter registers them so that automation and troubleshooting are easier.
>
> The API shape is that of 2.2.0; paths marked "Retired" still respond (410) but no longer provide the capability.

## 1. How to call

### 1.1 Basic conventions

- Base URL = the platform address; paths start with `/api/`, for example `https://<platform-domain>/api/public/version`.
- Request bodies and responses are JSON (except a few export endpoints, noted in the tables); send the request header `Content-Type: application/json`.
- Every response carries an `x-correlation-id` response header; when reporting a problem, provide this value together with the time — the logs can be chained along the whole request path by it.
- There is an edge rate limit between the browser and the platform; when it is exceeded or the gateway fails, the response is an HTML error page, not JSON (the pages reshape it into the standard error envelope automatically; scripts must check `Content-Type` themselves).

### 1.2 Authentication: Cognito ID token

Except for `/api/public/*`, every `/api/*` route requires the request header `Authorization: Bearer <ID token>`.
The token comes from the platform's Cognito user pool; the server verifies the issuer, the audience (client id) and `token_use = id`, and **accepts ID tokens only, not access tokens**. A missing / expired / wrong token always yields 401:

```json
{ "success": false, "error": { "message": "未认证或登录态已失效，请重新登录", "correlationId": "…" } }
```

After signing in through the browser, the pages attach the token for you. When calling from a script, obtain the token yourself: the user pool client has both the `USER_PASSWORD_AUTH` and `USER_SRP_AUTH` flows enabled, so you can get one directly with the AWS CLI (no client secret needed):

```bash
# 1) Get the user pool / client id (public information, no login required)
curl -s https://<platform-domain>/api/public/config
# => { "success": true, "data": { "userPoolId": "<region>_xxxx", "clientId": "…", "region": "<region>" } }

# 2) Exchange username + password for an ID token (valid for about 1 hour by default; run again after it expires)
TOKEN=$(aws cognito-idp initiate-auth --region <region> \
  --auth-flow USER_PASSWORD_AUTH --client-id <clientId> \
  --auth-parameters USERNAME=<username>,PASSWORD=<password> \
  --query AuthenticationResult.IdToken --output text)

# 3) Call
curl -s -H "Authorization: Bearer $TOKEN" -H "x-bgp-project: <project id>" \
  "https://<platform-domain>/api/monitor/runs?scope=global&limit=20"
```

Notes:

- If Cognito requires a newly created account to change its password at first login (`NEW_PASSWORD_REQUIRED`), complete the first login and password change on the page first, then obtain the token from the script.
- The password appears only in your own terminal; do not write it into a script repository or paste it into tickets.
- Both flows are currently enabled (on the infra side `authFlows: { userPassword: true, userSrp: true }`); a later version may keep only `USER_SRP_AUTH`, in which case switch to the SDK's SRP flow to obtain tokens. Write scripts so that they re-obtain the token on 401; do not rely on long-lived tokens.

### 1.3 Public endpoints (no login)

| Path | Purpose |
|---|---|
| `GET /api/public/version` | The running platform version: `releaseTag` / `productCommit` / `productCommitAt` / `version`; `known:false` when it cannot be determined, never made up |
| `GET /api/public/config` | The Cognito user pool id / client id / region needed to sign in (public identifiers) |
| `GET /api/public/locale` | Suggests the initial language (`zh` / `en`) from the visitor's IP; a language chosen manually on the page always wins |
| `POST /api/public/alerting-sink` | Self-test receiver for the alerting "Generic webhook" channel: only records the payload and always returns 200; what was received is shown in "Alerting Center" |
| `/api/public/data/{…}` | "Data Service" is retired: every method returns 410 `{ "code": "GONE", "since": "2026-09-05" }` plus a Chinese `message` saying the capability was retired in 2026-09 |

### 1.4 Role restrictions

- **Platform admin group `bgp-admin`**: `/api/admin/**` requires this group at the gateway layer, and non-admins always get 403 (the gateway returns the same text as for analyst accounts: "Analyst accounts may only use GenBI and submit requests"); each admin route checks again internally. GET is no exception: reads such as `/api/admin/lake-routes` and `/api/admin/lake-buckets/candidates` also return 403 to non-admin scripts.
- **Accounts that belong only to `bgp-analyst` (operations analyst)**: the gateway lets through only the routes below; every other `/api/*` returns 403 "Analyst accounts may only use GenBI and submit requests":

  | Prefix | Methods | Purpose |
  |---|---|---|
  | `/api/genbi/**` | GET · POST | GenBI: ask / history / cards |
  | `/api/redshift/connections` | GET | The workgroup selector on the GenBI page |
  | `/api/redshift/databases` | GET | The database selector on the GenBI page |
  | `/api/requirements/**` | GET · POST | Submit requests / my requests |
  | `/api/projects` | GET | The project switcher (read-only) |

- **Project roles** (owner ⊇ editor ⊇ viewer): most business endpoints check the minimum role against the "current project" or "the project the resource belongs to"; not a member ⇒ 403 "No access to this workspace", role too low ⇒ 403 "Insufficient permission: a higher project role is required".
- **Project config admin** = a platform admin, or a `bgp-manager` who is the owner of this project: renaming / deleting the project, adding / removing members and approval decisions use this level.

- The analyst allow-list only admits GET / POST, so an analyst cannot delete their own GenBI cards (`DELETE /api/genbi/cards/{cardId}` returns 403); ask an admin to delete them when needed.

### 1.5 Workspace and environment context

The pages put the currently selected workspace and environment into two request headers; scripts must send them themselves:

| Request header | Meaning | Default |
|---|---|---|
| `x-bgp-project` | The current workspace id (visible on the "Workspace" page) | `proj-default` (the default workspace; it has no implicit roles — not a member ⇒ 403 "No access to this workspace"; platform admins are treated as owner) |
| `x-bgp-env` | The current environment: `dev` / `staging` / `prod` | `dev` |

List endpoints filter by these two values; endpoints that operate by id check permissions against **the resource's own** project, regardless of which project you currently have selected.
When the environment is `prod`, "Publish to environment" and the data catalog's "New table / Alter table" are not executed directly; an approval request is created instead (response 202 with `approvalId`) and executed after a project owner approves it under "Workspace → Approvals".

- Before calling from a script, confirm on the page that you are a member of the target workspace ("System → Workspace", look at "My roles"); otherwise your very first request hits 403 "No access to this workspace".

### 1.6 Target (targetId) and execution scope (scope)

These are two different things, and the endpoint tables mark them separately as "target" and "scope":

- **Target**: every endpoint that really does something in an execution environment (querying the warehouse, creating tables, starting jobs, listing that region's VPCs …) requires you to **name** the execution environment: query parameter `?targetId=`, body field `targetId`, or `targets[]` when creating an object. Missing ⇒ 400 `PLACE_UNDECIDABLE`, **it never defaults to the home region**; naming an environment that does not exist, has been deleted or is not yet installed ⇒ 409 `PLACE_UNAVAILABLE`.
- **Scope**: list-type read endpoints accept the URL query parameter `?scope=`, with only three kinds of value: `global` (everything; an absent parameter also means everything), `<targetId>` (only this region), `cmp:<t1>,<t2>[,<t3>,<t4>]` (compare 2–4 regions). Invalid grammar ⇒ 400 `INVALID_SCOPE`; pointing at a region that does not exist ⇒ 404 `TARGET_NOT_FOUND`; the region is not authorized for this project ⇒ 403 `TARGET_FORBIDDEN`. Write endpoints **do not read** `scope`; the execution environment comes only from the request body or from the object's own binding.
- `targetId` grammar: the prefix `tgt_` + lowercase letters / digits / underscores (first and last character must be a letter or digit, total length ≤ 20); the home region is always `tgt_home`; each region's id is shown on the "Execution Environments" page and by `GET /api/exec-targets?component=any`.
- Before the first data operation on an execution environment in another jurisdiction you must agree to the disclaimer (`POST /api/residency/ack`); otherwise the related write endpoints return 409 and ask you to agree first; the pages guide you with a dialog.

```text
GET  /api/athena/tables?targetId=tgt_usw2_a          ← target: list the table tree in this region
GET  /api/sync?scope=tgt_usw2_a                     ← scope: list only the sync tasks bound to this region
GET  /api/sync?scope=cmp:tgt_home,tgt_usw2_a        ← scope: compare two regions
POST /api/etl-jobs  { "name": "…", "targets": ["tgt_home","tgt_usw2_a"], … }   ← creating an object names the bound regions
```

### 1.7 Long-running operations (202 + polling) and object leases (409)

Requests that wait for an external system to reach a final state (modeling landing / apply / unbind, catalog create / alter table, sync create table, start / stop / delete streaming jobs, workflow publish / take offline / trigger / delete, engine job runs, creating data sources, the various LLM calls …) use the uniform "hybrid response":

1. The server first waits in-process for up to 45 seconds; if the result arrives, it is returned synchronously as is (status code and envelope are byte-for-byte the same as without the background hand-off).
2. If not ⇒ it returns **202**, and `data` in the envelope carries the protocol marker:

   ```json
   { "success": true, "data": { "taskId": "01J…", "kind": "modeling-land", "label": "落地码表",
     "status": "running", "async": true, "protocol": "long-op/1" } }
   ```

3. Poll `GET /api/long-ops/{taskId}` with the same request headers about every 2 seconds (only the creator can read it; anyone else gets 403):

   ```json
   { "success": true, "data": { "taskId": "01J…", "kind": "modeling-land", "label": "落地码表",
     "status": "succeeded", "result": { … }, "resultStatus": 200, "elapsedMs": 61234 } }
   ```

- `status` is one of `running` / `succeeded` / `failed` / `timeout`. On `succeeded`, `result` is the `data` of the synchronous response; on `failed`, `error` is the message text and `errorStatus` / `errorBody` are the status code and envelope the synchronous branch would have returned, so they can be restored byte for byte; `timeout` means it exceeded 5 minutes and was terminated automatically (message "The operation exceeded 5 minutes and was terminated automatically; narrow the scope and retry").
- The pages already do this in the interception layer: when you see "Running in background: <label> (n s elapsed)" in the bottom-right corner, polling is in progress; scripts must implement it themselves.
- `GET /api/ai/tasks/{taskId}` is the legacy path alias of the same endpoint (see §4). The GenBI 202 (`{ "taskId", "status": "pending" }`, without `protocol`) is a separate mechanism; poll `GET /api/genbi/tasks/{taskId}`.
- **Object lease**: while a long-running operation is in progress, a second long-running operation on the same object, or its edit / delete endpoints, always return 409:

  ```json
  { "success": false, "error": { "code": "LONG_OP_IN_PROGRESS",
    "message": "「落地码表」正在进行中(已 37 秒),请等它结束后再操作" } }
  ```

### 1.8 Response envelope and common error codes

Success: `{ "success": true, "data": <result> }`; a few LLM endpoints add a `_meta` (the model id actually used, its source, correlationId).

Failure: `{ "success": false, "error": { "message": "<human-readable>", "code": "<machine code, optional>", "correlationId": "<optional>", "detail": { … optional } } }`.

A few older endpoints return the flat `{ "error": "<text>" }` (noted in the tables); scripts that read the error text must handle both shapes.

| Status | `error.code` | Meaning and your next step |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Invalid input; read `message` |
| 400 | `PLACE_UNDECIDABLE` | `targetId` / `targets` is missing and there is no default to the home region; add the named execution environment |
| 400 | `INVALID_SCOPE` | `?scope=` grammar is invalid; only `global` / `<targetId>` / `cmp:…` are accepted |
| 400 | `SERVERLESS_NODE_UNSUPPORTED` | The workflow contains a node the Serverless scheduler cannot express (external); change the graph |
| 400 / 409 | `LAKE_ROUTE_NOT_FOUND` · `LAKE_ROUTE_AMBIGUOUS` · `LAKE_ROUTE_ALIAS_CONFLICT` · `LAKE_ROUTE_NOT_WRITABLE` · `LAKE_ROUTE_NAMESPACE_CONFLICT` | Lake table-bucket routing: alias / bucket / namespace not matched, ambiguous, alias conflict, target not writable, namespaces overlap; fix it under "Settings → Lake table buckets and routes" |
| 401 | `UNAUTHENTICATED` | Token missing / expired / not an ID token; obtain a new token |
| 403 | `RBAC_DENIED` | Project role or platform group is insufficient |
| 403 | `TARGET_FORBIDDEN` | The execution environment named by the scope is not authorized for this project; ask an admin to grant it under "Execution Environments → Authorized projects" |
| 404 | `NOT_FOUND` | The resource does not exist |
| 404 | `TARGET_NOT_FOUND` | The execution environment named by the scope does not exist / was deleted / has not finished initializing; choose the scope again |
| 409 | `CONFLICT` | Optimistic lock / concurrency conflict; refresh and retry |
| 409 | `LONG_OP_IN_PROGRESS` | The object is held by a long-running operation; wait for it to finish |
| 409 | `PLACE_UNAVAILABLE` | The named execution environment does not exist / is not installed / lacks a component; `detail.targetId` says which one |
| 409 | `DATASOURCE_IN_USE` | The data source is still referenced by sync / streaming tasks when you delete it; `detail` lists the tasks one by one — delete or change the references first |
| 409 | `DATASOURCE_NETWORK_BROKEN` | The user-supplied security group / subnet / secret the data source depends on no longer exists; fix it under "Edit data source → Network configuration" |
| 409 | `JOB_IN_USE` | The job is still referenced by a "Batch Job Node" of a workflow when you delete it; remove the node from the workflow first |
| 409 | `JOB_RUN_IN_PROGRESS` | The job still has in-flight runs when you delete it; `detail.runs` lists the runIds — wait for a final state or stop them first |
| 409 | `START_IN_PROGRESS` | A start is already in progress for the same streaming sync task; wait for it, do not click again |
| 409 | `TEARDOWN_IN_PROGRESS` | The sync channel is still stopping; try again in a few tens of seconds |
| 409 | `DECISION_REQUIRED` | The platform does not take destructive actions on your behalf; `detail` offers the options — retry with `confirm` after the user confirms |
| 409 | `SCHEDULER_NOT_INSTALLED` | The target region has no scheduler component installed; `detail.fix` points to where to install it |
| 409 | `WORKFLOW_SCHEDULER_UNSUPPORTED` | The region runs airflow-serverless, which has no Airflow web console; use the platform's run / node log pages |
| 409 | `SCHEDULER_ARTIFACT_MISSING` | Neither the platform nor the scheduler can find this workflow's scheduling artifact; "Publish" again |
| 409 | `TARGET_PUSHDOWN_UNAVAILABLE` · `CROSS_REGION_SOURCE` · `CHANNEL_NOT_PUSHED_DOWN` | The region the definition is bound to does not match the execution channel / source and execution region differ (data leaving the region, always refused) / the channel is not yet per-region; change the binding or the channel |
| 409 | `GENBI_CARD_QUOTA_EXCEEDED` · `GENBI_CARD_TOO_LARGE` | Card quota is full / a single card exceeds the limit; the message gives used / limit |
| 409 | `PREVIEW_DRIFT` · `NOT_DRAINED` · `IMPACT_NOT_ZERO` · `USE_DISCARD` etc. | Refusal reasons of the individual steps of deleting an execution environment; each states the next step |
| 410 | `GONE` | The capability is retired (Data Service / two legacy execution-environment endpoints) |
| 502 | `UPSTREAM_ERROR` | A dependent AWS / OpenMetadata call failed; `message` carries the original wording |
| 504 | `UPSTREAM_TIMEOUT` | A dependency timed out (also used when a long-running operation hits the 5-minute ceiling) |
| 500 | `INTERNAL` | Unclassified error; report it with the `x-correlation-id` |

### 1.9 Tags used in the "Requires" column of the §3 tables

| Tag | Meaning |
|---|---|
| target | The execution environment must be named (`?targetId=` / body `targetId` / `targets[]`); "(subset)" means `targets` is optional and defaults to all of the object's bound regions |
| scope | The read endpoint accepts `?scope=` (see §1.6); "read scope" means only the GET side filters by scope |
| project viewer / editor / owner | You need at least that role in the current project (or the resource's project); "project config admin" see §1.4 |
| admin | Requires the platform admin group `bgp-admin`; "write admin" means GET only needs sign-in while write methods need admin |
| signed in | Any signed-in user |
| long-running | May return 202 and require polling (§1.7); another operation on the same object while in progress ⇒ 409 |
| audited | Write operations go to "Audit Log" |
| public / internal / retired | No login / reachable only inside the platform (403 from the internet) / always returns 410 |

## 2. Endpoint groups at a glance

52 groups and 315 paths in total. "Endpoints" counts path files (one path may have several methods).

| Group | Path prefix | Endpoints | What it does | Page |
|---|---|---|---|---|
| `admin` | `/api/admin` | 45 | Administration: execution environment lifecycle · lake table-bucket routing · AI model · users · platform security-group cleanup | Execution Environments / Settings / Users |
| `ai` | `/api/ai` | 1 | Legacy path alias for long-running operation polling | — |
| `alerting` | `/api/alerting` | 8 | Alert rules · notification channels · event stream · evaluate now | Alerting Center |
| `approvals` | `/api/approvals` | 2 | Approvals: join a project / publish to prod / delete an execution environment / create or alter tables in prod | Workspace |
| `athena` | `/api/athena` | 5 | Athena query on the data lake (S3 Tables): table tree · start / check status / fetch results / cancel | Athena Query |
| `audit` | `/api/audit` | 1 | Operation audit entries | Audit Log |
| `backfill` | `/api/backfill` | 6 | Backfill plans: create · progress matrix · pause / resume / cancel / retry failed | Backfill Center |
| `baseline` | `/api/baseline` | 3 | Task duration baselines (per task × region) and manual learning | Alerting Center |
| `bi` | `/api/bi` | 10 | Report widgets · dashboards · analyses · fetch data / export / field discovery | Report Builder |
| `copilot` | `/api/copilot` | 9 | Copilot chat · execution plans (generate / confirm / advance) · recipes | Copilot Plan Center |
| `datasources` | `/api/datasources` | 10 | Data sources: list / create / edit / delete · test · detect · browse tables · S3 external tables | Data Sources |
| `diagnostics` | `/api/diagnostics` | 2 | AI fault diagnosis (start / read the report) | Task Monitor |
| `engines` | `/api/engines` | 12 | EMR Serverless engine jobs: definitions · runs · schedules · logs · AI code generation | Batch Compute |
| `etl-jobs` | `/api/etl-jobs` | 12 | Batch jobs (Glue / Redshift SQL): definitions · runs · backfill · schedules · dependency upload | Batch Compute |
| `exec-roles` | `/api/exec-roles` | 2 | Candidates for the task execution role dropdown and the "Check permissions" preflight | Batch Compute / Stream Compute |
| `exec-targets` | `/api/exec-targets` | 1 | The execution environments available to the current project (choose an execution environment / top-bar scope) | Top bar / every creation wizard |
| `finops` | `/api/finops` | 9 | Cost overview · task attribution · budgets · anomalies · optimization advice · collection | FinOps |
| `flink` | `/api/flink` | 15 | Stream compute (Flink SQL): jobs · start / stop · generate data · results · connectors · network facts | Stream Compute |
| `genbi` | `/api/genbi` | 16 | GenBI: ask · history · cards and scheduled refresh · business definitions · skills | Ask-Your-Data / Business Glossary & Rules / Skills |
| `governance` | `/api/governance` | 22 | Governance: catalog · classification and masking · quality · lineage / impact · sensitive scan · scheduled tasks · create / alter tables | Data Governance / Governance Workbench |
| `incidents` | `/api/incidents` | 6 | Incident knowledge base: incident categories · fix runbooks · silence · masked export | Incident Knowledge Base |
| `internal` | `/api/internal` | 4 | Platform-internal endpoints (dispatch Lambda / in-process advance pump), unreachable from the internet | — |
| `lineage` | `/api/lineage` | 1 | SQL lineage parsing preview | Batch Compute |
| `long-ops` | `/api/long-ops` | 1 | Long-running operation polling (unified framework) | Site-wide ("Running in background" in the bottom-right corner) |
| `metadata-mirror` | `/api/metadata-mirror` | 1 | Read-only overview of the cross-region metadata mirror | Data Governance |
| `metrics` | `/api/metrics` | 4 | Metrics: list / create / compute (values per region) | Data Modeling (Metric system) |
| `modeling` | `/api/modeling` | 22 | Data modeling: layers · data domains · standards · code tables · dimension / fact tables · metrics · land / unbind | Data Modeling |
| `monitor` | `/api/monitor` | 2 | Run instance list and run logs | Task Monitor |
| `multi-region` | `/api/multi-region` | 1 | Version consistency matrix | Multi-Region Dashboard |
| `network-advisor` | `/api/network-advisor` | 3 | Network advisor: probe · AI advice · one-click fix | Data Sources / Stream Compute / Batch Compute |
| `observability` | `/api/observability` | 1 | GenBI observability dashboard data | Observability |
| `openmetadata` | `/api/openmetadata` | 1 | Governance Center (OpenMetadata) access URL | Governance Center |
| `ops` | `/api/ops` | 1 | Aggregated data for the ops dashboard | Ops Dashboard |
| `param-advisor` | `/api/param-advisor` | 2 | Parameter advisor: deterministic recommendation · AI advice | Batch Compute / Stream Compute / Data Sync |
| `projects` | `/api/projects` | 4 | Workspaces: list / create / rename / delete · members | Workspace / top-bar project switcher |
| `promote` | `/api/promote` | 2 | Publish to environment (dev / staging / prod) and publish lineage | "Publish to environment" on each resource's details |
| `public` | `/api/public` | 5 | Endpoints without login: version · login config · language suggestion · alerting self-test receiver · the retired Data Service | Login page / Settings |
| `redshift` | `/api/redshift` | 10 | Warehouse query: workgroups / databases / schemas · execute · results · cancel · history · saved query tasks | Redshift Query |
| `requirements` | `/api/requirements` | 8 | Requests workbench: submit · assign · comment · generate implementation · one-click create job · state transitions | Requests |
| `residency` | `/api/residency` | 1 | Consent to the cross-jurisdiction disclaimer | Dialog on the first cross-jurisdiction operation |
| `role-advisor` | `/api/role-advisor` | 2 | Execution role advisor: least-privilege recommendation · one-click role creation | Batch Compute / Stream Compute |
| `run-groups` | `/api/run-groups` | 3 | Multi-region run groups: whole-group view · cancel · retry failed regions | Task Monitor / run history |
| `s3` | `/api/s3` | 1 | S3 bucket inventory of the account (service status) | Settings |
| `schedule` | `/api/schedule` | 1 | Enable / disable scheduling (workflow / sync / governance / card / seeding) | Task Monitor → Schedule config |
| `scope` | `/api/scope` | 1 | "N more in other scopes" counts | Top-bar execution scope |
| `seed` | `/api/seed` | 3 | Demo seeding: seed now · scheduled seeding (demo mode) | Task Monitor → Schedule config |
| `settings` | `/api/settings` | 1 | Settings page data (resource facts of the current region / effective model / service status) | Settings |
| `sla` | `/api/sla` | 4 | SLA definitions · prediction · risk board | Alerting Center / Ops Dashboard |
| `sync` | `/api/sync` | 16 | Sync tasks: list / create / edit / delete · start / stop · create table · runs and logs · streaming status | Data Sync |
| `system` | `/api/system` | 1 | Wiring health check | Settings → Wiring status |
| `versions` | `/api/versions` | 1 | Resource version history and rollback | "Version" on each resource's details |
| `workflow` | `/api/workflow` | 10 | ETL orchestration: workflows · publish / take offline · trigger · run nodes and logs · Airflow console | ETL Orchestration |

## 3. Group details

The "Requires" column uses short tags; their meaning is in the tag table of §1.9. `{…}` in a path is a path parameter; `{ … }` in the Purpose column lists request body fields, and `?a=&b=` lists query parameters.

### 3.1 admin — administration

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/admin/datasource-network-objects` | List of the security groups the platform created for data sources (platform-wide), marked in use / orphan / pending cleanup / needs manual action, with network interface counts; read-only, not filtered by scope | admin | Settings |
| POST | `/api/admin/datasource-network-objects/cleanup` | `{ sgId, region, targetId }` hands an orphaned platform security group to background cleanup; the server re-verifies "platform group / no data source references / zero network interfaces" and returns 409 / 404 when a check fails | admin · target · audited | Settings |
| POST | `/api/admin/datasources/placement-backfill` | Backfills the "owning execution environment" field of existing data sources; fills only missing values and can be run repeatedly | admin · audited | No page entry (operations) |
| GET | `/api/admin/exec-envs` | Execution environment list (admin view, returned as is including abnormal items); filterable by `region` / `stage` / `status` | admin | Execution Environments |
| GET | `/api/admin/exec-envs/candidate-regions` | The regions selectable when creating an execution environment (from the regions really available to the account) | admin | Execution Environments → New |
| GET | `/api/admin/exec-envs/preflight` | Retired: always 410 (execution environments have zero egress, so the EIP quota preflight is no longer needed) | admin · retired | — |
| POST | `/api/admin/exec-envs/register` | Registers a new execution environment (first step of the page wizard); `targetId` is generated by the server, and a request body that carries one is always 400 | admin · audited | Execution Environments → New |
| POST | `/api/admin/exec-envs/seed-home` | Writes the home-region descriptor at deployment time (an explicit admin action called by the deployment script) | admin · audited | No page entry (deployment script) |
| GET | `/api/admin/exec-envs/{targetId}` | Details of one execution environment (admin view) | admin | Execution Environments → Details |
| POST | `/api/admin/exec-envs/{targetId}/access` | Sets the project allow-list of this execution environment (open to all projects by default) | admin · audited | Execution Environments → Details "Authorized projects" |
| GET | `/api/admin/exec-envs/{targetId}/acks` | Looks up every disclaimer consent record of this execution environment; the home jurisdiction returns an empty list | admin | Execution Environments → Details "Consents" |
| POST | `/api/admin/exec-envs/{targetId}/add-components` | Supplementary deployment: adds components to an existing execution environment | admin · audited | Execution Environments → Details |
| GET | `/api/admin/exec-envs/{targetId}/build-status` | `?buildId=` reads the deployment progress (build state and log summary) | admin | Execution Environments → Details |
| GET / POST | `/api/admin/exec-envs/{targetId}/canary` | GET the latest permission canary verdict for each project in use; POST `{ projectId, action, confirm }` starts one | admin · audited | Execution Environments → Details |
| POST | `/api/admin/exec-envs/{targetId}/credential-state` | Advances the credential isolation state of this execution environment | admin · audited | Execution Environments → Details |
| GET | `/api/admin/exec-envs/{targetId}/delete-preview` | Impact preview before deletion: the three counts bound resources / enabled schedules / running runs with details, the data resources that will be kept, and `previewHash` | admin | Execution Environments → Delete |
| POST | `/api/admin/exec-envs/{targetId}/delete-request` | `{ confirm, previewHash }` requests deletion; `confirm` must equal the environment's region verbatim; an expired preview returns 409 `PREVIEW_DRIFT` | admin · audited | Execution Environments → Delete |
| POST | `/api/admin/exec-envs/{targetId}/deploy` | Triggers a deployment (returns `buildId` / `lockEpoch`); both "New" and "Redeploy" use it | admin · audited | Execution Environments |
| POST | `/api/admin/exec-envs/{targetId}/destroy-observe` | Observes the destroy progress and closes it out; polled by the details page while destroying | admin · audited | Execution Environments → Details |
| POST | `/api/admin/exec-envs/{targetId}/destroy-retry` | `{ confirm }` retries the destroy (`confirm` = region) | admin · audited | Execution Environments → Details |
| POST | `/api/admin/exec-envs/{targetId}/discard` | `{ confirm, decisionId }` discards an execution environment that never deployed successfully (`confirm` = targetId) | admin · audited | Execution Environments → Details |
| POST | `/api/admin/exec-envs/{targetId}/drain` | `{ reason }` "Stop accepting work": no new work is accepted, in-flight work finishes; the first step of the deletion flow | admin · audited | Execution Environments → Details |
| POST | `/api/admin/exec-envs/{targetId}/enable` | "Enable": marks the environment usable after the real probes pass | admin · audited | Execution Environments → Details |
| POST | `/api/admin/exec-envs/{targetId}/intent` | `{ intent }` drain / resume accepting work | admin · audited | Execution Environments → Details |
| GET | `/api/admin/exec-envs/{targetId}/jobs` | `?kind=supply\|canary` the data-plane background jobs of this environment (newest first) | admin | Execution Environments → Details |
| GET / POST | `/api/admin/exec-envs/{targetId}/jobs/{jobId}` | GET one background job; POST "Advance now" by one step | admin · audited | Execution Environments → Details |
| POST | `/api/admin/exec-envs/{targetId}/network-profile` | Retired: always 410 (with zero egress there is no network profile to adjust) | admin · retired | — |
| GET / POST | `/api/admin/exec-envs/{targetId}/preview` | "Preview before approving" ahead of a supplementary deployment: POST starts a change dry run; GET `?buildId=` fetches the verdict (pending / unavailable / ready) | admin · audited | Execution Environments → Details |
| POST | `/api/admin/exec-envs/{targetId}/probe` | "Check initialization": probes and advances the lifecycle | admin · audited | Execution Environments → Details |
| POST | `/api/admin/exec-envs/{targetId}/provision-credentials` | Provisions this environment's warehouse credentials for a project | admin · audited | Execution Environments → Details |
| POST | `/api/admin/exec-envs/{targetId}/provisioning-deadline` | `{ extendDays \| provisioningDeadlineAt, reason }` extends the initialization window (1–30 days) | admin · audited | Execution Environments → Details |
| GET / POST | `/api/admin/exec-envs/{targetId}/recover` | Recovery entry after a failed deployment session: GET shows the available actions; POST `{ decisionId, confirm }` executes one | admin · audited | Execution Environments → Details "Resume" |
| POST | `/api/admin/exec-envs/{targetId}/retire-components` | Removes the record of a component that no longer exists in the live environment | admin · audited | Execution Environments → Details |
| POST | `/api/admin/exec-envs/{targetId}/scheduler-preference` | When both schedulers are installed, chooses which one later publishes go to; already published jobs are unaffected | admin · audited | Execution Environments → Details |
| GET | `/api/admin/exec-envs/{targetId}/statements` | `?auditId=` looks up the statements executed across jurisdictions by audit id | admin | Audit Log / Execution Environments |
| GET / POST / DELETE | `/api/admin/lake-buckets` | Compatibility alias of lake table-bucket routing (same handler as `/api/admin/lake-routes`, see §4); GET reads, POST registers, DELETE revokes | target · admin (the gateway requires bgp-admin even for GET) | Settings → Lake table buckets and routes |
| GET | `/api/admin/lake-buckets/candidates` | `?targetId=` the S3 Tables table buckets in the account in the region of this execution environment (marking the platform bucket / registered external buckets) | target · admin (the route only needs sign-in, but the gateway requires bgp-admin for /api/admin/**) | Data sync wizard / Settings |
| GET / POST / PUT / PATCH / DELETE | `/api/admin/lake-routes` | Table-bucket route table: GET `?targetId=` the route set (the route only needs sign-in, the gateway still requires bgp-admin); POST registers `{ targetId, bucket, alias?, tier?, writable?, namespaces?, label? }`; PUT / PATCH modifies; DELETE `?targetId=&bucket=` revokes (409 while still referenced) | target · admin (the gateway requires bgp-admin even for GET) | Settings → Lake table buckets and routes |
| POST | `/api/admin/metadata-mirror` | `{ targetId }` manually triggers metadata collection for one execution environment ("Sync now" / "Collect warehouse catalog") | admin · target · audited | Data Governance |
| GET / PUT / DELETE | `/api/admin/model-config` | Default LLM: GET the current configuration; PUT `{ modelId, settingScope, expectVersion }` saves it (takes effect only after the server's real probe passes); DELETE clears it | admin | Settings → AI model |
| GET | `/api/admin/model-config/catalog` | `?targetId=` the selectable model catalog (with `families[]` groups and probe cache) | admin · target | Settings → AI model |
| POST | `/api/admin/model-config/probe` | Probes one model with a real call; limited to 6 per minute per admin | admin | Settings → AI model |
| GET / PUT | `/api/admin/model-config/transport` | Transport gate state of the GPT series (GET reads, PUT changes) | admin | No page entry |
| GET | `/api/admin/pending-cleanups` | List of background cleanup jobs for platform security groups: those still waiting for network interfaces to be released + those whose budget ran out and need manual action | admin | Settings |
| GET / POST / PUT | `/api/admin/users` | GET lists users; POST `{ username, email, password, role }` creates an account; PUT `{ username, action, role?, password? }`, action = disable / enable / changeRole / resetPassword | admin · audited | Users |

### 3.2 ai — legacy alias

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/ai/tasks/{taskId}` | GET legacy path alias for long-running operation polling, same handler as `/api/long-ops/{taskId}` (see §4) | signed in | — |

### 3.3 alerting — Alerting Center

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET / POST | `/api/alerting/channels` | GET the notification channel list (secrets masked); POST creates a channel | project viewer / editor · audited | Alerting Center → Notification Channels |
| GET / PUT / DELETE | `/api/alerting/channels/{id}` | Get / update / delete one channel | project viewer / editor · audited | Alerting Center → Notification Channels |
| POST | `/api/alerting/channels/{id}/test` | Sends one test message to the channel and returns the immediate delivery result | project editor · audited | Alerting Center → Notification Channels "Test" |
| POST | `/api/alerting/evaluate` | "Evaluate now" the alert rules once; the same run / window is not alerted twice | project editor · audited | Alerting Center |
| GET | `/api/alerting/events` | `?ruleId=&limit=` the alert event stream; without ruleId, the most recent events | project viewer · scope | Alerting Center → Alert Events |
| GET / POST | `/api/alerting/rules` | GET the rule list (by scope); POST creates a rule | project viewer / editor · scope · audited | Alerting Center → Alert Rules |
| GET / PUT / DELETE | `/api/alerting/rules/{id}` | Get / update / delete one rule (permission checked against the rule's project) | project viewer / editor · audited | Alerting Center → Alert Rules |
| GET | `/api/alerting/test-sink` | Shows the most recent self-test deliveries received (together with `/api/public/alerting-sink`) | project viewer | Alerting Center |

### 3.4 approvals — approvals

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET / POST | `/api/approvals` | GET the approval list: `?mine=1` my requests / `?projectId=` one project / `?status=pending`; by default the pending approvals of the projects I own; POST `{ projectId, type?, role }` requests to join a project | signed in · read scope · audited | Workspace → Approvals |
| POST | `/api/approvals/{id}` | `{ decision: approve\|reject, reason? }` approves / rejects; approval executes immediately: add member / publish to environment / delete execution environment / create or alter table (the last is a long-running operation) | project config admin · long-running · audited | Workspace → Approvals |

### 3.5 athena — Athena Query

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| POST | `/api/athena/query` | `{ sql, targetId, … }` starts one read-only Athena query | target · project viewer | Athena Query |
| GET | `/api/athena/query/{id}` | `?targetId=` query state and statistics (bytes scanned / duration) | target · project viewer | Athena Query |
| GET | `/api/athena/query/{id}/results` | `?targetId=&nextToken=` fetches the results (columns + rows, paginated) | target · project viewer · audited | Athena Query |
| POST | `/api/athena/query/{id}/stop` | `?targetId=` cancels a running query | target · project viewer · audited | Athena Query |
| GET | `/api/athena/tables` | `?targetId=` the data-lake table tree of that region (platform bucket + registered external buckets, each namespace with bucket / catalog) | target · project viewer | Athena Query / Ask-Your-Data / Data Governance |

### 3.6 audit — Audit Log

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/audit` | `?scope=&limit=` operation audit entries (newest first) | scope · signed in | Audit Log |

### 3.7 backfill — Backfill Center

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/backfill` | The current project's backfill plans | project viewer · scope | Backfill Center |
| POST | `/api/backfill/plan` | Creates a backfill plan (validates targets and the date range; concurrency for sync tasks is fixed at 1) | project editor · audited | Backfill Center → New |
| GET | `/api/backfill/targets` | `?include=` the dropdown of backfillable targets (filtered by scope) | project viewer · scope | Backfill Center → New |
| GET | `/api/backfill/{planId}` | Plan details + the date × node progress matrix (each cell with the underlying run facts and a zero-row hint) | project viewer | Backfill Center → Details |
| POST | `/api/backfill/{planId}/control` | `{ action: pause\|resume\|cancel\|retry-failed }` | project editor · audited | Backfill Center → Details |
| POST | `/api/backfill/{planId}/tick` | Advances once, idempotently (refresh / manual / timer may all call it; nothing is submitted twice) | project editor | Backfill Center → Details |

### 3.8 baseline — duration baselines

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/baseline` | Duration baselines of every task in the current project, flattened by "task × region" | project viewer · scope | Alerting Center → SLA & Baseline Alerts |
| POST | `/api/baseline/learn` | `{ taskId? }` learns baselines once by hand; without taskId, all of them | project editor · audited | Alerting Center → SLA & Baseline Alerts |
| GET | `/api/baseline/{taskId}` | The learned baseline of one task | project viewer | Alerting Center → SLA & Baseline Alerts |

### 3.9 bi — Report Builder

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET / POST | `/api/bi/analyses` | GET the analysis list (filtered by scope only with `?scopeFilter=1`); POST creates one | project viewer / editor · audited | Report Builder |
| GET / PUT / DELETE | `/api/bi/analyses/{id}` | Get / update (optimistic lock) / delete an analysis | project viewer / editor · audited | Report Builder |
| POST | `/api/bi/analysis-query` | `{ widget, filters?, filterValues? }` fetches data for an analysis (results are masked) | project viewer | Report Builder |
| GET / POST | `/api/bi/dashboards` | GET the dashboard list; POST creates one | project viewer / editor · audited | Report Builder |
| GET / PUT / DELETE | `/api/bi/dashboards/{id}` | Get / update (optimistic lock) / delete a dashboard | project viewer / editor · audited | Report Builder |
| POST | `/api/bi/export` | `{ source, filters?, filterValues?, filename? }` exports CSV (the response is a `text/csv` attachment) | project viewer | Report Builder |
| POST | `/api/bi/query` | `{ source, filters?, filterValues? }` fetches / previews data (results are masked) | project viewer | Report Builder |
| GET / POST | `/api/bi/reports` | GET the report widget list (filtered by scope only with `?scopeFilter=1`, each row with `regions`); POST creates one | project viewer / editor · audited | Report Builder |
| GET / PUT / DELETE | `/api/bi/reports/{id}` | Get / update (optimistic lock) / delete a report widget | project viewer / editor · audited | Report Builder |
| GET | `/api/bi/schema` | `?engine=redshift\|athena&targetId=` the tables and columns selectable in the field configurator | target · project viewer | Report Builder |

### 3.10 copilot — Copilot Plan Center

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| POST | `/api/copilot/ask` | `{ prompt, conversationId? }` Copilot chat (LLM; goes to the background after 45 seconds) | signed in · long-running | Copilot Plan Center |
| GET / POST | `/api/copilot/plan` | GET the current project's execution plans (newest first); POST `{ prompt }` generates a plan asynchronously and returns `taskId` immediately | read scope · write project editor · audited | Copilot Plan Center |
| GET | `/api/copilot/plan/task/{taskId}` | Polls a planning task; on success the plan + steps are embedded | signed in | Copilot Plan Center |
| GET | `/api/copilot/plan/{planId}` | Plan details + step matrix | signed in | Copilot Plan Center → Details |
| POST | `/api/copilot/plan/{planId}/confirm` | `{ stepId }` confirms one step: creates the corresponding draft object, does not execute it | project editor · audited | Copilot Plan Center → Details |
| POST | `/api/copilot/plan/{planId}/control` | `{ action: pause\|resume\|cancel }`; optimistic lock conflict 409 | project editor · audited | Copilot Plan Center → Details |
| POST | `/api/copilot/plan/{planId}/tick` | Advances once (only reconciles and unlocks; never executes a step on your behalf) | project editor | Copilot Plan Center → Details |
| GET / POST | `/api/copilot/recipes` | GET the recipe list (built-in + admin extensions); POST adds an admin recipe | read signed in · write admin · audited | Copilot Plan Center |
| DELETE | `/api/copilot/recipes/{recipeId}` | `?engine=` deletes an admin recipe (built-in recipes cannot be deleted) | admin · audited | Copilot Plan Center |

### 3.11 datasources — Data Sources

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET / POST | `/api/datasources` | GET the list (by scope); POST `{ targetId, type, name, connection, jdbcParams?, probeVia, provision }` creates one; the connection and security-group provisioning segment is a long-running operation | write target · read scope · project viewer / editor · long-running · audited | Data Sources |
| GET | `/api/datasources/discover` | `?targetId=` discovers RDS instances and secrets in that region ("Select from RDS" in the creation wizard) | target | Data Sources → New |
| GET | `/api/datasources/kinesis-streams` | Lists the existing Kinesis streams (the "Use existing stream" dropdown when creating a streaming source); lists only the home region's streams, regardless of the selected execution environment | project viewer | Data Sources → New |
| GET | `/api/datasources/msk-clusters` | Lists the existing MSK clusters (the "Select cluster" dropdown when creating a streaming source); lists only the home region's clusters, regardless of the selected execution environment | project viewer | Data Sources → New |
| POST | `/api/datasources/test` | `{ type, host, port, database, username, password }` tests the connection; for JDBC sources it only checks that the Glue connection exists | project editor | Data Sources → New "Test connection" |
| GET / PUT / DELETE | `/api/datasources/{id}` | Details / edit / delete; still referenced by sync or streaming tasks ⇒ 409 `DATASOURCE_IN_USE`; a long-running operation in progress ⇒ 409 | project viewer / editor · audited | Data Sources |
| GET / POST | `/api/datasources/{id}/heartbeat` | "Detect": probes and writes the state back (GET reads the result, POST starts it) | project viewer / editor | Data Sources "Detect" |
| POST | `/api/datasources/{id}/s3-external` | "External table" for an S3 source: discover → choose a dataset → Athena DDL (long-running) | project editor · long-running | Data Sources "External table" |
| GET | `/api/datasources/{id}/schemas` | The databases / schemas of this source | project viewer | Data Sources / sync wizard |
| GET | `/api/datasources/{id}/tables` | `?database=&refresh=` "Browse tables": tables and column structures | project viewer | Data Sources "Browse tables" / sync wizard |

### 3.12 diagnostics — AI fault diagnosis

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET / POST | `/api/diagnostics` | POST `{ taskId, runId }` starts an AI fault diagnosis for one failed run (asynchronous); GET `?taskId=&runId=` reads an existing diagnosis | project viewer · audited | Task Monitor → run details "AI Diagnosis" |
| GET | `/api/diagnostics/{id}` | Diagnosis state and report (polled by the page) | project viewer | Task Monitor → run details |

### 3.13 engines — EMR engine jobs

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| POST | `/api/engines/generate` | `{ prompt, currentCode?, targetId }` AI-generated PySpark code (long-running) | target · project editor · long-running | Batch Compute → EMR job editor |
| GET / POST | `/api/engines/{engine}` | `engine` is currently only `emr-serverless`; GET the job list (by scope, reconciled on read); POST creates `{ name, targets[], lakeBuckets?, defaultCatalogAlias?, network?, sparkConf?, … }` | write target · read scope · project viewer / editor · audited | Batch Compute |
| GET / PUT / DELETE | `/api/engines/{engine}/{id}` | Details / edit (changing the binding requires naming the region) / delete; in-flight runs ⇒ 409 `JOB_RUN_IN_PROGRESS`; referenced by a workflow ⇒ 409 `JOB_IN_USE` | project viewer / editor · audited | Batch Compute |
| POST | `/api/engines/{engine}/{id}/backfill` | `{ startDate, endDate }` submits one run per business date (inclusive, ≤ 31 days) | project editor · audited | Batch Compute "Backfill" |
| GET | `/api/engines/{engine}/{id}/logs` | `?runId=` reads the driver log of one run | project viewer | Batch Compute → run history |
| POST | `/api/engines/{engine}/{id}/rerun` | `{ runId }` reruns with the same business date | project editor · audited | Batch Compute → run history |
| POST | `/api/engines/{engine}/{id}/run` | `{ runDate?, targets? }` "Run now"; the submission segment is a long-running operation; across jurisdictions you must agree to the disclaimer first | project editor · target (subset) · long-running | Batch Compute "Run now" |
| GET | `/api/engines/{engine}/{id}/run-groups` | `?limit=` the most recent multi-region run groups (single-region runs do not form a group) | project viewer | Batch Compute → run history |
| GET | `/api/engines/{engine}/{id}/runs` | Run history | project viewer | Batch Compute → run history |
| POST / DELETE | `/api/engines/{engine}/{id}/schedule` | POST `{ cronExpression, targets? }` publishes a cron schedule (to each region's own scheduler); DELETE takes it offline | project editor · target (subset) · audited | Batch Compute "Schedule" |
| POST | `/api/engines/{engine}/{id}/schedule/trigger` | "Trigger once" the published scheduling artifact | project editor · target (subset) · audited | Batch Compute "Schedule" |
| POST | `/api/engines/{engine}/{id}/stop` | `{ runId? }` stops a run | project editor · audited | Batch Compute → run history |

### 3.14 etl-jobs — Batch Compute

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET / POST | `/api/etl-jobs` | GET the batch job list (by scope); POST creates a Glue / Redshift SQL job (`targets[]` required; a custom execution role is preflighted at save time; table-bucket declarations are validated against the bound regions) | write target · read scope · project viewer / editor · audited | Batch Compute |
| POST | `/api/etl-jobs/generate` | `{ prompt, targetType: redshift\|glue, currentCode?, targetId }` AI-generated job code (long-running) | target · project editor · long-running | Batch Compute → job editor |
| GET / PUT / DELETE | `/api/etl-jobs/{id}` | Details / edit (changing the binding requires naming the region) / delete; in-flight runs ⇒ 409 `JOB_RUN_IN_PROGRESS`; referenced by a workflow ⇒ 409 `JOB_IN_USE` | project viewer / editor | Batch Compute |
| POST | `/api/etl-jobs/{id}/backfill` | `{ startDate, endDate }` runs once per business date (inclusive, ≤ 31 days) | project editor · audited | Batch Compute "Backfill" |
| POST | `/api/etl-jobs/{id}/deps` | Uploads dependency libraries (JAR / .py / .whl / .zip / .egg) to the scripts bucket of the job's target region and returns the S3 URI for `--extra-jars` / `--extra-py-files` | project editor · audited | Batch Compute → Advanced properties "Upload" |
| GET | `/api/etl-jobs/{id}/logs` | `?runId=` reads the log of one run (Glue / Redshift, fetched by region) | project viewer | Batch Compute → run history |
| POST | `/api/etl-jobs/{id}/rerun` | `{ runId }` reruns with the same business date | project editor · audited | Batch Compute → run history |
| POST | `/api/etl-jobs/{id}/run` | `{ runDate?, targets? }` "Run now", fanned out region by region when bound to several regions; across jurisdictions you must agree to the disclaimer first | project editor · target (subset) · audited | Batch Compute "Run now" |
| GET | `/api/etl-jobs/{id}/run-groups` | `?limit=` the most recent multi-region run groups | project viewer | Batch Compute → run history |
| GET | `/api/etl-jobs/{id}/runs` | Run history (the most recent 50) | project viewer | Batch Compute → run history |
| GET / POST / DELETE | `/api/etl-jobs/{id}/schedule` | GET reads the schedule; POST `{ cronExpression, targets? }` publishes; DELETE takes it offline; the target region lacks a scheduler component ⇒ 409 `SCHEDULER_NOT_INSTALLED` | project viewer / editor · target (subset) · audited | Batch Compute "Schedule" |
| POST | `/api/etl-jobs/{id}/schedule/trigger` | "Trigger once" the published scheduling artifact | project editor · target (subset) · audited | Batch Compute "Schedule" |

### 3.15 exec-roles — task execution roles

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/exec-roles/candidates` | `?engine=glue\|emr\|flink&targetId=` the three candidate groups of the "Execution Role" dropdown; an IAM read failure ⇒ 502 | target · signed in | Batch Compute / Stream Compute → Execution Role |
| POST | `/api/exec-roles/preflight` | `{ engine, targetId, roleArn, extraS3Uris?, scriptCode? }` "Check permissions": complete / N missing / cannot be measured; a preview only — the server measures again on save | target · signed in | Batch Compute / Stream Compute "Check permissions" |

### 3.16 exec-targets — available execution environments

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/exec-targets` | `?component=redshift\|airflow\|core\|any` the execution environments available to the current project; `any` feeds the top-bar "Execution scope" dropdown | project viewer | Top bar / Batch Compute / ETL Orchestration / Redshift Query / Data Modeling |

### 3.17 finops — FinOps

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/finops/advice` | Optimization advice (probed separately for every region in scope) | project viewer · scope | FinOps |
| GET | `/api/finops/anomalies` | The current cost anomalies (read-only detection) | project viewer · scope | FinOps |
| GET / POST | `/api/finops/budgets` | GET the budget list; POST creates a budget | project viewer / owner · read scope | FinOps → Budgets |
| PUT / DELETE | `/api/finops/budgets/{id}` | Updates (optimistic lock `version`) / deletes a budget | project owner | FinOps → Budgets |
| POST | `/api/finops/collect` | `?backfill=1` collects by hand (Cost Explorer daily costs + task attribution); idempotent | project editor | FinOps "Collect" |
| POST | `/api/finops/detect` | Anomaly detection + channel push + knowledge base deposit + budget evaluation; idempotent | project editor | FinOps "Detect" |
| GET | `/api/finops/overview` | Cost overview (by scope, with region cards) | project viewer · scope | FinOps |
| GET | `/api/finops/tasks` | Task-level cost ranking (one row per task × region; the count is returned with the response) | project viewer · scope | FinOps → Task costs |
| GET | `/api/finops/tasks/{taskId}` | Cost details of one task (each run with `effectiveTargetId`) | project viewer | FinOps → Task costs |

### 3.18 flink — Stream Compute

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| POST | `/api/flink/ai-sql` | Generates Flink SQL from natural language (long-running); the synchronous response is `{ sql, model, usage, dialect }` | project editor · long-running | Stream Compute → job editor |
| GET / POST | `/api/flink/connectors` | GET the custom connectors of the current project + environment; POST uploads one | project viewer / editor · audited | Stream Compute → Connectors |
| DELETE | `/api/flink/connectors/{id}` | Deletes a custom connector (together with its JAR on S3) | project editor · audited | Stream Compute → Connectors |
| GET / POST | `/api/flink/jobs` | GET the streaming job list (by scope; the real state is reconciled on read); POST creates a draft `{ name, sql, targets[], sourceType, sinkType, parallelism, executionRoleArn?, … }` | write target · read scope · project viewer / editor · audited | Stream Compute |
| GET / PUT / DELETE | `/api/flink/jobs/{id}` | Details / edit / delete (waits for the application to stop before destroying it, long-running); editing while a start / stop / delete is in progress ⇒ 409 | project viewer / editor · long-running · audited | Stream Compute |
| GET | `/api/flink/jobs/{id}/dashboard` | Issues a temporary URL to the native Flink Web UI (only while running) | project viewer | Stream Compute → Details |
| GET / POST | `/api/flink/jobs/{id}/diagnose` | POST starts an AI fault diagnosis (asynchronous); GET shows the diagnosis records | project viewer · audited | Stream Compute → Details "AI Diagnosis" |
| GET | `/api/flink/jobs/{id}/logs` | Application run logs (the most recent entries) | project viewer | Stream Compute → Details |
| POST | `/api/flink/jobs/{id}/produce` | "Generate Data": writes sample events into the stream in the job's region (in ascending event-time order) | project editor · audited | Stream Compute → Details "Generate Data" |
| GET | `/api/flink/jobs/{id}/results` | Reads the sink's aggregated results on demand (through Athena, a single query) | project viewer | Stream Compute → Details "Query results" |
| POST | `/api/flink/jobs/{id}/start` | Starts the job (waits through the transitional state for 1–3 minutes; long-running) | project editor · long-running | Stream Compute "Start" |
| GET | `/api/flink/jobs/{id}/status` | Application state + output aggregation summary (polled by the details page) | project viewer | Stream Compute → Details |
| POST | `/api/flink/jobs/{id}/stop` | Stops the job (only compute billing stops; long-running) | project editor · long-running | Stream Compute "Stop" |
| GET | `/api/flink/meta` | `?targetId=` the Flink runtime facts of that region (subnets etc.); a region that does not exist / is not installed ⇒ 409 | target · project viewer | Stream Compute → New |
| GET | `/api/flink/network` | `?targetId=&vpcId=` the VPC / subnet / security group lists of that region (network configuration dropdowns) | target | Stream Compute / Data Sources / Batch Compute → Network configuration |

### 3.19 genbi — GenBI · business definitions · skills

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| POST | `/api/genbi/ask` | `{ question, targetId, engine?, workgroupName?, database?, conversationId? }` asks a question; in asynchronous mode it first returns 202 `{ taskId, status:"pending" }`, then poll `/api/genbi/tasks/{taskId}` | target · project viewer | Ask-Your-Data |
| GET / POST | `/api/genbi/cards` | GET `?scope=` my card list; POST `{ title, turns, targetId, engine, database?, conversationId? }` saves / updates a card; quota full 409 `GENBI_CARD_QUOTA_EXCEEDED` | write target · read scope · project viewer | Ask-Your-Data → My cards |
| GET | `/api/genbi/cards/schedules` | `?scope=&withDrift=1` the scheduled refresh list of my cards | project viewer · scope | Task Monitor → Schedule config / Ask-Your-Data |
| GET / DELETE | `/api/genbi/cards/{cardId}` | GET reads the card body; DELETE deletes the card (two-phase) | signed in (owner) · audited | Ask-Your-Data → My cards |
| POST | `/api/genbi/cards/{cardId}/refresh` | `{ turnIndex? }` "Refresh now": reruns the card SQL and keeps a snapshot | project viewer · audited | Ask-Your-Data → My cards |
| POST | `/api/genbi/cards/{cardId}/resume` | Opens a continued conversation: rebuilds the session memory from the card body and returns which execution environment to switch to | signed in (owner) | Ask-Your-Data → My cards |
| GET | `/api/genbi/cards/{cardId}/runs` | The refresh history of this card (manual + scheduled; non-data fields only) | project viewer | Ask-Your-Data → My cards |
| GET / POST | `/api/genbi/cards/{cardId}/schedule` | GET the scheduled refresh settings; POST `{ cronExpression, enabled, turnIndex? }` creates / changes / enables / disables | project viewer · audited | Ask-Your-Data → My cards |
| GET / POST | `/api/genbi/context` | GET the business definitions / terms / rules of the current project + global; POST creates one (global entries admin only) | project viewer / editor · audited | Business Glossary & Rules |
| POST | `/api/genbi/context/seed` | One-click preset of common global definitions (idempotent upsert) | admin · audited | Business Glossary & Rules |
| PUT / DELETE | `/api/genbi/context/{id}` | `?projectId=` edits / deletes an entry (global entries admin only) | project editor · audited | Business Glossary & Rules |
| GET | `/api/genbi/history` | `?scope=` GenBI history (filtered by the region the question really hit) | signed in · scope | Ask-Your-Data → History |
| GET / POST | `/api/genbi/skills` | GET the registered skills of the current project + global; POST registers one | project viewer / editor · audited | Skills |
| POST | `/api/genbi/skills/seed` | One-click preset of the global public BI skills (idempotent upsert) | admin · audited | Skills |
| DELETE | `/api/genbi/skills/{id}` | `?projectId=` deletes a skill (global ones admin only) | project editor · audited | Skills |
| GET | `/api/genbi/tasks/{taskId}` | Polls a GenBI asynchronous task (preemption-driven execution; the final state carries `_meta`) | signed in | Ask-Your-Data |

### 3.20 governance — Data Governance

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/governance/access-grants` | "My grants": the data access grants in my name (per region) | signed in · read scope | Data Governance |
| GET | `/api/governance/catalog` | `?keyword=&scope=` the governance catalog (from OpenMetadata, per-region service dimension) | scope · signed in | Data Governance → Data Catalog |
| GET / PUT / DELETE | `/api/governance/classification` | GET `?fqn=` column classification (without fqn, all of them); PUT `{ targetId, fqn, column?, level, category?, maskStrategy? }`; DELETE `?fqn=&column=` | read signed in · write admin · target · audited | Data Governance → Data Classification |
| GET | `/api/governance/columns` | `?fqn=` the column names and types of one table (from OpenMetadata) | signed in | Data Governance → Data Classification |
| GET | `/api/governance/health` | `?refresh=1` the overall governance health score + dimension scores + asset ranking + to-dos | signed in | Governance Workbench |
| GET | `/api/governance/impact` | `?fqn=&depth=` downstream impact analysis (along OpenMetadata lineage) | signed in · read scope | Data Governance → Impact analysis |
| GET | `/api/governance/lineage` | `?fqn=&depth=` the lineage graph (with column-level mappings) | signed in | Data Governance → Data Lineage |
| POST | `/api/governance/lineage/backfill-om` | Backfills the compute lineage recorded by the platform into OpenMetadata (idempotent) | admin · audited | No page entry (operations) |
| GET | `/api/governance/quality` | OpenMetadata quality test cases and profiling results | signed in | Data Governance → Data Quality |
| GET | `/api/governance/quality-results` | `?fqn=&history=1` the latest quality result of one table + score / SLA; history=1 adds the trend | signed in | Data Governance → Data Quality |
| GET / POST | `/api/governance/quality-rules` | GET `?fqn=` quality rules; POST creates one (recorded per region) | read signed in · write admin · target · audited | Data Governance → Data Quality |
| PUT / DELETE | `/api/governance/quality-rules/{id}` | `?fqn=` updates / deletes a quality rule | admin · audited | Data Governance → Data Quality |
| POST | `/api/governance/quality-run` | `{ targetId, … }` runs a quality check once right now (the execution region comes from the body, scope is not read) | admin · target · audited | Data Governance → Data Quality "Run now" |
| GET / POST | `/api/governance/schedules` | GET `?scope=&withDrift=` scheduled governance tasks; POST `{ name, cronExpression, action, params, targetId }` creates one (not enabled; enabling goes through `/api/schedule/enable`) | write target · read scope · read project viewer · write admin · audited | Data Governance → Scheduled governance tasks / Task Monitor |
| GET / PATCH / DELETE | `/api/governance/schedules/{taskId}` | GET reads; PATCH edits the draft (not allowed while enabled — disable first); DELETE deletes | write admin · audited | Data Governance → Scheduled governance tasks |
| GET / POST | `/api/governance/sensitive-scan` | GET `?scanId=` scan results (without parameters, the most recent one); POST `{ targetId, … }` starts a sensitive-data identification scan | read signed in · write admin · target · audited | Data Governance → Sensitive Scan |
| POST | `/api/governance/sensitive-scan/adopt` | `{ scanId, items:[{ fqn, column, level?, category?, maskStrategy? }] }` adopts suggestions and writes them into the classification | admin · audited | Data Governance → Sensitive Scan "Adopt" |
| GET / POST | `/api/governance/sync-redshift-schema` | "Sync column information": backfills the real Redshift / S3 Tables columns into OpenMetadata (long-running; GET reads the progress) | admin · long-running | Data Governance → Data Catalog |
| POST | `/api/governance/tables` | `{ kind: redshift\|s3tables, targetId, schema, table, columns[], comment? }` "New table" from the data catalog; when the current environment is prod ⇒ not executed, an approval request is created (202 + approvalId) | admin · target · long-running · audited | Data Governance → Data Catalog "New table" |
| POST | `/api/governance/tables/alter` | `{ targetId, schema, table, desired[], confirmName?, dryRun? }` "Alter table"; dryRun only returns the plan (signed in suffices); execution admin only; prod ⇒ approval request | target · execute admin · long-running | Data Governance → Data Catalog "Alter table" |
| GET | `/api/governance/tables/columns` | `?targetId=&schema=&table=` the real columns of that region (with comments) and "whether it can be edited graphically" | target · signed in · long-running | Data Governance → Data Catalog "Alter table" |
| POST | `/api/governance/tables/preview` | DDL preview for the "New table" wizard (pure generation; nothing is persisted and no cloud call is made) | signed in | Data Governance → Data Catalog "New table" |

### 3.21 incidents — Incident Knowledge Base

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/incidents` | The incident category list (by scope) | project viewer · read scope | Incident Knowledge Base |
| GET | `/api/incidents/export` | `?format=jsonl` masked export (only signature / symptom template / category / fix kind / duration) | project owner · audited | Incident Knowledge Base "Export" |
| GET | `/api/incidents/health` | `?reconcile=` the health cards at the top (same filter as the list) | project viewer · read scope | Incident Knowledge Base |
| POST | `/api/incidents/lookup` | `{ signature? \| taskType + errorText }` looks up the verified fix runbook, recurrence count and last fix time for that signature | project viewer | Incident Knowledge Base / Task Monitor "AI Diagnosis" |
| GET / PUT | `/api/incidents/{signature}` | GET the details + timeline of one incident category; PUT `{ markdown, verified, fixKind, backfillHint, status, version }` maintains the fix runbook; signature must be URL-encoded | project viewer / editor · audited | Incident Knowledge Base → Details |
| POST | `/api/incidents/{signature}/silence` | `{ silenceUntil }` silences this incident category (default 30 days) | project editor · audited | Incident Knowledge Base → Details |

### 3.22 internal — platform-internal endpoints

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| POST | `/api/internal/actions/run` | `{ commandId }` a platform action node in an execution-region DAG → the home-region command table → the dispatch Lambda calls back this endpoint | internal | — |
| POST | `/api/internal/backfill/tick` | `{ projectId, planId }` the loop-back endpoint of the backfill plan advance pump (same function as the tick on the backfill page) | internal | — |
| POST | `/api/internal/dataplane-jobs/step` | `{ jobId }` advances a data-plane background job by one step (take the lease → execute → write back) | internal | — |
| POST | `/api/internal/dataplane-jobs/sweep` | "Auto-supply on binding" catch-up (every 10 minutes, leader replica only) | internal | — |

### 3.23 lineage — lineage parsing

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| POST | `/api/lineage/parse` | `{ sql }` parses Redshift SQL into a table-level lineage preview (does not write OpenMetadata and persists nothing) | signed in | Batch Compute "Parse lineage" |

### 3.24 long-ops — long-running operation polling

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/long-ops/{taskId}` | Long-running operation polling: running / succeeded / failed / timeout; visible only to the creator (anyone else gets 403) | signed in | Site-wide |

### 3.25 metadata-mirror — metadata mirror

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/metadata-mirror` | `?targetId=&kind=db\|table\|column\|lineage-edge` read-only overview of the cross-region metadata mirror | project viewer | Data Governance |

### 3.26 metrics — metrics

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET / POST | `/api/metrics` | GET the metric list (values resolved for the region of the current scope; honestly empty when that region has never computed them); POST creates one | read signed in · scope · write admin · audited | Data Modeling → Metric system |
| POST | `/api/metrics/compute-all` | `{ targetId }` computes all metrics in bulk (the execution region comes from the body) | admin · target | Data Modeling → Metric system |
| GET / PUT / DELETE | `/api/metrics/{id}` | Metric details / update / delete | write admin · audited | Data Modeling → Metric system |
| POST | `/api/metrics/{id}/compute` | `{ targetId }` computes one metric (direct warehouse query; long-running) | admin · target · long-running | Data Modeling → Metric system "Compute" |

### 3.27 modeling — Data Modeling

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET / PUT | `/api/modeling/assets` | GET `?fqn=` the asset's ownership (layer / domain); PUT sets the ownership | read signed in · write admin · audited | Data Modeling |
| GET / POST | `/api/modeling/codetables` | GET `?scope=` the code table list; POST creates one | read scope · write admin · audited | Data Modeling → Code table |
| GET / PUT / DELETE | `/api/modeling/codetables/{id}` | Code table details / update / delete; landing / unbinding in progress ⇒ 409 `LONG_OP_IN_PROGRESS` | write admin · audited | Data Modeling → Code table |
| POST | `/api/modeling/codetables/{id}/land` | `{ targets? }` lands it in the warehouses of each region (creates the physical code table and loads the enumeration values idempotently; long-running) | admin · target (subset) · long-running | Data Modeling → Code table "Land in this region" |
| POST | `/api/modeling/codetables/{id}/unbind` | `{ targetId, cleanup, confirm? }` unbinds from one region; with cleanup, the physical table is dropped first and `confirm` must be the physical table name | admin · target · long-running | Data Modeling → Code table "Unbind" |
| GET | `/api/modeling/codetables/{id}/unbind-preview` | `?targetId=` unbind impact preview (row counts are estimates, marked "approx." in the UI) | admin · target · long-running | Data Modeling → Code table "Unbind" |
| GET / POST | `/api/modeling/dimensions` | GET `?scope=` the dimension / fact table list; POST creates one | read scope · write admin · audited | Data Modeling → Dimensional modeling |
| PUT / DELETE | `/api/modeling/dimensions/{id}` | Updates / deletes a dimension / fact table; landing / unbinding in progress ⇒ 409 | admin · audited | Data Modeling → Dimensional modeling |
| POST | `/api/modeling/dimensions/{id}/apply` | `{ targets? }` "Apply": runs the DDL to create the table in each region's warehouse (long-running) | admin · target (subset) · long-running | Data Modeling → Dimensional modeling "Apply" |
| GET | `/api/modeling/dimensions/{id}/ddl` | DDL preview (pure generation) | signed in | Data Modeling → Dimensional modeling |
| POST | `/api/modeling/dimensions/{id}/unbind` | `{ targetId, cleanup, confirm? }` unbinds from one region (same semantics as code tables) | admin · target · long-running | Data Modeling → Dimensional modeling "Unbind" |
| GET | `/api/modeling/dimensions/{id}/unbind-preview` | `?targetId=` unbind impact preview | admin · target · long-running | Data Modeling → Dimensional modeling "Unbind" |
| GET / POST | `/api/modeling/domains` | GET `?scope=` data domains (may declare applicable regions; undeclared ones are visible to all regions); POST creates one | read scope · write admin · audited | Data Modeling → Data Domain |
| GET / PUT / DELETE | `/api/modeling/domains/{id}` | Data domain details / update / delete | write admin · audited | Data Modeling → Data Domain |
| GET / POST | `/api/modeling/layers` | GET `?scope=` data layers; POST creates one | read scope · write admin · audited | Data Modeling → Warehouse layers |
| POST | `/api/modeling/layers/seed` | One-click preset of the standard layers ODS / DWD / DWS / ADS (idempotent) | admin · audited | Data Modeling → Warehouse layers "One-click preset" |
| GET / PUT / DELETE | `/api/modeling/layers/{id}` | Layer details / update / delete | write admin · audited | Data Modeling → Warehouse layers |
| GET / POST | `/api/modeling/model-metrics` | GET `?scope=` the metric system (atomic / derived; values per region); POST creates one | read scope · write admin · audited | Data Modeling → Metric system |
| PUT / DELETE | `/api/modeling/model-metrics/{id}` | Updates / deletes a metric | admin · audited | Data Modeling → Metric system |
| POST | `/api/modeling/model-metrics/{id}/compute` | `{ targetId }` computes a metric (read-only aggregation; long-running) | admin · target · long-running | Data Modeling → Metric system "Compute" |
| GET / POST | `/api/modeling/standards` | GET `?scope=` data standards; POST creates one | read scope · write admin · audited | Data Modeling → Data Standard |
| GET / PUT / DELETE | `/api/modeling/standards/{id}` | Data standard details / update / delete | write admin · audited | Data Modeling → Data Standard |

### 3.28 monitor — Task Monitor

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/monitor/runs` | `?scope=&status=&taskType=&limit=` the run instance list (limit ≤ 500, applied after filtering) | project viewer · scope | Task Monitor / Home |
| GET | `/api/monitor/tasks/{id}/logs` | `?runId=` the log of one run (fetched from the region the run is in) | project viewer | Task Monitor "Logs" / Backfill Center |

### 3.29 multi-region — Multi-Region Dashboard

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/multi-region/matrix` | Version consistency matrix: the published version of every definition in each region and what is missing | project viewer | Multi-Region Dashboard |

### 3.30 network-advisor — network advisor

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| POST | `/api/network-advisor/advise` | `ConnectivityRequest { computeKind, targets, targetId, constraints?, userMessage?, … }` network advisor AI advice (long-running) | signed in · long-running | Data Sources / Stream Compute / Batch Compute → Network advisor |
| POST | `/api/network-advisor/apply` | One-click fix: low-risk create-only actions such as enabling VPC DNS / creating an S3 gateway endpoint | admin · audited | Network advisor "One-click fix" |
| POST | `/api/network-advisor/probe` | Deterministic probing only (no LLM call); returns environment facts | signed in | Network advisor |

### 3.31 observability — Observability

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/observability/genbi` | `?scope=` GenBI observability dashboard data (hits / latency / model) | scope · signed in | Observability / Skills |

### 3.32 openmetadata — Governance Center

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/openmetadata/url` | The access URL and version of the Governance Center (OpenMetadata); flat shape `{ url, version }` or `{ error }` | signed in | Governance Center |

### 3.33 ops — Ops Dashboard

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/ops/summary` | `?scope=` all card data of the ops dashboard | project viewer · scope | Ops Dashboard |

### 3.34 param-advisor — parameter advisor

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| POST | `/api/param-advisor/advise` | Parameter advisor AI advice (long-running) | signed in · long-running | Batch Compute / Stream Compute / Data Sync → Parameter advisor |
| POST | `/api/param-advisor/recommend` | `ParamAdviceRequest` (`channel` required) deterministic recommendation, returns within seconds, no LLM call | signed in | Parameter advisor |

### 3.35 projects — workspaces

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET / POST | `/api/projects` | GET the projects visible to me (`?discover=1` lists all of them and marks `myRole` / `pending`); POST `{ name, description }` creates one (platform admin or manager) | signed in · read scope · audited | Workspace / top-bar project switcher |
| GET / PUT / DELETE | `/api/projects/{id}` | Details / rename / delete; deletion requires resources, members and data-plane tables to all be 0 (long-running) | project viewer / project config admin · long-running · audited | Workspace |
| GET / POST | `/api/projects/{id}/members` | GET the member list; POST adds a member | project viewer / project config admin · audited | Workspace → Members |
| DELETE | `/api/projects/{id}/members/{username}` | Removes a member (the creator cannot be removed) | project config admin · audited | Workspace → Members |

### 3.36 promote — publish to environment

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| POST | `/api/promote` | `{ type, id, toEnv }` publishes to an environment: to prod it creates a deploy approval (pending); to dev / staging it executes immediately | project editor · audited | "Publish to environment" on each resource's details |
| GET | `/api/promote/lineage` | `?type=&id=` which version of this resource is in dev / staging / prod, who published it and when, and whether an approval is pending | project viewer | "Publish status" on each resource's details |

### 3.37 public — endpoints without login

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| POST | `/api/public/alerting-sink` | Alerting self-test webhook receiver: only records the payload and always returns 200; read it through `/api/alerting/test-sink` | public | Alerting Center (channel self-test) |
| GET | `/api/public/config` | The Cognito configuration needed to sign in `{ userPoolId, clientId, region }` (public identifiers, not secrets) | public | Login page |
| GET / POST / PUT / PATCH / DELETE | `/api/public/data/{slug...}` | The external "Data Service" endpoint, retired: all five methods return 410 `{ code:"GONE", message, since }` | public · retired | — |
| GET | `/api/public/locale` | Suggests the initial language from the visitor's IP `{ suggestedLocale, country }`; a manual choice on the page always wins | public | Site-wide language |
| GET | `/api/public/version` | The running platform version `{ known, releaseTag, productCommit, productCommitAt, version }` | public | Login page footer / Settings "Platform version" |

### 3.38 redshift — Redshift Query

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| POST | `/api/redshift/cancel` | `{ statementId }` cancels a query you submitted yourself; not yours ⇒ 403 | signed in · audited | Redshift Query |
| GET | `/api/redshift/connections` | `?targetId=` the warehouse workgroups of that region | target | Redshift Query / Ask-Your-Data / Data Sync / Settings |
| GET | `/api/redshift/databases` | `?targetId=&workgroupName=` the databases in a workgroup | target (registered region) | Redshift Query / Ask-Your-Data / Data Sync |
| POST | `/api/redshift/execute` | `{ sql, workgroupName, database, targets[] }` executes SQL, submitted to several regions in parallel; across jurisdictions you must agree to the disclaimer first (409); DDL-type statements are checked against admin | target (targets) · project editor · audited | Redshift Query "Execute" |
| GET / POST | `/api/redshift/history` | GET `?scope=` the execution history; POST `{ sql, status, duration, rowCount, error, targetId }` records one entry | project viewer · read scope · write target | Redshift Query → History |
| GET | `/api/redshift/history/{historyId}/sql` | Reads back the SQL text kept in that region (across jurisdictions only a pointer is stored) | project viewer | Redshift Query → History |
| GET | `/api/redshift/result/{id}` | `?targetId=` fetches a statement's results (statementId is region-local, so the matching region must be given) | target · audited | Redshift Query |
| GET | `/api/redshift/schemas` | `?targetId=` the schema / table / column tree | target · project viewer | Redshift Query / Data Governance / Ask-Your-Data |
| GET / POST | `/api/redshift/tasks` | GET `?scope=` the saved SQL query tasks; POST creates one (the target is derived from the workgroup) | read scope · write target · project viewer / editor | Redshift Query → Query tasks |
| PUT / DELETE | `/api/redshift/tasks/{id}` | Updates / deletes a saved query task (errors are in the flat `{ error }` shape) | project editor | Redshift Query → Query tasks |

### 3.39 requirements — Requests

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET / POST | `/api/requirements` | GET `?box=mine\|assigned\|inbox\|all` the request list (role-aware); POST submits a request | project viewer · audited | Requests |
| GET | `/api/requirements/assignees` | The developers that can be assigned (project members with their project roles) | project viewer (manager) | Requests "Assign" |
| GET | `/api/requirements/{id}` | Request details | project viewer | Requests → Details |
| POST | `/api/requirements/{id}/assign` | `{ assigneeName, assigneeSub?, priority?, dueDate? }` a manager assigns a developer | manager · audited | Requests "Assign" |
| POST | `/api/requirements/{id}/comment` | `{ text }` comments (does not change the state) | project viewer | Requests → Details |
| POST | `/api/requirements/{id}/create-job` | Creates a batch job in one click from the generated implementation (not executed; `targets` required) | assigned developer who is also project editor · target · audited | Requests "Create job" |
| POST | `/api/requirements/{id}/generate` | `{ targetType: redshift\|glue, targetId }` the LLM generates the implementation (long-running) | assigned developer · target · long-running | Requests "Generate implementation" |
| POST | `/api/requirements/{id}/transition` | `{ action, note? }` state machine transition (manager / assignee / requester checked per action) | per action · audited | Requests → Details |

### 3.40 residency — disclaimer

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET / POST | `/api/residency/ack` | POST `{ targetId, version, textHash }` agrees to the current version of the disclaimer of a cross-jurisdiction execution environment (idempotent; `created:false` means it was already agreed to); GET is not provided (405 "POST only") | target · signed in · audited | Dialog on the first cross-jurisdiction operation |

### 3.41 role-advisor — role advisor

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| POST | `/api/role-advisor/create` | Creates an execution role in one click (controlled prefix `bgp-job-role-*`, policy generated by the server) and returns the ARN | admin · audited | Batch Compute / Stream Compute → Role advisor "One-click create" |
| POST | `/api/role-advisor/recommend` | `RoleAdviceRequest` (`engine` required) least-privilege policy + trust policy recommendation (read-only) | signed in | Role advisor |

### 3.42 run-groups — multi-region run groups

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/run-groups/{id}` | The whole-group view of one multi-region run (`derivedStatus` is the displayable state) | signed in | Task Monitor / run history |
| POST | `/api/run-groups/{id}/cancel` | Cancels the child runs in the group that have not reached a final state; those that have are left alone | audited | Task Monitor / run history |
| POST | `/api/run-groups/{id}/retry-failed` | Authoritatively computes and returns the failed regions of the group; does not fan out itself — the page then calls the corresponding run endpoint | signed in | Task Monitor / run history |

### 3.43 s3 — S3 bucket inventory

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/s3/buckets` | S3 bucket inventory of the account (service status card; account-level, not per region) | signed in | Settings → Service status / Data Sync |

### 3.44 schedule — enable / disable scheduling

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| POST | `/api/schedule/enable` | `{ taskId, taskType, cronExpression, enabled }` enables / disables scheduling; taskType = workflow / sync / governance / genbi-card / seed; a long-running operation in progress on the object ⇒ 409 | project editor (cards: the author only; governance / seeding tasks: admin) · audited | Task Monitor → Schedule config / Data Sync / Data Governance |

### 3.45 scope — scope counts

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/scope/counts` | `?resource=etl-job\|engine-job\|sync\|workflow\|datasource\|model-table\|…` the "N more in other scopes" count (an invalid value returns 400 listing the accepted values) | project viewer | Top-bar execution scope / Task Monitor |

### 3.46 seed — demo seeding

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| POST | `/api/seed/run` | `{ targetId, dataset }` "Seed now": runs one seeding job in the named region (demo mode) | admin · project editor · target · audited | Task Monitor → Schedule config |
| GET / POST | `/api/seed/schedules` | GET `?scope=&withDrift=` scheduled seeding tasks; POST creates one (not enabled) | write target · read scope · admin · audited | Task Monitor → Schedule config |
| GET / PATCH / DELETE | `/api/seed/schedules/{taskId}` | GET reads; PATCH edits the draft (not allowed while enabled); DELETE deletes | admin · audited | Task Monitor → Schedule config |

### 3.47 settings — Settings

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/settings` | `?scope=` the Settings page data: resource facts of the current region (workgroups / buckets / scheduling), the read-only effective model value, service status | scope · signed in | Settings |

### 3.48 sla — SLA

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET / POST | `/api/sla` | GET `?scope=` the SLA definition list; POST creates one | project viewer / editor · read scope · audited | Alerting Center → SLA & Baseline Alerts |
| POST | `/api/sla/predict` | Predicts the completion time / breach risk from the baseline of the region the run is in | project editor | Alerting Center → SLA & Baseline Alerts |
| GET | `/api/sla/risk-board` | `?scope=` the SLA risk cards of the dashboard (baseline deviation ranked per task × region) | project viewer · scope | Ops Dashboard |
| GET / PUT / DELETE | `/api/sla/{id}` | Get / update / delete one SLA | project viewer / editor · audited | Alerting Center → SLA & Baseline Alerts |

### 3.49 sync — Data Sync

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET / POST | `/api/sync` | GET `?scope=&withDrift=` the sync task list; POST creates `{ datasourceId, sourceDatabase, syncMode, channel, targetType, incrementalConfig?, … }`; a task's own table bucket must be a writable route | read scope · project viewer / editor · audited | Data Sync |
| POST | `/api/sync/execute-ddl` | `{ targetId, redshiftConfig, … }` creates the target table from the preview and applies the platform marker (long-running; a concurrent second attempt on the same table ⇒ 409) | target · project editor · long-running | Data sync wizard "Create table" |
| POST | `/api/sync/generate-ddl` | `{ targetId, … }` generates the CREATE TABLE statement and probes the target table (long-running; read-only) | target · project editor · long-running | Data sync wizard "Generate DDL" |
| POST | `/api/sync/recommend-channel` | `{ sourceType, targetType, syncMode }` recommends a sync channel | signed in | Data sync wizard |
| POST | `/api/sync/type-mapping` | `{ sourceDb, columns }` source column type → target type mapping | signed in | Data sync wizard |
| GET / PUT / DELETE | `/api/sync/{id}` | Details / edit (tasks that write S3 Tables need Glue version ≥ 5.1) / delete (also takes the schedule and the job offline) | project viewer / editor · audited | Data Sync / Details |
| GET | `/api/sync/{id}/glue-status` | Run state of the Glue channel (queried in the task's region and written back) | project viewer | Data Sync → Details |
| GET | `/api/sync/{id}/logs` | Job logs (that region's log group) | project viewer | Data Sync → Details |
| GET | `/api/sync/{id}/output` | Output listing (that region's bucket) | project viewer | Data Sync → Details |
| GET | `/api/sync/{id}/realtime-status` | Run state of the streaming channel (CDC latency / rows replicated / status) | project viewer | Data Sync → Details |
| GET | `/api/sync/{id}/runs` | Run history (failure wording translated into a readable conclusion) | project viewer | Data Sync → Details |
| GET | `/api/sync/{id}/runs/{runId}/logs` | The log of one run (fetched from the region that run is in) | project viewer | Data Sync → Details |
| POST | `/api/sync/{id}/start` | "Start" the Glue channel: create the job → start → write the run row | project editor · audited | Data Sync "Start" |
| POST | `/api/sync/{id}/start-realtime` | "Start" the streaming channel (DMS / Zero-ETL); the first start waits for the replication instance in the background; clicking again ⇒ 409 `START_IN_PROGRESS` | project editor · audited | Data Sync "Start" |
| POST | `/api/sync/{id}/stop` | "Stop"; still stopping ⇒ 409 `TEARDOWN_IN_PROGRESS`, click again later | project editor · audited | Data Sync "Stop" |
| GET | `/api/sync/{id}/zeroetl-status` | Zero-ETL integration state + rows replicated | project viewer | Data Sync → Details |

### 3.50 system — wiring health check

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET | `/api/system/wiring` | Wiring health check: whether the model configuration / agent acknowledgements / execution-environment deployer really exist | admin | Settings → Wiring status |

### 3.51 versions — versions and rollback

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET / POST | `/api/versions` | GET `?type=&id=` the version history, `&version=N` fetches one version's snapshot; POST `{ type, id, version }` rolls back to that version | project viewer / editor · audited | "Version" on each resource's details |

### 3.52 workflow — ETL Orchestration

| Method | Path | Purpose | Requires | Page |
|---|---|---|---|---|
| GET / POST | `/api/workflow` | GET `?scope=` the workflow list; POST creates one (`targets[]` required) | write target · read scope · project viewer / editor · audited | ETL Orchestration |
| GET | `/api/workflow/airflow` | `?targetId=&dagId=` obtains a login URL for the classic Airflow console; the Serverless scheduler has no console ⇒ 409 `WORKFLOW_SCHEDULER_UNSUPPORTED` | admin · target · audited | ETL Orchestration → Details |
| GET / PUT / DELETE | `/api/workflow/{id}` | Details / edit / delete (first withdraws the scheduling artifacts region by region, then deletes the row; long-running); editing while a publish / trigger is in progress ⇒ 409 | project viewer / editor · long-running · audited | ETL Orchestration / Details |
| POST | `/api/workflow/{id}/publish` | "Publish" to the scheduler of the workflow's region (long-running); contains an external node ⇒ 400 `SERVERLESS_NODE_UNSUPPORTED` | project editor · long-running | ETL Orchestration "Publish" |
| GET | `/api/workflow/{id}/run-groups` | `?limit=` the most recent multi-region run groups | project viewer | ETL Orchestration → run history |
| GET | `/api/workflow/{id}/runs/{runId}/nodes` | The node states of one run (queried from that region's scheduler) | project viewer | ETL Orchestration → run details |
| GET | `/api/workflow/{id}/runs/{runId}/nodes/{task}/logs` | `?try=` the task log of one node | project viewer | ETL Orchestration → run details |
| GET | `/api/workflow/{id}/runs/{runId}/status` | The overall state of one run (reconciled on read) | project viewer | ETL Orchestration → run details |
| POST | `/api/workflow/{id}/trigger` | `{ targets? }` triggers one run manually (long-running; across jurisdictions you must agree to the disclaimer first) | project editor · target (subset) · long-running | ETL Orchestration "Trigger" |
| POST | `/api/workflow/{id}/unpublish` | "Take offline": withdraws that region's scheduling artifacts (long-running) | project editor · long-running | ETL Orchestration "Take offline" |

## 4. Compatibility aliases and deprecations

| Path | Status | Notes |
|---|---|---|
| `GET /api/ai/tasks/{taskId}` | Alias, kept for one version | Same handler as `GET /api/long-ops/{taskId}`; new scripts must use `/api/long-ops/{taskId}`, the old path will be removed in a later version |
| `/api/admin/lake-buckets` (GET · POST · DELETE) | Alias, kept for one version | The old name of lake table-bucket routing, same handler as `/api/admin/lake-routes`; GET does not include the implicit platform route (same shape as before the rename); new scripts use `/api/admin/lake-routes` |
| `GET /api/genbi/tasks/{taskId}` | Current (not an alias) | GenBI's own asynchronous polling, coexisting with the long-running operation framework; only the GenBI 202 uses it |
| `GET /api/admin/exec-envs/preflight` | Retired, always 410 | With zero-egress execution environments the EIP quota preflight is no longer needed |
| `POST /api/admin/exec-envs/{targetId}/network-profile` | Retired, always 410 | With zero egress there is no network profile to adjust; the old fields in the descriptor are kept read-only |
| `/api/public/data/{…}` | Retired, always 410 | The "Data Service" capability is retired as a whole; response `{ code:"GONE", message, since }` |
| `/api/metrics/**` | Current, page entry consolidated | The "Metrics Hub" page has been merged into "Data Modeling → Metric system"; the endpoints remain |
| `GET /api/admin/model-config/transport` | Current, no page entry | Transport gate of the GPT series, for operators to inspect only |

## Further reading

- Concepts: workspace / execution environment / target / execution scope / long-running operation / object lease — [Core concepts](02-concepts.md)
- The user-facing meaning of the refusal reasons and status codes you meet on the pages — [Rules and status code reference](30-reference-rules.md)
- Common symptoms and next steps — [FAQ](32-faq.md); Chinese-English terminology — [Glossary](33-glossary.md)
- Admin account, first login and password change, creating accounts and joining projects — [Platform admin guide](10-guide-admin.md), [Customer production deployment manual](../deployment.md)
- Pages / endpoints / mechanisms / boundaries of every feature module — [Feature module overview](../modules.md)
- The multi-region contract (target · scope · disclaimer · deleting an execution environment) — [Multi-region design contract](../design/multi-region-execution-spec.md)
- Design of the unified long-running operation framework — [Long-running operations design](../design/long-running-operations.md)
- Lake table-bucket routing (aliases / tiers / writability) — [Table-bucket routing design](../design/lake-bucket-routing.md)
