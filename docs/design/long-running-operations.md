# Long-Running Operations

Status: implemented. Code lives under `platform/src/lib/long-ops/`.

Related: [Supported versions](../supported-versions.md).

## 1. Summary

- Some write requests must wait for an external system to reach a final state before they can answer.
- Examples are a data-warehouse cold start, a large schema sync, a model inference, or an EMR application start.
- The platform sits behind an edge with a hard 60-second request limit, so such requests used to fail with 504 while the work kept running.
- This design removes "wait synchronously in the request handler" as a pattern from the whole platform.
- Only one server primitive remains, `submitLongOp`, and only one client semantic remains, "follow to the final state and hand back the same response".
- Routes and pages do not know that the 60-second limit exists.
- Guards make the next synchronous wait impossible to write without failing a test.

## 2. Problem

### 2.1 Symptoms before this design

Four independent routes hit the same wall and were each patched differently.

| Route | External wait | Symptom | Local patch |
|---|---|---|---|
| Governance "sync columns" | OpenMetadata and Redshift column read | "Sync failed" after 60 s, work finished later | Route-specific 202 and page polling |
| Delete project space | Redshift Serverless cold start | 400 "cannot verify" or 504 | Route-specific "warming" 202 and auto-retry |
| Seven model-calling POST routes | Model inference of 60 to 140 s | 504 HTML, page shows a JSON parse error | Task table and polling for AI routes only |
| Modeling "land" and "apply" | Target-region warehouse cold start | 504 while landing completed in the background | Not patched; triggered this design |

- Three 202 protocols and three polling loops existed, none reusable.
- An inventory found about 30 files with a "sleep and poll an external status" loop in the request path.
- Most of them had simply not met a slow day yet.

### 2.2 Root cause in three layers

```text
uncontrollable external time  x  edge 60-second limit  x  handler waits synchronously
(cold start, inference, big table)  (CloudFront origin timeout, ALB idle)   (route awaits the final state)
      physical, cannot change            defence in depth, kept               the only layer we can change
```

- The first layer is physical.
- The second layer is deliberate defence in depth; widening it would turn observable 202s into unobservable hangs.
- The third layer was decided per route in hundreds of handlers with no shared primitive and no guard.
- The fix is that the third layer has exactly one way to be written, and any other way fails a test.

## 3. Goals and non-goals

### 3.1 Goals

| Goal | Met when |
|---|---|
| One primitive | Only `lib/long-ops/` knows how long to wait, how to switch to 202, how to poll, how to settle |
| Zero call-site changes | Page `fetch("/api/...")` calls stay unchanged; adding a route changes the route and an executor, not pages |
| Fast path unchanged | A response that settles within the wait window is byte-identical to the previous synchronous response |
| Guards | The polling primitive has a single author, requires a wait context, and the call-site baseline only shrinks |
| Mechanically verifiable | A test deployment can force every route onto the 202 path by lowering the wait window |

### 3.2 Non-goals

- Do not widen the edge 60-second limit.
- No WebSocket or server-sent events; 2-second polling is sufficient.
- No task list page; a task id lives only in the browser session that started it.
- No change to the admin-DDL execution channel or its authorisation axis.

## 4. Design decisions

| # | Decision | Reason |
|---|---|---|
| D1 | Name everything `long-ops`: library, endpoint, table, env prefix, CDK context | The word `ops` already means operations dashboards in this repository |
| D2 | Keep the hybrid response: wait in-process, answer synchronously if settled, else 202 | The fast path must stay byte-identical for call sites to remain unchanged |
| D3 | The 202 body carries `protocol: "long-op/1"`; the client only reacts to that marker | Other 202 shapes exist (NL2SQL ask, legacy warming) and must not be hijacked |
| D4 | Client behaviour lives in the global fetch interceptor | Every `/api/*` call already passes through it; pages need no change |
| D5 | Final states are reshaped into the exact synchronous response, including the HTTP status | Earlier async failures lost 403 / 404 / 409 / 422 and became a generic 500 |
| D6 | Wait context via `AsyncLocalStorage`, process-wide singleton on `globalThis` | A polling primitive outside any context throws on its first call |
| D7 | Background loops declare themselves from a closed list of owners | Background work is legitimately outside the limit, but the back door must be enumerated |
| D8 | Interceptor emits DOM events; a shell component renders the global hint | The interceptor is not a React module and must not bypass the theme and locale providers |
| D9 | The AI task table was replaced, not duplicated, by `bgp-long-ops` | The table count stays constant |
| D10 | One set of environment knobs, prefix `LONG_OPS_*` | The earlier `AI_*` knobs were removed |
| D11 | `GET /api/ai/tasks/{taskId}` stays for one release as an alias | Existing acceptance tooling used that path |
| D12 | Closed kind list with a typed executor registry | Each kind maps to exactly one executor, one label, one parameter type |

## 5. Hybrid response

### 5.1 Server side

1. The route performs fast validation, authorisation, place resolution and audit actor capture.
2. The route calls `submitLongOp({ kind, params, correlationId }, ctx)`.
3. The driver acquires the object leases (section 9), creates the task row, claims it, and starts the executor in-process.
4. The driver waits up to `LONG_OPS_SYNC_WAIT_MS` (default 45 000 ms, below the 60-second edge limit).
5. If the executor settled within the window, the route answers exactly as before (same status, same envelope).
6. If it did not, the route answers 202 with the accepted body below, and the executor keeps running.

```json
{ "success": true,
  "data": { "taskId": "<ulid>", "kind": "modeling-land", "label": "<label>",
            "status": "running", "async": true, "protocol": "long-op/1" } }
```

### 5.2 Polling endpoint

`GET /api/long-ops/{taskId}` returns the task state. The caller must be the user who created the task.

| Case | Status | Body `data` |
|---|---|---|
| Succeeded | 200 | `status`, `result`, `resultStatus?`, `resultRaw?`, `elapsedMs` |
| Failed or timed out | 200 | `status`, `error`, `errorStatus?`, `errorBody?`, `elapsedMs` |
| Running with a fresh heartbeat | 200 | `status: "running"`, `elapsedMs`, `heartbeatAt` |
| Pending or stale running | 200 | This process claims it and continues the execution; returns `running` |
| Past the ceiling | 200 | Forced to `timeout`; never re-executed |
| Unknown task | 404 | `NOT_FOUND` |
| Another user's task | 403 | `RBAC_DENIED` |

- A failed task is a final state of the task, not a failure of the polling request, so the poll itself returns 200.
- `resultStatus` preserves a non-200 success status such as 201 for "create table".
- `errorStatus` and `errorBody` preserve the exact error status and envelope the synchronous branch would have returned.

### 5.3 Rollback switch

- `LONG_OPS_ASYNC` set to `0`, `false` or `off` disables the 202 path.
- Behaviour then equals the pre-framework behaviour byte for byte, including the ability to hit the edge limit.

## 6. Task table

Table `bgp-long-ops`; partition key `taskId` (ULID); TTL attribute `ttl` (7 days).

| Field | Type | Written by | Meaning |
|---|---|---|---|
| `taskId` | string | create | Primary key |
| `kind` | kind | create | Member of the closed kind list |
| `params` | per kind | create | All inputs, including place and project; another process may take over execution |
| `userId` | string | create | Owner; polling is restricted to the owner |
| `correlationId` | string | create | Correlation id of the submitting request |
| `status` | enum | state machine | `pending`, `running`, `succeeded`, `failed`, `timeout` |
| `result` | any | succeed | The response `data` of the synchronous branch |
| `resultStatus` | number | succeed | HTTP status of the synchronous success branch |
| `resultRaw` | boolean | succeed | `result` is the whole body, not wrapped in the envelope |
| `meta` | object | succeed | Source of `_meta` (for example the model used) |
| `error` | string | fail / timeout | Failure text; timeout always `LONG_OP_TIMEOUT` |
| `errorStatus` | number | fail | HTTP status the synchronous branch would have returned |
| `errorBody` | any | fail | Full error envelope the synchronous branch would have returned |
| `runToken` | string | claim | Current owner token; terminal and heartbeat writes are conditional on it |
| `leases` | string[] | create | Resource keys held by this task |
| timestamps | ISO | state machine | `createdAt`, `startedAt`, `heartbeatAt`, `finishedAt` |

### 6.1 State machine and concurrency guarantees

1. Claim and reclaim are DynamoDB conditional writes; only one executor moves `pending` to `running`.
2. Each claim issues a new `runToken`; a superseded executor cannot overwrite the current owner.
3. Terminal writes require `status = running`; the state never moves backwards.

Two ceilings end a task that will not settle.

- The executing process aborts the executor at `LONG_OPS_MAX_MS` (default 300 000 ms) and writes `timeout`.
- If the process died, the next poll compares `startedAt` with the ceiling and forces `timeout` without re-running.

Knobs: `LONG_OPS_STALE_MS` (heartbeat staleness, default 30 000 ms) and `LONG_OPS_HEARTBEAT_MS` (default 8 000 ms).

## 7. Client interceptor shaping

The global fetch interceptor in the auth provider handles every same-origin `/api/*` response.

1. It reacts only to status 202, JSON content type, `body.data.protocol === "long-op/1"` and a string `taskId`.
2. Any other 202 is passed through untouched.
3. It polls `GET /api/long-ops/{taskId}` every 2 000 ms with a total budget of 320 000 ms, using the original fetch and the same authorisation, project and environment headers.
4. Non-JSON 5xx responses during polling are treated as transient and polling continues.
5. JSON 4xx or 5xx responses from the poll endpoint are returned to the caller with that status.
6. On a final state it builds a new `Response` as the table below shows and hands it to the original caller.
7. The shaped response carries `content-type: application/json` and the header `x-bgp-long-op: <taskId>`.

| Final state | Shaped response |
|---|---|
| `succeeded` | `resultStatus ?? 200`, body `{ success: true, data: result, _meta? }` or the raw body when `resultRaw` |
| `failed` | `errorStatus ?? 500`, body `errorBody` if present, else `{ success: false, error: { message, code: "UPSTREAM_ERROR" } }` |
| `timeout` | 504, `{ success: false, error: { message, code: "UPSTREAM_TIMEOUT" } }` |
| Client budget exhausted | Same as `timeout` |

- The interceptor emits DOM events `started`, `progress` and `settled` (event name from a single author).
- The shell component `LongOpIndicator` renders "Running in background: <label> (<n>s elapsed)" and removes it on settle.
- Its container has `data-testid="long-op-indicator"` so page-driven tests can read it.
- Several concurrent tasks each get their own hint, keyed by task id.

## 8. Execution context and the wait primitive

- `awaitTerminal({ probe, intervalMs, maxIntervalMs, backoff, maxPolls | budgetMs, abortSignal? })` is the only primitive allowed to poll an external final state.
- `probe()` returns `{ done: false }` to continue or `{ done: true, value }` to finish; throwing propagates.
- Without a wait context it throws `LongOpContextMissing` on the first call, so a route that awaits a long service directly fails immediately in tests and in a real environment.
- Exceeding the budget throws `LongOpWaitBudgetExceeded`, with the time waited and the last observed state in the message.
- `runInLongOp(frame, fn)` is used by the driver; executors therefore have a context.
- `runAsBackgroundWaiter(owner, fn)` is used only at background loop entry points; `owner` must be in the closed list `BACKGROUND_WAITERS`.
- Background owners today: data-plane job step, reconciler, metadata mirror, sync run tracker, ETL run tracker, backfill tick, real-time start, seed run, engine run, Flink deletion.
- Request paths must not open a background context; a test pins the set of files allowed to call `runAsBackgroundWaiter`.

## 9. Resource leases and 409 on conflicting operations

### 9.1 Why

- A long operation changes an object's external products in several non-transactional steps (DDL, observe, record binding).
- The object definition itself remained editable and deletable during that window.
- Observed race: landing a code table took 67 s while the same code table was deleted; the task reported success, but the physical table stayed behind as an orphan.

### 9.2 Mechanism

| Part | Definition |
|---|---|
| Resource key | `<family>:<segment>[:<segment>...]`, built only by `resourceKey(family, ...parts)` |
| Families | Closed list: `codetable`, `dimension`, `table`, `approval`, `governance`, `project`, `flink`, `workflow`, `datasource`, `engine-job` |
| Declaration | `LONG_OP_RESOURCES` maps every kind to a function returning its keys; read-only kinds return an empty array |
| Lease row | Same table, key `lease#<resource key>`, fields `resource`, `holder` (task id), `kind`, `acquiredAt`, `ttl` |
| Acquire | Conditional put per key in lexical order; any failure rolls back the acquired keys and raises 409 |
| Dead lease | Decided by the holder's real state: finished, past the ceiling, or missing beyond a 60-second grace period |
| Release | Terminal writes return the held keys and delete them conditionally on `holder` |
| Route guard | `resourceBusyResponse([...keys])` in update and delete routes returns the same 409 or `null` |

- The 409 body is `{ code: "LONG_OP_IN_PROGRESS", detail: { taskId, kind, label, resource } }` with the message "<label> is in progress (<n>s elapsed); wait for it to finish".
- The driver checks leases before creating the task row; a conflicting submit answers 409 synchronously and leaves no row.
- The synchronous-only mode (`LONG_OPS_ASYNC` off) still acquires and releases leases with a synthetic holder.
- Guarded update and delete routes include code tables, dimensions, projects, Flink jobs, workflows, data sources, engine jobs, and the schedule-enable route of workflows.

### 9.3 Not covered

- Query-level mutual exclusion between concurrent read-only requests.
- Cross-entity dependency locks (for example a project versus objects inside it).

## 10. Closed kind list

Every kind below is declared in `lib/long-ops/kinds.ts` together with its parameter type, label and resource keys.

| Kind | Area | What it waits for |
|---|---|---|
| `copilot-ask` | Copilot | Model inference |
| `net-advise` | Network advisor | Model inference |
| `param-advise` | Parameter advisor | Model inference |
| `codegen-etl` | Offline compute | Model inference (code generation) |
| `codegen-emr` | EMR jobs | Model inference (code generation) |
| `codegen-requirement` | Requirements | Model inference (implementation generation) |
| `flink-ai-sql` | Real-time compute | Model inference (Flink SQL generation) |
| `modeling-land` | Modeling | Redshift DDL on the target region |
| `modeling-apply` | Modeling | Redshift DDL on the target region |
| `modeling-unbind` | Modeling | Redshift drop and ledger update |
| `modeling-unbind-preview` | Modeling | Redshift row-count estimate (GET) |
| `catalog-create-table` | Governance catalog | Redshift or S3 Tables DDL |
| `catalog-alter-table` | Governance catalog | Redshift DDL or dry-run plan |
| `catalog-read-columns` | Governance catalog | Live column read (GET) |
| `approval-execute-ddl` | Approvals | Approved DDL execution |
| `governance-schema-sync` | Governance | OpenMetadata and Redshift column collection |
| `project-delete` | Projects | Redshift inventory statement on a possibly cold warehouse |
| `sync-execute-ddl` | Data sync | Target table creation and platform marker |
| `sync-generate-ddl` | Data sync | Target table probe |
| `flink-start` | Real-time compute | Managed Flink application start |
| `flink-stop` | Real-time compute | Managed Flink application stop |
| `flink-delete` | Real-time compute | Application stop, then deletion (background waiter) |
| `workflow-publish` | Orchestration | DAG upload and scheduler load |
| `workflow-unpublish` | Orchestration | DAG removal on every region |
| `workflow-trigger` | Orchestration | Scheduler run start per region |
| `workflow-delete` | Orchestration | DAG removal, then row deletion |
| `datasource-s3-external` | Data sources | Athena external table DDL |
| `modeling-metric-compute` | Modeling | Redshift scalar query |
| `metric-compute` | Metrics | Redshift query |
| `datasource-create` | Data sources | Glue role check, network probe, Glue connection creation |
| `engine-run` | EMR jobs | Script upload, application start, job run submission per region |

Notes on specific kinds:

- `catalog-create-table` settles with `resultStatus` 201.
- `flink-start` and `flink-delete` settle with `resultStatus` 202 because their own semantics are "accepted".
- The four workflow kinds use `rawBody`; their historical responses were flat bodies without the envelope, and both branches return them unchanged.
- `datasource-create` keeps the secret creation in the route so the password never enters the task row; the executor receives only the secret ARN and cleans up in reverse order on failure.
- `engine-run` keeps fast validation, run-group creation and definition versioning in the route; the executor re-reads the job and submits per region.
- `modeling-unbind-preview` and `catalog-read-columns` are GET routes that still use the framework because they share the same waiting primitives.

## 11. Adding a new kind

1. Add the kind to `LONG_OP_KINDS`, its parameter type to `LongOpParamsByKind`, and its label to `LONG_OP_LABELS` in `kinds.ts`.
2. Declare its resource keys in `LONG_OP_RESOURCES`; use a new family only after adding it to `LONG_OP_RESOURCE_FAMILIES`.
3. Write the executor in the owning domain (for example `lib/<domain>/long-ops.ts`) importing only `executor-types.ts` and `kinds.ts`.
4. Register the executor in `registry.ts`; the type system requires exactly one executor per kind.
5. In the route, keep validation, authorisation and place resolution; move the waiting body into the executor; call `submitLongOp` and return `longOpResponse(req, result)`.
6. Map errors with `LongOpHttpError` (status plus original envelope) so both branches answer identically.
7. Add update and delete route guards with `resourceBusyResponse` for the object family.
8. Move any `sleep`-and-poll loop in the executor to `awaitTerminal`, keeping the original budget.
9. Make sure the executor is idempotent on re-execution, or add an idempotency key, because a stale task may be reclaimed by another process.
10. Run the guard tests; the call-site baselines must shrink or stay equal, never grow.

## 12. Guards

| Guard | What it pins |
|---|---|
| Registry wiring | Executor keys, label keys and parameter types equal the kind list |
| Await-terminal ratchet | Files containing a sleep loop next to a status query command are a subset of a baseline that only shrinks |
| Background entry points | Files calling `runAsBackgroundWaiter` equal a closed list; none under `app/api/**` |
| Route wiring | Every listed route calls `submitLongOp` with its own kind and no longer contains the waiting body |
| Direct-await ratchet | Routes calling long services directly are a subset of a shrinking baseline |
| Store and driver | State machine guarantees, five reconcile decisions, three response branches, error status preservation |
| Client follow | Only the protocol marker is honoured; reshaping rules; transient handling; events |
| Interceptor wiring | The interceptor actually calls the follow function with the original fetch and headers |
| Two sides | Table name in code equals the table created by the infrastructure stack |
| Environment keys | Container environment includes `LONG_OPS_SYNC_WAIT_MS`; CDK context default is 45 000 |
| Leases wiring | Every kind declares resources; guarded routes call the guard before the service call; no bypass route |

## 13. User-visible behaviour

| Situation | Behaviour |
|---|---|
| Operation finishes within the wait window | Exactly as before: button loading, then success message and list refresh |
| Operation exceeds the wait window | Button stays loading; a global hint shows the label and elapsed seconds; completion triggers the original success path |
| Operation exceeds the ceiling | Message "operation exceeded 5 minutes and was stopped; narrow the scope and retry" (504); never re-executed |
| User refreshes or closes the tab | The task continues to its final state; the page no longer tracks it; list pages show the real state on reload |
| Second operation on the same object | Toast with the 409 message naming the running operation and elapsed time |
| English locale | Labels and hints are translated |

## 14. Acceptance behaviour

Acceptance is performed in a headless browser against the pages; API and table reads are cross-checks only.

- A test deployment sets the CDK context `long-ops-sync-wait-ms` to a small value so every connected route takes the 202 path.
- For each kind: the first network response is 202 with the protocol marker, the indicator appears, and the page finally receives the synchronous status with the `x-bgp-long-op` header.
- The `data` of the synchronous branch and the `result` of the polled branch are deeply equal, except for the correlation id.
- A failure on the asynchronous branch reshapes to the exact synchronous status and message (for example a 403 for a non-assignee).
- A real cold-start scenario (idle warehouse for an hour) produces 202 then 200 and no 504.
- The NL2SQL ask route's own 202 is not intercepted.
- Starting a landing and immediately deleting the same object answers 409 and leaves no orphan table.
- Unit guards in section 12 are all green.

Production deployments must not set `long-ops-sync-wait-ms`; the default of 45 seconds applies.

## 15. Operations

- New tables are created by the upgrade script's database-stack step.
- Structured logs: `long-op.accepted` (task id, kind, waited ms) and `long-op.settled` (status, elapsed ms, error status), both from the driver.
- Aggregating `long-op.accepted` by kind shows which routes exceed the wait window and are candidates for optimisation.
- No audit rows are written by the framework itself; business writes are audited by the executors as before.
- No new IAM actions are required.

## 16. Limits

- Execution runs inside the ECS task that accepted the request; a rolling deployment leads to a reclaim in a new process, so executors must be idempotent.
- A refreshed page loses the hint; the ledger remains the truth.
- Requests are held for up to 45 seconds; concurrency pressure is unchanged from before.
- Leases are object-level; too coarse a key serialises unrelated changes, too fine a key misses conflicts.
- The ratchet is a source-literal scan; SDK waiter helpers are included in the scan word list.

## 17. Known gaps

- The single-region engine rerun route still submits synchronously.
- The schedule-enable route of workflows has the lease guard but still awaits publishing directly.
- The NL2SQL ask route keeps its own asynchronous protocol.
- A few waiting primitives with callers outside request paths remain on the ratchet baseline.
