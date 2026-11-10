# Configuration reference: fields, options and meanings on each page

| Item | Description |
|---|---|
| Audience | Data engineers · platform admins · operators (look things up while writing configuration or troubleshooting) |
| Estimated time | Consult as needed; about 20 minutes to read through |
| Prerequisites | You have read [Core concepts](02-concepts.md) and know which page you are on |
| What you get | One table per page with the meaning, options and default of every field; fields mentioned in an error can be mapped back to the page |

The "Location" column of each table gives the page name (menu group → page → section), identical to the on-screen label. The defaults in the tables are those of objects newly created in 2.2.0; saved objects are not changed by an upgrade.

---

## 1. Business date variables (shared by sync tasks and batch jobs, 15 in total)

One set of variables, one table platform-wide. The examples below assume business date `2026-01-15`.

| Variable | Meaning | Example | Location |
|---|---|---|---|
| `ds` | Business date, `YYYY-MM-DD` | `2026-01-15` | Data Sync → "Available variables" under Data filter (WHERE); Batch Compute scripts |
| `ds_nodash` | Business date, no dashes | `20260115` | Same as above |
| `yesterday_ds` | The day before the business date | `2026-01-14` | Same as above |
| `yesterday_ds_nodash` | The day before, no dashes | `20260114` | Same as above |
| `tomorrow_ds` | The day after the business date | `2026-01-16` | Same as above |
| `tomorrow_ds_nodash` | The day after, no dashes | `20260116` | Same as above |
| `run_date` | Same as `ds` | `2026-01-15` | Same as above ("Quick → Same day" fills in exactly `created_at >= '${run_date}'`) |
| `yesterday` | Same as `yesterday_ds` | `2026-01-14` | Same as above |
| `ds_month` | Month of the business date, `YYYYMM` | `202601` | Same as above |
| `last_month` | Previous month, `YYYYMM` | `202512` | Same as above |
| `last_month_std` | Previous month, `YYYY-MM` | `2025-12` | Same as above |
| `bizdate` | The day before the run date, no dashes (day-before-run convention) | `20260114` | Same as above |
| `bizdate_std` | The day before the run date, `YYYY-MM-DD` | `2026-01-14` | Same as above |
| `bizmonth` | The month before the run date, `YYYYMM` | `202512` | Same as above |
| `bizmonth_std` | The month before the run date, `YYYY-MM` | `2025-12` | Same as above |

How to use them:

| Scenario | Syntax | When the value is taken | Location |
|---|---|---|---|
| Sync task filter condition / source table name with date variables | `${variable}`, e.g. `created_at >= '${run_date}'`, `cf_point_${bizmonth}` | At run time, the current day in the "Business-date time zone"; when a manual run / backfill specifies a business date, that date is used | Data Sync → Source configuration |
| Redshift SQL job | `${ds}` / `${ds_nodash}` / `${yesterday_ds}` etc. in the script, replaced as text | The "Business date" input (defaults to today, UTC); backfill uses one per day | Batch Compute → Edit script |
| Glue PySpark job | Passed as `--ds` and similar parameters; the script reads them with `getResolvedOptions(sys.argv, ["ds"])` | Same as above | Batch Compute → Edit script |
| EMR Serverless job | Appended as `--ds <value>` etc. after the "Script arguments"; read by parameter name | Same as above | Batch Compute → EMR job panel |
| Invalid input | Non-existent dates (e.g. `2026-02-30`) are rejected; an unsupported variable name in a sync task shows "Unsupported variable ${x} (in "…"; available: …)"; an unknown `${x}` in a batch job script is kept as is without error | On save / at run time | Data Sync → Source configuration; Batch Compute → Edit script |

---

## 2. Sync tasks (Data Integration → Data Sync → New sync task)

The wizard has five steps: "Source configuration" → "Select Tables & Mapping" → "Target configuration" → "Create table preview" → "Schedule settings", then "Done".

### 2.1 Source configuration

| Field | Meaning | Options / example | Location |
|---|---|---|---|
| Sync mode | Move everything at once, incrementally by a field, or real-time CDC | "Full-load sync" (default) · "Incremental sync (CDC)" · "Real-time sync (DMS CDC)" | Source configuration |
| Write mode | How rows are written to the target table | "Overwrite" (default) · "Append" · "Merge" | Source configuration |
| Target type | Where to write | "S3 Data Lake" · Redshift (default) · "S3 + Redshift" | Source configuration |
| Channel Recommendation | Recommends and restricts the available channels based on mode + target; "Recommendation" tag in green, "Not supported" tag in red | Glue ETL · Zero-ETL · DMS CDC | Source configuration → Channel Recommendation |
| Data filter (WHERE) | Condition pushed down to the source database; write only the part after WHERE, no semicolon; use the source database's dialect; JDBC sources only | `created_at >= '${run_date}'`; quick picks "Same day" and "Last 7 days" (MySQL syntax) | Source configuration |
| Incremental strategy | How incremental sync decides what counts as "new data" | "Timestamp" · "Auto-increment ID" · CDC | Source configuration → Incremental config |
| Incremental field / Start Value | The column to compare on and the starting point of the first run | `updated_at` / `2026-01-01 00:00:00` | Source configuration → Incremental config |
| Current watermark (incrementalValue) | Each run reads only rows where "incremental field > current watermark" and advances automatically on success; clear it or set 0 to backfill everything again | Maintained automatically | Source configuration → Incremental config |
| Business-date time zone | When no business date is given at run time, "today" is taken in this time zone | IANA time zone name, e.g. `Asia/Singapore`; empty = UTC | Source configuration |

### 2.2 Select Tables & Mapping

| Field | Meaning | Options / example | Location |
|---|---|---|---|
| Source table list | Check the tables to sync; the "Target type" column shows compatibility | Multi-select | Select Tables & Mapping |
| Table names with date variables | When the source database shards tables by date, write the table name with a variable so each run reads only the table for the business date | `cf_point_${bizmonth}`; a "Fixed target table name" is required | Select Tables & Mapping → Add a table name with date variables |
| Sample table | For a table name with variables, pick a real table with the same structure; it is used only to read the column structure and is never synced | A real table name in the source database | Select Tables & Mapping |
| Derived columns | New columns computed from the date in a source column before writing; can be used as partition columns | New column name / source column / format `yyyyMM` `yyyyMMdd` `yyyy-MM` `yyyy-MM-dd` `yyyy` | Select Tables & Mapping → Derived columns |

### 2.3 Target configuration

| Field | Meaning | Options / example | Location |
|---|---|---|---|
| Table Bucket | Which S3 Tables table bucket to write to; empty = platform table bucket; a customer-owned bucket must be a **writable route** of this region | The dropdown shows `bucket · alias · tier` with "Registered", "Platform table bucket of this region" and "Not registered" tags; read-only routes are not listed | Target configuration → S3 Tables Data Lake Configuration |
| Namespace | Target namespace | "Auto (follow DB name)" (= source database name) · "Manual" | Target configuration → S3 Tables Data Lake Configuration |
| Table name prefix / Table name suffix / Target name for each table | Target table naming; empty = prefix + source table name + suffix | `ods_` | Target configuration |
| Partition config | Partition fields and types of the target table | "Add partition field"; types "📅 Date" and "🔤 String" | Target configuration → Partition config |
| Auto-compaction Interval (minutes) | How often Iceberg compacts small files automatically | 5–1440, default 60 | Target configuration → Iceberg |
| Overwrite scope | Whether an overwrite replaces the whole table or only the partitions touched by this batch; applies only to "Full load + Overwrite" | "Whole table" · "By partition" + choose partition columns (when writing to S3 Tables the partition fields must be exactly these columns, partitioned by raw value; writing to Redshift supports one column only) | Target configuration → Overwrite options |
| Allow clearing the target table even if 0 rows are read | By default 0 source rows counts as a failure and the target is left untouched; when checked, clearing is allowed | On / off (default off) | Target configuration → Overwrite options |
| Merge keys | Required for "Merge": rows matching on these columns are updated, the rest are inserted; duplicate or null keys in the source fail the run | At least one column; candidates = columns of the selected source tables | Target configuration → Merge options |
| Redshift Configuration | Workgroup / database when writing to Redshift (resolved automatically if empty) | Dropdown | Target configuration → Redshift Configuration |
| Overwrite existing tables | When the target table already exists and was not created by the platform, overwriting requires confirmation | Dialog "Overwrite existing tables?" → "Confirm overwrite" | Dialog shown when you click "Done" |

### 2.4 Glue Job Resources / DMS Task Settings

| Field | Meaning | Options / example | Location |
|---|---|---|---|
| Glue Version | Which version the generated Glue job runs on; writing to S3 Tables needs 5.1 or later | `4.0` `5.0` `5.1` `6.0` (default 6.0; the dropdown shows the Spark / Python versions; versions below 5.1 cannot be selected when the target includes S3 Tables) | Target configuration → Glue Job Resources |
| Worker Type / Worker Count | Size and number of Glue workers | See section 3.2 of this document for sizes; default `G.1X` / 2 | Target configuration → Glue Job Resources |
| Retry on failure | Number of in-place reruns at the Glue job level (distinct from scheduler-level retries) | Default 0 | Target configuration → Glue Job Resources |
| Full-load parallel subtasks | DMS full-load parallelism | 1–49, default 8 | Target configuration → DMS Task Settings |
| CDC Batch Apply | Batches small transactions when writing to the target to speed up high-throughput CDC; keep it off when transaction order matters | On / off (default off) | Target configuration → DMS Task Settings |
| Network access | VPC / subnets / security groups are determined by the data source's Glue connection | Adjust under "Data Sources → Network configuration" | Target configuration |
| Job timeout (minutes) | Timeout of a single Glue job run | 5–2880, default 60 | Sync wizard step 5 |
| Data Validation | Whether the DMS task enables data validation | On / off | Sync wizard (DMS channel) |

### 2.5 Schedule settings

| Field | Meaning | Options / example | Location |
|---|---|---|---|
| Enable scheduling | Whether to run on a cron schedule | On / off | Schedule settings |
| Cron Expression | Five-field cron | `0 2 * * *`; quick picks "Hourly" `0 * * * *` · "Daily at 2 AM" `0 2 * * *` · "Every 6 hours" `0 */6 * * *` | Schedule settings |
| Retry on failure | Scheduler-level retry count | 0–5, default 2 | Schedule settings |
| Timeout (sec) | Timeout of a single run | 60–86400, default 3600 | Schedule settings |
| Downstream dependencies | Sync tasks / workflows triggered automatically when this task succeeds | Multi-select | Schedule settings → Dependency scheduling |

---

## 3. Batch jobs (Data Development → Batch Compute)

### 3.1 New job and common fields

| Field | Meaning | Options / example | Location |
|---|---|---|---|
| Job name | Name of the job | `agg_orders_daily` | New ETL Job |
| Job type | Engine | "Glue PySpark Script Job" · "Redshift SQL Job" · "EMR Serverless (PySpark, standalone engine)" | New ETL Job |
| Execution region (multi-select) | Execution environments the job is bound to; one run executes once in each region | Checkboxes; "Select all active regions (N)" | Edit script |
| Business date | The `ds` of this run | `YYYY-MM-DD`, default today (UTC) | Edit script → run bar |
| Run now | Submits a run; the button restates the target | "Run now · <region>" / "Run now (once in each of N regions)" | Edit script → run bar |
| Dry run | Redshift SQL only: validates with EXPLAIN without writing data | "Dry run" / "Dry run (N regions)" | Edit script → run bar |
| Backfill | Runs day by day over a business date range | Dialog "Backfill (run day by day over a business date range)": "Start Date", "End date", ≤31 days → "Start backfill" | Edit script → run bar |
| cron / Publish to MWAA schedule | Attaches the job to this region's scheduler | `cron: 0 * * * *`; "Publish to MWAA schedule" · "Take schedule offline" · "Trigger once" | Edit script → run bar |
| Version history | Past versions of the job definition | — | Edit script |
| Publish to environment | dev → staging takes effect immediately; → prod needs approval by the workspace owner | Button "Publish to environment" → menu "Publish to staging" · "Publish to prod (approval required)" | Edit script → run bar |
| Run history | One run per region; "Logs" in each row, the "Audit" column records the cross-jurisdiction audit id; when one click ran several regions there is also a "Linked run" tab | Tab "Run History (N)" | Job tabs |

### 3.2 Glue PySpark jobs

| Field | Meaning | Options / example | Location |
|---|---|---|---|
| Worker Type | Worker size | `G.1X(4vCPU/16GB)` `G.2X` `G.4X` `G.8X` `G.12X` `G.16X`; `R.1X(4vCPU/32GB memory-optimized)` `R.2X` `R.4X` `R.8X` | Edit script |
| Workers | Number of workers | 2–1000, default 2 | Edit script |
| Glue Version | Runtime version; writing to S3 Tables needs at least 5.1; from 6.0 on, Spark 4 ANSI mode is on by default | `Glue 4.0(Spark 3.3.0 / Python 3.10)` · `5.0(3.5.4 / 3.11)` · `5.1(3.5.6 / 3.11)` · `6.0(4.1.1 / 3.13)`, default 6.0 | Edit script |
| Timeout (min) | Timeout of a single run | 5–2880, default 60 | Edit script |
| Glue Connection (optional, to access in-VPC sources like RDS) | References a data source that already has a Glue connection; leave empty for pure S3 / S3 Tables jobs | Dropdown | Edit script |
| Retries | Glue job-level retries | 0–10, default 0 | Advanced Properties |
| Execution class | Standard or flex | "STANDARD (standard)" · "FLEX (elastic, cheaper)" (G.1X / G.2X only) | Advanced Properties |
| Bookmark | Glue job bookmark | "Bookmark: Disabled" · "Bookmark: Enabled (Incremental)" · "Bookmark: Paused" | Advanced Properties |
| Max concurrency | Number of simultaneous runs of the same job | 1–100, default 3 | Advanced Properties |
| Execution Role | Which IAM role the job runs with; empty = platform default role | Dropdown with three groups: "Platform default (recommended, permissions complete)", "Created by Role Advisor", "Your own roles (must trust glue.amazonaws.com and be able to read the buckets your job depends on)"; "Refresh", "Enter ARN manually", "Check permissions" | Advanced Properties → Execution Role |
| Lake table buckets | Which routes the job can use; none selected = all routes of this region | Multi-select `alias · tier · bucket`; "Read" / "Write" per bucket; "Default catalog"; "Catalogs available to this job"; "Copy three-part name example" | Advanced Properties → Lake table buckets |
| Job parameters | Custom `--key` parameters read by the script via `getResolvedOptions`; `--conf` is appended after the platform Spark configuration | Parameter name (e.g. `src_table` or `--conf`) / value; platform reserved keys cannot be overridden (`--TempDir` `--datalake-formats` `--job-bookmark-option` `--extra-jars` `--extra-py-files` `--bgp_*` and the business date keys) | Advanced Properties → Job parameters |
| Dependency libraries | S3 URI auto-filled after upload; JAR → `--extra-jars`, `.py/.whl/.zip` → `--extra-py-files` | "Upload dependency files", ≤100MB, shipped with the job after saving | Advanced Properties → Dependency libraries |

### 3.3 EMR Serverless jobs

| Field | Meaning | Options / example | Location |
|---|---|---|---|
| Release label | EMR release | `emr-spark-8.0.0` (default) · `emr-7.14.0` … `emr-7.2.0` · `emr-6.15.0` | EMR job panel (unlabeled dropdown) |
| Architecture | CPU architecture | `ARM64` (default, cheaper) · `X86_64` (compatible with third-party native dependencies) | EMR job panel (unlabeled dropdown) |
| Executors | Number of executors | 1–100 | EMR job panel |
| Driver / Executor spec | CPU / memory / disk | CPU `1 vCPU` … `16 vCPU`; memory `2 GB` … `120 GB`; disk e.g. `20 GB` (defaults `4 vCPU` / `16 GB` / `20 GB` for each) | Driver / Executor spec (CPU / memory / disk) |
| Custom Spark conf | Extra Spark configuration; platform spec keys cannot be overridden | `spark.sql.shuffle.partitions` = value; "Add conf" | EMR job panel |
| Script arguments | Space-separated; the platform appends `--ds` and the other business date parameters after them | May be left empty | EMR job panel |
| Connection Info (VPC subnet / security group) | Private subnets and security groups of the application, required before running; after a change, save and rebuild the application | Pick real VPC resources; the "EMR Network Connectivity Advisor" can prefill them in one click; tags "Configured" / "Not configured (required before running)" | Connection Info (VPC subnet / security group) |
| Execution Role | Same as Glue, with service emr-serverless.amazonaws.com | Three-group dropdown + manual entry + permission check | EMR job panel → Execution Role |
| Lake table buckets | Same as Glue; the route map is read from `spark.bgp.lakeCatalogs` | Same as section 3.2 of this document | EMR job panel → Lake table buckets |

---

## 4. Lake table-bucket routes (System → Settings → Lake table buckets and routes)

The card shows the execution environment selected in the top-bar "Execution scope" (with "All" selected it shows, and registers to, the home region); the first row is always the region's platform table bucket ("Implicit default route", cannot be edited or revoked). Registering / editing / revoking requires a platform admin (bgp-admin).

| Field | Meaning | Options / example | Location |
|---|---|---|---|
| Table bucket | The S3 Tables table bucket to register; must be in this region and in the same account | The dropdown lists only unregistered buckets; you can also type one; 3–63 lowercase letters / digits / hyphens | Registration form → Table bucket |
| Alias | Spark catalog name, the first part of the three-part name in scripts; pre-filled from the bucket name, editable | `^[a-z][a-z0-9_]{0,31}$`; reserved names `s3tablescatalog` `spark_catalog` `glue_catalog` `default` are not allowed; unique within the region | Registration form → Alias (Spark catalog name, pre-filled from the bucket name) |
| Layer | Display and compliance label, no permission semantics | `detail(Detail tier)` `agg(Aggregate tier)` `result(Result tier)` `ods(ODS tier)` `dim(Dimension tier)` `other(Other)`; default other | Registration form → Layer |
| Writable | When off, sync / create-table / job write declarations cannot use it; IAM is not changed | On (default) / off; the table shows "Writable" / "Read-only" | Registration form → Writable |
| Namespace ownership | Declares which namespaces this route owns; required on one of the two routes when both contain a namespace of the same name | Press Enter to add, multiple allowed; the table shows "Resolved from what exists" when empty | Registration form → Namespace ownership (optional, press Enter to add) |
| Notes | Free text, up to 80 characters | Rows registered automatically by an upgrade read `auto-registered by upgrade` | Registration form → Notes (optional) |
| Registered by / at | Who registered it and when | The platform table bucket shows "Created at deployment" | Route table |
| Actions | "Edit" → dialog "Edit route <bucket>"; "Revoke" → popover confirmation | Changing the alias prompts "Changing the alias breaks scripts that reference the old alias. Change it anyway?"; revoking a route that is still referenced is rejected | Route table → Actions |

Quick rules:

| Rule | Result |
|---|---|
| Registering the platform table bucket | Rejected: it is already the default route |
| Alias identical to another route in the same region | Rejected: "Alias "…" is already used by route … of execution environment …; choose another alias" |
| The new bucket's namespace collides with an existing route and neither declares ownership | Rejected: "Namespace … exists in both … and …. Declare in namespaces which route owns … (exactly one) and retry" |
| The route is still referenced by sync tasks / jobs | Revoke rejected: "Table bucket … is still referenced; remove the references before revoking: sync tasks …; jobs …" |
| Just registered / revoked | Takes effect immediately; the Settings card and the job page's "Catalogs available to this job" read live (on the job page click "Refresh" to the right of the block); the Athena table tree / GenBI namespace-to-bucket lookup has a 15-second cache |

---

## 5. Workflow orchestration (Data Development → ETL Orchestration)

### 5.1 Workflow level

| Field | Meaning | Options / example | Location |
|---|---|---|---|
| Recurring schedule | Five-field cron (UTC); triggered runs are unaffected and can be started manually at any time | `*/30 * * * *` (every 30 minutes); about 1 minute after "Apply and publish" it runs on schedule | Workflow details → Schedule |
| Publish to scheduler / Take schedule offline | Publishes as an Airflow (MWAA Serverless) DAG in this region / takes it offline from MWAA (pause + delete DAG) | A DAG validation runs before publishing; on failure it shows "Cannot publish: DAG validation failed" | Workflow details |
| Downstream dependencies | Workflows / sync tasks triggered automatically when this workflow succeeds | Multi-select; saving shows "Saved downstream dependencies" | Workflow details → Downstream dependencies (auto-triggered after this workflow runs successfully): |
| Publish to environment | dev → staging publishes directly; → prod needs approval | "Publish to environment" | Workflow details |
| Business date | Runs triggered by the recurring schedule have no logical date: a batch job node uses the UTC day at the moment the node starts as its business date and derives the same set of 15 variables; a data sync node passes no business date, and the sync task takes the current day in its own "Business-date time zone" | Runs from the Backfill Center pass the instance date | Node run |

### 5.2 Nodes

| Field | Meaning | Options / example | Location |
|---|---|---|---|
| Node type | Nodes available in the canvas node menu (the card shows the name without the word "Node") | "Data Sync Node" · "SQL Node" (Glue Spark SQL (ETL processing)) · "Python node" · "Batch Job Node" · "Branch Node" · "Join Node" · "Empty Node" · "For-each Node" · "Assignment Node" · "Cross-cycle Dependency Node" | Canvas |
| Linked sync task | Which sync task the sync node references | "Select sync task"; shows "No linked sync task" when none is selected | Node configuration |
| Linked batch job | Which batch / EMR job the job node references; only jobs bound to this workflow's execution regions are listed | "Select a batch job (only jobs bound to this workflow's execution regions are listed)"; at publish time the job must be bound to the workflow's execution regions; a referenced job cannot be deleted | Node configuration |
| SQL Statement | The statement of a SQL node | Shows "SQL not configured" when empty | Node configuration |
| Retries / Timeout (sec) | Node-level retries and timeout | Number | Node configuration |
| Trigger rule | How a join node waits for its upstream nodes | "All succeeded (all_success)" · "No failures (none_failed)" · "No failures and at least one success (none_failed_min_one_success)" | Node configuration |
| Cross-cycle Dependency Node | Depends on a node from the previous cycle | Pick a node | Node configuration |
| Branch conditions | Restricted expressions evaluated in order; the first match routes to its target node; if none matches, the default path is taken | `xcom['rows'] > 0`; "Target node ID" | Branch Node |
| Subtasks | Executes once for each item of a list | "Subtask type", "Subtask SQL (use {{item}} to reference the current item)" | Node configuration |

---

## 6. Backfill (Scheduling & Ops → Backfill Center)

| Field | Meaning | Options / example | Location |
|---|---|---|---|
| Backfill target | Which task / workflow to backfill | "Select a task or workflow" | Backfill plan |
| Plan name | May be left empty for an automatic name | Text | Backfill plan |
| Date range | Start and end dates | Date range | Backfill plan |
| Granularity | Granularity at which instances are expanded | "Daily" (default) · "Weekly" · "Hourly"; sync tasks and workflows containing sync nodes support only daily / weekly | Backfill plan |
| Max concurrency | Upper limit of instances running at the same time, to avoid overloading the engine | 1–10, default 2; fixed at 1 for sync tasks | Backfill plan |
| Instance cap | Runaway guard: creation is refused when the expansion exceeds this number | 1–500, default 100 | Backfill plan |
| Cascade downstream dependencies | Workflows only: downstream nodes advance according to their dependencies | "Cascade" (default) / "Independent" | Backfill plan |
| Preview instances / Create | First check "Will generate N backfill instances", then create | Buttons | Backfill plan |
| Progress matrix | Date × node × execution region; click a cell for rows written / error text / run log | "Retry failed" reruns only the failed instances | Backfill progress |
| Isolation | Runs produced by backfill carry the backfill marker and are excluded from the online success rate / SLA baseline | — | Backfill Center |

The "Backfill" button on the Batch Compute page is a simplified version: "Start Date", "End date"; one run is triggered for each business date in the range (≤31 days).

---

## 7. Alert rules and channels (Scheduling & Ops → Alerting Center)

### 7.1 Alert rules ("New Alert Rule")

| Field | Meaning | Options / example | Location |
|---|---|---|---|
| Rule name | Name | e.g. Production sync task failure alert | New Alert Rule |
| Scope (task type) | Which kind of task to watch | "All types" · "Data Sync" · "Offline Compute (ETL)" · "ETL Orchestration" · "Real-time Compute (Flink)" | New Alert Rule |
| Severity | Severity level | P1 · P2 · P3 (default P2) | New Alert Rule |
| Limit to a specific task ID (optional; blank = all of this type) | Watch only one task | Task ID | New Alert Rule |
| Condition | When to alert | "Alert on task failure" · "Run timeout (duration over threshold)" · "Success rate below threshold" · "No-run (no success within window)" | New Alert Rule |
| Timeout threshold (minutes) | Threshold of the run-timeout condition | Number | New Alert Rule |
| Success rate threshold (%) / Window (minutes) | Threshold and window of the success-rate condition | Number | New Alert Rule |
| No-run window (minutes) | How long without a successful run counts as no-run | Number | New Alert Rule |
| Notification Channels | Which channels to send to | Multi-select | New Alert Rule |
| Auto-attach AI diagnosis on failure | Attaches a run diagnosis to the alert; only effective for "Task failed" conditions | On / off (default on) | New Alert Rule |
| Enable / Save | After saving, click "Enable" for the rule to take effect | Buttons | Rule list |

### 7.2 Notification channels

| Field | Meaning | Options / example | Location |
|---|---|---|---|
| Channel name | Name of the channel | e.g. Ops on-call group | "New Channel" dialog |
| Channel type | Which kind of endpoint to send to | "Generic Webhook" · "DingTalk group bot" · "WeCom group bot" · "Email (SES)"; the type cannot be changed after creation | Channels |
| Webhook URL | Address of the Webhook / DingTalk / WeCom endpoint | URL | Channels |
| Signing secret (required when DingTalk security uses "Signing") | DingTalk group bot only | Text | "New Channel" dialog |
| Sender (must be SES-verified) / Recipients (comma-separated) | Email channel only | Email addresses | "New Channel" dialog |

SLA tab: the SLA baseline is learned automatically from past runs and warns before a breach; backfill runs are excluded from the baseline.

---

## 8. AI model families (System → Settings → AI model)

The card shows "Effective model", "Source" and "Latest probe". A platform admin clicks "Change global default" (the button reads "Customize" when no custom model has been set yet) → dialog "Change global default model" → pick a model → "Test this model" → after the probe passes, "Save" ("You must Test this model and pass before saving (the server probes once more on save).") → confirmation "Change the global default model?" → "Confirm change" → toast "Global default switched to …; effective platform-wide within 5s". "Restore factory default" removes all runtime overrides and falls back to the deployment value. Non-admins are read-only: "Only platform admins (bgp-admin) can change the model; you are read-only."

| Family (dropdown group name) | Model id pattern | Required before saving | Characteristics / limits |
|---|---|---|---|
| Claude Opus | `anthropic.claude-opus-*` (may carry a geographic prefix such as `us.` / `global.`) | "Test this model" probe passed | Tool use is assumed supported; temperature / topP / stopSequences all supported; probe budget 10 seconds |
| OpenAI GPT-5.6 (via Bedrock) | `openai.gpt-5.6-*` | Probe passed + second tool-use probe passed | The page shows "GPT series is not open in phase 1 (transport gate)"; cannot be set as global default until released |
| GLM 5 (Z.AI / Zhipu, via Bedrock) | `zai.glm-5*` | Probe passed + second tool-use probe passed | stopSequences not supported (stripped automatically by the platform); when not enabled for the account, the message in the table below is shown |
| Kimi K3 (Moonshot AI, via Bedrock) | `moonshotai.kimi-k3*` | Probe passed + second tool-use probe passed; probe budget 45 seconds (long time to first token) | temperature / topP / stopSequences not supported (stripped automatically); always returns a reasoning block, output tokens are about 2× Claude, so cost rises accordingly |

When a probe fails, the page tells you "why + what to do":

| On-screen message | Meaning | Next step |
|---|---|---|
| "This model is not enabled for this account (Bedrock says "not available for this account" - an account-level restriction unrelated to region / IAM / Marketplace). …" | Not enabled at the account level | Ask your AWS account team to enable it, or pick another version of the same family / another vendor |
| "This model cannot call tools under Converse (tool-use probe failed); GenBI / Copilot / advisors would go silent, so it cannot be the global default" | Second tool-use probe failed | Choose another model |
| "tool-use probe timed out; test again" | Second probe timed out | Click "Test this model" again |
| "Too many probes (max N per minute); retry in Ns" | Probe rate limit | Wait and retry |
| "AI model problem: the current model … failed its latest probe" | Current model unavailable | "Restore factory default now" or "Choose another model" |

---

## Further reading

- Rules and status code reference: [30-reference-rules.md](30-reference-rules.md)
- Cross-bucket layering scenario (the complete route-and-declaration walkthrough): [21-scenario-cross-bucket-layering.md](21-scenario-cross-bucket-layering.md)
- Main scenario "detail to daily report": [20-scenario-detail-to-daily-report.md](20-scenario-detail-to-daily-report.md)
- Supported version matrix (Glue / EMR / Flink / models, etc.): [../supported-versions.md](../supported-versions.md)
- Module overview: [../modules.md](../modules.md)
