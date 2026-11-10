# Project Isolation — Technical Specification (SPEC): Completing Workspace Resource Isolation and Cross-Workspace Copy

> - Revision: **1.3** (🔴 2026-08-31, **rulings A and B synchronized**: the project-context branch of section 3.4 originally said "a missing credential is always refused, never falls back", which collided with [the multi-region execution specification](./multi-region-execution-spec.md), section 3.9
>   ⇒ unified by [state + time boundary] into **the multi-region execution specification, section 3.9b** [this section is word for word identical to it;
>   changing only one of the two copies = leaving the collision in place];
>   the admin-ddl branch **no longer issues credentials** and instead goes through the closed executor of the multi-region execution specification, section 3.9a.
>   🔴 The 7 operations and capabilities such as the SQL editor are **all retained**) · revision 1.2 (implementation-level technical design: finalized tables / interface schemas / pseudo-code for the key mechanisms / list of change points / acceptance) | Date: 2026-08-28 (revision 1.1: 2026-08-29) |
>   Status: ⬜ in design, pending review
> - 🎯 **Revision 1.1 changes (convergence review across all modules, 2026-08-29)**: ① 🔴 **the new table `bgp-table-ownership` (the table-creation ledger) is added** — the multi-region execution specification, section 1.3a-S12, had long stated "created by the project-isolation module; synchronized
>   into section 1 of its specification", but that back-feed was never carried out, and until now this table had **zero hits** in the three documents of this module (sections 1 / 3.7);
>   ② the section 1 headline claim "all pure append-only attributes, zero table migration" is **narrowed** to "this module's own additions are pure append-only;
>   the key changes and back-fill of `bgp-task-runs` / `bgp-audit` are owned by the multi-region execution work", and the claim "no new control-plane tables" is withdrawn (there are now 2: this table + `bgp-query-handles`);
>   ③ the migration pseudo-code of section 3.7 gains the ledger's **table name** (it previously said only "the ledger", with no anchor).
> - Basis: [the design](./project-isolation.md), **revision 1.11** (decisions / gaps / risks) + **[the multi-region execution design](./multi-region-execution-design.md), revision 3.26 / [the multi-region execution specification](./multi-region-execution-spec.md), revision 3.54** (the `targetId`
>   identity, the four axes of its section 19, the foundation corrections of its section 20, the controlled admin-DDL executor of its section 3.9a). **This document is the single implementation-level contract of the project-isolation module**; decisions are in the design, interaction in [the
>   interaction design](./project-isolation-interaction.md).
> - 🔴 Pure design (with pseudo-code); no implementation code is written and nothing is deployed without confirmation.
> - 🎯 **Revision 1.0 changes (two tracks of specification-level deep review confirmed by grep + ruling 2)**: completes the **8 P0 items that must be done before construction starts** — ① the sanitize rule of the authoritative `projectSchema()` is fixed (eliminating the fork of 3 existing functions);
>   ② **metadata-side FQN convergence** (9 occurrences of `||"public"`; prevents masking from silently failing after migration → PII exposed in clear text);
>   ③ **fail-closed split into three classes** (adding the "controlled admin-DDL provisioning identity"; otherwise DMS, modeling table landing and L3 provisioning itself are all cut off);
>   ④ **physical tables of the global-knowledge class land in the `shared` schema** (ruling 2: **two dimensions, region × project**);
>   ⑤ `statementId→projectId` is upgraded to the **queryHandle of the multi-region execution specification, section 3.7** (unified; includes fixing the IDOR in production);
>   ⑥ the definition of `isReadOnlyAction` + `isReadOnly(sql)` reusing the existing single source of truth;
>   ⑦ `copyToProject` gains multi-hit handling / COPY_EXCLUDE / compensation for partial writes;
>   ⑧ **replacement of the `public.` placeholder in the cookbook** (jointly with the multi-region execution specification, section 3.11).
> - Corrections: the fail-open ternary occurs at **16 sites (including only 3 in zeroetl**; the earlier "6" was an overestimate);
>   the read side of task-runs is split into two classes, **user view vs. platform aggregation**.

---

## 0. Identity alignment with the multi-region execution work (declared first, used throughout)

| Concept | Ruling |
|---|---|
| **Project** | `projectId` (as today, `proj-<ulid>`; `proj-default` is the legacy default) |
| **Execution target** | 🔴 **`targetId`** (the immutable identity introduced in revision 3.0 of the multi-region execution design; region is one of its attributes). The data-plane objects of this module exist **in two dimensions, (targetId, projectId)** |
| **Data-plane schema** | the project-private `proj_<sanitize(projectId)>` + 🆕 **the global-knowledge schema `shared`** (see sections 1 / 3.8); **one set per target** (ruling 2) |
| **Credentials** | uniformly through `getPrivilegedCred(targetId, {purpose, project})` of the multi-region execution specification, section 3.9; cache key **`(targetId, project, purpose)`** |

---

## 1. Table design (final)

- **Control plane**: 🔴 **wording corrected in revision 1.1** — the original "**all pure append-only attributes, zero table migration**" contradicted the cells right below it (`bgp-task-runs` explicitly says "making runId composite is owned by the multi-region execution specification, section 1.2", `bgp-audit` explicitly says "sharding per the multi-region execution specification, section 3.3", and both of these **are pk/sk key changes = breaking migrations**);
  the multi-region execution work has already withdrawn the same claim (its design, sections 10 / 7.1a).
  **The accurate statement = "everything this module adds itself is a pure append-only attribute; the key changes and back-fill of these two tables are owned by the multi-region execution work (via the home exemption + dual write / dual read + back-fill)";**
  **there are also 2 new tables (see below)**, so this module **no longer claims "no new control-plane tables"** either.

| Table | Added | Notes |
|---|---|---|
| `bgp-datasources` and the other resource tables | `sharedTo?: string[]` | a list of project ids or `["*"]`; sharing = read-only reference (decision D1). **Commitment C3: all 8 data-source types + sync / etl / workflow configuration resources** |
| the 5 copyable resource types | `copiedFrom?: {projectId,resourceId,version,at,by}` | copy provenance (decision D5); the lineageId is not shared |
| **`bgp-task-runs`** | `projectId: S` | 🔴 **the same batch of write points as the multi-region execution work; `{projectId,targetId}` changed together in one pass**; **making runId composite is owned by the multi-region execution specification, section 1.2**; read and write sides ship in the same batch |
| `bgp-sql-history` | `projectId: S` + 🆕 `targetId: S` | carried on both the read and the write side (decision D3) |
| `bgp-audit` | `projectId: S` | for filtering by project (decision D2); sharding / residency per the multi-region execution specification, section 3.3 (🔴 changing the pk to `audit#<targetId>#<day>` = a key change, owned by the multi-region execution work) |
| 🆕 **`bgp-table-ownership`** (**new table, created by this module**) | **`pk="fqn"`**, attributes `{projectId, targetId, kind:"business"\|"modeling-global"\|"unknown", createdBy, at}` | 🔴 **Back-fed in revision 1.1 (an omission found by the convergence review of 2026-08-29)**: **the table-creation ledger** — this table is the **sole basis** for the section 3.7 migration rule "ownership attribution does not depend on after-the-fact reverse lookup", and the evidence source for acceptance criterion G1.<br>The contract is registered in **the multi-region execution specification, section 1.3a-S12** (that side had long stated "created by the project-isolation module, **synchronized into section 1 of its specification**", but that back-feed was **never carried out** ⇒ this table had **zero hits** in the three documents of this module; building from the old draft, **nobody would have created this table**, and G1 could only fall back to the after-the-fact reverse lookup that this module's own assessment calls "basically collapsed").<br>**Stamped at table creation**: all four table-creation paths (`execute-ddl` / `codegen` / `sync` (`glue-script-generator`) / modeling), **none left out**; missing one = that batch of tables has unknown ownership at migration time → lands in `proj_default` pending claim.<br>🔴 **The earlier construction batch writes the ledger first without consuming it, so stamps for existing tables accumulate ahead of time** (the multi-region execution specification, section 5, G5) |
| 🆕 `bgp-query-handles` | — | **defined by the multi-region execution specification, section 3.7** (this module no longer builds a separate `statementId→projectId` mapping) |

**Data plane (section 7bis of the design; the data-plane construction phases L2 / L3; 🔴 one set per target)**:

| Object | Definition | Notes |
|---|---|---|
| Project schema | `proj_<sanitize(projectId)>` | goes through the **authoritative `projectSchema()`** (section 3.0); shared by all four uses — table creation / writes / queries / S3 Tables |
| 🆕 **Global-knowledge schema** | **`shared`** | 🔴 **Ruling 2**: physical tables of the "enterprise common vocabulary" — code tables, conformed dimensions and the like — land here; `GRANT USAGE + SELECT` to **all `role_proj_*` (not PUBLIC, not proj_)**; business data still lands in `proj_<id>` (section 3.8) |
| Project DB role | `role_proj_<sanitize(id)>` | GRANT USAGE/SELECT on the project's own schema + read-only on `shared` |
| 🆕 **Project login user** | `user_proj_<sanitize(id)>` | 🔴 **Contract gap filled on 2026-09-04** (found while building the data-plane phase): the original table defined only the role, but Redshift RBAC is two things, `CREATE USER` + `GRANT ROLE <role> TO <user>` — the role is a set of privileges, **the user is the principal that can log in with a password**, and that is what the per-project secret stores.<br>Without this row the provisioning layer could only improvise a name on the spot = yet another case of "the same name assembled separately in two places".<br>Derived with the same sanitize as the role;<br>the authoritative implementation is `projectDbUserName()` in `lib/exec-env/project-schema.ts`; the secret name is in `projectSecretName()` (reasoning in [the design](./project-isolation.md), section 13bis.3) |
| Project credential | a Secrets Manager secret in that **target** | per (target, project); provisioning / rotation per the multi-region execution specification, section 3.9, plus the design's credential item F1.2 |
| Data-lake namespace | `proj_<sanitize(projectId)>` | derived from the **projectId**, **not from a database name**; shares the same sanitize |

---

## 2. Interface design

```ts
type MinRole = "viewer" | "editor" | "manager" | "admin";
type ConflictMode = "rename" | "overwrite" | "cancel";
type CopyableType = "workflow" | "etl-job" | "sync" | "redshift-task" | "engine-job";
```

| Method · path | Request | Response / guard |
|---|---|---|
| **PUT** `/api/datasources/[id]/share` | `{ sharedTo: string[] }` | 200 `{ok}`; guard = **editor or higher in the owning project** |
| **POST** `/api/projects/copy-resource` | `{ type, id, toProjectId, toEnv?, conflict, includeDeps? }` | 200 `{newId, status, unresolvedRefs?, clashCandidates?}`; guard = **viewer or higher in the source project and editor or higher in the target project** |
| **GET** `/api/monitor/runs` | + implicit `projectId` | + `requireProject`; the FilterExpression **must carry the legacy fallback** (section 3.1) |
| **DELETE** `/api/projects/[id]` | — | 🔴 **cross-target reclamation** (section 3.9): precondition bindings = 0 + clean up the `proj_<id>` schema / role / secret target by target |

**Gap B — adding guards to the privilege-escalation surfaces (🔴 **13 surfaces**; revision 1.2 added the 13th, `redshift/schemas`; before → after)**:

| Route (current state confirmed by grep) | Current state | Change |
|---|---|---|
| 🆕 **`redshift/schemas:45` (the 13th surface, added in revision 1.2)** | **No guard at all** + deliberately uses the **shared admin (superuser)** to enumerate every schema / table / column in the database (the file's own comment admits that only the superuser can see tables created by others) ⇒ any logged-in user obtains the metadata of the whole database | `requireProject(viewer)` (already added in this batch) + **trim the result set by the project-schema allow-list** (pending the data-plane isolation of section 7bis of the design) |
| `redshift/execute:9` | no guard; executes arbitrary SQL under the admin identity | `requireProject(editor)` + `recordAudit(SQL)` + read-only guard (section 3.5) + **a handle issued through `submitStatement()`** |
| `sync/execute-ddl:14` (GRANT PUBLIC at :36) | arbitrary DDL + `GRANT ALL TO PUBLIC` | `requireProject(editor)` + **revoke GRANT PUBLIC** + audit |
| `workflow/airflow:9` | 🔴 **GET without even `resolveIdentity`** (weaker than the original draft described) | **restricted to bgp-admin only** + audit; ⚠️ a single MWAA has no dagId-level isolation (a known limitation recorded under decision D3) |
| `schedule/enable:13` | does not check the project; the sync branch does a blind Update (:71) | `guardResourceAccess(editor)` loads the item by taskType; fix the blind Update |
| `redshift/cancel:8` | cancels any statementId | guard by handle ownership or editor role |
| `datasources/test:13` + `[id]/heartbeat:13` | writes status across projects | `guardResourceAccess(editor)`; 🔴 **judged by the owning project** (prevents confused-deputy attacks) |
| `sync/generate-ddl:9` (injection at :29) | string concatenation into SQL | `requireProject` + parameterization / allow-list |
| `datasources/[id]/schemas\|tables` | browses the structure of any source | `guardResourceAccess(viewer)` |
| `monitor/tasks/[id]/logs:10` | reads the logs of any run | `guardResourceAccess(viewer)` |
| `redshift/history:11` | platform-wide shared SQL history | + `projectId` (read and write sides) |
| 🔴 `redshift/result/[id]:9-51` | relies on the statementId alone | **the queryHandle of the multi-region execution specification, sections 0 / 3.7** (fixed first, as a standalone stage) |
| 🔴 `modeling/model-metrics/[id]/compute:9` | usable by anyone logged in, with any fqn | **+ `isPlatformAdmin`** (🔴 **not** "or a project-membership check" — this resource has no projectId, so a membership check ≈ letting everyone through) |

---

## 3. Pseudo-code for the key mechanisms

### 3.0 🔴 The authoritative `projectSchema()` (eliminates the 3 existing sanitize forks; P0-1)

```
// Current state — three mutually incompatible implementations: sync/s3tables-identifier.ts:22 sanitizeS3TablesIdentifier (lower-cases, lossy, no length cap)
//                  modeling/redshift.ts:24 safeIdent (keeps case, throws on illegal characters)
//                  the python re.sub(...) inside glue-script-generator
// → Fix a single source of truth, shared by all four uses — table creation / writes / queries / S3 Tables namespace:
function projectSchema(projectId): string {
  const s = projectId.toLowerCase().replace(/[^a-z0-9_]/g, "_")   // lower-case + illegal characters → _
  const base = `proj_${s}`                                        // the prefix naturally takes care of "starts with a digit" and reserved words
  return base.length <= 127 ? base                                // the Redshift identifier limit is 127 bytes
    : `${base.slice(0, 120)}_${sha1(projectId).slice(0, 6)}`       // truncate + short hash against collisions
}
// 🔴 Uniqueness invariant (must be stated): projectId is generated by the platform = /^proj-[0-9A-HJKMNP-TV-Z]{26}$/
//    (ULID = Crockford base32, **upper-case**, I/L/O/U excluded) ⇒ under the premise "only the upper-case form is accepted",
//    sanitize (global lower-casing) is a **bijection**, lossless. If custom projectIds are ever allowed, a projectId→schema ledger + collision detection must be maintained.
//    🔴🔴 **Corrected against a real environment on 2026-09-03**: this line originally gave the lower-case character set `[0-9a-hjkmnp-tv-z]`, while the platform's actual generator
//    `project-service.createProject` uses `ulid()` (which returns **upper-case**) ⇒ an `assertProjectId` implemented from the original text
//    **rejected every real projectId** (measured with `proj-01M1KP594D2E6DJQC8EZ8CRAES`). The defect had not surfaced before
//    because `projectSchema()` had no production caller when it first landed; the project-deletion precheck of the first construction phase became the **first**
//    production caller, and as soon as it was wired in it showed up as "no project can be deleted" (the inventory throws → fail-closed).
//    ⇒ Contract and implementation are changed to the upper-case character set together; **deliberately no /i flag** (if both case forms were legal, `proj-ABC…` and
//    `proj-abc…` would map to the same schema = cross-project data confusion). The unit-test fixture was also changed from `"0".repeat(26)`
//    (all digits, identical in either case, which happened to bypass exactly this dimension) to the real-environment form.
// 🔴 The `proj-default` special case: its schema name is fixed as `proj_default` (not `proj_proj_default`), hard-coded in the mapping table (removes the ambiguity of review finding P2-2)
// safeIdent serves only as a [validator]: the output of projectSchema() is passed through it; the two never act independently
```

### 3.1 `projectFilter` extension (sharedTo + keeping the legacy fallback)

```
function projectFilter(projectId) {
  if (projectId === DEFAULT_PROJECT_ID)
    return "(projectId = :p OR attribute_not_exists(projectId) OR contains(sharedTo, :p))"
    // 🔴 The attribute_not_exists branch [must be kept]; otherwise every legacy resource without a projectId disappears
  return "(projectId = :p OR contains(sharedTo, :p))"
}
// 🔴 The task-runs read side [splits into two classes] (correction from review finding P1-4: the earlier "change all of them this way" would have hurt platform aggregation):
//   (A) the [project view] visible to users — the main Scan + joins of monitor/runs, Copilot list_recent_runs, the by-id run route
//       → (projectId = :p OR attribute_not_exists(projectId))
//   (B) platform-level [aggregation] — finops / baseline / alerting / incidents / diagnostics / ops-summary
//       → [no project filter is added]; only the projectId attribute is added for attribution (adding a filter would miss existing records)
//   Full list of consumers (confirmed by grep; missing one is an error): incidents/{signature,record}, diagnostics/evidence,
//   alerting/ops-summary, baseline/workflow-runtime, finops/sweep, copilot/plan/{executor,discovery-tools,step-handlers/spi}, engines/emr/provider
```

### 3.2 The three-state `guardResourceAccess` + `isReadOnlyAction` (P0-6)

```
function guardResourceAccess(item, ctx, minRole) {
  if (isPlatformAdmin(ctx)) return OK
  const owner = item.projectId ?? DEFAULT_PROJECT_ID
  if (isMember(ctx, owner) && roleOK(ctx, owner, minRole)) return OK   // ① owning project: read and write
  if ((item.sharedTo ?? []).includesAny([ctx.project, "*"])) {         // ② shared with the caller: read-only
    if (isReadOnlyAction(ctx.action)) return OK
    return DENY
  }
  return DENY(403)                                                     // ③ neither
}
// 🔴 Definition of isReadOnlyAction (previously zero hits in the whole repository, no rule):
//   read = HTTP GET/HEAD and action ∉ the side-effect list
//   side-effect list (counts as a write even on GET): test / heartbeat / execute / cancel / enable / disable /
//                                    trigger / copy / share / generate-ddl / land / compute / offline
//   The party a resource is shared with may only: GET-read + "be referenced as a source to build a sync" (the reference happens in the [referencing] project, with the referencing project's credential, landing in the referencing project's schema)
//   🔴 The party a resource is shared with [may not] trigger runs (prevents a confused deputy from producing side effects through a shared resource)
// 🔴 isReadOnly(sql) — 🔴 revision 1.0 correction: `genbi/core/sql-guard.ts` has [no] boolean isReadOnly;
//    it actually exports only `sanitizeSelect(raw, maxRows)` / `sanitizeReadOnly(raw, maxRows)`, which return a `GuardResult`
//    (containing the rewritten SQL and the row limit); so a [thin adapter] must be written rather than inventing new judgement logic:
function isReadOnly(sql: string): boolean {
  const r = sanitizeReadOnly(sql, /*maxRows*/ 1)   // use only its "is it read-only" verdict; discard the rewrite / row-limit output
  return r.ok === true                             // the failure state of GuardResult means "contains a write / DDL"
}
// ⚠️ The adapter [must not] execute the SQL rewritten by sanitizeReadOnly (it injects maxRows, which changes the semantics);
//    only the verdict bit is taken. assertQuery in section 3.5 uses this adapter.
```

### 3.3 `copyToProject` (generalized promote; P0-7 completion)

```
async function copyToProject(type, sourceId, toProjectId, {toEnv, conflict, includeDeps}) {
  requireRole(ctx, sourceProjectOf(sourceId), "viewer"); requireRole(ctx, toProjectId, "editor")
  const src = load(type, sourceId)
  const COPY_EXCLUDE = PROMOTE_EXCLUDE ∪ {triggers, sharedTo, copiedFrom, promotedFrom}   // 🔴 added: PROMOTE_EXCLUDE does not contain triggers
  const draft = strip(src, COPY_EXCLUDE)
  draft.projectId = toProjectId; draft.copiedFrom = {...}
  // 🔴 Conflicts: findByName returns a [set] (resource names have no uniqueness constraint within a project)
  const clashes = findByName(toProjectId, type, src.name, toEnv)      // the lookup key includes toEnv
  if (clashes.length > 1) return {needsChoice: true, clashCandidates: clashes}   // let the user choose; do not guess
  if (clashes.length === 1) switch (conflict) {
    case "rename":    draft.name = `${src.name}-copy`; break
    case "overwrite": if (clashes[0].copiedFrom?.resourceId !== sourceId)
                        return {error:"NotSameSource", hint:"the same-named target resource was not copied from this source and cannot be overwritten"}  // 🔴 a structured hint, not a bare thrown error
                      await snapshotVersion(clashes[0])   // 🔴 on failure [abort]; never swallow the error with .catch(()=>{})
                      break                               //    (the generalized implementation starts fresh and does not inherit the error swallowing of promote-service.ts:129,149)
    case "cancel":    return {cancelled:true}
  }
  // 🔴 Compensation for partial writes during dependency copying (P0-7): bookkeeping + rollback in reverse order
  const written = []
  try { for (const dep of topoOrder(deps)) { written.push(await write(copyOf(dep))) }
        written.push(await write(draft)) }
  catch (e) { for (const w of written.reverse()) await deleteQuietly(w) ; throw e }   // leave no orphan copies
  audit("copy", {from:sourceId, to:draft.id}); return {newId: draft.id, status, unresolvedRefs}
}
// datasource is [shared only, never copied] (secretArn / glueConnectionName are not portable)
```

### 3.4 🔴 L3 credential resolution: fail-closed **in three classes** (P0-3; the original two classes would have broken DMS / modeling / L3's own provisioning)

```
// Uniformly through getPrivilegedCred(targetId, {purpose, project}) of the multi-region execution specification, section 3.9; cache key (targetId, project, purpose)
type Purpose = "project-context" | "governance-read" | "admin-ddl"
async function resolveCred(targetId, project, purpose) {
  switch (purpose) {
    case "project-context":                     // ① project context (execute / genbi; data-service was retired on 2026-09-05, multi-region execution specification, section 3.9c)
      // 🔴🔴 Unified in revision 1.3 (ruling A of 2026-08-31): this branch originally said "a missing credential is always refused, never falls back to admin",
      //    which **collided directly** with the multi-region execution specification, section 3.9, "a transitional fallback is allowed before the data-plane phase lands"; and removing the fallback would
      //    break execute / GenBI before per-project credential provisioning is complete (= cutting a core function, item 1 of the do-not-cut list; data-service was retired on 2026-09-05).
      //    Ruling: unified by [state + time boundary] — the authoritative full text is **the multi-region execution specification, section 3.9b** (this section is word for word identical to it).
      assertProjectId(project)                  // 🔴 a projectId must be present; optional is not accepted
      const st = requireCredentialIsolationState(t)   // missing / unknown ⇒ throw + alert; never implicitly treated as legacy
      const arn = await lookupProjectSecretArn(targetId, project)
      if (arn) return cachedByEpoch(getSecret(arn), st.credentialEpoch)
      if (st.credentialIsolationState === "isolated")
        throw new Error("no per-project credential — refuse")   // steady state: never fall back to admin (the original intent of this module is preserved)
      return legacyFallback(t, project, st)     // only for existing home traffic that is legacy-seeded / under controlled provisioning
    case "governance-read":                     // ② platform-level [read-only] controlled global reader (governance / metrics / quality / sensitive-data scan)
      return SYSTEM_GOVERNANCE_IDENTITY          // read-only + constrained return shape + strong RBAC + full audit (see below)
    case "admin-ddl":                           // ③ controlled admin-DDL
      // 🔴🔴 Reworked in revision 1.3 (ruling B of 2026-08-31): this branch **no longer issues credentials**.
      //    The original had two fatal flaws (confirmed by priority-0 findings of the first and second external reviews): ① `stmt` was not among the parameters, so the pseudo-code was unimplementable;
      //    ② the final `return getSecret(...)` handed the raw admin secret to the caller — validating one SQL statement once
      //    constrains nothing about what the caller runs after obtaining the key; the allow-list becomes decoration (a "check A, execute B" TOCTOU).
      //    Ruling: always go through **the closed executor `executeAdminDdl(actor, request)` of the multi-region execution specification, section 3.9a** —
      //    the caller passes only a **structured request** (`{operation,targetId,projectId,…}`), never sql / statements[];
      //    the SQL is generated from **module-private templates**, the credential is obtained inside the function and never leaks out, and a failed audit write means refusal.
      // 🔴 The 7 business capabilities retained (item 5 of the do-not-cut list: none may be removed): create-project-schema /
      //    create-shared-schema / create-role / grant / drop-project-schema /
      //    dms-ingest-bootstrap / land-code-table.
      throw new Error("admin-ddl credentials are not issued by this factory — use executeAdminDdl() of the multi-region execution specification, section 3.9a")
  }
}
// 🔴 Classification is by [static categorization of the call site] (not by guessing from the SQL at run time); all three classes of calls are audited
```
- 🔴 **Fix the fail-open ternary (count corrected)**: **16 sites** across the repository of `...(SecretArn ? {SecretArn} : {})` — distribution: `redshift/execute:22`, `etl/job-service:351,403`, `backfill/execute:95`, `genbi/schema:33`, `genbi/redshift:51`, `modeling/redshift:40,201`, `quality/service:151`, **`zeroetl-service:240,260,292` (only 3 sites; the earlier draft's "6 sites" was an overestimate)**, `redshift/schemas/route:32`, `sensitive/scan:78`, `realtime/redshift-target:34`, `metrics/service:183`.
- **Both single-value caches (`admin-secret:13 _arn`, `zeroetl:69 _secretArnCache`) are changed to composite keys**;
  missing zeroetl would let zero-ETL workgroup queries bypass isolation.

🔴 **The four real closures of class ② "controlled global reader"**: (a) a read-only identity; (b) **a constrained return shape** — `sensitive-scan` returns only `{column, matched type, count}` and never rows; metrics return only scalars / aggregates and guard against enumeration through constructed aggregates; (c) strong RBAC (`model-metrics/compute` gains `isPlatformAdmin`); (d) full audit. Cross-jurisdiction use is additionally governed by the multi-region execution specification, section 8.5.7 ③.

### 3.5 Revoking GRANT PUBLIC (L1) + the execute read-only guard + the ban on cross-project data movement

```
// L1: all [6 sites] of TO PUBLIC in the repository are revoked + existing grants migrated (grep confirms there is no 7th):
//   ① execute-ddl:36 (run time) ② glue-script-generator:454 (every Glue script) ③ codegen:54 (the LLM prompt)
//   ④⑤ cookbook/seed/glue.ts:307,323 (+ the compiled copy core-dist/cookbook/seed/glue.js:306,322 → change the source and redistribute)
//   ⑥ types/etl-job.ts:92 (the default ETL template)
// Hard acceptance gate: the inspection scans the whole repository + TO PUBLIC in the warehouse == 0
function assertQuery(sql, {jurisdiction, project, targetId}) {
  if (isCrossJurisdiction && !isReadOnly(sql)) DENY          // reuses sql-guard.ts
  if (/\bUNLOAD\b|\bCREATE\s+EXTERNAL\s+SCHEMA\b|\bdatashare\b/i.test(sql)) DENY
  // cross-project UNLOAD to a bucket other than the project's own is forbidden; enforced in three dimensions, (jurisdiction, project, target)
}
```

### 3.6 Result retrieval: unified on the queryHandle of the multi-region execution specification, section 3.7 (replacing the original `statementId→projectId` mapping)

```
// 🔴 This module no longer builds its own mapping table: the submit side uniformly uses submitStatement() (multi-region execution specification, section 3.7); the fetch side checks ownerSub + projectId (+ targetId)
// Covers [all 8] submission points that produce retrievable results (missing one = a legitimate query cannot fetch its result = a fail-closed false rejection):
//   ① redshift/execute ② genbi-redshift ③ genbi-athena ④ ~~data-service/execute~~ (retired on 2026-09-05; the multi-region execution specification, section 3.7, had long classified it as not emitting statement ids)
//   ⑤ modeling/redshift (execScalar) ⑥ metrics/service ⑦ quality/service ⑧ sensitive/scan
//   (the earlier text said "7" while the enumeration in parentheses listed 8 items; corrected to 8; the multi-region execution specification, section 3.7, synchronized)
// 🔴 Minimal closed-loop fields of the first stage = {handleId(PK), statementId, ownerSub, projectId, expiresAt}
//    — [must include handleId as the PK] (the PK was previously left out and would have been misimplemented as "keyed by statementId, fetched without parameters");
//      the targetId / jurisdiction fields are filled in during the later multi-region phase that introduces per-target identity (the table is created complete once, writes are phased, avoiding a second migration)
// 🔴 Client contract (neither side had written it before; construction would have stalled on day one):
//   · the POST /api/redshift/execute response [adds handleId]
//   · GET /api/redshift/result/[statementId]?handleId=<h> (retrieval must carry it; missing ⇒ 400)
//   · the only front-end call site, the fetch(`/api/redshift/result/${statementId}`) at app/redshift/page.tsx:68, must add ?handleId=
//   · the four submission points ⑤⑥⑦⑧ that [fetch their own results server-side] consume the result directly [within the same process] and do not go through result/[id]
//     ⇒ they still call submitStatement() to issue a handle (unified audit / ownership ledger), but it [need not be sent down to the front end]
// 🔴 Clarification of the acceptance semantics (consistent with the multi-region execution specification, section 3.7): rejection condition = ownerSub does not match [and] the caller is not a member of that projectId
//   ⇒ members of the same project can fetch each other's results (collaboration inside a project is intentional); the acceptance case "A uses B's statementId → 403"
//     presupposes that [A and B belong to different projects]; it does not apply within one project (the test case must state this premise)
```

### 3.7 public→proj_ migration (🔴 run once per target)

```
// Default (a): CREATE proj_<id>.t + COPY/INSERT + verify identical row counts + keep public read-only for a compatibility period + DROP after approval
//   🔴 Before DROP, mandatory: UNLOAD/CTAS backup to S3 (or a snapshot) + second confirmation / approval + rerun the "public still has unmigrated tables" inspection
// (b) ALTER TABLE ... SET SCHEMA: an [exception chosen explicitly per table] (no compatibility window, a one-way door), only for tables confirmed to have no consumer dependencies
// 🔴 Ownership attribution [does not depend on after-the-fact reverse lookup] (review finding P1-3: sync stores only sourceTables and the target table name is derived at run time, so reverse lookup basically collapses):
//   changed to [stamping at table creation] — the four table-creation paths execute-ddl / codegen / sync (glue-script-generator) / modeling
//   all write the ledger table **`bgp-table-ownership`** (pk="fqn", fixed in section 1; revision 1.1 added the table name — the original said only "the ledger" without a name, leaving construction with no anchor)
//   recording `fqn → {projectId, targetId, kind}`; the migration routes by the ledger; no ledger record → proj_default (claimable)
// 🔴 Idempotent / resumable: the migration tool records {pending|migrated|failed|skipped} progress per table; an interrupted run can re-enter without migrating twice
// 🔴 Before revoking existing GRANT PUBLIC: use the inspection to list "existing reports / Ask-Your-Data / BI / DataAPI that depend on that grant" → revoke gradually
//    (SVV_TABLE_INFO / pg_default_acl + a static scan of platform-side configuration that references `public.`)
```

### 3.8 🔴 Physical tables of the global-knowledge class land in `shared` (ruling 2: two dimensions, region × project; P0-4)

```
// Root of the conflict: modeling code tables land in public (modeling/service.ts:258 landCodeTable passes no schema → redshift.ts:82 defaults to public),
//          dimension / fact tables land in the fixed global layers ods/dwd/dws/ads (service.ts:27-30)
//          ⇒ after L1 revokes PUBLIC, role_proj_* cannot read the code tables; after L2 migrates them into proj_, the "enterprise common vocabulary" is broken through
// Ruling (one set per target):
const SHARED_SCHEMA = "shared"
// ① default schema for modeling table landing: public → shared (landCodeTable / applyModelTableDDL pass it explicitly)
// ② at provisioning: GRANT USAGE ON SCHEMA shared TO role_proj_*; GRANT SELECT ON ALL TABLES IN SCHEMA shared TO role_proj_*
//    + ALTER DEFAULT PRIVILEGES so that new tables are readable automatically; 🔴 not PUBLIC, not proj_ (isolated yet globally readable)
// ③ write permission only for the class ③ admin-DDL provisioning identity of section 3.4 (project members cannot write shared)
// ④ L2 migration routing: tables built by modeling (ledger kind="modeling-global") → shared; business data → proj_<id>; no ledger record → proj_default
// ⑤ metadata FQNs (section 3.10) point to shared as well; cookbook / codegen reference code tables as shared.<t>
// 🔴 Semantic boundary (aligned with commitment C2): "a project cannot see another project's tables" holds fully for [business data];
//    `shared` is [an intentional global read-only knowledge layer] (code tables / conformed dimensions) and contains no project business data
```

### 3.9 Cross-target reclamation on project deletion (jointly with the multi-region execution specification, section 3.12)

```
async function deleteProject(projectId) {
  assertBindingsZero(projectId)                    // resource definitions / members / schedules / runs all 0 (as for deleting an environment, multi-region execution specification, section 4.4)
  for (const targetId of listActiveTargets()) {    // 🔴 target by target (including other jurisdictions)
    // 🔴 Revision 1.4 correction (a priority-0 finding of the fourth external review): the original wrote getPrivilegedCred(targetId,{purpose:"admin-ddl"})
    //    + execStatements(cred,[...]) — exactly **the exit that section 3.4 of this document already forbids** (that branch now throws directly);
    //    building from it would be guaranteed to blow up. Ruling: go through the **closed executor** of the multi-region execution specification, section 3.9a; pass only a structured request, never SQL.
    await executeAdminDdl(actor, {operation:"drop-project-schema", targetId, projectId, approvalId})
    //    role reclamation is produced by that operation's **private template** as well (the caller neither assembles SQL nor obtains the credential)
    await deleteSecret(targetId, projectId); await deleteLakeNamespace(targetId, projectId)
    audit("project-purge", {projectId, targetId})   // 🔴 leave a trace (right to be forgotten)
  }
  await deleteControlPlaneRows(projectId)           // today only this step is done (project-service.ts:162-178)
}
// ⚠️ A destructive cross-target operation: approval + re-typing the project name to confirm + back up the data first (leave a way back, as before DROP in section 3.7)
```

### 3.10 Metadata-side FQN convergence (P0-2; prevents masking from silently failing after migration → PII exposed in clear text)

```
// 🔴 **9 sites** of independent ||"public" / local FQN construction (confirmed by grep; the earlier "8 sites" missed the most critical one, the 9th on the write side),
//    all of which must converge on [the same authoritative FQN function] (multi-region execution specification, section 3.10):
//   🔴 ⑨ sync/glue-script-generator.ts:344  ← the **write-side** default `rs_schema = task.redshiftConfig?.schema || "public"`
//      Consequence of missing it: after the L2 migration [newly created sync tasks still write their data into public] (every generated Glue script has public baked in),
//      and the acceptance criteria M5 ("no residual public") and M1 (masking effective) would blow up only **after go-live** — so it is the first priority of this list.
//   governance/masking.ts:98,122      ← masking FQN (the most lethal: a classification miss ⇒ de-mask ⇒ PII in clear text)
//   lineage/sql-lineage.ts:214        ← lineage-parsing default
//   governance/lineage-service.ts:36  ← lineage write
//   openmetadata/om-push.ts:166,344   ← OpenMetadata push
//   genbi/core/retrieval-core.ts:128  ← Ask-Your-Data retrieval (cannot find migrated tables)
//   modeling/dimensions.ts:24         ← modeling lineage FQN
//   modeling/model-metrics.ts:54      ← the existing fqn field of metric bindings
//   sync/generate-ddl/route.ts:14     ← DDL generation
// The migration tool [rewrites in the same batch] `public.` → `proj_<id>.` / `shared.` in existing metadata (classification / lineage / metric fqn / OpenMetadata)
// 🔴 End-to-end invariant (multi-region execution specification, section 3.10): the schema / target of the four hops scan→findings→classification→masking must agree;
//    on disagreement, fail closed for sensitivity levels L3 / L4 (masking today fails open: on exception it returns the raw rows)
```

### 3.11 Replacing the `public.` placeholder in cookbook / codegen / templates (P0-8; jointly with the multi-region execution specification, section 3.11)

```
// Current state: the 6 sites whose GRANT is revoked [also] hard-code public. table names (cookbook/seed/glue.ts:307 `GRANT ALL ON public.dws_channel_roi`,
//      types/etl-job.ts:92 `public.sales_by_region`, codegen.ts:54 instructs the AI to use bgp-workgroup/dev + GRANT PUBLIC);
//      cookbook/seed/redshift.ts has many `public.<...>` (numerous occurrences in lines 112-287)
// Ruling: the platform injects at [generation time] — renderRecipe(recipe, {targetId, projectId}) substitutes the schema with
//      proj_<id> (business data) or shared (global knowledge); the output contains [real values, no <placeholder>] (does not violate the anti-placeholder rule of fissure B)
// The codegen prompt changes to: "the schema / workgroup are injected by the platform; do not hard-code public / bgp-workgroup / dev; do not GRANT PUBLIC"
// 🔴 The compiled core-dist copies (infra/agent/genbi/core-dist/cookbook/seed/{glue,redshift}.js) are changed at the source and redistributed by core-prebuild
```

---

## 4. List of change points

**A. New**: `POST /projects/copy-resource`, `PUT /datasources/[id]/share`, the `projectSchema()` single source of truth, the `fqn→{projectId,targetId,kind}` ledger, provisioning of the `shared` schema, per-(target, project) role / secret, the front-end "Sharing settings" + "Copy to project…". **No new tables** (the handle table belongs to the multi-region execution work).

**B. Changes (by layer)**:

| Layer | Item | file:line |
|---|---|---|
| Guards, gap B part 1 (7 surfaces with side effects) | requireProject / guardResourceAccess + recordAudit | redshift/execute:9, sync/execute-ddl:14, workflow/airflow:9, schedule/enable:13, redshift/cancel:8, datasources/test:13 + heartbeat:13, sync/generate-ddl:9 |
| Guards, gap B part 2 (read leakage) + | as above + model-metrics compute | schemas\|tables, monitor/tasks/logs:10, redshift/history:11, **model-metrics/[id]/compute:9** |
| **Result retrieval** | unified queryHandle | `result/[id]` (the first stage) + 5 class-A and 4 class-B submission points, 9 in total (criterion = whether the id leaves the server) (section 3.6) |
| task-runs | **13 write points** `{projectId,targetId}` (+ the composite runId of the multi-region execution work) | 9 inside the platform (start:185, :464, start-realtime:121, workflow trigger:72, etl job-service:71, **engines/emr/run-record:18**, backfill execute:97, **scheduler/dependency:31, :64**) + 4 on the MWAA bypass (runtime-lib:146, etl/dag-generator:152, **engines/emr/dag-generator:85**, workflow/dag-generator:126) [🔴 path correction: emr is in `lib/engines/emr/`, dependency in `lib/scheduler/`] |
| projectFilter | + sharedTo + keep legacy; read side split into classes A / B | guard.ts:74-85 |
| canCreate tightened | remove developer | projects/route.ts:32-36 |
| Data plane L1 / L2 / L3 | revoke GRANT × 6 + `projectSchema()` derivation + three credential classes + `shared` + migration | sections 3.0 / 3.4 / 3.5 / 3.7 / 3.8; the two caches admin-secret:13 / zeroetl:69 |
| Metadata FQN | **9 sites** converged + existing records rewritten (revision 1.2 correction: the body of section 3.10 had long stated "the earlier 8 sites missed the most critical one, the 9th on the write side", but this table had not been synchronized) | section 3.10 |
| cookbook / codegen | generation-time injection + core-dist redistribution | section 3.11 |
| Project deletion | cross-target reclamation | project-service.ts:162-178 |

---

## 5. Acceptance (implementation level)

- [ ] A developer creating a project gets 403; manager / admin can create; a developer-owner managing members gets 403.
- [ ] **Positive / negative matrix over the 13 privilege-escalation surfaces**: on every surface a member passes + a non-member gets 403; `workflow/airflow` gives non-admins 403; after a high-risk route, `bgp-audit` has a record.
- [ ] **Query handle (first stage)**: A using B's statementId gets 403; expired gets 410; the handles issued by all 9 submission points — 5 class A + 4 class B (criterion = whether the id leaves the server) — fetch results normally (**no legitimate query is falsely rejected**).
- [ ] `model-metrics/compute` rejects non-admins (not "proj-default members are let through").
- [ ] Sharing: A→B is visible / referenceable, **not editable / deletable / re-shareable** (403); **the party shared with cannot trigger runs** (the negative case of `isReadOnlyAction`); all 8 types + configuration resources work.
- [ ] Copy: **multiple same-name hits return candidates for the user to choose** (no guessing); `triggers` are stripped; a failed snapshot before overwrite aborts; **a failure midway through dependency copying → the copies already written are rolled back in reverse order and the target project has no orphans**.
- [ ] 🔴 **Data-plane isolation hard gate**: a member of A running `SELECT * FROM proj_B.*` **is rejected** (with the project credential, not the admin secret; assert on the connection's `current_user`, not on the error text).
- [ ] 🔴 **`shared` in both directions**: any project member **can read** `shared.dim_code_*` (code tables are globally available); but **cannot write** `shared` (only the admin-DDL provisioning identity can write); `shared` **contains no business data**.
- [ ] 🔴 **Each of the three credential classes holds**: ① a project context that cannot obtain a credential **is refused** (no fallback to admin); ② governance / metrics / quality / sensitive-data scan **still work** and their responses **contain no proj_* detail rows**; ③ **DMS creating `dms_ingest`, modeling landing code tables and L3 creating `proj_` schemas all succeed** (class ③ is not killed by mistake by fail-closed).
- [ ] 🔴 **GRANT PUBLIC down to zero**: the inspection scans the whole repository + `TO PUBLIC` in the warehouse == 0 (all 6 sites revoked + existing grants migrated + core-dist redistributed).
- [ ] 🔴 **Metadata FQN convergence (against PII exposure)**: after migrating to `proj_` / `shared` — masking **still takes effect** (sensitive columns are masked in the results, **not in clear text**), lineage **has not degraded** (table- and column-level edges still exist), Ask-Your-Data **can retrieve the migrated tables**; **deliberately making the classification disagree with the actual schema → L3 / L4 are refused by fail-closed** (not silently returned as raw rows).
- [ ] 🔴 **Reverse regression for revoking GRANT / migrating schemas**: legitimate reports / Ask-Your-Data / BI / DataAPI within the project **still return data** (assert that row counts / charts have not dropped to zero); produce the dependency list first, then revoke gradually.
- [ ] 🔴 **Unit tests for the composite credential key**: different projects in the same target obtain different credentials / schemas; the cache never crosses projects or targets; both caches are covered; merged into the lock-parity unit-test surface of the multi-region execution work.
- [ ] task-runs: a member of A cannot see B's runs; **the read side carries the legacy fallback** (existing records do not disappear); **platform aggregation adds no project filter** (finops / baseline / alerting do not undercount existing records); read and write sides ship in the same batch.
- [ ] **Migration safety**: ownership is routed by the **table-creation ledger** (not after-the-fact reverse lookup); no ledger record → `proj_default`, claimable; the migration is **idempotent and re-entrant**; before DROP there is an S3 backup + approval + an inspection for unmigrated tables.
- [ ] **Cross-target reclamation on project deletion**: after deletion, **every target** (including other jurisdictions) has no residual `proj_<id>` schema / role / secret; the operation leaves a trace.
- [ ] The contract guard reports zero FAIL; the new contracts `project_isolation` / `grant_public_zero` are added.

> Construction order: **the query-handle stage (the multi-region execution specification, section 0; first of all)** → the first phase (guards + permissions + L1 revoking GRANT [needs gradual rollout]) → the second phase (project-scoped monitoring, in the same batch as the first multi-region execution construction phase) → the sharing phase → the copy phase → **the data-plane phases L2 / L3 + `shared` (scheduled after the multi-region target-identity work, jointly with the three credential classes of section 3.4)**. Acceptance scripts stay local to the developer machine and are never committed.
