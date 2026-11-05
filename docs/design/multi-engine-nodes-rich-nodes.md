# Multi-Engine Nodes, Part B — Rich Workflow Nodes: Detailed Design

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the behavior under the multi-region deployment — place (target), execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of the module is recorded in the design index. A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> Revision: 0.2 (**✅ Implemented · in canary rollout (the default engine is still `legacy`; Strangler-style canary)**) (documentation audit calibration of 2026-08-26: the previous status header was outdated — it still read "design draft / code not started") | Created: 2026-08-02 · Updated: 2026-08-02 | Owner: architecture
> Parent roadmap: the platform roadmap of 2026-08 (historical, archived) — its rich-node item in section 1 and its entry for this module in section 3 (annotated "add `generateAirflowDagV2`, freeze the old generator pending deletion, run as a separate project")
> Predecessor: part A — batch multi-engine compute on EMR, completed 2026-07-03 — see [Multi-Engine Nodes](./multi-engine-nodes.md)
> Related disciplines: the change-safety discipline (the blast radius was surveyed before the change, see section 7) · the contract-guard regression check (the `lineage_column` anchor must not regress)
> Related facts: every statement about the current state in this design comes from a full-repository evidence sweep on 2026-08-02, marked 🔵 hard evidence from code `file:line` / ⚪ official mechanism / 🟢 to be verified by a real deployment

---

## 0. Goals and Non-Goals

**Goal**: extend the node types of visual workflow orchestration from the 3 types `sync/sql/python` to cover the mainstream node capabilities of a leading cloud data-development suite, **giving priority to reusing the native capabilities of Amazon MWAA (Airflow 2.10.3; see [supported versions](../supported-versions.md)) rather than building our own scheduling semantics**.

**Directions decided on 2026-08-02**:
| # | Decision point | Decision |
|---|---|---|
| ① | DAG code generation architecture | **Fixed runtime library + lightweight configuration injection** (no more string-concatenating Python business logic) |
| ② | Delivery approach | Produce the complete design document first; implement only after it is approved |
| ③ | Scope boundary | Do everything that can be implemented with native MWAA capabilities; what is not supported (loops) goes to the backlog |
| ④ | **Migration strategy** | **Strangler Fig with two engines in parallel**: the old generator is **frozen** (output only, no new input, no new node types), a new `generateAirflowDagV2` is added alongside it, and the `WORKFLOW_DAG_ENGINE` flag switches between them; after several canary rounds with zero regressions, **the next version deletes the old engine and keeps only the new one**. See section 8 |
| ⑤ | **Scope of the `exec` root fix** | The restricted executor is built **only in the new engine**; the bare `exec` of the old engine is **frozen together with the engine** and closed when the old engine is deleted. A platform-wide grep confirms the RCE surface is **exactly this 1 place** (section 5.4) |
| ⑥ | **Engine capability gate** | The two engines are **not functionally equivalent**: old = the three legacy nodes `sync/sql/python`; new = the three legacy nodes + six new ones (a superset). A workflow that contains a new node **must go through the new engine** (flag = legacy + new node present = rejected before publish, section 8.3) |

**Non-goals (not in this phase; see the backlog in section 6)**:
- ❌ Loop nodes (while / do-while) — an Airflow DAG is a directed **acyclic** graph; the model fundamentally does not support run-time loops
- ⚠️ HTTP trigger node — requires the MWAA `requirements.txt` groundwork first, which crosses into CDK; a separate batch
- Data-integration capabilities such as sharded-database / sharded-table or whole-database migration — they belong to the data-integration workstream of the roadmap, not to the rich-node item

---

## 1. Current Contract (must be fully understood before the change; all of it evidence-based)

### 1.1 The "source of truth" for node types — no strong typing, only a run-time convention
- 🔵 `types/workflow.ts:6`: `dagDefinition: { nodes: any[]; edges: any[] }` — nodes are `any[]`, **with no compile-time constraint**.
- The legal values of the node type `node.type` (`sync`/`sql`/`python`) are scattered across **5 run-time checks** with no single source of truth:
  1. 🔵 `lib/workflow/dag-generator.ts:23/31/40` — an if/else chain translating into Airflow operators
  2. 🔵 `app/workflow/[id]/page.tsx:16-19` — `nodeTemplates` (the drag-and-drop palette)
  3. 🔵 `app/workflow/[id]/page.tsx:279-281` — pre-publish validation
  4. 🔵 `components/dag-editor/DagEditor.tsx:60` — the `nodeTypes` render-component map
  5. 🔵 `components/dag-editor/NodeConfigPanel.tsx:60/71/88` — configuration panel branches
- 🔵 `lib/backfill/execute.ts:64` — backfill recognizes only `sql` nodes; everything else fails honestly.

> **Design implication (change-safety A1)**: adding a node type must cover these 5+1 places **in the same change**, otherwise they drift. Section 3 uses the type system to converge them into a single registry.

### 1.2 Current state of DAG generation — string-concatenated Python (the core of what this design replaces)
- 🔵 `lib/workflow/dag-generator.ts`: `generateAirflowDag()` concatenates every node into `PythonOperator(...)` text,
  and the execute logic (`trigger_sync_task`/`execute_redshift_sql`/`run_custom_script`) is inlined into the generated DAG.
- 🔵 `run_custom_script` uses `exec(script)` (:169) — a python node runs the user script directly with `exec` on the MWAA worker. **Security debt, see section 5.3**.
- 🔵 `userId: "default-user"` is hard-coded (:90/:138) — DAG generation still assumes a single tenant, inconsistent with the platform's multi-tenant RBAC. **Technical debt, see section 5.3**.

### 1.3 DAG generation has 4 entry points (a reuse opportunity)
🔵 There are 4 generators platform-wide that put files into the `dags/` bucket:
1. `app/api/workflow/[id]/publish/route.ts:33` — visual workflow (**the protagonist of this design**)
2. `app/api/etl-jobs/[id]/schedule/route.ts:39` — ETL jobs
3. `app/api/engines/[engine]/[id]/schedule/route.ts:71` — EMR engine jobs (`emr/dag-generator.ts`)
4. `app/api/schedule/enable/route.ts:42` — generic scheduling

> **Design implication**: if the fixed runtime library is abstracted well, it can become the **shared execution layer** for all 4 entry points (section 2 discusses the boundary trade-off).

### 1.4 Full-lifecycle consumers (new nodes must not break them)
| Stage | Current contract | 🔵 Evidence |
|---|---|---|
| Publish | fire-and-forget polling, 18×10 s, waits for the DAG to load and then unpauses (works around the CloudFront 60 s timeout) | `publish/route.ts:56-75` |
| Versioning / rollback | version-service snapshots the **entire** dagDefinition; rollback restores data only | `version-service.ts:16/25` |
| Backfill | SQL nodes only; everything else fails honestly | `backfill/execute.ts:64-71` |
| Run history | the DAG writes back to `bgp-task-runs` (on_success/on_failure callbacks) | `dag-generator.ts:86-133` |
| Node status rendering | colored by `data.runStatus`, **independent of the type** | `nodeStatus.tsx` |

> **Design implication**: full version snapshots → the runtime-library approach is **naturally compatible across versions** (the fixed library is not part of the snapshot; the DAG is a projection of dagDefinition; rollback is safe). This is an extra benefit of the runtime-library architecture.

---

## 2. Core Architecture: Fixed Runtime Library + Lightweight Configuration Injection

### 2.1 Why (compared with string concatenation)
| Dimension | String-concatenated Python (current) | Fixed runtime library + configuration injection (this design) |
|---|---|---|
| Injection risk | High (SQL/script concatenated into code; escaping relies on `.replace`) | **None** (business data is passed as JSON parameters and never enters the code text) |
| Indentation / syntax | Fragile (multi-branch concatenation easily scrambles) | **Stable** (the generated DAG has a fixed, minimal structure) |
| Testability | Hard (you only know whether it is right by running Airflow) | **Easy** (the runtime library has independent unit tests; the generator only tests JSON) |
| Rising node complexity | Concatenation becomes exponentially more complex | Linear (add one executor function) |
| Rollback | The DAG text changes with every version | The library is fixed, the DAG = a projection of the data, rollback restores data only |

### 2.2 Layering
```
Generated DAG (one per workflow, minimal):
  from bgp_workflow_runtime import build_dag
  DAG_SPEC = { "dagId": "...", "schedule": "...", "nodes": [ {id,type,data,deps}... ] }
  dag = build_dag(DAG_SPEC)          # all construction logic lives in the fixed library

Fixed runtime library bgp_workflow_runtime.py (one copy, shared by all DAGs):
  - NODE_EXECUTORS: { "sync": ..., "sql": ..., "python": ..., "branch": ..., "empty": ..., "foreach": ..., "join": ..., "setvar": ..., "external": ... }
  - build_dag(spec): builds the DAG + operators + dependencies + trigger_rule + on_failure callback from the spec
  - the executor functions (trigger_sync_task / execute_redshift_sql / ... )
```

### 2.3 Delivery mechanism (verified; independent investigation of 2026-08-02 backed by official AWS references)

| # | Question | Conclusion | Evidence |
|---|---|---|---|
| 1 | Can a DAG import a .py module from the same directory | ✅ **Yes**. `DAGS_FOLDER` (`/usr/local/airflow/dags`) is on `sys.path`; AWS officially states that custom operators/integrations can be placed directly under `/dags`. A generated DAG that writes `from bgp_workflow_runtime import build_dag` works | 🔵 AWS MWAA "Installing custom plugins" official documentation |
| 2 | Should the fixed library be delivered by S3 put or by CDK | ✅ **S3 put is enough; zero CDK change**. The contents of dags/ are not managed by CDK (no BucketDeployment); the platform puts/deletes them at run time. CDK's `dagS3Path` only sets the prefix | 🔵 `platform-stack.ts:53/768` + no `BucketDeployment` anywhere in the repository |
| 3 | Sync latency | ⚪→🔵 **about 30 s** to sync to all scheduler/worker containers (same channel as the DAGs); `dag_dir_list_interval=30`/`min_file_process_interval=30` (`mwaa-stack.ts:125-126`) | 🔵 official + configuration |
| 4 | Will a non-DAG .py be parsed by mistake | ⚠️ **Yes**. Hard official requirement: files under `/dags` that contain no DAG object **must be listed in `.airflowignore`**. The repository has no such file today | 🔵 official documentation + zero hits in a full-repository grep |
| 5 | Python module cache window | ⚠️ Long-lived processes cache `sys.modules`; after an S3 update the old version may linger briefly (there is no official explicit invalidation guarantee for helper modules under dags) | ⚪ inferred |
| 6 | **safe_mode keyword scan (🔴 root cause found by production testing; confirmed 2026-08-04 on the MWAA of a fresh account)** | 🔴 **Airflow's `DagFileProcessor` defaults to `safe_mode=True` and parses only those .py files whose content contains both keywords `airflow` and `dag` (case-insensitive); otherwise it skips the file silently — not loaded, no import error reported.**<br>The minimal three-line shell of the runtime library (`from bgp_workflow_runtime_v1 import build_dag`) **does not contain the word `airflow`** → every new-engine DAG was silently skipped by MWAA.<br>**Root fix**: the first-line comment of the generated DAG explicitly contains `airflow` (`dag-generator-v2.ts`; the safe_mode contract is pinned by a unit test) | 🟢 Measured with an MWAA self-diagnostic DAG: `list_py_file_paths` cannot see the three-line shell DAG; control experiment — the same DAG with an `airflow` comment added loaded successfully after 28 s |

> **D3 (response to fact 6; the core production fix of this phase)**: the first-line comment of a generated DAG file **must contain the keyword `airflow`** to feed safe_mode. This is a real defect exposed by the "three-line shell" of section 10.1 being too minimal — it cannot be detected in the pure-code / unit-test stage (safe_mode is MWAA run-time behavior); **it only shows up when actually deployed to MWAA**. This is exactly the value of full-coverage verification. The diagnostic path is noted in section 14.

**Two design decisions settled by these facts:**
- **D1 (response to fact 4)**: on the first publish, **idempotently deliver `dags/.airflowignore`** (listing non-DAG helper modules such as `bgp_workflow_runtime*.py` for exclusion) through the same S3 put channel. Otherwise the scheduler repeatedly parses the library as a DAG and reports errors.
- **D2 (response to fact 5)**: the fixed library's **file name carries a content hash / version** (for example `bgp_workflow_runtime_v{N}.py` or `_{sha8}`), and the generated DAG imports the corresponding versioned name. Thus: ① updating the library = publishing a new file name, so the old library cached in long-lived processes does not affect already-published DAGs; ② newly published DAGs import the new library; ③ old DAGs still point to the old library file (which is kept) — **naturally compatible across versions**, with no blast radius of "changing the library breaks every existing DAG". `.airflowignore` uses the wildcard `bgp_workflow_runtime*.py` to cover all versions.

> **Architecture confirmation**: the runtime-library approach **goes entirely through the existing S3 put channel, with zero CDK change and zero provider package installation**. Beyond its advantage over "string concatenation", this is a further advantage over the "MWAA plugins / requirements route" (which needs a CDK environment update + ObjectVersion for every update — heavyweight).

---

## 3. Node Inventory and Metadata Design (first batch = pure Airflow core built-ins, zero provider packages)

| New node | Airflow 2.10.3 translation | Node `data` fields | ⚪ Module ownership |
|---|---|---|---|
| **branch** | `BranchPythonOperator` | `data.branches[]` ({condition expression → downstream nodeId}) + a default branch | `airflow.operators.python` built-in |
| **empty / dummy** | `EmptyOperator` | none (pure convergence / placeholder) | `airflow.operators.empty` built-in |
| **join** | `EmptyOperator` + `trigger_rule` | `data.rule` (all_success/none_failed/none_failed_min_one_success) | core trigger_rule |
| **foreach** | Dynamic Task Mapping `.expand()` | `data.items` (a static list or an upstream XCom key) + a sub-task template | core, 2.3+ |
| **setvar (assignment)** | `PythonOperator` + XCom push | `data.vars` ({key: value / expression}) | core XCom |
| **external (cross-cycle dependency)** | `ExternalTaskSensor` | `data.externalDagId` + `data.executionDelta` | `airflow.sensors.external_task` built-in |

> All of them need **zero provider packages and zero CDK change** (Airflow core modules only). This is the key reason the first batch selects exactly these — the risk of "having to touch CDK / install packages" is isolated to later batches.

### 3.1 Metadata and UI of each node (details in the implementation phase; the contract is fixed here)
- Each node type: one render component (following the `SqlNode.tsx` pattern) + one configuration branch in NodeConfigPanel + one row in nodeTemplates + one validation rule.
- The "condition expression / collection source" of branch/foreach uses a **restricted DSL or an allow-list**; arbitrary Python is not allowed (security, see section 5.3).

---

## 4. Type System Design (change-safety A4: make illegal states unrepresentable)

Upgrade `nodes: any[]` to a **discriminated union**, with the `type` field as the discriminator:
```ts
type WorkflowNode =
  | { type: "sync";    data: { label?: string; syncTaskId: string; ... } }
  | { type: "sql";     data: { label?: string; sql: string; engine: "redshift"|"glue"; ... } }
  | { type: "python";  data: { label?: string; script: string; ... } }
  | { type: "branch";  data: { label?: string; branches: {cond: string; target: string}[]; ... } }
  | { type: "empty";   data: { label?: string } }
  | { type: "join";    data: { label?: string; rule: TriggerRule } }
  | { type: "foreach"; data: { label?: string; items: string | string[]; ... } }
  | { type: "setvar";  data: { label?: string; vars: Record<string,string> } }
  | { type: "external";data: { label?: string; externalDagId: string; executionDelta?: number } };
```
- **A single registry** (single source of truth): node type → { render component, configuration panel, validation, runtime executor name } driven by one table,
  eliminating the 5 scattered checks of section 1.1. Adding a node = one row in the registry + one executor in the runtime library (following the table-driven paradigm of the part-A engine SPI).
- Benefit: if an LLM or the front end writes an unknown node type or omits a field → the error is reported at the `tsc` stage, not at run time.

---

## 5. Full-Lifecycle Impact Analysis

### 5.1 Not broken (current behavior retained)
- **Publish polling**: with the runtime library the DAG is smaller and loads faster; the poll-then-unpause logic is unchanged.
- **Versioning / rollback**: ✅ naturally compatible (section 1.4).
- **Run history / monitoring**: the on_success/on_failure callbacks move into the runtime library; the contract of writing back to task-runs is unchanged.

### 5.2 Needs extension
- **Backfill**: new nodes keep the default "backfill not supported, fail honestly" (the allow-list in `backfill/execute.ts:64`). Whether branch/foreach should support backfill = assessed in phase two; not extended in this phase.
- **Per-node status back-population**: the existing mechanism reads by task instance, so new operators fit in naturally; displaying the status of foreach's dynamic sub-tasks needs UI adaptation (listed for phase two).

### 5.3 Final decisions on technical debt (decided 2026-08-02)
> ⚠️ The initial decision was "root-fix the technical debt"; after surveying the blast radius, the two debts turned out to differ by 3 orders of magnitude (`exec`: exactly 1 place / default-user: **5848 places** platform-wide), so they were split. **Under the Strangler parallel strategy the scope was narrowed one more level** (second decision of 2026-08-02):

1. ✅ **`exec(script)` security (:169) — root-fixed only in the new engine; no patch for the old engine**.
   - A python node that runs an arbitrary user script with `exec` directly on the worker = a remote code execution surface. **The new engine (`generateAirflowDagV2` + runtime library) natively uses the restricted executor** (section 5.4); this RCE surface never exists on the new path.
   - 🔴 **The bare `exec` of the old engine is left untouched and frozen together with the engine**, for these reasons (Strangler discipline; change-safety part C): ① the old engine is "the old vine that will be strangled and deleted in the next version", so investing security work in dead code is wasted effort; ② **the stronger reason — the frozen output of the old engine is the canary control group (the characterization golden master)**: once the python execution of the old engine is changed (bare exec → restricted), the control group itself changes and the "old vs. new equivalence" comparison loses its meaning. **A control group must be frozen solid to have value as a control.**
   - So the correct answer is: root-fix in the new engine; the old engine's bare exec stays open during the parallel period and **is closed together with the engine when the old engine is deleted**. This is not "ignoring it" — it is registered as a **known legacy risk + a guardrail tied to the deletion trigger** (section 8.5).
2. ⏸️ **The `default-user` hard-coding — split out into a separate initiative (multi-tenant DAG generation)**. A platform-wide grep finds **5848 places** (dozens of modules: datasources/engines/etl-jobs/flink/backfill); it is a systematic "single tenant → true multi-tenant" migration that **far exceeds the scope of rich nodes**; stuffing it into this design = breaking things while changing them. The new engine `generateAirflowDagV2` **keeps the default-user status quo** (consistent with the whole platform; it does not create a new inconsistency), and the separate initiative root-fixes it uniformly. See the authoritative roadmap document, section 3, entry for that initiative.
3. The condition expressions of branch/foreach: a **restricted allow-list DSL**; never eval arbitrary user input (the same security baseline as the `exec` root fix of section 5.4).

### 5.4 The `exec` root-fix approach (native security capability of the new engine only)
- **Platform-wide execution-surface scan (2026-08-02; evidence hygiene: a grep over all static source code)**:
  | Execution surface | Platform-wide hits | Conclusion |
  |---|---|---|
  | Python `exec(` | 🔵 **exactly 1 place** `workflow/dag-generator.ts:169` | the very place to be root-fixed |
  | `eval(` / `new Function` / `Function()` | 🔵 zero | none |
  | Node `child_process`/`execSync`/`spawn` | 🔵 zero | none |
  | The other 3 DAG generators (etl/emr/spark-lineage) | 🔵 zero exec | etl only splices SQL; emr submits to the isolated EmrServerless runtime; neither execs user scripts on the worker |
  > **Verdict**: the platform-wide RCE surface converges to exactly 1 place; **the root fix does not need to spread, and there is no "plug one hole, open another"**.
- **Root fix (the python node executor `_exec_python_safe` in the new engine's runtime library, section 12)**:
  - By default **forbid dangerous built-ins / modules** (`__import__`/`eval`/`exec`/`open`/`os`/`sys`/`subprocess`/`socket`), exposing only an allow-list of safe built-ins + the platform-injected data-manipulation API;
  - The positioning of the python node narrows to "**restricted expressions / data transformation**"; complex logic is steered to sql nodes;
  - Shares the same allow-list validation with the branch/foreach condition DSL (section 5.3, item 3).
- **Verification (new-engine path only)**: build a workflow containing a python node in a headless browser (flag=runtime-lib) → an attempt at a dangerous script such as `import os` is rejected → a normal data-transformation script passes.
- ⚠️ **No such verification on the old-engine path** — its python node behavior (bare exec) stays frozen as is, which is precisely the root of "the python node was never equivalent across the two engines, so no equivalence comparison is made" (section 8.4).

---

## 6. Backlog (TODO, recorded in the authoritative roadmap document, section 3)

| Item | Reason | Prerequisite |
|---|---|---|
| ⚠️ **HTTP trigger node** | `HttpOperator` belongs to a provider package | First add `requirementsS3Path` to `mwaa-stack.ts` + a `requirements.txt` that installs `apache-airflow-providers-http`; crosses into CDK, a separate batch |
| ❌ **Loops while / do-while** | Airflow's acyclic DAG model fundamentally does not support run-time loops | No solution; can only be approximated with foreach (a finite collection). **Definitely not done**; stated explicitly to users and in the documentation |
| ~~exec sandboxing~~ | ✅ **Root-fixed in the new engine in this phase** (section 5.4); the old engine's bare exec is closed when the old engine is deleted (registered as a known legacy risk in section 8.5) | — |
| 🔵 **Multi-tenant DAG generation (`default-user`)** | Single-to-multi-tenant debt in 5848 places platform-wide | **Split into a separate initiative** (authoritative roadmap document, section 3); the new engine keeps the status quo and creates no new inconsistency |
| 🟡 **Unify the 4 DAG generation entry points onto the shared runtime layer** | Reuse (section 1.3) | This phase serves workflow only; absorb etl/emr/schedule after the approach has proven mature |

---

## 7. change-safety Survey (blast radius before the change)

- **A1 single source of truth**: the legal node-type values are scattered across 5 places (section 1.1) → the 4 places of the shared layer converge into a single registry (section 13); of the engine-specific translation places, the old one is frozen and the new one reads the registry.
- **A2 blast radius**: a repository-wide `grep node.type` has been listed in full; the workflow DAG chain is closed within itself, and the other `.type===` hits are all unrelated domains (approvals/alerting/governance/etl/sync). **Structural benefit of Strangler (change-safety part C)**: adding `generateAirflowDagV2` instead of changing the old function → the blast radius of the new engine is **physically isolated in a new file behind a flag**; with the default flag=legacy, **the default behavior does not change at all**, and the old path cannot reach the new code. This is the strongest form of "fixing A physically cannot reach B".
- **A3 pin the current state**: phase 0 runs a `contract-guard snapshot` + a headless-browser baseline of workflow publish/run = the characterization golden master; **freezing the old engine is exactly what keeps this baseline a trustworthy control through the entire canary period** (section 8.4).
- **A4 type-level blocking**: the discriminated union of section 4 + the registry `Record<WorkflowNodeType,...>` (a missing registration is a tsc error) + the `minEngine` field turn "a new node routed to the wrong engine" into something that can be intercepted before publish (section 8.3).

## 8. Migration Strategy: Strangler Fig with Two Engines in Parallel (decided 2026-08-02)

> **Core mindset (as stated in the decision)**: *"Leave the existing capability untouched, implement it once more with MWAA capabilities, and after testing goes smoothly many times over, one version simply removes the original capability, and from then on a version has only the newest MWAA capability."* — This is textbook Strangler Fig (change-safety part C / Martin Fowler): wrap the old in a façade, grow the new in parallel, switch gradually, strangle once stable; the risk is always confined to the small "new engine" area, and flag=legacy can roll back at any time.

### 8.1 Mechanism for running two engines side by side (modeled on the mechanism of the Ask-Your-Data (GenBI) dual backend, not on its direction)
- 🔵 **A live precedent already exists in this repository**: `lib/genbi/execute.ts:48` `const backend = (process.env.GENBI_BACKEND || "inprocess")` selects the backend by env, and `:111` **falls back automatically** on failure. It runs in production; the mechanism is mature and can be borrowed.
- ⚠️ **Honest boundary**: GenBI defaults to `inprocess` (self-built), with agentcore as an optional enhancement — its default direction is the **opposite** of ours (we default to the old legacy engine and gradually switch to the new one). **What we borrow is the "env flag selects the implementation + fallback" mechanism, not its default direction.** We do not vaguely say "copied as is".
- **Implementation**:
  - Add `WORKFLOW_DAG_ENGINE = "legacy" | "runtime-lib"`, **default `legacy`** (the old engine).
  - `generateAirflowDag()` in `lib/workflow/dag-generator.ts` is **not changed by a single line** (frozen).
  - **Add** `generateAirflowDagV2()` in `lib/workflow/dag-generator-v2.ts` (serializes the spec + a 3-line shell, section 10).
  - The publish route chooses which generator to call according to the flag.

### 8.2 Five-step migration path (each step reversible)
| Step | Action | Rollback |
|---|---|---|
| **① Freeze** | Freeze the old `generateAirflowDag` (including its bare exec, section 5.3); take a `contract-guard snapshot` + a headless-browser baseline of workflow publish/run = the characterization golden master | — |
| **② Parallel** | Add `generateAirflowDagV2` + the runtime library + the `WORKFLOW_DAG_ENGINE` flag (default legacy). **Zero change to default behavior**; the new engine is used only when the flag is explicitly runtime-lib | Delete the flag / delete the v2 file; the old engine is untouched |
| **③ Canary** | Internally set flag=runtime-lib and run **result-level equivalence verification** on workflows with the three legacy nodes (section 8.4); verify the correctness of the six new nodes separately | Switch the flag back to legacy — a one-step rollback |
| **④ Switch the default** | After several canary rounds with zero regressions, change the default of `WORKFLOW_DAG_ENGINE` to `runtime-lib`. The old engine remains (as a fallback, following the GenBI fallback paradigm) | Change the default back to legacy |
| **⑤ Strangle** | Once the deletion trigger conditions (section 8.5) are met, **the next version** deletes the old function in `dag-generator.ts` and the bare exec is closed along with it; only the new engine remains | Reversible at any point before that version; after the deletion, rollback requires reverting the commit |

### 8.3 Engine capability gate (the two engines are not equivalent; prevents silently dropped nodes)
- **Essence**: old = the three legacy nodes `sync/sql/python`; new = the three legacy nodes + six new ones (branch/empty/join/foreach/setvar/external) = **a superset**. This is not the GenBI kind of "two functionally equivalent implementations" but "old subset, new superset".
- 🔴 **A mandatory gate**: if a workflow contains a new node type and flag=legacy → **pre-publish validation rejects it** with the message "this node type requires the runtime-lib engine". Otherwise the old engine does not recognize branch/foreach and would **silently drop the node or fail**.
- **Implementation point**: the pre-publish validation of the publish route = read the registry to determine whether the workflow contains a node type "supported only by the new engine", and cross-check it against the current flag.

### 8.4 The exact definition of canary "equivalence" (otherwise "canary verification" is an empty phrase)
- **A text diff is impossible**: the DAG text produced by the two engines has completely different structures (old = concatenation, new = JSON + shell); they are not comparable at the text level.
- **Equivalence is verified only at the run-result level**: the same legacy `sync`/`sql` workflow → each engine generates its DAG → each is published and run → assert **identical success state + identical `bgp-task-runs` write-back records** (node count / status / order).
- **The python node is not compared for equivalence**: the new engine uses restricted execution, the old engine bare exec; the behaviors differ by design (the new one is safer, section 5.4). python is verified separately, in the new engine only: "dangerous scripts rejected + normal transformations pass".
- **The six new nodes have no old counterpart to compare**: they are increments unique to the new engine; each is verified for its own correctness (branch routing / foreach expansion / join convergence …).
- > In one sentence: **the scope of the equivalence comparison = only the two node types sync/sql**; python is a one-way security improvement and the six new nodes are pure increments; neither enters the equivalence control group.

### 8.5 Two guardrails (honest about the risk of the parallel period)
- **Guardrail 1 — deletion trigger condition (the parallel period cannot be open-ended)**: the explicit prerequisite for ⑤ strangle = "after the new engine becomes the default, **N consecutive versions (recommended ≥3) with zero regressions** + all existing workflows have been re-published and migrated to the new engine". The shorter the parallel period, the smaller the risk window.
- **Guardrail 2 — known legacy risk register**: 🔵 the bare exec at `dag-generator.ts:169` is the platform's only RCE surface (confirmed by the scan of section 5.4); during the parallel period (default still legacy, the old engine still handling existing python nodes) it stays open and **is closed at deletion (step ⑤)**. This is the **known price** of "not touching the old engine", registered here rather than swept under the rug; mitigation = guardrail 1 shortens the window + new workflows are steered to the new engine.

### 8.6 Quality gates (every step must be fully green before the next)
- `contract-guard snapshot` (before the change, step ①) → tsc/build/unit tests (steps ②③, pure code) → deploy to a test account (**requires authorization**) → headless-browser acceptance asserting the DOM (build workflows containing each new node, publish, run to the success state + the equivalence verification of section 8.4) → `contract-guard verify` with zero FAIL (the `lineage_column` anchor does not regress) → sign-off → push.
- **Backlog batches (later)**: HTTP node (including CDK requirements); unification of the 4 entry points.

---

## 9. Decisions (2026-08-02, final)

1. ✅ **Runtime library boundary**: serve workflow only in this phase; absorb the 4 entry points after verification (reduces the blast radius).
2. ✅ **The first batch is exactly these 6 nodes** (branch/empty/join/foreach/setvar/external).
3. ✅ **Migration strategy = Strangler with two engines in parallel** (section 8): the old generator is frozen → `generateAirflowDagV2` + the `WORKFLOW_DAG_ENGINE` flag are added alongside → several canary rounds with zero regressions → **the next version deletes the old engine and keeps only the new one**. Default flag=legacy; reversible throughout.
4. ✅ **The `exec` root fix only in the new engine** (section 5.4): the platform-wide RCE surface is exactly the 1 place `dag-generator.ts:169`; the old engine's bare exec is frozen with the engine and closed when the old engine is deleted (a control group must be frozen solid to have value as a control).
5. ✅ **Canary equivalence compares only sync/sql** (section 8.4): python is a one-way security improvement and the six new nodes are pure increments; neither enters the equivalence control group.
6. ⏸️ **default-user is split into a separate multi-tenant initiative** (5848 places platform-wide, beyond the scope of rich nodes).

---

# In-Depth Design (sections 10–14, implementation-level precision, added 2026-08-02)

## 10. The Exact Shape of the Runtime Library

### 10.1 The generated DAG (one per workflow; minimal, no business logic)
```python
"""Auto-generated by BigData Governance Platform. DO NOT EDIT."""
from bgp_workflow_runtime_v1 import build_dag   # 固定库,版本化文件名(§10.3)
DAG_SPEC = {
    "dag_id": "bgp_<workflowId>",
    "workflow_id": "<workflowId>",
    "schedule": "<cron 或 None>",
    "region": "<AWS_REGION>",
    "redshift_secret_arn": "<arn 或 null>",
    "nodes": [
        {"id": "n1", "task_id": "n1", "type": "sync",    "data": {"syncTaskId": "..."}, "retries": 2, "timeout": 3600},
        {"id": "n2", "task_id": "n2", "type": "branch",  "data": {"branches": [...], "default": "n4"}},
        {"id": "n3", "task_id": "n3", "type": "foreach", "data": {"items": [...], "sub": {...}}},
        ...
    ],
    "edges": [{"source": "n1", "target": "n2", "branch": null}, ...],
}
dag = build_dag(DAG_SPEC)
```
- 🔴 **Strangler boundary (this is an "addition", not a "change to the old")**: this is **the `generateAirflowDagV2()` of the newly added `lib/workflow/dag-generator-v2.ts`**, whose responsibility = "serialize one JSON spec + a 3-line fixed shell". **The old `generateAirflowDag()` in `dag-generator.ts` is not changed by a single line; it is frozen pending deletion** (section 8.1). The two coexist, and the publish route selects one by the `WORKFLOW_DAG_ENGINE` flag. **This is absolutely not a rewrite of the old function into this shape.**
- **Injection surface reduced to zero (new engine only)**: all business data (sql/script/syncTaskId) enters `data` as **JSON values** and **never enters the code text**; the JSON is produced by `JSON.stringify`, and on the Python side `DAG_SPEC = <json>` is a legal literal, so any user input sits inside a quoted JSON string and cannot escape into code (the core benefit of section 2.1). The old engine's concatenation / escaping stays frozen as is and is unaffected.

### 10.2 Structure of the fixed library `bgp_workflow_runtime_v{N}.py`
```python
# 一份,所有 workflow DAG 共享。含全部执行器 + 构图逻辑 + callback。
NODE_EXECUTORS = {
    "sync":    _exec_sync,        # 复刻现有 trigger_sync_task(Glue start+poll)
    "sql":     _exec_sql,         # 复刻现有 execute_redshift_sql(Data API+poll)
    "python":  _exec_python_safe, # ★ 根治版:受限执行器(§12),非裸 exec
    "setvar":  _exec_setvar,      # XCom push
    # branch/empty/join/foreach/external 不是 callable,而是 build_dag 里造对应 operator
}
def build_dag(spec):
    with DAG(dag_id=spec["dag_id"], schedule_interval=..., catchup=False,
             on_failure_callback=_on_failure) as dag:
        tasks = {}
        for n in spec["nodes"]:
            tasks[n["id"]] = _make_operator(n, spec)   # 按 type 造 operator(§11)
        _wire_edges(spec, tasks)                        # 依赖 + 分支路由(§11.1)
        _attach_status_callback(spec, tasks)            # 复刻 leaf >> _status_done
    return dag
def _on_failure(context): ...      # 复刻现有回写 bgp-workflows/bgp-task-runs
def _on_success(**kwargs): ...     # 同上
```
- **The callback / task-runs write-back contract is replicated verbatim** from the existing dag-generator's `_update_workflow_status`/`_update_run_record` (the monitoring contract of section 1.4 is not broken).

### 10.3 Library versioning + `.airflowignore` (response to two official constraints that were independently verified)
- **D2 versioning**: the library file name carries a version, `bgp_workflow_runtime_v1.py`. Changing the library = publishing `_v2.py`; new DAGs import v2, old DAGs still import v1 (the file is kept) → **avoids the Python module cache window + zero impact on existing DAGs**. The version number is a platform constant; at publish time the generator writes the matching import.
- **D1 `.airflowignore`**: on the first publish, idempotently put `dags/.airflowignore` with the content `bgp_workflow_runtime.*\.py` (a wildcard over all versions) → the scheduler does not parse the library as a DAG (a hard official requirement).
- **Delivery timing**: on workflow publish, first ensure that `dags/bgp_workflow_runtime_v{N}.py` and `dags/.airflowignore` exist (idempotent put, skipped if already present), then put the DAG file. Everything goes through the existing S3 put channel (`publish/route.ts`), zero CDK.

## 11. The 6 Nodes One by One: Metadata Schema + Airflow Translation (implementation level)

### 11.1 Key premise: edges need a "branch affiliation" (a constraint found during evidence gathering)
- Existing edges are bare `{source,target}`; branch needs to know "which branch condition this outgoing edge belongs to".
- **Design decision (pitfall avoidance)**: extend the edge with an **optional** `branch` field, `{source,target,branch?:string}`. **Edges from non-branch sources have `branch=undefined`** (all existing edges need zero change; backward compatible). The outgoing edges of a branch node carry `branch:"<condIdx or default>"`.
- **Persistence dirty-check fix**: the edge projection in `normalizeDag` is widened from `{s,t}` to `{s,t,b:x.data?.branch}` (otherwise changing a branch affiliation does not trigger "unsaved" — prevention of a real bug found during evidence gathering). This is a **mandatory change point** within the A2 blast radius and has been registered.

### 11.2 Node-by-node table
| Node | data schema | Airflow translation (in the runtime library) | Dependency / edge handling |
|---|---|---|---|
| **empty** | `{label?}` | `EmptyOperator(task_id)` | regular edges |
| **join** | `{label?, rule?: "all_success"\|"none_failed"\|"none_failed_min_one_success"}` | `EmptyOperator(task_id, trigger_rule=rule\|"all_success")` | convergence of multiple incoming edges |
| **setvar** | `{label?, vars: {key:value}}` | `PythonOperator` push: `for k,v in vars: ti.xcom_push(k,v)` | regular; downstream uses `{{ ti.xcom_pull(...) }}` |
| **sql** (existing) | `{sql, engine, database}` | `_exec_sql` (values passed from the data JSON, not concatenated) | regular |
| **sync** (existing) | `{syncTaskId}` | `_exec_sync` | regular |
| **python** (existing) | `{script}` | `_exec_python_safe` (root fix of section 12) | regular |
| **external** | `{label?, externalDagId, externalTaskId?, executionDelta?: seconds}` | `ExternalTaskSensor(external_dag_id=..., execution_delta=timedelta(seconds=...), mode="reschedule")` | regular; acts as an upstream gate |
| **branch** ★ | `{label?, branches:[{cond:"<restricted DSL>", target:"<nodeId>"}], default:"<nodeId>"}` | `BranchPythonOperator`: the callable evaluates each cond (the same restricted evaluation as section 12) and returns the task_id of the matching target; returns default when none matches | outgoing edges carry `branch`; **the downstream of unselected branches needs `trigger_rule` handling** (see below) |
| **foreach** ★ | `{label?, items: string[]\|"<xcom_key>", sub:{type,data}}` | Dynamic Task Mapping: `_make_sub_operator.partial(...).expand(item=items)` | items is a static list or comes from upstream XCom; sub is a single-node template |

### 11.3 Two Airflow pitfalls of branch (in depth)
1. **Skip propagation**: the unselected branches of a `BranchPythonOperator` and their downstream are skipped. If several branches of a branch node eventually converge on the same downstream (a join), that join must have `trigger_rule="none_failed_min_one_success"`, otherwise it is skipped along with its skipped upstream. → **If the downstream of a branch is a join, that trigger_rule is set automatically**; the runtime library detects the branch→join topology in `_wire_edges` and injects it.
2. **Safety of cond evaluation**: `cond` is a user-entered condition expression and is **never `eval`ed**. It uses the restricted evaluator of section 12 (only comparisons / booleans / field references are allowed, for example `${upstream.rows} > 0`).

### 11.4 Boundaries of foreach (stated honestly)
- **Source of items**: a static list (filled in at design time) or an upstream XCom key (determined at run time). **Displaying the status of run-time dynamically mapped sub-tasks** in the UI = **phase two** (the existing per-node status rendering works on static task instances; dynamically mapped tasks need adaptation). In this phase foreach **supports static items first**; dynamic XCom is listed as an enhancement.
- sub supports a **single-node template** only (sql/python/empty); nested foreach/branch is not supported (avoids an explosion of DAG construction complexity).

## 12. The Exact `exec` Root-Fix Approach (the core security deliverable of this phase)

### 12.1 Threat model
- Today `exec(script)` runs without constraint on an MWAA worker (which has an IAM role, sits inside the VPC network, and can reach Glue/Redshift/S3) → a user script can `import os; os.system(...)`, read secrets, issue arbitrary AWS calls = **an RCE + privilege-escalation surface**.

### 12.2 Root fix: the restricted executor `_exec_python_safe`
```python
SAFE_BUILTINS = {  # 白名单,只给纯计算
    "len","range","min","max","sum","abs","round","sorted","enumerate","zip",
    "int","float","str","bool","list","dict","set","tuple","map","filter","print",
}
FORBIDDEN = ("import","__","eval","exec","open","compile","globals","locals","getattr","setattr")
def _exec_python_safe(script, ctx, **kwargs):
    # 1) 词法预扫:命中 FORBIDDEN 整词 → 直接拒(不执行)
    _scan_forbidden(script)
    # 2) 受限命名空间执行:无 __builtins__ 全量,只给 SAFE_BUILTINS + 平台注入的只读数据 API
    safe_globals = {"__builtins__": {k: getattr(builtins,k) for k in SAFE_BUILTINS},
                    "params": ctx.get("params",{}),      # 运行参数(只读)
                    "xcom": _readonly_xcom_view(ctx)}     # 上游输出(只读)
    exec(compile(script,"<node>","exec"), safe_globals, {})   # 受限 globals
```
- **Two lines of defense**: ① a lexical pre-scan against a deny-list of whole words (`import`/`__`/`open`/...) → static rejection; ② restricted `__builtins__` (stripped of `__import__`/`open`/`eval`) → even if the scan is bypassed, no dangerous capability remains.
- **Narrowed positioning**: the python node narrows from "arbitrary script" to "**pure data transformation / computation**" (compute a value from params/xcom). For complex logic the UI steers to the sql node. The documentation states this capability boundary explicitly.
- **Shared with the branch cond / DSL**: `_scan_forbidden` + restricted evaluation, one security baseline.
- ⚠️ Honest note: a restricted `exec` is not a perfect sandbox (Python sandbox escapes have a history of CPython tricks), but **compared with today's bare exec it narrows the surface by orders of magnitude**; truly strong isolation (a separate container / gVisor) belongs to the separate security initiative of section 6; this phase closes "casual RCE", the biggest surface.

## 13. Table-Driven Registry Structure (eliminating the 5 scattered places of section 1.1)

`lib/workflow/node-registry.ts` (new; single source of truth):
```ts
export interface NodeTypeDef {
  type: WorkflowNodeType;                    // "sync"|"sql"|...|"external"
  label: string;                             // 拖拽面板/i18n key
  icon: string;                              // 渲染组件用
  validate: (data: any) => string | null;    // 发布前校验(替 page.tsx:279-281 散落 if)
  runtimeExecutor: string | null;            // runtime 库里的执行器名(operator 类节点为 null)
  supportsBackfill: boolean;                  // 补数白名单(替 execute.ts:64)
  minEngine: "legacy" | "runtime-lib";        // ★ 引擎能力门(§8.3):新六节点标 "runtime-lib"
}
export const NODE_REGISTRY: Record<WorkflowNodeType, NodeTypeDef> = { ... };
```
- 🔴 **Under Strangler, the registry converges only the 4 places of the shared layer and does not touch the frozen old-engine place** (a key split found during evidence gathering):
  of the 5 scattered places of section 1.1 — ② `nodeTemplates` (page.tsx), ③ validation (page.tsx), ⑤ the backfill allow-list, and ④ the `nodeTypes` map (DagEditor) are the **UI / validation layer shared by both engines**, and **these 4 are changed to read the registry** (changed once, shared by both engines);
  whereas **① the translation in `dag-generator.ts:23/31/40` is engine-specific**: the old engine's place = **frozen, recognizes only the three legacy nodes, does not read the registry** (dead code pending deletion, section 8.1); the new engine's `generateAirflowDagV2` reads `runtimeExecutor` from the registry and recognizes all nine types.
  > So the accurate statement is not "5→1" but: **the 4 places of the shared layer converge into the registry; of the engine-specific translation logic, the old is frozen and the new reads the registry, and when the old engine is deleted the old place disappears with it.** This is consistent with the Strangler rule "don't fertilize the old vine".
- **Engine capability gate implementation**: pre-publish validation reads `NODE_REGISTRY[type].minEngine`; if the workflow contains a node with `minEngine="runtime-lib"` while the current flag=legacy → reject (section 8.3).
- **A4 type-level blocking**: the `WorkflowNodeType` union + the `WorkflowNode` discriminated union (section 4); the registry's `Record<WorkflowNodeType,...>` forces every type to be registered (missing one is a tsc error).

## 14. Implementation Order (phased; each phase verifiable with tsc/build, no deployment)

| Phase | Deliverable | Mapped Strangler step (section 8.2) | Verification (no AWS) |
|---|---|---|---|
| **0** | Freeze the old `dag-generator.ts` (annotated as no longer changed); `contract-guard snapshot` + a headless-browser baseline of workflow publish/run = golden master | ① Freeze | snapshot |
| **1** | Type system (WorkflowNode union) + node-registry.ts (with the `minEngine` field) + edge extended with the branch field + normalizeDag fix + **the 4 shared-layer places changed to read the registry** (UI / validation / backfill; the old engine's translation place untouched) | ② Parallel (shared layer) | tsc |
| **2** | Runtime library `bgp_workflow_runtime_v1.py` (pure Python, with the operators of the 6 nodes + the exec root fix + replicated callbacks) + unit tests (restricted executor rejects dangerous scripts / branch evaluation / foreach expansion) | ② Parallel (runtime) | python unit tests |
| **3** | **Add** `generateAirflowDagV2` in `dag-generator-v2.ts` ("serialize the spec + 3-line shell", **the old function not changed by a single line**) + the `WORKFLOW_DAG_ENGINE` flag + engine capability gate validation + delivery of the library / `.airflowignore` (the publish route selects by flag) + generator unit tests (spec JSON structure, zero injection surface, capability gate rejects new nodes) | ② Parallel (new engine) | tsc + unit tests |
| **4** | UI for the 6 nodes (render components + NodeConfigPanel branches + reading the registry) + multi-outlet Handle for branch | ② Parallel (UI) | build |
| **5** | ★ **Deploy to a test account (requires authorization)** → headless-browser acceptance: ① **two-engine equivalence verification** of workflows with the three legacy nodes (section 8.4, sync/sql only) ② correctness of each of the six new nodes ③ dangerous python scripts rejected → `contract-guard verify` with zero FAIL → sign-off → push | ③ Canary | headless + verify |
| **6+** | (later versions) switch the flag default to runtime-lib → once the deletion trigger conditions are met (section 8.5) → **delete the old engine + close the bare exec** | ④ switch default · ⑤ strangle | headless + verify |

> Phases 0–4 are pure code and are done consecutively (default flag=legacy, **zero change to default behavior**); phase 5 stops to obtain authorization for the deployment; phase 6+ are the default switch and the strangling in later versions, each passing through the quality gates independently.

---

# §15 Abstract Design: The Invariant System of Generated Artifacts (production deep dive of 2026-08-05, global-grade hardening)

> **Motivation**: runtime-lib turns the DAG from "self-contained" into "minimal shell + external library + spec-driven", introducing **a whole class** of new failure modes: "can the generated artifact be correctly loaded / executed by MWAA". The first round patched them one by one (D1 airflowignore / D2 versioning / D3 safe_mode), and **the verification used simplified data (nodeId="j") that masked a real bug**. This section converges them into **systematic invariants + self-validation at generation time**, so that we no longer "discover the next pitfall only after publishing to MWAA".

## 15.1 Two root causes (🟢 confirmed by a production test on the MWAA of a fresh account)

| # | Root cause | Symptom | Why unit tests cannot catch it | Fix |
|---|---|---|---|---|
| 1 | **safe_mode keyword scan** | The DAG content does not contain the word `airflow` → DagFileProcessor skips it silently (not loaded / no error) | safe_mode is MWAA run-time behavior; there is no Airflow at the tsc/vitest stage | The first-line comment of the DAG contains `airflow` (D3, section 10.3) + a safe_mode contract unit test |
| 2 | **Identifiers not normalized** | The branch callable returns the raw nodeId (`join-1738`), while the operator task_id is the sanitized one (`join_1738`) → invalid task_id at run time | The tests used nodeId=`j` (unchanged by sanitize), which happened to mask it; a real UI nodeId contains hyphens and is guaranteed to blow up | The identifier-normalization principle of section 15.2 ✅ **fixed + confirmed by a real MWAA run** (2026-08-05: a branch workflow with hyphenated nodeIds `branch-node-200`→`join-node-300` ran to success; after normalization target=`join_node_300`) |

> **Meta-lesson**: both root causes were "all green in pure code + all green with simplified-data verification", yet guaranteed to blow up under **real data + real MWAA**. ⇒ See the verification discipline of section 15.4.

## 15.2 Core abstraction: the identifier-normalization principle (single source of truth, change-safety A1)

**Essence of the problem**: the spec contains **two sets of identifiers** at once — the raw `nodeId` (generated by the UI, containing hyphens / dots) and `task_id` (sanitized, legal for Airflow). Which one the runtime side "uses" relied entirely on humans remembering to sanitize, so missing one place blows up (root cause 2). Edge wiring happened to be right (the dict keys use the raw id); the branch return value was wrong.

**Root-fix principle**:
> **Only one kind of identifier should exist on the runtime side = the legal task_id. Before the spec reaches the runtime, every "internal node reference" has already been normalized on the TS side (by the single sanitization authority `sanitize()`). The concept of a "raw nodeId" no longer appears on the runtime side, so it cannot be used wrongly.**

**The complete set of fields that must be normalized** (full sweep of 2026-08-05, to prevent another miss):
| Field | Location | Handling |
|---|---|---|
| `edge.source` / `edge.target` | spec.edges | → sanitize |
| `branch.data.branches[].target` | node data | → sanitize |
| `branch.data.default` | node data | → sanitize |
| `node.task_id` | spec.nodes | already sanitized (the only correct part of the status quo) |
| ⚠️ `external.data.externalDagId` / `externalTaskId` | node data | **never sanitize** — it references the real id of **another DAG**; normalizing it would point to the wrong one |

> **Key distinction**: an "internal node reference" (pointing to a node of this workflow) must be normalized; an "external resource reference" (externalDagId pointing to another DAG) is a real external id, and touching it makes it point to the wrong place. If this distinction is missed, external nodes fail across the board.

**Implementation**:
- On the TS side, `buildDagSpec` gains a "reference normalization" pass: for each node, by type, its "internal reference fields" go through `sanitize()`; the source/target of the edges go through `sanitize()`. **Once the spec is produced, it contains no raw nodeId.**
- On the runtime side, `_branch` returns `data.branches[].target` directly (already a task_id at this point); the lucky `handle_map` fallback is removed.
- **Invariant assertion**: at the end of `build_dag`, the runtime checks that `every candidate target returned by a branch ⊆ dag.task_ids`, otherwise it fails fast (see section 15.3).

## 15.3 Self-validation at generation time: fail loud, not silent

**Problem**: the most toxic aspect of the two root causes is **silence** — MWAA neither loads nor reports, and the diagnosis took hours (it needed a self-diagnostic DAG to pin down). The abstract solution: **turn "silent failure" into "loud failure at generation / load time"**.

Three checks (from earliest to latest):
1. **At TS generation time (earliest)**: after `buildDagSpec`, run `assertSpecValid(spec)` — checking: ① every `branches[].target`/`default`/`edge.target` exists in the set of `nodes[].task_id`; ② task_ids have no collisions, are non-empty, ≤250 characters, and match `^[A-Za-z0-9_]+$`; ③ foreach has a sub and branch has branches. On violation → the publish API returns 400 directly with an explicit reason and **does not put anything to S3 at all**.
2. **At DAG load time (after safe_mode)**: inside the generated DAG shell, `build_dag` runs the same assertions on the spec; an exception lands in MWAA `import-errors` (visible) instead of being silent.
3. **Contract unit tests (cheapest)**: one vitest case per invariant, using **realistic-style nodeIds (with hyphens)** instead of the simplified `j`.

> Design philosophy (change-safety A4, make illegal states unrepresentable + fail fast): an illegal spec **is stopped at the earliest checkpoint (the TS publish API)**; the closer to MWAA, the harder it is to diagnose.

## 15.4 Verification discipline: real data + real runtime (lessons learned the hard way this time)

- 🔴 **Test data must "look real"**: use nodeIds in the `branch-<ts>` style (with hyphens), not `j`. Simplified data masks sanitize / collision bugs (that is exactly how root cause 2 was masked).
- 🔴 **All green in pure code ≠ production-ready**: safe_mode, closure serialization, Dynamic Task Mapping and the like are **Airflow run-time behaviors** that tsc/vitest cannot test. A runtime-lib class of change **must be really deployed to MWAA + really triggered to success + task instance states inspected** before it counts as done (not merely publish 200).
- **The self-diagnostic DAG is a powerful tool**: when diagnosing "a DAG silently fails to load", build a self-contained diagnostic DAG (importing no external library → guaranteed to be loaded) and have it print sys.path / os.listdir / import results / a trial run of build_dag — one shot gets the truth. Pinning down both root causes this time relied entirely on it.

## 15.5 Exhaustive test conclusions for problems of the same class (2026-08-05, self-diagnostic DAG tested item by item on MWAA)

> Method: build an all-in-one self-diagnostic DAG and run all kinds of extreme specs against the runtime library inside the MWAA worker, obtaining real behavior (not inference).

| Item | Measured result | Verdict | Handling |
|---|---|---|---|
| **Late binding of closures** (`def` inside the loops of _branch/_setvar/_foreach) | The current node data is already bound via the default argument `_x=x` | ✅ already hardened | runtime-lib already changed |
| **Dynamic Task Mapping** (foreach with static items + sql sub) | `build OK, task=MappedOperator` | ✅ really constructed successfully | no change needed |
| **Callback serializability** (on_success/on_failure closures capture an env that includes boto3) | `pickle.dumps` fails, **but** after the root-cause-2 workflow really ran, `bgp-task-runs=succeeded` + `bgp-workflows.lastRunStatus=succeeded` | ✅ **false alarm**: Airflow stores DAGs as SerializedDAG (JSON, by reference), not pickle; callbacks execute inside the worker process; the write-back was measured as normal | no change needed (recorded to prevent misjudgment) |
| **build_dag raises** (unknown node type) | `EXC: Unknown node type` | ✅ correctly fails loud (the exception lands in MWAA import-errors, visible, not silent) | no change needed |
| **foreach without sub** | `build OK (sub defaulted to empty)` | 🟡 silent default; should fail loud | section 15.3 added a "foreach must have a sub" check to assertSpecValid on the TS side (the registry validate already includes it) |
| **Empty workflow (no nodes)** | `build OK, tasks=1` (only _status_done) | ✅ robust, does not crash | no change needed |
| **task_id collisions / edge cases** (empty / symbols only / overlong / leading digit) | buildIdMap de-duplication + sanitizeBase fallback + assertSpecValid assertion | ✅ already hardened | dag-generator-v2 already changed |

**Conclusion**: apart from the two real bugs (both root-fixed + confirmed on MWAA), the exhaustive tests **found no other production problem that is guaranteed to fail**. The invariants of the runtime-lib architecture have been systematically converged (normalization in section 15.2 + self-validation in section 15.3 + closure / edge-case hardening) and can support global production.

> **Meta-method takeaway**: the "self-diagnostic DAG" (self-contained → guaranteed to be loaded → measures the library's behavior inside the worker) is a powerful tool for diagnosing MWAA run-time problems, an order of magnitude faster than reading scheduler logs or reasoning. Locating both root causes and testing the 4 classes of related problems this time relied entirely on it.
