# Design — Workspace Resource Isolation Completion + Cross-Workspace Copy

> Revision: **1.11** (🔴 2026-09-04 **the credential-supply construction phase fully closed (including real-environment headless-browser acceptance 44/44 green + 1 item recorded as-is)**: ① 🔴🔴 **The very first execution in a real environment caught a real bug** — the `create-project-schema` template
> used to produce `ALTER SCHEMA … OWNER TO "role_proj_<id>"`, whereas **a Redshift schema owner must be a user; a role cannot be an owner** (the real environment reported `ERROR: user "role_proj_proj_01m1n2ap…" does not exist`).
>
> - Requirement source: raised on 2026-08-26 as a customer requirement: ① "Workspaces need to isolate resources; today nothing is isolated. Starting from the data source, at every step it must be possible to choose which resources a workspace can see and access"; ② "Only administrators and R&D
>   managers may create and configure workspaces; no other role may perform these operations"; ③ "If one set of code lives in workspace A, can it be copied directly into workspace B? The precondition is that the account has access to both A and B; the case where the target workspace already has a
>   task with the same name must be considered; and the necessity must be evaluated (test/production can be separated either by workspaces or by the existing dev/prod release flow — both are reasonable)".
> - Upstream: [multitenancy-rbac](./multitenancy-rbac.md) (multi-tenant RBAC, implemented) / [versioning-rollback](./versioning-rollback.md) (version snapshots) / [multi-environment-release](./multi-environment-release.md) (multi-environment promotion) / the default-user physical-partition debt
>   (filed as a separate item, not started).
> - 🔴 Red line: this document is design only; no code is written without an explicit instruction.
>
> Earlier revisions (7) are in the collapsible list below.

<details><summary>Revision history</summary>

- **Not one of the 1801 unit tests caught it**, because the template had zero production callers since it was introduced, and the gate only asserted "the role name appears somewhere in the string" — **that gate was actively pinning the bug in place**; changed to owner = login user (which is actually closer to the original intent) + supply order changed to shared→role→**login**→schema→grant-role-to-login→grant, the gate changed to per-operation assertions + negative assertions, and the two mutation tests each fail for the correct reason. This is the second real-world confirmation of the engineering lesson that unwired code is unverified code. ② Another real-environment problem fixed: `execOnTarget` polled with a fixed 1 s starting interval ⇒ non-home supply hit an **ALB 504**; changed to start at 150 ms with ×1.6 backoff capped at 1 s. ③ Hard acceptance evidence: **the non-home target really created the secret in us-west-2 and the schema/user really exist in that region's database** (the hard criterion of decision ①) · **the cross-project negative test is refused by Redshift itself** (with a positive control) · **`SELECT current_user` = `user_proj_<id>`** (proves the identity really was switched, an order of magnitude stronger than "the query did not fail") · **all three observability pieces for fallback landed** (audit + alert + CloudWatch metric, three dimensions) ⇒ the open item "console.warn alone is not closure" of the specification section 3.9b is closed · **the single write channel of section 3.9b ran for real for the first time** (reverse transition refused / missing confirmation string refused / missing items refused and listed / epoch 0→1 / replay refused). ④ ⚠️ **Recorded as-is: `isolated` was deliberately not pushed for real** — it is monotonic and irreversible, and its precondition should not be satisfied before the data migration of the next construction phase; only its full validation logic was verified. ⑤ One stale statement corrected: `redeploy-platform.sh` has **long** derived `-c execution-regions` from the registry on its own (added during the multi-region self-contained stack-group phase); nobody has to pass it. Details in the multi-region roadmap record)
- revision 1.10 (🔴 2026-09-04 **credential-supply slices ③④⑤ closed on the code side**: section 13bis.5 landed — **the closed executor `executeAdminDdl()`** [nine fixed steps per section 3.9a, audit **before** execution, credentials **after** validation] + **the second entry point `provisionProjectLogin()`** [🔴 **passwords never enter a template**: the author's earlier draft of the deliverable added `create-project-login` to the templates and stuffed the password into ctx, which directly conflicted with the decision already hard-coded in `admin-ddl-templates.ts`; it was reverted; changed to the permission-only `grant-role-to-login` (zero literals) + the password never leaves `provisionProjectLogin`, the audit keeps only a fixed redacted descriptor] + **six supply steps** [order = dependency order, not the order the contract is written in: role before the schema's OWNER TO, user before GRANT ROLE] + **a real implementation of `lookupProjectSecretArn`** [🔴 a read failure must throw; it must not be treated as "no credential" ⇒ otherwise a single throttling event would dismantle the isolation] + **18 call sites statically classified and wired** [12 pass project / 4 are governance-read and by contract pass none / 2 bootstrap and inventory / 1 awaiting the data-migration phase] + **the four observability pieces of section 3.9b** [including **zero tolerance** for a fallback appearing in `isolated`: highest-severity alert + direct throw, as a second line of defense] + **two production caller endpoints** [without them the supply layer is "code that has never been verified"]. 🔴 **One IAM statement was still missing**: slice ① only opened "write"; reading the per-project secret was still pinned to home ⇒ on a non-home target the failed read would be interpreted as "no credential" and **silently fall back to admin**; a second execution-axis statement was added (resource surface only `bgp/project/*`), `EXEC_AXIS_EXPECTED` 1→2, the three statements moved into a standalone ManagedPolicy (otherwise CDK splits on 10 KB overflow and the synth gate turns red on the spot). 🔴 **One boundary the user must know about**: the precondition of `PER_PROJECT_CRED=on` is that **the data migration of the next construction phase** has moved the data into `proj_<id>` — the per-project identity cannot see `public`, so "feature conservation" can only be claimed with the flag off; with the flag on the criterion is the **isolation property**. Gates: vitest **1801/109**, tsc 0 on both sides, naming-parity ✅, synth-gate ✅; **all 10 mutation tests of this batch fail for the correct reason**. **Not done**: real-environment deployment + headless-browser acceptance of the five credential-supply acceptance segments [deployment must carry `-c execution-regions=us-east-1,us-west-2`])
- revision 1.9 (🔴 2026-09-04 **credential-supply phase in progress**: new **section 13bis construction ledger** — slice ① **root fix** of the region segment of resource ARNs [42 occurrences measured, single exit + mandatory axis declaration with reason, only 1 opened, byte-by-byte synth comparison before/after shows only that one changed]; slice ② fixes a **live fail-open** [`registerTarget` hard-coded `legacy-seeded` for new non-home targets ⇒ indefinite fallback to the shared admin] + deadline validation consolidated into a single author + **an existing unit test was pinning that fail-open**, corrected and strengthened; section 13bis.3 records one **explicit deviation from section 12 item ⑤** [the secret name was moved to the existing author of project-derived names, because following item ⑤ literally would hit the "no ghost resource registration" gate and the naming single source of truth has no project dimension]; section 13bis.4 fills one **contract gap** [the project-isolation specification section 1 only defined the project DB role, not the login user; now defined as `user_proj_<sanitize(id)>` and fed back])
- revision 1.8 (🔴 2026-09-03 **run-ledger phase closed**: new **section 13 construction ledger** — ① `bgp-task-runs` consolidated into a **single write channel**, all 27 row-creation/write-back sites closed [including **4 MWAA bypass Python copies**; changing only the TypeScript side cannot stop the generated side], the three real failure classes "missing stamp / ghost row / reserved word without alias" eliminated structurally; ② read side `monitor/runs` gains authorization + project filter + a fix for **Limit×Filter silent under-reporting**, and lands the **region filter and column** of the multi-region interaction design section 3.3; ③ while inventorying the read side **a live privilege-escalation surface was caught** and fixed [Copilot `check_run_status` received the caller identity but ignored it ⇒ run records readable across projects]; ④ **section 12.4 corrected**: the write-point numbers in the three documents are in fact consistent; the author had misread the denominator [23 = TypeScript side, 27 = including Python copies, 13 = row creation]; ⑤ two real-environment headless-browser acceptance segments all green [**17/17 + 13/13**], and one **acceptance gap** recorded as-is: runtime-lib v3 was not verified in a real environment because the live flag is legacy. Details in the multi-region roadmap record)
- revision 1.7 (🔴 2026-09-03 **new section 12, pre-construction fact check for the credential-supply phase**: ① two things the contract requires **do not exist in code at all** [the closed executor `executeAdminDdl` is not written / `lookupProjectSecretArn` is a deliberate stub]; ② **one live fail-open** — `registerTarget` hard-codes `legacy-seeded` for newly created non-home targets, while section 3.9b requires new targets to start at `provisioning` [difference: legacy-seeded requires no deadline ⇒ indefinite fallback to the shared admin]; the real environment's `tgt_usw2_a` is in exactly this state, **a must-fix of that work package**; ③ **only home can go first** [the TaskRole's CreateSecret permission ARN is pinned to the deployment-time region] + the naming single source of truth lacks a project dimension; ④ the run-ledger write points measured at **23 sites / 12 files** [neither 13 nor 27] and `monitor/runs` additionally has the Limit×Filter silent under-reporting. Construction plan and pending decisions in the multi-region roadmap record)
- revision 1.6 (**the guard phase fully closed**: code + **two real-environment headless-browser acceptance segments all green** [segment ① privilege surfaces / configuration-permission matrix **37/37**, segment ② layer-1 end to end **18 items, 0 failures**]; including a "positive control" to rule out false greens and "0 hits in the Glue scripts actually running on S3" taking the artifact as evidence; details in section 11.5a]; acceptance caught another **real bug**, already fixed: `assertProjectId` accepted only lowercase while the platform's `ulid()` produces **uppercase** ⇒ `projectSchema()` rejected every real projectId ⇒ the fail-closed pre-check for deleting a project made **every project undeletable** [correction in the project-isolation specification section 3.0])
- revision 1.5 (**guard phase closed on the code side**: ① **layer 1 landed** [2026-09-03] — the real sites are **8, not 6** (section 11.4a: the compiled copy `infra/agent/genbi/core-dist/cookbook/seed/glue.js` **exists, is tracked by git, and is the copy the GenBI container actually loads**; the previous ledger entry saying "does not exist" is void) + root cause removed (execute-ddl unified on the admin secret) + hard guardrails on the generation side of all three engines (rules have a single author, `seed/shared-rules.ts`) + scan gate with 16 cases [including the compiled copy, all 5 mutations red] + section 11.4b records one **behavior change** as-is (non-platform identities can no longer write to platform-created tables — this is the intent, not a regression); ② **configuration-permission tightening landed** [2026-09-03] — single author for the criterion (front-end visibility and back-end 403 use the same function) + 6 landing points + project-deletion inventory of 12 resource classes (paginated + fail-closed when the warehouse cannot be queried) + group-name single source of truth `lib/auth/groups.ts` + an incidental fix of the `approvals/[id]` existence oracle + gate with 24 cases [all 7 mutations red, one pagination assertion **was a fake gate in its first version** and was rewritten as an executable assertion]; ③ real-environment headless-browser acceptance in progress; the guard phase is not declared closed until it finishes)
- revision 1.4 (🔴 2026-09-03 **guard phase started**: new section 11 construction ledger — ① **the pre-construction fact check overturned the "current state" column of the specification** [of the 13 privilege surfaces **5 had already been closed by later batches**; building from the old draft would have modified routes that are already guarded = pure risk]; ② the **10 surfaces** this batch really has to fill, ordered by harm, with their additional fixes [airflow back door / history shared platform-wide / blind Update in schedule / two injection paths in generate-ddl / model-metrics verifies identity but not authorization]; ③ **monitor/runs deliberately postponed to the run-ledger phase** [task-runs has no projectId today; adding the filter now would make every existing run of non-default projects disappear]; ④ **section 11.6 corrects the layer-1 fix**: the specification's "revoke all 6 TO PUBLIC sites, small change" does not hold — a bare deletion would break the sync chain; changed to **remove the root cause** (unify the DDL identity on the admin secret). **10/10 surface guards landed + guard-coverage gate with 24 cases [4 mutations each red for the correct reason]**; layer 1 and configuration-permission tightening not finished)
- revision 1.3 (🔴 2026-08-31 synchronized with decision A: the credential paragraph used to say "missing ⇒ fail-closed, **never fall back to admin**", which collided with the transitional states of the multi-region specification section 3.9; now made precise as [state + time boundary] and pointing to the multi-region specification section 3.9b as authoritative)
- revision 1.2 (🔴 2026-08-29 **external audit remediation**: sequences changed to pure pointers, see the multi-region design section 20.8)
- revision 1.1 (🔴 2026-08-29 **convergence-check remediation**: ① section 2 withdraws two claims that no longer hold, "all pure attribute additions, zero table migration" and "no new tables" (key changes belong to the multi-region specification sections 1.2 / 3.3; 2 new tables; the data plane of section 7bis has a heavy migration including DROP); ② **the new table `bgp-table-ownership` (table-creation ledger) added** — the multi-region specification section 1.3a had long said "created by this module, synchronized into the project-isolation specification section 1", but the feedback was never applied; the three project-isolation documents had zero hits, so building from the old draft nobody would have created the table and the acceptance criterion for table ownership would have had no basis; ③ `bgp-task-runs` / `bgp-sql-history` gain `targetId`)
- revision 1.0 (🔴 2026-08-28 specification-level deep review + decision #2 folded in, aligned with the **multi-region design/specification revision 3.0**: ① **#2 region × project, two dimensions** — modeling physical tables = definition global → structure materialized per target → within each target **global knowledge lands in the `shared` schema** (GRANTed to all `role_proj_*`, **neither PUBLIC nor proj_**), **project-private business data lands in `proj_<id>`** (see section 7bis.2a); ② **layer-3 fail-closed split into three classes** — adds **class ③, the controlled admin-DDL supply identity** (DMS creating `dms_ingest`, modeling landing tables, and **layer 3 itself creating the `proj_` schema**: the bootstrap-paradox solution); the original two classes would have broken these three paths; ③ **metadata-side FQN consolidation of 9 `||"public"` sites** (masking / lineage / OpenMetadata / Ask-Your-Data retrieval / modeling; a classification that cannot be matched after migration = **de-masked plaintext PII**, section 7bis.2b); ④ **the `statementId→projectId` mapping upgraded to the queryHandle of the multi-region specification section 3.7** (unified, includes fixing the live IDOR, **a standalone security fix scheduled first**); ⑤ **cookbook `public.` injection at generation time** (jointly with the multi-region specification section 3.11, dissolving the anti-placeholder dogma); ⑥ identity unified on the multi-region **`targetId`** (data-plane objects exist along the two dimensions (targetId, projectId)). Implementation-level details: the **specification revision 1.1** is the only contract.
- revision 0.12: 🔴 wrap-up of the composite review: the governance system identity of section 7bis layer 3 ② redone — the review proved that "cannot read proj_*" cannot be built (Redshift has no "may aggregate but may not read" permission), changed to "**acknowledge a controlled cross-project global reader + read-only + return-shape constraints [verdicts/counts only, no rows] + strong RBAC closing the model-metrics compute logged-in-only hole + audit**"; section 0.2 gap B.2 adds `result/[id]` and `model-metrics/[id]/compute` (logged-in-only hole) as two privilege surfaces; section 7bis adds the cross-project data-movement ban (no UNLOAD/datashare to other projects); section D1 adds the ingestion-side hard gate + approval for cross-jurisdiction sources with sharedTo; section 9 adds platform-identity / result[id] acceptance; section 7bis.4 wording de-duplicated.
- revision 0.11: layer-3 fail-closed in two classes + section 7bis.4 default (a);
- revision 0.10: three closure items from the review;
- revision 0.9 design draft) | Date: 2026-08-26 (revision 0.12: 2026-08-28) | Status: 🚧 **Under construction (the guard phase has landed on the code side, real-environment acceptance in progress)**; the run-ledger, data-plane and migration phases not started

</details>

---

## 0. Ground Truth Today (deep-dive conclusion, correcting the impression of "no isolation at all")

The **accurate statement** of "resources are not isolated today" is: the platform **already has** the workspace entity and application-layer isolation of the core resources ([multitenancy-rbac](./multitenancy-rbac.md)), but **four classes of real gaps** exist, which the user perceives as "no isolation". All evidence is given as file:line:

### 0.1 Already isolated (results of multitenancy-rbac / multi-environment-release, no rework needed)

| Module | Isolation mechanism | Evidence |
|---|---|---|
| Data sources | item stamped with projectId + `projectFilter` Scan filter + by-id `guardResourceAccess` | `api/datasources/route.ts:31-34,143`; `[id]/route.ts:18,35,106` |
| Sync / batch jobs / multi-engine / Flink / workflow / Redshift tasks | same as above, plus env filter | `api/sync/route.ts:28-35,86`; `etl-jobs:19-22,51`; `engines:23-26,63`; `flink/jobs:19-22,106`; `workflow:13-25,69` |
| BI reports / dashboards / analyses, Data Service DataAPI, Ask-Your-Data definitions / skills | **key-based isolation** (pk = projectId, the strongest) | `lib/bi/reports.ts:70-75`; `lib/data-service/store.ts:24-26`; `lib/genbi/context.ts:18,40` |
| Alerts / SLA / backfill / incidents / Copilot plans | projectId attribute, or pk contains projectId | `lib/alerting/rules.ts:61-70`; `lib/baseline/sla-service.ts:12`; `lib/backfill/types.ts:52-55`; `lib/incidents/store.ts:14` |
| Project entity / members / roles / approvals | bgp-projects / bgp-project-members (GSI byUser) / bgp-approvals; strict membership `resolveRole` (non-members 403, platform admin excepted) | `lib/projects/project-service.ts:83-104,245-273`; `guard.ts:24-94` |

### 0.2 Gap list (what this module remediates)

**Gap A — global modules ignore the project header entirely (the main place where the "every step" requirement falls short):**

| Module | Current state | Evidence |
|---|---|---|
| Modeling (layers / domains / standards / code tables / dimensions / metric system) | globally shared, readable when logged in, writable by platform admin, items have no projectId | `api/modeling/layers/route.ts:9-22` |
| Metrics store | same as above | `api/metrics/route.ts:9-27` |
| Governance (quality rules / classification / catalog / lineage) | global; quality rules pk = table FQN with no project dimension | `api/governance/quality-rules/route.ts:9-38` |
| **Monitoring monitor/runs** | **no guard at all, cross-project full Scan**; and `bgp-task-runs` items **have no projectId field** (missing at the table-structure level) | `api/monitor/runs/route.ts:6-60`; comment in `lib/copilot/tools/read-tools.ts:105` |
| Audit | global | `api/audit/route.ts:8-15` |

**Gap B — action routes without a project guard (privilege-escalation surfaces; ⚠️ after the fact-check review the list grew from 3 to 10, **and after the composite and specification-level deep reviews to 12 in total** (adding `result/[id]` and `model-metrics/compute`)):**

The original draft listed only 3 items; a route-by-route fact check found **10 unguarded routes with side effects or cross-project reach** (gap B.1: 7 with side effects + gap B.2: 3 read leaks; all protected only by the middleware JWT, usable by anyone logged in), graded by harm:

*Gap B.1 — side effects, cross-project write or execute (security in nature, must be fixed in the guard phase):*
- `api/redshift/execute/route.ts:9-12` — **the SQL editor executes arbitrary SQL under the unified admin identity with no project guard**; the middleware only blocks an analyst-only allow-list (`middleware.ts:61-67`), developer and above pass freely. This is the largest data-plane entry point for "isolation starting from the data source".
- `api/sync/execute-ddl/route.ts:14` — **executes arbitrary DDL under the platform identity and after creating a table automatically runs `GRANT ALL ON <table> TO PUBLIC`** (:36); it can create and drop, no less harmful than execute, **missing from the original draft**.
- `api/workflow/airflow/route.ts:9` — **any logged-in user can obtain an MWAA web login token** and, once in the Airflow UI, trigger/pause the DAGs of **all projects**; **this is a back door around every project guard of the platform** — it remains after decision D3 fixes the other gaps and must be closed in the same batch.
- `api/schedule/enable/route.ts:13-15` — enabling/disabling schedules, overwriting DAGs and unpausing do not check the project; branches on taskType across two tables (:18/:71), and the sync branch performs an unconditional blind Update for a non-existent taskId.
- `api/redshift/cancel/route.ts:8` — cancels any statementId, cross-project interference.
- `api/datasources/test/route.ts:13` + `[id]/heartbeat/route.ts:13` — connection test / heartbeat against any project's data source and **writes back its status/testResult** (cross-project write).
- `api/sync/generate-ddl/route.ts:9` — the admin session runs information_schema; schema/tableName are **concatenated into SQL as strings** (:29, injection surface).

*Gap B.2 — cross-project read leaks:*
- `api/datasources/[id]/schemas|tables` (browse the table structure of any data source, `schemas/route.ts:10-14`).
- `api/monitor/tasks/[id]/logs/route.ts:10` (read the run logs of any task/workflow from S3 + CloudWatch; **the original draft listed only monitor/runs and missed logs**).
- `api/redshift/history/route.ts:11` (one SQL execution history shared platform-wide including SQL text; any logged-in user sees other projects' queries).
- 🔴 **`api/redshift/result/[id]/route.ts:9-51` (threat-model finding of the composite review, caught only by a combined review)**: rows are fetched **by statementId alone, with no `requireProject` / `guardResourceAccess`** (only `resolveIdentity`, for masking);
  - the per-project execution credential of layer 3 **does not govern "fetching a finished result"**.
  - Whoever obtains another project's statementId (through the currently shared SQL history / an id held by the front end / the cancel enumeration surface) reads that project's result rows.
  - The multi-region design section 8.5.7 ① caught it only on the jurisdiction axis and **missed the project axis**.
  - Fix: 🔴 **revision 1.0 settles on a "server-side queryHandle"** (uniformly defined in the multi-region specification sections 0 / 3.7, **replacing** the original "statementId→projectId mapping" plan): an unforgeable handle is issued on submission (bound to ownerSub/projectId/targetId/jurisdiction/expiresAt), and fetching rows requires the handle and verifies it;
  - **listed as a standalone security fix, scheduled first**.
- 🔴 **`api/modeling/model-metrics/[id]/compute/route.ts:9-12` (composite review, usable by anyone logged in)**: **only `resolveIdentity`, no `isPlatformAdmin` / no project-membership check**, yet it calls `execScalar("SELECT <agg> FROM <fqn>")` (any fqn) → any logged-in user can read `SELECT SUM(salary) FROM proj_B.*` under the platform identity (a dimension `GROUP BY` leaks 50–60 slices at once).
  - Fix: add a project/admin guard (same source as the strong RBAC on the controlled service identity of section 7bis layer 3 ②).

*Gap B.3 — account-level metadata leaks (medium-low; add requireAuth/admin in the same batch as appropriate):* `s3/buckets` (ListBuckets of the whole account), `datasources/discover` (all RDS instances), `flink/network` (VPC / subnets / security groups), `redshift/connections|databases|schemas`, `settings` (role ARNs).

**Gap C — single physical partition (filed separately as the default-user partitioning item; not done by this module):**
All resource tables still physically use pk `userId="default-user"` (`lib/auth/identity.ts:23`); isolation is application-layer logical isolation; the platform-wide hard-coding of default-user **measures about 102 lines** (platform/src + infra/lib, excluding node_modules; ⚠️ the "5848 occurrences" in the master plan's row for that item is a stale, incorrect figure that counted node_modules / build artifacts, off by roughly 40×; it directly affects the effort estimate of that item and should be corrected there). **This module keeps working at the application layer, decoupled from that item** — when that item changes the keys, this module's projectId attributes / filter logic are preserved unchanged.

**Gap D — project creation permission too broad (new customer rule):**
Today admin / **manager / developer can all create projects** (`api/projects/route.ts:29-36`); member management is done by the project owner (`projects/page.tsx:169`). The new rule: **only platform administrators (bgp-admin) + R&D managers (bgp-manager) may create and configure/manage**.

### 0.3 The honest boundary of data-plane isolation (🔴 changed by decision C2 to **do it in phase one**; this section is kept as the conceptual clarification "control plane ≠ data plane")

- Control-plane isolation (visibility of resource definitions) ≠ data-plane isolation (accessibility of the underlying data).
- Current state: all projects' syncs land in **the same** Redshift workgroup (`bgp-workgroup` / db=dev) and in namespaces of the same S3 Tables bucket;
- Redshift execution uniformly uses the admin credential.
- ⚠️ Weaker still, `execute-ddl` actively runs `GRANT ALL ON <table> TO PUBLIC` after creating a table (:36) — it is not "only someone who knows SQL can find it"; the platform **explicitly grants new tables to PUBLIC**;
- the data plane today is more open than a "shared database".
- Even with the control plane fully isolated, a user who knows SQL can still reach other projects' tables through the SQL editor / Ask-Your-Data.
> 🔴 **Decision C2 of 2026-08-27: data-plane isolation is done in phase one (a major upgrade), no longer deferred to phase two.** Phase one of this module therefore covers control-plane isolation + **true data-plane isolation** (an independent schema / DB user / Lake Formation grant per project + revoking `GRANT ALL TO PUBLIC`), **which is heavy Redshift data-plane rework** (credentials / query identity / migration of existing data / Lake Formation; corrected by the cost review: the earlier comparison "same magnitude as the default-user partitioning item" was loose — the measured default-user hard-coding is only about 102 lines; the weight is on the Redshift side itself). See the new **section 7bis, phase-one data-plane isolation design**.

---

## 1. Design Decisions

### D1. "At every step, choose which resources a workspace can see" = ownership isolation + explicit sharing (two layers)

The requirement has two readings; the design covers both:
- **Ownership (owner project)**: every resource belongs to one project (already the case today) and is invisible to non-members — this is the default.
- **Sharing (share to projects)**: an editor or above can explicitly share a resource with other projects (**read-only reference**); the typical scenario is one production MySQL data source referenced by sync tasks of several projects, without each project registering the connection and credential again.

- Implementation: the resource item gains an optional attribute `sharedTo: string[]` (list of project ids) or `sharedTo: ["*"]` (visible platform-wide, e.g. public code tables).
- `projectFilter` is extended to `projectId = :p OR contains(sharedTo, :p)` — ⚠️ today's `projectFilter` still contains the compatibility branch `attribute_not_exists(projectId)` for proj-default (`guard.ts:78-83`); the extension must **keep that branch**, otherwise every legacy resource without a projectId vanishes from the view.
- A shared resource is **read-only and cannot be re-shared** in the target project (prevents transitive sharing);
- editing/deleting remain in the owner project only.

> 🔴 **`guardResourceAccess` must recognize the three `sharedTo` states (threat-modeling review: preventing "sharing = confused deputy" privilege escalation)**: the by-id guard today only distinguishes two states, "member of the owner project or platform admin".
> After sharedTo lands it must become **three states**: ① **member of the owner project** = read/write (edit / delete / re-share);
> ② **member of a shared-to project** = **read-only** (may reference, may not edit / delete / re-share);
> ③ **neither** = 403.
> Key point: **a shared-to party's reference must not become a write vector** (confused deputy) — side-effecting actions initiated through a shared data source, such as "connection test / heartbeat writing back status" or "change configuration", must be checked against the **owner project** and refused for the shared-to party (closed at the same place as the secretArn stripping of section 5, threat item T4);
> the guards that decision D3 adds to `datasources/test` and `heartbeat` must decide by the owner project, not the requester's project.

> 🔴 **Sharing scope (decision C3 of 2026-08-27, "both"):** phase-one sharing covers:
>
> 1. **All 8 data-source types**: MySQL / PostgreSQL / Oracle / SQL Server (JDBC) + S3 + DynamoDB + Kinesis + MSK — no longer limited to MySQL; a data source of any type can be shared and referenced across projects (what is shared is "referenceability"; secretArn / connection credentials are never exposed across projects, section 5).
> 2. **More resource categories**:
>    - **Knowledge resources (sharing = referencing the same copy, a natural fit)**: modeling layers / data standards / code tables / metric definitions — note that decision D2 already keeps these "global" (readable when logged in), so their "sharing" is in fact the natural consequence of global visibility; should they be narrowed to per-project in the future, they would be shared explicitly through sharedTo.
>    - **Configuration resources (sharing = reusing a definition across projects)**: sync / etl-job / workflow / redshift-task / engine-job — can be shared with other projects as a **read-only reference / copy template** (complementary to the cross-project copy of decision D5: sharing = read-only reference without a copy, copying = an independent copy).
> - **Uniform sharing granularity**: all types use the same `sharedTo` mechanism + `projectFilter` extension, with identical read-only-reference semantics; the "Share settings" UI is open for every shareable type (no more "switch present but disabled").
> - ⚠️ Boundary with the data-plane isolation of decision C2: what is shared is **the referenceability of the control-plane definition**; the shared-to party can reference the data source to build a sync, but the data lands in **the referencing party's own project schema** (section 7bis); sharing does not break data-plane isolation.
> - 🔴 **Ingestion-side export of a cross-jurisdiction source via sharedTo (composite-review threat item, consistent with the multi-region design section 8.5.0)**: once a data source **unique to a cross-jurisdiction region** (S3 / DynamoDB / Kinesis / MSK) is `sharedTo` a home project, a home user who builds a sync task ingesting its data into the home region performs **ingestion-side cross-jurisdiction data movement** (not "echoing a user's query result" but establishing a **standing pipeline** that moves business data out of the region).
>   This does not fall under "the user takes responsibility for interactive queries" of section 8.5.0 track 1; it is closer to **explicit data movement** — therefore: ① the "data source reachable" pre-check of the multi-region design section 5.1 is raised to a **hard back-end jurisdiction gate** (a task referencing a cross-jurisdiction source can only be bound to that jurisdiction's region; the back end hard-refuses an illegal binding, not merely a greyed-out UI);
>   ② **the sharedTo of a cross-jurisdiction source / a cross-region sync referencing it** gets its own **alert + explicit approval + audit** (echoing the explicit cross-region movement of the multi-region design section 4bis.3);
>   ③ ingestion-side cross-jurisdiction movement is explicitly the user's responsibility and leaves a trace.

### D2. Per-project strategy for the global modules (gap A decided item by item, not one-size-fits-all)

| Module | Strategy | Rationale |
|---|---|---|
| The four modeling pillars + metrics | **Stay global, not per project** (keep admin writes / logged-in reads) | Warehouse layers / data standards / code tables / metric definitions are by nature **the enterprise-wide common vocabulary**; cutting them up per project would manufacture divergent definitions; a leading cloud data-development suite likewise keeps data standards tenant-level. Make it explicit to users that this is a deliberate decision |
| Governance (catalog / lineage / classification / quality) | **Stay globally readable**, but the governance asset list gains a "filter by project" view (asset→project ownership derived through sync tasks / jobs) | Governance's value lies in the global view (cross-project lineage / impact analysis); isolating it would blind impact analysis |
| **Monitoring runs** | **Per project (mandatory)**: ① write side — every `bgp-task-runs` put_item site adds `projectId` (carried over from the task definition); ② read side — monitor/runs gains `requireProject` + a projectId filter (legacy runs without the field belong to proj-default); ③ the Ops Dashboard `/ops` follows | Run records contain task names / error details; cross-project visibility is a real leak surface; and bgp-task-runs is already consumed by cost attribution / baselines / alerting, so adding the dimension serves several purposes (the multi-region module also has to add a region dimension to the same table; **the two modules modify the same batch of write points and must be aligned in one design window**, see section 8) |
| Audit | Kept at platform level (admin sees everything); add a projectId attribute for per-project filtering | Audit is by nature a platform governance tool |

List of `bgp-task-runs` write points (the rework surface, shared with the multi-region module; ⚠️ a whole-repository grep of `PutCommand→TASK_RUNS` in the fact-check review found **13 sites**; the 4 missed by the original draft are added):
- **Inside the platform process (9 sites)**: `api/sync/[id]/start/route.ts:185` (regular) + **`:464` (zero-ETL,**
  - **originally missed)**, **`api/sync/[id]/start-realtime/route.ts:121` (DMS real-time,**
  - **originally missed)**, **`api/workflow/[id]/trigger/route.ts:72` (manually triggered workflow,**
  - **originally missed)**, `lib/etl/job-service.ts:70`, `lib/engines/emr/run-record.ts:17`, `lib/backfill/execute.ts:97`, `lib/scheduler/dependency.ts:31` (sync branch) + **`:64` (dependency-triggered downstream workflow,**
  - **originally missed)**;
- **MWAA bypass (4 sites)**: `lib/workflow/runtime-lib.ts:146`, `lib/etl/dag-generator.ts:152`, `lib/engines/emr/dag-generator.ts:85`, `lib/workflow/dag-generator.ts:126` (legacy).

**Read-side completeness (added by the fact-check review)**: besides the main Scan, monitor/runs at `route.ts:48-53` also joins the four task tables sync / workflows / etl / engine without any filter to map names — **task names leak across projects just the same** and must be filtered by project as well; the Copilot tool `list_recent_runs` (`lib/copilot/tools/read-tools.ts:103-119`) also Scans task-runs in full and must be included in the D2 remediation surface (the original draft cited its comment as evidence but did not list it as a remediation target).

> 🔴 **The read-side filter must carry the legacy fallback branch, otherwise existing runs disappear (data-migration review, highest priority, verified)**: today's FilterExpression in `monitor/runs/route.ts` only assembles status/taskType (**no projectId, no legacy fallback**, verified).
> As soon as a `projectId = :p` filter is added, DynamoDB simply does not match **existing run items without that attribute → they vanish from the monitoring / cost / baseline / alerting views**.
> "Legacy defaults to proj-default" is a semantic claim and **must be realized in the expression**: the read-side filter is uniformly written as **`(projectId = :p OR attribute_not_exists(projectId))`** (a copy of the legacy branch for resource tables at `guard.ts:80` — note that the guard's clause only protects resource tables and **does not automatically cover the task-runs Scan; it must be copied explicitly**).
> The main monitor/runs Scan + the joins + `list_recent_runs` + the finops / baseline / alerting consumers **all** change this way.
> Listed in the section 9 acceptance.

### D3. Add guards to every gap-B action route (mandatory, a security fix in nature; ⚠️ list completed after the fact-check review)

> - 🔴 **Adding a guard must be paired with adding audit in the same batch (threat-modeling review item T5, verified)**: the 5 high-risk data-plane routes `sync/execute-ddl`, `redshift/execute`, `workflow/airflow`, `schedule/enable`, `redshift/cancel` **currently have 0 `recordAudit` calls**
>   (confirmed by a per-file grep) — an attacker (even a legitimate member) who uses these entry points to execute arbitrary SQL/DDL, obtain an MWAA token, revoke a GRANT or cancel someone else's statement **leaves no trace at all in the audit layer**.
> - Therefore **every** high-risk route that gets a guard **also gets `recordAudit` in the same batch**: redshift/execute records the SQL text, execute-ddl records the DDL, workflow/airflow records who the token was issued to, cancel records the target statementId.
> - Listed as a hard acceptance gate in section 9.
> - ⚠️ **MWAA bypass audit blind spot (item T5)**: audit is the application-layer `recordAudit`, but MWAA DAGs / runtime-lib **write task-runs directly from another executor** (the 4 bypass sites of decision D2) without passing through the application layer → no audit. DAG operations triggered from
>   the Airflow UI and direct runtime-lib writes are all blind spots. An independent audit channel is required (CloudTrail Data Events / instrumentation inside the DAG writing back to audit); the application layer cannot be relied on.

*The three originally listed items:*
- `schedule/enable`: add `guardResourceAccess(editor)` — **load the item from the table matching taskType (workflow/sync) first, then take its projectId** (the two branches at :18/:71); and fix the sync branch's unconditional blind Update for a non-existent taskId.
- `redshift/execute`: add `requireProject(editor)`; **bgp-sql-history must carry / filter by projectId on both the read and write sides** (adding only the attribute without changing the GET's single-partition Query by userId would leave the history fully visible, :11). **The data plane is still a shared database** (section 0.3), but the entry point now has a project identity and audit.
- `datasources/[id]/schemas|tables`: add `guardResourceAccess(viewer)`.

*Added by the fact-check review (same-batch hotfix, mandatory):*
- `sync/execute-ddl`: add `requireProject(editor)`, **and revoke / tighten `GRANT ALL TO PUBLIC`** (:36, the largest opening in the data plane).
- `workflow/airflow` (web token): tighten to **bgp-admin only** (obtaining a token = full control of the Airflow UI).
  - ⚠️ **Correction from threat-modeling review item T2**: the original alternative "guard by looking up projectId from dagId" **is technically impossible under the environment-level semantics of CreateWebLoginToken** — once a token is issued, **every** DAG in the Airflow UI is visible and triggerable; dagId granularity cannot be provided.
  - And MWAA is a **single environment** (`ENV_NAME=bgp-mwaa`, all projects' DAGs in the same environment); an admin who enters the UI with a token can still trigger every project's DAGs.
  - Hence the **honest statement: with a single MWAA environment the web token can only be tightened to admin; there is no dagId-level project isolation;**
  - **project-level Airflow isolation requires multiple MWAA environments (one per project / per group), listed for phase two** (expensive: MWAA ≈ $350 per month per environment).
- `redshift/cancel`: add a guard (by statementId ownership, or editor).
- `datasources/test`, `[id]/heartbeat`: add `guardResourceAccess(editor)` (they have the cross-project side effect of writing status).
- `sync/generate-ddl`: add `requireProject` + **parameterized / allow-list validation of schema/tableName** (the injection surface at :29).
- Gap B.3 metadata routes (s3/buckets, datasources/discover, flink/network, redshift/connections, settings, etc.): add requireAuth/admin as appropriate.

### D4. Tightening workspace creation / configuration-management permissions (gap D, as decided)

- **Creation**: canCreate of `POST /api/projects` tightened from admin/manager/developer to **admin/manager** (delete the developer line at `api/projects/route.ts:32-35`).
- **Configuration management** (rename / delete project / add, remove or change members / approval decisions): tightened from "project owner" to **platform admin, or "platform role manager who is also the project's owner"**. A pure developer cannot manage members even when set as project owner (and can still develop resources normally). Landing points: the permission check in `project-service` + button visibility on the `/projects` page + `api/projects/[id]/**` and `api/approvals/[id]`.
- Compatibility: for existing projects whose owner is a developer, the management right lapses automatically (403 with the hint "please contact an administrator / R&D manager" on use); no data migration.
- ⚠️ Ripple effect: the decision maker for membership approvals (requests to join) changes from owner to "admin / manager-owner" — the visibility of the approval list is adjusted accordingly (the `approvals` query).
- 🔴 **Resource pre-check before deleting a workspace (design gap added by the deep review)**: this section previously defined only "who may delete" and **not "what happens when the project still has resources"** — deleting a project without a check would leave **an orphaned data-plane schema `proj_<id>` (the tables created per section 7bis still exist) and task-runs / resources with a dangling projectId**.
  - **Aligned with the "deletable only when bindings = 0" policy for deleting an execution environment in the multi-region design** (pre-check in section 4.4 there: bound resources / schedules / runs must all be 0, otherwise 400): the pre-check for deleting a project = the number of resource definitions in the project (datasource / sync / etl / workflow …), the number of members (excluding the owner), and the number of tables in the data-plane schema **are all 0**, otherwise **400 listing the details + an exit "go migrate / delete the resources"** (not a mere warning that still allows it);
  - a forced delete with resources requires approval + re-typing the project name to confirm (interaction in the new project-deletion scenario of the [interaction design](./project-isolation-interaction.md)).
  - **Default policy = forbid (consistent with the multi-region module); no cascading delete** (cascading data deletion is too risky; listed for phase two).
  - ⚠️ Section 5 of the interaction design previously said "warn when resources exist (still deletable)", which conflicts with this item; this item (forbid) prevails and the interaction design is revised accordingly.

### D5. Cross-workspace copy: do it, by generalizing the promote mechanism (necessity assessment in section 6)

**Semantics**: "copy the definition", not "move" — the source is untouched, a new copy is created in the target, and runtime state / schedule / bindings are all stripped. **Directly generalize `executePromote` of [multi-environment-release](./multi-environment-release.md)** (`lib/env/promote-service.ts:79-150`):
- reuse `PROMOTE_EXCLUDE` (:28-42) to strip runtime bindings (glueJobName / airflowDagId / status / scheduleEnabled / lastRun* …);
- extend the lookup key from `(projectId, lineageId, toEnv)` into **`copyToProject(type, sourceId, toProjectId, {toEnv, conflict})`**: target = `(toProjectId, lineageId?, toEnv)`;
- a cross-project copy **does not share the lineageId** (lineageId means "the same logical resource across environments within one project"; across projects it is a new logical resource — recording `copiedFrom: {projectId, resourceId, version}` for provenance is enough, and avoids polluting the promotion lookup of multi-environment-release).

**Permissions** (decided: "has access to both A and B"): source project ≥ `viewer` **and** target project ≥ `editor` (creation is a write). A platform admin satisfies this by nature.

**Conflict handling** (the problem the customer named): detect **same type, same name** within the target project; the user chooses one of three in the dialog:
1. **Rename** (default, prefilled `<name>-copy`);
2. **Overwrite** (only when the target was previously copied from the same source, i.e. copiedFrom matches; goes through a confirmation dialog; before overwriting, `snapshotVersion` automatically leaves a rollback point — reusing [versioning-rollback](./versioning-rollback.md)). 🔴 **Verified defect from the data-migration review**: today `snapshotVersion(...).catch(() => {})` at `promote-service.ts:129,149` **silently swallows snapshot failures** — the snapshot fails and the overwrite proceeds anyway; "leaves a rollback point" is a false promise. **Must change at construction start: if the pre-overwrite snapshot fails, abort the overwrite (do not catch and swallow); never overwrite when the rollback point was not created**;
3. **Cancel**.

**Dependency handling** (resource reference edges, fully listed in the research):

| Reference | Strategy |
|---|---|
| sync→`datasourceId`, flink→`sourceDatasourceId/sinkDatasourceId` | **exact match by name** of a same-type data source in the target project, rebound automatically; no match → the copy lands as `draft` + the UI marks "missing reference, awaiting rebind" (data sources are not copied automatically — they carry **non-portable physical bindings** such as secretArn / glueConnectionName / networkConfig, `api/datasources/route.ts:140-166`) |
| workflow node→`syncTaskId` | offer a "copy with dependencies" checkbox: workflow + the sync tasks it references are copied as **one bundle** (topological order: sync first, then workflow, rebinding to the new ids); unchecked → lands as draft awaiting rebind, as above |
| `triggers[]` (dependency triggering downstream) | **not carried** (a cross-project dependency chain is meaningless); cleared after copying, with a hint |
| BI dashboard→reportId→apiId, alert→channelIds | **not in the copy scope** in phase one (cross-project copy of BI / alerts is a weak scenario); scope = the same 5 configuration resource classes as multi-environment-release (workflow / etl-job / sync / redshift-task / engine-job) |

**API**: `POST /api/projects/copy-resource {type, id, toProjectId, toEnv?, conflict, includeDeps?}` (double permission check; audit records source / target); the front end adds a "Copy to project…" row action to the 5 resource lists (shown only when the user can see ≥ 2 projects).

### D6. Relationship with multi-environment-release (the dev/prod release flow) (asked: "are both reasonable?")

**Both are kept; they are complementary; the documentation guides clearly**:
- **Test→production within one project**: use the environments + promotion of [multi-environment-release](./multi-environment-release.md) (with approval, lineageId tracking, and idempotent "publish again") — **the recommended path**;
- **Cross-team / cross-project reuse, or isolating two environments at project granularity** (the usage where a customer builds test/prod as two workspaces): use this module's cross-project copy — **also valid**, with the note that it has no lineageId-level "continuous promotion" semantics (each copy is an independent event).
- The platform does not force either mode; the help text on the /projects page states the applicable scenario of each.

---

## 2. Data Model Changes

> - 🔴 **Revision 1.1 correction (convergence check of 2026-08-29): this section's title used to say "(all pure attribute additions, zero table migration)" and the table ended with "no new tables"; neither holds any more** — ① the **composite runId** of `bgp-task-runs` (multi-region specification
>   section 1.2) and the **pk sharding `audit#<targetId>#<day>`** of `bgp-audit` (multi-region specification section 3.3) are both **breaking key changes** (the multi-region module owns migration / backfill; this module owns only the attributes);
>   ② it is settled that **2 new tables** are created;
>   ③ **the data-plane migration `public`→`proj_`/`shared` of section 7bis** includes `DROP` + an S3 backup and is the heaviest migration this platform has ever done.
> - **The accurate statement = "this module itself only adds attributes on the control plane; key changes belong to the multi-region module; 2 new tables; the data plane has a separate heavy migration (section 7bis)"**.
> - At implementation level the [specification](./project-isolation-spec.md) **revision 1.1** section 1 is the only contract.

| Table | Change |
|---|---|
| bgp-datasources and the other resource tables | +`sharedTo?: string[]` (D1); the 5 copyable resource classes +`copiedFrom?: {projectId,resourceId,version,at,by}` (D5) |
| **bgp-task-runs** | +`projectId` **+`targetId`** (D2; write points add the stamp, **changed together with the multi-region module in one batch**; legacy default treated as proj-default / `tgt_home`). ⚠️ **The key change (composite runId + GSI + backfill) belongs to the multi-region specification section 1.2** |
| bgp-sql-history | +`projectId` **+`targetId`** (D3, carried on both the read and write sides) |
| bgp-audit | +`projectId` (D2). ⚠️ **The pk sharding belongs to the multi-region specification section 3.3** |
| 🆕 **bgp-table-ownership** (new table) | **Table-creation ledger** `fqn → {projectId, targetId, kind}`, stamped at table creation (the four paths execute-ddl / codegen / sync / modeling) ⇒ **the sole basis for the ownership decision** of the section 7bis migration and the evidence source for the table-ownership acceptance criterion. The contract is registered in the multi-region specification section 1.3a; **this module creates the table** |
| 🆕 **bgp-query-handles** (new table) | **Defined by the multi-region specification section 3.7** (the standalone first-scheduled fix of the live IDOR); this module therefore **no longer builds a separate** `statementId→projectId` mapping |
| Copy | No new table for copying (the `copiedFrom` provenance attribute suffices); approvals reuse bgp-approvals (add a type later if "copy requires approval" is wanted) |

## 3. API Change List

| Endpoint | Change |
|---|---|
| `POST /api/projects` | canCreate tightened (D4) |
| `api/projects/[id]/**`, `api/approvals/[id]` | configuration-management permission check changed (D4) |
| `api/monitor/runs` | +requireProject + projectId filter (D2) |
| `api/schedule/enable`, `api/redshift/execute`, `api/datasources/[id]/schemas\|tables` | guards added (D3) |
| `api/datasources` (list / by-id) | projectFilter extended with sharedTo (D1); +`PUT /api/datasources/[id]/share` (editor or above in the owner project sets the sharing list) |
| **New** `POST /api/projects/copy-resource` | cross-project copy (D5) |
| Governance catalog | + filter-by-project parameter (D2, read-only view) |

## 4. Front-End Changes

> 🎨 **The front-end interaction design has been deepened into its own chapter, the [interaction design](./project-isolation-interaction.md)** (same specification as the multi-region module) — covering 4 scenarios (workspace management / friendly degradation under tightened permissions, data-source sharing, conflicts + dependency rebinding in cross-project copy, the "why + exit" friendly hint of the privilege guard) × the security-mechanism matrix × friendliness criteria F1–F7 × ASCII wireframes, all anchored on existing UI conventions (the projects inbox / approval drawer, PromoteButton, FeatureGuide, row actions, Modal.confirm). This section lists only the front-end skeleton; interaction details follow that chapter.

- /projects page: the create button is shown/hidden by the new permission; the member-management entry uses the new check; help text (the two modes of D6).
- Data-source list: row action + "Share settings" (shows a "from project X (shared)" badge, read-only state).
- The 5 resource lists: row action + "Copy to project…" dialog (target-project dropdown = projects where I am editor or above; three-way conflict choice; "copy with dependencies" checkbox).
- Monitoring page: automatically filtered by the current project (admin gets an "all projects" switch).
- i18n entries added.

## 5. Security Considerations

- Copying is **read definition + write definition**; it touches no physical resource or secret; data sources cannot be copied, only shared (secretArn is not copied across projects).
- Sharing is an explicit allow-list, private by default; a shared resource is read-only in the target project, cannot be re-shared, and cannot be used to initiate write operations.
- All sharing / copying / permission changes go into bgp-audit.
- 🔴 **Credential exposure surface of shared data sources (threat-modeling review item T4, verified; must be implemented once C3 widens the scope)**: "secretArn is not exposed across projects" was so far only a **semantic claim** and must be realized as a concrete mechanism, otherwise sharing under C3 leaks:
  1. **The control-plane read path must strip secretArn (hard landing point)**: today's GET by-id at `datasources/[id]/route.ts:20` **does `return apiOk(Item)`, returning everything including secretArn**; list behaves the same. When C3 sharing is implemented, **GET by-id / list must strip `secretArn` / connection strings and other sensitive fields for callers from non-owner projects** (allow-list style response); it cannot be merely claimed at the semantic layer of decision D1.
  2. **Credential exposure on the execution side is an inherent cost of sharing (stated honestly)**: `glue-script-generator.ts:157` writes `secretArn` **in plaintext into the Glue script** (landing in the `bgp-glue-scripts` bucket), combined with the single account-wide `bgp-glue-role` (multi-region design section 12.0) → **any project's Glue job can get_secret_value on any secret**.
     - A shared-to party that builds a sync referencing the shared source will, at execution, necessarily connect to the source database and can reach the source credential in plaintext.
     - This is the inherent cost of "sharing = may reference it to run a sync" and must be stated honestly;
     - a complete root fix requires **runtime secret injection (not landing in the script text) + a per-project Glue role**, listed as a phase-two hardening item in the same batch as the C2 data-plane isolation.
  3. **Scan embedded sensitive literals before sharing / copying configuration (item T4, medium)**: C3 extends sharing / copying to the sync / etl / workflow configuration resources; templates such as `types/etl-job.ts:92` embed workgroup/schema literals, and codegen output has historically contained account ids (recorded as requiring redaction). Before sharing / copying, the configuration text must be scanned for embedded account ids / paths / credential-like literals and an alert raised.
- The gap in the D3 guards is in essence a **security fix** (after the fact-check review it grew from 3 items to the 7 side-effecting privilege surfaces of gap B.1 + the read leaks of gap B.2) and should land soon even if none of the other features are built.

## 6. Necessity Assessment (requested)

| Item | Verdict | Basis |
|---|---|---|
| Gap-B guards (**12** privilege surfaces: redshift/execute, sync/execute-ddl, workflow/airflow web-token, etc.) | **Necessary, security in nature** | The fact-check review confirmed the privilege surface is larger than originally estimated; small change, high payoff |
| Per-project monitoring | **Necessary** | Cross-project visibility of run records = a leak; and building it in the same batch as the task-runs dimension work of the multi-region module saves one blast radius |
| Tightening project creation / management permissions | **Necessary, already decided** | Tiny change |
| Data-source sharing | **High value** | Without it, several projects register the same physical database + secret repeatedly; management cost and drift risk are both high |
| Cross-project copy | **Necessary, but positioned as a "reuse tool", not a "release channel"** | The customer's own reasoning holds: test/prod can be separated either by project or by the environment release flow; both paths are reasonable; the independent value of cross-project copy is **cross-team reuse and onboarding new projects** (using mature tasks as templates); reusing the promote mechanism keeps implementation cost controllable (the core is two new pieces of logic: conflict + dependency rebinding) |
| Per-project modeling / governance | **Not recommended** (stay global, reasons in D2) | Enterprise-wide common vocabulary; isolation would hurt impact analysis |

## 6bis. 🔴 Decision Record (2026-08-27, raised by the coverage regression review)

> The coverage review found that the original requirement "**starting from the data source, at every step choose which resources can be seen / accessed**" had been narrowed in three places. They were put up for decision, **with the following outcome (all three settled; C2 / C3 are major upgrades of the phase-one scope)**:

| # | Narrowing | Decision (2026-08-27) | Impact on the design |
|---|---|---|---|
| **C1** | Whether modeling / metrics / governance become per project | ✅ **Agreed to keep them global, not per project**; but stressed that **multi-region heterogeneity** must be handled seriously in the interaction design — tasks choose the region to run in as needed, some regions have specific compute tasks, **some regions hold unique data that other regions do not**; compute tasks are not absolutely identical across all regions | Modeling / governance stay global (D2 unchanged); **new work = the multi-region interaction chapter redoes the "regional heterogeneity" scenarios** (see the [multi-region interaction design](./multi-region-execution-interaction.md): selecting and visualizing region-unique data / region-specific tasks) |
| **C2** | Timing of data-plane access isolation | 🔴 **Do it in phase one (major upgrade)** | Data-plane isolation moves from phase two to the **phase-one main line**: an independent schema / DB credential / Lake Formation grant per project + **revoking the `GRANT ALL TO PUBLIC` back door**. Heavy Redshift data-plane rework; phase one of this module becomes much heavier (see the new section 7bis) |
| **C3** | Scope of explicit sharing | 🔴 **Both (widened)**: ① **all 8 data-source types** (MySQL / PG / Oracle / SQL Server / S3 / DynamoDB / Kinesis / MSK) shareable; ② **extended to more resource categories** — global knowledge such as modeling / standards / code tables / metric definitions + configuration resources such as sync / etl / workflow can also be shared and referenced across projects | D1's sharing scope widens from "phase one: data sources only" to "all data-source types + several resource categories"; the UI switches are all enabled (see the D1 revision) |

**Follow-up actions (driven by this decision)**: ① C2 → data-plane isolation moved into phase one; add the phase-one data-plane isolation design in section 7bis; ② C3 → widen the D1 sharing scope; ③ C1 → add the "regional heterogeneity" design to the multi-region interaction chapter. **Note: C2 / C3 raise the phase-one workload and blast radius of this module significantly; the phasing (section 10) and the risks (section 8bis) must be re-estimated accordingly.**

### 6bis.1 🔴 Cost and Necessity Re-check Conclusion + the "Do Everything" Decision (2026-08-27, cost review)

The cost review did the sober arithmetic, pointed out that phase one of this module is on the full side and that the ROI of two "completeness-driven" items is debatable, and suggested a decision between "lighten phase one" and "do everything in phase one". **Decided on 2026-08-27: do everything** (the deferral suggestions were not adopted). The decision is recorded below (kept as a cost record for scheduling and expectation management):

| Item | Cost assessment | Lightening suggestion | 🔴 Decision |
|---|---|---|---|
| **C2 layer 3, strong data-plane isolation** (per-project DB role / credential + Lake Formation + the **16 consumers** of `admin-secret` + the **6 consumers** of `zeroetl-service`, both credential caches switched to per-project credentials + GenBI / BI / Data Service queries switch identity) | 💰 Large (the Redshift-side rework is itself heavy: credentials / query identity / migration / Lake Formation; and it is tightly coupled with the credential resolution of the multi-region design section 6.3, so it must be scheduled after the multi-region module) | Could be deferred to phase two; phase one up to layer 2, explicitly stated as "control-plane + schema isolation" | ✅ **Phase one goes to layer 3** (accepting the magnitude and the sequencing after the multi-region module; phase one is true data-plane isolation, no downgrade) |
| **C3 configuration-resource sharing** (read-only reference of sync / etl / workflow) | 💰 Medium (UI + read-path stripping per type) | Could be deferred to phase two (D5 copy already covers reuse) | ✅ **Phase one does all of it** (C3 stays "both") |
| **Full push-down of the third multi-region phase** | — | Could be an investment decision point after the second phase proves the pattern | ✅ **Phase one does the three multi-region phases in one go** (the original decision in the multi-region design section 17 stands) |

- **Undisputed high-ROI items (confirmed by the cost review, kept in phase one)**: all of model-configuration; the guard phase of this module (**13** privilege surfaces + C2 layer 1 revoking GRANT PUBLIC — fixes the current live exposure, highest ROI); sharing of all 8 data-source types; C2 layer 2 per-project schema; cross-project copy; the multi-region lossless refactor + the self-contained stack group (the hard precondition for a second region).
- ⚠️ **The cost of "do everything" needs expectation management (honest note from the cost review)**: phase one of this module is the heaviest piece of the three modules (control plane + the three C2 layers + all C3 types); C2 layer 3 is tightly coupled with the multi-region credential resolution in the same code (section 8 / section 15, highest priority), so construction must follow the order "this module's control plane → multi-region environment-ization → this module's C2 layer 2 / layer 3", and the schedule is raised accordingly.
- 📌 **Wording correction (cost review)**: several places compared "C2 layer 3 magnitude = the default-user partitioning item" — the measured `default-user` hard-coding across the repository is only about **102 lines** (not the old figure of 5848), so that item itself is not large; the "weight" of C2 layer 3 comes from the Redshift-side rework itself (credentials / query identity / migration of existing data / Lake Formation); the comparison is loose, and "heavy Redshift data-plane rework" is the more accurate phrasing.

## 7bis. 🔴 Phase-One Data-Plane Isolation Design (decision C2: do it in phase one, a major upgrade)

> Decision C2 of 2026-08-27: data-plane isolation is done in phase one. Goal = **even a user who knows SQL cannot query another project's tables across projects** (not just control-plane visibility). Based on the state of the code, a **layered landing** route is chosen (first root-fix the back door + schema isolation, then strong isolation), rather than jumping straight to the heaviest option.

### 7bis.1 Current State (verified in code, 🔵 file:line)
- Data lands by default in the **`public` schema**: `glue-script-generator.ts:344` `rs_schema = task.redshiftConfig?.schema || "public"`; the workgroup is uniformly `bgp-workgroup` (:342).
- All engines execute **with the one admin secret** `redshift!bgp-namespace-admin` (`admin-secret.ts:11`, shared by genbi / etl / schema and others).
- After creating a table the platform actively runs **`GRANT (ALL/SELECT) ON <table> TO PUBLIC`** — the root reason the data plane is more open than a "shared database", and there are **6 sites repository-wide** (execute-ddl:36 + glue-script-generator:454 + codegen:54 + cookbook seed 307/323 + etl-job template 92; details in section 7bis.2 layer 1), not one; GRANT PUBLIC makes a table readable by every DB role and is the number-one exposure that breaks through layer-2 / layer-3 isolation.

### 7bis.2 Phase-One Landing (three layers, light to heavy; the first two are root fix + primary isolation)

| Layer | Content | Code landing point | Nature |
|---|---|---|---|
| **Layer 1, revoke the back door (mandatory, first)** | Delete / tighten `GRANT ALL TO PUBLIC`, granting only to the role of the owner project instead.<br>⚠️ **Verified by two review rounds: GRANT (ALL/SELECT) TO PUBLIC has in fact 6 sites repository-wide** (the earlier "5 sites / 4 sites" statements were wrong and contradicted each other,<br>verified and corrected): ① `execute-ddl/route.ts:36` ② `glue-script-generator.ts:454` (**executed by every Glue sync script**) ③ `requirements/codegen.ts:54` (**the AI codegen prompt instructs the model to GRANT PUBLIC**) ④ `cookbook/seed/glue.ts:307` ⑤ `cookbook/seed/glue.ts:323` (the recipe teaches users to do it) ⑥ **`types/etl-job.ts:92`, the default ETL template** (`GRANT SELECT ON ... TO PUBLIC`,<br>added by the threat-modeling review,<br>produced whenever a user creates a job from the template).<br>Revoking it touches [engine-cookbook](./engine-cookbook.md) and [genbi-engine-unification](./genbi-engine-unification.md) (codegen / cookbook).<br>🔴 **Lethality (threat-modeling review)**: GRANT TO PUBLIC makes a table readable by **every DB role** and **directly breaks through the per-project grants of layer 3** (layer 3 grants proj_A, yet PUBLIC lets proj_B read anyway) — **if any one of the 6 sites is left unchanged, every table newly created on that path is open to everyone and the layer-2 / layer-3 isolation is void**.<br>Therefore layer 1 must revoke all 6 sites | the 6 sites on the left (including `types/etl-job.ts:92`) | 🔴 Security root fix, **scope = revoke all 6 sites + migrate existing data**;<br>⚠️ **Added by a repository grep: the two cookbook sites (glue.ts:307/323) have a compiled copy at `infra/agent/genbi/core-dist/cookbook/seed/glue.js:306,322`** — revoking the GRANT must **change the source and redistribute** through core-prebuild (same class as the container fallback of model-configuration; changing only the source copy without redistributing = new drift);<br>**hard acceptance gate**: an inspection script periodically scans the repository / warehouse for `TO PUBLIC` as a safety net; **until layer 1 is complete (all 6 sites revoked / existing data migrated), layer 2 / layer 3 must not be declared effective** |
| **Layer 2, an independent schema per project (primary isolation)** | Data lands per project in the **`proj_<projectId>` schema** (reusing the existing `redshiftConfig.schema` parameterization, changing the default `public` to a project-derived name); the schema used by sync / etl for table creation / writes / queries is decided by the project context | `glue-script-generator.ts:344` and the other schema injection points + the push-down side | The primary isolation means, reusing the existing schema mechanism |
| **Layer 3, a DB role per project + schema-level GRANT (strong isolation)** | One Redshift DB role per project, GRANTed only USAGE/SELECT on its own project schema; execution picks the credential by project (not the unified admin). SQL editor / GenBI queries inherit the project identity → no permission on other projects' schemas | New project→DB role mapping + admin-secret split into per-project credentials | True data-plane isolation, the largest magnitude |

> 🔴 **Layer 2 alone does not constitute data-plane isolation (threat-modeling review item T1, verified)**: every platform query runs with the unified admin superuser credential (the header comment of `admin-secret.ts` says "just one admin identity"; 16 call sites including `genbi/redshift.ts:49` / `data-service/execute.ts:52` / `redshift/execute:15`). Admin has rights on every schema → **with layer 2 only (schema isolation), a member of project A still succeeds with `SELECT * FROM proj_B.table`**. The real line of defense is **layer 3 (the query side switches to per-project credentials and abandons the unified admin)**. Hence:
> - **"runSelect / redshift-execute no longer use admin-secret and switch to per-project credentials" is the hard acceptance gate of data-plane isolation** (otherwise section 9 cannot prove that cross-project queries fail);
> - **Layer 2 / layer 3 either ship in the same batch, or during a layer-2-only period the UI / documentation may only claim "control-plane isolation" and must never claim "the data plane is isolated"** (against false security assurances).

- **S3 Tables side**: the data lake correspondingly isolates by per-project namespace + Lake Formation grants (in the same period as layer 3); Athena queries of the core inherit the project identity.
- **GenBI / BI / Data Service queries**: runSelect and the others execute with the project identity (not the unified admin), hitting the project's own schema / credential — data-plane isolation applies equally to Ask-Your-Data (knowing SQL does not get past DB permissions).

> 🔴 **Three "necessary but not sufficient" closures for landing layer 3 (deep reviews: beyond the composite key, these must still be plugged, otherwise isolation is nominal)**:
>
> - **A missing credential is fail-closed (🔴 revision 1.3, made precise per decision A: in the `isolated` steady state there is never a fallback to admin; within the `legacy-seeded` / controlled `provisioning` window, existing home traffic** may fall back explicitly, and always with audit + metric + deadline. **A missing state must not be interpreted as legacy**; the authoritative semantics are the multi-region specification section 3.9b — the former wording "never fall back under any circumstance" collided with the multi-region specification section 3.9, and simply deleting the fallback would have broken execute / GenBI / data-service before project credential supply completes = cutting features) **(fixing the fail-open ternary)**: the **16** consumer sites of `admin-secret` and the like are today `...(SecretArn ? { SecretArn } : {})`-style **ternary fallbacks** — when the per-project credential cannot be resolved they **fall back to "no SecretArn = the unified admin superuser identity"**, and isolation fails on the spot. Layer 3 must change this to **refuse execution when the project credential cannot be resolved (fail-closed)**; `zeroetl-service._secretArnCache` (6 sites) changes the same way, otherwise the zero-ETL workgroup path bypasses it as a no-op. This is **a different matter** from the `(targetId, project, purpose)` composite key of the multi-region design section 15: the composite key guarantees "the right credential is fetched"; fail-closed guarantees "when none can be fetched, admin is not used on the sly".
> - 🔴 **Revision 1.0 correction: fail-closed must be split into [three] classes, not two** (confirmed by a grep in the specification-level deep review of 2026-08-28): besides ① project-context callers and ② platform-level read-only governance readers below, there is a whole class of **platform-level supply identities that need CREATE/DDL writes** — `realtime/redshift-target.ts:51,78` (DMS creating `CREATE USER dms_ingest` / `CREATE SCHEMA ... AUTHORIZATION`), `modeling/redshift.ts:40` (code-table / dimension DDL), `sync/glue-script-generator.ts:439` (generated script `CREATE SCHEMA`), **and layer 3's own supply** (creating the `proj_<id>` schema / `role_proj_*` / GRANT). Classifying them as ① would get them killed by fail-closed (they belong to no project); classifying them as ② violates the "read-only identity" constraint ⇒ **implementing the two classes literally would break three paths: real-time CDC + modeling table landing + layer 3's own supply** (the last being a **bootstrap paradox**: the very step that establishes isolation is refused by itself). Hence **class ③, "the controlled admin-DDL supply identity"**, is added: credential = the admin secret of that **target** (multi-region specification section 3.9), **allow-listed DDL only** (CREATE SCHEMA / TABLE / USER / ROLE, GRANT, and DROP SCHEMA when deleting a project), **never used to SELECT business data on a user's behalf**, decided **by static classification of the call site** (not by guessing from the SQL at run time), **audited throughout**. Mechanism in the [specification](./project-isolation-spec.md), section 3.4.
> - 🔴 **The original two-class wording (kept, as ① and ②)**: fail-closed cannot be applied across the board; it must distinguish "project context vs platform level" (the deep review's highest-priority finding; a literal implementation would kill governance): among these 16 sites there is a whole class of **platform-level system calls without a project context** — `metrics/service.ts:183`, `quality/service.ts:151`, `modeling/redshift.ts:40/201`, `governance/sensitive/scan.ts:78` (the gap table in section 0.2 already notes that modeling / metrics / governance are global by nature, have no projectId, and use the platform constants `bgp-workgroup` / `dev`). Applying "refuse when no project credential can be fetched" to them across the board = **governance scans / metric materialization / quality checks / sensitive scans all fail closed and die**. Hence **two classes**: ① **project-context calls** (`redshift/execute`, `genbi/redshift`, `data-service/execute` and the others carrying a projectId) — fail-closed when the project credential cannot be resolved; ② **platform-level governance / modeling / metrics calls = a controlled service identity, acknowledged as a "cross-project global reader" (no pretending to GRANT away proj_*)** — 🔴 the composite review proved that "can run governance but cannot read proj_*" **cannot be built**: Redshift has no "may aggregate but may not read" permission (computing min / max / count is itself a SELECT, and sensitive-scan even samples 200 detail rows), and it conflicts head-on with D2's "governance stays globally readable". So no fake "GRANT to block proj_*" move; instead, **on top of "acknowledging it can read all proj_*", four real closures**: (a) a **read-only** service identity (no writes / DDL); (b) **return-shape constraints** — sensitive-scan returns only `{column, matched type, count}` and no rows; metrics return only scalars / aggregates and **guard against constructed aggregate enumeration** (generalizing the cross-jurisdiction return-shape constraint of the multi-region design section 8.5.7 ③ **to cross-project**); (c) **strong RBAC closing the trigger surface** — 🔴 `POST /api/modeling/model-metrics/[id]/compute` today **only does `resolveIdentity`, with no project / admin guard = anyone logged in can use it as a side door to read `SELECT SUM(salary) FROM proj_B`** (confirmed by the composite review); `isPlatformAdmin` or a project-membership check must be added (same batch as the D3 privilege surfaces); (d) **audit throughout**. Across jurisdictions these platform-level calls are additionally bound by the multi-region design section 8.5.7 ③ (run in the region, the center receives only non-data values). **"Fail-closed" refers only to class ① (project context, refuse when no project credential can be fetched) and does not harm these platform-level system calls.**
> - **The `proj_<projectId>` schema name must be sanitized**: splicing projectId straight into a SQL identifier / schema name risks injection and illegal identifiers (projectId is not a controlled SQL-safe character set) — it must pass through **one authoritative sanitize function** (following the single-source-of-truth lesson learned on sync identifiers and metadata FQNs, and sharing its origin with the naming single source of truth of the multi-region design section 3) that produces a legal, unique schema name; table creation / writes / queries **all three share that one function** (if any one of them bypasses it = wrong schema or an injection surface).
> - **Lake namespaces are isolated by `projectId`, not by database name**: on the S3 Tables side the namespace must be derived as `proj_<projectId>`; **database names / table names must not be used as the namespace** (with database names, same-named databases of different projects collide on one namespace and isolation fails); it shares the same sanitize function as the layer-3 schema derivation.
> - **Cross-project data-movement ban (composite-review threat item: layer-3 GRANTs block cross-project SELECT, but moving / exporting has no ban)**: the per-project role must be **forbidden to `UNLOAD` to buckets outside its project, and forbidden `datashare` / `CREATE EXTERNAL SCHEMA`** — otherwise a proj_A member could `UNLOAD (SELECT * FROM proj_A) TO 's3://another project's bucket'` or build a cross-schema external view to bypass isolation. Closed **at the same place** as the read-only guard on execute of the multi-region design section 8.5.7 ⑤, but the guard is **widened from "only when jurisdiction ≠ home" to the execute entry point in general**, applied along the **two dimensions (jurisdiction, project)** (cross-jurisdiction: no moving out of the region; cross-project: no moving to another project).

### 7bis.2a 🔴 Global Knowledge Physical Tables Land in the `shared` Schema (decision #2 of 2026-08-28: region × project, two dimensions)

**Root of the conflict (confirmed by grep)**: modeling code tables land in `public` (`modeling/service.ts:258` passes no schema → `redshift.ts:82` defaults to public); dimension / fact tables land in the **fixed global layers** `ods/dwd/dws/ads` (`service.ts:27-30`). ⇒ **After layer 1 revokes PUBLIC, `role_proj_*` cannot read the code tables** (all modeling consumption breaks); **migrating them to `proj_` under layer 2 breaks through the "enterprise common vocabulary"** (a code table becomes private to one project). Both routes are wrong, while D2 requires modeling to "stay global".

**Settled (one set per target)**:
- **Global knowledge** (code tables `dim_code_*`, conformed dimensions and other "enterprise common vocabulary" physical tables) → land in the **`shared` schema**; at supply time `GRANT USAGE ON SCHEMA shared` + `GRANT SELECT ON ALL TABLES IN SCHEMA shared` to **all `role_proj_*`** + `ALTER DEFAULT PRIVILEGES` (new tables readable automatically) — 🔴 **not PUBLIC (does not break isolation), not `proj_` (not privatized by one project)**.
- **Project-private business data** → still lands in `proj_<sanitize(projectId)>`.
- **Write permission**: only the **class ③ admin-DDL supply identity** may write `shared` (section 7bis layer 3); **project members cannot write it**.
- **Region dimension**: owned by the multi-region design sections 19.1 / 3.8 — the model **definition is globally unique**, **the structural DDL is materialized per target**, `landedByTarget` records the observed state; i.e. **`shared` and `proj_` each exist once per target** (= region × project, two dimensions).
- **Semantic boundary (aligned with the C2 commitment, must be stated to customers explicitly)**: "cannot query another project's tables across projects" holds **completely for business data**; `shared` is **an intentional global read-only knowledge layer** and contains no project business data.

### 7bis.2b 🔴 Metadata-Side FQN Consolidation (preventing silent masking failure after migration → exposed PII)

- Section 7bis layer 3 ③ originally consolidated only the sanitize of the schema **name** (the three physical write sites), but on the metadata side there are **8 mutually independent `||"public"` / local FQN constructions** (confirmed by grep): `governance/masking.ts:98,122` (**the most lethal**), `lineage/sql-lineage.ts:214`, `governance/lineage-service.ts:36`, `openmetadata/om-push.ts:166,344`, `genbi/core/retrieval-core.ts:128`, `modeling/dimensions.ts:24`, `modeling/model-metrics.ts:54`, `api/sync/generate-ddl/route.ts:14`.

**Concrete harm**: masking rules are registered in the form `...public.<table>`; after the data moves to `proj_<id>` / `shared` the real schema at query time has changed ⇒ **`getClassificationsForTables` finds no match → `maskStrategy` does not apply → sensitive columns return in plaintext in the result** (and `maskRows` is **fail-open**: on an exception it returns the raw rows); at the same time lineage degrades and Ask-Your-Data retrieval no longer finds the migrated tables.

**Settled**: all 8 sites **converge on the same authoritative FQN function** (same origin as the multi-region design section 3.10, shared by the physical and metadata sides); **the migration tool rewrites in the same batch** the `public.` of existing classifications / lineage / metric `fqn` / OpenMetadata entries to `proj_<id>.` / `shared.`; declare the **cross-component invariant** "the schema / target of the four hops scan→findings→classification→masking must agree", and **when they disagree, fail closed for the L3 / L4 sensitivity levels** (no more silently returning raw rows).

### 7bis.3 Relationship with the default-user partitioning item and governance-deepening
- With the **default-user physical partitioning item**: that item changes the DynamoDB pk; this module's layer 2 / layer 3 change Redshift schemas / credentials; **the two are orthogonal** (one is control-plane storage, the other the data-plane warehouse) and can proceed independently.
- With **[governance-deepening](./governance-deepening.md)** (phase-two row-level security, RLS): this module's layers 1–3 are **table / schema-level** isolation; finer **row-level** isolation (filtering rows by project within one table) still belongs to governance-deepening, phase two. Schema level in phase one is enough to satisfy "cannot query another project's tables across projects".

### 7bis.4 Migration and Compatibility (🔴 heavily hardened by the data-migration review: the original design had 3 places that "could permanently lose or skip data")

Moving existing `public` tables to `proj_<id>` schemas is the most dangerous operation of changing the data layout of a production system. The original design's "migration tool + read-only compatibility period" was far from enough; the following is added:

- **🔴 Reverse ownership lookup has a hard gap; orphan tables need a disposition (data-migration review, highest priority)**: ownership "derived through sync tasks" **does not cover everything** — tables created by `execute-ddl` (SQL editor table creation, no projectId; verified zero hits), by the `types/etl-job.ts:92` ETL template, and by `codegen.ts:54` AI codegen **have no sync task to derive from at all**;
  - and a sync task stores only `sourceTables` (source table names), while the target table name is derived at run time in `glue-script-generator.ts:344`, so the lookup dimension largely collapses.
  - → **A considerable share of existing public tables cannot be attributed = orphan tables**.
  - Disposition (must be defined; do not assume the lookup covers everything): ownership found → migrate to the corresponding `proj_<id>`;
  - **not found → migrate to the `proj-default` schema (not lost, can be claimed manually later); never skip or delete a table because it "has no owner"**;
  - the migration report lists all orphan tables for administrators to claim afterwards.
- **🔴 Keep a way back before DROPping a public table (data-migration review, highest priority, the most brutal permanent-data-loss point)**: migration = `CREATE proj_<id>.table + COPY/INSERT + verify row counts match + keep public as a read-only compatibility period + DROP only when it expires`.
  - **Hard requirements before DROP**: ① first `UNLOAD` / CTAS the table as a backup to S3 (or a snapshot);
  - ② the DROP at expiry requires **a second confirmation / approval** (no unattended bulk DROP);
  - ③ the compatibility period should be ≥ 1 data cycle and **an inspection "does public still have unmigrated tables" runs again before revoking** — one skipped table + the DROP at expiry = permanent loss.
  - **Explicit "how to recover a skipped table" = the S3 backup taken before DROP**.
- **🟠 DDL method and concurrency (data-migration review, priority 1; ⚠️ default corrected by the deep review)**: **the default is (a) CREATE + COPY + public compatibility period** (see the next item, which has a rollback window).
  - `ALTER TABLE public.<t> SET SCHEMA proj_<id>` (**atomic, no COPY, no half-migrated state**; supported by Redshift) **is an exception chosen explicitly per table**, used only for tables "confirmed to have no consumer depending on public and able to accept no compatibility window" — **not the default** (the earlier "prefer ALTER" contradicted the next item's "default (a)"; corrected and unified to default (a)).
  - Cross-database or redistribution scenarios cannot use ALTER and **must also** use CREATE + COPY + DROP.
  - **Concurrency during migration**: running sync tasks still write to public via `schema||"public"` (glue-script-generator.ts:344) and compete with the migration tool → migration must **lock per table / or pause that table's write tasks during the migration window**, and the implementation of "read-only compatibility" must be spelled out (REVOKE write permission vs application-layer interception);
  - resumability: the migration tool records progress per table; an interruption can be re-entered without migrating twice.
- 🔴 **ALTER SET SCHEMA and "public read-only compatibility period" are mutually exclusive; one must be chosen explicitly (deep review: reconciling the internal contradiction of section 7bis.4)**: `ALTER ... SET SCHEMA` is **an immediate one-way move** — public.<t> disappears on the spot and **there is no "public kept as read-only compatibility" window**, which **conflicts** with the previous item's premise "keep public as a read-only compatibility period + DROP only at expiry + UNLOAD backup".
  - The two routes are mutually exclusive; choose one by risk tolerance: **(a) CREATE + COPY + verify + keep the public compatibility period + DROP after approval** (rollback window, can be rolled out gradually; cost = double storage and COPY time; the safety design of the data-migration review takes this route);
  - **(b) ALTER SET SCHEMA** (atomic and fast, saves the COPY, but **no compatibility window**; "rollback" = a reverse ALTER moving it back, a **one-way-door** operation with no dual-read safety net).
  - **Default (a) for safety**;
  - use (b) only for tables "certain to have no consumer depending on public and able to accept no compatibility window".
  - The migration tool must let administrators **choose the route explicitly per table**; it must not default to ALTER and quietly cancel the compatibility period promised by the data-migration review.
- Legacy data without a projectId goes to the `proj-default` schema (consistent with proj-default on the control plane).

## 7. Known limitations and phase two

1. ~~Data-plane isolation not done~~ → **promoted to the phase-one main line (decided; see section 7bis)**; phase one goes as far as **schema/table-level isolation**; the finer **row-level isolation (RLS)** still belongs to phase two of [governance deepening](./governance-deepening.md).
2. Physical partitioning is still default-user (governed by the physical-partitioning design; orthogonal to this module's data-plane schema isolation, section 7bis.3).
3. ~~Phase-one sharing limited to data sources~~ → **the sharing scope has been widened (decided)**: all 8 data-source types + knowledge-class resources such as modeling / standards / code tables / metrics + sync/etl/workflow configuration resources can all be shared and referenced across projects (see the D1 revision). Cross-project triggers are still unsupported; BI / alerting are not in the copy scope.
4. Copying does not carry run history / version history (the current definition only).

## 8. Construction-order coupling with other modules (important)

- **Adding `projectId` to `bgp-task-runs` (this module's D2) and adding `region` (multi-region execution) are the same batch of write sites** — whichever module goes first, the rework of the write sites **must be designed once and changed once, together** (one attribute bundle `{projectId, region}`), so that the same high-risk surface (including the MWAA bypass runtime-lib) is not turned over twice. If multi-region execution is approved as a project, D2 should be folded into its first implementation batch.
- **🔴 The second shared rework surface: credential / client resolution (added by the architecture review, aligned with [the multi-region execution design](./multi-region-execution-design.md), section 15)** — this module's section 7bis L3 "execution picks credentials per project" and [the multi-region execution design](./multi-region-execution-design.md), section 6.3 "runtime-lib / client split per region" change **the same piece of execution-identity resolution code**: the process-level **single-value cache** `_arn` in `admin-secret.ts:13` (consumed by 16 sites) **+ the second isomorphic cache `zeroetl-service.ts:69 _secretArnCache` (3 consumers, added by a later grep audit)** + `runtime-lib._mk`.
  - Project isolation switches by project, multi-region splits by region; if each changes its own, whichever lands later overturns the former and collides with the lock byte alignment (fixed earlier).
  - 🔴 **Must be designed and changed together, once**: design the cache key as the **composite `(targetId, project, purpose)`**; one run executing in region R for project P resolves to `(R endpoint) × (P credential)`.
  - **This is the direct reason why this module's data-plane layers L2/L3 are recommended to come after the multi-region execution-environment work** (see the construction order).
- **Construction order (re-sequenced by the architecture review, consistent with [the multi-region execution design](./multi-region-execution-design.md), section 15)**: because the decision made phase one of this module include data-plane isolation (heavy Redshift data-plane rework), and because its credential resolution and multi-region's region resolution are the same piece of code — this module is split into two halves: **the control-plane part (D1–D5 / the security-fix, run-record stamping, sharing and copy batches + L1, revoking the GRANT backdoor) is decoupled from multi-region and can go first**; **the data-plane L2/L3 (per-project schema / credentials) is recommended to be pushed after the multi-region execution-environment work**, designed jointly with multi-region's per-region credential resolution.
- D3/D4 (guards + permission tightening) have zero coupling with other modules and can go first independently.
- When the physical-partitioning design changes the pk, all of this module's projectId attribute logic stays as it is; no conflict. **Orthogonal to it**: physical partitioning changes the DDB control-plane pk, while this module's data-plane isolation changes Redshift data-plane schemas / credentials (section 7bis.3).

## 8bis. Change scope · impact scope · risk register (🌐 production-grade change review)

> This module does two high-risk things on a **globally deployed production system**: ① it adds project guards to a batch of action routes that are **currently unguarded — usable by anyone who is logged in** (a wrong change = normal users wrongly rejected; a missed change = the privilege-escalation surface remains); ② it changes the **13 write sites** of `bgp-task-runs` (the largest single point, consumed by 4 modules). The production change-review specification follows, **all of it anchored to the real current state of the code** (calibrated by the 2026-08-26 audit).

### 8bis.1 Change scope (new vs. modified existing code, anchored by file:line)

**A. New (pure increments):** the `sharedTo?` / `copiedFrom?` attributes (pure additions to the resource tables), `POST /api/projects/copy-resource`, `PUT /api/datasources/[id]/share`, the front-end "Sharing settings" and "Copy to project…" dialogs. **No new table** (copying relies on the `copiedFrom` provenance attribute; approvals reuse `bgp-approvals`).

**B. Modified existing code (regression risk, layered by harm):**

| Layer | Item | Location (file:line) | Regression risk |
|---|---|---|---|
| Guards, gap B group 1 (escalation surfaces with side effects) | 7 routes get guards | redshift/execute:9, sync/execute-ddl:14, workflow/airflow:9, schedule/enable:13, redshift/cancel:8, datasources/test:13 + heartbeat:13, sync/generate-ddl:9 | Guard too strict → normal developers wrongly rejected; too loose → the escalation surface remains. Verify the min-role route by route |
| Guards, gap B group 2 (read leaks) | 3 routes get guards | datasources/[id]/schemas\|tables, monitor/tasks/[id]/logs:10, redshift/history:11 | Same as above |
| task-runs stamping | **13 write sites** | 9 inside the platform (start:185,:464, start-realtime:121, workflow trigger:72, etl job-service:71, emr run-record:18, backfill execute:97, dependency:31,:64) + 4 on the MWAA bypass (runtime-lib:146, etl dag-generator:152, emr dag-generator:85, workflow dag-generator:126) | **See the first item of 8bis.2 — the largest blast radius** (grep calibration: `new PutCommand` in job-service is at :71, run-record at :18) |
| projectFilter extension | guard.ts:78-83 | +`contains(sharedTo,:p)` | ⚠️ The `attribute_not_exists(projectId)` legacy branch **must be kept**, otherwise every old resource vanishes from the view |
| canCreate tightening | projects/route.ts:32-35 | remove the developer line | Existing developer-owner projects lose their management rights (needs a 403 with a hint; no data migration) |
| GRANT revocation | sync/execute-ddl:36 | revoke / narrow `GRANT ALL TO PUBLIC` | See risk P0-2 |

### 8bis.2 Impact scope / blast radius (based on verified current code)

- **The 13 task-runs write sites = the largest single point shared with multi-region execution**: the table is consumed by the **monitor / finops (cost attribution) / baseline / alerting** modules (confirmed by the audit).
  - This module adds `projectId`, multi-region adds `region` — **they must be designed once and changed together as one attribute bundle `{projectId, region}`**, otherwise the same high-risk surface (including the MWAA bypass runtime-lib, which writes directly into the control-plane DDB from across execution bodies) is turned over twice.
  - The read side follows: the monitor/runs join (:48-53) + Copilot `list_recent_runs` (read-tools.ts:103-119) also do full Scans and must be filtered by project at the same time.
- **Two backdoors are independent surfaces that "remain even after all the other guards are added"**: the `workflow/airflow` web-token (any logged-in user exchanges it for an MWAA login token → enters the Airflow UI and triggers the DAGs of **all projects**) and the `GRANT ALL TO PUBLIC` in `sync/execute-ddl` (the data plane actively grants to PUBLIC). Neither disappears automatically with "adding project guards"; they must be plugged specifically — otherwise, however good the control-plane isolation is, the data plane / Airflow plane remain penetrable.
- **Data-plane isolation (decided for phase one, section 7bis)**: today every project lands in the same Redshift workgroup / schema=public, with a single admin credential, and table creation does GRANT ALL TO PUBLIC — phase one **fixes the root**: revoke the backdoor (L1) + a separate schema per project (L2) + a per-project DB role / Lake Formation (L3), so that even a user who knows SQL cannot query another project's tables. The finer **row-level isolation (RLS)** still belongs to phase two of governance deepening.
- **Cross-module coupling**: with multi-region = the same task-runs batch (see above); with physical partitioning (default-user) = all of this module's projectId attribute logic stays as it is, no conflict when the pk changes.

### 8bis.3 Risk register (P0/P1/P2)

| # | Risk | Level | Trigger | Impact | Probability | Mitigation | Rollback |
|---|---|---|---|---|---|---|---|
| P0-1 | Guards added too strictly → normal users wrongly rejected | **P0** | min-role set wrong / projectId not loaded | Normal developers cannot perform operations in their own project | Medium | Verify the min-role route by route; headless verification of positive and negative cases on the 12 escalation surfaces (member passes + non-member rejected) | Revert a single route (one independent commit per route) |
| P0-2 | Revoking GRANT ALL TO PUBLIC / the schema migration breaks existing queries | **P0** | Existing tables depend on the PUBLIC grant or live in the public schema and are consumed by existing queries / BI / Ask-Your-Data | Reports / Ask-Your-Data that depend on the table stop working | Medium | Layering per section 7bis: L1 first stops the grant on new tables → assess existing ones; L2 migration tool for existing tables + a read-only compatibility period for public → revoke PUBLIC after migration; GenBI / BI queries switch to the project schema / credential at the same time. **Added by the data-migration review (mitigation 2): before revoking existing PUBLIC grants, first use the inspection script to list, in reverse, the "existing queries / reports that depend on this grant", and revoke gradually**; ⚠️ GRANT PUBLIC statements that users have already executed by hand in the SQL editor cannot be revoked by changing code; the warehouse inspection is the safety net | Re-GRANT / schema rollback (reversible at statement level); ⚠️ **rollback restores the grant itself but does not undo downstream failures that have already happened** (broken report runs / failed task records); the public compatibility period is not cut immediately. ⚠️ **Tables migrated via route (b) ALTER have no public compatibility period and no statement-level dual-read rollback** (rollback = reverse ALTER to move back, section 7bis.4) — P0-2's "compatibility period / statement-level reversibility" mitigation holds only for the default route (a) |
| P0-3 | task-runs: 13 write sites missed / changed wrongly + read side missing the legacy fallback, so existing runs disappear | **P0** | A write site missed / the MWAA bypass not synchronized / the read side only `projectId=:p` without fallback | Runs from that source have no projectId → monitor / cost / alerting filters go wrong; **existing runs filtered by project simply disappear** | Medium | Change together with multi-region in one batch; grep each of the 13 sites; **read-side filtering must be `(projectId=:p OR attribute_not_exists(projectId))`** (as in guard.ts:80, already explicit in D2), not merely "semantically treated as proj-default" | Attributes are pure additions, the read side is legacy-compatible, the filter logic can be reverted |
| P1-1 | projectFilter drops the legacy branch | P1 | `attribute_not_exists(projectId)` deleted while extending sharedTo | All old resources without projectId vanish from the view | Medium | Explicitly keep the branch (guard.ts:78-83); regression-verify that old resources remain visible | revert filter |
| P1-2 | canCreate tightening hits existing developer-owners | P1 | An existing project's owner is a developer | Their management rights lapse | High (by design) | 403 with the hint "contact an administrator / R&D manager" at operation time; no data migration | Relax by configuration |
| P1-3 | Cross-project copy wrongly binds physical resources / secrets | P1 | The copy wrongly carries the secretArn | Cross-project credential leak | Low | Data sources are only shared, never copied (the secretArn never crosses projects); copying reads definitions and writes definitions only | — |
| P2-1 | A shared resource is modified by the target project | P2 | The target project issues a write against a shared resource | The owning project's data is changed | Low | Shared resources are read-only in the target project, cannot be re-shared, cannot be the subject of writes | — |
| P2-2 | A copied workflow's dependency chain breaks across projects | P2 | The copy carries triggers | Cross-project dependencies are meaningless | Low | Triggers are not carried; cleared after the copy with a hint | — |

**🔄 Phasing is itself a risk gate**: the security-fix batch (guards + permission tightening) has zero coupling with other modules, is a pure security fix, can go first independently, and **should land as soon as possible even if none of the other features are built** (the **13** escalation surfaces are a real exposure of the current production system). The run-record stamping batch (task-runs stamping) is aligned with the multi-region schedule and done in one blast. The sharing and copy batches are incremental features with the lowest risk and can be done last.

## 9. Acceptance criteria (headless browser + real state sources; contract-guard once before and once after)

- [ ] A developer creating a project → 403; manager/admin can create; a developer-owner managing members → 403 (with a hint).
- [ ] Non-members accessing project resources still get 403 (regression); on the monitor page a member of project A cannot see project B's runs (hard evidence that new runs carry projectId = the DDB item).
- [ ] All escalation surfaces green: `redshift/execute`, `sync/execute-ddl`, `schedule/enable`, `redshift/cancel`, `datasources/test|heartbeat|[id]/tables`, `monitor/tasks/[id]/logs` reject calls without a project identity / from non-members (403); the `workflow/airflow` web-token rejects non-admins (otherwise the Airflow UI can directly trigger any project's DAG and isolation is meaningless).
- [ ] Data-source sharing: project A's source shared to B → visible in B members' list (with a shared badge), usable to build a sync that references it, not editable / deletable / re-shareable (403).
- [ ] Cross-project copy: the three-way same-name conflict dialog really takes effect; a missing datasource reference lands as draft and is flagged on the page; after copying the workflow+sync bundle together, publishing and running in project B reaches succeeded (real state source: Glue/MWAA); triggers are cleared.
- [ ] Permission matrix: viewer(B) alone copying into B gets 403; viewer(A)+editor(B) succeeds.
- [ ] contract-guard verify zero FAIL; the audit table shows sharing / copy / permission-change records.
- [ ] 🔴 **Data-plane isolation (a hard gate from the security review)**: a member of project A running `SELECT * FROM proj_B.*` through the SQL Editor / GenBI **is rejected (no permission)** — hard evidence = runSelect / redshift-execute no longer use admin-secret but the project credential (otherwise it only reaches L2 = fake isolation, and data-plane isolation must not be claimed).
- [ ] 🔴 **Two-way acceptance of the platform-level system identity (a P0 item from the spec-level deep review, section 7bis L3 ②)**: ① platform-level metrics / quality / modeling / sensitive-scan **still work** (they can compute cross-project governance metrics — because they are a controlled global reader, not pretending to have GRANTed away proj_*);
  - ② but the **return shape is restricted** — sensitive-scan returns only `{column, hit type, count}`, metrics return only scalars / aggregates, **no proj_* detail rows in the result response** (headless assertion: the response body has no row-level data);
  - ③ **the trigger surface is controlled** — a non-admin / non-member `POST /api/modeling/model-metrics/[id]/compute` is rejected (the former "usable by anyone logged in" hole is now closed);
  - ④ every platform-identity query goes into bgp-audit.
- [ ] 🔴 **`result/[id]` cross-project row fetch is rejected (an item of the spec-level deep review)**: using project A member identity with **project B's statementId** to call `redshift/result/[id]` **is rejected** (🔴 **queryHandle check**, not the original "statementId→projectId mapping"); `redshift/history` returns only this project's history (not the whole platform). ⚠️ Premise: A and B **belong to different projects** (members of the same project may fetch each other's results; the criterion of [the multi-region execution specification](./multi-region-execution-spec.md), section 3.7).
- [ ] 🔴 **GRANT PUBLIC zeroed (a hard gate from the security review)**: the inspection script scans the whole repository + the warehouse: `TO PUBLIC` = 0 (all 6 sites revoked + existing ones migrated); new tables are no longer granted to PUBLIC.
- [ ] 🔴 **High-risk route auditing (a hard gate from the security review)**: after operations on redshift/execute, execute-ddl, workflow/airflow, schedule/enable, redshift/cancel, **bgp-audit has a record** (execute records the SQL text, airflow records the token issuer).
- [ ] **Shared credentials do not leak (an item of the security review)**: the receiving side's GET of a shared data source by-id / list **contains no secretArn / connection string** (stripped on the read path).
- [ ] 🔴 **Reverse regression of revoking GRANT / migrating schemas (added by a later review; backs P0-2)**: isolation taking effect is one direction; **"no legitimate query was hurt" is the other direction that must be verified** — **after** the PUBLIC grants are revoked and the schema migration completes, the existing **legitimate, in-project** reports / Ask-Your-Data / BI widgets **still return data** (headless assertion on the row counts / charts of these pages not dropping to zero, not just "no error"). ⚠️ As per the data-migration review's mitigation: before revoking existing PUBLIC grants, first use the inspection script to list the "existing queries that depend on this grant" and revoke gradually; acceptance covers at least one positive regression per consumer class on that list (reports / Ask-Your-Data / data services).
- [ ] 🔴 **Unit test for the correctness of the credential composite key (added by a later review; backs the architecture P0 of section 8 + the cross-module cache risk)**: L3's per-project credential lookup reuses the `(targetId, project, purpose)` composite key of the `admin-secret` / client caches (designed jointly with multi-region) — there must be **a unit test pinning the composite-key hit semantics**: the same env with different projects gets **different** credentials / schemas, and the cache never mixes projects; folded into multi-region's lock-parity unit-test surface (registered in [the multi-region execution design](./multi-region-execution-design.md), section 16bis; caught here on the project-isolation side so that "multi-region proposed it, project isolation never picked it up" cannot happen).
- [ ] contract-guard verify zero FAIL (the regression net for existing features); the audit table shows sharing / copy / permission-change records.

### 9bis. New contract-guard contracts and test scaffolding required by this work (added by a later review)

> None of the existing 7 L2 contracts covers the project-isolation dimension; `/projects` is in the L1 sweep (which asserts that the page loads) but **does not assert the isolation invariant "a member of project A cannot see project B's runs"**. This work must add:
> - **A `project_isolation` L2 contract**: enter `/monitor` as a member of project A and assert that project B's runs are **not visible** (hard evidence: new runs carrying projectId); it guards the core invariant of D3's escalation surfaces + the project-ization of task-runs, preventing "isolation quietly reverted to global visibility by a later change" (exactly why contract-guard exists — regressions of the kind "table-level + column-level lineage downgraded to table-level only").
> - **A `grant_public_zero` inspection scaffold**: scan the whole repository's source + the warehouse metadata, `TO PUBLIC` count == 0 (the re-runnable form of the security review's hard gate).
> - **A positive/negative matrix scaffold for the 13 escalation surfaces**: for each surface (redshift/execute … workflow/airflow as listed in section 9) two cases, member passes + non-member 403; it guards P0-1 (guards too strict / too loose).
> - All of them follow the rule that verification scripts stay on the local machine and are never committed; the `project_isolation` contract is added to `contracts.py` in the same batch as the run-record stamping batch (project-ization of task-runs) lands.

## 10. Implementation phasing

> ✅ Decided on 2026-08-26: the security-fix batch **does not go first on its own; it is scheduled with the module as a whole**. 🔴 **The sole authority for the implementation order = [the multi-region execution design](./multi-region-execution-design.md), section 17** (revision 1.1 correction: the text used to say "the three modules in the order `model configuration → project isolation → multi-region execution` (project isolation in the middle), with the cross matrix in [the multi-region execution design](./multi-region-execution-design.md), section 15 as the authority" — the old module-granularity order has been superseded by the settled batch-granularity order, and that cell of section 15 itself now points to section 17). 🔴 **The sequence is in [the multi-region execution design](./multi-region-execution-design.md), section 17; this document does not restate it** (revision 1.2: a restatement is a source of drift).
>
> **This module is split into four segments interleaved with multi-region** (not simply "project isolation in the middle"; sequencing by the old text would hit a circular dependency): ① **the security-fix batch: control-plane guards + L1 revoking GRANT** before the multi-region first batch;
> ② **the run-record stamping batch (project-izing runs)** in the **same batch as the multi-region first batch** (read and write go live together, otherwise monitoring for non-default projects runs empty);
> ③ **the credential-supply batch (the supply layer)** (creating per-project credentials / schemas) **after the multi-region execution-environment batch and before the multi-region component-stack batch** — this is the key to breaking the circular dependency: multi-region's per-target privileged credential factory needs project isolation's per-project supply, while project isolation's data plane needs multi-region's per-target resolution; **only splitting into "supply layer first, migration layer later" untangles it**;
> ④ **the data-migration batch (the migration layer)** (the real `public`→`proj_`/`shared` migration + DROP) **after the multi-region component-stack batch**;
> ⑤ **the sharing and copy batches** last.
> The old coarse statement "push the whole data-plane L2/L3 after multi-region" **is not enough to build from** and has been superseded by this split.

- **The security-fix batch (security fixes, first within the batch)**: gap B **group 1's 7 escalation surfaces with side effects + group 2's 3 read-leak guards** (completed to 10 after the first review; **12** in total after the spec-level deep review (+`result/[id]` (already assigned to the query-handle security fix) + `model-metrics/compute`), see section 0.2 / D3 and [the specification](./project-isolation-spec.md), section 2) + D4 permission tightening.
- **The run-record stamping batch**: project-izing monitoring (stamping the task-runs write sites — scheduled together with multi-region execution) + governance views filtered by project.
- **The sharing batch**: sharing (sharedTo, the decided scope) — all 8 data-source types + knowledge-class + sync/etl/workflow configuration resources, a unified sharedTo mechanism + the "Sharing settings" UI opened for all types.
- **The cross-project copy batch**: cross-project copying (copy-resource + conflict / dependency handling + UI).
- **🔴 The data-plane isolation batch (decided as a new, major phase-one item)**: the three layers of section 7bis — **L1 revoke the `GRANT ALL TO PUBLIC` backdoor** (🔴 **already assigned to the security-fix batch**, not in this batch; listed here only for completeness) → **L2 a separate schema per project** (the primary isolation, reusing the existing schema parameterization) + a migration tool for existing tables → **L3 a per-project DB role / credential + Lake Formation** (strong isolation) + switching GenBI / BI / data-service queries to the project identity.
  - **Heavy Redshift data-plane rework** (the **16** admin-secret consumers switched to per-project credentials + query identity + migration of existing data + LF); the heaviest piece of this module's phase one.
  - 🔴 **Both parallel credential caches must change (confirmed by a later deep grep audit, to avoid missing a whole surface)**: besides `admin-secret.ts:13 _arn` (16 consumers), **there is a second, structurally identical process-level single-value cache `zeroetl-service.ts:69 _secretArnCache`** (`getZeroEtlSecretArn`, consumed by 6 sites, including the `wg===ZEROETL_WORKGROUP` branches of interactive SQL's `redshift/execute:16` and `redshift/schemas:31`).
    - **If L3 only changes admin-secret and misses zeroetl, queries on the zero-etl workgroup still go through the single-value cache → per-project credentials are ineffective on that path and data-plane isolation is bypassed**.
    - Both caches must switch to per-project credentials in the same batch (jointly with multi-region's `(targetId, project, purpose)` composite key, see the P0 of section 8).
  - ⚠️ **Ordering inside the phase (settled after the architecture review's re-sequencing, not merely a suggestion)**: L1 can be folded into the security-fix batch (the same security root fix, a small change); **L2/L3 come after the multi-region execution-environment work** (because per-project credential resolution must be designed jointly with multi-region's per-region resolution, see the P0 of section 8 + the cross matrix in [the multi-region execution design](./multi-region-execution-design.md), section 15) — no longer "the tail of project isolation" but **crossing over to after multi-region**. **The decisions on data-plane isolation and the widened sharing scope make phase one of this module significantly larger than the original estimate** (which covered control-plane isolation only); the schedule must be raised accordingly.

---

## 11. 🔴 Implementation log of the security-fix batch (control-plane guards) — pre-work status verification · 2026-09-03

> - 🔴 **Why this section exists**: the "gap B escalation surfaces" table in [the specification](./project-isolation-spec.md)'s section 2 and the "current state" column of section 0.2 were written on **2026-08-26**;
>   by today (2026-09-03) they have **drifted**. Verifying the real code route by route with grep before starting work found that **5 of the 13 surfaces had already been closed by later batches**,
>   while the real shape of `redshift/history` is **worse than [the specification](./project-isolation-spec.md) describes**.
> - **The consequences of building from the old text**: ① routes that are already guarded would be changed again (waste + regression risk introduced);
>   ② fixing history according to a light description such as "platform-wide shared SQL history" would miss the layer that it **has no authentication at all**.

### 11.1 The 5 surfaces already closed (**out of scope for this batch**; [the specification](./project-isolation-spec.md)'s status column is stale)

| Surface | The real guard now (confirmed by reading the code line by line) | When and by what it was closed |
|---|---|---|
| `redshift/schemas` | `requireProject(req,"viewer")` + early return on `instanceof NextResponse` | Landed (the file comment states "this batch adds the minimum threshold first") |
| `redshift/execute` | `requireProject(req,"editor")` + `recordAudit("redshift.execute", truncated SQL)` | Landed (the comment cites the contract at line 67 of [the project-isolation specification](./project-isolation-spec.md)) |
| `sync/execute-ddl` | `requireProject(req,"editor")` + `recordAudit("sync.execute-ddl")` | Landed (the comment cites the contract at line 68 of [the project-isolation specification](./project-isolation-spec.md)) |
| `redshift/cancel` | **The query-handle security fix**: `requireQueryHandle(req, statementId, "redshift")`, **the handle is unconditionally required** | The query-handle security fix; 🔴 the comment records that the previous `if(handleId){validate}else{requireProject}` **fallback has been deleted** — that criterion depended on "whether the client is willing to pass a parameter", so omitting the parameter bypassed it |
| `redshift/result/[id]` | **The query-handle security fix** (`resolveIdentity` + audit) | The query-handle security fix |

🔴 **For these 5 surfaces this batch only does regression confirmation and changes no code** — changing a route that is already guarded = pure risk.

### 11.2 The 10 surfaces this batch actually has to fix (confirmed by grep: the guard count is 0 on every one)

Ordered by harm (fix the most harmful first, so that "one batch, one red can be reverted alone"):

| # | Surface | Current state (measured 2026-09-03) | Fix (contract in [the specification](./project-isolation-spec.md), section 2) |
|---|---|---|---|
| 1 | 🔴🔴 `workflow/airflow` | **Not even `resolveIdentity`**. Any logged-in user can exchange for an MWAA Web login token ⇒ in the Airflow UI they can trigger / pause the DAGs of **all projects** = **a backdoor around every project guard on the platform** (it remains even after the other 9 surfaces are fixed) | **Restrict to `bgp-admin` only** + audit. ⚠️ A single MWAA has no dagId-level isolation (the capability-boundary note of D3); this is a capability boundary, not implementation laziness, and must be recorded honestly |
| 2 | 🔴🔴 `redshift/history` | **Worse than [the specification](./project-isolation-spec.md) describes**: `GET` **does not even take `req`** (no authentication of any kind), `userId` is the hard-coded constant `"default-user"` ⇒ the whole platform **shares one SQL history**: any logged-in user can read **all SQL anyone has ever executed** (table names / column names / business logic all leak), and can write into it to pollute it | 🔴 **The pk is untouched** (`LEGACY_PARTITION` is a platform-wide zero-migration convention; ownership goes into attributes) ⇒ add the `projectId` / `createdBy` attributes + `requireProject` on both the read and the write side + the `projectFilter()` legacy fallback on the read side |
| 3 | `schedule/enable` | No guard; the sync branch does an **unconditional blind Update** for a non-existent taskId | Load the item by `taskType` → `guardResourceAccess(editor)`; also fix the blind Update |
| 4 | `datasources/test` | No guard; writes `status` / `testResult` back across projects | `guardResourceAccess(editor)`, 🔴 **judged by the owning project** (against the confused deputy: the caller's active project must not be used) |
| 5 | `datasources/[id]/heartbeat` | Same as above | Same as above |
| 6 | `sync/generate-ddl` | No guard; `schema` / `tableName` are **concatenated as strings into SQL** (an injection surface) | `requireProject` + parameterization / allow-list |
| 7 | `datasources/[id]/schemas` | No guard; browse any source's structure | `guardResourceAccess(viewer)` |
| 8 | `datasources/[id]/tables` | No guard | `guardResourceAccess(viewer)` |
| 9 | `monitor/tasks/[id]/logs` | No guard; read any run's logs | `guardResourceAccess(viewer)` |
| 10 | `modeling/model-metrics/[id]/compute` | Has `resolveIdentity` **but no authorization decision at all** ⇒ usable by anyone logged in, with any fqn (can be used as a detour: `SELECT SUM(salary) FROM proj_B`) | **+`identity.isPlatformAdmin`** (🔴 **not** "or project member" — the resource has no `projectId`, so a membership check ≈ letting everyone through) |

### 11.3 🔴 One item deliberately deferred to the run-record stamping batch (it has a dependency; doing it now would cause a visibility regression)

`GET /api/monitor/runs` (listed under gap A in [the specification](./project-isolation-spec.md), section 2) **is not done in this batch**. Reason: the `bgp-task-runs` items
**currently have no `projectId` field** (missing at the table-structure level, noted in section 0.2). Adding `requireProject` + project filtering to it now:
- for the default workspace: the legacy fallback of `projectFilter()` includes the existing items without `projectId` ⇒ it looks normal;
- for **non-default projects**: all existing runs **disappear** ⇒ a blank monitor page.

⇒ It must land in the same batch as **the 27 write sites stamped by the run-record stamping batch**. **This batch only records it and does not touch it.**

### 11.4 Also in this batch (already settled in [the specification](./project-isolation-spec.md), not new)

- **D4 permission tightening** (section D4): canCreate of `POST /api/projects` is tightened from admin/manager/**developer** to
  admin/manager; configuration management (rename / delete project / add, remove, change members / approval decisions) is tightened from "project owner" to
  **platform admin or (manager ∧ owner of that project)**; implemented in the `project-service` permission check + button visibility on the `/projects` page
  + `api/projects/[id]/**` + `api/approvals/[id]`; **pre-deletion check for projects** (resources / members / tables in the schema all count 0,
  otherwise 400 listing the details; forbidden by default, no cascade).
  **Landed (2026-09-03)**; four points settled during construction:
  1. **The criterion is written once** in `lib/projects/config-permissions.ts` (zero dependencies ⇒ the front end can import it). The same criterion has
     three consumers (API guard / button visibility on the `/projects` page / gate); writing it once in each of the three places inevitably produces "button lit but 403"
     (a fault in the user's eyes) or "button grayed but actually permitted" (shrunken permissions).
  2. The guard `requireProjectConfigAdmin` **is layered on top of** `requireProject(req,"owner")`: the 401 and the
     "Access denied for this workspace" messages are **unchanged verbatim** (what non-members see does not change, no extra information leaks);
     only among those who "could already pass the owner gate" is the platform group filtered once more ⇒ **structurally impossible to loosen**
     (the gate proves with a cross product of 5 groups × 4 roles that no "could not before, can now" combination exists).
  3. **Group names have a single source of truth**: the three group names were defined in `identity.ts`, which imports `next/server` + aws-jwt-verify
     ⇒ the front end cannot import it ⇒ the front end could only write literals (two copies: `requirements/page.tsx:58`, `auth/roles.ts:18`).
     A new pure-constant `lib/auth/groups.ts`; `identity.ts` re-exports it as before (the behavior of the existing import paths is unchanged verbatim).
  4. **Project deletion inventories 12 resource classes** (`lib/projects/project-resources.ts`): 7 attribute-type (the same batch of tables as those 7
     `projectFilter()` read paths, **paginated** COUNT Scan) + 5 key-isolated (**reusing each module's own
     `list<X>(projectId)`**, no key layout re-copied). When the table count in the data-plane schema cannot be read, it **blocks fail-closed**.
     🔴 The first version of the gate's pagination assertion was a **fake gate** (it only scanned the source for the two words `LastEvaluatedKey` / `ExclusiveStartKey`;
     after mutating `= res.LastEvaluatedKey` into `= undefined` both words were still there and everything stayed green) ⇒
     changed to an injectable `countAllPages(scanPage)` fed with a three-page fake pager and asserting the total; the mutation went red immediately.
     **The same lesson a second time**: a text assertion proves nothing about behavior; whatever can run must be run.
  5. Also fixed the **existence oracle** in `approvals/[id]` (before the change it first answered "approval does not exist / already handled" and authenticated afterwards).
  6. Interaction implemented per [the interaction design](./project-isolation-interaction.md), section 1: developers do not see "+ New" and get a one-line "who to ask"; a developer-owner
     entering their own project sees the delete entry grayed + a Tooltip + a yellow box at the top of the drawer that explains "the permission is gone" as **division of labor**;
     the visibility of the "Pending my approval" inbox uses the same criterion as "who can decide".
  7. **Still not done (explicitly listed for phase two, not quietly cut)**: **force deletion** with resources present (via approval + typing the project name as re-confirmation).
     Phase one only has "deletable once emptied".
- **L1 revoking `GRANT ALL TO PUBLIC`** ([the specification](./project-isolation-spec.md), section 3.5): 🔴 **8 real sites, not 6** (see the correction below):
  `①execute-ddl:57 (runtime execution) ②glue-script-generator:454 (every Glue script)`
  `③codegen:54 (LLM prompt) ④⑤cookbook/seed/glue.ts:307,323 ⑥types/etl-job.ts:92 (default ETL template)`
  `⑦⑧infra/agent/genbi/core-dist/cookbook/seed/glue.js:306,322 (**compiled copy**)`.
  🔴 **Must be done on both tracks** (the recorded lesson that a cookbook bug fix must cover both the executing and the generating side): changing only ①② (the executable ones) = a wasted change —
  ③④⑤⑥⑦⑧ are the **generating side** and would keep recreating the exposure.
  🔴 **One verified construction premise**: `platform/src/lib/exec-env/admin-ddl-guards.ts:113` **already has** a regex
  blocking "grant to PUBLIC" (half of the defense exists).
- **Hard acceptance gate**: the inspection scan over the whole repository == 0 + the real warehouse == 0.

#### 🔴 11.4a Correction: the compiled copy **exists and is tracked by git** (the previous round looked in the wrong directory)

The previous round's log said "the compiled copy `core-dist/cookbook/seed/glue.js` mentioned in [the specification](./project-isolation-spec.md) **does not exist on this machine and is not tracked by git**;
'change the source + redistribute' has no corresponding artifact, do not look for it" — **that statement is wrong and is withdrawn**. Measured during construction on 2026-09-03:

| Fact | Evidence |
|---|---|
| The compiled copy exists | `infra/agent/genbi/core-dist/cookbook/seed/glue.js:306,322` contain the grant verbatim at two places |
| **Tracked by git** | `git ls-files infra/agent/genbi/core-dist` = **44 files** (including the whole `cookbook/seed/`) |
| **It is the copy the container actually loads** | `core-guard.ts` reads `SYSTEM_DIALECT_RULES` (seed constants) directly, and the GenBI AgentCore container's `agent.js` imports `./core-dist/cookbook/core-guard.js` |
| Redistribution command | `bash scripts/core-prebuild.sh all` (🔴 a recorded lesson: **it must be `all`, not just `genbi`** — the genbi build does `rm -rf genbi/core-dist`, which also deletes the cookbook subdirectory) |

⇒ **Changing only the TS source without redistributing = the remote GenBI path still runs the old rules** (an implicit no-op, the same family of pitfalls as "guard-core is an implicit
no-op for the code engine"). This batch redistributed, and brought `infra/agent` **into the scan surface of the L1 scan gate** —
from now on this kind of **artifact drift** ("changed the source, forgot to redistribute") goes red before the commit (verified with the mutation "pollute only the compiled copy, keep the source clean").

#### 🔴 11.4b One **behavior change** in L1 (recorded honestly, not hidden under "security fix")

After unifying on the admin secret + revoking the grant to PUBLIC, **non-platform identities** can no longer write to tables the platform created.
Concretely: a user's own EMR/Glue job code calling `boto3.client("redshift-data")` **without SecretArn**
⇒ executes under the job role's IAM identity ⇒ it can **create its own tables** without any problem (it is the owner),
but an **INSERT into a platform-created table** gets permission denied (before the change, that PUBLIC grant made it writable).

- This **is exactly L1's intent** (isolation), not a regression — "anyone can write the platform's tables" is the very exposure to be eliminated;
- Scenarios that genuinely need cross-identity writes are handled by **the per-project credential supply of the credential-supply batch** (granting to `role_proj_*`),
  **not by PUBLIC**;
- Phase-one position: the cookbook's positive examples are "the job creates its own result table" (DROP+CTAS) anyway and never touch the platform's tables ⇒
  the measured impact surface is 0; if real end-to-end acceptance finds a job that depends on it, record it here and re-evaluate; **never quietly add the grant back**.

### 11.6 🔴 Correction to the L1 fix (verified during construction on 2026-09-04; [the specification](./project-isolation-spec.md)'s "small change" judgment does not hold)

[The specification](./project-isolation-spec.md)'s section 3.5 wrote L1 as "revoke all 6 `TO PUBLIC` sites", and section 10 said it is "a small change, can be folded into the security-fix batch".
**After reading the code line by line + querying the users in the real environment, that judgment must be corrected** — a bare deletion would break the sync chain, for the following reasons.

**① That GRANT is not superfluous; it compensates for a real identity mismatch.** The code's own comment (the sync-fix note in `sync/execute-ddl`) says:
"when the wizard pre-creates the table here, the owner is the platform TaskRole, while the Glue sync job writes as `bgp-glue-role`
⇒ the subsequent INSERT reports permission denied". `TO PUBLIC` was the shortcut of the day.

**② The identities are in fact three asymmetric ones** (measured):

| Executor | Identity used |
|---|---|
| `sync/execute-ddl:34` | `ExecuteStatementCommand` **without SecretArn** ⇒ the caller's IAM identity (the platform ECS TaskRole) |
| Glue scripts (`glue-script-generator:339/421`) | **The admin secret first** (`redshift!bgp-namespace-admin`), falling back to their own IAM identity only when it cannot be obtained |
| Other platform read paths | Already **16** admin-secret consumers (the `redshift/schemas` comment states "only with the superuser can you see tables created by others") |

**③ The route "narrow the GRANT to specific identities" is brittle.** `pg_user` in the real environment has only three users:
`IAMR:cdk-hnb659fds-cfn-exec-role-<account>-us-east-1`, `admin`, `rdsdb` — **the platform TaskRole and
`bgp-glue-role` have no corresponding DB user at all** (Redshift's `IAM:*` / `IAMR:*` users are **created lazily on first connection**).
⇒ To GRANT to them, they must connect once first; moreover the user name **embeds the account id**, which changes with the account ⇒
writing it into SQL is yet another "deploy-time snapshot" anti-pattern (explicitly forbidden by the root-fix policy).

**④ ⇒ Decision: eliminate the root cause, do not narrow the grant.** Let `sync/execute-ddl` also **use the admin secret** to execute DDL;
then the tables the platform creates and the tables Glue creates have **the same owner**, the identity mismatch ceases to exist ⇒ the 6 `TO PUBLIC` sites can be **truly deleted**,
rather than "swapped for a slightly narrower grantee".
- **Why this is a compliant narrowing, not a privilege escalation**: the platform **already** uses this same admin secret at 16 sites;
  execute-ddl not using it was the inconsistent exception. This change merely pulls the exception back into the existing shape.
- **Its relation to L3**: what L3 (the credential-supply and data-migration batches) is going to do is precisely to replace those 16 admin-secret consumers with **per-project credentials**
  (`projectRoleName()` / `SHARED_SCHEMA` are already in place in `exec-env/project-schema.ts`).
  This change merges execute-ddl into "those 16" ⇒ L3's single narrowing covers all of them, **leaving no extra tail**.
  Conversely: if a separate `bgp_platform` DB role were created now just for L1, L3 would have to dismantle it when it lands = a wasted round.
- 🔴 **Must be verified end to end in the real environment** (unit tests cannot prove it): the wizard pre-creates the table → the Glue sync job writes → the platform query page reads it;
  only when all three segments pass can we say `TO PUBLIC` was removed cleanly without breaking functionality. This is L1's definition of done.

**⑤ Conclusion on this batch's scope**: L1's **code changes** (execute-ddl switched to the admin secret + deleting the 8 grants + the generating-side
recipe guardrail + the scan gate) stay in the security-fix batch; **but its definition of done depends on one complete real sync run**, which is an acceptance segment independent of the guard acceptance
of the 10 surfaces; if one goes red it must be revertible separately (see section 11.5).

**⑥ Landed (2026-09-03)**:
- `sync/execute-ddl` switched to the admin secret (the same ternary as the existing 16 sites: `...(SecretArn ? { SecretArn } : {})`;
  an environment without the secret falls back to the IAM identity = the pre-change behavior, no new failure mode);
- all 8 grants deleted (including the compiled copy, redistributed with `core-prebuild.sh all`);
- **Generating-side hard guardrail**: a new dialect hard rule `<engine>.no-grant-to-public` (**redshift / glue / emr**, all three engines).
  `severity=error` ⇒ it automatically enters the planner prompt (`allDialectRulesForPrompt`); it carries an `antiPattern`
  and **deliberately provides no fix** ⇒ the guard judges `blocked` ⇒ a hard stop before running (glue: `job-service` / emr:
  `engines/emr/provider` / redshift SQL: both run and explain). The **single author** of the rule text and the regex =
  `cookbook/seed/shared-rules.ts` (the existing precedent in the repository, `no-jdbc-redshift`, is copied once each for glue/emr —
  three copies will drift); the recipe gains "wrong counter-example ③" (recipes are required to have positive and negative examples).
- **Scan gate** `platform/src/lib/projects/__tests__/l1-no-grant-to-public.test.ts` (16 cases):
  scans 8 root directories line by line (including the compiled copy); the exemption list has **only 4 entries** (the definition of the ban itself and its payload test)
  and "the list must not rot" (each entry must really hit, otherwise the exemption is superfluous ⇒ rejected); it does not bite i18n copy / `REVOKE` /
  grants to `role_proj_*` / two statements separated by a semicolon on the same line; **consistency of judgment** with the ban in `admin-ddl-guards`
  is pinned with the same set of samples. **5 mutations each went red for the right reason** (one of them being "pollute only the compiled copy, keep the source clean").
- 🔴 **The gate immediately bit a comment of our own** ⇒ which shows that **the wording of a ban should not take the shape of the ban**: 3 comments and the codegen
  prompt were reworded in Chinese prose instead of adding an exemption for ourselves (every extra entry on the list makes it a little less absolute).

### 11.5 Definition of done (headless page level + real state sources) — ✅✅ **both segments fully green on 2026-09-03**

1. **Positive/negative matrix for the 10 surfaces**: for each surface, ① a member of the owning project → passes ② a non-member → **403** ③ `workflow/airflow` for a non-`bgp-admin` → **403**.
2. **High-risk routes leave traces**: `bgp-audit` has the corresponding entries (who / resourceId / action).
3. **`redshift/history` isolation**: SQL executed in project A **cannot be read** by project B; A can read its own; existing rows (without `projectId`) remain visible in the default workspace.
4. **Grants to PUBLIC zeroed**: whole-repository scan 0 + warehouse 0; and **newly created tables are no longer granted automatically** (run one real table creation after the change to verify).
5. 🔴 **Reverse gate**: add a scan test pinning "the generating side must never again produce a grant-to-PUBLIC suggestion", with **mutation verification** (putting one back must go red).
6. **Regression**: the 5 surfaces of 11.1 still behave (member passes / non-member 403) and are not hurt by this batch's changes.

#### 11.5a Real-environment acceptance results (two independent segments; a red one can be reverted separately)

**Segment ① escalation surfaces + D4 matrix: 37/37 green** (headless acceptance script and report kept outside the repository)
- The 10 surfaces, negative: `biz-tester` (no group, non-member) gets **403** on each surface against project A's **real resources**; `workflow/airflow` rejects **both `biz-tester`
  and `pm-tester` (manager)** (it is not something project-level permissions can grant); `model-metrics/compute` for a non-admin → 403.
- The 10 surfaces, positive: admin in project A **is not 403** on any surface (the guard lets the call through; failures happen only at the business layer) ⇒ no feature was killed for the sake of security.
- Evidence for each of the additional fixes: `generate-ddl` with an injected table name → **400 allow-list rejection**; `schedule/enable` with a non-existent taskId →
  **404 and no ghost task in the list** (the blind Update is fixed).
- Audit traces: `workflow.airflow-web-token` / `project.create` / `project.member.put` all have entries.
- D4: a developer **does not see** the "+ New workspace" button and the API returns 403 (the message names bgp-admin / bgp-manager and "who to contact");
  a developer-owner managing members / renaming / deleting the project gets **403 on all three surfaces with messages explaining the division of labor** ("you can still develop this project's resources normally"),
  the yellow box at the top of the drawer is present and the "Add / Update" entry is gone; a manager-owner **works normally on all three** (not a blanket cut).
- **Pre-deletion check for projects**: with resources present, **400 listing the details** "1 data source, 1 member (besides the creator)"; once emptied, **the same path returns 200
  and deletes successfully** ⇒ proving the refusal is not a permanent lock.

**Segment ② L1 end to end: 18 items, 17✅ / 1⚠️ / 0❌** (headless acceptance script and report kept outside the repository)
- Walked the wizard at page level (real MySQL source `ecommerce.fx_rates`) → clicked "Execute create table" → the page reported "Table created";
- 🔴 **`tableowner = admin`** ⇒ the wizard and the Glue job have **the same owner**; the identity mismatch is gone (before the change it was `IAMR:<platform TaskRole>`);
- 🔴 **The number of grants to PUBLIC on that table = 0**, with a **positive control**: after really granting to PUBLIC on a throwaway comparison table, the same query returned **10 rows**
  ⇒ proving the "0" is not a false green from a mis-written query;
- 🔴 **The Glue sync job really wrote into this table (70 rows)** ⇒ after deleting the grant the sync chain **still works** (the most critical L1 point: unit tests cannot prove it);
- 🔴 **The Glue script actually running on S3** (`glue-scripts/<taskId>.py`, 18320 bytes) has **0** hits for grant statements ⇒ the evidence is taken from **the artifact**, not the source;
- 🔴 The platform query page ran `SELECT COUNT(*) AS p52cnt` and read **70** (the header contains the alias we chose ⇒ that SQL was really what ran).
- ⚠️ The only non-green item: the locator for the "Target table name" input on step 2 of the wizard did not match ⇒ the default table name was used. **This does not affect the conclusion**:
  the target table name was changed to be **parsed from the generated DDL**, and `DROP TABLE IF EXISTS` runs before clicking "Execute create table", guaranteeing this table can only have been created
  by this click (otherwise an old table created before the change might be verified = a false conclusion).

**Existing warehouse**: a full scan of `svv_relation_privileges` for `identity_type='public'` leaves only **1 row**, and it belongs to the Redshift
**system schema** `pg_auto_copy.copy_job_detail` (auto COPY job metadata, not a business table) ⇒ **0** for existing business tables.
🔴 Recorded honestly why this is so clean: this environment was rebuilt on 2026-09-03 itself, and the only sync target table was created by the **fixed** path;
**when going live on an environment with historical data, a REVOKE inspection pass is still needed** (the gradual-rollout position is in [the specification](./project-isolation-spec.md), section 3.7, assigned to the data-migration batch).

---

## 12. 🔴 Pre-work status verification for the credential-supply batch (assessed 2026-09-03; **scheduling and batch division are tracked with the multi-region execution work**)

> - The same discipline as section 11: **before starting work, verify whether the current state described by the old text still holds**. This time it caught 4 code-level facts + 1 fail-open in the running system.
> - 🔴 No work starts without a decision (the two pending decisions are tracked with the multi-region execution work).

### 12.1 Two things the contract requires **whose code does not exist**

| Item | Current state | Impact |
|---|---|---|
| `executeAdminDdl(actor, request)` (the **closed executor** of [the multi-region execution specification](./multi-region-execution-spec.md), section 3.9a; section 3.4 class ③ states explicitly "credentials not issued by this factory ⇒ always go through it") | **Does not exist**. The templates `admin-ddl-templates.ts` (7 operations) and the request parser `admin-ddl-request.ts` are both there; **the executor body was never written** | The 7 operations currently have **no execution path at all** ⇒ creating the `proj_<id>` schema / role / grants cannot run ⇒ the supply layer is missing a part at its very first step |
| `lookupProjectSecretArn(targetId, project)` | **A deliberate stub** (`privileged-cred.ts:185`, parameters prefixed with underscores, always `return undefined`; the comment states "the per-project secret is created by the credential-supply batch") | **Neither creation nor lookup** of per-project credentials exists; the project-context branch of `getPrivilegedCred` necessarily takes the legacy fallback today |

🔴 Two further modules have **0 production callers** (measured by AST): `getPrivilegedCred`, `advanceCredentialIsolationState`.
Following the recorded lesson that unwired code is unverified code, **treat them as "never verified" when wiring them up** — the security-fix batch was just bitten by
`assertProjectId` in the same package (the contract regex accepted lowercase only while the platform's `ulid()` produces uppercase; the unit tests stayed green because of degenerate fixtures).

### 12.2 🔴 One fail-open in the running system (must be fixed in the second construction wave)

`registerTarget` at `registry.ts:1340` hard-codes `credentialIsolationState: "legacy-seeded"` for **newly created non-home targets**.
The authoritative text of [the multi-region execution specification](./multi-region-execution-spec.md), section 3.9b, is: "**only existing home targets explicitly registered by the deployment migration script** may enter `legacy-seeded`;
**new targets start at `provisioning`**". The difference is substantive, not wording:
- `legacy-seeded` **does not require `provisioningDeadlineAt`** ⇒ it can fall back to the shared admin **indefinitely**;
- `provisioning` must carry a deadline, **at most 30 days**, and **on expiry is fail-closed exactly like `isolated`**.

Measured in the real environment: `tgt_usw2_a` (a non-home target created by the wizard) is currently `legacy-seeded` / `epoch=0`.
There is no harm today **only because `getPrivilegedCred` has no callers yet**; the moment the credential-supply batch wires it up, it inherits this hole.
⇒ The fix: the initial state becomes `provisioning` + deadline; existing non-home targets are pushed into the right state with `advanceCredentialIsolationState`
(**not** with `reconcileTarget` — its allow-list deliberately rejects these 5 credential fields, see the note at `registry.ts:918`).

### 12.3 Two facts that constrain the scope

1. **Only home can go first**: the platform TaskRole's `secretsmanager:CreateSecret` permission ARN is **pinned to the deploy-time region**
   (`infra/lib/platform-stack.ts:428-433`) ⇒ creating a per-project secret for a non-home target **necessarily gets AccessDenied**.
   Credential supply for non-home **hangs on the root fix of the "26 deploy-time region-ARN snapshots" in the multi-region component-stack batch** (the same anti-pattern family; explicitly forbidden by the root-fix policy).
2. **The naming single source of truth has no project dimension** (`project` has **0** hits in `platform/src/lib/aws/naming.ts`) ⇒ the per-project secret
   name needs a new kind, and **both sides must match byte for byte** (the naming-parity gate enforces it; section 3.0 explicitly forbids creating a 4th sanitize fork).

### 12.4 Cross-check with section 11: the status of the run-record stamping batch / monitor has drifted too

- **Write sites of the run-record stamping batch**: 🔴 **Corrected during construction on 2026-09-03 — the numbers in the three documents are in fact consistent; the denominator had been misread**.
  The AST instrument (`platform/scripts/ast-task-runs-writes.mjs`) measures: TS side **23 writes / 12 files**
  (**9 row creations + 14 write-backs**), plus **4 Python copies on the MWAA bypass** (`put_item` in the DAGs, generated from TS template strings)
  ⇒ **27** in total. Hence: the "27 sites" of section 11.3 = the total number of sites to touch; in the "13 creations + 14 write-backs = 27" of [the multi-region execution specification](./multi-region-execution-spec.md), section 5,
  the 13 creations = 9 TS + 4 Python; the "13 write sites stamped" figure used in the multi-region scheduling = **the creation count** (only creations need stamping).
  The previous round's claim that these three numbers "contradict each other" was wrong and is withdrawn.
  The only real problem: about 14 `UpdateCommand`s have DDB upsert semantics ⇒ **they can conjure run rows without projectId out of nothing**,
  the **same family** as the blind Update in `schedule/enable` fixed by the security-fix batch ⇒ the Update class must get a `ConditionExpression`.
- **`monitor/runs`**: besides the "zero guard" recorded in section 11.3, there is also a place where **`Limit` and `FilterExpression` are used together**
  ⇒ filtering happens after the Limit ⇒ **silent under-reporting when a filter is applied** (the same DDB trap as in `redshift/history`, which the security-fix batch fixed).
- **There are only 2 existing runs, and neither has `projectId` / `targetId`** ⇒ the concern of section 11.3 that "existing runs of non-default projects all disappear"
  costs almost nothing in this environment: **backfill directly**, no permanent legacy fallback branch needed.

---

## 13bis. 🚧 Implementation log of the credential-supply batch (**in progress**; the decisions are tracked with the multi-region execution work)

> Decided on 2026-09-03: ① **the region-ARN root fix is pulled forward and done together**; the credential-supply batch covers home + non-home in one pass;
> ② **done in one piece + an env flag as the safety net** (accepting the cost that "the flag is a permanent fork point; both identity paths must be maintained and tested long term").

### 13bis.1 Slice ①: root fix of the region segment in resource ARNs — done

Measured: **42 places** write the region into resource ARNs (the "26" recorded in [the multi-region execution design](./multi-region-execution-design.md), section 12, has grown), spread over 7 stacks.
The root-fix technique = a single exit `regionalStatement(scope, {axis, reason, …})`, **forcing the axis to be declared and the reason written down**;
it welds shut the requirement that "the ARN segment and the `RequestedRegion` condition change **as a pair**" (changing only one is exactly the class of silent bug).
**Only 1** statement was flipped from the home axis to the execution axis — the secret **write** statement in `platform-stack`, the hard blocker of the credential-supply batch;
the other 41 were judged home axis, each with a written note "why no cross-region is needed / with which batch it opens" ([the multi-region execution design](./multi-region-execution-design.md), section 20: granting now = granting unused power).
Hard evidence of equivalence: a byte-for-byte comparison of the 18 templates before and after `cdk synth`; **only that one statement changed**.
Gate = synth-gate section 12 (9 executable cases + bare region segments down to zero + **execution-axis call sites frozen at 1**); all six mutation tests went red.

### 13bis.2 Slice ②: correcting the initial state of the credential state machine + the derived name of per-project credentials — done

| Item | Content |
|---|---|
| 🔴 **Fixing a fail-open in the running system** | `registerTarget` hard-codes `legacy-seeded` for **newly created non-home targets**, while the authoritative contract of section 3.9b is "**new targets start at `provisioning`**".<br>The difference is hard: `legacy-seeded` **requires no deadline** ⇒ it can fall back to the shared admin secret **indefinitely**, and isolation never converges.<br>Now changed to `provisioning` + `credentialStateUpdatedAt` + `provisioningDeadlineAt` (≤30 days, the contract's upper bound: a freshly registered target carries no project load yet, so the fallback has no real traffic within the window; fail-closed on expiry is **deliberate** convergence pressure) |
| A single author for the deadline validation | Extracted `assertProvisioningDeadline()` — the initial write and the state transition, **two** write sites, share one criterion (strict parsing + must be in the future + ≤30 days). Writing it once at each site is the next source of drift |
| 🔴 **An existing unit test was pinning the fail-open** | `register.test.ts` used to assert `credentialIsolationState: "legacy-seeded"` — it was pinning that fail-open. Corrected and strengthened: a negative assertion "never legacy-seeded" + the deadline is parseable / in the future / ≤30 days |

### 13bis.3 🔴 An **explicit deviation** from fact ⑤ of section 12 (where the per-project secret name lives)

Fact ⑤ of section 12 says "the per-project secret name should get a new kind in the **naming single source of truth `naming.json`**, byte-identical on both sides".
**Doing it that way would hit an existing gate, so the location was changed**; the reasons:
1. `naming-coverage.test.ts` has a rule **"against registering ghost resources"**: the home fixed names registered in naming.json must really appear in
   `infra/lib`. But this secret is created **at platform runtime**, per project; the CDK side never produces its name
   ⇒ registering it as a kind would necessarily be judged a ghost resource;
2. The template variables of `naming.json` are a **closed set** (account/region/slug/component) with **no project dimension**;
   adding one would require extending the parity fixture matrix as well, and that extra dimension has no counterpart whatsoever on the deployment side.

⇒ It lands in **the existing single author of project-derived names**, `lib/exec-env/project-schema.ts` (`projectSchema` / `projectRoleName` /
`projectLakeNamespace` are all there); **the target dimension still comes from the single source of truth's `toTargetSlug()`**, not assembled by hand.
Form: `bgp/project/<targetSlug>/<projectId as is>`. The prefix `bgp/` is one of the two self-managed prefixes allowed by the IAM write statement
(a name without it necessarily gets AccessDenied in the real environment while the unit tests show nothing ⇒ a dedicated assertion now pins it).

### 13bis.4 🔴 One **contract gap**, filled and written back

The object table in [the project-isolation specification](./project-isolation-spec.md), section 1, defines only "project DB role = `role_proj_<sanitize(id)>`" and **does not define the login user**.
Yet Redshift RBAC consists of two things, `CREATE USER` + `GRANT ROLE <role> TO <user>`: the role is the permission set,
the user is the principal that can log in with a password. Without a convention for the user name, the supply layer would have to improvise one on the spot = another "the same name assembled separately in two places".
⇒ Settled as **`user_proj_<sanitize(id)>`** (the same sanitize and the same prefix style as the role, visibly matchable),
and written back into the object table of [the project-isolation specification](./project-isolation-spec.md), section 1.

### 13bis.5 Slices ③④⑤: closed executor + supply layer + wiring + observability loop — code side done

**7 new modules / 2 endpoints**:

| Location | Contract it carries |
|---|---|
| `lib/exec-env/admin-ddl-executor.ts` | The closed executor with the **fixed nine-step sequence** of section 3.9a + the second entry `provisionProjectLogin()` |
| `lib/exec-env/target-clients.ts` | Per-target Redshift Data / Secrets Manager clients and their placement (step 8 of section 3.9a; the landing point of [the multi-region execution specification](./multi-region-execution-spec.md)'s lint guardrail against bare client construction) |
| `lib/exec-env/project-secret.ts` | The real implementation of `lookupProjectSecretArn` (replacing the stub that always returned `undefined`) |
| `lib/exec-env/project-cred-supply.ts` | The six supply steps + `listProjectsWithBindings` + the three-way `verifyProjectCredentials` |
| `lib/exec-env/cred-observability.ts` | The four parts of section 3.9b "fallback observability (closed loop)": audit event / metric / timeout alert / **zero-tolerance alert** |
| `lib/audit.ts`, extracting `writeAuditRecord` | An audit core that does not depend on `NextRequest` and **throws** (the prerequisite for fail-closed-on-audit) |
| `POST .../[targetId]/provision-credentials` | The **production caller** of the supply layer (without it, the supply layer is "code that was never verified") |
| `POST .../[targetId]/credential-state` | The **production caller** of section 3.9b's sole write channel (verbatim confirmation string + hard server-side validation + fail-closed audit) |

**🔴 Three places that differ from the original plan / contract (all for hard reasons, not for convenience)**:

1. **The password never enters a template ⇒ the new operation is `grant-role-to-login`, not `create-project-login`.**
   The previous version of section 13bis.5 (and the implementation in the work in progress) added `create-project-login` to the templates and stuffed the generated password into
   `VerifiedAdminDdlContext`. That **directly conflicts** with the decision long since fixed in `admin-ddl-templates.ts`:
   "the password **does not enter the templates**: template output goes into the audit, and the password must never land in the audit / logs". Reverted.
   Settled: a **pure-permission** statement (`GRANT ROLE … TO …`, zero literals) stays in the templates; **creating the user + setting the password + writing the secret**
   go through the executor's second entry `provisionProjectLogin()` — the statement is produced by the executor's **private** builder, **not cast as branded**,
   does not enter the audit details (the audit has only the fixed redacted descriptor `create-login:<user>@<target>`), and the error text passes through `redactSql` first.
   The password **never leaves that function, from generation to writing into Secrets Manager**, so an interface surface that "returns the password" simply does not exist.

2. **IAM was still missing one statement: slice ① opened only "write".** A hard gap found by measurement this round — `lookupProjectSecretArn` needs
   `DescribeSecret` by name, `verifyProjectCredentials` needs to check existence project by project, and executing with `SecretArn` through the Data API also needs
   `GetSecretValue`, while the account-wide broad read-only statement is on the **home axis** ⇒ per-project secrets for non-home **cannot be read**.
   The consequence is not an error: it is interpreted as "no credential" ⇒ **silent fallback to the shared admin** within the transition window (far worse than an error).
   ⇒ A second execution-axis statement was added (resource surface **only** `bgp/project/*`, narrower than the write statement's `bgp/*`);
   synth-gate's `EXEC_AXIS_EXPECTED` goes from **1 → 2** with the reason written down.
   Along the way: the three per-project credential statements (read / write / metrics) were moved into a separate `ExecEnvProjectCredentials` ManagedPolicy —
   because after adding the statement, synth-gate section 9f went red immediately (the TaskRole inline policy crossed CDK's 10KB split line, reshuffling **other existing statements**
   into the OverflowPolicy). This is the existing convention in the repository (8 precedents).

3. **The order of the supply steps = the dependency order, not the contract's textual order.** The first version, written in the contract's textual order, did not run:
   `create-project-schema`'s `ALTER SCHEMA … OWNER TO role_…` requires the role to exist first;
   `grant-role-to-login` requires the login user to exist first; `grant` requires `shared` to exist first.
   Settled order: **shared → role → schema → login → grant-role-to-login → grant** (each of the six steps has a unit test pinning its relative order).
   Also: Redshift has **no** `CREATE ROLE IF NOT EXISTS` (schemas have it, roles do not), so re-running the supply necessarily reports already-exists
   ⇒ idempotency is judged from the error text at this one step only (the only such place in the repository; the criterion is narrowed and applies only to the steps marked `tolerate`).

**🔴 The 18 wired call sites: distribution of the static classification (section 3.9: "the decision is a static classification per call site, not a runtime guess from the SQL")**

| Class | Count | Location |
|---|---|---|
| **project-context**, `project` passed | 12 | SQL Editor / schema tree / sync table-creation DDL / batch jobs (formal + trial run) / backfill / workflow publish / schedule enable-disable / ETL scheduling / Ask-Your-Data (`runSelect` + `introspectSchema`, passed through via `genbi/agent` ← `genbi/execute`) |
| **governance-read**, the contract says **do not pass** | 4 | Sensitive scan / metrics / quality / `modeling.execScalar` — the original text of section 3.9: "🔴 **never** go through `lookupProjectSecretArn` (they have no project ⇒ they would be wrongly judged fail-closed)", exactly the failure mode this module's risk P0-3 guards against |
| **admin / bootstrap / inventory**, not passed | 2 | DMS bootstrap (its proper home is `executeAdminDdl({operation:"dms-ingest-bootstrap"})`, but switching requires changing the password path of `ensureRedshiftDmsUser` as well ⇒ assigned to the DMS component batch of the multi-region component-stack work) · project-deletion inventory (the project is being deleted; counting its own tables under its own identity would fail closed ⇒ **the project could never be deleted**) |
| **project-context, wiring pending**, not passed | 1 | `modeling.execStatements` (modeling landing writes to the **`spec.schema` the user chose on the modeling page**, such as `public`/`dw`, not `proj_<id>` ⇒ flag=on would kill modeling landing, the same shape as the finding in [the multi-region execution specification](./multi-region-execution-spec.md), section 4.6, that "a blanket INSERT ban kills code-table landing". The prerequisite is that the data-migration batch brings the physical tables into the project schema) |

**🔴🔴 A boundary that must be made known: `PER_PROJECT_CRED=on` does not mean "can be switched on at any time".**
A per-project identity sees only `proj_<id>` and `shared`, while the running system's data is still in `public` (the data-plane migration is **the data-migration batch**).
So the correct prerequisite for flag=on is that the data-migration batch has landed. **This means the credential-supply batch's "functional conservation" acceptance can claim full-chain equivalence only under flag=off**;
under flag=on the acceptance criteria must be **isolation properties** (the per-project identity is really used + the cross-project negative tests pass + the governance classes still work),
not "everything as before". This was not discovered at acceptance time; it was derived from the design, and is written in the wiring comment of `admin-secret.ts`.

**Gates and mutations**: 5 new test files / +99 cases (platform vitest **1801 / 109 files** all green, tsc 0 on both sides,
naming-parity ✅, synth-gate ✅ execution axis = 2). **10 mutation tests, all red for the right reason**:
password into the audit / SecretArn omitted / a read failure treated as no credential / `unverifiable` merged into `missing` / the flag default changed to on /
the audit moved to after execution / lint passing fewer projectIds / the isolated fallback not throwing / wrong supply order / the in-use project list not paginated.

### 13bis.6 ✅ Real-environment headless acceptance: **44/44 green + 1 item recorded honestly** (the details are tracked with the multi-region execution work)

🔴🔴 **The very first real run caught a real bug that none of the 1801 unit tests had caught**:
the `create-project-schema` template used to produce `ALTER SCHEMA … OWNER TO "role_proj_<id>"` —
**a Redshift schema owner must be a user; a role cannot be an owner** (the real environment reported
`ERROR: user "role_proj_proj_01m1n2ap…" does not exist`).
Why the unit tests were all green: the template has had **zero production callers** since the foundation batch that introduced it, and the rule in `admin-ddl-contract.test.ts`
"schema / role names always come from the single source of truth" **only asserted that the role name appeared in the string** — **it was pinning this very bug**;
and the mocks never really run Redshift. This is the **second** real instance of the lesson that unwired code is unverified code
(the first was `assertProjectId` rejecting every real projectId).
With the login user as owner, **the original intent is in fact served better** (the comment already said "so that the tables the project creates itself naturally have a consistent owner",
and under per-project credentials every connection of that project is `user_proj_<id>`); the supply order was changed accordingly to
**shared → role → login → schema → grant-role-to-login → grant**. The gate now asserts per operation + with negative assertions;
two further mutation tests each went red for the right reason.

Also fixed one real-environment problem: `execOnTarget` polled with a fixed 1s initial interval ⇒ one supply run is ~10 statements, slower across regions,
and `POST /provision-credentials` against `tgt_usw2_a` went straight to **504**; changed to **a 150ms start × 1.6 backoff, capped at 1s**.

**The four most decisive acceptance items**:
- 🔴 **Non-home really created the secret in us-west-2**, and **that region's database** really has the schema and the login user (the hard criterion of decision ①);
- 🔴 **The cross-project negative test was rejected by Redshift itself** (`permission denied for schema proj_…`), **with a positive control** ruling out "merely unable to connect";
- 🔴 **`SELECT current_user` = `user_proj_<id>`** (run through the platform) — one statement proving at once that the flag works / the lookup works / the Data API really used that secret,
  an order of magnitude stronger than "the query did not error" (the latter is green with admin too);
- 🔴 **All three fallback observability pieces really landed** (audit event + alert event with an epoch dedup key + CloudWatch three-dimension metric Sum=1)
  ⇒ section 3.9b's sentence "a mere `console.warn` + an in-process Map is not an observability loop" is closed here.

⚠️ **Two items recorded honestly**:
1. **`isolated` was deliberately not really advanced.** It is monotonic and irreversible (the contract explicitly has no reverse API), and the precondition "all in-use projects have credentials"
   should not be satisfiable before the **data-migration batch** moves the data — had it really been advanced, anyone turning on the flag would find that the SQL Editor cannot see the existing data in `public`,
   **with no way back**. All of its **validation logic** was verified (reverse rejected / missing confirmation string rejected / rejected with the missing items listed / replay rejected);
   "after `isolated`, another process holding an old cache can no longer return admin" is to be verified after the data-migration batch.
2. `redeploy-platform.sh` **does not need** a human to pass `-c execution-regions` — its section 1b was changed back in the multi-region real-deployment slice to
   derive it from the registry (measured this round: `us-east-1,us-west-2`). The sentence carried over from the plan, "the script does not pass it", was stale information.

**Environment status**: `tgt_home` has been advanced to **`provisioning`** (epoch=1, deadline `2026-10-04`; step ④ of the section 3.9b go-live sequence,
no path is affected under flag=off); the platform has been redeployed with `PER_PROJECT_CRED=off`.

---

## 13. ✅ Implementation log of the run-record stamping batch (**closed out**, 2026-09-03; the same batch as the remainder of the multi-region first batch = the second construction wave)

> - The scheduling view and the acceptance details are tracked with the multi-region execution work (this section records only the contract landing points and the behavior changes on the project-isolation side).
> - Commits: the write side / the read side / the consolidation of the multi-region first batch, all in the same batch.

### 13.1 Where the contract landed

| Contract | Landing |
|---|---|
| Project-isolation specification, section 1: `bgp-task-runs` gains `projectId` | ✅ All **27** write sites go through the **single write channel** `lib/monitor/run-records.ts`; `stamp` is a **required parameter** ⇒ an unstamped run row cannot even be constructed at the type level |
| Multi-region execution specification, section 1.2: gains `targetId` | ✅ Stamped by the same channel in the same batch |
| Project-isolation specification, section 1: "read and write go live in the same batch" | ✅ The read side `monitor/runs` gains `requireProject(viewer)` + `projectFilter` in the same batch |
| Project-isolation specification, section 1, the correction "two classes on the read side" | ✅ **User views** (monitor/runs) get project filtering; **platform aggregates** (finops/baseline/alerting/diagnostics/incidents) deliberately **do not** — adding it would under-count existing data |
| Multi-region execution specification, section 6, the lint guardrail "no bare Put/Update against task-runs" | ✅ Landed as an AST gate (`ast-task-runs-writes.mjs` + a unit test running the real script); bare write sites outside the channel = **0** |
| Multi-region execution interaction design, section 3.3: monitor gains a region filter | ✅ `Select allowClear` + a "Region" column; the region is **derived** from `targetId` via the registry (not stored redundantly on the run row) |

### 13.2 🔴 **Behavior changes** recorded honestly (intended, not regressions)

1. **Runs of non-default projects no longer appear on the default workspace's monitor page.** That is exactly the purpose of the run-record stamping batch;
   existing unstamped runs stay in the default workspace through `projectFilter`'s legacy fallback (and in this environment all of them have been backfilled).
2. **`/api/monitor/runs` now requires login + project membership.** Before the change it had **zero guards**: any logged-in user could see the task names and error text of
   runs across the whole platform; a scripted caller must now send `Authorization` and `x-bgp-project`.
3. **`check_run_status` (the Copilot tool) returns failure for a cross-project taskId.** Before the change it **obtained the caller's identity but did not use it**;
   a project A user reporting a project B taskId could read B's run records — a **live escalation surface** caught while inventorying the read side in this batch.
4. **`fireDownstreamOnce` can no longer create ghost run rows** (the original condition was always true for a non-existent row).
5. **runtime-lib upgraded to v3** (new file name `bgp_workflow_runtime_v3.py`). Already-published existing DAGs still import v2
   ⇒ **they must be republished** to carry the stamp; measured in this environment, the `dags/` prefix had no published DAG at all, so this migration step had no object here.

### 13.3 🔴 Closure of section 11.3

The item that section 11.3 "deliberately deferred to the run-record stamping batch" (`monitor/runs` with zero guards) **has been closed in this batch**,
and the concern of the time, "adding the filter now makes all existing runs of non-default projects disappear", was dissolved by measurement: there are only 2 existing runs, both belonging to the default workspace;
after a reverse lookup through the resource rows they were backfilled, and the read side need not keep a permanent special-case branch for them.
