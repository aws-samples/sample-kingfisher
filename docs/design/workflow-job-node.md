# Workflow Job Node

Status: implemented. Code lives under `platform/src/lib/workflow/` (`job-ref.ts`, `job-node-spec.ts`, `job-node-prepare.ts`, `job-references.ts`, `back-links.ts`, `job-exec-py.ts`) and `platform/src/components/dag-editor/`.

Related: [Execution role binding](execution-role-binding.md), [Long-running operations](long-running-operations.md), [Supported versions](../supported-versions.md).

## 1. Summary

- The orchestration canvas gains a **job node** that references an existing offline compute job (Glue script or Redshift SQL) or an EMR Serverless job.
- A sync task, a job and a SQL step can now be chained into one DAG and published completely to the region's scheduler.
- The node runs the referenced job with the same core as "run now": the same per-region Glue job name, the same EMR application and execution role, the same Redshift statements, the same run lock, and the same run ledger.
- Binding is checked at publish time and fails closed: a job that is not bound to the workflow's region rejects the whole publish.
- Run records link in both directions: from the job's run history to the workflow run, and from the workflow run's node details to the job's run history.
- A job referenced by a workflow cannot be deleted (409).
- Job nodes participate in backfill.

## 2. Problem

### 2.1 Before

| Layer | Fact | Gap |
|---|---|---|
| Node types | Ten node types; none referenced an offline or EMR job | A job could not be placed on the canvas |
| Executor | One shared Python block used by two scheduler carriers | The single-job run family lived only in the serverless runtime, outside the shared block |
| DAG to platform | DAG Python talks to AWS directly, not to the platform HTTP API | Job nodes must do the same; no new internal endpoints |
| Sync node | Started the Glue job by its home-region name; no business date; no run row for the sync task | A task bound to another region failed at run time; run history did not show "triggered by workflow" |
| Binding check | Place consistency checked only on start and backfill, not on publish | Mismatches surfaced as `EntityNotFound` at run time |
| Candidates | Node panel listed all sync tasks regardless of region or project | Users could pick tasks the workflow could never run |
| Backfill | Workflow scope recognised only SQL and sync nodes | Job nodes could not be backfilled |

- The only workaround was pasting the job code into a SQL or Python node.
- That lost the engine configuration, the execution role, the dependency libraries and the run history.

### 2.2 In one sentence

"Sync then SQL or Python" could be chained; "sync then job" could not, because neither the node nor a shared job executor existed.

## 3. Requirements

| # | Requirement |
|---|---|
| R1 | A job node references one job of the same project whose bindings include the workflow's region; the picker filters by project and region |
| R2 | Execution equals "run now": same Glue job name per region, same EMR application and role, same Redshift statements, same run lock, business date passed |
| R3 | Run rows are written twice: the job's own run row with a back-link to the workflow run, and the workflow instance row |
| R4 | Publish is complete on both scheduler carriers; the legacy generator rejects the node with 400 |
| R5 | Place consistency is checked at publish for job nodes and sync nodes; any mismatch rejects the whole publish with 400 |
| R6 | Backfill supports job nodes with `triggeredBy: "backfill"` |
| R7 | Deleting a referenced job returns 409 naming the workflows; a missing or retyped job is flagged on the canvas and rejects publish |
| R8 | Sync nodes gain the same publish-time check, region-filtered candidates and run-row back-links |
| R9 | Stored DAG definitions are unchanged; new fields are additive; no new tables |

## 4. Concepts

| Term | Definition |
|---|---|
| Job node | Node type `job`; `data.jobRef = { kind, jobId }` |
| `kind` | Closed list `JOB_NODE_KINDS = ["etl", "emr"]`; `etl` covers Glue and Redshift offline jobs, `emr` covers EMR Serverless jobs |
| `jobSpec` | The run spec resolved at publish time and attached to `node.data.jobSpec` in the generated artefact only; never saved with the workflow |
| Workflow place | The execution region the workflow publishes to; every node must be runnable there |
| Back-link | Fields on a run row (`workflowId`, `workflowRunId`, `nodeId`, `workflowName`) and the derived page links |

`jobRefOf(node)` in `job-ref.ts` is the only reader of the reference; it is a pure function usable in the browser and on the server.

## 5. Node registry entry

| Attribute | Value |
|---|---|
| `type` | `job` |
| `labelKey` | "Batch Job Node" |
| `runtimeExecutor` | `job` |
| `supportsBackfill` | `true` |
| `minEngine` | `runtime-lib` (the frozen legacy generator rejects it) |
| `serverless` | `task` (one scheduler task per node) |
| `userPlaceable` | `true` (appears in the palette automatically) |
| `validate` | `jobRef.kind` in the closed list and `jobId` non-empty, else "node is not linked to a batch job" |

The engine from the job row is not duplicated on the node; it is read when the spec is resolved.

## 6. Publish-time resolution

### 6.1 Loading the referenced job

`loadJobNodeRow(node, workflow, wfTarget)` performs the checks below and throws `JobNodeUnbound` on any failure.

| Reason | Check | Message names |
|---|---|---|
| `missing-ref` | `jobRef` absent or malformed | Node |
| `not-found` | Job row missing in `bgp-etl-jobs` or `bgp-engine-jobs` | Node, job id |
| `kind-mismatch` | `kind: emr` but the row's engine is not EMR Serverless | Node, job id, engine |
| `project-mismatch` | Job's project differs from the workflow's project | Node, job name, both projects |
| `not-bound` | `bindingTargets(job)` does not include the workflow place | Node, job name, bound regions, target region |

- The read uses a consistent read so a row updated moments earlier during preparation is seen.
- The project of rows without an explicit project resolves through the same stamp resolver used for run records; no second default is written.
- `JobNodeUnbound` has `code = "JOB_NODE_UNBOUND"`; routes map it to 400 because the fix is to change the diagram or the binding, not to install anything.
- The platform never picks another region on the user's behalf.

### 6.2 Resolving the spec

- `resolveJobNodeSpec(node, wfTarget, projectId, ctx)` calls the existing single-job spec authors: `lib/etl/job-spec.ts` for offline jobs and `lib/engines/emr/job-spec.ts` for EMR jobs.
- The result is the same `ServerlessJobSpec` the single-job scheduler carrier uses: `engine`, `jobId`, `dagId`, `taskType`, `jobsTable`, `lockAttr`, `place`, `stamp { projectId, targetId }` and engine-specific fields.
- `withJobSpecs` attaches the spec to `node.data.jobSpec` for job nodes only; every other node and edge is byte-identical, so existing workflows produce unchanged artefacts.
- An EMR job that has never been prepared in the region resolves to `not-prepared` on the read-only path; the publish path prepares first (section 7).

### 6.3 Fail-closed order inside publish

1. Resolve the carrier plan (read-only): scheduler endpoint present, warehouse place, node and sync binding consistency, unsupported node types, legacy engine capability gate, spec self-validation.
2. Any rejection here leaves the region untouched: 409 when the scheduler component is not installed, 400 for every other reason.
3. Prepare job nodes (write phase, section 7).
4. Generate the artefact and upload it.

`assertWorkflowNodesRunOn(workflow, wfTarget)` iterates nodes: sync nodes go through `assertDefinitionRunsHere`; job nodes go through the checks in 6.1. One failure rejects the entire publish; nothing is published partially.

## 7. Preparation per region

`prepareJobNodesForTarget(workflow, wfTarget)` makes each referenced job runnable in the region, using the same authors as "run now".

| Job kind | Writes |
|---|---|
| Offline Glue job | `ensureGlueJob(job, wfTarget)` creates or updates the per-region Glue job definition, including the custom role preflight |
| Offline Redshift job | Nothing to prepare; statements run through the warehouse place at run time |
| EMR Serverless job | Upload the script, ensure the S3 Tables jar, ensure the application, persist the application id on the job row |

- A custom execution role on an EMR job is preflighted for the region before anything is written; a gap fails the publish with the preflight message.
- Without job nodes the preparation performs zero writes.
- The returned list records what was prepared per node for audit and troubleshooting.

## 8. Two scheduler carriers

The node semantics exist once, in Python, and are embedded in both carriers.

| Carrier | Dispatch | Business date |
|---|---|---|
| MWAA Serverless runtime | `_run_node_body` routes `type == "job"` to `_exec_job(env, node, ds, workflow_run_id)` | From the run context, else today |
| Classic MWAA runtime library | `_make_operator` creates a `PythonOperator` calling `_exec_job` with `scheduler="mwaa"` | Airflow `{{ ds }}` |

- The job family (`_ddb`, `_record`, `_acquire_run_lock`, `_release_run_lock`, `_check_soft_limit`, `_exec_place`, `_run_redshift`, `_run_glue`, `_run_emr`) moved into the shared block `JOB_EXEC_PY` and is included byte-identically in both carriers.
- The single-job carrier's `run_job` calls the same family.
- The classic runtime library version was incremented; already-published classic workflows must be republished once to receive it.
- The serverless runtime library version is derived from the source hash and changes automatically.
- A single-author test asserts both carriers embed the same bytes and dispatch `job` to the same executor.

## 9. Run-time semantics of `_exec_job`

1. Read `node.data.jobSpec`; a missing spec means the workflow must be republished.
2. Verify `spec.stamp.targetId` equals the runtime's region; otherwise refuse (publish checked it, the runtime checks again).
3. Build the job run id from the workflow run id, node id and region.
4. Acquire the job's run lock on the job row (`lockAttr` of the region) with a wait budget of 45 minutes.
5. If the lock is still held, write a `failed` run row and raise; the node is never skipped, because a skip would let the workflow finish green without the job's output.
6. Run by engine: `_run_redshift`, `_run_glue` (with the business date) or `_run_emr`.
7. The soft limit of 50 minutes counts from the node start, including lock wait, because the serverless task hard limit of 60 minutes also counts from task start.
8. Write the run row with `triggeredBy: "workflow"`, `workflowId`, `workflowRunId`, `nodeId`, `runDate`, and `workflowName` when available; `scheduler` is added on the classic carrier.
9. Release the lock; on failure close the ledger first and rethrow the original exception.

## 10. Run-record back-links in both directions

### 10.1 Job run history to workflow run

- Run rows written by a job node or a sync node carry `triggeredBy: "workflow"` and the workflow fields.
- `workflowRunHref(run)` builds `/workflow/<workflowId>?run=<workflowRunId>`; the run id is URL-encoded because it contains `#`.
- The shared cell `RunTriggerCell` renders "Triggered by workflow <name>" as a link, `data-testid="run-trigger-workflow"`.
- It is used on the offline compute run history and the EMR job panel.

### 10.2 Workflow run to job run history

- The workflow detail page opens the node details of the run named by `?run=` once the run list has loaded.
- The node status API attaches `backLink` to every row by mapping Airflow task ids back to definition nodes through the generator's id map.
- `nodeBackLinkHref` builds `/etl-jobs?jobId=<jobId>&tab=runs` for job nodes and `/sync/<taskId>` for sync nodes.
- The link is rendered with `data-testid="node-job-run-link"` and labelled "job run history" or "sync run history".
- Rows without a link carry `backLink: null`, so the page never guesses.

## 11. Sync node changes in the same design

- Publish checks that the referenced sync task is bound to the workflow place.
- The node panel lists only sync tasks of the workflow's region and project.
- After a run, a run row is written for the sync task itself with `triggeredBy: "workflow"` and the same back-link fields.
- Passing the business date to the sync Glue job is not part of this design (section 16).

## 12. Delete guard

- `workflowsReferencingJob(jobId, projectId)` scans workflow definitions for job nodes whose `jobRef.jobId` matches.
- Workflows in the job's project are listed with id, name and node ids.
- Workflows in other projects are counted but not named, so object names do not leak across projects.
- Both delete routes (offline jobs and engine jobs) call it before deleting; any reference returns 409.

```json
{ "success": false,
  "error": { "code": "JOB_IN_USE",
             "message": "This job is still referenced by 2 workflow job nodes: <A>, <B>; deletion refused. ...",
             "detail": { "workflows": [ { "id": "<wf>", "name": "<A>", "nodeIds": ["n3"] } ],
                         "otherProjects": { "count": 0 } } } }
```

The page shows the message verbatim and points the user to the workflow canvas.

## 13. Backfill

- The backfill executor's workflow scope has a `job` branch.
- Offline jobs run through `runEtlJob(job, { runDate, triggeredBy: "backfill", targetId, backfill })`.
- EMR jobs run through the EMR provider's `submit` with the same options.
- Run rows carry `triggeredBy: "backfill"`, `backfillPlanId` and `backfillNode`, matching SQL node backfill rows.
- The runner collects the final state by `(jobId, runId)`.

## 14. User interface

| Element | Location | `data-testid` |
|---|---|---|
| Job node card | Canvas, `JobNode.tsx` | `dag-node-job-name`, `dag-node-job-engine`, `dag-node-job-warning` |
| Job picker | Node configuration panel | `job-node-picker` |
| Missing-job hint | Node configuration panel | `job-node-missing` |
| Sync task picker | Node configuration panel | `sync-node-picker` |
| Candidate scope note | Node configuration panel | `node-candidates-scope` |
| Candidate load error | Node configuration panel | `node-candidates-error` |

- The palette lists the node automatically because it is user-placeable.
- The job picker has two groups, "Offline compute (Glue / Redshift)" and "EMR Serverless", with labels `name · engine · bound region`.
- Candidates come from the existing read endpoints `/api/etl-jobs`, `/api/engines/emr-serverless` and `/api/sync`, each called once per workflow region with `?scope=<targetId>`.
- For a workflow bound to several regions only candidates bound to every region are shown.
- A job that no longer exists or is no longer bound shows a warning on the card and in the panel; publish rejects it.
- The page help explains the node; English dictionary entries ship with the feature.

## 15. Compatibility

- Existing DAG definitions are untouched; `job` is a new node type.
- Classic published workflows must be republished once because the runtime library version changed.
- No new tables; no environment variables.
- Error code `JOB_IN_USE` is added to the API error code list.

## 16. Acceptance behaviour

Page-driven scenarios in a headless browser on a non-home region using the serverless scheduler:

1. Create a workflow; drag a sync node (a task of that region), a job node (a Glue job of that region) and a SQL node; connect them; publish.
2. Publish succeeds; the scheduler lists the workflow; a trigger runs all three nodes green and the instance ends `succeeded`.
3. The job's run history shows a row "Triggered by workflow <name>" that links to the workflow run; the workflow run's node details link back to the job's run history.
4. The sync task's run history shows the same kind of row.
5. Negative: a job bound only to the home region placed into the non-home workflow makes publish return 400 naming the node and the job.
6. Negative: deleting the referenced job returns 409 naming the workflow; the job remains.
7. A backfill plan that includes the workflow runs the job node per date with `triggeredBy: "backfill"`.

Unit guards:

- Registry closure and the backfill-capable set.
- Spec resolution rejections, and spec equality with the single-job carrier.
- Runtime single author across both carriers.
- YAML emits one task per job node carrying the spec.
- Python compile of both carriers.
- Publish 400 cases (sync mismatch, unbound job, legacy engine).
- Backfill job branch.
- Delete 409.
- Server render of the node card and panel fields.

Mutations: removing the lock acquisition or the publish-time binding check turns a test red.

## 17. Limits and known gaps

- The serverless task hard limit of 60 minutes applies; long job nodes end as `timeout-pending`, as with the single-job carrier.
- EMR application cold start of up to 10 minutes counts toward the node duration.
- Whether the business date reaches the sync Glue job depends on how the sync script reads arguments; this design adds only the binding check and run-row back-links for sync nodes.
