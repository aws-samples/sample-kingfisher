# Multi-Region Execution Environments — Interaction Design (Soundness / Convenience / Safety)

> - Revision: **2.33** (🆕 2026-10-19 **wizard presentation of candidate-region pre-authorization (section 1.2, Step 1)**: each region is tagged "pre-authorized, usable right after the build" / "needs a one-time operations authorization after the build" + one `wizard-region-preauth` line; [design
>   document](./multi-region-execution-design.md), section 12.1, revision 3.24 / acceptance criteria revision 1.96) 2.32 (🔴🔴 2026-09-21 **the closure-condition table of section 4ter.a-1 was missing a row** — the fifth state `⊘ missing write channel` has **two halves**: the "🧱 code table" row needs
>   the narrow-privilege shared-writer (it has `INSERT … VALUES`), whereas the "🧱 dimension/fact" row issues **pure DDL** (`CREATE SCHEMA` / `CREATE TABLE` / `COMMENT`, not a single DML statement) ⇒ **no new identity is needed**; all that is missing is a new admin template. In the wireframe of
>   section 4ter.a both rows **were already marked ⊘**, yet the closure conditions of revision 2.31 covered only code tables ⇒ had we closed on that basis, the dimension/fact row would still show ⊘ on screen and the fifth state would not have disappeared. A third row + an acceptance criterion have
>   been added (contract: [specification](./multi-region-execution-spec.md), **revision 3.49, section 3.9d.6**; acceptance criteria **revision 1.89**))
>
> - Revision: **2.31** (🆕 2026-09-21 **🆕 section 4ter.a-1: closure conditions for the fifth state `⊘ missing write channel`** (the write-channel closure work; contract: [specification](./multi-region-execution-spec.md), **revision 3.48, section 3.9d**). Deliberately written as closure
>   **conditions** rather than "already closed": the contract only defines the carrier; when that cell on screen stops being ⊘ is decided by the acceptance criteria actually running against it, and **not a single cell may be turned green ahead of time**. Three load-bearing rules: ① after closure,
>   non-home goes through **the same four states** as home — **not a fifth state under different wording**; ② cross-jurisdiction and same-jurisdiction take **byte-for-byte the same path**, with only one extra regional audit record; 🔴 the refusal reason must not contain a single jurisdiction word
>   (otherwise we are back to the already-withdrawn "blocked by residency gate"); ③ 🔴 **the `error` text must be changed before closure** — it currently says "that channel is a leftover of the project-isolation construction batch and has never been delivered"; the moment the contract lands it
>   becomes **an outdated sentence**, and that is exactly what users read. Also recorded truthfully: after closure this cell **can no longer be produced** ⇒ the positive criterion disappears and the negative criterion is re-judged accordingly; no "can never be verified" criterion may be left
>   hanging as debt (same precedent as the wholesale withdrawal of the `⊘ blocked by residency gate` state))
>
> - Revision: **2.30** (🆕 2026-09-12 **section 9.7 "page-proposed execution-scope switch" settled (guardrail 7)** — up to revision 2.29 the scope could only be changed by the user in the top bar, whereas "opening an object that belongs to another scope" is a whole new class of requirement (the
>   Ask-Your-Data session card is the first consumer; the same family includes opening a run in another region from an alert / monitoring deep link, shared BI cards, and drilling down from the cross-region overview). 🔴 Silently switching the top bar and executing in place regardless of scope are
>   **both rejected** (the latter is the interaction-surface version of the whole "always hits the home region" class of defects); the ruling = **an explicit proposal + a two-way choice**, seven contract clauses, of which clause 7 pins "**being able to see ≠ being able to serve**" — when visible
>   but not serviceable, "switch region and continue" is **not offered**; only read-only + a plain-language reason + a direct entry to supplemental deployment / approval. ⚠️ The first draft wrote `residency-blocked` into clause 7 as if it were an existing state and was caught on the spot by the
>   contract-drift negative list — that state was removed in the "no legal gate" cut; it has been changed to the registry's **single author** `unusableReason()`, and "pages must not write their own serviceability judgment" was written into the contract as well) 2.29 (🆕 2026-09-12 **section 10:
>   interaction ruling for "Discontinued" components** (decided: "we will no longer deploy the classic version of MWAA either"): the wizard row **stays but is disabled** + a "Discontinued" tag (strictly distinct from "not implemented": the latter would be a lie — the stack group still exists and
>   existing installations still run); the tooltip must spell out "why / what happens to existing ones / what to tick instead"; the refusal reason and the tooltip are **the same text** (single author); 🔴 the **full set** submitted for an existing environment must be allowed to keep carrying it,
>   otherwise that environment cannot even add serverless; the wording must not say "deprecated / decommissioned" — decommissioning is a different thing (drain + approval + destroy)) 2.28 (🔴🔴 2026-09-10 **execution-scope guardrail rulings**: ① **guardrail 2 extended to "region list" controls** —
>   network dropdowns / model catalog / data-source dropdowns / Airflow entry / baseline tables must all **state which region the list belongs to** (an unlabeled dropdown is a trap under multi-region: selecting writes the id of another region, it only blows up on submit, and the error points at the
>   configuration itself); ② **two new forms of guardrail 1**: the approval inbox filtered by region must return a `hiddenByScope` count and say so on the page (**one item missed in the inbox = one thing that should be approved and nobody approves, with no trace on screen**); the single-region
>   total of the cost dashboard must say "which spend is not included" (otherwise users will compare it with the AWS bill total and suspect the platform miscalculates); ③ **"no filter by default" is a product decision** (verbatim: "I think a filter capability could be added, with no filtering by
>   default") ⇒ the per-region filter of the BI list is a switch that is **off by default**, and the gate pins that initial value; ④ **the buttons that create a data source / workflow / Flink job must restate the place** ("New data source (in us-west-2)"), and the post-creation message changes from
>   "created in the home region, not visible in the current scope" to the fact; ⑤ the previous revision's whole-card "all regions" disclaimer on `/ops` is withdrawn — once fixed it must not keep saying it is unfixed; instead rows are tagged `legacy` only when a baseline predating the gate stamp
>   really exists)
>
> - Revision: **2.27** (🔴🔴 2026-09-10 **decided: "both banner sentences are wrong, and not a single page platform-wide may be missed"** ⇒ 🆕 **section 9.6.0ter three-state self-attestation + ratchet** [partial wiring must be registered structurally as `partial`; `global-only` must give a **closed
>   reason code + which page to look at**; not-wired must give a **work-item reference + what is missing**; `NOT_WIRED_LIMIT` only decreases, baseline 22 → 16 at the close of batch A]; **15 rows of table A re-judged** [🔴 `/settings` as `global-only` was **an outright lie** (showing the home
>   region's workgroup / buckets / VPC to all regions as "platform configuration") · 7 pseudo-global pages truthfully moved to not-wired · `/` `/sync` `/workflow` `/observability` `/openmetadata` `/finops` wired in batch A · `/governance-workbench` moved from batch A to D because **signal keys
>   without a region dimension would cross-contaminate**]) 2.26 (🔴🔴 2026-09-10 **wording changed per two decisions**: table A row 10 (Ask-Your-Data) = **all regions go through the same AgentCore** (the place travels with the payload and is injected deterministically into the container; the page may
>   no longer say "in-process engine") · row 15 (governance) = **all regions go through the same OpenMetadata** ("which region" = the service dimension; the home region gets no suffix, zero migration; 🔴 the catalog is what it looked like **at sync time** ⇒ the sync status and a refresh entry must
>   be shown permanently; 🔴 table counts must not use the facet's `tables`)) 2.25 (✅🔴 2026-09-10 **per-region wiring of the query, Ask-Your-Data and governance pages landed**: table A rows 7 / 10 / 15 changed to ✅, each stating "what exactly is per-region on this page, and where it differs" — the
>   left tree of `/redshift` follows the editor's own selection via `?targetId=` (one tree can show only one region) and the execution target **follows by default** when the top bar switches region; `/genbi` 🔴🔴 decided to be switchable, **non-home regions automatically use the in-process engine**
>   and the page must say so permanently (the whole AgentCore set lives in the home region only; not saying so is deceiving); `/governance` 🔴 non-home **does not go through OpenMetadata** (the single central instance ingests only the home region; going through it anyway would list the home region's
>   tables and look perfectly normal)) 2.24 (🔴🔴 2026-09-09 **phase 1 of the execution-scope page wiring landed**: table A rows 3 / 17 / 20 / 22 changed to ✅ wired, each stating "how much of this page actually follows the switch" — the read side of `/datasources` is wired but **creating a source is
>   still home-only** (item O4 is assigned to the data-source work package) · `/modeling` **has only two region-partitioned tabs**, the other four are platform-level definitions · the binding field of `/backfill` is named `execTargets` · `/monitor` uses the list's own counts for guardrail 1. 🔴 One
>   general rule: **"wired" must also state "what does not follow the switch, and why"** — otherwise users can only guess, and the wrong guess is always "is it broken?") 2.23 (🔴 2026-09-09 **two decisions**: section 9.6.0 gains rule 5 "**the dropdown lists only fully installed execution
>   environments**" [the same two filters as "can it be bound"; a non-serviceable target hard-written in the URL ⇒ 409 `TARGET_NOT_READY` with no silent region change] + rule 6 "**refresh does not lose the selection**" [cold start restores from `bgp-scope:<pid>:<env>` and writes the parameter back
>   into the address bar; if the stored one is no longer valid ⇒ fall back to "All" and say so explicitly]; also `compare` changes from a union to the optional field `scopeCompare`. Contract: [specification](./multi-region-execution-spec.md), revision 3.36, sections 2.6.5a / 2.6.5b) 2.22 (🆕
>   2026-09-09 **execution scope (O1) · contract landed**: 🆕 **section 9.6 route capability matrix** — 🔴 the platform has **40 page routes** in total [31 menu leaves + **9** with a page but outside the menu tree] while the execution-scope work wires only 6 units ⇒ **two required fields on `Leaf`**,
>   `scope` + `scopeWired`; un-wired pages show a **permanent notice bar** "This page is not yet filtered by execution scope; all regions are shown" [silence is worse than "losing things" = handing out other regions' things without saying so] / **single-target equivalence rule** [when exactly 1
>   target is visible, a `target-only` page does not pop "please select"; this is not a fallback to home] / for the direct warehouse query page, where counts are not supported, guardrail 1 becomes "only offer the entry to switch to All" / the 9 non-menu pages of table B need their own explicit
>   registration / 🔴 **section 9.6.3 truthfully records the dependency on the per-region data-plane wiring** [decided to skip that wiring and open the execution-scope work directly: etl-jobs · monitor · modeling **do not depend** on it and can be done fully; the data plane of the two governance
>   pages depends on it ⇒ this package only builds the shell and empty states; finops goes to the cost work package]. Contract: [specification](./multi-region-execution-spec.md), revision 3.34, section 2.6) 2.21 (🆕 2026-09-08 **zero-egress execution environments**: wizard Step 1 of section 1.1
>   **drops the "network size" radio and the EIP pre-check Alert** [no more NAT / EIP], replaced by a one-line read-only zero-egress note; the network row of the detail page becomes "Zero egress ✓ · interface endpoints n/n ✓ · cross-region private link → home ✓"; probing gains `network:egress-none`
>   · `network:home-link`, and both **must retry with back-off** [endpoint available ≠ usable; DNS propagation takes 2–3 minutes]. Contract: [specification](./multi-region-execution-spec.md), revision 3.33, section 3.16) 2.20 (🔴 2026-09-07, a real-environment finding: run-history rows show only
>   "Serverless"; the trigger source moves to the run-log dialog and is shown from the service-side truth) 2.19 (🔴 2026-09-06 **MWAA Serverless scheduling entry**: wizard Step 2 of section 1.1 gains the 🆕 row `airflow-serverless` "Scheduling / orchestration (Serverless Airflow; billed per
>   task-second, provisioned in minutes)" + Step 1 gains a 🆕 "network size" choice standard / lean (a quota pre-check item) with a quota pre-check Alert; the warning card of section 2.2a is generalized to "no scheduler component installed" + the button "Add a scheduler in Execution Environments →"
>   (serverless highlighted by default); 🆕 section 2.2b scheduler-kind visibility [job list / run history / EMR panel tags "Serverless" "MWAA"; "Scheduler preference" on the detail page when both are installed; task logs read from CloudWatch]) 2.18 (🔴 2026-09-06 **in-region scheduling**: 🆕 section
>   2.2a MWAA precondition notice for scheduling configuration + one-click path to supplemental deployment [a non-home target without `mwaa` ⇒ a warning card in the scheduling area lists every missing region + the button "Add MWAA in Execution Environments" ⇒ the detail drawer opens automatically
>   with the mwaa row highlighted]; in wizard Step 2 of section 1.1 `mwaa` becomes selectable, wording changed to "Scheduling / orchestration (this region's Airflow; required to schedule in a non-home region)"; detail-page deep link `/exec-envs?target=<id>&highlight=<component>`) 2.17 (🔴 2026-09-05
>   **contract first, no legal gate ([design document](./multi-region-execution-design.md), section 18, decision 6quinquies)**: section 4bis **rewritten in full** as "disclaimer + consent retention + neutral label + audit id" [section 4bis.1 banner becomes a neutral 🌍 tag + "Consented v1 ✓";
>   section 4bis.3 "no transparent merge" becomes "merge available, queries audited"; section 4bis.4 informed confirmation → **disclaimer dialog** (text verbatim = `disclaimer.ts`; retained server-side after consent and not shown again; cancel = do not execute)] · section 4septies.6 "merge disabled
>   across jurisdictions" → available · sections 2bis.4 / 3.1b / 4ter / 4ter.a drop `⊘ blocked by residency gate` ⇒ **four states** · the last wizard step of section 1.2 gains the disclaimer (registration only after admin consent) · 🆕 section 1.7 "Authorized projects" card + "Consents" list ·
>   section 5 gains two rows (set authorized projects / register a cross-jurisdiction environment) · wording of section 7.1 row IX-6 synchronized) 2.16 (🔴 2026-09-05 **modeling unbind / cleanup work**: section 4ter gains the final interaction for "unbind / unbind and clean up / controlled
>   definition deletion" [mechanism A: type the table name; the residue cell is drawn as before and disappears after cleanup]; the same day it was decided "no legal gate, only auditability + disclaimer consent retention", and the rewrite of section 4bis lands with construction step 1 of the
>   no-legal-gate work) 2.15 (✅ 2026-09-05 **new section 9: top-bar "Execution scope" ruling** — decided "every page of a single region can be switched" + the conclusion of benchmarking against the AWS console and several leading cloud data platforms: a pure AWS-style region switch is the passing
>   grade; the ruling = three states switch + All + compare, the selected value is always a targetId, every route declares its capability, the URL is authoritative, an invalid value does not fall back to home, plus **six guardrails** [never let users lose things / buttons restate the target /
>   instances point back to the definition / no reload / one definition one row / compare only for cost and the matrix]; linked execution = a persistent RunGroup whose **default scope follows the current view**. The data gate had already landed first in the third construction wave [specification,
>   section 1.3a, item S6]; the interaction layer O1–O4 is done right in one pass after the compliance gate [route A]) 2.14 (🔴 2026-09-04 **new section 4quater.1: implementation rules for the cross-region one-screen overview** — seven rules fixed while building it, each closing a gap of "looks like
>   it satisfies the wireframe but actually lies": ① the two views are **mutually exclusive, not side by side** [the current-target tabs are all single-region read/write surfaces] · 🔴 ② the **lineage edges / quality score / sensitivity hits in the wireframe cannot be collected this phase** (the
>   central store has no target dimension for any of them) ⇒ write "not collected" + the reason truthfully, **never fill in 0 and never give a total** [a made-up 0 looks like "this region is very clean"] · ③ `stale` becomes **five states** ["never synced" ≠ "synced but old"; `last sync failed` must
>   also be surfaced] · ④ **read for viewers / write for administrators**; for non-administrators **disable + explain the reason**, do not hide · ⑤ the warehouse catalog gets **its own row with its own timestamp**, merged neither into ✓/⚠ nor into the asset total [otherwise a manual collection from
>   3 days ago poses as real time] · ⑥ truncation must be visible · ⚠️ ⑦ **the "read-only · from \<target\>" group has nothing to hang this phase** [cross-region replication is skeleton-only, not implemented, per the specification, section 6.4] ⇒ do not draw an empty group pretending to have the
>   capability; and **truthfully record the difference in drill-down semantics** [this phase = expand the list of mirrored entries; "click a table to see data" waits for the governance page to become target-aware]) 2.13 (🔴 2026-09-04 **section 4ter gains one load-bearing rule**: [Re-check]
>   **updates only observed facts and never the definition fingerprint** — a real bug in the landing side, bitten while writing the read side: observation sees only the column structure, not the data, and the most common change to a code table is adding one enum value (same column structure, one
>   row fewer in the table) ⇒ overwriting the fingerprint would let "click Re-check" turn ⚠ version mismatch into ✓ landed = a false green. Ruling: the fingerprint carries over from the previous record, left empty when there is no history (the read side judges version mismatch); **only a real
>   landing is entitled to write the current fingerprint**. **Second real bug of the same batch**: editing a code table / dimension table **goes through a full Put ⇒ wipes `targets` / `landedByTarget` wholesale** — changing a display name degrades every cell to ⚠ not landed (while the tables are
>   still in the warehouse) and not even "residue" is visible; ruling = the per-target truth columns become one list `PER_TARGET_TRUTH_KEYS`, and both edit paths carry them through `perTargetTruth()`) 2.12 (🔴 2026-09-04 **new section 3.1b: modeling-artifact row groups interleaved into the
>   version-consistency matrix** — ruling from the read-side construction: task rows (dispatch ledger) and modeling-artifact rows (landing observation state) share **the same matrix and the same columns**; four gaps pinned one by one [③ observed state → cell state is an **exhaustive mapping** (`??
>   ok` would let a new state silently turn green) · ④ `drift` counts toward the verdict while the two ⊘ states **firmly do not** (otherwise a red dot that can never be resolved), and it is **compared state by state** with the modeling side's `LANDED_ATTENTION` · ⑤ one-click remediation becomes a
>   **pure-function dispatch table** (the hard-coded line before interleaving would send a DAG with a codeTableId) · ⑥ `drift` **gets no one-click** (alignment is only DROP and recreate = lossy)]; also newly defined: **"residue"** — unbind ≠ drop table and the platform **has no cleanup channel** ⇒
>   a cell with a record but no binding is shown as is + tagged "residue", excluded from the verdict but **never hidden**; and the rule "tasks = this project / modeling = platform-global" is recorded) 2.11 (🔴 2026-09-04 **new section 4ter.a: the fifth state of modeling landing, `⊘ missing write
>   channel`** — discovered while building the landing side: non-home modeling landing **cannot even reach the four states**: it is admin-level DDL, while `project-context` requires a projectId (modeling is global with no project, and forcing one does not work either: the per-project identity has
>   no privilege on `public`), the `admin-ddl` branch throws outright (ruling: go through the closed executor of the specification, section 3.9a), and the contract's `land-code-table` template **deliberately writes no data** (data loading goes through the "narrow-privilege shared-writer"), yet that
>   channel is **a leftover of the project-isolation construction batch, never delivered** ⇒ ruling: judge the **deterministic state** `credential-gap`, execute not a single statement, write the reason into the record; it does not count as needing action but **the reason must be displayed**;
>   cross-jurisdiction takes precedence. Also spelled out: **why not to work around it by force** and **the deliverables needed to close the gap**) 2.10 (🔴 2026-09-04 **new section 3.1a: which rows enter the version-consistency matrix** — two gaps that would make the dashboard **falsely red**,
>   caught while building the matrix (① resource types whose dispatch path is not yet wired to the ledger entering the matrix ⇒ every cell judged "not dispatched"; ② unpublished drafts entering the matrix); ruling: exclude them + **truthfully record the coverage**; also settled: "columns = **active
>   ∪ ever seen**" (taking only active would make the whole column of "dispatched to a region that was later removed" disappear = hiding a problem), "a registry read failure **throws** rather than falling back" (an empty matrix on screen equals "all is well"), "`currentVersion` comes from the
>   version-snapshot table, not a second copy". **A false alarm is as fatal as a false green** is the thread of that section) 2.9 (🔴 2026-09-04 **new section 4septies, scenario nine: direct warehouse query "multi-region parallel + multi-sheet results"** — the interaction decided on 2026-09-04
>   [switch between sheets to see each region's data] + added constraints [regions are fast and slow unevenly, **never wait for all regions before showing anything**; a region that errors shows its error in its own sheet]. Design points: each sheet has an **independent lifecycle** [submit and
>   fetch-results are separated, whichever returns first can be viewed first, the tab badge carries the elapsed time] · **focus is grabbed only once** · errors in three parts [the original text + a classification of where to fix it + **that region's place**, given only in identity form, never as an
>   ARN] · a timeout **cancels only that region** and timeout ≠ failure · the "⚖ Compare" sheet fills progressively and **column-signature mismatch is judged only after all are terminal** [judging midway is guaranteed to misreport] · 🔴 **results are never merged automatically**; merging is explicit
>   and **disabled across jurisdictions** · reuses `bgp-query-handles` so you can navigate away and resume viewing. ⚠️ **Recorded truthfully: section 4 previously covered only "Ask-Your-Data region switching"; multi-sheet direct query had never been designed**; and section 4septies.0 states that
>   the difference "Ask-Your-Data not parallel / direct query parallel" is **intentional**) 2.8 (🔴 2026-09-01, execution-environment stack-group construction batch: wizard Step 2 **opens the redshift / dms / flink checkboxes** (core always ticked; unimplemented ones disabled and tagged "not
>   implemented"); the cost wording is made truthful; on the detail page every component that is implemented but not installed enables "+ Supplemental deployment" (full-set semantics)) 2.7 (🔴 2026-09-01, construction batch: the detail page gains "Trigger deployment / Redeploy" buttons [before this,
>   an environment whose register succeeded but whose trigger failed had no way forward on the page, while the wizard's error text promised "you can retry on the detail page"]; the status set has the same semantics as the broker's DEPLOYABLE_STATUS; home and the states of the deletion flow get no
>   button) 2.6 (🔴 2026-09-01, construction batch: wizard Step 1 **drops the account input** (decided: strictly the same account as the control plane; accountId is taken server-side); the list's empty state / missing home offers an "Initialize home environment" button (the UI carrier of the seed
>   entry)) 2.5 (🔴 2026-09-01, construction slice d: the `/exec-envs` management page landed (list / wizard / detail); menu group corrected `g-platform` → **`g-system`** (the real name in routes.tsx); the data behind the card's "bound tasks / monthly cost" belongs to a later construction batch, so
>   the page truthfully does not show them) 2.4 (🔴 2026-09-01, construction slice c: 7 occurrences of "admin/manager" narrowed to **admin (bgp-admin)** — the gateway middleware admits only bgp-admin; implementing the old text = a dead button that is always 403 for managers; manager participation is
>   recorded as a pending security decision) 2.3 (🔴 2026-08-31, construction batch: the two resource-name previews corrected to the new derivation key, `bgp-datalake-<acct>-tgt-usw2-a`) 2.2 (🔴 2026-08-29, convergence-check back-fill: the key of the section 1.6 "AI model for this region" card
>   **`ai-model#<region>#global` → `ai-model#<targetId>#global`**, `resolveModelIdRuntime(capability, region)` → **`(capability, targetId)`**, aligned with the specification, section 1.3a item S2 / section 6, and with the dimension ruling D8 of the [model-configuration
>   design](./model-configuration.md); the UI wording keeps "this region") 2.1 (🔴 2026-08-28, aligned with **the design document revision 3.1 / the specification revision 3.1** [design document section 20.4 freezes the contract: the interaction may not define its own scope]: ① **target-level RBAC
>   moved from "phase two" to phase one** (section 6.2, gap ④); ② **the position of the masking layer corrected** — authoritative masking = the regional data plane, server-side; presentation-layer masking is defense-in-depth only (section 4bis.2); ③ **the region-switch scope does not treat
>   localStorage as authoritative** — `targetId` is carried by the URL / resource identity + cross-validated server-side (section 6.1); ④ terminology region → **target** (`targetId` is the immutable identity; region is one of its attributes). ⑤ ✅ **New interactions added (revision 2.1, 4 scenarios)
>   **: section 4ter per-target modeling push-down and drift presentation, section 4quater cross-region one-screen read-only metadata overview, section 4quinquies draining / three-part approval validation / fencing / failed state, section 4sexies per-target alert configuration (default "evaluate
>   per region" so a regional failure is not averaged away). 1.7: 🔴 a review remediation: section 4bis cleans up leftover old wording "residency mode / results all stay in the region" [subheading changed to cross-jurisdiction mode; "results echoed back to you" vs. "nearby in the region" distinguish
>   track 1 and track 2] + section 4bis.3 adds, from the review, that informed consent / responsibility binds to the "data jurisdiction", not the "UI region mode" [dashboards fetch data automatically with no click; responsibility cannot be pinned on an uninformed user]. 1.6, decision B: section
>   4bis changes from "residency danger zone / refused" to two tracks — section 4bis.1 informed banner [query results come back to you = leave the region = your responsibility + audited; not forbidden], section 4bis.4 changes from "friendly refusal" to "informed confirmation" [the interaction does
>   not block; the hard gate applies only to hard residency / track 2], sections 4bis.5 / 6.2 ⑤ / 7.1 IX-6 corrected to the two-track model; 1.5, a review remediation: section 2.1 one-click select-all gains data heterogeneity; 1.4, a review remediation: section 1.6 "AI model for this region" card +
>   section 2.1; 1.3: + section 4bis) (4 scenarios + section 2bis regional heterogeneity + 4 safety mechanisms + friendliness / convenience + ASCII wireframes) | Date: 2026-08-27 (revision 1.6: 2026-08-28) | Status: ⬜ In design, pending review
>
> - Upstream: the [design document](./multi-region-execution-design.md) (back-end / infrastructure design; section 11 is the interaction skeleton) and the research notes (evidence base).
>
> - 🏛️ **Follows the platform-wide interaction principles** (the 4 scenarios × 4 safety mechanisms × friendliness F1–F7 of this chapter have been distilled into groups A–D of those principles; on conflict the principles prevail).
>
> - 🔴 Red line: this document is design only; no code is written without an explicit instruction.

---

## 0. Why this chapter stands on its own (the direction given)

Stated explicitly on 2026-08-26: **"The design also has to consider the soundness and convenience of the interaction … how multi-region should be interacted with sensibly needs a great deal of time. Interaction convenience and safety must all be considered, otherwise building this feature is meaningless."**

The [design document](./multi-region-execution-design.md) is currently almost entirely a **back-end / infrastructure view** (registry, client factory, runtime-lib split, IAM); the interaction is only a skeleton in its section 11. For a **global-grade, N-region** system, if the interaction is unsound, operators will not dare to use it, or a single slip causes a cross-region incident — and however clean the back end is, it loses its meaning. Hence this dedicated chapter, taking the **soundness, convenience and safety** of the interaction to reviewable depth.

## 0.1 Design goals (the 4 scenarios × 4 safety mechanisms, all selected)

**The 4 interaction scenarios to deepen first (all four selected):**
1. Full lifecycle of an execution environment (creation wizard / initialization progress / probing / canary / deletion approval)
2. Multi-region binding and push-down of tasks (one definition, many bindings / per-region dispatch / region-specialized copies) + **section 2bis regional heterogeneity (key focus: tasks and data are not homogeneous)**
3. Unified multi-region monitoring dashboard (version-consistency matrix / re-dispatch after failure / cross-region cost and run comparison)
4. Region switching in Ask-Your-Data (region selector / session anchoring / switch-region notice)

**The 4 classes of safety interaction mechanisms that must be implemented (all four selected):**
- A. Second confirmation for high-risk operations (delete an environment / revoke a GRANT / cross-region bulk dispatch → type the environment name or confirm explicitly)
- B. Impact preview before an operation (show "which regions / which resources / estimated cost will be affected" before executing)
- C. Tiered permissions + approval trail (who may create / delete / push down is tiered by role; high-risk actions go through bgp-approvals; everything is written to the audit log)
- D. Visual isolation of danger zones (production regions in a conspicuous color / corner badge; cross-region operations clearly highlight the region currently in effect, to prevent acting on the wrong region)

## 0.2 Design principles that run through the chapter

1. **Anchor to existing UI conventions; invent no new paradigm** (antd Steps wizard / Modal.confirm danger confirmation / bgp-approvals approval drawer / monitor filters / Badge status) — to be back-filled by the "survey of existing interaction conventions", see section 6.
2. **The region is a first-class citizen and always visible**: for any execute / dispatch / query operation, the region currently in effect must be clearly displayed within view, eliminating "thought it was A, actually hit B".
3. **Safe by default**: the region multi-select ticks only home by default; high-risk operations default to the most conservative option; destructive actions default to RETAIN on the data side.
4. **Convenience does not sacrifice safety**: bulk / one-click convenience operations must come with an impact preview (mechanism B) and a second confirmation (mechanism A).
5. **Friendly = no thinking required** (a newly emphasized requirement: "sound, friendly, convenient"): every page carries its own "what is this / how to use it" guidance (reusing `FeatureGuide`); empty states offer a next-step exit (reusing `<Empty description>`); defaults are filled with the most common values; error-prone spots get `Tooltip` help nearby; any failed operation is recoverable and leaves no half-dead state. See section 8.

---

## 1. Scenario one: full-lifecycle interaction of an execution environment

Where it lives: a new "Execution Environments" management page (🔴 revision 2.5 correction: the menu group's real name is **`g-system` [System]**; `routes.tsx` never had a `g-platform` — the original text wrote the group name from memory; ✅ **construction slice d landed** `/exec-envs`, three views list + wizard + detail, placed after the "Workspace" entry). Corresponds to the back-end lifecycle state machine `registered→initializing→testing→active→decommissioning→deleted` in the [design document](./multi-region-execution-design.md), section 4.

### 1.1 List page (overview + global view of regions)

- **Card list** (not a plain table): one card per execution environment showing region, displayName, a status badge (one color per state of the 6-state machine: `active` = green / `initializing` = blue spinning / `decommissioning` = orange / `deleted` = gray), component tags (core/mwaa/dms/flink/agentcore), number of bound tasks, monthly cost, and last probe time.
- **The home environment card** carries a 🏠 corner badge + a "home region" label, visually distinct from the other regions (mechanism D, the positive use of visual isolation of danger / critical zones — anyone can tell at a glance which one is the undeletable home).
- The "+ New execution environment" button at the top right: visible to admins only (mechanism C, tiered permissions — 🔴 narrowed to bgp-admin in revision 2.4, see mechanism C in section 1.4; both front-end visibility and the back-end API).

**Wireframe (list page):**
```
┌─ Execution Environments ─────────────────────────────────────────────[+ New execution environment]─┐
│ 💡 How it works: manage execution environments across multiple regions… (FeatureGuide, collapsible)   │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────┐ ┌──────────────────────────┐ ┌──────────────────────────┐              │
│ │ 🏠 us-east-1      [Home] │ │ us-west-2        ●active │ │ eu-west-1  ●initializing │              │
│ │ ●active (green)          │ │ (green)                  │ │ (blue · spinning)        │              │
│ │ core mwaa dms flink      │ │ core mwaa                │ │ core                     │              │
│ │ bound tasks 42 · $410/mo │ │ bound tasks 8 · $402/mo  │ │ bound 0 · —              │              │
│ │ probed 2 min ago ✓       │ │ probed 5 min ago ✓       │ │ [Check initialization]   │              │
│ │                [Details] │ │        [Details][Delete] │ │                [Details] │              │
│ └──────────────────────────┘ └──────────────────────────┘ └──────────────────────────┘              │
│  ↑ 🏠 badge = home region, cannot be deleted   ↑ production region gets a conspicuous border (mechanism D) │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
> Friendliness points (section 8): FeatureGuide at the top (F1); the 🏠 badge on the home card is recognizable at a glance (F4 / mechanism D); each card shows cost / probe / binding count directly, no need to open it (F7, fewer round trips). For the empty state (home only) see section 8.1, F2.

### 1.2 Creation wizard (🔴 one-click fully automatic deployment by the platform; humans only choose region + components)

> Direction set on 2026-08-27: the platform is responsible for deploying environments (deployment privilege isolated through CodeBuild, [design document](./multi-region-execution-design.md), sections 4.1 / 12.0); humans only choose **which region and which services to deploy**. The former "generate commands for operations to type by hand" is abandoned. Interaction goal = **the administrator completes the deployment with a few clicks and sees the progress the whole way**. Three antd Steps (there is no longer a "wait for the operations receipt" step):

- **Step 1: choose region + naming preview**: a region dropdown (excluding regions already registered); a live **preview of the resource names that will be generated** (per the naming SSOT `naming.json`; 🔴 **revision 2.3 correction**: the derivation key is `targetSlug`, not region ⇒ the preview looks like `bgp-datalake-<acct>-tgt-usw2-a`; see the design document, section 3.2), so the administrator sees the products of the naming rules in advance (answering the "naming-rule constraints" requirement). 🔴 **Revision 2.33 (candidate-region pre-authorization, released 2026-10-27; [design document](./multi-region-execution-design.md), section 12.1, revision 3.24)**: each selectable region is suffixed "pre-authorized, usable right after the build" (the control-plane IAM already includes that region — a candidate region pre-authorized at install / upgrade time, or a region already in use) or "needs a one-time operations authorization after the build"; one read-only line `wizard-region-preauth` below the dropdown reads "N of them are pre-authorized by the control plane (usable right after the build); the others need ops to run the authorization command once after the build completes, then 'Check initialization'". Regions that are taken or blocked by an SCP remain disabled with the reason stated. Source = the new field `controlPlaneEnabled` of the candidate-region route (a read-only view; the wizard performs no authorization). Say it at the moment the region is chosen, rather than letting the user wait 25 minutes for the build to finish only to run into it at "Check initialization".
- **Step 2: choose components (tick services)**: **core is mandatory** (checkbox disabled, annotated "Compute + storage + network + data lake (required)"); `redshift` (warehouse) / `kafka` (MSK) / `mwaa` / `dms` / `flink` / `agentcore` are optional, each with a `Tooltip` explanation + **the estimated fixed cost stated explicitly** (e.g. mwaa ≈ $350/month + NAT ≈ $65/month); a note at the bottom says "all of these can be deployed later as supplements (design document, section 4.6); installing only the minimal core first is fine" — relieving the pressure of "I must choose everything now" (friendliness F4).
- **Step 3: confirm + one-click deploy**: shows a summary (region / components / estimated total monthly cost) + a "Start deployment" button. Click → write `registered` to the registry → the platform calls `StartBuild` → `initializing`; **the wizard turns in place into a live progress view** (see the wireframe below); nobody has to leave and type commands elsewhere.
- A failed deployment can be **retried in place** (idempotent); on success, probing runs automatically and the state moves to `testing`.
- 🔴 **Revision 2.17 (no-legal-gate work): when the jurisdiction ≠ home, Step 3 adds the disclaimer** (text = `disclaimer.ts` verbatim, see section 4bis.4) + a checkbox "I have read and agree"; **unchecked ⇒ [Start deployment] disabled**; checked ⇒ the registration request carries `residencyAck`, and the server verifies the version / text hash before writing it into the descriptor. The jurisdiction input is validated against `^[a-z][a-z0-9-]{1,31}$` (`EU` / `Home` are rejected), with the note "a non-home jurisdiction must install residency-api (regional audit / result storage)" — this is a technical prerequisite, not an approval.

**Wireframe (creation wizard Step 3 → one-click deploy → live progress):**
```
┌─ New execution environment ───────────────────────────────────────────────────────────────────────┐
│   ① Choose region + naming  ─────  ② Choose services  ─────  ● ③ Confirm and deploy                 │
├────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  region: us-west-2     services: core, redshift, mwaa                                               │
│  Resource name preview (naming SSOT):  bgp-datalake-<acct>-tgt-usw2-a / table bucket / …          │
│  Estimated total fixed cost ≈ $415/month  ⓘ    (redshift/mwaa can be added later, design doc. 4.6)  │
│                                                                   [Previous]   [🚀 Start deployment] │
├─ After the click, progress is shown in place (the platform deploys via CodeBuild; no commands typed) ─┤
│  ● bootstrap ……………… ✓      ● VPC / network ……………… ✓                                                 │
│  ● S3 data lake / table bucket …… ✓      ● Glue / Athena / EMR … ✓ (core complete)                   │
│  ● Redshift warehouse ……… ⟳ creating…   ● MWAA ………………… ⏳ queued                                      │
│  ──────────────────────────────────────────────────────────────────────  [View build log]            │
│  Progress comes from polling the CodeBuild phase + build log; on failure → mark that stack red + [Retry] │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
> The key to convenience: the administrator **clicks "Start deployment" and then just watches the progress bar**; the platform finishes fully automatically — this is what a platform that "saves manual operations" should look like. Friendliness points: naming / cost visible before clicking (F3 / F4); per-stack progress is perceptible (F5, not a spinner and a blind wait); failure can be retried in place without starting over (F6); "can be added later" relieves the pressure of choosing (design document, section 4.6). Safety: deployment privilege is isolated in CodeBuild (design document, section 12.0); the platform only calls StartBuild.

### 1.3 Initialization / probing / canary (progress visualization)

- The "Initialize" area of the detail page: **probes resource by resource** according to the descriptor; **the probe items are driven by the env's installed `components` set — uninstalled components are neither probed nor judged** (e.g. a core-only region does not probe Redshift GetWorkgroup, otherwise it would never be "all green" and would be stuck in testing forever). core always probes HeadBucket / S3Tables / Glue / Athena; GetWorkgroup is probed only when redshift is installed, GetEnvironment only when mwaa is installed … one row per resource + a Badge (untested / green ✓ / red ✗ + reason), corresponding to the design document, section 4.1. "Enable" lights up only when all are green.
- The "Test run" area (status = testing): two levels — a **probe suite** (seconds; includes a Bedrock converse call to probe model availability in that region, reusing the D5 probe of the [model-configuration design](./model-configuration.md)) + a **canary task** (minutes, optional, **conditional on components**: by default takes the data-lake path, create temporary data → Glue sync into that region's **S3 Tables** → **verify by querying with Athena** → clean up, which runs in any region; **the Redshift branch is appended only when the redshift component is installed**); results land in the probe field and each step is shown on the page.
- All green → the "Enable" button (admin; mechanism C, narrowed in revision 2.4) → `active`, and the environment starts accepting push-downs.

### 1.4 Deleting an environment (🔴 the most dangerous operation in this module — all four safety gates engaged)

Deletion destroys all execution resources of a region; an accidental deletion = a production incident. Four gates (mechanisms A + B + C + D all used):

1. **Mechanism C, tiered permissions**: 🔴 **narrowed in revision 2.4: only admins (`bgp-admin`) may initiate** — the gateway `middleware.ts:104` **admits only bgp-admin** to `/api/admin/**` (the heading of the specification's section 2.1 is this very ruling); this document previously wrote "admin/manager" in several places, which collided with it: a manager's request would be rejected by the gateway with 403 first, so **implementing the old text = building a button that a manager can never click**. Manager participation requires changing the gateway's admission policy first = **an independent security decision, recorded as pending** (not loosened quietly). For the `home` environment the UI hides the delete entry + the back end hard-rejects (design document, section 4.4).
2. **Mechanism B, impact preview (pre-check)**: clicking delete first pops the **impact list** — the number of resource definitions bound to this env / enabled schedules / running runs; **if any is > 0, deletion is forbidden** and the details are listed ("please migrate / unbind N tasks first"). Operators see the blast radius before acting.
3. **Mechanism A, second confirmation**: once the check passes, a second confirmation dialog **requires typing the environment's region name** (e.g. `us-west-2`) before the "Confirm delete" button activates (guards against a slipped click).
4. **Mechanism C, approval trail**: after confirmation **nothing is destroyed immediately**; instead a `bgp-approvals` item is created (type = `exec-env-delete`, approver = platform admin, design document, section 4.4) → pending approval. 🔴 **The approval receiving end (a review addition, against blind approval)**: in the inbox the approver must be able to **replay this impact-preview snapshot** (which region is destroyed, the data-bucket RETAIN notice, the list of bound resources, the initiator), otherwise the "human approval gate" degenerates into a rubber stamp — the general rules for the approval receiving end are in the [project-isolation design](./project-isolation.md), interaction section 5bis (one source platform-wide: the dangerous approval items exec-env-delete / project-delete / region-deploy all replay the initiator's blast radius).
5. **Approved → destroy**: the platform calls `StartBuild` to trigger destruction (CodeBuild runs `cdk destroy` under the same isolated role as deployment) → progress visible → probe that the resources no longer exist → `deleted` (the item stays as a tombstone for audit). 🔴 **Data protection (a top-priority item that must be fixed in code before construction starts)**: the exec-env data buckets **must be explicitly `RemovalPolicy.RETAIN` + drop `autoDeleteObjects`** (the current platform-stack.ts:51-53 is `DESTROY+autoDelete` = a real defect that would delete customer data); S3 Tables table buckets are free-floating orphans created at runtime (not managed by CDK) and need separate retention handling (design document, section 4.4). The page states in red "data buckets have been retained and must be cleaned up separately after manual confirmation"; destruction deletes only recreatable resources.

**Wireframe (deleting an environment; mechanism B → A, two dialogs in sequence):**
```
Gate one · impact preview (mechanism B)            Gate two · typed-name strong confirmation (mechanism A; only shown if the preview passes)
┌─ Delete execution environment us-west-2 ───────┐   ┌─ ⚠ Confirm deletion of us-west-2 ─────────────────────────────┐
│ Pre-deletion checks (all must be 0):           │   │ This operation destroys all execution resources of the region. │
│   Bound resource definitions …… 3  ✗           │   │ Data buckets will be [RETAINED] (RETAIN); they must be cleaned │
│   Enabled schedules ……………… 1  ✗                │   │ up separately by hand and are not deleted by this operation.   │
│   Running runs ………………………… 0  ✓                 │   │                                                                │
│ ─────────────────────────────────────────────  │   │ Type the region name to confirm:                               │
│ ✗ Bindings exist; cannot delete. Details:      │   │  ┌──────────────────────────────────────────────────────────┐  │
│   · sync "Order sync"                          │   │  │ us-west-2                                                │  │
│   · workflow "Daily report" + 1 schedule       │   │  └──────────────────────────────────────────────────────────┘  │
│   [Go unbind these tasks]  (F7 direct link)    │   │  After submitting, it goes to approval (platform admin)        │
│                                      [Close]   │   │                       [Cancel]  [Confirm delete (disabled)]   │
└────────────────────────────────────────────────┘   └────────────────────────────────────────────────────────────────┘
  ↑ any value > 0 blocks right here and offers an exit   ↑ "Confirm delete" stays grayed out until the name matches (guards against a slipped click)
```
> Everything goes into bgp-audit (who initiated, the impact-list snapshot, the approver, the destruction time). This is the prudence a global-grade system owes to "deleting a region". Friendly and safe at the same time: the first gate lays the blast radius out in the open and offers the "Go unbind" exit (F7) instead of erroring only after your last click; the second gate's typed name is a stronger tier that the existing conventions lack, added specifically for deleting a region (section 6.2).

### 1.5 Supplemental deployment of components (🔴 explicitly requested: add a warehouse / Kafka etc. at any time after core is built, without rebuilding)

Corresponds to the design document, section 4.6. Location = the "Components" area of the execution environment detail page; installed components show ✓, uninstalled ones show "+ Supplemental deployment" (admin only; mechanism C, narrowed in revision 2.4). This is the heart of the "start small, grow on demand" convenience — stand up the minimal core first, add the warehouse / streaming when the business needs them, and the platform deploys incrementally and automatically without touching existing data.

**Wireframe (detail page · components area + supplemental deployment):**
```
┌─ Execution environment us-west-2 · Components ────────────────────────────────────────────────────┐
│  ✓ core        Compute + storage + network + data lake (required)                                 │
│  ✓ mwaa        Scheduling                                                                         │
│  ✗ redshift    Data warehouse                 [+ Supplemental deployment]                         │
│  ✗ kafka (MSK) Streaming message source       [+ Supplemental deployment]                         │
│  ✗ flink       Stream processing   ⓘ add redshift first (if the sink is the warehouse)            │
│  ✗ agentcore   This region's Ask-Your-Data trio   [+ Supplemental deployment]                     │
├───────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Click "+ Supplemental deployment redshift" → impact preview (mechanism B):                         │
│   Will create: Redshift Serverless namespace / workgroup + admin secret                            │
│   Cost delta: by usage (RPU)  ·  does not affect the installed core / mwaa or running tasks        │
│                                                     [Cancel]   [Confirm supplemental deployment]   │
│ After confirmation: the platform calls StartBuild (passing the full component set; CDK is idempotent and only adds the redshift stack) │
│         → same live progress as section 1.2 → on success the row turns ✓                           │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```
> Friendly and convenient: uninstalled components are visible at a glance + one-click add (F5 / F7); components with dependencies get a precondition hint (F4, e.g. flink needs redshift); the impact preview states the scope of change explicitly (F6). **Approval rule (consistent with the design document, section 12.6)**: supplemental deployment **does not go through approval when it purely adds new component stacks** (only CREATEs new stacks and does not touch installed components); but if the changeset **touches a stateful core stack (Redshift / MWAA)**, a **changeset approval gate** pops up, forbidding unattended replace (downtime / data risk) — that is, "add only, never modify" holds only while the source template is unchanged, hence add-components is anchored to the commit of creation time (design document, sections 12.6 / 4.6). Removing components is not done in phase one (see the design document, section 4.6).

### 1.6 The "AI model for this region" card (per-region model override; resolves a dangling reference from the model-configuration interaction design, section 1bis)

Corresponds to D8 of the [model-configuration design](./model-configuration.md) and its construction batch (the `ai-model#<targetId>#global` key). That design explicitly hangs the configuration UI of per-region model overrides on **this page (the execution environment detail page)**; this interaction design previously had no such card = a dangling reference, which this section fills in. Location = an "AI model for this region" card below the "Components" area of the execution environment detail page (editable by admins only [mechanism C, narrowed in revision 2.4]; read-only for non-admins).

- **Display**: the model currently in effect for this region + its source layer (per-region override `ai-model#<targetId>#global` / fallback to the global default); when no override is set it shows "inherits the global default: `global.anthropic.claude-opus-4-8`".
- **Switching**: choose a model within the two families (Claude Opus / GPT-5.6, the same catalog as `/settings` in the model-configuration design) → **"Test this model" probe (reusing scenario one / the D5 probe of the model-configuration design, with a real invoke in this region)** → saving is allowed only after it passes → **a medium-tier `Modal.confirm danger` confirmation** (switching this region's model affects all AI capabilities of this region; same tier as scenario one of the model-configuration design).
- 🔴 **Residency notice (cross-jurisdiction regions; synchronized with the design document, section 8.5.4, and D9 of the model-configuration design)**: if this env has `jurisdiction≠home`, the card carries an F4 info note "in phase one, models use `global.*` global routing; the Ask-Your-Data model-call hop has a cross-border gap (pure SQL / BI data is unaffected); phase two closes it with region pinning"; **non-blocking** (decided: the gap is accepted in phase one). In phase two the card will support choosing a region-pinned model (forbidding `us.` / `global.` cross-region profiles).
- **Precondition**: when the region has no `agentcore` installed and no regional Ask-Your-Data runtime, the card notes "this region has no local Ask-Your-Data runtime yet; the model setting will be used for the fallback path", so nobody is misled into thinking it is already in effect per region.
- **Consistency**: the three-state probe badge / friendly refusal (F8) / danger-confirmation tiers all reuse scenarios one and two of the model-configuration interaction design; no new paradigm is created.

### 1.7 🆕 Revision 2.17: "Authorized projects" card + "Consents" list (execution environment detail page; no-legal-gate work)

- **The "Authorized projects" card** (**present on every target**, not specialized for cross-jurisdiction; editable by bgp-admin, read-only for everyone else): a two-state Radio "All projects (default)" / "Only the projects below" + a project multi-select; save ⇒ `POST .../[targetId]/access` (full-set semantics). Mechanism B impact preview: before switching to the allow-list, it lists **the projects that will lose visibility** and the number of their tasks already bound to this target (removing a project with bindings from the list ⇒ notice "the bindings of these tasks remain, but members of that project will no longer see this target or be able to rebind"). Members of an excluded project: the target **does not appear** in the target selectors of the job editor / direct query / modeling; a direct API write ⇒ 4xx `project-not-allowed` (presentation = authorization, the same predicate `accessAllows`).
- **The "Consents" list** (shown only when `jurisdiction≠home`): the admin at registration (`by / at / text v<version>`) + every user who has consented (`userSub / text version / time`), data from `GET .../[targetId]/acks`; this is the sole authority for "avoiding disputes", **read-only** and not deletable.
- The jurisdiction in the detail page header is shown as a neutral `🌍 <jurisdiction>` tag; there is no wording like "filing / legal / liability" anywhere.

## 2. Scenario two: multi-region binding and push-down of tasks

Corresponds to the [design document](./multi-region-execution-design.md), section 5 (one definition, many bindings + region-specialized copies) and section 5.2 (per-region dispatch).

### 2.1 Region binding in resource editors

- The editors of the 5 resource kinds (sync / etl-job / engine-job / workflow / redshift-task) + flink-job gain a **region multi-select** (`Select mode=multiple allowClear`, following the monitor filter control convention of section 6.1): **only home is ticked by default** (principle 3, safe by default), and only execution environments in `active` status are listed.
- 🔴 **The "select all current regions" convenience + execution-environment readiness pre-check (decided on 2026-08-28)**: a "Select all active regions" button next to the multi-select binds the definition to every `active` execution environment in one click. **But the availability of the target regions' execution environments must be pre-checked** — for every region to be bound, verify that its execution environment is **installed and initialized** (all probes green per section 1.3 + the required components present, e.g. a redshift-task needs the `redshift` component, workflow scheduling needs `mwaa`). **Regions that are not ready are not bound silently**; instead they are listed as "the execution environments of the following regions are not ready: `eu-west-1` (redshift not installed) / `ap-south-1` (initialization incomplete)", each with a **[Deploy / Supplemental deployment] jump button** (deep link to the supplemental-deployment area of that env's detail page, section 1.5, following the F7 deep-link convention of section 6.1); come back and tick them once ready. Follows principle B6 (pre-check and tell early) + F7 (jump nearby). 🔴 **Select-all must also respect data heterogeneity (a review remediation; consistent with section 2bis.3)**: for tasks that reference a **region-exclusive data source**, "select all" **binds only regions that are ready and where the data is reachable** — for data-locked tasks (the source exists only in one region), select-all grays out the other regions per section 2bis.3 and the button degrades to "bind reachable regions only + notice"; "select all" never binds a region where the data is unreachable. That is, the readiness check has **two dimensions, components ready and data reachable**, not components alone.
- When no non-home region is ticked, the behavior is **byte-for-byte identical** to today (existing tasks notice nothing) — this is the precondition for daring to add this dimension to a production system.
- Data-source resources **show no region binder** (a data source has a physical location; its connection bag carries the region; JDBC sources are home-only in phase one, design document, section 6.4); instead, when a task is bound to a region, **the reachability of the referenced data source in that region is pre-checked**, and an unreachable region is grayed out + a Tooltip explanation (convenience: tell early rather than fail after dispatch).

### 2.2 Publish push-down: preview first, then execute region by region (mechanism B + step-by-step progress)

When publishing / enabling a schedule with more than one region bound, **do not dispatch directly**; first pop the "Dispatch preview" (mechanism B impact preview):

- A table lists: **which regions** will receive **which artifacts** (DAG / Glue script), which bucket they are written to, which workgroup / role is used (all taken from each region's ExecutionEnv descriptor, so operators see the baked-in values), and an estimate.
- After confirmation, **dispatch serially region by region, fail-fast** (design document, section 9); progress uses the `setInterval` polling of section 6.1 + one Badge row per region (dispatching spinner / success ✓ / failure ✗ + reason); at the first failing region it stops, successful ones are kept, and the failed one becomes a red cell in the version dashboard (see scenario three).
- **Cross-region bulk dispatch is a high-risk convenience operation**: when the region count ≥ a threshold (e.g. 3) or a production region is included, a mechanism A second confirmation (`askDecision` pattern) follows the preview.

### 2.2a 🆕 Revision 2.18: MWAA precondition notice for scheduling configuration + one-click path to supplemental deployment (in-region scheduling; the specification, section 3.14)

Decided: "every region's scheduled tasks are executed by that region's own MWAA" ⇒ a non-home target without `mwaa` installed **cannot** have a schedule configured for it. The notice must appear **at the point of action**, **list everything**, and **reach the supplemental-deployment entry in one click**:

- **Trigger points**: Batch Compute [Publish to MWAA schedule] / [Dispatch preview], the EMR panel [Publish to MWAA schedule], and (from the workflow-publishing work onward) workflow publishing. The server returns 409 `MWAA_NOT_INSTALLED` ([specification](./multi-region-execution-spec.md), section 2.1) ⇒ the front end renders the warning card `mwaa-missing-notice` **directly below the scheduling area** (not a toast: a toast vanishes in three seconds, before the user can see which region is missing).
- **Card content**: title "These execution environments have no MWAA scheduler installed, so scheduling / orchestration cannot be configured there"; one row per target `<region> · <targetId> (<displayName>)`; one principle sentence "every region's scheduled tasks can only be executed by that region's own MWAA"; button **"Add MWAA in Execution Environments →"** (`mwaa-missing-fix`) ⇒ `router.push(fix.href)`; in the dispatch preview the corresponding row shows ✗ + the same button.
- **Destination**: `/exec-envs?target=<id>&highlight=mwaa` ⇒ the list page reads the query and opens that target's drawer automatically; the mwaa row in the components area is highlighted + an Alert on the row "You came from the scheduling page: click '+ Supplemental deployment' on this row"; then the existing flow of section 1.5 follows (dry run → approve → deploy → Check initialization); once installed, go back to the scheduling area and click once more to succeed.
- **Wizard Step 2**: `mwaa` is selectable, wording "Scheduling / orchestration (this region's Airflow; required to schedule in a non-home region) · ≈ $350/month (always-on)"; home and non-home jurisdictions are treated alike. 🆕 **Revision 2.19**: a parallel row `airflow-serverless` "Scheduling / orchestration (Serverless Airflow; billed per task-second, minimum 1 minute; provisioned in minutes, nothing always-on)"; both may be ticked at the same time; ~~Step 1 🆕 "network size" radio **standard** (one NAT in each of 2 Availability Zones, default) / **lean** (1 NAT, saving 1 EIP and ≈ $32/month), with a quota pre-check Alert beside it: "EIP usage in this region x / limit y, this environment needs n; if insufficient ⇒ give the quota code `L-0263D0A3` and the increase command, [Start deployment] disabled" (a quota pre-check item).~~
  🔴 **Withdrawn in revision 2.21 (zero-egress execution environments; design document, section 18, decision 6octies)**: execution environments no longer have NAT / EIP ⇒ Step 1 **removes the "network size" radio and the EIP pre-check Alert** (the `networkProfile` field is kept only for compatibility with existing descriptors and no longer appears in the UI).
  Instead, Step 1 keeps only region / jurisdiction / cellId and adds one **read-only note** at the bottom: "The execution environment of this region is **zero-egress**: no NAT / Elastic IP is created, all AWS calls go through VPC endpoints; the only cross-region link is a private connection back to the home region for writing run records."
  **The network row of the detail page** now shows three facts: "Zero egress ✓ · interface endpoints n / n ✓ · cross-region private link → `<home region>` ✓ (`vpce-…`)"; the probe list gains two items `network:egress-none` and `network:home-link`
  (🔴 both **must retry with back-off** before being judged red — after an interface endpoint reaches `State=available` there is still a 2–3 minute private-DNS propagation window; reporting "endpoint missing" after a single red judges a good product to be defective; confirmed by a spike investigation).
- 🆕 **Revision 2.19 correction**: the warning card title becomes "The following execution environments have no scheduler component; scheduling / orchestration cannot be configured for that region", and each row lists the selectable components "airflow-serverless (recommended, minutes) / mwaa"; button "Add a scheduler in Execution Environments →" (`scheduler-missing-fix`; the old testid `mwaa-missing-fix` is kept for one release) ⇒ `highlight=airflow-serverless` (serverless is also highlighted when the target already has mwaa installed but prefers serverless).

```
Batch Compute › job ui-redshift-x   bound to: home · us-west-2 (tgt_usw2_b)
[ cron: 0 * * * * ] [ Publish to MWAA scheduler (2 regions) ]
┌─ ⚠ These execution environments have no MWAA scheduler installed, so scheduling / orchestration cannot be configured there ─┐
│  • us-west-2 · tgt_usw2_b                                                                                                   │
│  Every region's scheduled tasks can only be executed by that region's own MWAA; add the mwaa component in Execution Environments first. │
│                                                                                 [ Add MWAA in Execution Environments → ]     │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
Execution Environments › tgt_usw2_b (drawer opened automatically)  Components:
  ✓ core   ✓ redshift   ✓ residency-api
  ✗ mwaa   Scheduling / orchestration (this region's Airflow)   [ + Supplemental deployment ]   ← highlighted: you came from the scheduling page
```

### 2.2b 🆕 Revision 2.19: scheduler-kind visibility (MWAA Serverless scheduling entry; the specification, section 3.15)

- **Which scheduler is running must be stated on the page**: the "Scheduled" column of the job list and every run-history row carry the tag **"Serverless"** or **"MWAA"** (from deployments[targetId].scheduler / the run row's scheduler); the EMR panel likewise; the "Bucket / environment" column of a dispatch-preview row shows "workflow <name> (version <ver>)" for serverless.
- **Both installed**: the components area of the execution environment detail page shows a "Scheduler preference" radio (Serverless default / MWAA); switching affects only **subsequent** publishes; already-published jobs keep their original scheduler until republished (the page says so).
- **Task logs**: the "Task log" drawer of a serverless run reads CloudWatch (`GetTaskInstance.LogStream`), with the title "CloudWatch · /aws/mwaa-serverless/<workflow>"; MWAA runs keep using the Airflow CLI.
- **60-minute cap**: a run row in `timeout-pending` gets the plain-language note in run history "Serverless has a 60-minute cap per task; the task was submitted and is still running; request a limit increase or switch to MWAA".
- 🆕 **[Trigger once]** (Batch Compute page / EMR panel, clickable once published; `scheduler-trigger`): runs the scheduling artifact once immediately for every published target (serverless ⇒ `StartWorkflowRun`, classic ⇒ `dags trigger`), with a second confirmation "Run each published scheduling artifact once now (without changing the cron)?"; trigger ≠ publish (unpublished targets are truthfully reported as skipped). The "Trigger" column of run history carries the tag "Serverless · SCHEDULED / ON_DEMAND" or "MWAA" (ledger fields `scheduler` / `runType`).
> 🔴 **Revision 2.20 correction (real-environment finding of 2026-09-07)**: run-history **rows show only "Serverless"**. SCHEDULED / ON_DEMAND are not on the row — the worker side cannot tell the trigger source apart (measured: a cron trigger and a manual StartWorkflowRun look exactly alike), and the ledger deliberately does not store this derived value; the trigger source is shown in the **run-log dialog** from the service-side `GetWorkflowRun.RunType` (`run-log-trigger`: "Trigger: scheduled (service-side)" / "Trigger: manual (service-side)").

```
Batch Compute › job glue-spark-x   bound to: home · us-west-2 (tgt_usw2_a)
[ cron: */5 * * * * ] [ Publish schedule (2 regions) ]   Published: home [Serverless] · tgt_usw2_a [Serverless]
Run history: 09:05  tgt_usw2_a [Serverless · SCHEDULED] succeeded   [Task log → CloudWatch]
> 🔴 **Revision 2.20 correction (real-environment finding of 2026-09-07)**: run-history **rows show only "Serverless"**. SCHEDULED / ON_DEMAND are not on the row — the worker side cannot tell the trigger source apart (measured: a cron trigger and a manual StartWorkflowRun look exactly alike), and the ledger deliberately does not store this derived value; the trigger source is shown in the **run-log dialog** from the service-side `GetWorkflowRun.RunType` (`run-log-trigger`: "Trigger: scheduled (service-side)" / "Trigger: manual (service-side)").
```

### 2.3 Region-specialized copies (echoing the tension management of the design document, section 5.1)

- Entry: the task row action "Specialize from the shared definition to region…" (reusing the copy mechanism of the [project-isolation design](./project-isolation.md), with region as the target dimension).
- **Visual marker after specialization**: that (region × definition) shows a **"Specialized" corner badge** in the editor / dashboard (e.g. an orange Tag "detached from the shared definition; does not follow updates to the main definition"), making the "controlled re-introduction of drift" emphasized in the design document, section 5.1, **explicitly visible** rather than hidden in the data.
- A rollback action "Cancel specialization and follow the shared definition again" is provided (mechanism A second confirmation, because it discards that region's specialized changes).

## 2bis. 🔴 Regional heterogeneity interaction (a decided key focus: regions are not homogeneous)

> Emphasized on 2026-08-27: "**Not all regions' compute tasks are absolutely identical; it is normal for some regions to have region-specific compute tasks** (which regions a task runs in is chosen by the user's needs); **certain regions may hold exclusive data that other regions do not have**". Scenario two previously assumed implicitly that "all regions run the same set"; this section redoes the interaction for heterogeneity specifically, following principles A3 (scope as a first-class citizen), B6 (pre-check and tell early) and B5 (one-screen aggregation).

### 2bis.1 Three kinds of heterogeneity (clarify what is being solved first)

| Kind | Meaning | What the interaction must solve |
|---|---|---|
| **Task heterogeneity** | The same task need not be bound to all regions; a region may have exclusive tasks (the definition is bound only to it) | Selective binding by region + telling "shared multi-binding / region-exclusive / specialized" apart at a glance |
| **Data heterogeneity** (the most emphasized) | A region has exclusive data that other regions lack (exclusive data sources / tables) — factual basis: the connection bags of stream / object sources carry `region` (`msk.ts:57` / `s3.ts:59` 🔵), and data sources inherently have a physical location (design document, section 5.1) | Express "this data source / table exists only in region X"; tasks referencing it **can be bound only to X**; choosing another region is blocked up front with the reason stated |
| **Visualization heterogeneity** | The dashboard cannot assume "every cell should have a value" | Cells that are region-exclusive / have no data must be **visually distinct** from "not dispatched", avoiding false alarms |

### 2bis.2 Task heterogeneity: selective binding + recognizable ownership

- The region multi-select of the resource editor (scenario two, section 2.1) already supports "the user chooses which regions to bind" — **this is precisely the entry point for task heterogeneity**, already covered in phase one. Additional interaction:
  - The task list / dashboard labels each task's **binding form**: `🌐 Multi-region shared` (bound to > 1 and not specialized) / `📍 Region-exclusive` (bound to only 1 region) / `🔶 Specialized` (section 2.3). Whether "this task runs in all regions" is recognizable at a glance (principle A3).
  - **Region-exclusive tasks** are first-class citizens, not anomalies: just tick a single region as usual when creating; the dashboard does not report "missing / not dispatched" because the task "exists in only one region" (see 2bis.3).

### 2bis.3 Data heterogeneity: expressing exclusive data + reference constraints (core)

- **Make a data source's "regional availability" explicit**: the data-source list / detail labels its region ownership (stream / object sources from the connection bag's region; JDBC sources home-only in phase one, design document, section 6.4). Badges such as `📍 us-west-2 only` or `🌐 available in multiple regions`.
- **Pre-check of reference constraints (principle B6, not failing after execution)**: when binding a task to a region, if the data source it references **does not exist / is unreachable** in the target region, that region option is **grayed out + a Tooltip** "data source "X" exists only in us-west-2 and cannot execute in this region". Users understand at the moment of choosing, instead of blowing up after dispatch.
- **Reverse guidance**: for a task that selected a region-exclusive data source, the region multi-select locks automatically to that region (the others grayed out) with the note "this task depends on data exclusive to region X and can only execute in X".

**Wireframe (task editor · region binding meets data heterogeneity):**
```
┌─ Edit sync task "MSK order stream → warehouse" · execution regions ────────────────────────────────────┐
│  Source data source: kafka-order-stream  📍 us-west-2 only (the MSK cluster is in that region)         │
│  Bound execution regions (multi-select):                                                               │
│    ☑ us-west-2   (where the source data lives)                                                         │
│    ☐ us-east-1   ⊘ grayed out  ⓘ source "kafka-order-stream" exists only in us-west-2; unreachable     │
│    ☐ eu-west-1   ⊘ grayed out  ⓘ same as above                                                         │
│  ⚠ This task depends on region-exclusive data and is locked to execute in us-west-2 (region-exclusive) │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2bis.4 Visualization heterogeneity: the dashboard distinguishes "exclusive / nonexistent" from "not dispatched"

The version matrix of the multi-region dashboard (scenario three) **must distinguish three kinds of "cell without a value"**, otherwise region-exclusive tasks are misreported as "missing a region":

- **Green / yellow / red** (has a binding): dispatched ✓ / version mismatch / dispatch failed — this is what "needs attention or not" is about.
- **`—` gray (unbound, normal)**: the task was never bound to this region (region-exclusive / not bound on purpose) — **excluded from the "inconsistency" verdict, no alarm**.
- **`⊘` dark gray (data unavailable)**: the region lacks the exclusive data this task depends on and inherently cannot be bound — hover explains "region-exclusive data source missing", clearly distinct from "not dispatched".

> This directly answers the other side of a customer requirement: "afraid of missing a region" relies on the matrix to catch it; but **"a region that was never supposed to have it" must not be mis-caught as missing** — otherwise the dashboard misreports every day and operators stop trusting it. The visual distinction between gray / dark gray and red / yellow (the unified color palette of the interaction principles, ruling D-2) is key.

### 2bis.5 Consistency with the existing design

- With the design document's section 5.1 (one definition, many bindings vs. region specialization): task heterogeneity = the natural result of multi-binding + the explicit specialization action; no new mechanism is added.
- With the no-redshift degradation of the design document's section 8.1: the data-heterogeneity case "a warehouse task hitting a region without redshift" likewise goes through the pre-check and is grayed out (design document, section 5.2, component-existence check); the two are different trigger sources (component missing / data missing) of the same "pre-check" framework.
- With the design document's section 5.1 "data sources are not multi-region bound + reachability pre-check": this section is its **interaction-level explicitation**; the back-end conclusion is unchanged.

## 3. Scenario 3: unified multi-region monitoring dashboard interaction (the direct answer to the customer pain point "afraid of missing a region so that the data no longer matches")

Corresponds to [the design document](./multi-region-execution-design.md), section 5.3. This is **an aggregated view that existing conventions do not cover and that needs new design** (gap ① in section 6.2) — every existing page is "switch, then look at a single scope", whereas here we need "see all regions on one screen".

### 3.1 Version-consistency matrix (the core new component)

- **Matrix view**: row = resource definition, column = bound region, cell = the version number pushed for that (definition × region) + a status color.
- **Inconsistency highlighting**: when the versions of the same definition differ across regions (a region was missed, or received an old version) → the row gets a **yellow warning**; a failed push → red cell. This directly answers "afraid that an operation misses a region and the data no longer matches".
- **One-click re-push**: open a red / yellow cell → "Re-push to this region" (mechanism B previews what will be generated for that region → confirm → push).
- Specialized cells carry a corner marker (they do not take part in the "inconsistent" verdict, because they are supposed to differ).

**Wireframe (multi-region dashboard · version-consistency matrix):**
```
┌─ Multi-Region Dashboard                          [region: All ▾] [Inconsistent first ▾] ─┐
│ 💡 Push consistency of every region on one screen; red = failed, yellow = version mismatch, green = consistent (FeatureGuide) │
├────────────────────────┬──────────────┬────────────────────┬────────────────┬────────────────────────┤
│ Task definition        │ us-east-1    │ us-west-2          │ eu-west-1      │ Actions                │
├────────────────────────┼──────────────┼────────────────────┼────────────────┼────────────────────────┤
│ Order sync 🌐          │ ✓ v5 (green) │ ✓ v5 (green)       │ ⚠ v4 (yellow)  │ [Re-push to eu-west-1] │← version mismatch
│ Daily-report workflow 🌐│ ✓ v3        │ ✗ failed (red)     │ — not bound    │ [Re-push to us-west-2] │← push failed
│ User profile 🌐        │ ✓ v2         │ 🔶 specialized v2' │ ✓ v2           │ —                      │← specialized: not judged inconsistent
│ MSK order stream 📍    │ ⊘ no such data│ ✓ v1 (green)      │ ⊘ no such data │ —                      │← region-specific: not reported as missing
├────────────────────────┴──────────────┴────────────────────┴────────────────┴────────────────────────┤
│  ⚠ 2 items inconsistent / failed                 [Re-push all inconsistent items (impact preview)]   │
│  Cell legend: ✓ pushed  ⚠ version mismatch  ✗ failed  🔶 specialized  — not bound (normal)  ⊘ data unavailable │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
  Run comparison (optional column): the row counts produced by the latest run of the same task in each region, side by side; deviations highlighted → early warning of "data does not match"
```
> This is the **head-on answer** to the customer's core pain point "afraid that an operation misses a region and the data no longer matches": a missed push / failure / version mismatch is visible at a glance (F5 feedback), clicking a cell goes straight to re-push (F7), and the batch "re-push all inconsistent items" goes through the impact preview (section 8.2 convenience + mechanism B). **Key point (C1 regional heterogeneity, section 2bis.4)**: the three cell kinds `🔶 specialized` / `— not bound` / `⊘ data unavailable` **take no part in the red / yellow verdict and raise no alarm** — only a genuine missed push / failure / version mismatch is highlighted, so that "this region was never supposed to have it" is not mistaken for "a region was missed", which would make the dashboard raise false alarms every day. Task names carry a binding-form marker (🌐 shared across regions / 📍 region-specific).

### 3.1a 🔴 Added in design revision 3.0 (settled during construction): **which rows enter the matrix** — without this rule the dashboard raises false alarms every day from the moment it goes live

Section 2bis.4 settled that "three kinds of cells take no part in the red / yellow verdict", but **the admission rule for rows** had never been settled. During construction two loopholes were found that make the dashboard **raise false alarms (false red)**,
which is just as fatal as a "false green" (after three days of false alarms nobody looks at it any more, and the component was built for nothing):

| Loophole | What happens if it is not handled | Decision |
|---|---|---|
| **① Resource types whose publish path is not yet wired to the ledger** | The `deployments` attribute does not exist at all ⇒ every cell of every row is judged `never-deployed` = ⚠ not pushed. **The whole screen turns yellow**, while the truth is "publishing for this resource type never went through the ledger at all" | 🔴 **List only the resource types whose publish path really writes the ledger**. Currently = **the single type `etl-job`** (wired in the second half of the publish-path construction batch). The top of the dashboard **honestly lists the uncovered types** (sync / engine-job / workflow / redshift-task / flink-job), so that users do not believe "one screen shows everything" |
| **② Definitions that have never been published (drafts)** | Bound to regions but "publish" was never clicked ⇒ judged `never-deployed` = ⚠ not pushed. Yet the user never asked for a push at all | 🔴 **Unpublished definitions do not enter the matrix** (criterion: `scheduleEnabled` is true **or** `deployments` is non-empty). The matrix is about the consistency of **what has been pushed**; a draft has nothing to compare against. The number of excluded definitions is **shown honestly** ("N more unpublished definitions are not listed") |

🔴 **How the columns are chosen**: **the currently active targets ∪ every target that appears in any row** (in a binding or in the ledger).
Taking only the active columns would make "pushed to a target that was later removed" **disappear as a whole column** — exactly the inverse (hiding) of the "miss" this dashboard is meant to catch.
Inactive columns are marked (for example `Retired`), never silently dropped.

🔴 **`currentVersion` comes from the version-snapshot table** (`currentDefinitionVersion`) and **is not stored a second time on the resource row** —
two sources of truth inevitably drift, and the drift shows up precisely as "the matrix says the versions differ, when in fact it misremembered them itself".

### 3.1b 🔴 Added in design revision 3.0 (settled during construction): **the "modeling artifacts" row group is interleaved into the matrix** — one screen answers "what exactly is this region missing"

Section 3.1a settled the admission rule for task rows. The construction batch that delivered "per-target landing of modeling artifacts + observed state" (section 4ter)
gave the same question **two sources of truth**: task rows look at "what I pushed" (the `deployments` ledger),
modeling-artifact rows look at "what is in the database right now" (`landedByTarget`, the **observed state**).
The user is asking **one and the same question** ⇒ decision: **interleave both into the same matrix, sharing the same set of columns** (no second dashboard —
two dashboards would mean "does this region lack something" has to be checked in two places, and the place that gets missed is exactly the one nobody looks at).

```
┌ Multi-Region Dashboard ──────────────────────────────────────────────────────────────────────────────┐
│  Definition                                  │ us-east-1 (home)   │ us-west-2              │ eu-west-1        │
│  ⏱ Batch job     Order wide table 🌐 shared  │ ✓ v7               │ ⚠ version mismatch v6  │ — not bound      │
│  🧱 Code table    Order status               │ ✓ observed 09-04   │ ⊘ no write channel     │ — not bound      │
│  🧱 Dim / fact    Customer dimension         │ 🔴 schema drift    │ ⊘ no write channel     │ ⚠ Not persisted  │
│  Cell legend (two new cells): 🔴 schema drift  ⊘ no write channel  (⊘ blocked by residency gate: withdrawn in revision 2.17) │
│  [Remediate the auto-alignable items (3)]  [1 of them requires manual handling]                     │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Interleaving brings four points that **must be done right the first time** (each has a gate test plus a mutation test pinning it):

| # | Loophole | What happens if it is not handled | Decision |
|---|---|---|---|
| ③ | The **mapping** from observed state to cell state | Modeling has 7 observed states and the matrix originally had 7 cell states; they do not line up. Written as `map[s] ?? "ok"`, any state added in the future **silently turns green** | 🔴 **Exhaustive mapping** `LANDED_TO_CELL: Record<LandedState, CellState>` — a missing state **fails to compile**. `never-landed → never-deployed` (same severity), with the wording rewritten per row group (task = "not pushed" / modeling = "Not persisted"); **severity is defined in exactly one place** |
| ④ | Which states **take part in the verdict** | If `⊘ no write channel` counted, it would be **a red dot the user can never clear** (the platform has no channel yet; `⊘ blocked by residency gate` was withdrawn in revision 2.17 — no legal gate) ⇒ false alarms every day; whereas if `drift` did not count, the dashboard would **fail to report a real problem** (the table in the database is not at all what the platform defined) | 🔴 `ATTENTION_STATES` = `never-deployed / stale / failed / **drift**`; `⊘ no write channel` **firmly stays out** (revision 2.17: `⊘ blocked by residency gate` withdrawn, the whole state deleted). 🔴 And it is **compared state by state** against the modeling side's `LANDED_ATTENTION` (gate test): otherwise you get "the landing panel is red while the dashboard is green" — two statements about one and the same fact |
| ⑤ | **Which endpoint** "one-click remediation" calls | Before interleaving, that action was **hard-coded** to `/api/etl-jobs/{id}/schedule` ⇒ after interleaving it would **publish a DAG with a codeTableId** (successfully doing the wrong thing) | 🔴 Extract a **pure dispatch function** `matrixRepublishAction(row, target, state)`: code table → `/land`, dimension table → `/apply`, task → `/schedule`; **an unknown type may only skip, never fall back to the task endpoint**. The gate test asserts a dispatch target for every type |
| ⑥ | Whether `drift` may be remediated with one click | There is **only one road** to align a drift: DROP the existing table in that region and rebuild it from the platform definition — **lossy and irreversible**; that table may have been created by someone else and may be written by another job right now. Mixing it into one-click batch remediation means one click can delete tables in several regions | 🔴 **No one-click for `drift`**; it goes through the typed confirmation string on the Data Modeling landing panel (`FORCE-REBUILD`, section 4ter); the dashboard **shows "requires manual handling → Data Modeling page" and states the reason** (silently skipping = the user believes it has been handled). The number on the button is the count of **auto-alignable** cells, not the total count pending (otherwise it over-promises) |

🔴 **Landing / detecting a subset must never change the bindings of other regions** (the third real bug caught during the interleaving construction batch, fixed at the root):
the [Land in this region] action on a matrix cell carries **that one** target, but the landing service used to write its input straight back into the bindings ⇒
one click **silently unbound this code table from its other regions**. The task side had long since forbidden exactly this (the publish-path construction batch: a subset re-push that names an unbound region
is **refused outright** and never touches the bindings). Decision: **the targets of this landing ≠ the definition's bindings**; bindings **only grow, never shrink**
(**landing implies binding**); **unbinding must be an explicit action** — this iteration has no such action, which is honestly recorded below.
The checkbox wording on the landing panel is changed accordingly to "Land only these regions; **the bindings of other regions are not changed**".

🔴 **Leftovers (the fifth finding, newly settled in the interleaving batch)**: for modeling artifacts, **unbinding is not the same as dropping the table** — to this day the platform has **no channel to "clean up landed artifacts"**.
If a cell that has a landing record but is not currently bound to that region were drawn as `— not bound`, **the table left behind in another jurisdiction** would be hidden
(exactly the shape that residency compliance fears most). Decision: **the cell shows the observed state as it is + a "Leftover" tag + a tooltip explaining that there is no cleanup channel**;
it is **not counted** as needing attention (pressing it would have no corresponding action), but it is **never hidden**. The verdict order is therefore
"**first check whether a record exists** (the record is an observed fact) → then check whether it is bound"; the reverse order would hide the leftovers.

🔴 **Scope stated honestly**: task rows belong to **this project** (`projectFilter`); modeling artifacts are **platform-wide and global**
(modeling has no project dimension on this platform — which is also the root cause of the missing credential channel for non-home modeling landing, section 4ter.a).
The dashboard must print this statement on the page; otherwise users assume the whole screen is "things in my project".

🔴 Moreover, once "landing changes the bindings as a side effect" was fixed, the "**Leftover**" state **can no longer be constructed at all in a real environment** —
the platform has no explicit unbind action of any kind (modeling bindings can only grow through landing). It **stays in the code** (covered by unit tests):
once an "unbind / clean up landed artifacts" action is added in the future, leftovers will really appear, and if they were drawn as "— not bound" at that point,
tables left behind in other jurisdictions would be hidden. ⇒ The "**unbind + clean up landed artifacts**" piece of work is registered in the backlog
(same batch as the narrow-privilege shared-writer channel; see section 4ter.a).

✅ **Correction in revision 2.17**: the former note "honestly recorded: `⊘ blocked by residency gate` and cross-jurisdiction leftovers cannot be constructed in the current environment" is withdrawn — `⊘ blocked by residency gate` is deleted as a whole state (no legal gate; [the design document](./multi-region-execution-design.md), decision 6quinquies); cross-jurisdiction leftovers were really tested by the explicit-unbind work; `⊘ no write channel` **can be verified every single time** in a real environment (non-home modeling landing; it turns into success after the shared-writer channel work).

### 3.2 Cross-region cost + run comparison

- **The first level of cost = region** ([the design document](./multi-region-execution-design.md), section 8.4): the top level of the cost page becomes region cards (monthly cost per region); clicking a card drills into that region's service / task costs (reusing the existing finops tabs). Follows the `Row+Col+Card+Statistic` convention of section 6.1.
- **Run-comparison column (optional)**: the row counts produced by the latest run of the same task in each region are **shown side by side**; a deviation above the threshold is highlighted — the early signal of "data does not match" (the data comes from task-runs metrics, which already carry the region dimension; [the design document](./multi-region-execution-design.md), section 7.1).

### 3.3 Region filter on the monitoring lists

- The monitor / ops pages **add a `region` `Select allowClear`** following the convention of section 6.1 (alongside the existing status / taskType filters); administrators default to "all regions" and can filter down to one region. A run's region comes from the new dimension on task-runs.

## 4. Scenario 4: switching region in Ask-Your-Data (decided: single-region execution, no parallelism, use that region's model)

Corresponds to [the design document](./multi-region-execution-design.md), section 8.2.

- **Region selector**: a region selector at the top of the Ask-Your-Data page (following the header environment-switcher pattern of section 6.1; the list of active environments, default home); **the current region is prominently displayed** (mechanism D: the user always knows which region is being queried, eliminating "I thought I was querying A but it was B").
- **A conversation is anchored to a single region**: one conversation is anchored to one region; switching region shows the prompt "Switching region starts a new conversation (to avoid mixing regions in the context)", and after confirmation the current conversation context is cleared. **No multi-region parallel Ask-Your-Data / result merging** (already decided).
- **The model follows the region**: Ask-Your-Data in that region uses the model configured for that region (`resolveModelIdRuntime(capability, targetId)` of [the model-configuration design](./model-configuration.md), D8); if that region has no agentcore component installed, it falls back to inprocess automatically ([the design document](./multi-region-execution-design.md), section 8.2), transparently to the user.
- **History filtered by region**: the Ask-Your-Data history page gets a region filter; every question and answer **is labeled with the region queried** (convenience: when reviewing history you know which region was queried at the time).

## 4bis. 🔴 Cross-jurisdiction data queries: disclaimer + retained consent + neutral label + audit id (rewritten in revision 2.17; [the design document](./multi-region-execution-design.md), section 18, decision 6quinquies)

> 🔴 **Correction in revision 2.17**: before revision 2.16 this section described "an informational banner + informed confirmation + acceptance of liability + no transparent merge" (the interaction surface of the dual-track option B decided in [the design document](./multi-region-execution-design.md), section 8.5). It was decided on 2026-09-05 that **there is no legal gate**: "we do not make legal decisions … we only need it to be auditable" + "a dialog may show the liability notice … once the user agrees, the user's choice may be retained, to avoid disputes" + "state that we assume no legal risk whatsoever; users must constrain and govern data compliance themselves according to the laws and regulations of their local government". ⇒ The former wording "informed confirmation / liability / data export" is **withdrawn entirely**; a cross-jurisdiction target **follows exactly the same interaction path as a same-jurisdiction target**; the platform does only two additional things: **disclaimer + retained consent**, and **auditability** (the audit id is visible). Follows the interaction constitution, principles A3 / A4 / F8.

### 4bis.1 Entering a cross-jurisdiction target (switching the execution scope)
- When the execution scope in the top bar (section 9) is set to a target with `jurisdiction≠home`: the data pages **do not change** (SQL editor / data lake / Ask-Your-Data / BI as today); the only additions are a **neutral label** `🌍 <region> · <jurisdiction>` (direct-query sheet header / dashboard column header / history rows / the "Execution region" column of run history) and, for that target, the small text "**Consented v<version> ✓**" (when the current user has already consented). There is **no** danger-colored banner and **no** "export / liability" wording (that would be the platform making a legal characterization on the customer's behalf, which it was decided not to do).
- SSO is seamless, no hop to another site, no regional front end is installed (unchanged).

### 4bis.2 Three query paths (experience unchanged, plus one audit id)
- **Redshift SQL editor / Athena / Ask-Your-Data / BI**: **byte-for-byte the same interaction** as same-jurisdiction; execution is central (having the browser connect directly to the regional data plane to execute nearby is an optimization of later work, not a gate). The only difference: the sheet header / result header shows the **audit id** (`audit_<ulid>`, click to copy) — this query has a full record in the regional audit table and a summary in the central one ([the specification](./multi-region-execution-spec.md), section 3.3), and can be traced back.
- **SQL history**: rows of a cross-jurisdiction target carry 🌍; the SQL column shows "Kept in region <jurisdiction>"; clicking [View] has the central plane **proxy-read the regional table** and display the original text, which never lands centrally ([the specification](./multi-region-execution-spec.md), section 1.3a, the SQL-history storage item). This is a **residency product capability (where the data lives)**, not an intervention.
- Masking: the same central masking as same-jurisdiction (regional-side masking → later work).

### 4bis.3 Merge / JOIN: available, audited
- The direct-query [Merge into one table] action **is available** for cross-jurisdiction targets (section 4septies.6, revision 2.17); the merged result header carries the audit ids of each sheet. No more "why you cannot merge + the way out" — the customer completed its own legal decision the moment it registered the cross-jurisdiction target (decision 6quinquies).
- BI dashboards that interleave cross-jurisdiction widgets: each widget fetches on its own and is audited on its own; no per-widget disclosure dialog.

### 4bis.4 🔴 Disclaimer dialog + retained consent (supplementary decision of 2026-09-05)
- **Moment ① (at registration)**: the last step of the creation wizard (section 1.2) shows the notice text + a checkbox "I have read and agree" for `jurisdiction≠home`; **unchecked ⇒ [Start deployment] is disabled**; checked ⇒ the registration request carries `residencyAck:{version, textHash}`, which the server verifies and writes into the descriptor ([the specification](./multi-region-execution-spec.md), section 1.1).
- **Moment ② (first time per user)**: when any user performs a data operation on a given cross-jurisdiction target **for the first time** (direct query / binding a task / modeling landing / run) ⇒ the server returns 409 `residency-ack-required` (the response contains the current text and version) ⇒ the front end shows the **disclaimer**:
  ```
  ┌─ Disclaimer · tgt_euw1_a (🌍 eu-west-1 · eu-sim) ─────────────────────────────────────────┐
  │  This platform assumes no legal risk related to cross-border data transfer or data compliance. │
  │  You must constrain and govern data compliance yourself according to local laws and regulations. │
  │  Clicking [Agree and continue] confirms that you have read and agree.            (text v1)  │
  │                                                          [Cancel]   [Agree and continue]    │
  └────────────────────────────────────────────────────────────────────────────────────────────┘
  ```
  [Agree and continue] ⇒ `POST /api/residency/ack {targetId, version}` (writes the residency-acknowledgement table + the central audit event `residency.ack`) ⇒ the original operation is **retried automatically**; [Cancel] ⇒ nothing is executed, nothing is recorded. The same (user, target, text version) **is never prompted again**; only a new version of the text prompts once more.
- **One author for the text**: `lib/residency/disclaimer.ts` (version + text + hash); pages **must not** compose the text themselves; neither the repository nor any page **contains** wording such as "legal filing / you bear the liability / data export" that characterizes on the customer's behalf (the withdrawn old wording; covered by a negative acceptance check).
- **Enforced server-side, the front end is not trusted**: a request without consent is always 409 and the operation is not executed (an acceptance criterion); the dialog is merely the presentation of the 409.

### 4bis.5 Traceability (avoiding disputes) + consistency
- The execution-environment detail page (section 1.7) has a "Consents" list: the administrator at registration (`residencyAck.by / at / version`) + every user who has consented (`userSub / version / at`); `GET .../[targetId]/acks`.
- Consistent with scenario 4 (switching region in Ask-Your-Data): cross-jurisdiction is not a "hardened" variant of it, it only adds the disclaimer / audit id; same-jurisdiction behavior is unchanged. First-iteration trade-off (accepted): cross-jurisdiction SQL history stays in the region ⇒ there is no globally unified history ([the design document](./multi-region-execution-design.md), section 8.5.6).

## 4ter. 🆕 Scenario 5: per-target push-down of modeling and drift presentation (axis A; [the specification](./multi-region-execution-spec.md), section 3.8)

> Since design revision 3.0, modeling landing (code tables / dimensions / fact tables) is part of the same push-down framework as tasks: **the definition is globally unique → the structural DDL is materialized per target → `landedByTarget` records the observed state**. The interaction reuses three existing patterns — section 2.1 (target multi-select) + section 2.2 (push preview) + section 3.1 (consistency matrix) — **nothing new is invented**; the only additions express "which schema it lands in / the three-color observed state / gated".

- **Landing panel** (Data Modeling › code tables · dimensions): states explicitly whether it lands in the **`shared` schema** (the global knowledge layer) or in `proj_<id>` (project-private); the target multi-select checks only home by default (principle 3, safe by default).
- 🔴 **Three-color observed state (prevents a false-green dashboard)**: `✓ landed v3` (the observed schema hash matches the definition) / `⚠️ version mismatch` / 🔴 **`drift`** (a table of the same name with a **different structure** already exists in that target and the platform **did not overwrite** it) (revision 2.17: `⊘ blocked by residency gate` withdrawn — no legal gate; landing a code table in a cross-jurisdiction target takes the same path as in a same-jurisdiction one). **drift is never shown as ✓.**
- **Exits for `drift`**: [View diff] (column-level diff) + [Force rebuild from platform definition ⚠] (mechanism A double confirmation + the hint "this will DROP the existing table in that target; back it up first").
- **Enters the section 3.1 consistency matrix**: modeling landing is interleaved into the version matrix as a separate row group "modeling artifacts" — governance artifacts are more hidden than tasks (nobody ever gave code tables a dashboard before), **which is exactly why they must enter the matrix**. **The admission rules for interleaving and the four points that must be done right are in section 3.1b.**
- 🔴 **[Re-detect] only updates the "observed facts", never the "definition fingerprint"** (a real bug of the first modeling-landing batch, bitten back by the interleaving batch, fixed at the root):
  observation can only see `information_schema` (**column structure**), not **data**. And the most common change to a code table is **adding one enum value** —
  not a character of the column structure changes, the table has one row fewer. If [Re-detect] overwrote the landing record with the current definition fingerprint, one click would turn
  ⚠ version mismatch into ✓ landed while the table in that region actually lacks that row ⇒ **exactly the false green the contract names as the thing to prevent**
  (the "observed state" mistaken for "what I believe I pushed"). Decision: the fingerprint **is carried over from the previous record**; with no history it stays empty
  ⇒ the read side judges "version mismatch" (honest: the structure exists, but the platform never landed this definition) and prompts for a real landing.
  **Only a real landing (one that executed the load statements) is entitled to write the current fingerprint.**
- 🔴 **Editing a definition must never wipe the per-target truth** (the second real bug caught in the same batch, fixed at the root): the resource row has **two authors** —
  definition editing (name/code/values/columns) and the landing records (`targets` / `landedByTarget`) — and editing is a
  **full Put** ⇒ unless carried over explicitly, "editing the definition once erases what the other author wrote".
  The consequence is not "one field missing": every cell degrades from ⚠ version mismatch to **⚠ Not persisted** while those tables **still exist** in the database (false alarm);
  once `targets` is lost along with it, those regions do not even show a "Leftover" any more — exactly the "never hide" rule of section 3.1b overturned by a single edit.
  🔴 **Changing nothing but the display name triggers it**, regardless of whether code/values changed. Decision: the per-target truth attributes are listed in a **single list**
  (`PER_TARGET_TRUTH_KEYS`), both edit paths carry them over through the same `perTargetTruth()`, and the gate test pins every key of the list;
  a per-target attribute added in the future only needs to be added to that list.
- The interaction details are aligned with the project-isolation side (modeling landing panel / `shared` presentation); see [the project-isolation design](./project-isolation.md).

- 🔴 **Revision 2.16 (the explicit-unbind work): unbind / cleanup are explicit actions and no longer grow one-way through landing**: every target row on the landing panel gets [Unbind…], a dialog with two choices —
  "Unbind only, keep the table already landed in that region (the matrix will show **Leftover**)" / "Unbind and clean up: DROP `<schema.table>` (about N rows, last landed <time>)";
  cleanup requires **typing the table name** to confirm (mechanism A, the same discipline as force rebuild). Unbinding the last target shows the note "this will fall back to the default home".
  Deleting a definition that still has landing records: the dialog lists the physical tables in each region and offers only two exits, [Go to the landing panel and clean up region by region] / [Keep the physical tables, delete only the definition] (type the code to confirm; the audit records "intentionally kept" per table).
  The "Leftover" cell keeps its existing rendering (volcano tag, not counted as needing attention, **never hidden**) and disappears after cleanup.

### 4ter.a 🔴 Added in design revision 3.0 (settled during construction): the fifth state `⊘ no write channel` — a **contract gap** for non-home modeling landing

Section 4ter defined four states (`✓ landed / ⚠ version mismatch / 🔴 drift / ⊘ blocked by residency gate`) [revision 2.17: `⊘ blocked by residency gate` withdrawn; the four states are now ✓ / ⚠ / drift / ⊘ no write channel]. During construction it turned out that **a non-home target cannot reach these four states at all**,
because the contract layer lacks a credential channel, and the gap has a precise shape (it is not an implementation oversight):

| Fact | Source |
|---|---|
| Modeling landing is **admin-level DDL**; `project-context` requires a projectId, yet **modeling is global and has no project** (forcing one in does not work either: a per-project identity has no privileges on `public`) | [the specification](./multi-region-execution-spec.md), sections 3.9 / 3.9b |
| The `admin-ddl` purpose **throws outright** (decision: admin-level DDL always goes through the closed executor of section 3.9a; the raw admin ARN is never handed to the caller) | `privileged-cred.ts` file header |
| The contract **already has** a `land-code-table` operation, but its template lands in **`shared.code_<id>`** (columns `code/label/sort_order`) and **deliberately does no data write** — loading data was moved out of the admin channel to the "narrow-privilege shared-writer" | `admin-ddl-templates.ts` file header, section 4.6 |
| Whereas the production implementation lands in **`public.dim_code_<code>`** (columns `value/label/seq`) and **does load data**; that narrow-privilege channel is **a leftover deliverable of the project-isolation construction, not delivered to this day** | measured in this batch |

⇒ **Decision: add a fifth state `credential-gap` (⊘ no write channel)**; a non-home target is judged this directly and **not a single statement is executed**,
and the reason is written into the record (what is missing / which batch it belongs to / why there is no workaround).

- 🔴 **Not counted as "needs attention"** (the user can do nothing at all in that region), but the interface **must show the reason** — a bare grey dot amounts to hiding the gap.
- 🔴 Cells of this kind **cannot be checked** in the panel: checking would only write one more identical record, and would suggest "maybe it works if I try again".
- ~~🔴 **Cross-jurisdiction first**: `residency-blocked` is the stronger "was never supposed to exist here"; it is judged before this one.~~ [🔴 withdrawn in revision 2.17: `residency-blocked` deleted as a whole state (no legal gate); there is no ordering question any more]
- 🔴 **Why there is no workaround** (both roads are unacceptable; written down here so that nobody later "just tweaks it"):
  dropping the data load = abolishing code-table landing as a feature; handing the raw admin ARN to the caller = violating the security decision of section 3.9a.

**Deliverables needed to close this gap** (a separate piece of work, not part of the modeling-landing batch): **a narrow-privilege `shared-writer` credential channel** —
a per-target narrow-privilege write identity (INSERT/DELETE only on `shared` / the modeling physical tables, no admin),
or a stored procedure with fixed parameters; and converging the physical landing point of code tables from `public.dim_code_<code>` to the contract's
`shared.code_<id>` (column naming unified at the same time). ⚠️ Both touch **existing tables** and must be designed together with migration and rollback.

#### 4ter.a-1 🆕 Revision 2.31: the **closing conditions** of the fifth state (the shared-writer channel work; contract: [the specification](./multi-region-execution-spec.md), **revision 3.48, section 3.9d**)

> - 🔴 Written as "closing conditions" rather than "already closed": specification revision 3.48 only **defines** the carrier;
>   when a given cell on the screen stops being `⊘ no write channel` is decided row by row by the table below.
> - **Not a single cell may be turned green early** — the only admissible basis is that the acceptance criteria for this closure have actually been run.

| This cell | What it shows after closure | Closing condition (missing any one ⇒ still ⊘) |
|---|---|---|
| **Non-home · same jurisdiction** (e.g. us-west-2) | The **same four states as home** (`✓ landed / ⚠ version mismatch / 🔴 drift`, plus `failed` on a real failure) — 🔴 **no fifth state**, not "the fifth state with different wording" | The rows really exist in that region's Redshift (row count == the number of enum values in the definition) and the writer is `shared_writer` (acceptance criterion) |
| **Non-home · cross-jurisdiction** | **Byte-for-byte the same path** as same jurisdiction (no legal gate; [the design document](./multi-region-execution-design.md), section 18, decision 6quinquies), plus one **regional audit** entry | Acceptance criterion: landing succeeds + that region's audit table has `entry=modeling-land`; 🔴 **not a single jurisdiction word may appear in a refusal reason** (otherwise we are back at the withdrawn "blocked by residency gate" state) |
| 🆕 **The "🧱 dimension / fact" row** (added in revision 2.32) | The same four states as above | 🔴🔴 **This row and the code-table row are two halves**: what it pushes is **pure DDL** (not a single DML statement) ⇒ it **does not need** the narrow-privilege writer; all it lacks is a new admin template `land-model-table` ([the specification](./multi-region-execution-spec.md), section 3.9d.6). **Closing only the code-table half ⇒ this row stays ⊘ ⇒ the fifth state has not disappeared**. Its own acceptance criterion applies |
| **The checkbox** | From "cannot be checked" to **checkable** | 🔴 Only allowed after both rows above have really been run; before that, checking it only writes one more identical record while the user believes "maybe it works if I try again" |

🔴 **The reason must keep being shown until closure**: the `error` text of `credential-gap` must be updated together with the contract —
from "that channel is a leftover of the project-isolation construction, not delivered to this day" to "**this region has not yet been provisioned with a shared-writer identity**", with a way forward,
otherwise what the user reads is a sentence that **has already expired** (text whose "conclusion expires" is a failure pattern this codebase has fallen into repeatedly).

⚠️ **Honestly recorded**: once the shared-writer channel work is complete, `⊘ no write channel` **can never be constructed again** (non-home can always write).
Following this document's own precedent (`⊘ blocked by residency gate` **withdrawn** as a whole state), at that point the **positive criterion for this cell disappears and the negative criterion must be re-judged along with it** —
a criterion that "can never be verified" must not be left hanging there as debt.

## 4quater. 🆕 Scenario 6: cross-region one-screen read-only metadata overview (differentiator B; [the specification](./multi-region-execution-spec.md), section 3.13)

> All comparable products (including the major cloud data-development suites) **can only view assets / lineage / quality in a single region at a time**; we provide a **central cross-target read-only metadata overview** (a read-only mirror per target, **zero data egress**) — this is a point where we go beyond, but **"metadata panorama ≠ cross-region result aggregation" must be made clear**, otherwise users assume they can query data across regions.

- **Entry**: the data map / lineage / asset inventory get an "**All targets**" view at the top (alongside the existing "current target" view), following the monitor filter convention of section 6.1.
- **Presentation**: faceted by target (columns / color blocks); each target shows the asset count, lineage edge count, quality score and sensitive hits; clicking a target drills down → enters that target's view (the data still goes through that region's data plane, section 4bis).
- 🔴 **Honest boundary (constitution A4)**: the page carries a permanent label **`Metadata mirror · last synced <mirroredAt>`**; the mirror is **eventually consistent** and **contains no result rows**; if a target's mirror is stale / failed → that facet is marked `⚠️ mirror stale (last synced 2h ago)` with [Sync now]; **a stale mirror is never passed off as real time**.
- **Expressing data referenced across targets (after the shared-catalog grouping pattern of leading lakehouse products)**: if one target's data is explicitly copied / referenced by datashare into another target, the catalog shows a **separate group + a `Read-only · from <target>` type label**, so that "this one lives in another region and is a reference, not a copy" is understood at a glance.
- **Not done**: cross-target result aggregation / cross-region JOIN (settled in section 4bis.3: to merge, go through an explicit copy job + approval).

**Wireframe (cross-region one-screen overview):**
```
┌─ Data map                                [View: All targets ▾] [Type ▾] [Project ▾] ─┐
│ 💡 Cross-region [metadata] panorama (no data rows); click a target to drill into its data (the data stays in that region) │
├─────────────────────┬─────────────────────┬─────────────────────┬────────────────────────────┤
│ tgt-use1-home       │ tgt-usw2-a          │ tgt-euw1 🌍         │ Total                      │
│ Assets 1,284        │ Assets 312          │ Assets 96           │ 1,692                      │
│ Lineage edges 3,411 │ Lineage edges 622   │ Lineage edges 141   │ 4,174                      │
│ Quality 92          │ Quality 88          │ Quality — (not run) │ —                          │
│ Mirror 3 min ago ✓  │ Mirror 5 min ago ✓  │ ⚠ Mirror 2h ago     │ [Sync now]                 │
└─────────────────────┴─────────────────────┴─────────────────────┴────────────────────────────┘
  ⓘ The metadata mirror is read-only and eventually consistent; cross-target results are not aggregated here (to merge, use an explicit copy job)
```

### 4quater.1 🔴 Presentation rules fixed at implementation time (revision 2.14)

> The wireframe above is the design draft. At implementation time four things had to be written down explicitly; otherwise what gets built **looks** as if it satisfied the wireframe while actually lying.

| Item | Decision | Why |
|---|---|---|
| **The two views are mutually exclusive, not side by side** | One dropdown at the top of the governance page, "View: current target / All targets (read-only metadata)"; selecting "All targets" **replaces** the tabs below it | Below the current-target view everything is a **single-region read-write surface** (click a table to see its data, run quality checks, change classification). Putting them side by side suggests "I can click in and change classification in the All-targets view too", and that has to wait for the governance page to become per-target |
| 🔴 **Metrics that cannot be collected are written honestly as "Not collected" + the reason, never filled with 0** | The three items **lineage edges / quality score / sensitive hits** in the wireframe **cannot be collected at all** in this iteration (none of them has a **target dimension** centrally; see [the specification](./multi-region-execution-spec.md), section 3.13 ②) ⇒ every such cell shows "Not collected" with the reason and the piece of work it belongs to (the axis B construction batch); 🔴 **and there is no "Total" either** (adding three dashes up into a 0 is inventing a number) | Constitution A4. An invented 0 is far more dangerous than a "Not collected" — the former looks like "this region is very clean". The three items assets / databases / columns are **real** (taken from that region's Glue catalog) |
| **Five states instead of "stale / not stale"** | The facet is marked `✓` / `⚠ mirror stale` / `⚠ mirror expired` / `— Never synced` / `⚠ last sync failed`; the last four all offer [Sync now] | "Never synced" and "synced but old" must be kept apart on the screen: the former **does not mean that region is empty**, only that we have not looked yet. `⚠ last sync failed` must surface as well — hidden, the mirror would rot all the way to stale before anything is exposed |
| **Viewers read / administrators write** | The overview and the drill-down are **visible to viewers**; [Sync now] [Collect warehouse catalog] are **platform administrators only**; for non-administrators they are **not hidden but disabled, with the reason stated** | A dashboard locked away with administrators is a dashboard nobody looks at (the same criterion as for `/api/exec-targets`); whereas collection really calls that region's APIs, and the warehouse path also wakes up the Serverless warehouse (which costs money) ⇒ it belongs to the management plane. "The worst is not being unable to use it, it is not being able to see why" |
| **The warehouse catalog has its own row and its own timestamp** | "Warehouse catalog (manual collection)" is its own row, with its own state and its own "collected at …"; 🔴 **not folded into the ✓/⚠ above**, and **not folded into the "assets" total** | Mixing them and taking the max produces "Glue 3 min ago ✓" masking "the warehouse catalog was collected manually 3 days ago" = a stale manual collection passed off as real time |
| **Truncation must be visible** | Entries above the cap get a "truncated" tag + the note "this region's real asset count is **greater than** the number above"; a truncated column list of a single table is tagged too | Silent truncation on the screen amounts to "this region has only this much" |
| ⚠️ **The "Read-only · from \<target\>" group has nothing to hang on it in this iteration** | Cross-target reference / copy is, per [the specification](./multi-region-execution-spec.md), section 6.4, **a data-model skeleton only, deliberately not implemented** ⇒ this iteration **does not draw this group**, which is stated in the coverage register; it is added once copying lands | Drawing an empty group first = pretending to have the capability |

**The definition of drill-down (its difference from the wireframe's "click a target to drill down → enter that target's view", honestly recorded)**: in this iteration, drill-down =
**expanding the list of that target's mirrored entries** (databases / tables / column counts / mirror time, read-only). **Clicking a table to see data** still has to wait for the "governance page per target" piece of work
(a later construction batch); clicking in today has no data-plane read path for that target to take ⇒ rather than building an entry that returns 404, the drill-down card says so explicitly.

## 4quinquies. 🆕 Scenario 7: the interaction for draining / three-stage approval validation / fencing ([the specification](./multi-region-execution-spec.md), section 3.5; an item of the independent architecture review)

> Deleting an execution target is upgraded from "approve, then destroy" to **draining → re-validation during the approval period → a third validation before destruction + a fencing epoch**. The interaction must make "why can't I bind tasks to it any more" and "why was I still blocked after the approval passed" understandable.

- **The `draining` status is visible**: the status badge on the execution-environment list / detail gets a new **`draining` (orange, "draining, not accepting new work")**; that target is greyed out in **every** target selector + Tooltip "this target is draining / pending deletion and cannot be bound to new tasks".
- **User visibility of the three validation stages**:
  - Stage one (initiation): mechanism B impact preview (the existing section 1.4).
  - Stage two (during approval): if someone **attempts** to add a binding in the meantime → refused outright with the message "the target is draining"; the approval drawer shows "**validation time + current binding count**", refreshed live (what the approver sees is not a stale snapshot).
  - Stage three (before destruction): if the validation fails at that moment (someone bypassed the front end and inserted a binding) → **abort the destruction**, return the approval to `pending`, and notify the initiator "pre-destruction validation failed: 1 new binding appeared", with a [View / Unbind] exit. **No silent failure, no forced deletion.**
- **The user-facing expression of fencing**: if a stuck old operation later "comes back to life" and tries to write state → the platform discards it and the page shows "a stale operation was detected (epoch mismatch) and ignored; the current state is authoritative" — so that the user never sees the state jump inexplicably.
- **The `failed` state**: a failed build no longer sits in `initializing` indefinitely; it becomes **`failed` + the failing stack + a log excerpt + [Retry]** (F6, recoverable failure).

## 4sexies. 🆕 Scenario 8: per-target alert configuration (operations side; [the specification](./multi-region-execution-spec.md), section 3.12)

> Today's alerting **lumps the runs of all targets into one number**; a region that has stalled is averaged away by the healthy regions and never alerts. The interaction must make "alert per region" configurable, and safe by default.

- **The alert-rule form gets a "Target scope" field**: `All targets (evaluated per region)` / `Specific target`; 🔴 **default "All targets (evaluated per region)"** — that is, **each target computes its own success rate / no-run**, instead of one merged number (the default itself removes the "averaged away" trap; users need not understand the principle).
- **New rule type "regional no-run"**: alert when a target has **zero runs** within the window (the current `no-run` never fires in merged mode).
- **Alert events carry the target**: the first line of the alert list / notification body is `[tgt-usw2-a]`, so the region is obvious at a glance; the event detail drills into that target's run list.
- **Baselines / SLA per target**: SLA targets support "set separately per target" (a slow region can get a wider threshold), defaulting to inheritance from the project level; baseline learning **pools per target** (p50/p90 are never mixed across regions).
- **Masking of notification content**: the run error text of a cross-jurisdiction target is **masked** in notifications (or goes through that region's channel); no in-region data fragments are sent out through the central channel ([the specification](./multi-region-execution-spec.md), section 3.12).

## 4septies. 🆕 Scenario 9: warehouse direct query "multi-region parallel + one result sheet per region" (the interaction decided on 2026-09-04)

> - **Origin**: the requirement as stated — "with multi-region execution, the result display should also use multiple sheets; switch sheets to view the data returned by the different regions"; with a key constraint added — "each region's execution efficiency differs and the return time differs, so
>   always waiting for all of them to return before showing anything may be inappropriate. A region may also fail during execution (no such table, permission problem …); in that case show the error in its corresponding sheet".
> - **Place**: the warehouse direct-query page (`/redshift`) and the Athena query page (same structure). **⚠️ Honestly recorded: this section is a new design added on 2026-09-04; before it, section 4 covered only "switching region in Ask-Your-Data", and multi-sheet + progressive return for direct
>   query had never been designed.**

### 4septies.0 🔴 No contradiction with "Ask-Your-Data does not run in parallel" (the boundary is written first, so that nobody later believes it was forgotten)

It had been decided earlier that "**Ask-Your-Data** executes in a single region, not in parallel, with that region's model" (section 4). This section is about **direct query**:

| | Ask-Your-Data (GenBI) | Direct query (Redshift / Athena) |
|---|---|---|
| Parallel across several regions? | **No** (decided) | **Yes** (this section) |
| Reason | Ask-Your-Data must use **that region's model**; parallel = two regions, two models, two sets of semantics, and the answers cannot be reconciled | Direct query is **read-only with no model involved**; one SQL against several regions is exactly the hard requirement for "compare the data of each region" |

⇒ The difference between the two interfaces is **intentional**, not an omission.

### 4septies.1 Core principle: **each sheet has an independent lifecycle and does not share one loading state**

This is the direct implementation of that constraint. The opposite approach (one global spinner waiting for all regions to return) has three concrete harms:
① the slowest region determines when the whole screen becomes usable; ② one failing region leaves the whole screen without results; ③ the user cannot tell "still running or hung".

**Submission and result fetching are separated** (the Redshift Data API is asynchronous anyway: submit → `statementId` → poll):

1. `POST /api/redshift/execute` accepts **`targets: string[]`**, **only submits** for each target, and returns immediately
   `[{targetId, region, workgroup, database, statementId?, submitError?}]` — **it waits for none of them**.
2. 🔴 **Submission itself may already fail** (the target has no `redshift` installed / the per-project credential is missing / place conflict / cross-jurisdiction gate);
   that row carries `submitError` ⇒ the corresponding sheet shows the error **immediately** and **does not enter polling** (it is not allowed to pretend "running").
3. **Each sheet polls its own `statementId`** (`GET /api/redshift/statement?targetId=&id=`).
   Polling stops at a terminal state; the other sheets continue. **Whoever returns first can be read first.**
4. **Concurrency cap** (at most 8 regions at once): N regions = N times the cost and N connections; one click must not quietly enlarge the blast radius;
   the button states the region count (`Execute (2 regions)`), the same convention as "Run now (once in each of 2 regions)" in Batch Compute.

### 4septies.2 Sheet state machine + focus rule

Each sheet's tab title **carries its own badge**, so whether it succeeded is known without opening it:

| State | Tab title example | Notes |
|---|---|---|
| Submitting | `us-west-2 ⏳ Submitting` | the statementId has not been obtained yet |
| Running | `us-west-2 ⏳ Running 12s` | 🔴 **shows the elapsed time**, so that "slow" and "hung" can be told apart |
| Has results | `us-west-2 ✓ 1,204 rows · 0.8s` | |
| Failed | `us-west-2 ✗ Failed` | the error is shown in place inside that sheet |
| Timed out | `us-west-2 ⏱ Timeout` | see section 4septies.4 |

🔴 **Focus is taken only once**: the first sheet to enter "has results" **is activated automatically, once**, and after that focus is **never taken again**.
Otherwise a user who is reading the us-east-1 table is switched away when us-west-2 returns — more infuriating than waiting for all regions.

### 4septies.3 Errors shown in place (explicitly requested) + three mandatory parts

One failing region **never affects the other sheets** (🔴 **the opposite of "publish push-down"**: a push is a **write** and must fail fast and stop on error;
direct query is **read-only** and the results of the other regions are just as valuable ⇒ **no fail-fast** here). Inside that sheet it shows:

1. **The original Redshift / Athena text** (e.g. `relation "public.orders" does not exist`) — not rewritten, not swallowed;
2. **The platform's classification + where to fix it**: `table does not exist` / `insufficient permissions` / `target not ready` / `place conflict` / `missing credential` / `timeout`,
   with one actionable suggestion per class (e.g. "this table has not been synced to this region yet ⇒ go to Data Sync and create a task to this target");
3. 🔴 **The place of that region**: `region · workgroup · database · execution identity form`.
   The first question in multi-region troubleshooting is always "what did I actually hit"; without these three you can only guess.
   **Only the identity form is given** (`per-project` / `shared-admin`); 🔴 **never the secret ARN / user name** (it would end up in screenshots and browser history).

### 4septies.4 Timeout: results are kept, only that one region is cancelled

- Each sheet has an **independent timeout** (default 5 minutes). On timeout the existing content is **not cleared**; it shows
  `⏱ Timed out; it may still be running in the background` + [Keep waiting] [Cancel this region].
- [Cancel this region] = `CancelStatement`, 🔴 **cancels only this one target's statement**; the other regions are not dragged along.
- 🔴 **Timeout ≠ failure**: the wording must distinguish them. Writing "failed" makes people think the SQL is wrong, when the truth is usually that the region is slow or the data volume is large.

### 4septies.5 The "⚖ Compare" sheet (the first tab) — added by the designer, because differences cannot be seen by clicking back and forth

The most important information across N sheets is **their differences**, and spread over N tabs that requires people to memorize numbers. So the first tab is a side-by-side comparison:

```
┌ ⚖ Compare ─────────────────────────────────────────────────────────────────┐
│ Region      Status                  Rows     Duration  Column signature       │
│ us-east-1   ✓                       1,204    0.8s      region,count   ← baseline │
│ us-west-2   ⏳ Running 12s           —        —         —                      │
│ eu-west-1   ✗ table does not exist  —        —         —                      │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Progressive fill**: rows / duration show `—` first and are filled in one by one as each returns.
- 🔴 **"Column signature mismatch" is judged only after all have reached a terminal state** — judging midway necessarily raises false alarms (most regions have no column signature yet at that point).
  This is the same discipline as section 2bis.4 "false alarms kill a dashboard".
- Baseline = **the first region to return successfully** (not home: home may fail too; the baseline must be the one that really has a column signature).

### 4septies.6 🔴 Results are **never merged automatically**; merging must be explicit (revision 2.17: cross-jurisdiction is **available**, the query is audited)

- A [Merge into one table] **explicit action** is provided; 🔴 **correction in revision 2.17**: the former "when a cross-jurisdiction target takes part, the button is disabled + Tooltip" is **withdrawn** ([the design document](./multi-region-execution-design.md), section 18, decision 6quinquies: no legal gate) — when a cross-jurisdiction target takes part the button is **available**, and the merged result header carries the audit ids of each sheet (section 4bis.3).
- "Never merge **automatically**" is unchanged: side-by-side sheets remain the default form; merging must be the user's explicit action.
- Export: **per sheet**, the file name carries the target segment; a merged export is equally available and equally audited.

### 4septies.7 Navigating away and coming back (reusing the already-specified query-handle table)

`(targetId, statementId)` is written to **`bgp-query-handles`** (finalized in [the specification](./multi-region-execution-spec.md), section 1.3a: `handleId(PK)`,
`statementId`, `targetId`, `projectId`, `ownerSub`, `jurisdiction`, TTL≈36h) ⇒
a user who navigates away from the page and comes back can **keep pulling the results** without re-running (re-running = paying once more).

🔴 On read-back `ownerSub` and `projectId` must be verified; a handle is not a credential, and someone else's handleId cannot be used to fetch results.

### 4septies.8 Headless acceptance essentials (red line: page-level + assert on the real state source)

1. One SQL against two regions ⇒ **two sheets**, each tab title carrying its own row count / duration;
2. 🔴 **The fast region returns first**: construct one slow region (e.g. `SELECT pg_sleep(20)`) + one fast region, and
   assert that the fast region's sheet is **already readable** while the slow region is still `⏳ Running` (this item is the executable criterion for that constraint);
3. 🔴 **A failing region does not drag the others down**: query, in one region, a table that exists only in another region ⇒ that sheet shows the three error parts, the other sheets return results normally;
4. Focus is taken only once: when the slow region returns, the current tab **does not change**;
5. Compare sheet: the "column signature mismatch" warning **is not shown** before all terminal states; after that, differing columns are marked red;
6. When a cross-jurisdiction target takes part, [Merge into one table] is disabled and the reason is shown;
7. After a page refresh, the results can still be pulled from `bgp-query-handles` (no re-run).

## 5. Master table of safety interaction mechanisms (4 mechanisms × high-risk operation matrix)

The four mechanisms, all of which were selected, are applied to every high-risk / sensitive operation (✅ = mandatory, ➖ = not applicable):

| Operation | A Double confirmation | B Impact preview | C Tiered permissions + approval | D Visual isolation of the danger zone |
|---|---|---|---|---|
| **Delete execution environment** | ✅ Type the region name (the new strong-confirmation tier of section 6.2) | ✅ Pre-check of bound resources / schedules / run counts; > 0 ⇒ deletion forbidden | ✅ Initiated by an admin (mechanism C, narrowed in revision 2.4) + `bgp-approvals` approval + hard refusal for home | ✅ Data bucket RETAIN stated explicitly in red |
| **Cross-region batch push** | ✅ When the number of regions ≥ threshold / a production region is included | ✅ Push preview (artifacts / buckets / estimate) | ✅ Pushing to a protected region = isomorphic to promotion approval (section 6.1) | ✅ Prominent color for production regions |
| **Revoke GRANT ALL (linked with [the project-isolation design](./project-isolation.md))** | ✅ | ✅ List the affected tables | ✅ admin | ➖ |
| **Region specialization / cancel specialization** | ✅ Cancel specialization (changes are lost) | ➖ | ✅ Explicit administrator operation | ✅ Specialization corner badge |
| **Re-push to one region** | ➖ (single region, lightweight) | ✅ Preview of that region's artifacts | ✅ editor+ | ✅ Red / yellow cell hint |
| **New execution environment** | ➖ | ✅ Naming preview + cost estimate | ✅ admin (mechanism C, narrowed in revision 2.4) | ✅ Home corner badge for distinction |
| **Set authorized projects (target allow-list, revision 2.17)** | ➖ | ✅ List the projects that will lose visibility + the number of tasks they have bound | ✅ bgp-admin (`POST .../access`, audit `exec-env.access.set`) | ✅ The "Authorized projects" card on the detail page |
| **Register a cross-jurisdiction execution environment (revision 2.17)** | ✅ Tick the disclaimer acknowledgement (cannot register without ticking) | ➖ | ✅ admin; the consent is written into the descriptor as `residencyAck` and can be looked up later | ✅ 🌍 neutral jurisdiction label (not a danger color) |
| **Switch Ask-Your-Data region** | ➖ (switching region prompts a new session) | ➖ | ➖ | ✅ Current region prominent |

- **Unified convention for mechanism D, visual isolation of the danger zone**: production regions use a prominent color + a corner badge (following the Header `envColor` convention; prod is red); for any **cross-region write / execute / delete** operation, the region currently being acted on must be highlighted at the top of the operation area, eliminating "wrong region".
- Alignment with the design document: the approval of mechanism C reuses `bgp-approvals` (type=exec-env-delete) and promotion approval from [the design document](./multi-region-execution-design.md), section 4.4; mechanisms A / B are front-end gates added by this interaction chapter and do not change the back-end security model (the back-end IAM / guards remain the final line of defense; the front-end gates only "stop mistakes earlier + let people see the consequences clearly").

## 6. Anchors in existing interaction conventions (confirmed by investigation, all 🔵 file:line)

Design principle = **reuse existing conventions as far as possible, so that multi-region looks like a native platform feature**. Findings of the investigation:

### 6.1 Strong anchors that can be used directly (6 of them, zero new paradigms)

| Multi-region interaction | Existing convention reused | Evidence |
|---|---|---|
| **Target switcher** | The Header's **environment switcher** (`envColor` color mapping + Select + colored Tag + Tooltip) can be **copied as-is in visuals and controls**; 🔴 **but the source of the scope was corrected in revision 3.0 (an item of the independent architecture review)**: `targetId` **does not take localStorage as its authority** — it must be carried by the **URL / the resource's identity** (e.g. `?target=tgt-usw2-a`, or a resource detail page carrying its own bound target), and **cross-validated by the server against the resource being operated on**; localStorage stores only a "default preference". Reason: when several browser tabs each open a different target, a global value gets crossed between them, and in-flight requests from an older page would be redirected by the new global value (acting on the wrong region). The `x-bgp-region` header serves only as a **routing and audit label, not as an authorization criterion** (authorization goes through RBAC × target and the queryHandle) | `components/layout/Header.tsx:24-29,131-140`; `lib/projects/constants.ts:29,35` 🔵 |
| **Cross-region / production-region deployment = promotion + approval** | The `PromoteButton` Dropdown + the "protected target → createApproval pending" gate of `promote-service` + the inbox on the projects page; adding `type:"region-deploy"` hooks it into the existing inbox; the approval data model (type/payload/status) is already generic | `components/common/PromoteButton.tsx:38-46`; `api/promote/route.ts:38-52` 🔵 |
| **New-environment wizard** | SyncTaskModal's `Steps + single Form with preserve + display:none step switching + validateStep + submit on the last step`; the part with "test / health probe" follows DataSourceModal's last step "test connection + Result receipt"; `NetworkAdvisorPanel` can be embedded for a cross-region network pre-check | `sync/SyncTaskModal.tsx:154,167,616`; `datasources/DataSourceModal.tsx:216,537-592` 🔵 |
| **Region filter on lists** | monitor's `filters state + buildQuery + a row of Space wrap controls inside a Card + Tabs grouping`; **adding one `region` `Select allowClear`** fits right in (alongside the existing taskType/status) | `monitor/page.tsx:24,26,144-161` 🔵 |
| **Region health / deployment progress** | settings' **parallel fetch of every endpoint + three-state statusIcon + one colored Tag per line**; or the `VerdictBadge` multi-state badge; progress via `setInterval` 10s polling + `Badge`/`Descriptions`/`Row+Col+Card+Statistic` | `settings/page.tsx:21-61,65`; `sync/[id]/page.tsx:118-131`; `network-advisor/VerdictBadge.tsx:13-29` 🔵 |
| **Consequence explanation and confirmation for high-risk operations** | `realtime-compute`'s `askDecision`: `Modal.confirm({width:620, okButtonProps:{danger:true}})` + a Collapse "why" + an Alert "what happens after you confirm" + "other options to consider"; the code comment explicitly records "major decisions must be confirmed by a human (a stated red line)" | `realtime-compute/page.tsx:547-555,1058` 🔵 |

### 6.2 Parts that existing conventions do not cover and that need new design (5 of them — this is where the "a lot of time" really goes)

| Gap | Current state | What multi-region needs designed anew |
|---|---|---|
| **A global aggregated view along the region dimension** | env is only **switched** in the Header; list filters **have never had an env/region dimension**; every page is "switch, then look at a single scope" | Scenario 3's **one-screen version matrix / cost comparison across all regions** is a brand-new aggregated view (not a single view after switching) and needs a new component |
| **Peer multi-region / primary-standby topology** | env is a **linear promotion chain** dev→staging→prod (`PromoteButton.tsx:12 ORDER`); there is no concept of "several peer regions + primary/standby" | The **region topology visualization** of a single control plane × multiple execution planes (which one is the home control region, the execution regions as peers) needs a brand-new component |
| **Strong confirmation tier (type the name before you can delete)** | The strongest available tier is Modal.confirm rich text + a danger button; **there is no "the confirm button activates only after the resource name is typed"** | The **mechanism A type-the-region-name double confirmation** for deleting an environment in scenario 1 is a new interaction (the consequences of deleting a region are too heavy; the existing tiers are not enough) |
| **Target-level RBAC** | Permissions are "workspace × environment", with no region/target authorization dimension | 🔴 **Changed in revision 3.0 to be done in the first iteration** (decided on 2026-08-28: "do everything in the first iteration"; the earlier "listed for the second iteration" is withdrawn): the authorization axis is extended to **project × environment × `targetId`**, `guard.ts` gets `requireTarget(min, targetId)`, a new **regional administrator** role is added, and indiscriminate push-down to arbitrary cross-jurisdiction targets is forbidden ([the design document](./multi-region-execution-design.md), section 19.3 / [the specification](./multi-region-execution-spec.md), section 3.12). UI: member management gets an "operable targets" assignment; on push-down / region switch, targets without permission are greyed out + an F8 explanation. 🔴 **Correction in revision 2.17**: the first-iteration form = **project allow-list** (the "Authorized projects" card of section 1.7; settable on any target, default all projects, no special treatment of cross-jurisdiction); the regional administrator role / `requireTarget` → a later construction batch; "forbid indiscriminate push-down to arbitrary cross-jurisdiction targets" is withdrawn (no legal gate) |
| **Data sovereignty / compliance notices** | Alert notices exist only for network / billing; there is no data-residency / compliance paradigm | ✅ **Settled (section 4bis rewritten in revision 2.17; [the design document](./multi-region-execution-design.md), section 18, decision 6quinquies)**: **no legal gate** — a cross-jurisdiction target follows the same path as a same-jurisdiction one; the platform only provides a **disclaimer + retained consent** (at registration + once per user, enforced server-side, retrievable later) and **auditability** (audit id visible; full audit in the region + central summary); the former wording "informed confirmation + liability + cross-jurisdiction merge requires approval" is withdrawn |

**Key fact**: a grep for `region` across the whole UI layer hits only back-end `new XxxClient({region})` calls and the data sources' own region input fields — **there is no front-end interaction at all along a "platform multi-region" dimension**. Multi-region is a brand-new dimension for the front end, but the 6 anchors of section 6.1 are enough to make it land "like a native platform feature".

## 7. Interaction-layer risks and acceptance

### 7.1 Interaction-layer risks (distinct from the back-end risks in [the design document](./multi-region-execution-design.md), section 14bis; these are mis-operation risks at the human–interface level)

| # | Interaction risk | Trigger | Interaction-layer mitigation |
|---|---|---|---|
| IX-1 | **Wrong region** (thinking you operate on A while actually hitting B) | region is a new dimension and can be switched in many places | Mechanism D: the region currently in effect is prominently displayed throughout; cross-region write / delete operations highlight the region at the top of the operation area; production regions in a prominent color |
| IX-2 | **A region is missed yet the push looks successful** (partial push) | Serial fail-fast region by region; a failure in one region is overlooked | Scenario 3's version matrix highlights inconsistencies + red cells; push progress shows an explicit result per region; this is the customer's core pain point, a first-class citizen |
| IX-3 | **Mass accidental delete / revoke** (deleting an environment, revoking GRANT) | Convenient operations with heavy consequences | Mechanism A typed-name strong confirmation + mechanism B impact preview + mechanism C approval; data buckets are RETAINed on deletion |
| IX-4 | **Forgotten specialization drift** (after a region is specialized, updates to the main definition no longer follow it) | Region specialization is "controlled drift" | The specialization corner badge is always visible; annotated in the version matrix; cancelling the specialization can roll back |
| IX-5 | **Runaway cost without noticing** (opening many regions / components burns money) | Each region's MWAA+NAT ≈ $400+/month | The creation wizard shows the estimate as components are ticked; region is the first level of the cost page |
| IX-6 | **Data sovereignty / compliance** (revision 2.17: the customer's responsibility — the customer makes its own legal decision at the moment it registers a cross-jurisdiction target) | Cross-jurisdiction regions | ✅ **Settled (section 4bis in revision 2.17; [the design document](./multi-region-execution-design.md), decision 6quinquies)**: disclaimer + retained consent + full audit (full in the region / central summary / cannot be altered or deleted); the former wording "informed confirmation / refusal by regional computation / hard residency" is withdrawn; in-region masking and executing close to the data → an optimization for a later construction batch |

### 7.2 Headless acceptance essentials (following the project red line: assert the DOM through CloudFront + assert the real state source)

- [ ] Creation wizard: **walk through the 3 steps**; clicking "Start deployment" in step 3 triggers a **platform StartBuild** (fully automated CodeBuild deployment), writes a registry item with status=registered (hard evidence in DynamoDB) + the build is triggered + the progress view refreshes live; a failure can be retried in place.
- [ ] Region binding is safe by default: the region multi-select of a new task ticks only home by default; when no non-home region is ticked, behavior is identical to today (regression).
- [ ] Push preview: bind 2 regions and publish → a preview pops up listing the artifacts of both regions → after confirmation the push proceeds region by region and the page shows each region's own result (hard evidence: the successful region's DAG bucket has the artifact, and the baked values are that region's own).
- [ ] Version matrix: deliberately make one region's push fail → a red cell in the matrix + one-click re-push recovers; version mismatch → the row is highlighted yellow.
- [ ] **The four gates for deleting an environment** (asserted one by one): the entry is invisible to non-admins / the API returns 403 (mechanism C); deletion is forbidden while bound resources exist, with the details listed (mechanism B); the confirm button is disabled until the correct region name is typed (mechanism A); home has no delete entry (hard refusal); deletion goes through an approval ticket (`bgp-approvals` has an exec-env-delete record); data buckets are RETAINed.
- [ ] Switching region in Ask-Your-Data: select region B → that session queries B's workgroup (hard evidence in CloudTrail / logs) + uses the model configured for B; switching region prompts a new session; the current region is prominently visible.
- [ ] Danger-zone visuals: the prominent color / corner badge of production regions is really rendered; the top of a cross-region operation area highlights the current region.
- [ ] `bgp-audit` has records throughout (create / delete / push / specialize); the contract regression check reports zero FAIL.
- [ ] 🆕 **Section 4ter, modeling push-down**: bind a code table to 2 targets → two `✓` rows in the landing panel; deliberately pre-create a heterogeneous table of the same name in one of them → that row shows 🔴 `drift` (**not ✓**) + has [View diff]; a cross-jurisdiction target row follows **the same path** as a same-jurisdiction one (revision 2.17: `⊘ gated` is withdrawn); the landing action has `entry=modeling-land` in the regional audit table; the modeling row **appears in the Multi-Region consistency matrix**.
- [x] 🆕 **Section 4quater, one-screen overview** (✅ closed out: headless-browser acceptance in a real environment, **14 items, 0 failures**, folded into the acceptance gate): the "All targets" view lists every target's **assets / databases / columns** counts (🔴 the three items lineage / quality / sensitivity honestly show "Not collected" — there is no target dimension centrally, see section 4quater.1); the page shows `mirroredAt`; artificially expire one target's mirror → that facet shows `⚠ mirror stale` + [Sync now] (**an old mirror is not passed off as live**); the overview **contains no result rows** (assert that the response body carries no data rows); in addition: a failed collection keeps the last successful timestamp, and the scheduled glue refresh does not wipe a manually collected warehouse catalog.
- [ ] 🆕 **Section 4quinquies, draining / three-stage validation**: after deletion is initiated the target is greyed out in **every** selector; an attempt to add a binding during the approval period **is refused** and the binding count in the drawer **refreshes live** (not a stale snapshot); insert a binding before destruction → **destruction aborted + the approval ticket returns to pending + an unbind exit exists** (no silent failure / forced deletion); a failed build shows `failed` + [Retry] (it does not stay in initializing).
- [ ] 🆕 **Section 4sexies, per-target alerts**: a new rule defaults to "All targets (evaluated per region)"; stall one target → **the alert really fires** and the first line of the notification body carries `[tgt-…]`; the health of the other targets during the same period **does not mask** that alert; the error text of a cross-jurisdiction run is **masked** in the notification.

### 7.3 Alignment with the implementation phases

- The interaction lands together with the back-end phases: the first implementation phase (minimal closed loop of a second region) delivers the **creation wizard + health probe + canary + region health** first (most of scenario 1); the next phase delivers **region binding / push preview + version matrix + the four gates of deletion approval** (scenarios 2 and 3 + the safety mechanisms); the following phase delivers the **Ask-Your-Data region selector + region as the first level of cost** (scenario 4).
- 🔴 **Target-level RBAC (gap ④ of section 6.2) was changed in revision 3.0 to be done in the first iteration** (decided on 2026-08-28: "do everything in the first iteration"; the former "not in the first iteration, listed for the second" is withdrawn): authorization axis project × environment × `targetId`; interaction in section 4ter (operable-target assignment).

---

## 8. Friendliness & convenience design (where the emphasis on "reasonable, friendly, convenient" lands)

Safety (section 5) solves "nothing goes wrong"; friendliness and convenience solve "people want to use it and it feels smooth". Multi-region is a brand-new dimension with an inherently heavy cognitive load; without friendliness work, operators will feel it is "complicated, better not touch it". Every item below is anchored in **existing platform components / conventions**; no new paradigm is invented.

### 8.1 Seven friendliness rules (each = the component it lands on + the concrete multi-region practice)

| # | Friendliness principle | Existing convention reused | Concrete multi-region practice |
|---|---|---|---|
| F1 | **Every page carries its own "what is this / how to use it"** | `FeatureGuide` (a collapsible "purpose + steps + tips" card, already used on finops/backfill/modeling; `components/common/FeatureGuide.tsx` 🔵) | One card each at the top of the execution-environment page and of the multi-region dashboard: one sentence stating "manage execution environments in several regions" / "see push consistency across all regions on one screen", 3–4 steps, tips covering the cost / deletion-approval essentials |
| F2 | **Empty states offer the next step, never a blank** | `<Empty description="No X yet; go to Y to create one">` (etl-jobs:296,332 🔵) | When only the home environment exists: `<Empty description="Only the home region exists; click 'New execution environment' at the top right to add other regions">` + a direct button. The same guidance when the dashboard has no multi-region tasks |
| F3 | **Defaults are the most common choice** | The existing form-default convention | Creation wizard: the region dropdown defaults to the first available region, components default to core only; task region binding defaults to home only; the Ask-Your-Data region defaults to home. The "most common choice" costs zero clicks |
| F4 | **Help right next to error-prone spots** | `Tooltip title=` (beside form fields; used extensively in DataSourceModal 🔵) | A Tooltip beside the component checkbox explaining "mwaa = scheduled orchestration capability, about $350/month"; one beside the region name explaining the naming rule; hovering the "specialized" badge explains "detached from the shared definition" |
| F5 | **Operations give immediate feedback; long operations show progress** | `message.success/error` + `setInterval` polling + `Badge`/`Statistic` (section 6.1) | Push / health probe / canary all show step-by-step progress (not a spinner you wait on); when the push completes, `message.success("Pushed to 3 regions")`; failures name the exact region |
| F6 | **Failures are recoverable; no half-dead state** | reconcile-on-read fallback (an existing platform pattern) | Partial push failure → a red cell on the dashboard + one-click re-push **only for the failed regions** (the successful ones are not pushed again); interrupted environment initialization → the detail page offers "re-probe / retry", no need to delete and recreate |
| F7 | **Jump from where you are; less hunting back and forth** | Deep links between pages (governance's `?tab=` 🔵) | "Resolve" on a red dashboard cell goes straight to that task's editor; clicking "bound task count" on the environment detail = that region's task list; the cost card drills down into that region's details |

### 8.2 Convenience: lowering the cognitive burden of "multi-region = multiplied operations"

The biggest convenience risk of multi-region = **"N regions means doing it N times"**. The design presses it down with three levers:

- **Define once, take effect on many targets** (the core of convenience): a task binds **`targets[]`** (corrected in revision 2.2: formerly written `regions[]`; [the specification](./multi-region-execution-spec.md), section 1.3a, item S1, settles `targets?: string[]`); one definition is changed once and takes effect on all targets ([the design document](./multi-region-execution-design.md), section 5.1, single definition with multiple bindings), rather than maintaining one copy per region — this is in itself the convenience answer to the customer pain point "N copies, afraid of drift".
- **Batch operations backed by impact preview**: multi-select regions and push once; one-click "re-push all inconsistent items" on the dashboard; but convenience does not run bare — every batch action first passes the impact preview (section 5, mechanism B), fast yet under control.
- **One-screen overview instead of switching one by one**: the multi-region dashboard (scenario 3) lets operators **avoid switching region by region to look**; the version matrix shows on one screen which regions are aligned / missed — a direct response to "afraid of missing a region so that the data no longer matches".

### 8.3 Friendliness acceptance (supplementing section 7.2)

- [ ] The FeatureGuide at the top of the execution-environment page / dashboard exists and its content is accurate (purpose / steps / tips).
- [ ] A fresh environment (home only) has guidance text in its empty state + a direct "New" button, not a blank page.
- [ ] The creation wizard's defaults are reasonable (core ticked by default, region defaults to the first); a task's regions default to home only.
- [ ] After a partial push failure, "one-click re-push" re-pushes only the failed regions (without affecting the successful ones); after the re-push the dashboard turns green.
- [ ] Key error-prone items have Tooltips (component cost / naming rule / meaning of specialization).

## 9. 🆕 Decided in revision 2.15: the top-bar "Execution scope" — every single-region page can switch it, with three more guardrails than AWS-style region switching

> **Decided on 2026-09-05** (as stated: "later we also need an interface function like switching region in AWS … every single-region page should be a page that can be switched"
> + "evaluate whether there is a better interaction experience than that; refer to the leading cloud data-development and lakehouse platforms" + "tasks created in the home region and pushed to several regions become related to each other").
> The candidates and the fact ledger are recorded in the planning notes that preceded this decision (③ information architecture / ④ three contract clauses / ⑤ RunGroup / ⑪ six supplements); this section is the **settled contract**.
> Construction is split into four work items — the execution-scope foundation / the RunGroup / per-region cost / data-source placement — scheduled **after the compliance acceptance gate** (route A);
> the data gates (the run's `runGroupId` / the stamp on cost rows / the data source's `ownerTargetId`) were delivered first, as the three entry tickets of that gate ([the specification](./multi-region-execution-spec.md), section 1.3a, S6).

### 9.1 Benchmarking conclusion (why it is not "copy AWS")

| Form | Representatives | What we take | What we avoid |
|---|---|---|---|
| Global switch | AWS console · a major cloud vendor's data-development suite | One switch in the top bar, every single-region page follows it, **the scope goes into the URL** | Full-page reload; after switching to the wrong region "things disappear" without any hint |
| Resource attribute + filter | Other hyperscale cloud consoles and their cloud data warehouses | The "All" view = every page can show a cross-region overview, region is a column | N rows mixed together; the default region when creating something is often wrong |
| Container as scope | Lakehouse platforms (workspace as the container) · cloud data warehouses (account as the container) | The selected value is a **targetId** (a container-level identity, not a bare region) | Switching containers replaces the whole context; across containers only an account-level usage table remains |
| Primary–replica replication | Replication groups of cloud data warehouses · deployable asset bundles of lakehouse platforms | "Defined in the home region, instances in each region" + **group-level status** (RunGroup) | Only the CLI / SQL can tell which definition an instance came from |

### 9.2 Control and the three states (carrying forward item ③ of the planning notes)

- The third level of the top bar is `Workspace → Environment → Execution scope`; **it is not called Region**. Options are displayed grouped by region, and **the selected value is always a `targetId`** (one region can hold several accounts / cells; keying by region would cross identities; the same reasoning that made [the model-configuration design](./model-configuration.md) settle on targetId). Each option shows region · target name · jurisdiction · health · component badges.
- Three states `global | target | compare (2–4 targets)`; **every route declares its capability** `global-and-target / target-only / global-only / compare`. Entering a `global-only` page shows "This page belongs to the global control plane and is not affected by the current execution scope", and **does not silently reset the selection**; entering a `target-only` page from the `global` view ⇒ the user is asked to pick a target, **never silently falling back to home**.
- **The URL is the authority**; localStorage stores only the "last selection", isolated by `projectId + env`; after switching project / environment the target is re-validated for visibility, and if it is no longer valid ⇒ **an explicit error, no automatic switch to home**.
- 🔴 `x-bgp-target-id` serves only for observation / as a default hint for GET; it **must never be** the basis for authorization / the basis for residency routing / the sole source of a POST's execution target. Execute · publish · delete must carry the target explicitly in the URL / body / resource definition and the server must re-verify it (`AuthProvider.tsx:64` already injects `x-bgp-project`; injecting the target the same way "while you are at it" is exactly how you step on this).

### 9.3 Six guardrails (added to the decision at the time it was made; each one corresponds to a real pain point of an external product)

1. **Never let the user "lose things"** (the biggest AWS pain point): list pages in the `target` view carry a persistent faint hint at the top "Other execution scopes have N more → View all"; the empty state says outright "us-west-2 has no tasks; home has N" and offers one click to switch to "All".
2. **Write operations restate the target on the button**: "Run now · us-west-2", "Publish to 2 regions"; the confirmation dialog names each region (the "Run now (runs once in each of 2 regions)" from an earlier construction batch is the prototype; after this decision it is unified across the platform).
3. **Instances point back to their definition**: the fanned-out instance cards seen in the `target` view carry "from home-region definition X · v3 · not specialized / 🔶 specialized" (plain region switching would hide the relationship "defined in the home region, instances in each region", which is precisely our difference from AWS; 🔴 "specialized" currently cannot be constructed in a real environment: `specializedFrom` has 0 production writers, and [Specialize to this region] is **a new feature**, not wiring).
4. **Switching scope does not leave the current page and does not reload**; a `target-only` page in the `global` view asks for a selection and does not silently fall back to home.
5. **In the global view one definition is one row, expand to see the per-region instances** (the matrix already works this way; list pages copy it; cleaner than the N mixed rows of the attribute-plus-filter pattern).
6. **`compare` is offered only for cost and the consistency matrix**, limited to 2–4 regions (a differentiator none of the four benchmarked products has; no other page gets a compare state, to avoid every page building its own).

### 9.4 Linked execution = a persistent `RunGroup` parent object (carrying forward item ⑤ of the planning notes)

- The N runs of one multi-region run share one `runGroupId` (**the field was already delivered with the compliance-gate prerequisites**: produced only for multi-region runs, no attribute for single-region runs, enters only as a first-class parameter of the write channel). The parent object is built in the RunGroup work item: `requestedTargets / acceptedTargets / skippedTargets[{targetId,reason}] / failurePolicy / six-state status / idempotencyKey`, view the whole group · cancel the unfinished ones with one click · **retry only the failed regions** · `retryOfRunGroupId` chains repair runs.
- 🔴 **The default scope follows the current view**: clicking Run in the us-west-2 view runs only that region by default; in the "All" view it defaults to a linked run across **all bound regions** (otherwise you get "I only wanted to run one region and it fanned out to three").
- 🔴 `fail-fast-submit` expresses only "stop submitting further during the submission stage"; it **does not promise a cross-region atomic transaction**; scheduled triggers derive a deterministic idempotency key from `definitionId + scheduledTime + definitionVersion` (belongs to the RunGroup work item; the Python DAG side has to change).
- In the run history **a group row expands into per-region child rows** (the same "one definition, one row" principle as 9.3-5); "partially successful" is a first-class status and is not folded into failed.

### 9.5 Headless acceptance essentials (pinned one by one as the four work items are built)

- Page level: on every page declaring `global-and-target`, switching target changes the data **on the same route**, the URL carries the scope, and after a refresh the page is still in that scope; a `target-only` page in the global view shows "Select an execution scope" and **not** home's data; a deleted target in the URL ⇒ the page shows an error message instead of silently falling back.
- The "losing things" guardrail: in the target view, when N>0 the hint bar **must appear** and the number == the real count in the other regions (assert against DynamoDB, not against the text).
- Button restatement: the button text of Run / Publish / Delete contains the current target's region; the confirmation dialog of a multi-region run names each region and matches the stamps of the runs actually fanned out.
- Negative: tampering `x-bgp-target-id` to another target ⇒ the POST's execution target is unchanged (the server takes body/URL as authoritative).

### 9.6 🆕 Revision 2.22: the route capability matrix (delivered as the first step of the scope-wiring construction batch; contract: [the specification](./multi-region-execution-spec.md), section 2.6.7)

> **Why this table must exist**: `Leaf.scope` is a **mandatory** field (leaving it out turns `tsc` red), so there must be an authoritative table of "what each route fills in";
> more importantly — the first scope-wiring batch wires only **6 pages**, while the platform has **40 page routes** in total (measured: **31** menu leaves in `src/components/layout/routes.tsx`
> + **9** routes that have a page.tsx but are not in the menu tree). **Without this table the remaining 34 pages would silently render as "All"**; a user switching to us-west-2 would see platform-wide data,
> which is worse than the "losing things" that guardrail 1 of section 9.3 prevents — it is **giving the user other regions' things without saying so**.

#### 9.6.0 Four rules (read these first, then the table)

1. 🔴 **A page that is not yet wired must carry a persistent hint bar (the fourth shell of ScopeGate)**: the capability declaration and **whether it is wired** are two different things, so `Leaf` has **two mandatory fields**
   `scope: ScopeCapability` + `scopeWired: boolean`. `scopeWired:false` ⇒ the page renders as usual, but with a **persistent** faint hint bar at the top
   "This page is not yet filtered by execution scope; the data shown covers **all regions**". As each page is wired, flip it to `true` and remove the hint bar (one page, one commit).
   Guard: `capability === "global-only"` ⇒ `scopeWired` is always `true` (a global page needs no wiring and must not carry the hint bar).
2. 🔴 **The single-target equivalence rule** (otherwise single-region users get an extra choice out of nowhere): for a `target-only` page in the `global` view, if the current project has **exactly 1 visible target**
   ⇒ render that target directly, **without the "Select an execution scope" prompt**. This is **not** a silent fallback to home — with only one region, "All" and "that one region"
   are exactly the same set; with **≥2** visible targets a choice must be made explicitly, and in the `global` view no region's data may be rendered (pinned by an acceptance criterion).
3. **Pages where counts are not supported** (warehouse direct query / governance metadata): guardrail 1 **gives no number**, only the [Switch to All] entry — the truth lives in each region's warehouse,
   and counting it would wake every region's Serverless warehouse (one click costs money; [the specification](./multi-region-execution-spec.md), section 2.6.6). Named in the Notes column of the table.
4. **The matrix ↔ code synchronization guard** `scope-capability-guard`: the number of rows in this table == menu leaves + non-menu pages == **40**; one row more or less on either side turns it red;
   a new page must change the code and this table together (this is the only mechanical safeguard against "a new page silently renders as All").
5. 🔴 **Only "fully installed" execution environments appear in the dropdown** (decided on 2026-09-09; as stated: "non-existent / not-installed ones must not appear in the region switcher list.
   Right after the system is installed and initialized there is, in theory, only the home region") ⇒ the list = `listActiveTargets()` ∩ project authorization, the **same two filters** as "can it be bound";
   not fully installed / failed / being taken offline / probe not confirmed / not authorized are never listed. A target hard-coded in the URL that "exists but cannot currently accept work" ⇒ **409 `TARGET_NOT_READY`**
   with the reason stated verbatim, **not silently replaced by another region** (contract: [the specification](./multi-region-execution-spec.md), sections 2.6.5 / 2.6.5a).
6. 🔴 **A refresh does not lose the selection** (decided in the same batch; as stated: "show the region you displayed last time; a refresh must not force a new choice") ⇒ on cold start, if the URL carries no `?scope=`,
   restore the last selection from `bgp-scope:<projectId>:<env>` and **immediately write the parameter back to the address bar** (the address bar and the view are always consistent);
   if the stored target is no longer in the list ⇒ fall back to "All" and **show one explicit notice** (contract: [the specification](./multi-region-execution-spec.md), section 2.6.5b).

#### 9.6.0ter 🔴🔴 Decided on 2026-09-10: **neither banner sentence is acceptable** (rules redone in revision 2.27)

> **Verbatim statement**: "All of these have problems; you must cover every one of them, I do not want to say it a second time:
> `This page is not yet filtered by execution scope; the data shown covers all regions`: Home / Data Sync / ETL Orchestration / Athena Query / Stream Compute / Report Builder / Governance Workbench / Alerting Center / FinOps
> `This page belongs to the global control plane and is not affected by the current execution scope`: Copilot Plan Center / Business Glossary & Rules / Ops Dashboard / Incident Knowledge Base / Workspace / Audit Log"

**What was rejected is not only "not yet wired", but also "declares itself global and therefore need not be wired".** ⇒ The declaration changes from two states to **three**, and every state must **prove itself**:

| State | Mandatory | What the banner looks like |
|---|---|---|
| ① Wired | `wired: true` | No banner (really filtered by region) |
| ①bis Wired but **partially** | `wired: true` + `partial{note}` | 🔵 One persistent line: **which parts are not per-region + why** (since 2026-11-04 without an internal ticket number). 🔴 This state is new in this revision: before, something like "only two of the six tabs are per-region" was written only in the page body, and the next person taking over would certainly miss it |
| ② Not yet wired | `wired: false` + `missing` | 🟡 One persistent line: **what is missing** + "what you see now is all regions". No longer the same sentence on nine pages; since 2026-11-04 the internal ticket number is no longer displayed |
| ③ Truly global | `globalReason` (**a closed reason code**) + `insteadSee` (a real route or `self`) | 🔵 Renders **the reason itself** + "to see it per region, go to ×××". Not being able to come up with a reason code = it should not declare itself global |

**Why reason codes rather than free text**: free text can say a tautology like "this page is global", and the exemption becomes free again.
Narrowed to a closed enumeration, a new page either matches one of the codes (then it really is region-independent) or it does not — and if it does not, **it should be wired**.
In practice this caught `/settings` immediately: it shows the home region's Redshift workgroup / Glue bucket / MWAA bucket / VPC as "Platform Settings" to every region,
and **matches not a single reason code** ⇒ honestly flipped to `wired:false` (tracked as a work item). The same batch uncovered **7 pages** of pseudo-global in total.

🔴 **Ratchet (a mechanical guarantee, not human memory)**: `NOT_WIRED_LIMIT` in `route-scope.ts` is the upper bound on the number of "not yet wired" pages,
and the `scope-coverage-guard` guard asserts that **the actual count equals it exactly**: adding a page without wiring it ⇒ red; wiring a page requires decreasing it by 1 in the same commit (decreasing by more is red too).
Starting baseline **22** (the original 15 + the 7 pseudo-global pages uncovered), **may only be lowered**. At the close of sub-batch A = **16**.

#### 9.6.1 Table A — menu leaves (31 rows, in the order of `routes.tsx`)

| # | Route | Menu name | Capability | Existing region dimension | Wiring batch | Notes |
|---|---|---|---|---|---|---|
| 1 | `/` | Home | `global-and-target` | **Yes** (the tables behind each of the six statistic blocks have it) | ✅ **Wired in the third scope-wiring batch, sub-batch A** | The six statistic blocks each carry `?scope=` (data sources / sync / orchestration / batch / engine jobs / runs) + the persistent hint bar of guardrail 1; 🔴 "Core business metrics" **deliberately does not** — it is a platform-level metric definition (the same object as "Metric" on the modeling page); forcing a region dimension onto it would invent the non-existent concept "one copy of the same metric per region" ⇒ registered structurally via `partial`, not written in the body text |
| 2 | `/copilot/plans` | Copilot Plan Center | `global-and-target` | None | 🔴 **Third scope-wiring batch, sub-batch E** (tracked as a work item) | 🔴🔴 **Re-judged in revision 2.27**: originally written `global-only`, "plans are platform-level" — named as problematic on 2026-09-10. The reasoning holds: the batch jobs / syncs / orchestrations **produced by** a plan all land in specific regions, yet the plan row has no "which regions is this to be configured in" ⇒ users cannot ask per region "which plans are to land in this region". "Each step carries its own target when executed" solves execution only, not **presentation** |
| 3 | `/datasources` | Data Sources | `global-and-target` | **Yes** (`ownerTargetId`, already delivered by the data-gate prerequisites) | ✅ **Wired in the second scope-wiring batch, stage 1** (read side); **choosing the execution scope when creating a source** = the data-source placement work item | 🔴 In the first iteration a new source always lands in home ⇒ non-home views are **necessarily empty**: the empty state explains "the home region has N" + the create-source button **states the place first** (pinned by acceptance criteria). This is not a bug; the placement work is not done yet, and this is shown honestly |
| 4 | `/sync` | Data Sync | `global-and-target` | **Yes** (since the third scope-wiring batch: `targets[]`, derived from the data source's place) | ✅ **Wired in the third scope-wiring batch, sub-batch A** (read side); **execution push-down** = the data-source placement work item | New rows are stamped by `bindingForNewSyncTask` from the data source's `ownerTargetId` (single author); existing rows without a stamp fall back through three levels to the home region (they **really did** run only in the home region); 🔴 on the execution side `assertDefinitionRunsHere` **blocks in the reverse direction**: if the stamp disagrees with the place where it can really run ⇒ **409, refuses to run**, never running it once in the wrong region on its behalf ⇒ "has a region dimension" cannot degrade into "has a lying region dimension". The non-home empty state explains "this region cannot create one yet, why, and where to look" |
| 5 | `/etl-jobs` | Batch Compute | `global-and-target` | **Yes** | 🔨 **First scope-wiring batch, pages 1+2** | 🔴 The same page hosts ETL jobs and **EMR engine jobs** (`EmrJobPanel`, `app/etl-jobs/page.tsx:509`) ⇒ counts as two wiring units in the construction sequence (two API paths) |
| 6 | `/workflow` | ETL Orchestration | `global-and-target` | **Yes** (through the three-level fallback; the definition dimension = the per-region orchestration fan-out work item) | ✅ **Wired in the third scope-wiring batch, sub-batch A** (read side); **per-region fan-out** = the per-region orchestration fan-out work item | The execution body of existing orchestrations really is the home region only (publish goes through `homeMwaaEndpoint()`) ⇒ attributing them to the home region is the truth, not a fallback. 🔴 The machinery for per-region fan-out (`dag-fanout.ts`: per-target MWAA / unbind and take offline / ledger) **already exists**; what orchestration lacks is only the binding on the definition |
| 7 | `/redshift` | Redshift Query | `global-and-target` + **`compare`** | **Yes** | ✅ **Wired in the direct-query target-ization batch** (left-hand database/table tree + the execution target follows the top bar by default) | `compare` = the parallel multi-sheet of section 4septies; counts not supported; 🔴 the left-hand tree uses `?targetId=` (following the editor's own selection) rather than `?scope=` — one tree can show only one region's structure, and multi-region differences are presented by multiple sheets; switching region in the top bar ⇒ the execution target **follows by default** (section 9.4, "the default scope follows the view"), after which it can still be multi-selected by hand for fan-out; if that region has no warehouse installed ⇒ the tree's position explains why, no empty tree |
| 8 | `/athena` | Athena Query | `global-and-target` | None | Separate batch | Currently home only; counts not supported |
| 9 | `/realtime-compute` | Stream Compute | `global-and-target` | None | Separate batch | 🔴 The 45 occurrences of `region` on this page are Flink/MSK **resource configuration**, not the target dimension; do not mistake them for an existing region dimension |
| 10 | `/genbi` | Ask-Your-Data | `target-only` | **Yes** (SQL executed per region since the direct-query target-ization batch) | ✅ **Wired in the direct-query target-ization batch** (🔴🔴 decided on 2026-09-09: "even Ask-Your-Data can switch region") | Section 4 settled single-region execution + that region's model ⇒ it must be anchored to one target; a single target follows rule 2; 🔴🔴 **revision 2.26 changed the rule as decided: everything goes through the same AgentCore** (as stated: "however you design it, my requirement is: everything goes through the same AgentCore") — the data-access place is resolved by the platform and handed to the container with the payload, the container **deterministically injects** it into every tool call at the single funnel (not decided by the model), and the skill Lambda builds per-region clients by place. ⇒ The page carries a persistent line "SQL runs on the warehouse in that region (Ask-Your-Data goes through the same AgentCore; memory and skills are shared across all regions)"; 🔴 **"in-process engine" must never appear again** (an overturned statement; an acceptance criterion asserts it does not appear) |
| 11 | `/skills` | Skills | `global-and-target` | None | 🔴 **Third scope-wiring batch, sub-batch E** (tracked as a work item) | 🔴 **Re-judged in revision 2.27**: skill definitions are global, but **availability is per region** — Ask-Your-Data now really executes per region, and the skills that hard-code home-region resources fail in other regions. The page must be able to answer per region "which skills really work in this region"; "filter by target at retrieval time" is an execution-side matter and does not replace presentation |
| 12 | `/observability` | Observability | `global-and-target` | **Yes** (since the third scope-wiring batch: Ask-Your-Data history rows are stamped with the real place) | ✅ **Wired in the third scope-wiring batch, sub-batch A** | 🔴 Corrected after measurement: it was assumed the direct-query batch had given Ask-Your-Data a region dimension — what is stamped is the **task table**; the **history rows** had no region dimension at all ⇒ this change has `executeGenBiAsk` return the real place and `recordGenBiHistory` stamp it, then filters sessions and tool calls by the stamp. `partial` registration: the AgentCore runtime and skill Lambda metrics are **single-instance** (the whole platform has one AgentCore); splitting them per region has no counterpart |
| 13 | `/bi` | Report Builder | `global-and-target` | None | A later construction batch | Widget-level `targetId` ([the specification](./multi-region-execution-spec.md), section 8.3) ⇒ the page scope serves only as a default |
| 14 | `/requirements` | Requests | `global-only` | None | Not needed | — |
| 15 | `/governance` | Data Governance | `global-and-target` | **Yes** (catalog / quality / sensitivity queried per region since the direct-query target-ization batch) | ✅ **Wired in the direct-query target-ization batch** (catalog · quality checks · sensitive scan) | 🔴 counts not supported; 🔴🔴 **revision 2.26 changed the rule as decided: everything goes through the same OpenMetadata** (as stated: "the governance catalog must go through the same OpenMetadata, otherwise there is yet another thing to maintain, and incompatibilities and forgotten fixes become extremely likely") — "which region" = OM's **service dimension** (`bgp-*-<targetSlug>`; the home region has no suffix ⇒ zero migration of existing assets), and each region's tables are pushed into OM by the **metadata mirror**. 🔴 The catalog is therefore what it looked like **at sync time** (not live) ⇒ the page **must** carry a persistent line "sync status · last synced · where to refresh"; 🔴 the table count must not use the facet's `tables` (it counts only scheduled sources; measured 0 while the catalog had 21 tables ⇒ "0 tables" amounts to saying this region has nothing). Reads use `?scope=`; execution (quality runs / sensitive scans) uses **body.targetId** (those hit that region's warehouse **live**, unlike the catalog; the page must say so) |
| 16 | `/governance-workbench` | Governance Workbench | `global-and-target` | None | 🔴 **Third scope-wiring batch, sub-batch D** (tracked as a work item; moved out of sub-batch A during construction) | 🔴 Reason for the move (measured): the full table set can be fetched per region (just switch to that region's place), but **the keys of the three signal paths quality / lineage / classification have no region dimension** (`health-service.ts:87` aggregates by `fqn`) ⇒ same-named tables across regions overwrite each other, and per-region scores would be **contaminated**. Doing half (table set per region, signals still platform-wide) is worse than not doing it: the score looks like that region's while it mixes in other regions' coverage ⇒ to be done in the same change as adding the region dimension to quality rules |
| 17 | `/modeling` | Data Modeling | `global-and-target` | **Yes** (per-region landing panel) | ✅ **Wired in the second scope-wiring batch, stage 1** | The five-state drift presentation is already there (section 4ter); 🔴 **only the two tabs Code table + Dimensional modeling have a region dimension**; Layer / Data Domain / Data Standard / Metric are platform-level definitions **not split by region** — **since revision 2.27 this sentence is upgraded from page body text to a structured `partial` registration** (a verbal note gets missed by the next person taking over, exactly the kind of problem named on 2026-09-10), rendered uniformly by ScopeGate (the acceptance criteria are unchanged) |
| 18 | `/knowledge` | Business Glossary & Rules | `global-and-target` | None | 🔴 **Third scope-wiring batch, sub-batch E** (tracked as a work item) | 🔴 **Re-judged in revision 2.27** (named explicitly): a glossary term itself is a global definition, but "in which regions this term is already in effect / which region has not landed it yet" is something operations looks at every day, and one sentence "not affected by the execution scope" covered it up entirely |
| 19 | `/openmetadata` | Governance Center | `global-and-target` | **Yes** (OM's service dimension) | ✅ **Wired in the third scope-wiring batch, sub-batch A** | Lists per region **the OM services corresponding to that region** (`bgp-redshift-<slug>` / `bgp-glue-<slug>`; the home region has no suffix) with direct links to the service pages ⇒ per-region navigation under "the same OpenMetadata". 🔴 This page **does not display table counts** (that would require querying OM; to see tables go to `/governance`, which shows freshness and deliberately avoids the facet's `tables`) |
| 20 | `/monitor` | Task Monitor | `global-and-target` | **Yes** (region filter + targetId as the authoritative axis, `api/monitor/runs/route.ts:76-117`) | ✅ **Wired as page 3 of the first scope-wiring batch** (real-environment acceptance completed in the second scope-wiring batch, stage 1) | 🔴 The existing region filter is **demoted to secondary**; scope is the main axis; 🔴 the N of guardrail 1 comes from **the list response's own `countsByTarget`** (same time window), not from the counts endpoint (pinned by an acceptance criterion) |
| 21 | `/multi-region` | Multi-Region Dashboard | `global-only` + **`compare`** | **Yes** (cross-region by nature) | Not needed | 🔴 The only naturally global page; the consistency matrix of guardrail 6 lives here; the selector **does not affect** this page and **is not reset** |
| 22 | `/backfill` | Backfill Center | `global-and-target` | **Yes** (plan rows carry `execTargets`) | ✅ **Wired in the second scope-wiring batch, stage 1** | Backfill fan-out per target is already there; 🔴 the binding field is named **`execTargets`**, not `targets` — filtering by the default name would attribute the whole table to home, and the symptom would look like "the filter works" (pinned by an acceptance criterion) |
| 23 | `/alerting` | Alerting Center | `global-and-target` | None | Separate batch | Per-target alerting = [the specification](./multi-region-execution-spec.md), section 3.12; not done |
| 24 | `/finops` | FinOps | `global-and-target` + **`compare`** | **Yes** (cost run rows carry `targetId`, delivered by the data-gate prerequisites) | ✅ **Wired in the third scope-wiring batch, sub-batch A** (partially); billing per region = a tracked work item (the per-region billing work item) | "Task costs" and "Cost anomalies" are already per region, and 🔴 **anomaly detection now filters before computing the baseline** — the same disease as pooled alerting: the history of two regions mixed into one baseline, so a spike in one region is diluted by the other into no alarm. `partial` registration: "Cost overview" and "Budgets" are still platform-wide totals (billing is collected from Cost Explorer by the SERVICE dimension; per region requires collecting an additional REGION grouping and re-collecting existing data); service-level anomalies are marked `unscoped` and **not discarded**, labeled "platform-wide" in the UI |
| 25 | `/ops` | Ops Dashboard | `global-and-target` | None | 🔴 **Third scope-wiring batch, sub-batch D** (tracked as a work item) | 🔴 **Re-judged in revision 2.27** (named explicitly): the dashboard's aggregates (success rate / Gantt / recent alerts) lump the whole platform together, and it is precisely the page that most needs a per-region view; same change as de-pooling the alerts |
| 26 | `/incidents` | Incident Knowledge Base | `global-and-target` | None | 🔴 **Third scope-wiring batch, sub-batch E** (tracked as a work item) | 🔴 **Re-judged in revision 2.27** (named explicitly): knowledge-base entries mostly distill from **one region's** cost spike / alert, yet the rows carry no region stamp ⇒ no per-region traceability |
| 27 | `/projects` | Workspace | `global-and-target` | None (a project **does have** a target allow-list) | 🔴 **Third scope-wiring batch, sub-batch E** (tracked as a work item) | 🔴 **Re-judged in revision 2.27** (named explicitly): a project has a per-execution-environment allow-list (`accessAllows`), yet the page does not show "is this project authorized in this region" — the single most important cell for data residency |
| 28 | `/exec-envs` | Execution Environments | `global-only` | **Yes** (it is the page that manages targets) | Not needed | 🔴 The example page named in the prototype of section 9.2: shows "This page belongs to the global control plane and is not affected by the current execution scope", and **the selector keeps its value and is not reset** (pinned by an acceptance criterion) |
| 29 | `/admin/users` | Users | `global-only` | None | Not needed | — |
| 30 | `/audit` | Audit Log | `global-and-target` | None (audit **does have** target sharding) | Separate batch | Cross-jurisdiction audit stays in the region (section 4bis.5) ⇒ the target view queries that region's audit |
| 31 | `/settings` | Settings | `global-and-target` | None (everything it displays is **per-target** resources) | 🔴 **Third scope-wiring batch, sub-batch B** (tracked as a work item) | 🔴🔴 **Re-judged in revision 2.27 — the former `global-only` was an outright lie**: `app/settings/page.tsx:79-86` renders **AWS Region / Redshift workgroup / Glue script bucket / MWAA DAG bucket / default VPC** as "Platform Settings" to **every** region, with all values coming from the home region; the Redshift / S3 entries under "Service status" likewise. That is worse than "not yet filtered": it **explicitly denies** having anything to do with region. The region dimension of the AI model belongs to the model-configuration design's own work item |

#### 9.6.2 Table B — the 9 routes that have a page.tsx but **are not in the menu tree** (🔴 the group most easily missed)

> These 9 routes cannot get a `Leaf.scope` (the menu tree has no leaf for them), so their capability must be given in **a separate explicit registry**,
> otherwise they are a blind spot that "nobody ever declares and that renders as All by default". The place = the `EXTRA_ROUTE_SCOPE` table in `lib/scope/route-capability.ts`,
> asserted for coverage by `scope-capability-guard` together with `routes.tsx`.

| # | Route | Capability | Wiring batch | Notes |
|---|---|---|---|---|
| 1 | `/login` | ScopeGate not mounted | — | The logged-out state has no project / no scope; the only entry on the guard's allow-list |
| 2 | `/metrics` | `global-and-target` | Separate batch | Named in item ② of the planning notes as "no region dimension at all" |
| 3 | `/schedule` | `global-and-target` | Separate batch | The back end already routes by target (earlier scheduling work); the page dimension is still to be wired |
| 4 | `/sla` | `global-and-target` | Separate batch | — |
| 5 | `/sync/[id]` | Follows `/sync` | With `/sync` | The scope of a detail page = the resource's own binding, unaffected by the selector (read-only echo) |
| 6 | `/workflow/[id]` | Follows `/workflow` | With `/workflow` | Same as above |
| 7 | `/theme-gallery` | `global-only` | Not needed | Theme preview, unrelated to business data |
| 8 | `/theme-gallery/[id]` | `global-only` | Not needed | Same as above |
| 9 | `/theme-preview` | `global-only` | Not needed | Same as above |

#### 9.6.3 🔴 The dependency between the scope-wiring batch and the direct-query target-ization batch, recorded honestly (decided on 2026-09-09 to skip the direct-query batch and start the scope-wiring batch directly)

The prerequisite of the scope-wiring batch originally read "the direct-query target-ization batch (otherwise the target view has no data)", while that batch was still 📋 not started. **Conclusion after checking page by page**:

| Page | Does the data depend on the direct-query batch | What this batch does about it |
|---|---|---|
| `/etl-jobs` (including engine jobs) · `/monitor` · `/modeling` | **No** — the truth lives in the home control plane's DynamoDB; the target dimension was already delivered by the data-gate prerequisites (run stamps / definition `targets`) | **Fully done in this batch** (data + empty state + guardrail 1 + button restatement) |
| `/governance` · `/governance-workbench` | **Yes** — the truth lives in each region's warehouse; only the direct-query batch's "five warehouse direct-query paths made target-aware" provides a data plane | 🔴 This batch does **only the capability declaration + ScopeGate + empty / unavailable states**; data wiring follows the direct-query batch; `scopeWired` stays `false` for now |
| `/finops` | Does not depend on the direct-query batch, but the region dimension of the cost page belongs to **the per-region billing work item** | Not wired in this batch, `scopeWired:false` |

⇒ **The 6 wiring units of the scope-wiring batch are corrected to**: `etl-jobs` (ETL) → `etl-jobs` (EMR engine jobs) → `monitor` → `modeling` → top bar + the site-wide ScopeGate shell (including the hint bar on 34 pages) → the shell and empty state of `governance`.
**This does not shrink the scope**: in the original plan the data plane of governance already read "URL read by the direct-query batch", and finops already read "with the per-region billing work item"; this item merely writes the boundary of these two pages into the contract, so that acceptance does not judge red on "all 6 pages have data".

### 9.7 🆕 Decided in revision 2.30: **the page proposes an execution-scope switch** (guardrail 7; the Ask-Your-Data session-card work is the first consumer, but this is a general protocol)

**Shape of the problem**: up to revision 2.29, the execution scope **could be changed only by the user in the top bar**. But one class of actions inherently has to open "an object that belongs to another scope" —
the first real requirement is the **Ask-Your-Data session card** (a card is bound to the target it fetched data from; a user may open a us-east-1 card while in the home view);
in the same family: opening a run in **another region** from an alert / monitoring deep link, opening a BI card shared by a colleague, drilling down from the cross-region metadata overview to a table in one region.

Three approaches; the first two are wrong:

| Approach | Why not |
|---|---|
| **Silently change the top-bar scope** | Violates guardrail 4 (no reload) and the user's sense of direction — the user clicked "open a card", yet the top bar changed by itself and every subsequent page follows it; they cannot tell when it changed |
| **Ignore the scope and execute in place** | Worse: "continue the conversation" would ask in **the wrong region**. This is the interaction-surface version of the whole class of "always hits the home region" defects fixed earlier |
| ✅ **Explicit proposal + the user chooses one of two** | The user always knows which scope they are in; declining also leaves a **meaningful** way out (read-only viewing) |

**Contract (every entry that "opens an object of another scope" must follow these seven points)**:

1. 🔴 **Never switch silently**. A change of scope must be clicked by the user in the dialog; the page must not change the top bar by itself.
2. **It must be a choice between two**: [Switch to `<region>` and continue] / [View read-only]. The default focus lands on **View read-only** (the conservative side).
3. **Restatement + instance pointing back to its definition** (guardrails 2 / 3): the dialog must state **targetId + region + the object's identifier** together
   (e.g. "this card belongs to `tgt_use1_a` (us-east-1) · 4 turns · 09-12 10:31"). Writing only the region is not enough —
   one region may have several execution targets (a lesson from an earlier scope-wiring batch).
4. **The read-only state must explain why operations are unavailable**, and **keep the switch entry**. Merely disabling the input box without giving the reason = the user thinks it is broken.
5. **After switching, the URL must change accordingly** (section 9.2: the URL is the authority) ⇒ a refresh stays in that scope, and the browser's **Back returns to the original scope**.
6. **Declining the switch must have zero side effects**: no memory written, no run created, no ledger touched, no top-bar change.
7. 🔴 **"Can it be viewed" and "can it accept work" are two different criteria** (this repository has made this mistake twice; see section 2.2a and the lesson of an earlier construction batch):
   - Read-only viewing requires only that the object is **visible** (its target is still in the registry and the user has permission);
   - "Switch and continue" additionally requires that the target **can accept work** — and that criterion **recognizes only the registry's single author**:
     `unusableReason()` (descriptor not serviceable / draining / initializing·upgrading not yet closed out) + whether the component the action needs is installed.
     🔴 Writing another set of "what counts as able to accept work" inside the page is not allowed (that would be a second copy, bound to diverge from admission sooner or later).
   ⇒ If visible but unable to accept work: **do not offer** "switch and continue"; give only read-only + a one-sentence human-readable reason + a **direct** entry to install the missing component / approve / release
   (the same rule as the missing-component direct link of section 1.7 and the missing-scheduler 409 direct link of section 2.2a). **"Cannot run" must never be presented as "does not exist".**

**Headless acceptance essentials** (each consumer lands them in its own acceptance segment; for the Ask-Your-Data session-card work they land in the acceptance criteria of that feature's design note):
① opening an object that belongs to B while in the A view ⇒ the dialog appears and **contains all three: targetId, region, object identifier**;
② clicking [Switch and continue] ⇒ the top-bar view **really changes**, the URL changes, the operation entries become usable;
③ clicking [View read-only] ⇒ the top bar **does not change**, the operation entries are disabled **and a reason is given**, and there is no side effect of any kind (zero new ledger / memory entries);
④ the target is visible but cannot accept work ⇒ **there is no** [Switch and continue] button, only read-only + reason + direct entry.

## 10. 🆕 Decided in revision 2.29: the interaction for a component that is "Discontinued" (the retired-component work; decided on 2026-09-11: "from now on we will not deploy the classic version of MWAA either")

**Shape of the problem**: a component changes from "installable" to "no longer offered", while **existing environments still have it installed and still use it**.
There are three possible interactions; the first two lie:

| Approach | Why not |
|---|---|
| **Delete the whole row** from the wizard | People who already have `mwaa` cannot understand "where did it go"; the detail page still shows the component while the wizard has no such item ⇒ the two places contradict each other |
| Label it "**Not implemented**" | That is a **falsehood** — the stack group is still there and existing installs still run; moreover the established meaning of "Not implemented" is "ticking it gets explicitly refused by the stack group", which is not this situation |
| ✅ **Keep the row, disable the checkbox, label it "Discontinued"** | The only one that does not lie: the position remains (discoverable), the status is explicit (cannot be newly installed), and the reason and the way forward are in the tooltip |

**Decision (kept strictly apart from the existing "Not implemented" label; two Tags, two meanings)**:
1. In wizard Step 2 that row is **`disabled`** + the Tag **"Discontinued"** (`data-testid=wizard-component-<key>-retired`);
   the tooltip must state all three: **why** (everything goes through airflow-serverless, billed per task-second, zero always-on resources) · **what happens to existing installs** (they keep working as before) · **what to tick instead**.
2. **Registration / supplementary deployment** that includes it ⇒ refused, and the refusal reason is **the same text as the tooltip** (single author `retiredComponentMessage`, shared by the three places).
3. 🔴 **Existing installs must remain operable**: the detail page still lists the component row, the health probe runs as before, and the take-offline path works as before;
   and because the semantics of "supplementary deployment" is **the full set**, the full set submitted for an existing environment **must be allowed** to keep carrying it —
   otherwise it could not even "add airflow-serverless" (an acceptance criterion pins exactly this point).
4. Wording discipline: the UI never shows "obsolete / deprecated / take offline" — **taking offline is a different thing** (it requires drain + approval + destruction);
   here it is only "no longer offered for new installs", and the wording must be kept distinct from that other thing.
