# ETL Development (Job Development, code-first)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is described in the [module overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> Status: implemented and **verified online** (v1.3.0). The engines reuse the existing **Glue (PySpark script jobs) / Redshift (SQL jobs)**; scheduling goes through **MWAA**.
> Complements the "ETL Orchestration (visual DAG)" module: this module is aimed at developers who **write code** and author their own scripts.

## 1. Feature Overview
Lets developers build ETL jobs by "writing scripts" (the same way they used to write Glue/Redshift scripts directly):
- **Glue script jobs** (type=glue): write PySpark in Monaco; the platform uploads the script to the scripts bucket, creates/updates the Glue job, runs it, and shows status/history.
- **Redshift SQL jobs** (type=redshift): write SQL (multiple statements separated by semicolons), executed through the Redshift Data API.
- **Run now** (run-now) + **run history** (written to `bgp-task-runs`, reused by the monitoring page).
- **Scheduling**: each job can be given a cron expression; "Publish" generates a **single-job Airflow DAG**, uploads it to MWAA and unpauses it automatically.

## 2. Interaction
The `/etl-jobs` "Job Development" page: on the left, the job list + New (choose Glue/Redshift, preset script templates); on the right, the Monaco editor + engine configuration (Glue: WorkerType/Workers/connections; Redshift: workgroup/db) + buttons (Save / Run now / Publish to MWAA schedule) + a Run history tab.

## 3. API
```
GET/POST           /api/etl-jobs                # list / create
GET/PUT/DELETE     /api/etl-jobs/[id]           # detail / update / delete
POST               /api/etl-jobs/[id]/run       # run now (glue: create/update job + StartJobRun; redshift: BatchExecuteStatement)
GET                /api/etl-jobs/[id]/runs       # run history (query bgp-task-runs by taskId=jobId)
POST               /api/etl-jobs/[id]/schedule  # generate DAG → upload to MWAA → auto-unpause
```

## 4. Data Model
New table **`bgp-etl-jobs`** (PK userId / SK jobId): name, type, script, glueConfig, redshiftConfig, cronExpression, scheduleEnabled, airflowDagId, glueJobName, status, lastRun*. Run records are written to `bgp-task-runs` (taskType `etl-glue`/`etl-redshift`).

## 5. Backend
- `lib/etl/job-service.ts`: `ensureGlueJob` (upload script + create/update, **MaxConcurrentRuns=3**), `runGlueScriptJob` (+ polling), `runRedshiftSqlJob` (BatchExecuteStatement + polling).
- `lib/etl/dag-generator.ts`: single-job DAG — glue calls `start_job_run` + polls; redshift uses `batch_execute_statement` + polls; success/failure is written back to `bgp-task-runs` + the job status.

## 6. AWS Dependencies and the IaC Fix of This Release
- Glue (glueetl 5.1, bgp-glue-role), Redshift Data API, MWAA, S3 (scripts bucket / DAG bucket).
- **Fix**: both `bgp-glue-role` and `MwaaRole` now include `redshift-data:BatchExecuteStatement`/`CancelStatement` (previously only ExecuteStatement, which caused AccessDenied when user scripts / scheduled DAGs used batch).

## 7. Security / Known Limitations
- Job scripts are written by users and executed inside Glue/Redshift; they inherit the permissions of bgp-glue-role/MwaaRole (demo level; production should tighten to least privilege + read-only / read-write separation).
- **Redshift table ownership across execution identities**: tables created by run-now (the ECS task role identity), by MWAA (the MwaaRole identity) and by Glue (the glue-role identity) have different owners, so `DROP` or writes to someone else's table fail with "permission denied". Recommended follow-up: unify on a single Redshift role/user, or have scripts use `CREATE OR REPLACE` / an explicit `ALTER TABLE ... OWNER` / `GRANT`.

## 8. Acceptance (v1.3.0, measured online)
- [x] Redshift SQL job: run-now succeeded and produced `public.etl_category_sales` (5 categories).
- [x] Glue PySpark job: run-now succeeded; the Spark aggregation was written back to `public.etl_glue_marker` (total_v=450).
- [x] MWAA scheduling: publish DAG → MWAA loads and unpauses it → trigger → the Glue job ran successfully through the DAG and the run record was written back.
