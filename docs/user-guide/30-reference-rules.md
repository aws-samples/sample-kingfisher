# Rules and status code reference: rejection reasons, notices and their meaning on the pages

| Item | Description |
|---|---|
| Audience | All roles; look here when you see red text, a rejecting dialog, or "Running in background" at the bottom right |
| Estimated time | Look up as needed, 1–2 minutes per entry |
| Prerequisites | You can sign in; you know what the three selectors in the top bar mean: "Workspace", "Environment", "Execution scope" (see [Core concepts](02-concepts.md)) |
| What you will have at the end | You understand what each rejection says, why it rejects, and what to click on which page next |

## 0. How to read this reference

- Every rejection on the platform carries a verbatim message, and that message usually already states the "why" and the "next step". This reference groups those messages by page and adds the meaning and the way out.
- `…` in a message is a name filled in at run time (execution environment id, table name, role name, and so on); "execution target", "target" and "stamp" in a message all mean the execution environment (see the [Glossary](33-glossary.md)).
- Three rules run through the whole platform; remember them first:
  - **Never fall back**: when the execution environment is missing, the execution scope is invalid, or access is denied, the platform always rejects; it never silently switches to the home region or to "All".
  - **Automatic move to the background after 45 seconds**: "Running in background: <label> (n s elapsed)" appears at the bottom right, disappears automatically at the terminal state, and the result is the same as a synchronous completion; do not click again.
  - **The platform never performs destructive actions on your behalf**: clearing a whole table, DROPping a table, deleting a project with content — all require you to confirm per table / per item or to clean up first.

### 0.1 Status codes at a glance

| Status code | Meaning on the platform | What you usually have to do |
|---|---|---|
| 400 | The request is missing something or is malformed: missing execution environment, invalid execution scope parameter, role pre-check failed, invalid table bucket / alias / namespace | Complete the form as the message says; re-select "Execution scope" in the top bar |
| 401 | "Not authenticated or the session has expired; please sign in again" | Sign in again |
| 403 | Not a project member, project role too low, the action is for platform admins only, the execution environment is not authorized for this project | Ask the project owner or a platform admin |
| 404 | The object does not exist or has been deleted; the execution environment the execution scope points to does not exist / is not installed | Refresh the list; re-select the execution scope in the top bar |
| 409 | State conflict: the object is busy (lease), still referenced, needs your decision, the execution environment cannot accept work right now, a cross-jurisdiction notice must be agreed to first | Wait for it to finish / clear the references first / decide as the dialog asks |
| 410 | The capability has been retired (the legacy "Data Service" data source in reports) | Switch data source |
| 202 | The operation moved to background execution (notice at the bottom right) | Wait for the notice to disappear; do not click again |
| 502 / 503 | A dependent AWS service refused or the regional audit could not be written; the operation was not executed and no record was changed | Retry later; if it persists, ask a platform admin |
| 504 | Background execution exceeded 5 minutes and was terminated, or a dependency timed out | Narrow the scope and retry; first check whether the object was already created |

## 1. Targets and execution scope

| Symptom (what you see on the page) | Meaning | What you can do | Where it appears |
|---|---|---|---|
| 400 "… missing targetId — unknown in which execution environment to run (no default to the home region)" | This action must name the execution environment to run in, and the request did not carry one | Choose "Execution region" in the form, or choose a specific execution environment in "Execution scope" in the top bar and retry | Data Sources · Data Sync · Batch Compute · Stream Compute · Data Modeling, and others |
| 400 "The current view is "All" — a data-plane operation requires choosing one execution environment first (no default to the home region)" | The execution scope in the top bar is "All", but this action has to land in one region | Switch "Execution scope" in the top bar to a specific execution environment | Read operations that fetch by the current execution scope: Report Builder data fetch / export / field configuration · data source wizard "Select from RDS" · sensitive scan · model catalog in Settings |
| 400 "… no execution environments named (targets) — will not bind to the home region by default" | The new object has no bound region selected | Check at least one under "Execution regions (multi-select)", or click "Select all active regions" | Batch Compute "New" · ETL Orchestration · Data Sync |
| 400 `INVALID_SCOPE` "Invalid value for execution scope ?scope= (received …). Valid forms: global / <targetId> / cmp:<t1>,<t2>[,<t3>,<t4>] (2–4 entries, comma-separated)" | The execution scope parameter in the address bar was corrupted (edited by hand or an old bookmark) | Re-select with "Execution scope" in the top bar; do not edit the address bar by hand | All list pages |
| 404 `TARGET_NOT_FOUND` "The execution environment … the execution scope points to does not exist, has been deleted, or has not finished initializing — please re-select the execution scope (no automatic switch back to the home region)" | The region selected last time was deleted, or has not yet passed "Check initialization" all green and been "Enable"-d | Re-select in the top bar; check the region's status in "Execution Environments" | All list pages |
| 403 `TARGET_FORBIDDEN` "Execution target … is not authorized for project … — this target has a project allow-list ("Authorized projects" on the execution environment details page); ask an admin to add this project to the allow-list" | The region is authorized only for some projects, and the current project is not on the allow-list | Ask a platform admin to add this project under "Execution Environments → details → Authorized projects"; or switch the top bar to an authorized project | All list pages · Batch Compute region binding · Redshift Query region selection |
| 409 "Execution environment … cannot accept work right now: … (will not run in the home region instead)"; the region is tagged "Not accepting work" in the top-bar drop-down | The region is deploying / draining / not all probes are green | Wait for it to return to "Running"; check the reason in "Execution Environments" | Run · publish · Athena query · landing |
| 409 "Execution environment … does not have the … component installed (installed: …) — rejected, will not run in another region instead" | The region lacks a component this feature needs | "Execution Environments → details → Complete missing components" | Stream Compute · schedule config |
| 409 "Execution environment … does not exist (not in the registry) — rejected, will not use the home region instead" / "… not installed yet (initialization did not finish) — rejected…" | A region was named that does not exist or is not in place | Verify in "Execution Environments"; wait for "Check initialization" all green and "Enable" | Read interfaces |
| 409 "The resource manifest of execution environment … has no … — rejected, will not substitute the same-named resource of another region" | The region's descriptor lacks a resource (incomplete deployment) | "Execution Environments → details → Check initialization"; if still missing, ask a platform admin | Every data-plane operation |

Note: the "Execution scope" drop-down in the top bar lists only **fully installed** execution environments; anything in the drop-down can be viewed, and anything not in it is rejected even when named. Switching the execution scope does not leave the current page.

## 2. Workspaces, environments and permissions

| Symptom | Meaning | What you can do | Where it appears |
|---|---|---|---|
| 401 "Not authenticated or the session has expired; please sign in again" | Sign-in expired | Sign in again | Any page |
| 403 "No access to this workspace" | You are not a member of the current workspace; the "Default Workspace" has no members at first | Have the project owner / a platform admin add you under "Workspace → Members / Approvals"; or on the "Workspace" page click "Request to join" on that space under "Other workspaces you can request to join" at the bottom | Ask-Your-Data · cards · Athena query · almost every page |
| 403 "Insufficient permission: a higher project role is required" | A viewer did an editor's action (create / edit / delete), or an editor did an owner's action | Ask the owner to raise your role, or submit a role request | All write operations |
| 403 "Configuration management (rename / delete project / add, remove or change members / approval decisions) requires a platform admin (bgp-admin) or a dev manager (bgp-manager) who is also the owner of this project; you can still develop this project's sync tasks / jobs / workflows and other resources as usual. …" | Project configuration is for admins / dev managers who are also owners; development rights are unchanged | Contact an admin or a dev manager | Workspace |
| 403 "No permission to create a workspace: only platform admins (bgp-admin) and dev managers (bgp-manager) can create one. If you need a new workspace, contact an admin or a dev manager." | Same as above | Same as above | Workspace "Create" |
| 403 "Only platform admins can alter table structures" "Only platform admins can create scheduled governance tasks (same permission tier as running quality checks / sensitive scans / catalog sync manually)" "Only platform admins can edit scheduled governance tasks" "Only platform admins can delete scheduled governance tasks" "Only platform admins can unbind code table landings" "Only platform admins can unbind dimension / fact tables" "Only platform admins can view" | These actions are for bgp-admin only | Ask a platform admin | Data Governance · Data Modeling · Multi-Region Dashboard |
| 403 "Warehouse query for non-platform-admins allows read-only queries only (a single SELECT / WITH): …. For writes / DDL contact a platform admin, or submit them through job development" | The Redshift Query page is read-only for non-admins | Use a Redshift SQL job in "Batch Compute" for writes; or ask an admin | Redshift Query |
| An object just created / just published is not in the list | One of three filters is wrong: "Workspace", "Environment" (dev / staging / prod), "Execution scope" in the top bar | Check the top bar one by one; the environment switcher's tip reads: "Can't see a resource you just published? Switch here to the target environment first." | All list pages |
| You clicked "Publish to prod (needs approval)" but it is not in prod | Publishing to prod needs the project owner's approval | Wait for the owner to approve under "Workspace → Pending my approval (n)"; after approval switch "Environment" in the top bar to prod | Batch Compute · Data Sync · ETL Orchestration · Data Governance "New table" |
| "Request submitted; awaiting workspace owner approval"; the list shows "Pending approval" | You submitted an access / role request to a space you are not a member of | Wait for the owner to handle it; the owner acts under "Pending approval (access/role requests)" at the bottom of the "Workspace" page | Workspace |

The meaning of role groups and project roles is in the [Glossary](33-glossary.md); the complete procedure for two workspaces collaborating is in [Scenario: several teams sharing one platform](29-scenario-projects-permissions.md).

## 3. Background execution (long-running operations) and object leases

| Symptom | Meaning | What you can do | Where it appears |
|---|---|---|---|
| "Running in background: <label> (n s elapsed)" at the bottom right | The operation did not finish within 45 seconds and continues in the background; the notice disappears automatically at the terminal state, and the result is the same as a synchronous completion | Wait; do not click again; each background operation has its own notice | All actions listed in the table below |
| 504 "The operation was automatically terminated after 5 minutes; narrow the scope and retry" | Background execution hit the 5-minute ceiling | Narrow the scope (fewer tables / fewer regions) and retry; first check whether the object was partly created | Same as above |
| 409 `LONG_OP_IN_PROGRESS` ""<label>" is in progress (n s elapsed); please wait for it to finish before trying again" | The same object is held by a background operation (object lease); editing / deleting / repeating are all blocked | Wait for the notice at the bottom right to disappear, then act | Same as above |
| 409 "Object … is occupied by another operation; please retry later" | Same as above, but the occupying task row has not been created yet | Retry after a few seconds | Same as above |

### 3.1 Which actions move to the background (labels shown in the notice)

| Page | Labels that can appear in the notice |
|---|---|
| Copilot Plan Center | Copilot chat |
| Data Sources | New data source · Create Athena external table for S3 data source · Network connectivity advice |
| Data Sync | Generate DDL and probe target table · Create target table from preview |
| Batch Compute | AI-generated batch job code · AI-generated EMR job code · Parameter recommendation · Run engine job ("Run" of EMR Serverless) |
| ETL Orchestration | Publish workflow · Unpublish workflow · Trigger workflow run · Delete workflow |
| Stream Compute | AI-generated Flink SQL · Start streaming job · Stop streaming job · Delete streaming job |
| Requests | Generate implementation from requirement |
| Data Governance | Sync column information to the data catalog · Create table from data catalog · Alter table structure from data catalog · Read live table columns · Execute approved create / alter table |
| Data Modeling | Land code table to execution target · Apply dimension table to execution target · Unbind landed artifacts · Unbind preview · Compute model metric |
| Metric library (entered from modeling / Ask-Your-Data) | Compute metric |
| Workspace | Delete workspace |

### 3.2 Which objects get "held" (editing / deleting / repeating then ⇒ 409)

| Object | Action that holds it |
|---|---|
| Code table / dimension table | Landing, applying, unbinding in progress |
| A physical table of an execution environment | Catalog create / alter table (not a dry run), approved DDL execution, sync wizard "Create target table from preview" in progress |
| Approval ticket | Execution of the approved create / alter table in progress |
| Governance catalog "Sync column information" | Only one at a time platform-wide |
| Workspace | Deletion in progress |
| Streaming job | Start / stop / delete in progress |
| Workflow | Publish / unpublish / trigger / delete in progress |
| Data source | Creating the Athena external table in progress; a same-named "New data source" in the same project still being created in the background (clicking the same name again ⇒ 409, no second row is created) |
| Engine job (EMR Serverless) | The submission phase of "Run" in progress (clicking run / edit / delete again all ⇒ 409) |

## 4. Cross-jurisdiction operations, disclaimer and audit

| Symptom | Meaning | What you can do | Where it appears |
|---|---|---|---|
| Dialog "⚠️ Disclaimer (v1)" with the buttons "Cancel" / "Agree and continue" | Your first data operation on a **cross-jurisdiction** execution environment; the platform asks you to read and agree to the notice first | After "Agree and continue" the original operation retries automatically; the consent is stored (user / target / version / time) and appears once per person per region; "Cancel" = nothing is executed | Redshift Query · Batch Compute "Run now" / "Dry run" / "Backfill" · EMR job run · scheduling "Trigger once" · Data Modeling land / apply · ETL Orchestration trigger · Ask-Your-Data "Save conversation as card" / card "Refresh now" |
| Small print in the dialog "Execution target … belongs to another jurisdiction. Before your first data operation on it, please read and agree to the notice below (your choice is retained: user / target / version / time)." | Same as above | Same as above | Same as above |
| 409 "The operation on execution target … requires agreeing to the disclaimer (v1) first" | The server-side wording of the same thing; the page opens the dialog automatically, so you normally do not see this | Same as above | Same as above |
| 503 "The regional audit of execution target … cannot be written right now; the operation was not executed (audit integrity): …" | That region's audit table cannot be written at the moment, and the platform prefers not to execute | Retry later; if it persists, ask a platform admin | Any data operation on a cross-jurisdiction region |
| 400 "The returned disclaimer version / text hash does not match the current version — refresh, then read and agree again" | The disclaimer text was updated and you saw the old version | Refresh the page, read and agree again | Same as above |
| 400 "Execution target … is in the home jurisdiction; it neither needs nor accepts disclaimer consent (the notice only matters for cross-jurisdiction targets)" | No notice is needed for a region in the same jurisdiction | No action needed | Same as above |
| "Audit #" in the result sheet header / the "Audit" column of the run history | The number of the regional audit record this operation left in that region | Search for it in "Audit Log" and look at the residency.* actions; the "Consents" card on the execution environment details shows who agreed to which version when | Redshift Query · Batch Compute · Task Monitor · Audit Log |

Full disclaimer text (version v1 as of 2.2.0; the page shows the text sent by the server verbatim):
"This platform assumes no legal liability related to cross-border data transfer or data compliance. You must constrain and control data compliance yourself in accordance with local government laws and regulations. Clicking "Agree and continue" means you have read and agree."

## 5. Data sources

| Symptom | Meaning | What you can do | Where it appears |
|---|---|---|---|
| 409 `DATASOURCE_IN_USE` "This data source is still referenced by N tasks; delete them or change their source first: …" (since 2.2.0) | Before deleting a source the platform checks references: sync tasks / streaming tasks still use it | The message names each task; delete them under "Data Sync" / "Stream Compute" or point them to another source, then delete | Data Sources "Delete" |
| Red tag "Network object missing" in the list; start / detect 409 `DATASOURCE_NETWORK_BROKEN` | The security group / subnet / Glue connection / credential secret this source depends on was deleted in the account | Read the message below: objects created by the platform are rebuilt automatically; ones you specified yourself must be replaced under "Data Sources → Edit → Network configuration" | Data Sources · Data Sync "Start" |
| 409 `CROSS_REGION_SOURCE` "Cross-region data access is forbidden: the data source is in execution environment …, while the task is bound to … — sync = read the source, write the warehouse; source and task must be in the same execution environment (data does not leave its region); this is a design rule and a permanent rejection (create the sync task in the source's region)" | The source and the sync task are not in the same region | Create the sync task in the source's region; changing the source while editing is rejected the same way and "the task is unchanged" | Data Sync "Start" / changing the source while editing |
| After creation the status is first "Testing", then "Connected" or "Unreachable" | "Connected" only comes from a real successful sign-in | For "Unreachable" click "Detect" and read the message; JDBC sources need a security-group inbound rule for the database port | Data Sources |
| "Browse tables" shows 0 tables | A source whose database is in a VPC is not connected to the network yet, or the port is not open | Click "Save Network Access" once under "Network configuration" in the row (the "Network Access (optional)" block in the new-source wizard); after the security group opens the port, "Detect" again | Data Sources |
| "Running in background: New data source" at the bottom right after clicking "Done" | Creating a source creates a security group / Glue connection and so on; beyond 45 seconds it moves to the background | Wait for it to be created; clicking the same name again gives 409 | Data Sources "New data source" |
| 404 "Data source does not exist" | Someone else deleted it | Refresh the list | Data Sources |

The "Network object missing" messages (six kinds; "n" in the message is the source name):

- "The security group … specified by data source "n" no longer exists; it was not created by the platform, and the platform will not create one for you; pick another security group under "Data Sources → Edit → Network configuration", or have the account admin restore it and then start again"
- "The platform security group … of data source "n" no longer exists (deleted outside the platform), and automatic rebuild failed: …; retry later, and if it keeps failing contact a platform admin"
- "The subnet … specified by data source "n" no longer exists; it was not created by the platform, and the platform will not create one for you; pick another subnet under "Data Sources → Edit → Network configuration""
- "The subnet … of data source "n" no longer exists (deleted outside the platform), and automatic re-selection of a subnet failed: …; specify one manually under "Data Sources → Edit → Network configuration""
- "The Glue connection … of data source "n" no longer exists (deleted outside the platform), and rebuilding it from the source row and credentials failed: …; retry later"
- "The credential secret of data source "n" no longer exists, so the platform cannot rebuild the Glue connection; re-enter the username and password under "Data Sources → Edit""

## 6. Data sync

| Symptom | Meaning | What you can do | Where it appears |
|---|---|---|---|
| Red tag "Table exists (not created by platform; overwrite needs confirmation)" in the wizard's "Create table preview" | The target table is a table you already had, not one the platform created; with write mode "Overwrite" the task clears the whole table | To overwrite, confirm per table at submission; otherwise switch to "Append" or change the target table name | Data Sync "New sync task" |
| Dialog "Overwrite existing tables?" "These target tables already exist and were not created by the platform. Every run of this task will clear them completely:" with the button "Confirm overwrite" | Same as above, listed per table | Check the list, then click "Confirm overwrite"; without confirmation the task cannot be created | Same as above |
| Run-history error column "The target table already exists and was not created by the platform; this task has not confirmed the overwrite per table ⇒ the run was refused (not a single row touched); confirm the overwrite in the task editor or change the target table name" | Run-time guard `SYNC_REFUSED_CLEAR_FOREIGN_TABLE`: a task without confirmation that meets a same-named table not created by the platform **fails outright and deletes nothing** | Edit the task to confirm the overwrite, or change the target table name | Data Sync details · Task Monitor |
| Save 400 / start 409 `LAKE_ROUTE_NOT_FOUND`; the Table Bucket drop-down in the wizard tags "Not registered" and offers "Register →" and "Registered? Re-check" | The table bucket you entered is not a route of this execution environment (neither the platform table bucket nor registered under "Settings → Lake table buckets and routes") | Register it first (registering once = sync can write, jobs can access by alias, Athena query / governance catalog / Ask-Your-Data can see it); or clear Table Bucket and use the platform table bucket | Data Sync |
| Save 400 / start 409 `LAKE_ROUTE_NOT_WRITABLE`; the bucket is tagged "Read-only" in the drop-down | This route is registered as read-only | Change it to writable under "Settings → Lake table buckets and routes", or choose a writable route | Data Sync |
| 409 `START_IN_PROGRESS` | This DMS streaming task already has a start in progress; this click did not send another | Wait for it to finish; to abort click "Stop"; if it stays in "Starting" for a long time, "Stop" first and then "Start" | Data Sync "Start" (streaming channel) |
| 409 `TEARDOWN_IN_PROGRESS`: "The task status **stays unchanged** — the replication task **is on its way to stopping**; click "Stop" once more in a few dozen seconds." | The channel is stopping | Click "Stop" again after a few dozen seconds | Data Sync "Stop" |
| 409 "The task was **not deleted** — the channel **is on its way to stopping**; click "Delete" once more in a few dozen seconds (deleting the row first would leave an orphan that can never be taken down)." | Same as above | Click "Delete" again after a few dozen seconds | Data Sync "Delete" |
| 502 "The task was **not deleted** — deleting the row first would turn that channel into an orphan that can never be stopped from the platform (it keeps moving data and incurring cost). Please retry." | AWS refused to stop the channel; the platform does not change the record | Retry; if it persists, ask a platform admin | Data Sync "Delete" / "Stop" |
| 409 `CHANNEL_NOT_PUSHED_DOWN` "This task is bound to execution environment …, but the Zero-ETL channel has not been pushed down per region yet (managed integrations are currently provided only in the home region warehouse) — start refused" | Zero-ETL / DMS streaming channels are provided only in the home region | Create the task in the home region, or switch to the Glue channel | Data Sync "Start" |
| Run-history error column "The previous run is still finishing (the same Glue job can run only one at a time); start again later" | The previous run has not wound down yet | Start again later | Data Sync · Task Monitor |
| Run-history error column "The security group … of the data source no longer exists (deleted outside the platform). The platform will automatically rebuild its own group and reattach the Glue connection before the next start; this run failed. If the group was specified by you, pick another one under "Data Sources → Edit → Network configuration"" | The security group was deleted outside the platform (the AWS wording is Security Group Not Found) | Platform-created: start once more; specified by you: pick another group | Data Sync · Task Monitor |
| Run-history error column "The subnet … of the data source no longer exists (deleted outside the platform). …" / "The Glue connection … of the data source no longer exists (deleted outside the platform, or the source was deleted). …" | The subnet / Glue connection was deleted outside the platform | The message states the way out: automatic re-selection / rebuild, or specify it under network configuration; if the source was deleted, delete the tasks that reference it | Same as above |

The wording of the start 409 `START_IN_PROGRESS`:
"This task is already starting (the replication channel is being built; first use includes creating a replication instance, about 10–15 minutes); this click did not send another start — wait for it to finish; to abort click "Stop". If it stays in "Starting" for a long time, "Stop" first and then "Start" again"

The wording when the Table Bucket is not a route (the same sentence on save and on start):
"Execution environment … cannot write to table bucket "…": it is neither this execution environment's platform table bucket "…" nor registered as a route for this execution environment under "Settings → Lake table buckets and routes". Register it first (registering once = sync can write, Athena query / governance catalog / Ask-Your-Data can see it), or clear Table Bucket and use the platform table bucket; routes this execution environment can write: …"

The wording when the route is read-only:
"Lake route "…" (…) of execution environment … is registered as read-only; a sync task cannot select it as Table Bucket. Change it to writable under "Settings → Lake table buckets and routes", or choose another writable route"

## 7. Batch compute and EMR jobs

| Symptom | Meaning | What you can do | Where it appears |
|---|---|---|---|
| 409 `JOB_RUN_IN_PROGRESS` "This job still has N unfinished runs: "<runId>" (running · <region> · started <time>)… — deletion refused. Wait for these runs to finish before deleting…" (since 2.2.0) | Before deleting a job the platform checks in-flight runs; deleting now would leave the run records stuck in "Running" forever | Wait for the runs to finish; for EMR jobs you can "Stop" them in "Run History" first | Batch Compute "Delete" · EMR job "Delete" |
| 409 "This job is submitting a run right now — deletion refused. Retry in a few seconds." | Inside the submission window | Retry in a few seconds | Same as above |
| 409 `JOB_IN_USE` "This job is still referenced by the batch job nodes of N workflows: … — deletion refused. Remove the node from those workflows' canvases first (or point it at another job), then delete; …" | A job referenced by orchestration cannot be deleted | Remove the node or switch the job on the "ETL Orchestration" canvas | Batch Compute "Delete" · EMR job "Delete" |
| Save 400 "Job **not saved / submitted**: execution role `<role name>` is missing N required permissions ——" followed by one line per "· action → resource (decision)" and "why it is needed: …" | You picked your own execution role, and on save the platform measured permissions one by one against what the job really references (script, dependency libraries, lake table buckets) and refused on the spot | Follow the ways out in the message: ① in the job form's "Role Advisor" click "Recommend Execution Role Permissions" first, then "One-click create / repair role" (needs a platform admin) ② leave "Execution Role" blank to use the platform default role ③ switch dependency libraries to "Upload dependency files" ④ add the s3tables permissions, or remove that bucket from the declaration / change it to "Read" | Batch Compute · EMR job save |
| Save 400 "Execution role ARN is malformed: … — it should look like arn:aws:iam::<account>:role/<role name>." | A hand-typed ARN is wrong | Use "Pick from list" or correct the ARN | Same as above |
| Save 400 "Execution role `<role name>` **does not exist** in this account. Two ways out: ① leave "Execution Role" in the job spec **blank** ⇒ use the platform default role (its permissions are already complete); ② …" | The role name does not exist | Leave it blank or pick another | Same as above |
| Save 400 "Job **not saved / submitted**: the trust policy of execution role `<role name>` does not allow <service> to assume it, so that service cannot obtain this role. Ways out: add service … to this role's "trusted entities" in IAM, or leave "Execution Role" blank ⇒ use the platform default role." | The role does not trust Glue / EMR Serverless / Flink | Change the trust policy as the message says, or leave it blank | Same as above |
| "⚠️ The permission pre-check could not run: …. The job is submitted as usual, but if it reports AccessDenied, look at the required-permission list for this engine in "Role Advisor" first." | The check could not be measured (the platform itself has no permission to simulate); not blocking | Submit as usual; if AccessDenied appears, go back to the list | Same as above |
| The "Check permissions" button in the "Execution Role" section: green "Permissions complete (n checked)" / orange "Could not verify: …" / red "Missing n permissions" + "This role cannot be used yet" | Self-service pre-check before saving; the conclusion is the same as at save time | For red, follow the ways out above | Same as above |
| Save 400 `LAKE_ROUTE_NOT_FOUND` "Table bucket "…" is not a lake route of execution environment … (the platform table bucket "…" or a table bucket registered under "Settings → Lake table buckets and routes"). Register it first…" | A bucket declared under "Advanced properties → Lake table buckets" is not a route of that region | Register it first, or remove it from the declaration | Batch Compute · EMR job "Advanced Properties" |
| Save 400 `LAKE_ROUTE_NOT_WRITABLE` "Lake route "…" (…) is registered as read-only; the job cannot declare it as "Write" — change the access to "Read", or change it to writable under "Settings → Lake table buckets and routes"" | Write was declared on a read-only route | Pick one of the two as the message says | Same as above |
| Save 400 `LAKE_ROUTE_ALIAS_CONFLICT` "The hand-written Spark catalog "…" points to table bucket …, while the platform route "…" is … — the same alias cannot point to two buckets. Remove those spark.sql.catalog.… entries from your hand-written --conf (the platform injects them), or give the hand-written catalog another alias" | A catalog hand-written in the 2.1.x transition recipe collides with the alias of a new route | Remove the hand-written `--conf` and use three-part names | Same as above |
| Save 400 "Default catalog "…" is not a catalog available to this job (available: …)" / "… appears twice in the lake table-bucket declaration" | The default catalog must be one of this job's catalogs; the same bucket cannot be declared twice | Change as the message says | Same as above |
| Notice after saving "Ignored the hand-written spark.sql.defaultCatalog=…: the job already specifies a default catalog under "Lake table buckets", which the platform injects" | The platform took over the hand-written configuration; not an error | No action needed | Same as above |
| "Running in background: Run engine job" at the bottom right after clicking "Run" | An EMR application cold start can exceed 45 seconds, so the submission phase moves to the background | Wait; clicking run / edit / delete again during submission ⇒ 409 "is in progress" | EMR job |
| After "Run now (one run in each of N regions)" the message "Submitted one run in each of N regions: … (business date …)" | A multi-region job gets one run per region | See one row per region in "Run History" | Batch Compute |
| Backfill dialog "Backfill (run day by day over a business date range)" "Triggers one run per business date in the range (≤31 days), each parameterized with its own ${ds}." | The backfill range is capped at 31 days | Backfill in segments | Batch Compute "Backfill" |

The three groups in the execution-role drop-down: "Platform default (recommended, permissions complete)" · "Created by Role Advisor" · "Your own roles (must trust <service> and be able to read the buckets your job depends on)"; you can also "Enter ARN manually"; "Refresh" re-reads the IAM roles in the account (no need to leave the page for a freshly created role). The notice for multi-region jobs: "Multi-region job: the platform default resolves to each region's own role; your own role is pre-checked for every region."

## 8. ETL orchestration and scheduling

| Symptom | Meaning | What you can do | Where it appears |
|---|---|---|---|
| Publish 400 "Batch Job node "…" is not linked to a batch job and cannot be published — choose a batch compute job or an EMR Serverless job in the node configuration" | The job node has no job selected | Choose a job in the node configuration | ETL Orchestration "Publish to scheduler" |
| Publish 400 "The batch compute job … referenced by Batch Job node "…" does not exist (it may have been deleted) — re-select a job in the node configuration" | The job was deleted | Re-select | Same as above |
| Publish 400 "The job … referenced by Batch Job node "…" is not an EMR Serverless job (…) — re-select" | The node type and the job type do not match | Re-select | Same as above |
| Publish 400 "The job "…" referenced by Batch Job node "…" belongs to project …, while this workflow belongs to project … — a workflow can only reference jobs of its own project" | Cross-project reference | Switch to a job of this project | Same as above |
| Publish 400 "The job "…" referenced by Batch Job node "…" is bound to execution environment …, while this workflow is to be published to … — publish refused (it will not be run in another region on your behalf); bind that job to …, or pick a job bound to …" | The job is not bound to the workflow's execution region; the whole publish touches nothing | Add the region binding to the job in "Batch Compute", or pick another job | Same as above |
| 409 `SCHEDULER_NOT_INSTALLED` "The following execution environments have no scheduler component, so scheduling / orchestration cannot be configured for that region: …. Scheduled tasks of each region can only be run by that region's own scheduler; first add the airflow-serverless (recommended, minute-level) or mwaa component in Execution Environments." + the button "Add a scheduler in Execution Environments" | The region has no scheduler component | Click the button to go to "Execution Environments → Complete missing components" | ETL Orchestration · Task Monitor "Schedule config" · Batch Compute "Publish to MWAA schedule" |
| 400 `SERVERLESS_NODE_UNSUPPORTED` "This workflow contains a … node that MWAA Serverless cannot express: …. Way out: turn the cross-cycle dependency into an upstream / downstream relation inside the same graph; execution environments with classic MWAA installed keep working as before." | The graph contains a node this region's scheduler cannot express (an external sensor node with a cross-cycle dependency) — installing anything will not help; the graph must change | Turn the cross-cycle dependency into an upstream / downstream relation inside the same graph, then publish again | ETL Orchestration "Publish to scheduler" |
| 409 `SCHEDULER_ARTIFACT_MISSING` "… has no serverless workflow for this workflow (name …) — publish it again" | Neither the platform nor the scheduler can find this workflow's scheduling artifact | "Publish to scheduler" again | ETL Orchestration run details (node status / node logs) |
| 409 `WORKFLOW_SCHEDULER_UNSUPPORTED` "… has airflow-serverless installed — it has no Airflow web console (definitions and runs are presented on the platform side)" | This region's scheduler (MWAA Serverless) has no Airflow web console | Use the platform's run / node log pages instead | ETL Orchestration · Task Monitor "Schedule config" |
| "The same job never runs concurrently twice (job-level run lock)" | A workflow whose scheduler was switched regenerates its DAG | No action needed | ETL Orchestration |

## 9. Lake table buckets and routes (registered in Settings; Athena query / Ask-Your-Data / governance catalog resolve by route)

| Symptom | Meaning | What you can do | Where it appears |
|---|---|---|---|
| 400 "Invalid table bucket name: … (3–63 lowercase letters / digits / hyphens, starting and ending with a letter or digit)" | The name does not follow S3 Tables table-bucket naming | Check the name | Settings "Lake table buckets and routes" |
| 400 "Layer … is not in the list (options: detail / agg / result / ods / dim / other)" | The layer must be one of the listed values | Choose one | Same as above |
| 400 "Namespace … is invalid (lowercase letters / digits / underscores)" | The namespace ownership list contains an invalid name | Correct it | Same as above |
| 404 "No S3 Tables table bucket named <bucket> in <region> (…) — create it in that region before registering, or check the name" | The region has no such bucket | Create the bucket in AWS first, or check the name and the region | Same as above |
| 409 "<bucket> is the platform table bucket of execution environment … (alias s3tablescatalog); it is the default route already and needs no registration" | The platform table bucket is the implicit default route | No registration needed | Same as above |
| 409 "<bucket> is already registered for execution environment … (<time> by <person>, alias …)" | Duplicate registration | Edit the existing route instead | Same as above |
| 409 `LAKE_ROUTE_ALIAS_CONFLICT` "Alias "…" is already used by route … of execution environment …; choose another alias" | The alias must be unique within the region | Change the alias | Same as above |
| 409 `LAKE_ROUTE_NAMESPACE_CONFLICT` "Namespace … exists in both … (alias …) and … (alias …). Declare in namespaces which route owns … (only one) and retry; three-part names <alias>.<namespace>.<table> are unaffected" | Both buckets have a namespace with the same name, and the platform does not guess the owner | Enter it under "Namespace ownership" of one route | Same as above |
| 409 `DECISION_REQUIRED` "Changing the alias of route … from "…" to "…" would make jobs whose scripts say ….<namespace>.<table> unable to find the catalog (jobs declaring this route: …). To confirm, retry with confirmAliasChange=true" | Changing the alias breaks existing scripts | In the dialog "Changing the alias breaks scripts that reference the old alias. Change it anyway?" click "Change"; then update the three-part names in the scripts | Same as above |
| 400 "The route of platform table bucket … is the implicit default route (alias fixed to s3tablescatalog) and cannot be modified" / "… cannot be revoked" | The platform table bucket route can be neither changed nor revoked | No action needed | Same as above |
| 409 "Table bucket … is still referenced; remove the references before revoking: sync tasks …; jobs …" | References are checked before revoking | Change the sync tasks / job declarations first | Same as above |
| 400 `LAKE_ROUTE_NOT_FOUND` "Namespace … is not in any of the N lake routes of execution environment …: … — check the namespace name, or register the table bucket that holds it under "Settings → Lake table buckets and routes"" | Athena query / Ask-Your-Data / catalog look up the bucket by namespace and no route has it; **no fallback to the platform table bucket** | Check the name or register it | Athena Query · Ask-Your-Data · Data Governance catalog |
| 400 `LAKE_ROUTE_AMBIGUOUS` "Namespace … exists in both … (alias …) and … (alias …) — declare ownership on one of the routes under "Settings → Lake table buckets and routes" (enter … in namespaces)" | Both routes have this namespace and nobody declared ownership | Declare ownership | Same as above |
| 409 "Namespace … is declared as owned by both … (alias …) and … (alias …) — keep the ownership on only one route under "Settings → Lake table buckets and routes"" | Both routes declared the same namespace | Keep only one | Same as above |
| 400 "Execution environment … has no lake route with alias "…" (existing: …)" | A three-part name in the script uses a non-existent alias | Correct the alias against "Catalogs available to this job" | Batch Compute · EMR job |

The meaning of the layer / alias / namespace ownership / writable fields is in the [Configuration reference](31-reference-config.md); the complete procedure is in [Scenario: detail-bucket / summary-bucket layering](21-scenario-cross-bucket-layering.md).

## 10. Data modeling

| Symptom | Meaning | What you can do | Where it appears |
|---|---|---|---|
| The delete-definition dialog lists the physical tables per region and offers two ways out: "Open the landing panel to unbind and clean up per region" / "Keep physical tables, delete definition only" (type the confirmation string exactly) | Server-side 409 `DECISION_REQUIRED`: the definition still has landed artifacts, and the platform does not decide for you | Pick one; keeping the physical tables records "intentionally kept" per table in the audit | Data Modeling "Delete" |
| 409 wording "This definition still has landed artifacts in N regions (…) — unbind and clean up per region in the landing panel first, or pass keepTables=1 with the confirmation string to explicitly keep the physical tables and delete only the definition" | Same as above | Same as above | Same as above |
| Two kinds of unbind dialog: "Unbind only; keep the table already landed in that region" / "Unbind and clean up: DROP <table>" (the physical table name must be typed exactly) | Unbind only leaves a "Leftover" and the panel shows it as it is; clean up DROPs | Choose as needed; confirm the table name before cleaning up | Data Modeling landing panel |
| "Unbind and clean up DROPs … in that region (destructive) ⇒ the confirmation string must equal the physical table name … exactly" | The confirmation string is wrong | Type it exactly | Same as above |
| "Execution target … is neither bound nor has a landing record — nothing to unbind" | Nothing was landed in that region | No action needed | Same as above |
| "Running in background: Land code table to execution target / Apply dimension table to execution target" at the bottom right after "Land in this region" / "Apply" | The target region's warehouse cold start may exceed 45 seconds | Wait; deleting the same object meanwhile ⇒ 409 "is in progress" | Data Modeling · Multi-Region Dashboard "Land in this region" |
| 403 "Only platform admins can unbind code table landings" / "Only platform admins can view" (unbind preview) | Unbinding is for bgp-admin only | Ask a platform admin | Data Modeling |
| Altering a table structure that includes "Drop column" requires typing the table name to confirm; "Alter table" is greyed out for S3 Tables tables | Dropping a column is irreversible; S3 Tables tables offer no alter | Confirm as prompted; for S3 Tables tables do schema evolution with a Spark job | Data Governance "Alter table" |

## 11. Deleting a workspace

| Symptom | Meaning | What you can do | Where it appears |
|---|---|---|---|
| 409 "The workspace still has content; deletion refused (the platform does not cascade deletes): …. Migrate or delete this content first, then delete the workspace." | Before deleting a project the platform takes stock by category (jobs / sync tasks / workflows / reports / Ask-Your-Data cards / scheduled governance and data generation / unfinished Copilot and backfill plans, and so on); any non-zero category refuses | The message names which categories still have how many; delete or migrate them page by page | Workspace "Delete" |
| "Cannot verify the count of "…" (…) — deletion refused to avoid leaving orphan resources; …" | A resource category cannot be read, and the platform does not treat "cannot read" as "none" | Retry later | Same as above |
| "Cannot read the execution environment list, so credential reclamation cannot be scheduled — deletion refused (project not deleted; retry later): …" / "The credential-reclamation jobs of the following execution regions could not be queued; deletion refused (project not deleted; retry later): …" | Deleting a project first schedules the reclamation of each region's warehouse credentials | Retry later | Same as above |
| "Running in background: Delete workspace" at the bottom right | Stocktaking has to wait for the warehouse to wake up | Wait | Same as above |

## 12. Ask-Your-Data, session cards and the AI model

| Symptom | Meaning | What you can do | Where it appears |
|---|---|---|---|
| 403 "No access to this workspace" | Not a member of the current project | See section 2 | Ask-Your-Data |
| Notice "Select an execution scope in the top bar first (the card must remember which region this conversation queried)" | Saving a card requires knowing which region the data came from | Choose a specific execution environment in "Execution scope" in the top bar | Ask-Your-Data "Save conversation as card" |
| 409 `GENBI_CARD_QUOTA_EXCEEDED` "You have saved N/M session cards, the per-person limit. The platform does **not** delete your saved cards automatically — delete the ones you no longer need first." | Cards are capped per person | Delete some under "My cards" | Ask-Your-Data |
| "No cards in the current execution scope; you have m in other scopes — click 'Show all scopes' above" | Cards are filtered by execution scope | Click "Show all scopes"; the execution scope in the top bar does not change | Ask-Your-Data "My cards" |
| "The titles of n cards cannot be read right now (titles and bodies live in their own regions) — the cards themselves still exist; retry or open them directly" | A region is temporarily unreadable | Retry or "View read-only" | Same as above |
| "Go to Execution Environments to resolve" / "View read-only" on a card | The execution environment the card belongs to cannot accept work | Check in "Execution Environments"; or view read-only | Same as above |
| Saving "Change global default" in Settings fails | The probe did not pass; the reasons are in the table below | Switch model or act on the message | Settings "AI model" |
| 400 `ToolUseUnavailable` "This model cannot call tools under Converse (tool-use probe failed); GenBI / Copilot / advisors would go silent, so it cannot be the global default" | The model cannot do tool calls, and all AI capabilities of the platform rely on it | Switch model | Same as above |
| "GPT series is not open in phase 1 (transport gate)" / "This model is not in the selectable series catalog" | The family is not open yet / not in the catalog | Pick a model from the catalog | Same as above |
| 409 "Another admin just changed the config; refreshed, please choose again" | Concurrent modification | Choose again | Same as above |
| Success notice "Global default switched to …; effective platform-wide within 5s" | Success | None | Same as above |

The six kinds of model-probe failure text (the "AI model" card in Settings):

| Category | Page text |
|---|---|
| AccessDenied | "This account cannot invoke this model. Request access in the Bedrock console or pick an enabled model." |
| NotFound | "This model is unavailable in the current region. Pick one that is live here (the list is region-filtered; it may have just been retired)." |
| MarketplaceSCP | "This model requires an AWS Marketplace subscription, but your account policy (SCP) forbids subscribing to third-party models. Use a first-party Anthropic model or ask your account admin to allow subscriptions." |
| Throttle | "The probe was throttled; please retry shortly." |
| NotAvailableForAccount | "This model is not enabled for this account (Bedrock says "not available for this account" - an account-level restriction unrelated to region / IAM / Marketplace). Ask your AWS account team to enable it, or pick another version or vendor." |
| Timeout | "Probe timed out: the model did not respond within this family's budget (reasoning models can take tens of seconds to start; this is not throttling). Test again shortly; if it keeps timing out, switch to the global. inference profile or contact your AWS account team." |

## 13. Execution environments

| Symptom | Meaning | What you can do | Where it appears |
|---|---|---|---|
| Region drop-down in the wizard "Select a region (regions enabled in the account; regions that already have an execution environment are unavailable)" | One region can have only one execution environment | Pick another region, or retire the old one first | Execution Environments "New execution environment" |
| Wizard notice "n of them are pre-authorized by the control plane (usable right after the build); the others need ops to run the release command once after the build, then "Check initialization"" | A region that was not pre-authorized still needs ops to enable it once after installation | Pick a pre-authorized region, or contact ops (the command is in the [deployment manual](../deployment.md) §7) | Same as above |
| "The control plane has not enabled this region yet: the deployment can finish, but "Check initialization" will fail until it is enabled" | Same as above | Same as above | Same as above |
| A region blocked by organization policy (SCP) is unavailable and shows the blocked action; "Organization policy could not be verified" offers "Refresh" | The account policy does not allow building in that region | Pick another region or ask the account admin | Same as above |
| For a cross-jurisdiction region, "Start deployment" stays disabled until "Disclaimer (text v1)" is checked | Cross-jurisdiction registration requires the admin to agree to the notice first | Read and check it | Same as above |
| "Every execution environment must have all components installed (no reduced variant)." | Components cannot be trimmed | No action needed | Execution environment details |
| The button "Recover (record failure and unlock)" after a failed deployment | Records the failure and releases the deployment lock; health is set to unknown | Click it, then "Redeploy" | Execution environment details |
| "A deployment session is still in flight — silently retrying a new deployment is prohibited; available again once the session ends or is recovered" | The previous deployment has not wound down | Wait or "Recover" | Execution environment details |
| "Drain (stop accepting new work)" → dialog "Drain this execution environment?": "Once drained, this region **immediately stops accepting new work** (takes effect synchronously); **in-flight jobs run to completion** and no resources are destroyed." "Draining is **not deletion**…" | Stops accepting work; deletes nothing | "Confirm drain"; to resume, click "Confirm" in the resume dialog, which requires the next probe to be all green | Execution environment details |
| "Discard" | An environment that never got installed is discarded directly, freeing the slot for that region | Click "Discard" | Execution environment details |
| Delete: impact preview → type the region name to confirm → approval → destroy; "Data buckets / table bucket / final snapshot are retained and need manual cleanup" | Data resources are not destroyed with the deletion | Follow the wizard; the approval is under "Workspace → Pending my approval" (platform admins only) | Execution environment details |
| "Complete missing components" | Installs the missing components | Click it | Execution environment details |

## 14. Stream compute

| Symptom | Meaning | What you can do | Where it appears |
|---|---|---|---|
| 409 `TARGET_PUSHDOWN_UNAVAILABLE` "This job's stamp is …, but that execution environment's Flink channel cannot be resolved: …. 🔴 The platform deliberately does not run it in the home region instead — that would make the "stamp" and the "region it really runs in" diverge" | The region the job belongs to cannot resolve Flink resources right now | Check the region's status and components in "Execution Environments" | Stream Compute "Start" / "Generate Data" |
| "Running in background: Start streaming job / Stop streaming job / Delete streaming job" at the bottom right after "Start", "Stop", "Delete" | Waiting for the Flink application to reach a terminal state | Wait; clicking again meanwhile ⇒ 409 "is in progress" | Stream Compute |
| "Long SQL is normalized automatically and written to the application properties in chunks (2048-byte limit)" | Handled automatically by the platform; not an error | None | Stream Compute |

## 15. Other general notices

| Symptom | Meaning | What you can do | Where it appears |
|---|---|---|---|
| 410 "Data service retired" | The legacy dataapi data source in a report has been retired | Switch to the warehouse-query data source | Report Builder |
| `UPSTREAM_TIMEOUT` / `UPSTREAM_ERROR` + the AWS wording | A dependent AWS service timed out / errored; the platform does not change the record | Retry later; give the wording to a platform admin | Any page |
| `DECISION_REQUIRED` (409) | The platform does not perform destructive or semantics-changing actions on your behalf; it needs your confirmation | Decide as the dialog asks and retry | Modeling · governance alter table · route alias change |
| "Delete" shows "Deleted" only on success; on failure it shows the server's wording or "Delete failed (HTTP n)" | The page shows only real conclusions | Act on the wording | All list pages |
| "When not ready the page says "Check the deployment status"" | OpenMetadata is not up yet | Wait; if it persists, ask a platform admin | Governance Center |

## Further reading

- Concept explanations: [Core concepts](02-concepts.md) · [Glossary](33-glossary.md)
- Find answers by symptom: [User FAQ](32-faq.md)
- Field-level configuration: [Configuration reference](31-reference-config.md)
- Known boundaries of the platform (operations view): [Deployment manual](../deployment.md) §8 · [Module overview](../modules.md)
