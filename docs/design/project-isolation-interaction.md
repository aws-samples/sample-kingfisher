# Project Isolation — Workspace Isolation + Cross-Workspace Copy · Interaction Design Chapter (Reasonableness / Convenience / Safety)

> Revision: **1.2** (4 scenarios + 🆕 **Scenario 5 "presenting the global knowledge layer `shared`"** + 🆕 **Scenario 6 "assigning operable targets (RBAC × target)"** + 🆕 **Scenario 7 "confirming cross-target reclamation when deleting a project"** + 🆕 **Scenario 8 "legacy table migration console"** + safety mechanisms + friendliness + ASCII wireframes) | Date: 2026-08-28 (revision 1.2: 2026-08-29) | Status: ⬜ in design, pending review
> 🎯 **Changes in revision 1.2 (filling the interaction gaps found by the convergence verification)**: adds **section 4quinquies, Scenario 8 "legacy table migration console"** — the legacy table migration is the heaviest migration this platform has ever done (moving `public.*` target by target + a final `DROP`); until now this document kept only **one line** about it in the convenience section 7, while the three acceptance criteria — **routing by the ownership ledger with claimable orphans, idempotent resumable runs, and backup + approval + unmigrated-table inspection before DROP** — **all require the UI to be visible** ⇒ without a console those three could only be run by hand with scripts, and acceptance would have nothing to assert.
> It covers a dry-run three-bucket preview / the **orphan-table claim ledger** (reads the new table `bgp-table-ownership`) / resumable progress / compatibility-period and "one-way door" markers / the **four DROP gates** (same tier as Scenario 7).
> 🎯 **Changes in revision 1.1**: takes over the **[design document](./project-isolation.md), revision 1.0 / [specification](./project-isolation-spec.md), revision 1.0** and the **[multi-region execution design](./multi-region-execution-design.md), revision 3.0** — ① decision #2 "two dimensions: region × project" introduces the `shared` global knowledge layer, which needs an interaction that says "this table is shared globally and you can only read it" (Scenario 5); ② RBAC × target was pulled forward from the second phase into the first ([multi-region execution design](./multi-region-execution-design.md), section 19.3), so member management has to assign "operable targets" (Scenario 6); ③ deleting a project is upgraded to **cross-target reclamation** (irreversible), so the confirmation interaction must move up a tier accordingly (Scenario 7).
> Upstream: the [design document](./project-isolation.md) (isolation gaps / copy mechanism / guard design). Sister chapter: the [multi-region execution interaction design](./multi-region-execution-interaction.md) (same specification).
> 🏛️ **Follows the platform-wide interaction constitution** (this chapter's "friendly refusal F8 / explain a restriction as division of duties F9 / private by default" have been distilled into the constitution; where they conflict, the constitution prevails).
> 🔴 Red line: this document is pure design; no code is written without an explicit instruction.

---

## 0. Positioning and Design Goals

The multi-region execution interaction is about "operations managing regions"; the project isolation interaction is about **day-to-day collaboration** — who may create projects, how resources are shared / copied between projects, and how a user is stopped in a friendly way when exceeding their permissions. The security surface of project isolation leans more toward **data isolation and privilege escalation** (the **12** escalation surfaces of the [design document](./project-isolation.md), section 0.2, plus the `GRANT ALL TO PUBLIC` back door of `execute-ddl`); the interaction must make "isolation" both strict and not grating.

### 0.1 The four main interaction scenarios

1. **Workspace creation / configuration management** (permission tightened to admin/manager; friendly degradation when a developer-owner loses management rights)
2. **Data source sharing** (the owner project sets `sharedTo`; the target project gets a read-only reference + a shared badge)
3. **Cross-project copy** (three-way conflict choice + automatic dependency rebinding / missing dependencies land as draft + bundled copy package — the most complex scenario)
4. **How users perceive the privilege-escalation guards** (after the **13** escalation surfaces get guards, a refusal gives a friendly "why + what to do" hint rather than a cold 403)

### 0.2 Principles throughout (carried over from the multi-region execution chapter; project isolation focuses on "isolation that does not grate")

1. **Anchor on existing UI conventions**: the inbox / approval drawer on the projects page, PromoteButton, row-action dropdowns, `FeatureGuide`, the `<Empty>` empty state, `Modal.confirm` danger confirmations.
2. **Private by default, shared explicitly**: a resource is visible only to its owning project by default; sharing is an active authorization action, not an open default.
3. **Automate whatever can be automated; humans only at authorization and genuine ambiguity** (carrying the "save manual work" value): dependency rebinding on copy matches by name automatically; humans only decide "share with whom / what to do on conflict / with or without dependencies".
4. **Refusals must be friendly**: exceeding permissions / insufficient permission is not a dead end; give a clear reason + a next-step exit (whom to contact, where to apply), and leave no dead ends.

---

## 1. Scenario 1: Workspace Creation / Configuration Management (permission tightening, [design document](./project-isolation.md) section D4)

### 1.1 Friendly presentation of the tightened creation permission

- `POST /api/projects` canCreate is tightened from admin/manager/developer to **admin/manager** ([design document](./project-isolation.md), section D4).
- Interaction: on the `/projects` page the "+ New workspace" button is **hidden outright for developers** (not a 403 only after clicking); the developer view gets one light hint at the top: "Workspaces are created by administrators / R&D managers; contact them if you need a new workspace" (friendly, leaves no confusion).
- admin/manager see the button; clicking it goes through the existing single-step `Modal + Form` (name / description, following the existing creation convention of the projects page).

### 1.2 Tightened configuration-management permission + developer-owner degradation (the place that most needs friendly handling)

Configuration management (rename / delete project / add, remove and change members / approval decisions) is tightened from "project owner" to **platform admin or manager-owner** ([design document](./project-isolation.md), section D4). The hard part = **existing developer-owners lose their management rights**; they must not be left confused or believing the system is broken:

- **Button visibility**: when a developer-owner enters their own project, the member management / rename / delete entries are **greyed out or hidden**, and hover / click gives an explicit hint: "Configuration management requires a platform administrator or R&D manager; you can still develop this project's resources as usual" (explaining "the permission is gone" as "division of duties" rather than "a failure").
- **The fallback 403 also carries a message**: even if someone bypasses the front end and calls the API directly, `api/projects/[id]/**` returns 403 with the message "Please contact an administrator / R&D manager (bgp-admin/bgp-manager)" (compatibility item of the [design document](./project-isolation.md), section D4), not a bare 403.
- **The knock-on effect of changing the approval decision-maker**: the approver of membership join requests changes from the owner to "admin / manager-owner" → the visibility of the "Pending my approval" inbox at the top of the projects page follows (a developer-owner no longer sees this project's pending approvals; only admin / manager-owner see them). For the developer-owner this is "one piece missing", which needs a FeatureGuide or a change announcement so nobody asks "where did my approvals go".

**Wireframe (project detail from the developer-owner's perspective, management entries degraded):**
```
┌─ Workspace: E-commerce Data Team ───────────────────────────────────────────────┐
│ 💡 You are the owner of this project (development rights). Configuration          │
│    management (members / rename / delete) requires an administrator or R&D       │
│    manager — you can still develop this project's sync / job / workflow resources.│
├──────────────────────────────────────────────────────────────────────────────────┤
│ Members (5)                                     [+ Invite member] ⊘ (greyed out)  │
│   · alice  editor      bob  viewer   …      hover: "requires admin/manager"      │
│ Project settings   [Rename] ⊘   [Delete project] ⊘     ← greyed out + Tooltip    │
│ Resources: sync (8) jobs (3) workflows (2)  ← create / edit as usual             │
│                                               (development rights unaffected)    │
└──────────────────────────────────────────────────────────────────────────────────┘
```
> Friendliness core: translate "permission tightening" from "a feature vanished / an error" into "a clear statement of division of duties + you keep the development rights you are entitled to", so the developer feels neither demoted and humiliated nor that the system is broken.

## 2. Scenario 2: Data Source Sharing ([design document](./project-isolation.md) section D1)

The pain point that data source sharing solves = **multiple projects referencing the same physical database should not each have to register the connection + credentials again** ([design document](./project-isolation.md), section D1). In the first phase only data sources are opened for sharing.

### 2.1 Owner project side: setting up sharing

- The data source list gets a row action "Share settings…" (visible only to editor+ of the owner project) → a drawer: multi-select target projects (dropdown = all projects) or tick "Visible platform-wide (for public code tables and the like)" = `sharedTo:["*"]`.
- Sharing is an **explicit authorization action** (private by default, design document principle 2): one sentence at the top of the drawer says "After sharing, members of the selected projects can **reference** this data source to build syncs, but cannot see its credentials and cannot edit / delete / re-share it".
- **secretArn / glueConnectionName / networkConfig are never exposed through sharing** (only "may be referenced" is shared; the physical credentials stay with the owning project).

### 2.2 Target project side: read-only reference

- In the target project's data source list, a shared-in source carries a **"From project X (shared)" badge** (blue Tag) + a read-only state: the edit / delete / re-share buttons are **greyed out** + Tooltip "Shared resources are read-only; contact the owning project to make changes".
- It can be selected as the source as usual when creating a sync task (which is the whole value of sharing).

**Wireframe (data source list · shared badge + share-settings drawer):**
```
┌─ Data Sources ───────────────────────────────────────────────────────────────────────┐
│ prod-mysql-orders                           mysql  ●healthy  [Share settings][Edit][Del]│
│ user-profiles 🔗from "User Center Team" (shared)  mysql  ●healthy  [Edit]⊘[Del]⊘ [Test]│
│                                                     ↑read-only badge  ↑greyed + Tooltip │
├─ Click "Share settings" → drawer ─────────────────────────────────────────────────────┤
│  Share prod-mysql-orders with:                                                        │
│   ☑ E-commerce Analytics   ☐ Risk Control   ☑ Visible platform-wide (*)               │
│  ⓘ Shared-to projects can reference it to build syncs; they cannot see credentials    │
│    and cannot edit / delete / re-share.                                               │
│                                                      [Cancel]  [Save share settings]  │
└───────────────────────────────────────────────────────────────────────────────────────┘
```
> Friendly + safe: the badge makes "this is not my source" recognizable at a glance (danger-zone visual); read-only buttons are greyed out rather than erroring after a click (F4); the sharing text spells out "what you can / cannot do", dispelling the worry that "sharing = handing over credentials".

## 3. Scenario 3: Cross-Project Copy ([design document](./project-isolation.md) section D5, the most complex interaction)

Copy = read the definition + write the definition (the source is untouched, a replica is created in the target, and runtime state / schedules / bindings are all stripped). The interaction difficulty concentrates on **conflict handling** and **dependency rebinding** — the user must see clearly "what this will become once copied over".

### 3.1 Entry point and target selection

- The list row actions of the 5 resource types (sync / etl-job / engine-job / workflow / redshift-task) gain "Copy to project…" (**shown only when the user can see ≥ 2 projects**; otherwise it is meaningless); data sources **do not get this item** (shared only, never copied — the secretArn is a physical binding that cannot be moved).
- The target-project dropdown in the dialog = **the projects where I am editor+** (double permission check: viewer+ required in the source and editor+ in the target, [design document](./project-isolation.md) section D5).

### 3.2 Three-way conflict choice + dependency preview (core)

The dialog shows "what will happen once copied" in real time (impact preview):

**Wireframe (copy-to-project dialog):**
```
┌─ Copy "Daily report workflow" to project… ─────────────────────────────────────────┐
│  Target project:  [E-commerce Analytics ▾]   (dropdown = projects where I am editor+)│
│                                                                                     │
│  ⚠ The target project already has a "Daily report" with the same name — choose:     │
│    ● Rename (default)   New name: [Daily report-copy__________]                      │
│    ○ Overwrite          (selectable only if the target replica came from the same     │
│                          source; a rollback point is kept automatically)             │
│    ○ Cancel                                                                         │
│                                                                                     │
│  Dependency handling (analyzed automatically):                                      │
│    · references sync "Order sync"     → ☑ copy along (topological order: create the  │
│                                          sync first, then rebind)                   │
│    · references data source "Orders DB" → same name exists in target ✓ auto-rebound │
│    · 2 downstream trigger dependencies → meaningless across projects; cleared after  │
│                                          copying (hint)                             │
│                                                            [Cancel]   [Copy]        │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

- **Three-way conflict choice** ([design document](./project-isolation.md), section D5): ① rename (default, prefilled with `-copy`); ② overwrite (selectable **only when the target was previously copied from this same source**, i.e. copiedFrom matches; otherwise the option is greyed out; before overwriting a `snapshotVersion` is taken automatically as a rollback point, reusing the [versioning and rollback](./versioning-rollback.md) module); ③ cancel.
- **Automatic dependency analysis** (the core of convenience, saving manual work):
  - Data source references → **rebound automatically by exact name match** inside the target project (✓ green mark); no match → the replica lands as `draft` + a conspicuous "⚠ missing reference, rebinding needed" mark (data sources are not copied automatically — the physical binding cannot be moved).
  - workflow → sync references → a "copy along" checkbox (ticked by default) that bundles them, copies in topological order and rebinds to the new ids; unticked, the replica lands as draft pending rebinding.
  - triggers → **not carried over** (a cross-project dependency chain is meaningless); cleared after copying + a hint.
- Copy succeeded → the replica appears in the target project's list for that resource (with a "From project X (copy)" provenance mark, plus a "missing reference" mark if it is a draft), `message.success`; written to the audit (source / target).

### 3.3 Guidance for choosing between copy and the multi-environment release flow ([design document](./project-isolation.md) section D6)

One light pointer at the bottom of the copy dialog + the help text on /projects spell out the two modes: **within one project, test→prod uses environment promotion of the [multi-environment release](./multi-environment-release.md) module (with `lineageId` continuous-promotion semantics)**; **cross-team reuse / bootstrapping a new project uses this copy (each copy is an independent event, no continuous promotion)**. Neither is pushed; the user chooses by scenario.

## 4. Scenario 4: How Users Perceive the Privilege-Escalation Guards ([design document](./project-isolation.md) section D3, **13** escalation surfaces)

The [design document](./project-isolation.md), sections 0.2 / D3, adds guards to 9 escalation surfaces that used to be "usable as soon as you log in". **Adding guards is a security fix, but in the interaction it must not turn into a cold 403** — otherwise normally collaborating users hit a wall, get confused, and think the system is broken. The core = **distinguish two kinds of refusal and give each a different exit**:

| Refusal type | Scenario | Friendly hint + exit |
|---|---|---|
| **Not a member of this project** (can apply) | accessing / operating a resource that does not belong to one's own project | "You are not a member of 'project X' and cannot operate its resources. **[Apply to join project X]**" → goes straight to the join request (through membership approval) |
| **Insufficient permission** (role too low) | is a member but the role is too low (a viewer wants to write) | "This action requires editor+ permission; you are currently a viewer. **Please ask the project owner to raise your role**" |
| **Platform role restriction** | a developer wants to create a project / manage configuration | "This action requires an administrator / R&D manager (see the degradation hint of Scenario 1)" |

- **Data-plane entry points must be especially friendly**: entry points such as `redshift/execute` and `sync/execute-ddl` that gained `requireProject` must, when triggered by a non-member, show the hints of the table above in the SQL editor / DDL page (instead of the execute button spinning for a long time after the click and finally ending in a bare 403).
- **Fallback**: every guarded API that returns 403 **must carry a structured message** (reason + optional actionHint), from which the front end renders "why + what to do"; never a bare 403.

## 4bis. 🆕 Scenario 5: Presenting the Global Knowledge Layer `shared` (decision #2 "two dimensions: region × project")

> Background ([design document](./project-isolation.md) section 7bis.2a / [specification](./project-isolation-spec.md) section 3.8): the physical tables of the "enterprise common vocabulary" such as code tables and conformed dimensions land in the **`shared` schema** (GRANT SELECT to all `role_proj_*`, **not PUBLIC and not proj_**), while project-private business data lands in `proj_<id>`; **one set per target**. The core contradiction the interaction must resolve: users will see "a table I can query, that does not belong to my project, and that I cannot change" — if this is not explained, it will be misread as "isolation is broken" or "someone else's data leaked to me".

### 4bis.1 Visual layering of the three kinds of data-plane objects (understand "what table is this" at a glance)

| Category | Badge | Permission semantics | Where it appears |
|---|---|---|---|
| **This project's business data** `proj_<id>.*` | 🔵 `This project` | read / write (by role) | data catalog, SQL editor schema tree, selectable tables in Ask-Your-Data |
| 🆕 **Global knowledge layer** `shared.*` | 🟡 **`Global shared · read-only`** | **readable by all projects, written only by platform modeling** | same as above, but placed in a **separate group** "Global shared (code tables / dimensions)" |
| **Other projects' data** `proj_<other>.*` | — | **invisible** (not even found at the DB permission layer) | **does not appear** (not greyed out — simply not listed) |

- **SQL editor schema tree**: two groups — "This project (`proj_x`)" and "🟡 Global shared (`shared`)"; hovering a table in the `shared` group shows "Global common vocabulary (code tables / conformed dimensions), readable by all projects; to change it, go through the modeling module".
- **Pre-emptive interception of writes (F8 friendly refusal)**: when a user writes DDL / DML against `shared.*` → **intercept before submission** (do not wait for the DB error) with the hint "`shared` is the global knowledge layer and is read-only. To change a code table go to [Modeling › Code tables] (→ deep link)"; avoid throwing the DB's bare `permission denied` at the user.
- **Selectable tables in Ask-Your-Data / BI**: `shared` tables are selectable as usual (they exist precisely for all projects), but carry the 🟡 mark in the field picker so users do not mistake them for their own project's tables.

### 4bis.2 Modeling side: making "where code tables / dimensions land" explicit (linked with axis A of multi-region execution)

- The landing panel of Modeling › Code tables / Dimensions **states explicitly that it lands in `shared`** (no longer a vague "land in the database") and lists **which targets it will land on** (the `targets[]` binding of the [multi-region execution specification](./multi-region-execution-spec.md), section 3.8, + the `landedByTarget` status).
- One status row per target: `✓ landed v3` / `⚠️ versions differ` / 🔴 **`drift` (that region already has a heterogeneous table of the same name)** (`⊘ blocked by residency gate` was withdrawn on 2026-09-05: no legal gate, [multi-region execution design](./multi-region-execution-design.md), section 18, item 6quinquies).
- 🔴 **Friendly handling of `drift`**: not silent, not falsely green — a red row + "This target already has a table with the same name but a different structure; the platform did not overwrite it" + exits [View differences] [Force rebuild from the platform definition (dangerous, goes through a second confirmation)].
- 🔴 **Presenting a residency-gate block**: `⊘ This code table is marked "not shareable across jurisdictions" and was not pushed to eu-target` + exit [Change to shareable (requires approval)].

**Wireframe (Modeling › code table landing panel):**
```
┌─ Code table "Order status dim_code_order_status" · Landing ──────────────────────────┐
│ Landing location: 🟡 shared schema (global knowledge layer, readable by all projects)  │
│ Land on which execution targets:  [tgt-use1-home ✓] [tgt-usw2-a ✓] [tgt-euw1 ⊘]      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  tgt-use1-home   ✓ landed v3   2 min ago                                             │
│  tgt-usw2-a      🔴 drift      this region already has a same-name table with a       │
│                                different structure                                   │
│                                [View differences] [Force rebuild from platform def ⚠] │
│  tgt-euw1        ⊘ not pushed  this code table is marked "not shareable across        │
│                                jurisdictions"  [Request change to shareable]         │
└──────────────────────────────────────────────────────────────────────────────────────┘
```
> Friendliness core: turn "which schema / which regions it landed on / why it did not land" from back-office state into **one screen the user can read and act on**; `drift` and "blocked by the gate" are **never shown as ✓** (prevents a falsely green dashboard, [specification](./project-isolation-spec.md) section 3.8).

## 4ter. 🆕 Scenario 6: Assigning Operable Targets (RBAC × target, first phase)

> Background ([multi-region execution design](./multi-region-execution-design.md) section 19.3 / [multi-region execution specification](./multi-region-execution-spec.md) section 3.12): the authorization axis expands from "project × environment" to **project × environment × `targetId`**, and a new **region administrator** role is added; a project editor **must not indiscriminately** push tasks down to any cross-jurisdiction target. The interaction must keep "one more dimension" from becoming "twice the configuration burden".

- **The default is the least effort**: members inherit "the set of targets the project is already bound to" by default, **no per-person configuration needed**; only when tightening is needed (e.g. "only the compliance team may operate the EU region") is an explicit assignment made → avoids having to click through a configuration every time a person is added.
- **The member management table gains a column "Operable targets"**: it shows `Inherit from project (3)` by default; opening it switches to explicit ticking; cross-jurisdiction targets in the tick list **carry a 🌍 jurisdiction badge + the hint "this region is a separate jurisdiction; operations are audited"**.
- **Up-front feedback at push-down time (constitution B6: tell early rather than fail afterwards)**: in a resource editor's target multi-select, **targets without permission are greyed out + Tooltip** "You do not have operate permission on `tgt-euw1`; contact an administrator / region administrator"; the one-click "Select all active regions" **skips targets without permission automatically** and notes beside the button "1 region without permission skipped".
- **Region administrator role**: appears as a separate item (`region-admin`) in the member role dropdown, with the hover explanation "may manage the execution environments and push-downs of the designated targets; does not include platform-level configuration".
- **Audit**: target permission changes go into `bgp-audit` (who opened which target for whom).

**Wireframe (member management · operable targets):**
```
┌─ Workspace: E-commerce Data Team › Members ──────────────────────────────────────────┐
│ Member        Role          Operable execution targets                                │
│ alice         editor        Inherit from project (3) ▾   ← default, zero configuration│
│ bob           editor        Explicit: home, usw2 ▾       ← tightened                  │
│ carol         region-admin  Explicit: euw1 🌍 ▾          ← region admin, EU only      │
│ dave          viewer        — (read-only, no push-down involved)                      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ 🌍 = cross-jurisdiction target (operations audited; the former "legal sign-off must be │
│      in place first" was withdrawn on 2026-09-05)                                     │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## 4quater. 🆕 Scenario 7: Deleting a Project = Cross-Target Reclamation (irreversible, four gates)

> Background ([specification](./project-isolation-spec.md) section 3.9): deleting a project no longer just deletes two central tables; it must **DROP the `proj_<id>` schema / role / secret / data lake namespace target by target (including cross-jurisdiction targets)** — **destructive and irreversible**, and it involves deleting data across jurisdictions (the positive side of the compliance "right to be forgotten", but a wrong deletion is real data loss). Hence the confirmation tier must be **higher than deleting an environment**.

1. **Mechanism C, permission**: only a platform admin or manager-owner may initiate it ([design document](./project-isolation.md), section D4).
2. **Mechanism B, impact preview (must be computed first)**: list, for **every target**, the objects that will be deleted and the **data volume** — table count / estimated row count of the `proj_x` schema, role, secret, lake namespace; and state explicitly "business data will be permanently deleted".
3. **Mechanism A, strong confirmation**: require **typing the project name** (following the delete-environment convention of multi-region execution) + ticking "I confirm the data is backed up or no longer needed".
4. **Mechanism C, approval + backup first**: goes through `bgp-approvals`; 🔴 **after approval, back up first (UNLOAD / snapshot), then DROP** ([specification](./project-isolation-spec.md) section 3.7 keeps a way back before DROP), with the backup location shown in the preview; the approver can **replay the impact-preview snapshot from the initiating end** (prevents rubber-stamping; carries the approval receiving-end rule of section 5bis of this chapter).
5. **Execution and traces**: executed target by target, the page shows progress per target; `bgp-audit` throughout (`project-purge` events carry the targetId), and deletions on cross-jurisdiction targets **leave separate traces** (provable for compliance).

**Wireframe (delete project · impact preview):**
```
┌─ Delete workspace "E-commerce Data Team" — Impact preview ───────────────────────────┐
│ ⚠ This will [PERMANENTLY DELETE] the project data on each execution target below;     │
│   it cannot be undone:                                                                │
│                                                                                       │
│  tgt-use1-home   proj_ecom:  12 tables / ~420 million rows · role · secret            │
│  tgt-usw2-a      proj_ecom:   3 tables / ~1.8 million rows · role · secret            │
│  tgt-euw1 🌍     proj_ecom:   5 tables / ~9 million rows · role · secret              │
│                  (cross-jurisdiction: the deletion leaves a separate trace, usable as  │
│                   compliance evidence)                                                │
│  Lake namespaces:  proj_ecom × 3 targets                                              │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ Backup: after approval, automatic UNLOAD to s3://…/purge-backup/<project>/<timestamp>/ │
│ ☐ I confirm the data is backed up or no longer needed                                 │
│ Type the project name to confirm: [                  ]  [Cancel] [Submit for approval (disabled)]│
└───────────────────────────────────────────────────────────────────────────────────────┘
```
> Difference from deleting an execution environment in multi-region execution: deleting an environment **keeps the data buckets** (RETAIN); deleting a project **really deletes business data** → hence the extra "backup first + tick to confirm" gate; typing the name alone is not enough.

## 4quinquies. 🆕 Scenario 8: Legacy Table Migration Console (the legacy table migration, `public`→`proj_`/`shared`; includes orphan-table claiming + four DROP gates)

> Background and the reason for adding this scenario (an **interaction gap** found by the convergence verification on 2026-08-29): the legacy table migration is **the heaviest migration this platform has done to date** — target by target, the existing `public.*` tables are moved into `proj_<id>` / `shared`, and at the end the **compatibility-period tables are `DROP`ped**.
> Yet until now this interaction chapter kept only **one line** about it in the convenience section 7 — "provide a progress view + an orphan-table claim ledger" — **with no scenario-level design**;
> while the three acceptance criteria — **idempotent / resumable runs, S3 backup + approval + unmigrated-table inspection before DROP, and routing by the ownership ledger (no ledger entry → `proj_default`, claimable)** — **all require the UI to be visible**; without a console these three could only be run by hand with scripts, acceptance would have nothing to assert, and an error would have no way back.
> Ownership data source = the new table **`bgp-table-ownership`** ([specification](./project-isolation-spec.md) sections 1 / 3.7).

**Where it lives**: a new "Legacy table migration" page in the governance area (platform admin only; invisible to non-admins, [design document](./project-isolation.md) section D4). **Switched target by target**; one target is one migration job.

1. **Mechanism B, pre-migration preview (dry-run first)**: run a dry-run first and list that target's `public.*` tables in three buckets according to the ledger — **① owned** (→ `proj_<id>`), **② global knowledge class** (`kind=modeling-global` → `shared`), **③ orphans** (no ledger record → `proj_default`, pending claim). 🔴 **The three bucket counts must be shown explicitly**, and in particular when the orphan count > 0, **entering the real run directly is not allowed by default** (claim first, see item 2), to avoid "finishing the migration only to discover a pile of tables went into `proj_default`".
2. **Orphan-table claim ledger** (the positive exit of the ledger-routing criterion): the orphan bucket gets an actionable table — columns = `fqn` / creation time / creator (if any) / row count / last queried time (helps judge ownership) / **owning-project dropdown**. The admin can **claim one by one or in bulk**; claiming writes `bgp-table-ownership`. 🔵 Reuses the row-action + bulk-selection conventions. **Unclaimed tables may be released explicitly** (tick "the rest go to `proj_default`, to be claimed later"), but **it must be an active tick, not the default**.
3. **Real run + progress / resumption** (the idempotency criterion): a progress bar with the four states `pending / migrated / failed / skipped` at table granularity + a detail list; **a failed table can be retried individually**; after an interruption, re-entering the page **resumes without re-migrating** (idempotency is guaranteed by the progress table of the [specification](./project-isolation-spec.md), section 3.7; the UI is only its view). 🔴 **Related queries on that target are briefly affected during the migration** ⇒ a "migration in progress" banner at the top of the page + the expected impact scope (using the same expression as draining in the [multi-region execution interaction chapter](./multi-region-execution-interaction.md), section 4quinquies).
4. **Compatibility period visible**: the default path (a) keeps `public` as a **read-only compatibility period** — the page states "compatibility period until X; during it the old `public.` references remain readable"; tables for which path (b) `ALTER ... SET SCHEMA` was chosen **must carry a conspicuous "no compatibility period · one-way door" marker** ([specification](./project-isolation-spec.md) section 3.7 / [design document](./project-isolation.md) section 7bis.4), because **the only rollback is a reverse ALTER**.
5. **Four DROP gates** (the DROP criterion; same tier as Scenario 7 but a different object): ① **the unmigrated-table inspection must be 0** before a DROP may be initiated (not 0 → the button is disabled and the remaining tables are listed); ② **the S3 backup objects must exist** before it is released (show the backup path + object count; a failed backup **aborts and does not swallow the error**); ③ **goes through `bgp-approvals` approval**, and the approver can replay the impact-preview snapshot from the initiating end; ④ **type the target name + tick to confirm**. 🔴 **After the DROP, recovery is possible only from the S3 backup** — this sentence must appear in the confirmation dialog.
6. **Traces**: `bgp-audit` throughout (`schema-migrate` / `schema-drop` events carry `targetId`), with separate traces for cross-jurisdiction targets.

**Wireframe (migration console · dry-run result):**
```
┌─ Legacy table migration · Execution target [tgt-usw2-a ▾] ───────────────────────────┐
│ dry-run finished (2026-08-29 10:12)  47 tables in public                             │
│                                                                                      │
│  ① owned → proj_*                 38 tables   [View details]                         │
│  ② global knowledge → shared       5 tables   (code tables dim_code_* · conformed     │
│                                                dimensions)                           │
│  ③ orphans (no ledger record)      4 tables   ⚠ claim first, otherwise they go to    │
│                                                proj_default                          │
├─ Orphan-table claiming ──────────────────────────────────────────────────────────────┤
│  public.tmp_sales_0731   created 2026-07-31  ~1.2 million rows  last queried 08-20   │
│                                              Owning project [E-commerce Data Team ▾][Claim]│
│  public.ext_partner_ref  created 2026-06-02  ~3,000 rows        last queried —       │
│                                              Owning project [Select…             ▾][Claim]│
│  … 4 in total                                      [Claim in bulk] [Export list CSV]   │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ☐ The remaining orphan tables go to proj_default, to be claimed later                │
│   (the real run is allowed only after ticking)                                       │
│                                        [Re-run dry-run]  [Start migration (disabled)]│
└──────────────────────────────────────────────────────────────────────────────────────┘
```
> **Division of labor with Scenario 7 (delete project)**: Scenario 7 deletes **all objects of one project on every target**; this scenario moves **all legacy tables on one target** — two orthogonal axes, but the DROP gates are on the same tier (backup + approval + strong confirmation), and the wording is deliberately kept consistent to reduce mis-operation.

## 5. Safety Interaction Mechanisms (carrying the four mechanisms of the multi-region execution chapter; project isolation focuses on data isolation)

| Operation | A second confirmation | B impact preview | C tiered permissions + approval | D danger-zone / isolation visuals |
|---|---|---|---|---|
| **Delete workspace** | ✅ confirm by typing the project name (heavy tier) | ✅ list the project's resources / members / data-plane table count — **resources present = deletion forbidden (400 with the detail list + an exit "go migrate / delete the resources")**, not merely a warning (aligned with the [design document](./project-isolation.md) section D4 and consistent with deleting an environment in multi-region execution; prevents orphaned `proj_<id>` schemas / dangling projectIds) | ✅ admin / manager-owner; forced deletion with resources goes through approval | ➖ |
| **Copy — overwrite** (overwrite chosen on conflict) | ✅ overwrite confirmation | ✅ preview before overwriting + automatic snapshotVersion rollback point | ✅ viewer+ in the source and editor+ in the target | ➖ |
| **Copy — create new** | ➖ | ✅ preview of dependency rebinding / missing references / cleared triggers | ✅ double permission check | ✅ the replica carries a "From X (copy)" provenance mark |
| **Data source sharing** | ➖ | ✅ the drawer states "what the shared-to party can / cannot do" | ✅ editor+ of the owner project | ✅ a "From X (shared)" read-only badge on the target side |
| **Access to an escalation surface** | ➖ | ➖ | ✅ requireProject / guardResourceAccess | ✅ the refusal gives "why + exit" (Scenario 4) |
| **Create workspace** | ➖ | ➖ | ✅ admin / manager (entry hidden for developers) | ➖ |

- Aligned with the design document: approvals reuse bgp-approvals (membership joins); the copy double permission check = the `copy-resource` service side ([design document](./project-isolation.md) section D5); sharing / copying / permission changes all go into bgp-audit ([design document](./project-isolation.md) section 5).
- **Honest boundary of data-plane isolation (🔴 updated per decision C2, carrying the [design document](./project-isolation.md) section 7bis)**: ⚠️ **Decided on 2026-08-27 (decision C2): data-plane isolation ships in the first phase (a major upgrade), no longer deferred to the second phase** — this item has been revised accordingly (revision 1.0 said "data plane in the second phase", the old wording from before decision C2, now corrected).
  - The first phase does **control-plane guard tightening + true data-plane isolation** at the same time (L1 revoke `GRANT ALL TO PUBLIC` → L2 an independent `proj_<id>` schema per project → L3 a DB role / credential per project + Lake Formation, with the query side switched to the project identity).
  - **The help text truthfully says "both the control plane and the data plane are isolated per project (schema / DB role / LF)"**;
  - only **row-level isolation (RLS)** still belongs to the second phase of the [governance deepening](./governance-deepening.md) module; the text may note "row-level fine-grained isolation (RLS) as a later enhancement".
  - No exaggeration in the interaction — while L1 / L2 / L3 roll out in batches, the help text describes truthfully the level reached so far (e.g. when only L1 / L2 are done, write "schema isolated, query-identity isolation in gradual rollout"), and only at L3 does it say "data plane fully isolated" (echoing constitution A4, honest boundary).

### 5bis. Approval "Receiving End" Interaction (added after the deep review: only the initiating end had been designed; an approver approving blind = the gate fails)

> Both multi-region execution and project isolation route high-risk operations (delete environment / delete project / forced deletion with resources / cross-region deployment) into bgp-approvals, but until now **only the initiating end was designed** (impact preview + typing the name); what the approver sees in the inbox was not designed — if the approver cannot see the blast-radius list from the initiating end, the "human approval gate" degrades into a rubber stamp. This item is the platform-wide rule for the approval receiving end (referenced from multi-region execution as the same source):

- **Dangerous approval items replay the initiating end's impact preview**: in the approval drawer / detail, dangerous approvals (exec-env-delete / project-delete / region-deploy / forced deletion with resources) must **replay the impact snapshot taken at initiation in full**: scope of destruction / change, data-protection notes (e.g. "data buckets are kept (RETAIN) and need separate manual cleanup"), the list of bound resources, the initiator, the time. Only when the approver sees the full blast radius can they decide.
- **Closed-loop notification to the initiating end after approval**: approve → the initiating end receives "approved; destruction / deployment starts automatically" → progress is visible (the same deployment progress view as section 1 of the multi-region execution interaction chapter); reject → the initiating end receives the rejection reason.
- Anchor: the approval drawer Table already exists at `app/projects/page.tsx:181-314`; extending its rendering of dangerous items (reading the impact snapshot in the approval payload) is enough; no new component.

### 5ter. Data-Plane Isolation Operation Interaction (added after the deep review: the first-phase main line of decision C2, section 7bis, had no interaction at all)

> The data-plane isolation of section 7bis (L1 revoke GRANT / L2 schema migration / L3 credentials) is the heaviest block of the project isolation first phase, yet its operating interaction was missing. When an administrator performs "changing the data layout of a production system" — the most dangerous kind of operation — the interface must hold the line:

- **Legacy table migration console** → ✅ **upgraded to a scenario-level design, see section 4quinquies, Scenario 8** (revision 1.2: originally there was only this one line here, not enough to build from, while the acceptance criteria for ledger routing, idempotent resumption and the DROP gates all require the UI to be visible). Ownership data source = the new table **`bgp-table-ownership`** ([specification](./project-isolation-spec.md) sections 1 / 3.7), including the dry-run three-bucket preview / orphan-table claim ledger / resumable progress / compatibility-period and one-way-door markers / four DROP gates.
- **Dependency list preview before revoking GRANT PUBLIC (L1)**: the [design document](./project-isolation.md), section 8bis (priority-0 item 2), requires listing "the existing queries / reports that depend on this grant" before revocation and revoking gradually → the interaction shows this list + a tick "I confirm these consumers have been migrated".
- **Second confirmation for DROP of public tables (heavy tier)**: section 7bis.4 requires an UNLOAD / CTAS backup before DROP → the interaction uses the **heavy-tier typed-name confirmation** + states "backed up to S3 path X; this operation permanently deletes the public tables".
- **F8-friendly handling of data-plane escalation**: a member of proj_A queries `proj_B.<table>` in the SQL editor / GenBI and is refused at the Redshift layer (the L3 credential has no permission) → do not just throw Redshift's raw error; the front end recognizes "cross-project schema access refused" → shows "You are not a member of project X and cannot query its data" (the same F8 as the application-layer 403 of section 4, but this refusal happens at the **data-plane layer**).

## 6. Anchors in Existing Interaction Conventions (all 🔵, carrying the survey of the multi-region execution chapter)

| Project isolation interaction | Existing convention reused | Evidence |
|---|---|---|
| Project management / members / approvals | the inbox `<Card Pending my approval>` on the projects page + the approval Table in the drawer + inline approve / reject links | `app/projects/page.tsx:181-314` 🔵 |
| Underlying mechanism of the copy dialog | reuse `promote-service.executePromote` + PROMOTE_EXCLUDE (generalized into copyToProject) | `lib/env/promote-service.ts:79-150` 🔵 |
| Apply to join a project | the existing membership request `Popconfirm Submit join request` | `app/projects/page.tsx:232` 🔵 |
| Rollback point before overwriting | reuse the [versioning and rollback](./versioning-rollback.md) module's VersionHistoryDrawer / snapshotVersion | `components/common/VersionHistoryDrawer.tsx` 🔵 |
| Row actions / danger confirmation | list row-action dropdown + `Modal.confirm` / `Popconfirm` | existing conventions of the datasources / workflow pages 🔵 |
| Per-page guidance / empty state | `FeatureGuide` + `<Empty description>` | `components/common/FeatureGuide.tsx` 🔵 |

**Needs new design (not covered by existing conventions)**: ① the "shared badge + read-only state" (existing resources have no display for "shared in from another project"); ② the "automatic dependency analysis preview" in the copy dialog (the existing promote has no UI for cross-project dependency rebinding); ③ the draft annotation "missing reference, rebinding needed" + a rebinding entry; ④ the structured "why + exit" hint for an escalation 403 (most existing ones are bare message.error).

## 7. Friendliness & Convenience + Interaction-Layer Risks and Acceptance

### 7.1 Friendliness (where F1–F7 of the multi-region execution chapter land in project isolation)

- **F1 per-page guidance**: the FeatureGuide on the projects page explains "a workspace = the unit of resource isolation; who may create / share / copy"; one sentence of explanation at the top of the copy / share dialogs.
- **F2 empty-state exit**: when there is no target project to copy to: "You have only 1 project; copying needs ≥ 2 projects where you are editor"; when there is no sharing source, behave as usual.
- **F3 defaults**: conflict defaults to "Rename" + prefilled `-copy`; copy-along ticked by default; sharing ticks no project by default (private).
- **F4 help close at hand**: Tooltips at error-prone spots such as sharing / overwriting / specialization.
- **F6 recoverable failure**: a copy landing as draft is not a dead end — it gets a "Rebind references" entry; an overwrite has a snapshotVersion to roll back to.
- **F7 jump nearby**: the "Apply to join" in a refusal hint is a direct link; the replica draft's "Go rebind" goes straight to the editor.

### 7.2 Convenience (carrying the "save manual work" value)

- **Data source sharing removes duplicate registration**: multiple projects referencing the same physical database no longer have to re-register the connection + credentials in every project (the original intent of the [design document](./project-isolation.md), section D1).
- **Automatic rebinding on copy reduces the manual work of porting**: dependencies are matched by name automatically; humans only step in as a fallback to rebind when it cannot be inferred automatically (no source of the same name in the target).
- **Bundled copy package**: workflow + its syncs become one package with one click, with no need to copy them manually one by one and then wire them up by hand.

### 7.3 Interaction-Layer Risks and Headless Acceptance

| Interaction risk | Mitigation |
|---|---|
| Accidentally overwriting a production replica in the target project | overwrite selectable only when copiedFrom matches + second confirmation + automatic snapshotVersion rollback point |
| Sharing misread as handing over credentials | the drawer states "cannot see credentials / cannot edit or delete"; secretArn never crosses projects |
| A copy missing a dependency cannot run | automatic dependency analysis + missing references land as draft with a conspicuous mark + replicas that have not been rebound are blocked from running directly |
| Escalation guards hurting normal collaboration | Scenario 4 "why + exit"; distinguish non-member (can apply) / insufficient permission (ask the owner) |

**Headless acceptance essentials** (following the red line: assert the DOM through CloudFront + assert the real state source):
- [ ] A developer does not see the "New workspace" button; calling the API gives 403 with the hint text.
- [ ] A developer-owner enters a project: member / rename / delete entries greyed out + Tooltip; development resource functions work normally (regression).
- [ ] Data source sharing: A shares with B → B's list shows the shared badge + read-only (edit / delete greyed out) and can build a sync referencing it; B cannot edit / delete / re-share (403 with a hint).
- [ ] Copy: the three choices of the same-name conflict dialog actually take effect; the overwrite option is selectable only when copiedFrom matches; a missing datasource reference lands as draft with a conspicuous mark; a bundled workflow + sync package publishes as succeeded in project B (real state source Glue / MWAA); triggers are cleared.
- [ ] Escalation surfaces (redshift/execute etc.): a non-member call is refused and gets the "why + apply to join" exit, not a bare 403.
- [ ] bgp-audit has records of sharing / copying / permission changes throughout; the contract regression check reports zero FAIL.
- [ ] 🆕 **Scenario 5, `shared` presentation**: the SQL editor schema tree is split into the two groups "This project" / "🟡 Global shared"; **other projects' schemas do not appear at all** (not greyed out); DDL / DML against `shared.*` **is intercepted before submission** and gets the modeling deep link (not a bare DB error); the modeling landing panel shows the three `landedByTarget` states, **`drift` as a red row and `⊘ blocked by gate` with a request exit** (neither is **ever shown as ✓**).
- [ ] 🆕 **Scenario 6, RBAC × target**: members default to "Inherit from project" with **zero configuration**; targets without permission are **greyed out + Tooltip** in the editor's multi-select; "Select all active regions" **skips regions without permission automatically and notes how many were skipped**; cross-jurisdiction targets carry the 🌍 badge; target permission changes go into the audit.
- [ ] 🆕 **Scenario 7, delete project**: the impact preview **lists the table count / estimated row count per target**; "backed up" unticked or project name mismatch → the submit button is **disabled**; the approver can **replay the impact-preview snapshot**; after execution no residue remains on any target (acceptance per the [specification](./project-isolation-spec.md), section 3.9) and cross-jurisdiction deletions **leave separate traces**.
