# Resource Versioning and Rollback + Completing RBAC for Action Sub-Routes (Priority 0, Pillar 2)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is described in the [module overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> Revision: 1.5.0 | Date: 2026-06-14 | Status: implemented and verified online
> Addresses the engineering item of the gap-analysis re-check (group B): "no **versioning and rollback** of jobs/workflows". This module also closes the gap left by [multi-tenancy RBAC](./multitenancy-rbac.md): **resource action sub-routes were not guarded**.

---

## 0. Goals

1. **Versioning and rollback**: every create/save of a configuration-type resource (workflow / ETL job / sync task / Redshift task) automatically leaves a **configuration snapshot**; any historical version can be viewed and **rolled back** to with one click (the rollback itself can be undone as well).
2. **Completing RBAC for action sub-routes**: multi-tenancy RBAC guarded only the CRUD of resources; the **action sub-routes** for start/stop, publish, trigger, run, schedule and so on were not yet guarded. This module adds the guards (write actions = editor, read actions = viewer) so that resource-level RBAC is complete.

---

## 1. Versioning Design

### 1.1 Data model

New table `bgp-resource-versions`:

| pk | sk | Key attributes |
|----|----|---------|
| `<type>#<resourceId>` (e.g. `workflow#01...`) | `version` (zero-padded to 6 digits, e.g. `000002`) | `versionNum` (integer) / `type` / `resourceId` / `projectId` / `name` / `config` (snapshot) / `versionedAt` / `versionedBy` / `note` |

`Query(pk)` + `ScanIndexForward=false` lists the history in descending version order; `Get(pk, sk)` fetches a single version.

### 1.2 Resource type mapping (`lib/versions/version-service.ts`)

| type | Table | sort key | Label |
|------|----|---------|------|
| `workflow` | bgp-workflows | workflowId | Workflow |
| `etl-job` | bgp-etl-jobs | jobId | Job |
| `sync` | bgp-sync-tasks | taskId | Sync task |
| `redshift-task` | bgp-redshift-tasks | taskId | Redshift task |

> Data sources (datasource) are not included: they involve external provisioning (Glue connection / secret / security group), so the rollback semantics are complex and will be designed separately later.

### 1.3 Snapshot content

`config` = all business fields of the resource item after removing **its own sort key** and the **meta fields** (`userId`/`projectId`/`createdBy`/`createdBySub`/`createdAt`/`updatedAt`). A rollback overwrites only these business fields; tenant, ownership and creation time stay unchanged.

### 1.4 When a version is produced

- **Create** (POST of the 4 resource types) → v1, note = "created".
- **Every save** (after a successful `[id]` PUT of the 4 resource types) → incremented version, note = "saved".
- **Rollback**: first store the **current state** as a new version (note = "automatic snapshot before rollback", which makes the rollback undoable), then overwrite the current resource with the target version's `config`. (The note texts are stored as Chinese literals.)

Version number = the resource's current maximum `versionNum` + 1 (`Query` descending, take 1). The snapshot call sits in the write path as `await ... .catch(()=>{})`: numbering stays correct, and a save **never fails because the snapshot failed**.

### 1.5 API (`/api/versions`)

| Method | Description | Minimum role |
|------|------|---------|
| `GET ?type=&id=` | List the version history (metadata) | viewer |
| `GET ?type=&id=&version=N` | Fetch the complete snapshot of a version (with config) | viewer |
| `POST {type,id,version}` | Roll back to that version | editor |

Authorization: first `loadResource(type,id)` to obtain the resource (with `projectId`), then `guardResourceAccess(req, item, role)` (reusing multi-tenancy RBAC).

### 1.6 Front end

A generic component `components/common/VersionHistoryDrawer.tsx` (list / view JSON snapshot / roll back), wired into:
- the workflow editor page (`/workflow/[id]`): a "Version history" button in the toolbar; after a rollback `reloadKey` is incremented and the workflow is re-fetched.
- the Job Development page (`/etl-jobs`): "Version history" in the job detail toolbar; after a rollback the job is re-fetched and `selectJob` is called.

> Sync tasks / Redshift tasks are already supported on the back end; the front-end entry points will be added later (this does not affect API usage).

---

## 2. Completing RBAC for Action Sub-Routes

Multi-tenancy RBAC guarded CRUD; this module adds `guardResourceAccess` to the **action sub-routes** (load the resource → check the project role):

| Category | Routes | Minimum role |
|------|------|---------|
| Write | sync `start`/`stop`, workflow `publish`/`trigger`, etl-jobs `run`/`schedule` | **editor** |
| Read | sync `glue-status`/`logs`/`output`/`runs`/`runs/[runId]/logs`, workflow `runs/[runId]/status`/`nodes`/`nodes/[task]/logs`, etl-jobs `runs` | **viewer** |

For read actions that query `bgp-task-runs` (and do not load the resource directly), the route first `Get`s the resource to obtain `projectId` and then checks; when the resource does not exist it passes gracefully (keeping the original empty-response behavior).

---

## 3. Online Verification (temporary test account, us-east-1)

1. Versions: create a workflow → v1 "created"; rename and save → v2 "saved"; roll back to v1 → the name is restored, and the current state was stored as v3 "automatic snapshot before rollback" (which can be undone again).
2. Action RBAC: the non-member `rbac-tester` (not a member of the Default Workspace) gets **403** on `publish`/`trigger` of a Default Workspace workflow and on the `/api/versions` list and rollback; the platform administrator `admin` gets 200 on the list.

---

## 4. Known Limitations / Follow-ups

1. Versioning/rollback of data sources is not done (complex external-provisioning semantics).
2. Deleting a resource does not cascade-delete its version rows (orphan versions are harmless; a clean-up can be added later).
3. A version snapshot is the **full configuration** (not a diff); the front end displays it as JSON, and a field-level diff view can be added later.
4. **Pillar 3 (multi-environment / release process)**: will reuse this module's version snapshots (as release artifacts) + the approval flow of multi-tenancy RBAC (`type:"deploy"`); see the later design document.
