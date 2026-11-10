# Glossary

| Item | Description |
|---|---|
| Audience | Anyone in any role who is new to the platform |
| Estimated time | 15 minutes to read through; 1 minute per lookup |
| Prerequisites | None |
| What you will have | A one-line explanation of every term that appears on the pages, in messages and in this guide, plus the page where you see it |

Note: the "English term" column is the word that appears in the console's English mode or in verbatim messages (switch the console language with the globe icon to see the Chinese label); "Where you see it" names the page (menu group → page).

## 1. Top bar and scope

| English term | One-line explanation | Where you see it |
|---|---|---|
| Workspace | The boundary of resources and permissions: data sources / sync / jobs / workflows / reports and so on are visible only in their own project; each project has independent warehouse credentials per region | Top-bar "Workspace" switcher · System → Workspaces |
| Default Workspace | The workspace pre-created by the platform, holding legacy resources; it starts with no members, and non-administrators must be added first | System → Workspaces |
| Environment (dev / staging / prod) | Three isolated copies of configuration-type resources within a project: development / staging / production; publishing to prod requires approval | Top-bar "Environment" switcher |
| Publish to environment (promote) | Push objects finished in dev (definitions, not run history) to staging (takes effect immediately) or prod (requires approval) | "Publish to environment" in Batch Compute · Data Sync · ETL Orchestration |
| Pending my approval (approvals inbox) | Approvals you must handle as owner: publishing to prod, joining a project, data access, deleting an execution environment (platform administrators only) | "Pending my approval (n)" at the top of System → Workspaces |
| Execution scope | Choose "All" or a single region in the top bar: it only affects reads (lists / dashboards) and does not decide where things really run; an invalid or unauthorized scope is always rejected, never quietly switched back to the home region | Top-bar "Execution scope" dropdown |
| All (global) | One value of the execution scope: lists objects from every execution environment that is fully installed | First item of the top-bar "Execution scope" dropdown |
| Target (place) | "Which execution environment an object / run executes in"; every write operation must carry it explicitly, otherwise 400 — it never defaults to the home region | "Execution region" in forms · targetId in verbatim error messages |
| Execution regions (multi-select) | The bound regions you tick when creating a job / query; one job can be bound to several regions, and one run executes once per region | Batch Compute · Redshift Query · ETL Orchestration |
| Select all active regions | Tick every execution environment that is "Running" and visible to this project in one click | Batch Compute · Redshift Query |
| Multi-tabs | Every page you visit opens a tab; switching does not unload it; right-click for "Close others / Close tabs to the right / Close all" | Tab strip under the top bar |
| User guide (operation guide) | The "How to use this page" drawer opened by the ❓ at the top right of every page; an interactive tour runs on first visit | ❓ at the top right of any page · "Onboarding" on the home page |

## 2. Execution environments and multi-region

| English term | One-line explanation | Where you see it |
|---|---|---|
| Execution environment / execution region / execution target | A complete data plane in one AWS Region (warehouse · data lake · job engines · scheduler · real-time); "execution target", "target" and "tag" in error messages all refer to it | System → Execution Environments |
| Home region | The region chosen at installation: where the control plane (pages / metadata / governance center / agents) lives, and itself an execution environment; tagged "Home region" in dropdowns | Top-bar "Execution scope" dropdown · execution environment list |
| Components | The data-plane parts installed in an execution environment (warehouse / real-time / scheduler and so on); every region must install the full set — no lean variant | Execution environment detail |
| Check initialization (probe) | Probes each component; only when all are green can you "Enable" | Execution environment detail |
| Enable (activate) | After all probes are green, let the region start accepting jobs and queries | Execution environment detail |
| Allow region (pre-authorize) | The control plane's authorization for a region; regions pre-authorized at install / upgrade are "usable right after the build", the rest need one operations allow step after the build | Region list hint in the new execution environment wizard |
| Authorized projects | An execution environment is visible and usable only to the projects on its allow-list; defaults to all projects | "Authorized projects" card in the execution environment detail |
| Not accepting work (not serviceable) | The region is currently deploying / draining / not fully green and takes no new work for now; tagged in the top-bar dropdown | Top-bar "Execution scope" dropdown · execution environment list |
| Drain (stop accepting new work) | Stop accepting new work immediately, let in-flight jobs finish, destroy nothing; "Confirm" to resume | Execution environment detail |
| Redeploy / Complete missing components | After a platform upgrade, refresh the region's stacks to the new version (dry run first, then approval); or install missing components | Execution environment detail |
| Discard | Give up an execution environment that never finished building, freeing that Region's slot | Execution environment detail |
| Delete execution environment (decommission) | Impact preview → type the Region name to confirm → approval → destroy; data buckets / table buckets / final snapshots are kept | Execution environment detail |
| Jurisdiction | A marker typed by the administrator when registering an execution environment (default `home`); a region whose jurisdiction differs from the home region's is "cross-jurisdiction"; immutable after registration, and the platform makes no legal judgement | New execution environment wizard · execution environment detail · 🌍 tag in result sheet headers |
| Disclaimer | The notice shown before your first data operation on a cross-jurisdiction region; after "Agree and continue" it is recorded (user / target / version / time), once per person per region | First cross-jurisdiction operation in Redshift Query · Batch Compute · Data Modeling and so on |
| Consents (acknowledgements) | Look up who agreed to which version of the disclaimer and when | "Consents" card in the execution environment detail |
| Audit # (audit id) | The number of the regional audit record a cross-jurisdiction operation leaves in that region; look it up in the audit log | Redshift Query sheet header · "Audit" column in run history · Task Monitor |
| Regional (residency) audit | The dual audit of cross-jurisdiction operations: the full record in that region + a summary without sensitive content in the home region; if either write fails, nothing executes | System → Audit Log (residency.* actions) |
| Multi-Region Dashboard | The version-consistency matrix of every job / modeling artifact across regions: missing publishes / mismatched versions / failures at a glance; ⊘ pending re-landing and ⊘ data unavailable both stay out of the verdict | Scheduling & Ops → Multi-Region Dashboard |

## 3. Permissions

| English term | One-line explanation | Where you see it |
|---|---|---|
| Platform group (role group) | Platform-level account groups: bgp-admin platform administrator · bgp-manager development manager · bgp-developer developer · bgp-analyst business analyst (GenBI and requests only) | System → Users |
| Project role | A person's role inside one project: owner manages configuration and approvals · editor can develop · viewer only views / asks | System → Workspaces → "Members / Approvals" |
| Platform admin (bgp-admin) | Can perform every administrative action: create execution environments, change the AI model, register table-bucket routes, alter table structures, schedule governance tasks, unbind landings | Every administration page |
| Manager (bgp-manager) | Can create workspaces; like the platform administrator, manages project configuration when acting as owner | System → Workspaces |
| Execution Role | The IAM role a job runs with: platform default (full permissions) / generated by the Role Advisor / your own (pre-checked item by item against what the job actually references when saving) | "Execution Role" in the Batch Compute · EMR job form |
| Role Advisor | Click "Recommend Execution Role Permissions" against the engine's required-permission list, then "One-click create / repair role" to build a platform-managed role (platform administrator required) | "Role Advisor" in the job form |
| Check permissions (preflight) | One measurement before saving: role exists / trusts the service / required permissions + every S3 object the job references; verdicts "permissions complete", "could not verify", "missing n permissions" | Next to "Execution Role" in the job form |

## 4. Data integration

| English term | One-line explanation | Where you see it |
|---|---|---|
| Data Source | A registered external source (MySQL / PostgreSQL / Oracle / SQL Server / DynamoDB / S3 / Kinesis / MSK); stamped with its execution environment on creation, immutable afterwards | Data Integration → Data Sources |
| Network Access / Network configuration | When the database is inside a VPC, the Glue connection must join its VPC / subnets / security groups; leave empty and the platform probes automatically | "Network configuration" → "Save Network Access" in the Data Sources row; "Network Access (optional)" block in the new wizard |
| Network advisor | Probes VPC / subnets / security groups / routes / endpoints, gives a reachability verdict and one-click allow suggestions | Data Sources new / edit wizard |
| Detect (probe) | Really signs in to the source database once through the source's own Glue connection; verdict "Connected" or "Unreachable" | "Detect" in the Data Sources row |
| Browse tables | Lists the tables in the source database | Data Sources detail |
| Network object missing | A security group / subnet / Glue connection / secret this source depends on was deleted in the account; platform-created ones self-heal, your own must be replaced by you | Red tag in the Data Sources list |
| Sync task | A task that syncs source tables to the region's data lake (S3 Tables) and / or warehouse (Redshift) | Data Integration → Data Sync |
| Sync mode | Full load / incremental / real-time (CDC) | Sync wizard · "Sync mode" column of the list |
| Sync channel | Which channel moves the data: Glue ETL (batch) · DMS (real-time CDC) · Zero-ETL (managed integration); the latter two are home-region only and bill continuously | Sync wizard · "Sync channel" column of the list |
| Write mode | Append / overwrite / merge; must be chosen explicitly; overwriting an existing table not created by the platform must be confirmed per table | Sync wizard |
| Confirm overwrite | Per-table confirmation for tables flagged "Table exists (not created by platform; overwrite needs confirmation)"; an unconfirmed task fails outright at run time and deletes not one row | Dialog when submitting the sync wizard |
| Date variables | Business-date placeholders usable in sync / jobs (such as `${ds}`), replaced by the business date at run time; list in the [Configuration reference](31-reference-config.md) | Sync wizard · job scripts |
| Replication instance | The foundation created the first time a DMS real-time channel starts, about 10–15 minutes; has an ongoing cost | "Start" message of a real-time task in Data Sync |

## 5. Data development and scheduling

| English term | One-line explanation | Where you see it |
|---|---|---|
| Batch job (Batch Compute) | Three kinds: Glue PySpark script job · Redshift SQL job · EMR Serverless (PySpark); can be bound to several regions | Data Development → Batch Compute |
| Engine Job | Another name for an EMR Serverless job; the submit phase of "Run" moves to the background | EMR panel in Batch Compute |
| Business date (ds) | The data date this run represents (YYYY-MM-DD), passed to the script as `--ds` and similar parameters; "Run now" lets you set it | "Business date" input in Batch Compute · "Business date" column in run history |
| Backfill | Rerun a range of historical business dates day by day (≤31 days per request); backfill runs are isolated from online scheduling and excluded from success rate and SLA | "Backfill" in Batch Compute · Scheduling & Ops → Backfill Center |
| Dry run | Validates a Redshift SQL job with EXPLAIN without writing data | Batch Compute |
| Run History | One row per run: business date · region · status · start / end · error · audit | Batch Compute · Data Sync detail · Task Monitor |
| Run group | The set of all runs from one multi-region run / one workflow trigger, for cancelling or retrying failures as a whole | Task Monitor · ETL Orchestration |
| Publish to MWAA schedule / Publish to scheduler | Attach a job / workflow to the region's scheduler (MWAA Serverless) to run on cron; republish after changing parameters | Batch Compute · ETL Orchestration |
| Workflow / ETL Orchestration (DAG) | Connect sync nodes, batch job nodes and SQL / Python nodes into a dependency chain on the canvas | Data Development → ETL Orchestration |
| Job node | References a batch job or EMR job in this project that is bound to this workflow's execution region; bindings are checked on publish, and referenced jobs cannot be deleted | ETL Orchestration canvas |
| Scheduler | Each region's own MWAA Serverless; a region without one cannot configure schedules / workflows | "Schedule config" in Task Monitor · execution environment components |
| Job run lock | The same job never runs concurrently twice | ETL Orchestration hint |
| Task Monitor | The unified view of run instances across the platform: filtering, run logs, reruns, audit lookup | Scheduling & Ops → Task Monitor |
| Redshift Query (warehouse direct query) | The Redshift Query page: one SQL statement can hit several regions, one result sheet per region, with "⚖ Compare" or "Merge into one table"; read-only for non-administrators | Data Development → Redshift Query |
| Athena Query (lake direct query) | The Athena Query page: interactive SQL over S3 Tables table buckets; namespaces are resolved by route | Data Development → Athena Query |
| Streaming job (Flink job) | A Flink SQL streaming job: reads from Kinesis / MSK, writes to the data lake / warehouse; start / stop / delete move to the background | Data Development → Stream Compute |
| Generate Data (produce sample events) | Writes a batch of sample events into the sample stream on the Stream Compute page so you can see aggregated results | Stream Compute |

## 6. Lake table buckets and routes

| English term | One-line explanation | Where you see it |
|---|---|---|
| S3 Tables table bucket | The S3 Tables bucket that stores Iceberg tables; every execution environment has one platform table bucket, and customer table buckets can be registered too | "Table Bucket" in the sync wizard · Settings |
| Platform table bucket | The table bucket created when the region was installed; the implicit default route, alias fixed to `s3tablescatalog`, cannot be changed or revoked | "Lake table buckets and routes" in Settings · tagged "Platform table bucket of this region" in the wizard dropdown |
| Lake table buckets and routes | One route table per execution environment: table bucket → alias / tier / namespace ownership / writable; registering once = sync can write it, jobs reach it by alias, lake query / governance catalog / GenBI see it | "Lake table buckets and routes" card in System → Settings |
| Alias | A route's name in scripts, the first part of the three-part name; unique within a region | Settings · "Catalogs available to this job" in the job |
| Tier | A route's tier label: detail / agg / result / ods / dim / other | Settings · wizard dropdown (bucket · alias · tier) |
| Namespace | The database-level grouping inside a table bucket (Iceberg namespace); the second part of the three-part name | Athena Query table tree · "S3 Tables namespace" of a sync task |
| Namespace ownership | When the same namespace appears in two routes, declares which route it belongs to; without a declaration the platform does not guess | "Lake table buckets and routes" in Settings |
| Writable / Read-only | Whether a route can be a sync target or a job "write" declaration | Settings · tagged "Read-only" in the wizard dropdown |
| Three-part name | `<alias>.<namespace>.<table>`; write it directly for cross-bucket reads and writes | Job scripts · Athena Query |
| Federated catalog (s3tablescatalog) | The catalog through which Athena / Glue see S3 Tables; the platform table bucket's alias is exactly this | Athena Query · catalogs injected into jobs |
| Lake table buckets (job declaration) | The job's "Advanced properties → Lake table buckets": by default every route in the region is usable; you can tick a subset and mark each bucket read / write, and permissions are measured per bucket on save | "Advanced properties" of Batch Compute · EMR jobs |
| Catalogs available to this job | The list of aliases the job can currently use | "Advanced properties → Lake table buckets" of the job |

## 7. Background execution

| English term | One-line explanation | Where you see it |
|---|---|---|
| Long-running operation / running in background | An action that waits for an external system to reach a terminal state: returns synchronously if done within 45 seconds; otherwise moves to the background with "Running in background: <label> (n s elapsed)" at the bottom right, disappearing at the terminal state; 5-minute ceiling | Bottom-right notice |
| Object lease | While a background execution runs, the object is "held": a second one on the same object, or an edit / delete ⇒ 409 ""<label>" is in progress (n s elapsed); wait for it to finish before acting" | 409 message |

## 8. Smart analytics

| English term | One-line explanation | Where you see it |
|---|---|---|
| Ask-Your-Data (GenBI) | Ask your data in natural language: retrieves relevant tables, generates and executes SQL (read-only), gives a conclusion; really queries in the region where the data lives | Smart Analytics → Ask-Your-Data |
| View generated SQL | Check the data-retrieval logic behind this answer | Ask-Your-Data result card |
| Session card | Save a conversation: continue it, refresh it on schedule, keep run snapshots; each person has a limit; the card remembers which region it queries | "My cards" · "Save conversation as card" in Ask-Your-Data |
| Skills | Packaged business definitions / common queries, loaded automatically by Ask-Your-Data and Copilot sessions | Smart Analytics → Skills |
| Business Glossary & Rules (business definitions and rules) | Metric definitions, rules and terms referenced by GenBI and governance | Data Governance → Business Glossary & Rules |
| Observability | Skill hits, call volume and latency | Smart Analytics → Observability |
| Report Builder | Drag-and-drop reports and dashboards, sourced from warehouse queries | Smart Analytics → Report Builder |
| Requests (requirements workbench) | Business submits a request → development "Generate implementation with LLM" → "Create ETL job" | Smart Analytics → Requests |
| Copilot plan | One request generates a step-by-step plan (create source / sync / job / schedule); objects are created only after you confirm each step, and only created, never executed | AI Hub → Copilot Plan Center |
| Global default model | The large language model shared by every AI capability on the platform; a real probe runs before a change and must pass before saving | "AI model" card in Settings |
| Probe | Really calls the model once and (for some families) verifies tool use; failure categories in the [Rules reference](30-reference-rules.md) | "Test this model" in Settings |

## 9. Data governance and modeling

| English term | One-line explanation | Where you see it |
|---|---|---|
| Governance catalog | The table and column inventory of the warehouse / table buckets; "Sync column information" fills in the real columns | Data Governance → Data Governance |
| Classification and masking | Assign sensitivity levels and masking rules to columns; GenBI / card results are masked by physical column (aliased columns included) | Data Governance |
| Sensitive Scan | Automatically identifies suspected sensitive columns and suggests a level, which can be adopted into the classification | "Start Scan" in Data Governance |
| Quality rules | Templates generate validation SQL that runs in the warehouse, with scoring and SLA | Data Governance · Alerting Center |
| Lineage / Impact analysis | Table-level and column-level provenance; who is affected when a table changes | Data Governance · Governance Center |
| Governance Center (OpenMetadata) | The built-in unified metadata catalog (one for the whole platform) | Data Governance → Governance Center |
| Governance Workbench | The overall governance health score (security / quality / SLA / lineage) and to-dos | Data Governance → Governance Workbench |
| Warehouse layers / Data Domain / Data Standard / Code table / Dimensional modeling / Metric system | The six tabs of Data Modeling; code tables and dimension tables can be "landed" in each region's warehouse | Data Governance → Data Modeling tabs |
| Land / Apply | Materialize a code table / dimension table in one region's warehouse; the board shows each region's status and drift | Data Modeling landing panel · "Land in this region" |
| drift | Drift | After landing, the physical table no longer matches the definition | Data Modeling landing panel · Multi-Region Dashboard |
| Leftover | The physical table still left in the region after "Unbind only"; the panel shows it as is, never hides it | Data Modeling landing panel |
| Unbind and clean up | DROP the region's physical table and remove the landing record; the physical table name must be typed exactly | Data Modeling landing panel |

## 10. Operations and cost

| English term | One-line explanation | Where you see it |
|---|---|---|
| Alert Rules / Notification Channels | Rules with four conditions — failure / timeout / success rate / no-run — pushed on match to DingTalk / WeCom / email / generic webhook; SLA warnings are on the "SLA & Baseline Alerts" tab of the same page | Scheduling & Ops → Alerting Center |
| SLA baseline | The completion-time / duration baseline learned automatically from historical runs, warning before a breach; one row per region | "SLA & Baseline Alerts" in the Alerting Center |
| Incident signature | The incident category into which AI diagnoses of failed tasks are merged by fingerprint; recurrences of the same kind only increment the count | Scheduling & Ops → Incident Knowledge Base |
| Fix runbook | The "verified fix method" you write for an incident category, referenced directly by the next diagnosis of the same kind | "Save fix runbook" in the Incident Knowledge Base |
| Redacted export | Export Incident Knowledge Base entries with sensitive data removed | Incident Knowledge Base |
| Ops Dashboard | Today's runs, timeline (Gantt) and failure distribution on one screen | Scheduling & Ops → Ops Dashboard |
| FinOps | Bills drilled down to task / run level (T+1): overview · ranking · task-level attribution · budget alerts | Scheduling & Ops → FinOps |
| Wiring status | The connection health of the platform's dependencies: governance center / agents / scheduler and so on | "Refresh status" in Settings |
| Platform version | The current release tag and version number | Sign-in page footer · "Platform version" card in Settings |

## Further reading

- How the concepts fit together: [Core concepts](02-concepts.md)
- The verbatim text and way out for every rejection: [Rules and status-code reference](30-reference-rules.md)
- Internal vocabulary (for operations / developers): `AGENTS.md` at the repository root
