# ETL Job Run Parameterization (${ds}) + Dry Run + Backfill + Rerun (Priority 1 · Developer Experience)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is described in the [module overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> Revision: 1.7.0 | Date: 2026-06-14 | Status: implemented and verified online
> Addresses the developer-experience item of the gap-analysis re-check (group C, priority 1): "schedule parameters / backfill / rerun / dry run". This is the first item of the priority-1 tier.

---

## 0. Goals

Add four developer-experience capabilities to the runs of "Job Development" (ETL): **business-date parameterization**, **dry run**, **backfill** and **rerun**, matching the day-to-day development loop of leading cloud data-development suites. This iteration focuses on ETL jobs (code-first Glue / Redshift).

## 1. Business-Date Parameterization (`${ds}` and friends)

`lib/etl/run-params.ts`: every run carries a **business date** `runDate` (YYYY-MM-DD, default today in UTC), from which the template variables are rendered:

| Variable | Meaning |
|------|------|
| `${ds}` | Business date `YYYY-MM-DD` |
| `${ds_nodash}` | `YYYYMMDD` |
| `${yesterday_ds}` / `${yesterday_ds_nodash}` | The previous day |
| `${tomorrow_ds}` / `${tomorrow_ds_nodash}` | The next day |

- **Redshift SQL jobs**: before the run, the script undergoes an **exact token text substitution** (`${ds}` does not accidentally touch `${ds_nodash}`), and the rendered script is then executed.
- **Glue jobs**: the dates are passed in as **Glue Job parameters** `--ds`/`--ds_nodash`/`--yesterday_ds`/`--tomorrow_ds` (the script reads them with `getResolvedOptions(sys.argv, ['ds', ...])`); no text substitution is done (avoiding the race of rewriting a shared script per run).

The run record in `bgp-task-runs` gains `runDate` and a finer-grained `triggeredBy` (manual/backfill/rerun/dryrun/schedule).

## 2. Dry Run (dry-run, Redshift)

Validates SQL without writing data: after rendering the parameters, run `EXPLAIN` on every **EXPLAIN-able statement** (`SELECT/WITH/INSERT/UPDATE/DELETE`) (only the execution plan is computed; nothing is executed or persisted), skipping pure DDL (`CREATE/DROP/TRUNCATE/ALTER`, which cannot be EXPLAINed). If the plan of any statement fails, the dry run fails (exposing syntax/object errors). It is recorded as `taskType=etl-redshift-dryrun, dryRun=true` and **does not change the job's lastRunStatus**. Glue jobs do not support dry run for now.

## 3. Backfill (backfill)

`POST /api/etl-jobs/[id]/backfill {startDate, endDate}`: triggers one run for **every business date** in the range (inclusive of both endpoints, ≤31 days), each parameterized with its own `${ds}`, `triggeredBy=backfill`. Triggered sequentially day by day, each with its own independent run record; progress is visible in the run history.

## 4. Rerun (rerun)

`POST /api/etl-jobs/[id]/rerun {runId}`: takes the `runDate` of that historical run and runs again with the **same business date** (`triggeredBy=rerun`).

## 5. API / Front End

- `POST /api/etl-jobs/[id]/run` accepts the body `{runDate?, dryRun?}` (dryRun for Redshift only).
- New `POST /api/etl-jobs/[id]/backfill` and `POST /api/etl-jobs/[id]/rerun`. All three use `guardResourceAccess(editor)`.
- Job Development page: the run toolbar gains a **Business date** input + **Dry run** (Redshift) + **Backfill** (opens a date-range dialog); the run history gains a **Business date** column and a **Rerun** action; the editor hints at the available variables such as `${ds}`.

## 6. Relationship with v1.6.1 (important)

All Redshift executions (run-now / dry-run / backfill / rerun / schedule) go through the **unified admin-secret identity** introduced in v1.6.1, so table owners are consistent — parameterized runs / backfills that write the same result table repeatedly no longer trigger cross-identity ownership errors.

## 7. Online Verification (temporary test account, us-east-1)

With a `${ds}`-parameterized job (`DELETE WHERE business_date='${ds}'` + `INSERT ... '${ds}'`):
1. run-now with `runDate=2026-06-09` → the table gets 1 row for `2026-06-09` (parameters rendered correctly).
2. dry-run for `2026-06-09` → succeeds and **the data is unchanged** (EXPLAIN persists nothing).
3. backfill `2026-06-10..06-12` → 3 runs triggered; the table has 1 row each for the four dates `06-09/06-10/06-11/06-12`.
4. rerun of the `2026-06-09` run → the business date is still `2026-06-09`, idempotent (1 row for each of the four dates, no duplicates).

## 8. Known Limitations / Follow-ups

1. This iteration's parameterization/backfill/rerun covers **ETL jobs**; parameterization and backfill for sync tasks/workflows come later (workflows can rely on Airflow's native `{{ ds }}`).
2. Dry run is Redshift only (EXPLAIN semantics); a Glue dry run needs a separate design (e.g. a `--dry-run` convention).
3. Runs triggered by the schedule (cron) currently use the date of the trigger time; parameterizing scheduled runs with the Airflow `{{ ds }}` business date is a later enhancement.
4. Backfill triggers sequentially day by day with a 31-day cap; large ranges / concurrency and an aggregated "backfill task" view come later.
