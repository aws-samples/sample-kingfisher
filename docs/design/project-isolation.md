# Project Isolation

> Project spaces, per-project warehouse identities in every region, ownership guards, and promotion between environments.
> Related designs: [Multi-region execution](./multi-region-execution.md) and [Model configuration](./model-configuration.md).

---

## 1. Summary

A **project space** is the unit of ownership in Kingfisher. Data sources, sync tasks, jobs, workflows, queries,
dashboards and their run records belong to exactly one project. Members see and act only on their project's resources;
every API route checks membership and role before touching a resource.

Isolation reaches the data plane. In every execution region each project gets its own warehouse schema, database role, login user and secret.

Platform-wide reference data (code tables, conformed dimensions) lives in a `shared` schema that every project can read and no project can write. The
platform never grants anything to `PUBLIC`.

Promotion of a definition between environments (dev, staging, prod) inside one project is implemented.
Copying definitions between projects and sharing a resource read-only with other projects are designed and specified
but not yet shipped; their contracts are described here with that status.

---

## 2. Goals and non-goals

### 2.1 Goals

1. Every resource has an owner project; non-members get 403 with a reason and a next step.
2. Project creation and configuration are restricted to platform administrators and research managers.
3. Run records, SQL history and query results are visible only inside their project.
4. A user who knows SQL cannot read another project's tables, because the warehouse identity itself is per project.
5. Reference data shared by all projects is readable everywhere and writable only by the platform.
6. Deleting a project leaves no orphaned credentials in any region.

### 2.2 Non-goals

- Row-level security inside a shared table.
- Project-level isolation of modelling standards, metrics definitions and the governance catalog; these stay global by design.
- Copying run history or version history between projects.
- Separate Airflow environments per project.

---

## 3. Concepts

| Term | Meaning |
|---|---|
| Project space | `projectId` of the form `proj-<ULID>`; `proj-default` is the legacy workspace that holds pre-existing resources |
| Project role | `owner`, `editor`, `viewer`; `owner` includes `editor`, `editor` includes `viewer` |
| Platform group | Cognito groups such as `bgp-admin` and `bgp-manager`; platform admins bypass project membership |
| Environment | `dev`, `staging`, `prod` inside a project; `prod` is protected and requires approval to promote into |
| Execution target | one region's data plane, `targetId`; data-plane objects of a project exist once per target |
| Active project and environment | request headers `x-bgp-project` and `x-bgp-env` |
| Query handle | a server-issued token bound to the submitting user, project and target, required to fetch query results |

---

## 4. What is isolated and what is shared

| Area | Isolation | Mechanism |
|---|---|---|
| Data sources, sync tasks, offline jobs, engine jobs, Flink jobs, workflows, warehouse tasks | per project and environment | `projectId` + `env` stamps, list filters, by-id guard |
| BI reports, dashboards, query context, skills | per project | partition key contains `projectId` |
| Alerts, SLA, backfill plans, incidents, Copilot plans | per project | `projectId` attribute or key |
| Run records | per project and target | `projectId` and `targetId` stamped at every write point |
| SQL history and query results | per project | `projectId` on history rows; query handles on results |
| Warehouse tables | per project and target | `proj_<id>` schema, `role_proj_<id>`, `user_proj_<id>` |
| Lake namespaces | per project and target | `proj_<id>` namespace |
| Modelling (layers, domains, standards, code tables, dimensions, metrics) | global | enterprise vocabulary; admin writes, members read |
| Governance catalog, lineage, classification, quality rules | global read | project filter as a view, not a boundary |
| Reference data tables | global read-only | `shared` schema, readable by every project role |
| Audit | platform level | `projectId` attribute for filtering |
| Execution environments and model configuration | platform level | project allow-list per target |

---

## 5. Control-plane isolation

### 5.1 Ownership stamps and filters

Every resource row carries `projectId` and, where environments apply, `env`.
List routes add a filter clause built by `projectFilter(projectId)`; for the default workspace the clause also admits
rows without a `projectId`, so legacy resources stay visible. `envFilter(env)` behaves the same for `dev`.

### 5.2 Resource guards

| Guard | Behaviour |
|---|---|
| `requireProject(req, minRole)` | 401 without identity; 403 for non-members; 403 below the minimum role; otherwise returns identity, project and role |
| `guardResourceAccess(req, item, minRole)` | resolves the owner project from the item (default workspace when absent) and applies `requireProject` |
| Configuration guard | platform admin, or `bgp-manager` who is also the project owner; same function drives button visibility |

All routes with side effects (execute SQL, execute DDL, enable schedules, cancel statements, test or heartbeat a source,
read logs, browse schemas) apply a guard, and the high-risk ones also write an audit record.
Obtaining a classic Airflow web token is restricted to platform administrators because the environment is shared.

### 5.3 Project configuration permissions

- Creating a project: platform admin or research manager.
- Renaming, deleting, managing members and deciding membership approvals: platform admin or manager-owner.
- A developer who owns a project keeps development rights but loses configuration rights; the page explains this as division of duties and disables the entries with a tooltip.

### 5.4 Run ledger

All write points of `bgp-task-runs`, including those executed by the scheduler runtime, stamp `{ projectId, targetId }`.
Read routes filter by project with the legacy clause so pre-existing runs stay visible in the default workspace.
Platform aggregations (cost, baselines, alerting) read across projects on purpose.

### 5.5 Query handles

Submitting a warehouse statement issues a **query handle** stored in `bgp-query-handles`, bound to the submitting user, project, target and an expiry.
Fetching results requires the handle. A handle of another project is refused with 403; an expired handle with 410.

Members of the same project may fetch each other's results. Server-side consumers (metrics, quality, sensitive scans) also obtain handles for the
ownership ledger but do not expose them.

---

## 6. Data-plane isolation per project and per region

### 6.1 Layers

| Layer | Content |
|---|---|
| Revoke the back door | the platform never issues `GRANT ... TO PUBLIC`; the DDL lint rejects it; generated scripts and templates grant to the project role instead |
| Per-project schema | data lands in `proj_<id>`, not in `public`; the schema is owned by the project login user |
| Per-project identity | one database role and one login user per project, with a secret in the target's Secrets Manager |

Schema-level isolation alone is not isolation while queries run as the shared administrator.
The protective layer is the per-project identity: queries in project context run as `user_proj_<id>`.

### 6.2 Naming

Names have one author, `platform/src/lib/exec-env/project-schema.ts`.

| Object | Name |
|---|---|
| Project schema | `proj_<sanitised projectId>`; `proj-default` maps to `proj_default` |
| Project role | `role_proj_<sanitised projectId>` |
| Project login user | `user_proj_<sanitised projectId>` |
| Project secret | `bgp/project/<targetSlug>/<projectId>` in the target's region |
| Lake namespace | `proj_<sanitised projectId>` |
| Reference schema | `shared` |

Sanitising lowercases the id and replaces other characters with `_`. Names longer than the warehouse limit are truncated
and suffixed with a short hash. Project ids are platform-generated ULIDs, so the mapping is lossless.

### 6.3 Credential supply and the closed DDL executor

Per-project identities are created by a **supply job** per target, run as a durable data-plane job so that a cross-region
failure can be retried and is visible on the execution environment page.

1. Create the `shared` schema if absent.
2. Create the project role.
3. Create the login user and write its secret; the password never leaves the function that creates it.
4. Create the project schema owned by the login user.
5. Grant the role to the login user.
6. Grant schema usage and selects, including read access to `shared`.

All administrative DDL runs through one **closed executor**. Callers pass a structured request, never SQL.

The executor validates the request, cross-checks target and project, verifies the target's readiness and credential epoch, applies role and approval
rules, generates SQL from private templates, writes an intent audit record (failure refuses the operation), reads the target's administrator secret
inside the function, executes in the target's workgroup and writes a result audit record. The executor returns no secret and no password.

Supported operations: `create-project-schema`, `create-shared-schema`, `create-role`, `grant`, `grant-role-to-login`,
`drop-project-schema` (requires an approval id), `dms-ingest-bootstrap`, `land-code-table`, `grant-shared-writer`.

### 6.4 Credential isolation state machine

Each target carries an explicit, monotonic `credentialIsolationState`.

| State | Meaning |
|---|---|
| `legacy-seeded` | existing home target; shared administrator fallback allowed for existing traffic |
| `provisioning` | per-project supply in progress; fallback allowed only until a mandatory deadline (at most 30 days) |
| `isolated` | missing project credential is a hard failure; no administrator fallback under any error |

Transitions go only forward and only through `advanceCredentialIsolationState`, which checks the previous state and the epoch with a conditional write
and increments `credentialEpoch`. Credential caches are keyed by target, project, purpose and epoch, so a transition or a secret rotation invalidates
old entries.

A missing or unknown state is refused, never interpreted as legacy. Every fallback is reported with who, target, project, purpose, state and epoch.

The switch `PER_PROJECT_CRED=on` makes project-context queries use the per-project identity.
Its prerequisite is that project data has been moved out of `public`; that migration is designed but not yet shipped.

### 6.5 Credential purposes

| Purpose | Identity | Constraint |
|---|---|---|
| `project-context` | the project's own login | required `projectId`; fail-closed in `isolated` |
| `governance-read` | platform read-only service identity | returns verdicts, counts and aggregates, never detail rows; strong RBAC on triggering routes |
| `admin-ddl` | none returned | always the closed executor |

### 6.6 Shared reference schema

Code tables and conformed dimensions are the enterprise vocabulary. They are physically landed in `shared` in every target. Every project role
receives usage and select on `shared`, with default privileges so new tables are readable.

Writes to `shared` are possible only through the closed executor, or through a narrow `shared_writer` identity granted per target for code-table
landing. Business data never goes into `shared`.

### 6.7 Permission canary

After supply, a canary verifies the isolation from the project's own identity: it can read its schema and `shared`,
it cannot insert into `shared`, and it cannot read another project's schema.

---

## 7. Project-level access to execution targets

A target carries an `access` setting: all projects, or an explicit allow-list. The same function decides what the target pickers show and what the
binding path accepts, so what a member can see equals what a member can bind.

A direct API write for a non-allowed project is refused with `project-not-allowed`. Changing the allow-list is audited with before and after values.

---

## 8. Deleting a project

Deletion is a long operation with the following steps.

1. Inventory the project's resources and bindings; if any remain, return 400 with the list and a link to migrate or delete them.
2. Enqueue a credential reclaim job for every target; if enqueueing fails the deletion is refused.
3. Delete the control-plane rows (project, memberships).
4. Each reclaim job waits until the project is really gone, then deletes the project's secret in its region.

Dropping the project schema, role and user in a warehouse is destructive and is not automatic; it is the approval-gated
operation `drop-project-schema`. The default workspace cannot be deleted.

---

## 9. Promotion between environments and copy between projects

### 9.1 Promotion (implemented)

Within one project a logical resource exists once per environment and is tied across environments by a `lineageId`. Promotion copies the authored
definition (script, DAG, cron, mapping) and strips runtime bindings (Glue job name, Airflow DAG id, last run state, schedule flag, publication marks),
so the target environment recreates its own bindings on first publish.

Promotion into `prod` goes through the approval flow. Routes: `POST /api/promote`, `GET /api/promote/lineage`.

### 9.2 Copy between projects (designed, not shipped)

The design generalises promotion to a different project.

- Route: `POST /api/projects/copy-resource { type, id, toProjectId, toEnv?, conflict, includeDeps? }`.
- Types: workflow, offline job, sync task, warehouse task, engine job. Data sources are shared, never copied.
- Permissions: viewer or above in the source project and editor or above in the target project.
- The copy excludes runtime bindings plus `triggers`, `sharedTo`, `copiedFrom`, `promotedFrom`, and records `copiedFrom` for provenance; it does not share the `lineageId`.
- Conflict on same name: rename (default suffix `-copy`), overwrite (only if the existing resource was copied from the same source, and only after a successful version snapshot), or cancel. Several matches return the candidates instead of guessing.
- Dependencies: a referenced data source is rebound by exact name in the target project, otherwise the copy lands as a draft marked "missing reference". A workflow may copy its sync tasks as a bundle in topological order. Triggers are dropped.
- Partial failure of a bundle rolls back the written copies in reverse order.

### 9.3 Sharing (designed, not shipped)

- A resource gains `sharedTo: string[]` (project ids) or `["*"]`; list filters admit shared rows.
- The by-id guard gains a third state: owner members read and write, shared-to members read only, others 403.
- Read-only means HTTP reads only; test, heartbeat, execute, cancel, enable, trigger, copy, share and similar actions are side effects and are refused for shared-to members.
- Secrets and connection details are stripped from any response to a non-owner project.
- Route: `PUT /api/datasources/[id]/share { sharedTo }`, owner project editor or above.

### 9.4 Legacy table migration (designed, not shipped)

Tables created in `public` before per-project schemas are to be moved per target to `proj_<id>` or `shared`, driven by a
table ownership ledger stamped at creation. Orphans without ownership go to `proj_default` for later claiming.
Dropping the compatibility copies requires a backup, an approval and a zero-residue check.

---

## 10. Interaction essentials

- The "New project" button is hidden for developers; a short note explains who can create projects.
- Configuration entries a developer-owner can no longer use are disabled with a tooltip, not removed; development entries stay active.
- Every 403 carries a structured message with the reason and a next step ("apply to join project X", "ask the project owner for editor").
- The warehouse schema tree groups "this project" and "shared (read-only)"; other projects' schemas do not appear at all.
- Writing to `shared` is intercepted before submission with a pointer to the modelling module.
- Landing panels for code tables and dimensions state the schema (`shared`) and show one status row per target, including `drift`.
- Deleting a project previews, per target, the schema, role, secret and lake namespace that will be affected, and requires the typed project name.

---

## 11. Acceptance criteria

- [ ] A developer cannot create a project (403); a developer-owner cannot manage members (403 with guidance).
- [ ] A non-member receives 403 on every guarded route; a platform admin passes.
- [ ] High-risk routes (execute SQL, execute DDL, Airflow token, schedule enable, cancel) leave an audit record.
- [ ] A member of project A cannot fetch a statement result of project B (403); an expired handle returns 410.
- [ ] SQL history lists only the current project's statements.
- [ ] Monitoring shows only runs of the current project; pre-existing runs without a project remain visible in the default workspace.
- [ ] After supply, a project login can read its own schema and `shared`, cannot insert into `shared`, and cannot select from another project's schema.
- [ ] Source code and warehouses contain no `GRANT ... TO PUBLIC`.
- [ ] The same project resolves to different credentials and schemas on two targets; caches never mix projects or targets.
- [ ] In `isolated` state a project-context call without a project credential is refused, not served as administrator.
- [ ] A target with an allow-list is absent from pickers of excluded projects, and a direct bind is refused.
- [ ] Deleting a project with remaining resources returns 400 with the list; deleting an empty project removes its secrets in every target.
- [ ] Promotion to `prod` creates an approval item; the promoted copy carries no runtime bindings of the source environment.

---

## 12. Limits and roadmap

### 12.1 Limits

- Isolation is at schema and table level; row-level filtering inside a shared table is out of scope.
- The default workspace keeps legacy semantics: any logged-in user is an implicit editor and rows without a project belong to it.
- `PER_PROJECT_CRED` stays off until the legacy table migration has run.
- The classic Airflow web console cannot be scoped per project; its token is admin-only.
- Dashboards and alerts are outside the copy design.

### 12.2 Roadmap (as stated in the design)

- Cross-project copy with conflict handling and dependency rebinding.
- Read-only sharing of data sources and configuration resources with `sharedTo`.
- Legacy table migration console with ownership ledger, orphan claiming and guarded drop.
- Per-member target assignment and a region-administrator role.

---

## Appendix A. Where the facts live

| Topic | Path |
|---|---|
| Guards and filters | `platform/src/lib/projects/guard.ts`, `config-permissions.ts`, `constants.ts` |
| Naming of schemas, roles, users, secrets | `platform/src/lib/exec-env/project-schema.ts`, `project-secret.ts` |
| Credential supply job | `platform/src/lib/exec-env/project-cred-supply.ts` |
| Closed DDL executor and templates | `platform/src/lib/exec-env/admin-ddl-executor.ts`, `admin-ddl-request.ts`, `admin-ddl-templates.ts`, `admin-ddl-guards.ts` |
| Credential factory and state machine | `platform/src/lib/exec-env/privileged-cred.ts`, `registry.ts` |
| Permission canary | `platform/src/lib/exec-env/permission-canary.ts` |
| Target allow-list | `platform/src/lib/exec-env/residency.ts` |
| Project deletion and reclaim | `platform/src/lib/projects/long-ops.ts`, `platform/src/lib/exec-env/project-cred-reclaim.ts` |
| Environment promotion | `platform/src/lib/env/promote-service.ts`, `platform/src/app/api/promote/` |
