# Multi-Tenancy / Workspaces / Resource-Level RBAC / Approvals (Priority 0, Pillar 1)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is described in the [module overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> - Revision: 1.4.1 | Date: 2026-06-14 | Status: implemented (revision 1.4.1 correction: strict membership; the implicit editor role on the Default Workspace was removed)
> - Addresses the first priority-0 finding of the gap-analysis re-check (group B): "`userId` is still hard-coded to `default-user`; there are no projects/workspaces, no resource-level or row/column-level RBAC, and no permission request and approval flow".

---

## 0. Background and Goals

Up to v1.3.0 the platform was still **single-tenant**: every API route hard-coded `const USER_ID = "default-user"`, all resources (data sources / sync tasks / workflows / Redshift tasks / ETL jobs) landed in the same DynamoDB partition, and every logged-in user saw the same data. This was **the most critical blocker** for going to production and supporting multi-user collaboration.

The priority-0 work has three pillars in total; this module delivers only **Pillar 1** and lays the foundation for the other two:

| Pillar | Content | Release |
|--------|------|------|
| **1 (this module)** | Real identity + projects/workspaces + resource-level RBAC + approval flow | **v1.4.0** |
| 2 | **Versioning and rollback** of jobs/workflows (a configuration snapshot of each resource within a project + rollback) | v1.5.0 (planned) |
| 3 | **dev/staging/prod multi-environment and release process** (environments within a project + cross-environment promotion + approval) | v1.6.0 (planned) |

Why Pillar 1 comes first: versioning is "the history of a resource within a project", and multi-environment is "dev→prod promotion within a project"; both hang on the foundation of **project + members + roles + approvals**. Once that foundation is solid, Pillars 2 and 3 can be built on it cleanly.

---

## 1. Design Principles and Key Decisions

### 1.1 Zero-breakage migration (the most important decision)

The existing 7 resource tables are all modeled with `pk = userId` (whose value is always `"default-user"`) + a resource sort key, and every by-id route performs Get/Update/Delete with `Key{userId:"default-user", <sk>}`.

**Changing the partition key directly is a breaking change** (DynamoDB cannot change a primary key; it would require a new table + data migration, and the existing online demo data would "disappear").

**Decision**:
- **Keep the physical partition value of `userId` unchanged (still `"default-user"`)** — all existing and new resources keep landing in the same physical partition, by-id Key access is completely unchanged, **zero migration**.
- **Add attributes** `projectId`, `createdBy`, `createdBySub` to the resource item.
- **Tenant isolation and RBAC are enforced at the application layer**: list reads filter by `projectId` + membership check; by-id reads and writes verify project + role after the Get.

> Physical partition-key-level isolation (a separate partition / separate table per project) is a later hardening item; at workshop scale (tiny tables, lists already go through Scan+Filter), application-layer isolation is the correct, safe and reversible choice. This module records this explicitly under "Known limitations".

### 1.2 Default Workspace (carrying historical resources) + strict membership

- A fixed project `proj-default` (named "Default Workspace", `system:true`) carries all **historical resources** (an item without `projectId` is treated as belonging to the Default Workspace).
- **Strict membership (revision 1.4.1)**: accessing any project (**including the Default Workspace**) requires being an **explicit member** of that project; the only exception is the platform administrator (`bgp-admin`, a cross-project super administrator for operations/governance). **There is no "any logged-in user is implicitly an editor of the Default Workspace" back door** — that back door existed in the initial v1.4.0 and let non-members see every resource of the Default Workspace; it was removed in revision 1.4.1.
- New project: the creator becomes `owner`; everyone else must be invited by the owner or join through **approval**.
- Non-members can "discover" other workspaces on the `/projects` page and **request to join** (see section 3); the owner of that workspace approves.

Effect: the demo user `admin` (a member of the Cognito group `bgp-admin` → platform administrator) is owner in every project; ordinary users see only the projects they have been granted membership of, and **real multi-tenant isolation applies to the Default Workspace as well**.

### 1.3 Real identity replaces the hard-coded value

- New `lib/auth/identity.ts` reuses `verifyRequest` from `verify-token.ts` (`aws-jwt-verify`, signature/iss/aud/exp verification) to resolve the real Cognito `sub` / `cognito:username` / `cognito:groups`.
- **Fallback**: when Cognito is not configured (local/dev, `isAuthConfigured()==false`), it returns a **demo super-administrator identity** (`default-user` + `bgp-admin`), preserving the platform's existing "open when there is no Cognito" behavior.
- The platform middleware `middleware.ts` already verifies the signature for every `/api/*` request; inside a route only the claims need to be resolved and authorization applied.

---

## 2. Data Model (3 new DynamoDB tables)

| Table | pk | sk | GSI | Description |
|----|----|----|----|------|
| `bgp-projects` | `pk` (constant `"project"`) | `projectId` | — | Project metadata; `Query(pk="project")` lists all, `Get(pk,sk)` fetches one |
| `bgp-project-members` | `projectId` | `username` | `byUser` (pk=`username`, sk=`projectId`, ALL) | Members and roles; `Query(projectId)` lists members, `Query(byUser)` lists "my projects" |
| `bgp-approvals` | `pk` (constant `"approval"`) | `approvalId` (ULID) | — | Approval requests; single partition, `Get(pk,sk)` to decide, `Scan+filter` to list pending items (the volume is tiny) |

Members use the **Cognito `Username`** (e.g. `admin`) as the sk, consistent with the "Users" page and human-readable; `sub`/`email` are stored redundantly as well.

### Roles and hierarchy

- **Platform roles** (from Cognito groups): `bgp-admin` (platform super administrator, owner across projects) / `bgp-developer` / `bgp-viewer`.
  <br>⚠️ (Audit calibration, 2026-08-26) There is in fact also a **`bgp-manager`** group (the data-product / engineering manager of the [GenBI requirement pipeline](./genbi-requirement-pipeline.md), who accepts / assigns / signs off requirements; identity.ts:16 `MANAGER_GROUP`). Therefore **creating a workspace is authorized for any one of admin/manager/developer** (projects/route.ts:32-36 `canCreate = isPlatformAdmin || bgp-manager || bgp-developer`), not admin only.
- **Project roles** (from the member row): `owner` > `editor` > `viewer` (rank 3/2/1).

`resolveRole(identity, projectId)` (**strict membership, revision 1.4.1**):
1. platform administrator → `owner`;
2. a matching member row → that row's role;
3. otherwise → `null` (no access, **the Default Workspace is no exception**).

### Minimum role required per operation

| Operation | Minimum role |
|------|---------|
| List/read resources, list members | `viewer` |
| Create/update/delete resources | `editor` |
| Create a project (any platform developer or above may create one; the creator becomes owner) | — |
| Manage members, modify the project, delete the project, decide approvals | `owner` |

---

## 3. Approval Flow (access request / role elevation)

A generic approval entity `bgp-approvals`; v1.4.0 fully implements the **`membership` type** (request to join a project / elevate a role):

```text
Requester (editor/viewer) ── POST /api/approvals {projectId, type:"membership", payload:{role}} ──► pending
Project owner ── GET /api/approvals?projectId= to see pending items ──► POST /api/approvals/[id] {decision:"approve"|"reject"}
approve(membership) ──► writes/updates the member row in bgp-project-members (takes real effect)
```

An approval record carries `requestedBy/requestedAt/decidedBy/decidedAt/reason/status`, and the whole flow goes into the audit log. The `type` field is reserved for Pillars 2/3 (e.g. `deploy`: approval of a cross-environment promotion).

**Discovery and request entry point (revision 1.4.1)**: non-members cannot see the resources of projects they are not authorized for, but through `GET /api/projects?discover=1` (returns all projects, each annotated with `myRole`/`pending`) they can browse "Other workspaces you can request to join" on the `/projects` page and submit a request (including for the Default Workspace). The owner approves/rejects in the "Pending approvals" section of the project drawer.

---

## 4. Request Path and Front End

- In the global fetch interceptor of the `AuthProvider`, in addition to `Authorization: Bearer <idToken>`, the front end attaches **`x-bgp-project: <activeProjectId>`** (taken from `localStorage["bgp-active-project"]`).
- On the back end, `getActiveProjectId(req)` = the `x-bgp-project` header || `proj-default`.
- The header gains a **project switcher** (a Select listing "my projects"; switching writes localStorage and refreshes).
- New `/projects` page: project list + New + member drawer (add/remove/change role) + pending approvals (approve/reject). The sidebar gains a "Workspace" entry.

### RBAC guard (`lib/projects/guard.ts`)

```ts
requireProject(req, minRole, projectId?) -> { identity, projectId, role } | NextResponse(401/403)
guardResourceAccess(req, item, minRole)   // 资源 by-id：item.projectId（缺省→proj-default）
projectFilter(projectId)                  // 列表 Scan 的 projectId 过滤子句（默认空间含 legacy）
```

Resource route refactoring: list GET → `requireProject(viewer)` + `projectFilter`; create POST → `requireProject(editor)` + stamping `projectId/createdBy/createdBySub`; by-id GET → `guardResourceAccess(viewer)`, PUT/DELETE → `guardResourceAccess(editor)`.

Covered resources: `datasources` / `sync-tasks` / `workflows` / `redshift-tasks` / `etl-jobs`. Audit (`bgp-audit`) and GenBI/SQL history are personal logs and are not given a project dimension for now (recorded under "Limitations").

---

## 5. Deployment and Permissions

- The ECS task role already has `AmazonDynamoDBFullAccess` attached → the 3 new tables **need no IAM change**.
  <br>⚠️ (Audit calibration, 2026-08-26) This premise no longer holds: **the IAM least-privilege work of [production hardening](./production-hardening.md) removed every `*FullAccess` policy** (including `DynamoDBFullAccess`) in favor of precise inline policies derived from the actual SDK calls in `platform/src`, with resources narrowed to `bgp-*` (comment at platform-stack.ts:135-136). New tables must therefore have names that fall within the `bgp-*` authorization scope (all platform tables carry the bgp- prefix, so they are covered) and can no longer rely on FullAccess as a safety net.
- Deployment order: `BgpDatabaseStack` (creates the tables) → `BgpPlatformStack` (with `-c openmetadata-url=<OM CloudFront>`, otherwise the OM link is cleared).
- The new tables use `RemovalPolicy.DESTROY` (consistent with the existing tables; workshop account).

---

## 6. Verification Cases

1. In the Default Workspace, the existing demo data (data sources / syncs / workflows / jobs) is visible and editable by its **members** (and platform administrators) (legacy items without projectId → proj-default); **a non-member accessing the Default Workspace is rejected (403)**.
2. Create a project P2 → the current user becomes owner; switch to P2 and the resource lists are empty (isolation works); create a data source in P2 → it carries `projectId=P2`; switch back to the Default Workspace and it is not visible.
3. Member management: the owner adds members to P2, changes roles, removes members; a viewer cannot write (403), an editor can.
4. Approvals: submit a membership request → pending; the owner approves → the member row is persisted; reject → status rejected.
5. Real identity: the `createdBy` written on resources is the real Cognito user name; the audit actor is consistent.

---

## 7. Known Limitations / Later Hardening

1. **The physical partition is still a single one** (`userId="default-user"`): logical multi-tenancy is enforced at the application layer; partition-level / table-level physical isolation is later hardening (requires new tables + migration).
2. **Row/column-level permissions** are not done (resource level only); data classification / masking belongs to the priority-1 tier.
3. **Audit / GenBI / SQL history** have no project dimension (personal logs).
4. **Members are maintained by Cognito Username**: the user must exist in the user pool; bulk / SSO synchronization comes later.
5. Pillar 2 (versioning/rollback) and Pillar 3 (multi-environment/release) have their own later design documents.

---

## 8. Bridge to Pillars 2 / 3 (outlook)

- **Versioning (Pillar 2)**: add `bgp-resource-versions` (pk=`<type>#<resourceId>`, sk=`version`); every save writes a snapshot; rollback = take a version and overwrite the current state. Reads and writes reuse this module's `guardResourceAccess`.
- **Multi-environment (Pillar 3)**: add an `env` dimension (dev/staging/prod) within a project; resources carry `env`; promotion = copy the dev configuration to prod, passing through this module's **approval flow** (`type:"deploy"`).
