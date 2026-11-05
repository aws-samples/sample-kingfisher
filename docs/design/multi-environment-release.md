# dev/staging/prod Multi-Environment and Release Process (Priority 0, Pillar 3)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is described in the [module overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> Revision: 1.6.0 | Date: 2026-06-14 | Status: implemented and verified online
> Addresses the engineering item of the gap-analysis re-check (group B): "no **dev/staging/prod multi-environment and release process (CI/CD)**". This module reuses the version snapshots of [versioning and rollback](./versioning-rollback.md) (as release artifacts) and the approval flow of [multi-tenancy RBAC](./multitenancy-rbac.md) (`type:"deploy"`).

---

## 0. Goals

Give configuration-type resources (workflow / ETL job / sync task / Redshift task) **three environments — dev / staging / prod — within one project**, and provide a **promotion (promote) release process**: push an "already orchestrated definition" from a lower environment to a higher one; **promotion to a protected environment (prod) requires approval**. Data sources are not split by environment (they are connection resources shared across environments).

---

## 1. Environment Model

- Every **configuration-type resource** carries `env` (dev/staging/prod, default dev) and `lineageId` (the anchor that links the same logical resource across environments).
- The same logical resource is an **independent physical resource** in each environment (its own id / runtime state / schedule), linked by `lineageId`.
- Resource lists are isolated by **(project, env)**: the request header `x-bgp-env` (default dev); the list Scan adds an env filter (dev includes historical resources without env, `attribute_not_exists(env)`, for backward compatibility).
- The front-end header gains an **environment selector** (dev/staging/prod, stored in `localStorage["bgp-active-env"]`; the fetch interceptor attaches `x-bgp-env`).
- By-id access and actions need no env filter (ids are globally unique and the resource carries its own env).

> Data sources (datasource) are **not** included in the env dimension (connections shared across environments); the env dimension covers only these 4 configuration resource types, consistent with versioning.

## 2. Promotion (promote) Semantics

`executePromote(type, sourceId, toEnv, actor)` (`lib/env/promote-service.ts`):
1. Read the source resource → `fromEnv`, `projectId`; on the first promotion anchor `lineageId` to the source's own id (written back to the source).
2. Take the **portable definition** `portableConfig`: the source's business configuration with **the environment-specific runtime bindings removed** — `glueJobName`/`airflowDagId`/`glueJobRunId`/`lastRun*`/`testResult`/`status`/`scheduleEnabled`/`downstreamFired`/`promotedFrom`/`env`/`lineageId`. **This guarantees that the prod copy never reuses dev's Glue job / Airflow DAG** — runtime bindings are rebuilt in the target environment when it publishes/runs.
3. Look up the target by `(projectId, lineageId, toEnv)`:
   - hit → overwrite the target's business fields with portableConfig (keeping the target's own env/id/runtime state).
   - miss → create a new resource in the target environment (new id, `env=toEnv`, the same `lineageId`, `status=draft`, `promotedFrom=fromEnv`).
4. After the promotion, `snapshotVersion(... note="promoted from <fromEnv>")` on the target (reusing versioning and rollback, leaving a release snapshot; the note text is stored as a Chinese literal).

Idempotency: promoting the same `(project, lineageId, toEnv)` again = updating the target (re-release).

## 3. Release Process and Approval

`POST /api/promote {type, id, toEnv}` (`guardResourceAccess(editor)`, authorized by the resource's project):
- **toEnv is a protected environment (prod)** → create an approval `type:"deploy"` (payload: `{resourceType,resourceId,fromEnv,toEnv,name}`) and return `202 {pending:true, approvalId}`; **nothing is deployed immediately**.
- **Otherwise (dev→staging etc.)** → `executePromote` immediately and return the result.

Approval decision (`/api/approvals/[id]` approve, project owner only): when `type=="deploy"`, it dispatches to `executePromote(payload)` to actually deploy to prod. `type=="membership"` still writes the member row (multi-tenancy RBAC). The approval list/drawer (`/projects` page) can already display and handle `deploy` requests.

```
editor: dev resource ──promote staging──► executed immediately (a copy appears in staging)
editor: dev resource ──promote prod────► deploy approval (pending)  ──owner approve──► a copy appears in prod
```

## 4. Front End

- Header environment selector (dev/staging/prod) + colored tag; switching writes localStorage and reloads (every list re-fetches for the new environment).
- A generic `PromoteButton` (dropdown to choose the target environment → `/api/promote`; when prod returns pending, a "Submitted for approval" message is shown), wired into the toolbars of the workflow editor page and the Job Development page.
- The `/projects` approval drawer renders the `deploy` type (`Promote <name> → <toEnv>`); the owner approves/rejects.

## 5. Online Verification (temporary test account, us-east-1)

1. Create a job in dev → 1 item in the dev list, 0 in staging/prod (env isolation).
2. Promote dev→staging (direct) → a new copy appears in staging (new id, `env=staging`, `lineageId` = the source id, `promotedFrom=dev`).
3. Promote dev→prod (protected) → `202 pending` + approvalId; the prod list is still 0 at this point.
4. The owner approves that deploy request → automatic `executePromote` → a copy appears in prod (same `lineageId`).
5. The non-member `rbac-tester` calling `POST /api/promote` on a Default Workspace resource → **403**.
6. The copies in the three environments share the same `lineageId`.

## 6. Known Limitations / Follow-ups

1. No new DynamoDB table: `env`/`lineageId` are attributes on the resource item; promotion reuses the existing resource tables + the approval table. The `(projectId, lineageId, env)` lookup uses Scan+filter (sufficient at workshop scale; a GSI can be added at scale).
2. The chained order dev→staging→prod is not enforced (a direct dev→prod push is allowed and still goes through approval); a "must promote level by level" policy can be added later.
3. A promotion carries the **definition**; each target environment must "publish/run" on its own to create its own Glue job / Airflow DAG (avoiding reuse of runtime resources across environments).
4. Sync/Redshift tasks are already supported for promotion on the back end; the front-end "Promote" entry point currently exists on the workflow editor page and the Job Development page (the others will be added later).
5. No environment-level separate connections/secrets or differentiated parameters yet (e.g. automatic rewriting of different Redshift workgroups for dev/prod) — to follow, combined with "environment variables / parameterization".
