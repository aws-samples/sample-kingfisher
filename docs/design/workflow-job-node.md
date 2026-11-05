# Workflow Job Node · Batch Job Nodes in the Orchestration DAG (requirements + design)

> Revision **1.0** (2026-11-03). Status: 🆕 design written, code pending (ships with the 2.2.0 release).
> Decided on 2026-11-03: "Allow data sync tasks and batch development jobs to be chained into one DAG workflow and **published completely into Airflow Serverless**. This is a **basic capability; it must be fixed at the root, and to the highest global standard**."
> Origin (the second question raised the same day): a Data Sync task's dependencies can only be other sync tasks; Batch Compute jobs cannot enter orchestration — to chain "sync → batch job → SQL" today, the only way is to paste the job's code once more into an inline SQL / Python node, losing the engine configuration, the execution role, the dependency libraries and the run history.

## 1. Current state and gaps (🔵 code facts, surveyed 2026-11-03 on the development tree of that day)

| Layer | Fact (file:line) | Gap |
|---|---|---|
| Node list | `types/workflow.ts:32-36` ten kinds `sync / sql / python / branch / empty / join / foreach / setvar / external / platform-action`;<br>`lib/workflow/node-registry.ts:62-142` one row per kind (`runtimeExecutor · supportsBackfill · minEngine · serverless · userPlaceable · validate`); a missing row is a tsc error | **No node references a Batch Compute job (`bgp-etl-jobs`, glue / redshift) or an EMR engine job (`bgp-engine-jobs`)** |
| Executor | Node semantics exist in exactly **one** Python block `NODE_EXEC_PY` (`lib/workflow/node-exec-py.ts`), spliced into two carriers: the classic runtime-lib (`lib/workflow/runtime-lib.ts`, `RUNTIME_LIB_VERSION = 10`) and the MWAA Serverless `bgp_runtime` (`lib/scheduler/serverless/runtime-py.ts`);<br>the legacy generator `dag-generator.ts` is frozen | A new node = one executor added to the shared block + one dispatch entry in each of the two carriers; legacy does not support it (same rule as branch / foreach, `minEngine: "runtime-lib"`) |
| Single-job carrier | The serverless runtime library already has the `run_job` family (`runtime-py.ts:177-300`: `_run_glue` with `bgp_run_param_args(ds)` · `_run_emr` waits for the application to be STARTED and then calls `start_job_run` · `_run_redshift` · `_acquire_run_lock` job lock `lockAttrFor(target)` · `_record` writes `bgp-task-runs` + writes back to the job row · `_check_soft_limit` 50 minutes); the spec is resolved **at publish time** by `lib/etl/dag-fanout.ts:325-358` / `lib/engines/emr/schedule-fanout.ts:124-158` (per-region Glue job name / EMR application / statements) | This family is **not in the shared block**, so workflow nodes cannot use it; the classic carrier does not have it |
| DAG ⇄ platform | The Python inside a DAG **goes entirely through boto3** (glue / redshift-data / emr-serverless / dynamodb), never through the platform HTTP API (`/api/internal/*` serves only the platform-action node and the two pumps) | Job nodes must also go through boto3; no new endpoint is opened |
| Sync node | `_exec_sync(env, task_id)` (`node-exec-py.ts:148-166`): reads the task row's `glueJobName` (**the home-region display copy**) → `start_job_run` **without Arguments** (no business date) → polls every 15 seconds with no upper bound;<br>**does not write** the sync task's own run row;<br>save / publish **do not check** that the task's place ∋ the workflow's place (`assertDefinitionRunsHere` is used only by the start route and by backfill, `definition-binding.ts:50-82`);<br>the node panel's `/api/sync` is not filtered by place / project (`NodeConfigPanel.tsx:20-25`) | A task bound to another region ⇒ EntityNotFound at run time; the sync run history never shows "triggered by workflow" |
| Backfill | `lib/backfill/execute.ts:93-125` workflow scope recognizes only `sql` / `sync` nodes | Job nodes must be backfillable |
| Pages | Canvas render mapping `components/dag-editor/DagEditor.tsx:62-66`; panel `NodeConfigPanel.tsx`; the palette `PALETTE_NODE_TYPES` lists `userPlaceable` kinds automatically | Add the `JobNode` render + the panel fields |

In one sentence: **today "sync → SQL / Python" can be chained; "sync → batch job" cannot** — not because the generator cannot generate it, but because there is no such node and no shareable job executor.

## 2. Requirements (contract)

| # | Requirement | Acceptance (page-driven) |
|---|---|---|
| R1 | New node **Batch Job Node `job`**: references one Batch Compute job (Glue script / Redshift SQL) or EMR Serverless job of the same project **whose bindings include the workflow's place**; the panel dropdown filters by project + place and shows "name · engine · bound region" | The panel of a us-west-2 workflow lists only jobs bound to us-west-2; once selected, the canvas node shows the job name and engine |
| R2 | Execution semantics = the **same core** as the job's "Run now": the same per-region Glue job name (`glueJobNameFor(jobId, target)`) / the same EMR application + execution role / the same set of Redshift statements;<br>with the business date (classic takes Airflow `ds`; serverless has no logical date ⇒ `today`, the same rule as the single-job carrier, with backfill passing it in);<br>**the same job run lock** (`lockAttrFor(target)` on the `bgp-etl-jobs` / `bgp-engine-jobs` row; busy ⇒ wait up to 45 minutes / skip on timeout, consistent with the scheduler);<br>waits for the terminal state;<br>the 50-minute soft limit writes `timeout-pending` (the serverless single-task hard limit is 60 minutes) | The Glue JobRun the node runs has the job's own per-region name; the job page's "Run history" shows that run |
| R3 | **Run rows written twice with back-links**: the job's own `bgp-task-runs` row (taskId = jobId, taskType `etl-glue / etl-redshift / emr-serverless`, `triggeredBy: "workflow"`, extra `{ workflowId, workflowRunId, nodeId }`) + the workflow instance row as before;<br>the job's "Run history" can click through to the workflow instance, and the workflow instance's node can click through to the job run | The job's run history row shows "Triggered by workflow X" and can be followed |
| R4 | **Complete publish**: both carriers — the serverless YAML (one task per node) and the classic runtime-lib — support it; publishing with the legacy engine ⇒ 400 pointing to switch to runtime-lib (same rule as branch) | us-west-2 (serverless) publish succeeds, `ListWorkflows` lists it, a trigger really runs all three nodes green |
| R5 | **Place consistency fails closed (at publish)**: the job a job node references must satisfy `bindingTargets(job) ∋ workflow place`, otherwise publish 400 naming the node and the job; **the sync node gets the same check in the same change** (`assertDefinitionRunsHere`), instead of waiting for EntityNotFound at run time | Drag a home-bound job into a us-west-2 workflow ⇒ publish 400 names it verbatim |
| R6 | Backfill: workflow scope supports `job` nodes ⇒ `runEtlJob(job, { runDate, triggeredBy: "backfill", targetId })` / `provider.submit(...)`; `supportsBackfill: true` | A backfill plan that ticks the workflow ⇒ the job node runs per date, run rows `triggeredBy: backfill` |
| R7 | Referential integrity: before deleting a job, check workflow references (single author); referenced ⇒ 409 `JOB_IN_USE` listing each workflow (the same rule as deleting a data source that sync / stream tasks still reference); job missing / type changed ⇒ the canvas node is flagged "job not found", publish 400 | Delete a referenced job ⇒ 409 names the workflow verbatim, nothing is deleted |
| R8 | Sync node follow-up (same change, not a separate item): ① publish-time place consistency (R5); ② the panel dropdown filters by place + project; ③ a run writes the sync task's own run row (`taskType: sync`, `triggeredBy: "workflow"`, back-link) — the same "two rows with back-links" as the job node | The sync task's "Run history" shows the row triggered by the workflow |
| R9 | Compatibility: existing `dagDefinition` unchanged; the new kind is additive only; `RUNTIME_LIB_VERSION` 10 → 11 (already published classic workflows are republished once to pick up the new library, same rule as 9 → 10); the serverless runtime library version = the source sha, changes automatically; no new tables | Existing workflows are untouched unless changed; behavior unchanged after republishing |

## 3. Design

### 3.1 Types and registry (the closed list changes first)
- `types/workflow.ts`: `WorkflowNodeType` + `"job"`; `{ type: "job"; data: CommonNodeData & { jobRef?: { kind: "etl" | "emr"; jobId: string } } }` (`kind` is closed; `etl` covers both Batch Compute job kinds, glue / redshift; the engine is read from the job row and not stored again on the node).
- `node-registry.ts`: `job: { labelKey: "Batch Job Node", runtimeExecutor: "job", supportsBackfill: true, minEngine: "runtime-lib", serverless: "task", userPlaceable: true, validate: d => d.jobRef?.jobId ? null : { key: "Batch Job node \"{nm}\" is not linked to a batch job" } }` (the two string literals are i18n keys, shown here with their English locale text).
- `dag-generator-v2.test.ts:29` "exactly sql + sync support backfill" becomes `sql + sync + job`.

### 3.2 Publish-time resolution: a single author for the job spec
- New `lib/workflow/job-node-spec.ts#resolveJobNodeSpec(node, wfTarget, projectId)`: read the job row (ETL `bgp-etl-jobs` / EMR `bgp-engine-jobs`) → same project, `bindingTargets(job) ∋ wfTarget` (otherwise `JobNodeUnbound` ⇒ 400) → call the **existing** single-job spec constructor to obtain **the very same** spec as the single-job carrier.
- Extract the spec construction in `dag-fanout.ts:325-358` (ETL) and `schedule-fanout.ts:124-158` (EMR) into the single authors `lib/etl/job-spec.ts#serverlessJobSpecFor(job, targetId)` / `lib/engines/emr/job-spec.ts#emrJobSpecFor(job, targetId)`; both call sites switch to importing them (ratchet: the spec field set is defined only in these two places).
- `buildDagSpec` (classic v2) and `buildWorkflowTasksYaml` (serverless) both write the resolved result into `node.data.jobSpec` for `job` nodes (engine / jobId / glueJobName | statements | the five EMR fields / jobsTable / lockAttr / taskType / place / stamp); resolution failure ⇒ publish 400 naming it (`JobNodeUnbound` added to the existing error mapping in `long-ops.ts`).

### 3.3 Python executor: the job family moves into the shared block
- New shared block `lib/workflow/job-exec-py.ts#JOB_EXEC_PY`: move `_ddb / _record / _acquire_run_lock / _release_run_lock / _check_soft_limit / _exec_place / _run_redshift / _run_glue / _run_emr` from `runtime-py.ts` **as they are** (bytes unchanged); both carriers splice it in; the single-job carrier's `run_job` is changed to call the same family.
- `NODE_EXEC_PY` gains `_exec_job(env, node, ds)`: `spec = node["data"]["jobSpec"]` → `_acquire_run_lock(spec, token)` (busy ⇒ wait 45 minutes / skip) → run by `spec["engine"]` → `_record(spec, run_id, status, extra={ "triggeredBy": "workflow", "workflowId", "workflowRunId", "nodeId", "duration" })` → release;
  - exceptions close the books and re-throw, following the existing `run_node` convention.
- `_exec_sync` in the same change: at the end of the run, write the sync task's own run row (`taskType: sync`, `triggeredBy: workflow`, back-link fields as above); everything else untouched (whether the business date can be passed to the sync script still has to be checked against `SYNC_RUN_VARS_PY`; not promised in this change).

### 3.4 Wiring the two carriers
- classic `runtime-lib.ts#_make_operator`: `job` ⇒ `PythonOperator(_exec_job, op_kwargs={env, node, ds: "{{ ds }}"})`; `RUNTIME_LIB_VERSION = 11`.
- serverless `runtime-py.ts#_run_node_body`: `job` ⇒ `_exec_job(e, node, ds=ctx.get("ds") or today)`; `workflow-yaml.ts` unchanged (one task per node already covers it).
- `runtime-single-author.test.ts`: `SHARED_DEFS` gains the job family + `_exec_job`; both carriers byte-identical; the version-bump check as before.

### 3.5 Place consistency (R5)
- Before `publish-dag.ts#buildCarrierArtifact` generates: iterate the nodes; `sync` ⇒ `assertDefinitionRunsHere(task, "sync task", wfTarget)` (the second argument is the display label, shown here in English); `job` ⇒ the `JobNodeUnbound` of 3.2; any mismatch ⇒ the whole publish is 400 (no publishing half first; the same fail-fast rule `publishWorkflowDag` already has).

### 3.6 Backfill (R6)
- `lib/backfill/execute.ts` workflow scope gains a `job` branch: ETL ⇒ `runEtlJob(job, { runDate, triggeredBy: "backfill", targetId: inst.targetId })`; EMR ⇒ `getProvider("emr").submit(job, { runDate, triggeredBy: "backfill", targetId })`; the run row's extra carries `backfillPlanId / backfillNode` (same shape as the sql node).

### 3.7 Reference guard (R7)
- New `lib/workflow/job-references.ts#workflowsReferencingJob(jobId)` (scans `bgp-workflows` for `dagDefinition.nodes[].data.jobRef.jobId`, within the project); the ETL / EMR delete routes check before deleting; non-empty ⇒ 409 `JOB_IN_USE` (`ApiErrorCode` gains one member, detail `{ workflows: [{ id, name }] }`); the page dialog points the way.

### 3.8 Pages (R1 / R8)
- `components/dag-editor/JobNode.tsx` (reuses `RichNodes.tsx#Shell`: job name · engine Tag · "Not linked / job not found"); `DagEditor.tsx` nodeTypes gains `job`.
- `NodeConfigForm` job fields: a `Select` grouped into "Batch Compute (Glue / Redshift)" and "EMR Serverless"; the options come from `GET /api/etl-jobs?scope=<workflow place>` and `GET /api/engines/emr?scope=<workflow place>` (two existing read endpoints, filtered by `scope=` — the execution-scope read guard recognizes it), label `name · engine · bound region`; the sync node's dropdown likewise gains `scope=`.
- The palette picks it up automatically; "How to use this page" gains a sentence; the English dictionary in the same commit.

## 4. Checks and gates
- Unit tests: registry closure / the backfill set;
  - `job-node-spec` (project mismatch / not bound to the region / job missing ⇒ rejected; the spec equals the single-job carrier's field by field);
  - `runtime-single-author` (the job family is shared + both carriers dispatch `job` to the same executor);
  - `workflow-tasks-yaml` (a job node ⇒ one task, `op_kwargs.node.data.jobSpec` complete);
  - `py_compile` of both carriers;
  - publish 400 checks (sync place mismatch / job not bound to the region / legacy engine);
  - the backfill job branch;
  - delete job 409;
  - component server-side real render (JobNode / panel fields).
- New page-driven acceptance segment (us-west-2, serverless): create a workflow → drag a "Data Sync Node" (a us-west-2 sync task) → drag a "Batch Job Node" (a us-west-2 Glue job) → drag a "SQL Node" → connect → publish → trigger → all three nodes green, workflow instance succeeded → the job's "Run history" shows a `triggeredBy=workflow` row with a back-link → the sync task's run history likewise → negative: drag a home-bound job in and publish ⇒ 400 verbatim → delete a referenced job ⇒ 409 → a backfill plan ticks the workflow ⇒ the job node runs per date.
- Mutations: remove `_acquire_run_lock` from `_exec_job` ⇒ the lock check goes red; remove the publish-time place check ⇒ the check goes red.

## 5. Risks / boundaries
- Serverless single-task hard limit of 60 minutes: a long job node over the limit ⇒ `timeout-pending` (same rule as the single-job carrier); the text names it.
- `RUNTIME_LIB_VERSION` bump ⇒ already published classic workflows must be republished once (the upgrade note goes into CHANGELOG).
- EMR application cold start of up to 10 minutes (40 × 15 s) counts toward the node's duration.
- Business date for sync scripts: whether the sync node passes ds to the Glue sync job depends on how the sync script reads its parameters; this change only adds the place check + the run-row back-link, and date passing is decided after a separate check.

## 6. Effort
2 days: ① types / registry / spec single author / shared block and wiring of both carriers ② publish-time place check / backfill / reference guard / pages ③ unit tests + the page-driven acceptance segment.
