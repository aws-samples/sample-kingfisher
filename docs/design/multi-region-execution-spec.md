# Multi-Region Execution — Technical Specification: Multi-Region Execution Environments, Dual-Track Data Residency and Platform-Wide Multi-Region Coverage

> - Revision: **3.54** (🆕 2026-10-21 **the long-running-operation framework ⇒ new section 3.18, the unified long-running-operation protocol** (any write route that waits for an external system to reach a terminal state may only go through the `lib/long-ops/submitLongOp` hybrid response: wait
>   in-process for `LONG_OPS_SYNC_WAIT_MS` (45 s); if no terminal state is reached ⇒ 202 carrying the protocol marker `protocol:"long-op/1"`; the client's global fetch interceptor follows the task to its terminal state and reshapes it into a synchronous 200 ⇒ zero changes at call sites; the single
>   author of the wait-for-terminal primitive is `lib/long-ops/await-terminal.ts`, which throws when no long-running-operation context is present; relation to section 3.9a = the execution channel and the authorization axis are unchanged, only "how long to wait and how to answer" changes; the
>   implementation-level contract is [the long-running-operations design](./long-running-operations.md), revision 1.0, section 2; the governance "sync columns" timeout, the project-deletion failure on warehouse cold start, the model-call 504s behind the 60-second edge limit and the modeling-landing
>   504 on warehouse cold start are the same disease and are cured together)) revision 3.53 (🆕 2026-10-20 **the orchestration "New" target multi-select was always empty ⇒ the endpoint row in section 2.6.5a gains `GET /api/exec-targets?component=` with the closed dimension list `redshift / airflow /
>   core / any`** (single author `lib/exec-env/exec-targets-dims.ts`; route validation and the page's `fetchExecTargets` parameter type are the same definition; `airflow` = any scheduling component installed, plus the home region always listed; `core` = every target that is in place; before the fix
>   the multi-select in orchestration "New" was always empty)) revision 3.52 (2026-10-20 **graphical create-table / alter-table in the Data Catalog ⇒ the section 3.9a union gains a 14th operation, `alter-model-table`** (it accepts only `modelTableId`; the change plan is read server-side by the
>   executor from the ledger row's `pendingAlter`, the template generates the ALTER / COMMENT statements from the plan, with the same author as the home path, `lib/modeling/alter.ts`; policy same as `land-model-table`; the irreversible confirmation for dropping a column (typing the physical table
>   name) and the approval for prod environments (approval ticket type `ddl`) are both route-layer mechanisms. "New table" in the Data Catalog adds no operation: Redshift reuses `land-model-table` (ledger entry `origin: catalog`), S3 Tables goes through s3tables `CreateTable` (control plane, Iceberg
>   schema); S3 Tables **offers no alter-table** (Iceberg schema evolution needs a Spark engine, and Athena supports no DDL against s3tablescatalog), the UI greys it out with an explanation.) revision 3.51 (🔴🔴 evening of 2026-09-21, **the "pending decision" was rejected ⇒ 🆕 section 3.9d.8 settles the
>   authorization axis of modeling landing**. Revision 3.50, section 3.9d.7 (b), had written "should platform-global knowledge objects be constrained by the 'Authorized projects' allow-list" as a multiple-choice question awaiting a decision — the verbatim reply was: "**If you let it through because
>   you could not solve it, that is evasion; we have built the feature, why evade?**" **That criticism stands**: the comment in `landing.ts` **already stated, in the author's own words**, "that error text is meaningless for modeling: modeling is global and never had a project"; only because the
>   immediately following `return credential-gap` masked it and the path was currently unreachable did the author leave it unfixed and package it as a question — while **the very thing the shared-writer work was to do was to remove that early return**. Decision: **modeling artifacts are not
>   constrained by the project allow-list, because the axis itself is wrong** (the allow-list governs "which region a project's business data lands in"; modeling has no project dimension; it is not fail-closed but **dead-closed** — no projectId exists that could pass it; and it is self-contradictory
>   — code tables / dimension tables are the **prerequisite** for the allow-listed projects to run in that region at all). 🔴 **Never fail-open**: replace it with the four gates that genuinely govern it (admission `requireReadyTarget` unchanged to the letter / 🆕 **the landing place must be the
>   platform-global schema, never `proj_<id>`** / ledger membership / audit), and give `BindingOpts` a **mandatory discriminant** `scope:"platform-global"|"per-project"` (**no default** ⇒ forgetting to pass it is a compile error); **`accessAllows` is not changed**. The 🆕 acceptance criterion **must
>   come as a pair** (with an empty allow-list set, modeling still succeeds ∧ ETL is still refused). Tracked as a defect.) revision 3.50 (🔴 2026-09-21 **third survey ⇒ section 3.9d.7: another contract sentence without a carrier + one honestly recorded design issue + one piece of good news**. (a) 🔴🔴
>   **the guard in section 4.6 ④ is unimplementable** — it says "verify that the object's ledger `kind` is `modeling-global`; forbid business tables in shared", but in reality `modeling-global` occurs in the whole repository in **one comment only**, `bgp-table-ownership` has **not a single line of
>   code**, and the `CodeTable`/`ModelTable` types have no `kind` either. **This is the same family of defect as section 3.9d itself** (the contract wrote a sentence and the thing that carries it does not exist). Decision: the guard becomes **ledger membership** (refuse when `getCodeTable(id)` /
>   `getModelTable(id)` finds nothing), **no new field** — it is **stronger** than `kind`: a string can be written wrongly, whereas "this id is found in the code-table ledger" is **closed-form**; which class an object belongs to is decided by **which ledger it comes from**; business tables are simply
>   not in either ledger ⇒ the original intent holds unchanged. (b) ⚠️ **one design issue recorded**: modeling **has no project**, yet `assertBindableTarget` passes through `accessAllows(t, undefined)` — true only when that target is `all-projects` ⇒ **once an administrator sets an "Authorized
>   projects" allow-list, modeling landing in that region is refused forever**, and the reason is even written as "not authorized for the project **(no project context)**". The live `tgt_usw2_a` is `all-projects` ⇒ this package's criteria can pass, **but that is a precondition, not a guarantee**; the
>   fixture of the corresponding acceptance criterion must spell it out. Whether platform-global knowledge objects should be constrained by the per-project allow-list **requires a decision**; this section only records it. (c) ✅ **good news: the execution channel already exists** —
>   `execOnTarget({warehouse, sql, secretArn})` is, to the letter, the required shape (client taken by target region + explicit workgroup/database + explicit SecretArn, and it refuses an empty ARN by itself) ⇒ narrow-privilege DML uses it directly; 🔴 **never write a new Redshift client for it** (that
>   would be "a second author"))
> - Based on: **[the design document](./multi-region-execution-design.md), revision 3.26** (decisions / invariants / section 19 platform-wide coverage / section 20 foundation-correction record; **the sole authority for the implementation order = the design document, section 17**) + [the interaction
>   design](./multi-region-execution-interaction.md) (interaction). **This document is the sole implementation-level contract** (tables / APIs / state machines / migration / acceptance); decisions and the "why" are in the design document, interaction in the interaction design, and the interaction
>   design may not define scope on its own (the frozen contract of the design document, section 20.4).
> - 🔴 Pure design (including pseudocode); no implementation code is written and nothing is deployed without explicit confirmation.
>
> Earlier revisions (7) are in the collapsible list below.

<details><summary>Revision history</summary>

- Revision: **3.49** (🔴🔴 2026-09-21 **a second review right after the change found on the spot that revision 3.48 got only half of it right** ⇒ 🆕 section 3.9d.6. The `credential-gap` in `landOne` is **one gate shared by two kinds of object**, and `landToTargets` has **two** production callers: code
  tables (`buildLandStatements`: `CREATE`/`DELETE`/**`INSERT … VALUES`**) ⇒ genuinely need the narrow-privilege writer; dimension/fact tables (`buildCreateTableStatements`: `CREATE SCHEMA`/`CREATE TABLE`/`COMMENT` — **not a single DML statement**) ⇒ **need no new identity**; pure DDL belongs on the
  admin channel anyway, and all that is missing is **one new template operation**. ⇒ the section 3.9a union gains **two** operations in total (`grant-shared-writer` + 🆕 `land-model-table`), and one acceptance criterion is added. Three disciplines for `land-model-table`: it accepts only
  `modelTableId` and **reads the ledger server-side** for the names (same shape as `land-code-table`, which accepts only `codeTableId` — the physical table name the user typed is **product ledger data**, not "a name freely chosen by the call site"; this distinction must be written down or
  successors will think it violates section 3.9a); 🔴 the DDL **must reuse `buildCreateTableStatements`** and the template is responsible for branding only — assembling it again yourself means the modeling DDL has **two authors** (type normalization / primary-key clause / `COMMENT` escaping each in
  two copies) ⇒ "a table built from home differs from one built from a non-home target" while each side looks right on its own. 🔴 **Why this had to be corrected before writing code**: with code tables alone, the "🧱 Dimension/fact" row in the UI **stays ⊘** ⇒ the fifth state does not disappear ⇒ the
  closing condition in [the interaction design](./multi-region-execution-interaction.md), section 4ter.a-1, is only half met, and the reverse re-verdict of the corresponding headless acceptance item would **go straight red**)
- Revision: **3.48** (🆕 2026-09-21 **contract first for the shared-writer work: 🆕 section 3.9d, the narrow-privilege `shared-writer` identity class** — it supplies the **carrier** for the sentence in section 3.9a / section 4.6 ②: "data writes do not use admin, they use the narrow-privilege
  shared-writer" had been **just a sentence** since it was decided on 2026-08-31, so non-home modeling landing was deterministically judged `credential-gap` (the fifth state of [the interaction design](./multi-region-execution-interaction.md), section 4ter.a). This revision fixes four things: ① the
  identity is a **target-level** fixed login user `shared_writer` (modeling is platform-global and has no project ⇒ issuing identities per project would give the same code table N writers); ② 🔴 **per-table grants**, no schema-level write privilege — `GRANT INSERT ON ALL TABLES IN SCHEMA shared` is
  the "enumerate violations" way of thinking, and what it misses is always table N+1, whereas "the tables the admin template explicitly created" is a **closed-form** universe, so the negative criterion becomes **decidable**; ③ 🔴 **the physical landing place of code tables must first have a single
  author** `codeTableLandingFqn()` — today the live system lands at `<schema>.dim_code_<code>` while the admin template lands at `shared.code_<id>`, **two authors each writing a name**; if the grant template assembled it a third time there would be **three**; with a single author, "converging the
  landing place" degenerates into **one function's return value + one migration of existing data**, so "does the channel work" and "do we rename" can be split into two steps (the `physical` entry of the consistency matrix is **single-valued** ⇒ convergence must change home too ⇒ must touch existing
  data ⇒ it is naturally a separate step); ④ two **honestly recorded deviations**: the secret ARN **does not enter the descriptor's resource bag** (the bag's single author is the deployment-time read of CFN Outputs; stuffing a non-CFN key in at runtime = a second author, and "is the bag complete"
  is a closed-form criterion; the existing precedent `verifyProjectCredentials` already Describes by name), and creating the user **cannot be a template** (passwords may not enter template artifacts ⇒ it is the executor's third public entry point, same discipline as `provisionProjectLogin`); both
  have been fed back into the work-package plan. Also: **the acceptance-criterion numbering was corrected** (the original numbers collided with the serverless-scheduling items). The load-bearing premises were read in the real environment and **dated** (the non-home target has an admin secret in
  us-west-2 / the `provisioning` window runs to 2026-10-19 / ⚠️ window expiry **does not affect** admin DDL — `provisioningExpired()` has exactly one consumer in the whole repository, the project-context fallback))
- Revision: **3.47** (🔴🔴 2026-09-14 **section 3.14ter adds the premise that had been missed: the execution-environment VPC must change its address range** — peering strictly requires non-overlapping CIDRs on both sides, while the home-region VPC and the execution-environment VPC **both use the CDK
  default `10.0.0.0/16`** (this fact had sat in a code comment of the zero-egress work for six days; when the design was switched only the SCP was re-surveyed, not the CIDR; the one-off probe used two throwaway VPCs ⇒ **the probe proved "this path works", not "our foundation can take this path"**).
  Decision: address pool `10.128.0.0/9` (**disjoint from the home region by construction**) + allocated at registration into the descriptor field `vpcCidr` + mandatory in the type (**no silent default allowed**) + a guard for existing address ranges; on the home-region side `BgpVpcStack` provides
  same-region endpoints (`privateDnsEnabled=false`) and three Outputs, and the three facts are **bundled into one object** passed downward; on the home side the accept / return route / ENI IP are done by the `HomeLink` **custom resource** (lifecycle bound to the peering ⇒ deleting the stack
  reclaims it, no blackhole left); `crossRegionDdbEndpointId` **retires** → `homeLinkPeeringId`; and a **"written but never wired"** defect fixed in passing: the base stack's network-observation Output never entered the resource bag ⇒ the two zero-egress probes **had never run**) revision 3.46 (🔴🔴
  2026-09-14 **the cross-region private path changes design ⇒ 🆕 section 3.14ter**. The zero-egress foundation relied on one **cross-region** DynamoDB interface endpoint to carry the only cross-region call, "ledger write-back to the home region", and it could not be created in any of three temporary
  accounts — the IAM simulator proves **this is a block at the organization SCP layer** (the role carries `AdministratorAccess`=`*`, the identity layer already allows it; the organization grant `vpce:AllowMultiRegion` = False), and no policy added inside the account can open it. The same simulator
  **allows all of** peering / TGW / Global Tables / EventBridge / S3 CRR ⇒ only that one action is blocked. Decision: switch to **cross-region peering + a home-side "same-region" interface endpoint + a private hosted zone on the non-home side**: all endpoints same-region, the action is bypassed,
  **zero platform-code changes** (the PHZ hijacks the default domain name), zero egress unchanged. Confirmed with a one-off probe, which also dug up a pit that must be stepped around: the home-side endpoint must be **`privateDnsEnabled=false`**, otherwise it hijacks home's own-region DynamoDB
  traffic from the free gateway endpoint onto the billed interface endpoint) revision 3.45 (🔴🔴 2026-09-14 **decided: classic MWAA stops being deployed everywhere (including home)** ⇒ 🆕 **section 3.14bis**. The retirement work had only marked the **execution-environment side** RETIRED; this entry
  goes one step further: `deploy-all` step 7 skips by default, `infra/bin/app.ts` instantiates it only with `-c classic-mwaa=1` (the stack class is **kept** so the one existing instance can be claimed and deleted); 🔴 the hard-coded `"mwaa"` in `seed-home.ts` becomes **claimed only when probed** —
  without that change the descriptor **would lie** once home no longer installs it, scheduler routing would pick classic MWAA and call `CreateCliToken` with a non-existent environment name, scheduling would break wholesale and the symptom would be far from the root cause) revision 3.44 (🔴
  2026-09-14 **the run-group objective starts "contract first"**: 🆕 **section 1.3a S7**, new table `bgp-run-groups` (group status **derived**, no second source of truth · failure to write the group row **refuses the run**, no fail-open · the `definitionKind` value set reuses the existing
  `ResourceType` of the versioning module, **no new vocabulary**) + 🆕 **section 2.7**, four endpoints (cancel **does not drag down already-terminal runs** · retry **does not modify the original group** · a single region forms no group) + 🆕 **section 3.17**, exhaustive group-status derivation + a
  deterministic group key for scheduled triggers. 🔴🔴 **Opening the package overturned on the spot a formula that had sat in S6 ② for three months**: (a) `scheduledTime` **may not be taken from Airflow's `run_id`/`logical_date`** — under MWAA Serverless it **degenerates into a constant** (measured;
  `runtime-py.ts:_ledger_run_id` had long recorded this fact, nobody had connected it to the run-group objective) ⇒ implemented per the original formula, the failure mode is **every historical scheduled run grouped into one group that never reaches a terminal state**; (b) **`definitionVersion` does
  not enter the key** — it is per-target deployment-ledger state, and a single-region republish creates a cross-region version difference ⇒ the same trigger **split into two single-member groups**; version differences are instead **visible inside the group**. ⇒ Decision = **round down to the cron
  slot** (each region computes it alone, no communication; to be staggered the delay must exceed a whole period)) revision 3.43 (🔴🔴 2026-09-11 **the decision "scheduling moves fully to MWAA Serverless, classic is no longer deployed" becomes contract — section 3.15 gains the revision 3.43 passage**:
  the shape is **`tasks` only** (the original route A `inline` is cancelled) — because real-environment measurements **overturned the revision 3.27 file header**: `trigger_rule` **is supported** (`all_done` takes effect, and with it a whole run still reports SUCCESS when one task FAILED ⇒ "did the
  run succeed" must never be read from RunState alone); operators have an **allow-list** (`BranchPythonOperator` / `ExternalTaskSensor` are explicitly refused by CreateWorkflow) ⇒ branching is carried by the platform's own PythonOperator + XCom + `AirflowSkipException`, foreach with static items is
  **expanded at generation time** into N tasks, only `external` is honestly refused at publish time (recorded as a known limitation); the ledger closes through three write points, `__start` / the failed node itself / `__finish` (the substitute for forbidden callbacks; the same `ex_<uuid>`
  guarantees the three points share one key = measured), and "`__start` grabs the lock" is **corrected** to "only creates the ledger row; the lock stays node-level, classic semantics"; node semantics are extracted into the single author `NODE_EXEC_PY` (classic runtime-lib v6→v7 and the serverless
  code package assemble one copy); classic mwaa **is kept for existing installations, no longer offered**) revision 3.42 (🔴🔴 2026-09-10 **three rounds of decisions land — the scope follow-up work**: ① **section 2.6.7bis, a read-level ledger + a second ratchet** — page-level `wired:true` only
  guarantees "somewhere on the page reads scope"; in reality **18 of the 20** declared pages had reads without scope (67 in total) ⇒ new `api-read-ledger.ts`: every read without scope needs a **closed reason code** (`platform-singleton` / `by-id-row-lookup` / `by-id-server-derives` /
  `cross-scope-by-design` / `not-wired-yet`), and debt must carry a ticket; the criterion **consumes URL actual parameters only** (`targetId` is reused in this repository as a form field name; matching whole call passages would give false green); 🔴 plus an **anti-gaming** criterion (if the front
  end passes scope, the server must actually use it — a ratchet looking only at the URL can be fooled by "parameter passed, server ignores it"; 5 such places found in reality). ② **three rejected "by design" verdicts reversed**: layering / data domains / data standards / metrics no longer count as
  platform-level, unpartitioned (governance conventions gain an **applicable region**, with the semantics "undeclared = platform-wide", the **opposite** of the executor's "no stamp = belongs to home", hence a separate `filterRowsByApplicableScope`); BI definitions gain an **optional** filter (no
  filtering by default); orchestration **has one Airflow per region, scheduling executes only in its own region, only metadata is reported to the home region** (previously 6 files all used `homeMwaaEndpoint()`). ③ **three execution push-downs**: data-source creation genuinely per region
  (`resolveDsPlace`; secret / SG / Glue connection / test-connection all created in that region) · Flink gets a place (`FlinkPlace`; 6 module-level home-region clients zeroed + cross-region runner JAR `ensureRunnerJar`) · orchestration per region (`schedulerEndpointFor` wiring + serverless honestly
  refuses). ④ **three governance paths gain a region dimension**: partition key `<targetId>::<fqn>`, **bare fqn for home ⇒ zero migration of existing data**; an illegal targetId **throws**, no fallback. ⑤ new reason code `redirect-only` with a gate. Two ratchets: page-level 22 → **0**; read-level
  31 → **1**)
- Revision: **3.41** (🔴🔴 2026-09-10 **decided: "both banner sentences are wrong; nothing on the whole platform may be left out; I do not want to say this a second time"** ⇒ **section 2.6.7, the route capability declaration changes from two fields to a discriminated union**: not-wired must give a
  **ticket number + what is missing** (the banner renders it directly) · wired-but-partial must give a structured **`partial`** (previously only written in page prose; the next maintainer would surely miss it) · `global-only` must give a **closed reason code + which page to look at instead** (if no
  reason can be formulated, it should not declare global; this directly caught `/settings` as a pseudo-global) · 🔴🔴 a new **ratchet** `NOT_WIRED_LIMIT` (the real count must match exactly and may only decrease) · the shell grows from four kinds to five; tracked in the work-package plan, with an
  acceptance segment) revision 3.40 (🔴🔴 2026-09-10 **two decisions, sections 3.4.5 / 3.4.6 rewritten entirely**: ① "**However you design it, my requirement is: everything goes through the same AgentCore**" ⇒ the split "non-home uses the in-process engine" is cancelled; instead **the data-fetch
  place becomes part of the payload** (the platform resolves it → the container injects it **deterministically** at the single funnel `tracedCall`, not decided by the model → the skill Lambda builds a per-region client by place, defaulting to env ⇒ the home region is byte-for-byte unchanged); ②
  "**the governance catalog must go through the same OpenMetadata, otherwise there is yet another thing to maintain, which is extremely prone to incompatibility and forgotten fixes**" ⇒ non-home direct query is cancelled; instead **"which region" = OpenMetadata's service dimension** (home gets no
  suffix ⇒ zero migration of existing assets; no suffix or an unknown suffix always maps to home) + each region's tables are **pushed into OpenMetadata by the mirror collection** + 🔴 **freshness must be returned and displayed together** (the catalog comes from sync, not real time) + 🔴 the table
  count may not use the facet's `tables` (it counts only scheduled sources; measured 0 while the catalog had 21 tables) + 🔴 push failures must be visible; also a compile boundary recorded: the OpenMetadata write primitive moves to the lightweight layer `om-write.ts` (the mirror runs on the edge
  surface; via om-push it would touch `node:crypto` ⇒ build failure)) revision 3.39 (🔴🔴 2026-09-10 **the direct-query work lands: section 3.4 is promoted from pseudocode to contract** — single author `direct-query.ts` (place / client / polling, three things converge) + **three things deliberately
  not unified** (row shape / polling budget / error wording, each with its measured difference) + **home and non-home must have different `projectId` rules** (home fails closed if it is passed; non-home refuses with a misleading reason if it is not passed) + degradation = a **capability state**
  recognizing only `missing-component` + three groups of measured consolidations (**20** bare clients, not 21; **two Ask-Your-Data places move from group C home-only to target-aware**) + 🆕 `HomeOnlyReason` **frozen list** (each entry states when it may be deleted) + 🔴🔴 **section 3.4.5,
  Ask-Your-Data executes per region: non-home uses the in-process engine** (AgentCore is installed only in the home region and its skill Lambda has no concept of "take the place by target" ⇒ handing it over means silent cross-contamination) + 🔴 **section 3.4.6, the governance catalog does not use
  OpenMetadata for non-home** (the central single instance ingests only the home region) + section 3.4.7, the dividing line: reads use `?scope=`, execution uses `body.targetId`) revision 3.38 (🔴 2026-09-09 **scope follow-up, phase 1 landing corrections** (section 2.6.6): ① `resource` value set
  +`backfill-plan`; ② 🆕 the decision on **class-B binding field names not being uniform** — measured: backfill-plan rows call it `execTargets`; add an optional `bindingAttr` that **only swaps the field name**, the three-level fallback keeps a single author, and two wrong ways are forbidden [writing
  a literal in the registration table / the caller mapping out its own `targets` field]; ③ backfill plans reuse `listPlans(projectId)` rather than a new Scan [a Scan would count other projects' plans into the hint bar]. 🔴 Why this deserves to be in the contract: reading that table with the default
  field name makes **every row fall back to home**, so the home view shows "everything is here" while other regions show "all empty" — **a symptom that looks exactly like filtering working**) revision 3.37 (🔴 2026-09-09 **real-environment acceptance caught two items on the spot, both folded back
  into the contract**: ① **the list source of section 2.6.5a is replaced** — the first version reused `listActiveTargets()`, which judges "can it accept new work right now", so `tgt_usw2_a` with `health=unknown` **disappeared from the top bar** (the dropdown had only home left) ⇒ changed to four
  "is it installed" filters; health degradation becomes a **per-item badge**, not a filter condition; ② **the hint bar of section 2.6.6 counts visible targets only** — measured: 6 jobs were bound to the deleted usw2_b/c, and counting them into N gives a number the user cannot click) revision 3.36
  (🔴 2026-09-09 **two decisions into the contract**: 🆕 **section 2.6.5a, the selector lists only "fully installed" targets** [`listActiveTargets()` ∩ `accessAllows`, the same two filters as `listRedshiftCapableTargets`, no new judgment; not finished / failed / draining / operation in flight /
  health unknown / unauthorized never enter the list; a brand-new environment has only `tgt_home`] + 🆕 **section 2.6.5b, cold start restores the last selection** [if the URL carries the parameter the URL wins; otherwise restore from `bgp-scope:<pid>:<env>` and `replaceState` writes it back to the
  address bar; if the stored one is no longer in the list ⇒ fall back to "All" and **say so explicitly**, which is a different matter from the "URL names a bad target and we silently fall back" forbidden by section 2.6.5] + section 2.6.5 gains a 5th refusal **409 `TARGET_NOT_READY`** [exists and is
  visible but cannot currently accept work; the response carries the `serviceabilityReason` sentence]; also `compare` in section 2.6.7 moves out of the union into the optional field `scopeCompare`) revision 3.35 (✅ 2026-09-09 **execution-scope construction step 3 landing corrections** [three items
  the implementation surfaced, all changed in section 2.6]: ① the three refusal codes join the site-wide `ApiErrorCode` union and become `INVALID_SCOPE` / `TARGET_NOT_FOUND` / `TARGET_FORBIDDEN` [the originally planned PascalCase was **a second code vocabulary**]; ② section 2.6.4, when class A
  names home it **must explicitly also fetch empty-string rows** — DDB's `attribute_not_exists` does not match the empty string, a real semantic difference forced out by the parity unit test; the fix is to make the DDB side fetch them too, **not** to loosen the unit test; ③ section 2.6.6, **`run`
  moves out of the counts endpoint** [the run list has a time window, so a full-table count and the list rule can never agree ⇒ the acceptance criterion went falsely red]; the monitor list returns `countsByTarget` with its response instead, plus the three rules "must paginate to the end + mutation",
  "not trimmed by visibility", "the two modeling tables reuse the existing list functions") revision 3.34 (🆕 2026-09-09 **execution scope, first objective · contract landing**: 🆕 **section 2.6, "execution scope"** — 🔴 **section 2.6.0, prerequisite A1** [`?scope=` was already taken by the
  model-configuration "model setting scope" with the same name and a different meaning, and the two grammars **both happen to have `global`**; decision = `?scope=` has exactly one platform-wide meaning = execution scope; the model-settings side is renamed `settingScope` with **no compatibility
  alias**] / grammar single author `lib/scope/scope.ts`, with targetId judgment reusing `isValidTargetId` / `readScope` **recognizes the URL only**, 🔴 **`x-bgp-target-id` is never introduced** [measured 0 occurrences in the whole repository; the root fix is for the header not to exist, not a
  runtime check] / **write routes never read scope** / `scopeFilter` **two kinds of resource, two methods** [scalar stamps use a DDB fragment; binding lists **must use in-memory filtering over `bindingTargets`**; copying the three-level fallback semantics into `contains(targets,…)` is forbidden] /
  never fall back to home · never fall back to global, four error codes / `GET /api/scope/counts` [warehouse direct-query classes **do not enter** this endpoint: counting would wake every region's serverless warehouse = one click costs money] / `Leaf` gains **two mandatory fields `scope` +
  `scopeWired`** [omit them and tsc goes red; pages not yet wired show a permanent "Showing all regions" hint bar — silence is worse than losing things] + **the single-target equivalence rule** / 9 non-menu pages registered separately [page routes total **40**] / six gates. Sections 2.4 and 2.5 are
  empty numbers) revision 3.33 (🆕 2026-09-08 **zero-egress execution environments · contract landing** [the ten measured spike results are in the work-package plan]: 🆕 **section 3.16**, three invariants / the endpoint list fixed by the runtime's real boto3 calls [`s3tables` and
  `redshift-serverless` added, cross-region KMS removed] / **the only cross-region path = a cross-region DynamoDB interface endpoint + a Route 53 private hosted zone, zero product-code change** [the originally planned peering was overturned: home and the three execution-environment VPCs all have
  CIDR `10.0.0.0/16`] / job-lock conditional-write semantics preserved across regions [Global Tables still vetoed] / 🔴 the prerequisite grant `vpce:AllowMultiRegion` must be given verbatim to the **cfn-exec role** [wildcard policies do not cover it, Administrator is also refused; decided to grant
  only to it] / section 1.1 resource bag +`endpointIds?` · `crossRegionDdbEndpointId?` · `homeLinkHostedZoneId?` with `peeringConnectionId` not set / `networkProfile` and `-c exec-env-nat-gateways` retire / probes +`network:egress-none` · `network:home-link`, which must retry with backoff [endpoint
  available ≠ usable, propagation window 2–3 minutes] / switching existing installations does not replace the VPC) revision 3.32 (🔴 2026-09-07 **serverless-scheduling real-environment correction**: section 3.15 decommission semantics add "**stopping must wait for a terminal state**" — after
  `StopWorkflowRun` you must poll until no non-terminal run remains before `DeleteWorkflow` (the service's words: Cannot delete workflow resource while workflow runs are in progress), conflicts retry with backoff; 🔴 **a failed decommission never clears the ledger**
  (`deployments[targetId].workflowArn` is the platform's only clue for recovering an orphan workflow; clearing it means "keeps running on cron while the platform believes it is decommissioned"), and the two schedule routes report 502 and do **not** set `scheduleEnabled=false`) revision 3.31 (🔴
  2026-09-07 **serverless-scheduling real-environment corrections**: section 1.2, the **uniqueness rule for ledger row keys lands** [one row = one (job × target × run); the scheduler-side raw id is deterministic ⇒ it must be composed as `<raw>#<targetId>` with `taskTargetKey` stored; **for
  serverless the raw id is the service-side per-run dag_id `ex_<uuid>`** — the Airflow `run_id` degenerates into a constant under MWAA Serverless; measured: two regions, two rows, same key, the later write overwrote the earlier] + the four scheduler-side writers converge on the single author
  `lib/monitor/run-key.ts` + a ledger **write that fails refuses** (previously swallowed by print = that run does not exist on the dashboard); section 3.15, the runtime **no longer writes runType** [the worker side cannot distinguish cron from manual: measured, run_id is equally constant, run_type
  equally `DagRunType.SCHEDULED`, conf empty, `OverrideParameters` does not enter environment variables]; the truth for the trigger source = service-side `GetWorkflowRun.RunType`, shown on demand by the log dialog) revision 3.30 (🔴 2026-09-07 **serverless-scheduling real-environment correction**:
  section 3.15, the runtime **Code package = zip (module `bgp_runtime.py` at the root)** [a bare `.py`: CreateWorkflow succeeds, the workflow is READY, cron triggers as usual, and every run dies with `ModuleNotFoundError: No module named 'bgp_runtime'` — the spike had long established "zip, module
  at root", but construction wrote "no zip" from an unverified assumption]; packaging converges on the single author `code-package.ts` (fixed zip timestamp ⇒ same content, same bytes), and `runtime-py.ts` no longer exports the S3 key) revision 3.29 (🔴 2026-09-07 **serverless-scheduling
  real-environment correction**: section 3.15, the platform TaskRole's `airflow-serverless:CreateWorkflow` gets its own statement with **Resource `*`** [the action does not support resource-level permissions; the service reports it as workflow/*; a name qualifier bgp* never matches ⇒ publishing in
  two regions on three engines all fell at the first step; still bound to the execution-region condition]; 🆕 **IAM simulation gate** (`infra/iam/platform-taskrole-calls.json`, the platform's real call list + `scripts/iam-simulate-gate.py` SimulatePrincipalPolicy, hooked into redeploy step 4 and the
  start of the serverless acceptance segment) makes the three classes of IAM defect "action missing / resource pattern wrong / FAS calls the service makes on the caller's behalf" go red within 10 seconds of deployment; the other two corrections = the FAS-created log group lacked logs:CreateLogGroup,
  and each delegated CreateServiceLinkedRole lacked permission; the full FAS set on the success path is just these two) revision 3.28 (🔴 2026-09-06 **first serverless-scheduling real-environment correction**: sections 1.1 / 2.1, seed-home 🆕 **the add-only adoption channel `adoptHomeComponents` for
  home components** [while home is already serving, components newly built by the control plane (such as `BgpAirflowServerlessStack`) can enter the descriptor only through it: home only / add only, no modification / `spec.desiredComponents` · `observed.components` · `components` synchronized in all
  three places / written only when this round's real probe is all green and covers all components / conditional write on version ∧ ready ∧ no in-flight session; the original route through reconcileTarget was refused by the maintenance-state gate in the real environment, HTTP 500] · section 3.5, the
  broker's top-level projection comparison becomes **canonical** [comparing the top-level `components` byte-for-byte against the normalized `observed.components` judged bad-descriptor in the real environment; the descriptor itself was consistent, only ordered differently] · section 3.5, the
  session-opening snapshot hash `openSnapshotHash` takes **set semantics** for `components` (a sorted copy; computed in order, the Update that opens the session reorders the top-level components so the post-image hash can never match ⇒ the operation stays stuck) · section 3.5b, recovery of a
  session without buildId gains **a second piece of evidence**, "the CodeBuild project list has no build for that operation" (trustworthy once the session is ≥ 5 min old; if it hits, judge by its real terminal state), no longer relying only on the 2h15m structural window · the broker's full
  component set is enumerated and injected by `context.ts` [it no longer holds a third copy of the list]) revision 3.27 (🔴 2026-09-06 **the MWAA Serverless scheduling entry** [verbatim decision in [the design document](./multi-region-execution-design.md), section 18, decision 6septies: classic MWAA
  is kept, a serverless entry is added, decommissioning is discussed after every region works; acceptance = headless + ≥ 2 regions + every scheduled task truly runs on three engines]: section 1.1 🆕 optional component `airflow-serverless` (resource bag `workflowBucket` / `airflowServerlessRoleArn` /
  `airflowServerlessSgId`; `schedulerPreference?`) · section 2.1, the 409 code of the three schedule routes 🔴 corrected `MWAA_NOT_INSTALLED` → `SCHEDULER_NOT_INSTALLED` (the old code is an alias for one release) · 🆕 **section 3.15, the serverless scheduling endpoint** [union-typed endpoint resolver
  / dag-factory YAML + code package / workflow lifecycle mapping / 🔴 VPC mode mandatory (the default network cannot reach cross-region endpoints, established by the spike) / quotas and the 60-minute rule] · section 1.1 `networkProfile` (a known constraint: each execution environment with 2 NATs = 2
  EIPs, default quota 5 per region ⇒ at most 2 execution environments per region; 🆕 a lean profile with 1 NAT + a quota pre-check before deployment)) revision 3.26 (🔴 2026-09-06 **in-region scheduling = each execution environment's own MWAA** [verbatim decision in [the design
  document](./multi-region-execution-design.md), section 18, decision 6sexies: "each region's scheduled tasks are executed by that region's own MWAA; cross-region scheduling is not allowed"]: section 1.1, the `mwaa` component moves from "legal but not implemented" to **implemented** (stack
  `BgpExecEnv-<slug>-mwaa`, resource bag `dagBucket`/`mwaaEnvName` unchanged) · 🆕 **section 3.14, in-region scheduling** [MWAA endpoint resolver single author `mwaaEndpointFor(targetId)` / scheduled artifacts · unmount · decommission · logs all land in that target's MWAA, home byte-for-byte
  unchanged / control-plane write-back = the only cross-region exception / stack group 🆕 `-c exec-env-home-region`] · section 2.1, the three scheduling entries without `mwaa` ⇒ **409 `MWAA_NOT_INSTALLED`** (corrects the 400 written in revision 3.25; same "user-fixable" class of refusal as
  `TargetBindingRejected`, 409 site-wide; response `detail.missing[]` + `detail.fix{label,href}`) · section 3.12, `offlineDag(dagId,targetId)` ✅ landed; EMR engine scheduling fans out per target (absorbing the EMR-scheduling work). The target dimension of workflows goes to the workflow work.
  Construction package in the work-package plan; recorded in the roadmap) revision 3.25 (🔴 2026-09-05, second-stage real-environment correction: 🆕 section 2.1 `GET .../[targetId]/statements?auditId=` — the correlation look-back endpoint required by the audit-correlation acceptance criterion [the
  Data API's ListStatements / DescribeStatement are isolated **by caller IAM identity** and DescribeStatement does not return StatementName ⇒ only the platform TaskRole can see `StatementName == auditId`; without this endpoint layer nobody can observe the correlation; TaskRole
  +`redshift-data:ListStatements`; returns only id / status / time, **no SQL**]) revision 3.24 (🔴 2026-09-05, second-stage construction correction: section 3.2, the execute audit is written before submission, the row has no statementId, cross-jurisdiction statements use `auditId` as the Redshift
  `StatementName` [statement ↔ audit correlation]; not set for home) revision 3.23 (🔴 2026-09-05 **parallel wave 1 contract freeze**: 🆕 **section 3.9c, registry of decommissioned capabilities** — `data-service` was decommissioned on 2026-09-05 [menu / page / admin API / lib removed,
  `/api/public/data/**` now 410, three tables kept; the BI `dataapi` data source went with it; the shared pieces `renderSql` / `coerceParams` moved byte-for-byte to `lib/sql/param-render.ts`], and the section 3.9a feature-conservation list was trimmed accordingly; **section 3.2, second-stage
  construction detail** [`entry` enum / the regional audit of scheduled runs is written afterwards by platform observation / the central SQL-history row for a cross-jurisdiction target stores no sqlText, the original text goes to the regional results table, `GET
  /api/redshift/history/[historyId]/sql` reads by proxy [correcting the original handleId] / `POST /api/residency/ack` input +`textHash` / 409 · 503 response shapes / S13 gains GSI byTarget]) revision 3.22 (🔴 2026-09-05 **residency-audit contract first · no legal gate ([the design
  document](./multi-region-execution-design.md), section 18, decision 6quinquies)**: section 3.2, the `residencyGuard` / `classifyTrack` track-judging refusal is **void**, replaced by **`residencyAudit`** [no track judgment, no refusal; allow-listed entries; regional full record + central summary
  dual write; failure to write refuses with `audit-unavailable`; `authKind` is only an audit field] · section 1.1 🆕 `access?` (project allow-list, **generic**, default all-projects) + 🆕 `residencyAck?` (mandatory when registering a cross-jurisdiction target, immutable afterwards) + `jurisdiction`
  format `^[a-z][a-z0-9-]{1,31}$` · section 1.3a 🆕 **S13** `bgp-residency-acks` (append-only) + S4 table names fixed `bgp-region-audit-<slug>` / `bgp-region-results-<slug>` + the regional results bucket (RETAIN / CMK / deny replication) · section 2.1 🆕 `POST .../[targetId]/access` / `GET
  .../[targetId]/acks` / register +`residencyAck` / data plane `POST /api/residency/ack`; the pre-gate is rewritten as the **technical prerequisite** `residencyPrerequisite` (residency-api ∈ components ∧ per-target execution roles complete; **no legal switch**) · section 3.3, dual-write shape +
  tamper-proof Deny of three actions · section 3.12, RBAC × target = the project allow-list is generic, the regional administrator role → the follow-up residency work · section 6.4, `residencyApproval` deleted · section 6.7, go-live condition = residency-api slice 1 + per-target roles + an
  auditable closed loop. Construction package in the work-package plan; recorded in the roadmap) revision 3.21 (🔴 2026-09-05 **two IAM compliance gates · contract delta**: section 6.1, passage two, landing rules [**four classes** of per-target execution role, glue / emr / redshift-copy /
  dms-kinesis, created by the exec-env stack group together with the target; the core stack's `glueRoleArn` **now emits this target's role** and gains `emrExecutionRoleArn`, the redshift stack `redshiftCopyRoleArn` [attached as the namespace default role], the dms stack `dmsKinesisRoleArn`; trust
  bound to `aws:SourceAccount` [EMR additionally binds `aws:SourceArn` to this region]; every `Resource:*` statement carries `aws:RequestedRegion=this region`; the platform TaskRole's `iam:PassRole` opens the four patterns `BgpExecEnv-*-{glue,emr,redshift-copy,dms-kinesis}-role`, flink still
  registered] · sections 1.1 / 3.1a, resource bag +3 keys, the **execution-role key** rule [a non-home value must equal, to the letter, this target's name from the naming SSOT = the data plane's fail-closed criterion; existing home names are not condemned in section 3.1a but guarded by two gates,
  the admission prerequisite + data-plane resolution] · 🔴 **two contract gaps surveyed at the start of work and filled in this revision**: ① finalize of an enabled target had only the "add only, no modification" narrow channel, so **neither changing a role nor adding core keys could get in** ⇒ the
  narrow channel's sole exception = execution-role keys being "added" or switched **one way** from "home name → this target's name" [decidable by the SSOT; not a byte of buckets / workgroups is touched]; ② once the source package changes, existing targets become `drift-unauthorized` and must be
  approved, but `deploy` did not accept `approvedPlanHash` and `preview` refused an identical set ⇒ **"Redeploy" simply could not proceed after source drift** ⇒ section 2.1, `preview` accepts "the same full set as installed" = **upgrade rehearsal**, `deploy` accepts an optional `approvedPlanHash`,
  "Redeploy" = rehearsal → approval → deploy · section 6.2, collection-window correction [complete only after the first deployment of a third target + added components + the temporary target's destruction; narrowing moves after step 7 of the residency-audit construction]. Recorded in the roadmap)
  revision 3.20 (🔴 2026-09-05 **unbind + cleanup of landed artifacts**: section 3.8 adds the explicit three actions for modeling artifacts, "unbind only / unbind and clean up / delete definition (controlled)" ⇒ the "residue" state can from now on be constructed in the real environment and the
  corresponding acceptance item moves from registered to truly tested; the same day it was decided "no legal gate, only auditability + retained acceptance of the disclaimer", whose contract correction lands with step 1 of the residency-audit construction) revision 3.19 (✅ 2026-09-05 **the three
  data-gate fields of the fan-out tickets**: section 1.3a gains row **S6** — `bgp-cost-runs` +`{projectId,targetId}` [cost rows inherit the run's stamp; existing rows are back-filled from run rows by conditional write; no stamp ⇒ home is not guessed] · `bgp-task-runs` +`runGroupId` [`rg_<ULID>`;
  the same value across a multi-region fan-out, no attribute for a single region; enters only as a first-class parameter of the write channel] · `bgp-datasources` +`ownerTargetId` [existing rows normalized to `tgt_home`, new rows stamped at creation, PUT cannot change it]. All three are "data first,
  wiring later": the gate on the cost of turning back lies in the data, not the code. Recorded in the roadmap; interaction decision in [the interaction design](./multi-region-execution-interaction.md), section 9) revision 3.18 (🔴 2026-09-04 **metadata-mirror landing decisions**: section 3.13 gains
  **six** rules [① sources = Glue on schedule + Redshift **manual only** [cost: scheduled collection would keep every region's serverless warehouse permanently awake]; Lake Formation / OpenMetadata are not sources [LF permissions are not yet per-target; OpenMetadata is a central single instance
  ingesting only home] · ② `column`/`lineage-edge` keep only their key space and are not written [columns travel with the table payload; lineage edges **have no target dimension centrally**, so no per-region counts are fabricated] · ③ the facet index goes in a separate `mirror#__facets` partition
  [avoids a full-table Scan] · ④ deleted tables **disappear immediately** and only the sources collected in this round are deleted [otherwise the Glue schedule would wipe the manually collected warehouse catalog] · ⑤ `stale:boolean` becomes the five states `fresh|stale|expired|never|failed` and
  **the read side judges ttl itself** [DDB lazy deletion lags 48 h] · ⑥ partial failures leave a trace per source, and a failure keeps the last success time [showing "0 assets" is more dangerous than reporting an error]]; section 2.1 API row **corrected**: the read endpoints move **out of**
  `/api/admin/` from `/api/admin/metadata-mirror` [the middleware forces that whole segment to bgp-admin ⇒ implemented at the original path, the dashboard is one non-administrators cannot open]; the write endpoints stay on the admin surface. Recorded in the roadmap) revision 3.17 (🔴 2026-09-04
  **section 1.1a exit list gains a row**: Airflow `dag_id` and the DAG's S3 key → **the raw `targetId`** [non-home artifacts = `<base>__<targetId>`; dag_id allows `_`; by the list's rule "only exits that forbid `_` switch to the slug" ⇒ no switch, to avoid mixing two separators in one name], and
  the mapping is stated to be **one-way**, reverse-resolving the target from dag_id being forbidden [`TARGET_ID_RE` allows `__` inside the body, so the reverse is not unique; the authoritative record is the ledger `deployments[targetId].artifact`]. Decided when the fan-out deployment landed)
  revision 3.16 (🔴 2026-09-03 **mechanism correction for item ④ of the drift decision + the draining writer**: section 3.5c ④ originally said "use baselineRef to **replay** the old source (buildspec checkout)" — **impossible and not allowed** (the source is an immutable content-hashed CDK asset,
  and the first entry of the exclusion list is `.git`; the only thing that could swap the source, `sourceLocationOverride`, is already forbidden by the explicit IAM Deny of section 12.0 fix ①) ⇒ changed to "**drift visible + explicit waves + fail-closed**", 5 judgment rules + `planHash` includes
  sourceRef + the limitation "a lagging target cannot be switched back to keep using the old source" is stated explicitly. Recorded in [the design document](./multi-region-execution-design.md), sections 20.26a / 20.27) revision 3.16 (🔴 2026-09-01 **root fix of status in the execution-environment
  stack-group construction batch**: `status`, one field, carried the three meanings lifecycle × health × in-flight operation and was written by 6 places each hard-coding its own previous state ⇒ two earlier defects were the same mechanism firing twice, and the real environment produced the
  impossible shape `initializing ∧ ready=true`. **Split into two orthogonal field groups, spec (desired) / observed (observed), + a single reconciler controller**: API/broker write only spec, observed is written only by the controller; `status` is demoted to a **derived compatibility projection**
  (value set unchanged, compatible with old readers during the transition); admission becomes a **single derived judgment**. `observed.phase` has an authoritative transition table; `observed.operation` replaces the resumeStatus-style workaround; the dead field `observedVersion` is revived as
  `observed.templateVersion`. Additive migration, zero scripts, the controller **adopts** existing items and self-heals. Recorded in [the design document](./multi-region-execution-design.md), section 20.23) revision 3.14 (🔴 2026-09-01 **execution-environment stack-group construction batch**:
  section 2.1, `add-components` lands (full-set semantics / add only, never remove / unimplemented component 400 / cross-jurisdiction 403 / zero writes to the registry); component stacks implemented **redshift/dms/flink** (mwaa/kafka/agentcore/residency-api still unimplemented); `components` is now
  **purely observed** (the desired/observed separation fields come in a separate batch). Recorded in [the design document](./multi-region-execution-design.md), section 20.22) revision 3.13 (🔴 2026-09-01 **deployment-orchestration construction phase**: section 3.5 adds the **stale-lock takeover**
  contract [three necessary conditions + a doubly bound conditional write + residual risk honestly recorded]; section 2.1, build-status gains an optional `?buildId=` [a race between the first pull and the broker's write-back, measured at page level]) revision 3.12 (🔴 2026-09-01
  **deployment-orchestration construction phase**: section 2.1, register **drops accountId/partition** (decided: strictly the control plane's own account; the server takes them itself, 400 if received, cross-partition 400) + adds the `POST seed-home` row (the home seed entry lands). Recorded in
  [the design document](./multi-region-execution-design.md), section 20.20) revision 3.11 (🔴 2026-09-01 **deployment-orchestration construction phase, slices d+e**: section 1.1, the reconcile ready condition's **internal contract collision is resolved** ("missing counts as false" — section 2.1
  register is by contract not allowed to set ready; read literally per revision 3.7, a freshly registered item could never enter the write-back); section 2.1, probe/enable land (probe = finalize → real probe → persist → set ready, a closed loop), canary moves to slice g. Recorded in [the design
  document](./multi-region-execution-design.md), section 20.18) revision 3.10 (🔴 2026-09-01 **deployment-orchestration construction phase, slice c**: section 2.1 gains `GET [targetId]` and the probe/enable registration (assigned to slice d); the deploy request's **`operationId` is now generated
  server-side** (the lock token and audit key may not be client-specified, same precedent as targetId); list states the raw rule explicitly. Recorded in [the design document](./multi-region-execution-design.md), section 20.17) revision 3.9 (🔴 2026-09-01 **deployment-orchestration construction phase,
  slice a**: section 3.5, the stack-group name is corrected to `BgpExecEnv-<targetSlug>-*` (originally written `<targetId>`, which contains `_`, an illegal CFN stack name; built to the letter, no stack could be created); stack-group inputs and gates in [the design
  document](./multi-region-execution-design.md), sections 4.1a / 20.15) revision 3.8 (🔴 2026-08-31 **naming single source of truth**: section 6.5, the naming signature is **fixed again** as `resourceName(kind,{targetId,account?,component?})`, and derived keys take **`targetSlug`** (the revision 3.0
  version's `region + cellId(only for non-first)` is abandoned — "first" is registration-order state that a pure function cannot obtain); the naming-SSOT row is split into two construction slices. Rationale and record in [the design document](./multi-region-execution-design.md), sections 3.2 /
  20.14) revision 3.7 (🔴 2026-08-31 **fourth independent-review round, remediation (batch one: wrong contracts + dangerous right now)**: ① 🔴 **a contract the author had weakened is restored** — revision 3.6 had cut the section 1.1 reconcile condition from "`version`/`status`" to "only `version`" to
  accommodate the implementation; that was **changing the contract to fit the code** (entirely the wrong direction); it is now restored and the implementation completed: the condition binds **`version` + `ready=false` + `status ∈ maintenance states`** + **the candidate after merging the patch
  passes the section 3.1a validation as a whole**; ② section 3.9b, the **deadline must be enforceable** (strict parsing on the write side + must lie in the future + ≤ 30-day window; on the read side, expired ⇒ fail-closed — previously it was only stored, never enforced, and the shared admin could
  be used indefinitely); ③ section 1.1, seed idempotency **normalizes defaultable fields** (`jurisdiction`); ④ the **remaining 4** of the 12 old-semantics convergences ("auto-register / read-only fallback / deleting the item restores the status quo") + 3 clarifying pointers. 🔴 Still open: four
  review findings (the closed executor / per-project provisioning / migration of the real call surface); the **real-ownership evidence** for S3/AgentCore goes to the deployment-orchestration construction phase) revision 3.6 (🔴 2026-08-31 **third independent-review round, remediation landed (nine
  remediation items)**: ① section 1.1 defines the **single "complete" rule** for seed [whole-package validation ∧ ready=true ∧ status can accept work] + **an existing item must be compared with the expected values** [location identity unequal ⇒ conflict-mismatch]; ② section 1.1, **reconcile
  switches to an allow-list** `RECONCILE_ALLOWED_FIELDS` [a deny-list on a security load-bearing surface always leaks]; ③ section 1.1, stale gains a **2-minute future-clock tolerance** [`probe.at=2999` was fresh forever]; ④ section 3.1a adds **malformed keys that must be ARNs are refused / per-item
  shape / arrays element by element / component ↔ resource pairing**; ⑤ section 3.9b adds the **single write channel `advanceCredentialIsolationState()`** [previous-state + epoch condition, epoch++, no reverse API]. 🔴 Still open: four review findings [the closed executor + per-project provisioning
  + migration of the real call surface]) revision 3.5 (🔴 2026-08-31 **re-review corrections of the third independent-review round**: fixes two errors the author introduced in this document — ① the seed timing in section 1.1 cited "DESIGN §77/§83-85", a dangling reference that mistook **line
  numbers** for **section numbers**; ② this row's pointer "based on the design document, revision 3.2" was stale. 🔴 **The `stale` definition still lacks a "future-clock tolerance"** [`probe.at=2999` was measured to pass], and **the core completeness of section 3.1a lacks the component→resource
  pairing invariant**; both are fixed with the remediation items recorded in [the design document](./multi-region-execution-design.md), section 20.11; furthermore the domain-name spellings in sections 1.1a / 3.1, in the acceptance criteria and at lines 716/720 of this specification still collide
  and are converged in one go with a further remediation item) revision 3.4 (🔴 2026-08-31 **second independent-review round, second remediation batch**: ① **section 3.1, the admission judgment may not be cached + must use a strongly consistent read** [the original "60s TTL" was read by the
  implementation as "the whole descriptor enters a positive cache" ⇒ new runs were still admitted for 60 s after draining = the safety judgment bypassed] + **GSI explicitly forbidden for admission**, lists must paginate; ② **section 1.1 gains an enforceable definition of `stale`** [time source /
  threshold / non-home only / missing time source ⇒ stale] — previously it only said "stale ⇒ refuse" without ever defining it, so it could be neither implemented nor accepted; ③ **section 1.1, the home seed timing is fixed at deployment time**, the platform's read path is **read-only and never
  self-heals by writing the database**, and the real caller goes to the deployment-orchestration construction phase; ④ **section 1.1a, the `targetId` format is fixed** `^tgt_[a-z0-9](?:[a-z0-9_]{0,14}[a-z0-9])?$` [40→16 + first and last must be alphanumeric, eliminating `tgt_a_` → an illegal DNS
  label]; ⑤ **new section 3.1a, runtime whole-package validation of the descriptor** [replacing the bare `as ExecutionTarget`]; ⑥ **section 1.1, `components/capabilities` `SS`→`L`** + GSI sk naming corrected. 🔴 **Feature conservation**: zero features deleted in this batch) revision 3.3 (🔴
  2026-08-31 **second independent-review round remediation · decided A+B+C**: ① section 3.9, project-context abandons the `PER_PROJECT_CRED_READY` switch-style transition in favour of a **persisted, monotonic, irreversible** credential-isolation state machine [new section 3.9b + four fields in
  section 1.1]; ② the section 3.9a public interface **no longer accepts `statements[]`**, replaced by a structured `AdminDdlRequest` + module-private templates + a closed executor; ③ section 4.6 is added, splitting code-table landing into two layers [real code shows the old guard would condemn that
  feature]; ④ the regex guard is downgraded to non-authorizing defense in depth. 🔴 **Feature conservation**: SQL editor / code-table landing / DMS bootstrap / legacy fallback / 7 operations, none deleted. Based on the independent review's root-remediation proposal) revision 3.2
  (implementation-level technical design: table definitions / interface schemas / key-mechanism pseudocode / change list / acceptance) | Date: 2026-08-28 (revision 3.1: 2026-08-29) | Status: ⬜ in design, awaiting review
- 🎯 **Revision 3.1 changes (back-filled in the revision header — the body already contained 7 "🔴 revision 3.1 correction" notes while the header still said revision 3.0; completed during this convergence check)**: ① **GSI choice corrected** to `byTaskTarget(pk=<taskId>#<targetId>)` (the original
  `byTarget(pk=targetId)` cannot answer the target query: DDB `Limit` applies before the filter ⇒ `Limit:1` necessarily returns empty) + **back-fill is mandatory** (sections 1.2 / 6.8); ② 🆕 **`targetSlug`** (CFN stack names / DNS / ACM / IAM role names forbid `_`; without the slug, deployment fails
  at the first step, section 1.1a); ③ **dual read gains an `isHome` gate** (the original "on miss fall back to the old key" resurrected, at the result-table layer, the "fall back to home" forbidden throughout this document = a silent cross-jurisdiction, cross-border read, section 6.9); ④
  **`getPrivilegedCred` gains the `legacy-single-admin` transition state** (otherwise the fail-closed privileged-credential batch would immediately break home's execute/genbi/data-service, section 3.9); ⑤ **`/[id]/start` with a missing parameter may not default to `tgt_home`** (changed to "admit
  only when there is exactly one value, otherwise 400", section 2.3); ⑥ **lock coexistence period / separator / leak**, three corrections (section 3.6); ⑦ **the composite runId becomes a suffix** (a prefix would break 6 places with `ScanIndexForward:false+Limit:1` and 4 places with
  `startsWith("scheduled__")`, section 1.2).
- 🎯 **Revision 3.0 changes (carrying forward the design document's revisions 2.0/3.0)**: ① **immutable `targetId`** replaces "envId=region" (section 1); ② **composite `runId` + GSI for task-runs** (section 1.2, resolving the primary-key collision); ③ **run-lock identity includes targetId** (section
  3.6); ④ **queryHandle** (section 3.7; fixes the live IDOR and unifies with [the project-isolation design](./project-isolation.md), section 3.6); ⑤ **StartBuild narrow-privilege broker + deny override** (sections 2.1 / 3.5); ⑥ **lifecycle draining/fencing/failed** (sections 2.1 / 3.5); ⑦ tables /
  interfaces / mechanisms for **the four axes of section 19 + consumption/operations + differentiation** (sections 1.3 / 3.8–3.12); ⑧ **per-target privileged-credential factory** (section 3.9; a new load-bearing P0 of [the design document](./multi-region-execution-design.md), section 20.6-A); ⑨
  acceptance re-ordered per section 5, including **the standalone security fix (IDOR) as a prerequisite**; ⑩ **the four former "open before start" items of section 6 are decided** (decided on 2026-08-28: "go with the recommendations"): per-target roles land in two stages / cfn-exec-role collects
  first and narrows later / regional API DNS · TLS · WAF · JWT-aud fixed · PrivateLink not in phase one / replication objects get a skeleton only, not implemented ⇒ **this specification has no open items before start** (section 7).

</details>

---

## 0. 🔴 The standalone security fix (unrelated to multi-region; decided on 2026-08-28 to be "scheduled first")

> **Nature**: a **live privilege-escalation (IDOR) defect** in `redshift/result/[id]`, independent of any multi-region change; **a standalone batch, scheduled before the first multi-region construction phase**, which can go live and be rolled back on its own.

| Item | Content |
|---|---|
| **Defect** | `app/api/redshift/result/[id]/route.ts:11,28` fetches results by `statementId` alone, **with no owner/project/target check**; `resolveIdentity` (:36) only feeds column masking ⇒ **any signed-in user who knows a statementId can read another user's query results** (shielded only by column-level masking) |
| **Fix** | a server-side **queryHandle** (full mechanism in section 3.7): issued at submission; fetching results must present it and it is checked against `ownerSub/projectId`; mismatch ⇒ **403** |
| **Minimum closed loop for phase one** | the phase-one security fix needs only 🔴 **the five fields `{handleId(PK), statementId, ownerSub, projectId, expiresAt}`** (**`handleId` is the PK and must never be omitted** — omit it and it gets implemented as "key by statementId, fetch without parameters" = the IDOR is not fixed at all) to close the hole; the two fields `targetId/jurisdiction` are added with the data-residency construction phase (**create the table structure in full once, fill the writes in stages**, to avoid a second migration) |
| **Coverage** | every submission path that produces a "fetchable result" goes through `submitStatement()` uniformly (section 3.7); **missing one = a legitimate query cannot fetch its result** (a fail-closed false refusal), so all submission points must be enumerated first |
| **Acceptance** | user A uses user B's statementId → **403**; A fetches their own → 200; the **anonymous / api-key paths** are equally controlled; the audit records `who/statementId/result row count` |
| **Rollback** | the handle check is switchable (feature flag): switching it off restores the status quo (**for emergency rollback only**, not a normal mode) |

---

## 1. Table design (final)

### 1.1 New table `bgp-execution-envs` (control-plane DDB) — 🔴 sk = `targetId` (no longer the region)

| Key / attribute | Type | Description |
|---|---|---|
| `pk` (PK) | S | constant `"env"` |
| `sk` (SK) | S | 🔴 **`targetId`**: an immutable identity (e.g. `tgt_usw2_a`; format and `targetSlug` in section 1.1a); once created it **can be neither changed nor reused** ([the design document](./multi-region-execution-design.md), section 20.1-1; replaces the `envId=region` of revision 0.1) |
| `partition` / `accountId` / `region` / `cellId?` / `stage?` | S | **location and deployment attributes** (demoted to attributes): `aws\|aws-cn\|aws-us-gov` / account / region / multiple cells or blue-green within one region / dev · staging · prod (**orthogonal** to the environment axis of the multi-environment release module). "Which targets does a region have" goes through GSI `byRegion` (pk=`region`, **sk=`sk`** — 🔴 **revision 3.4 correction**: the sk **reuses the base table's `sk` attribute** [whose value is the targetId] rather than storing a separate `targetId` attribute as the index key. The original `sk=targetId` would require the same value under two attribute names, and any drift between the two misaligns the index; moreover changing a GSI key schema afterwards requires **deleting and recreating the index**. **A GSI is eventually consistent ⇒ forbidden for admission judgment**, see section 3.1) |
| `displayName` / `isHome` | S / BOOL | home has `isHome=true` and cannot be deleted |
| `jurisdiction` | S | jurisdiction label (default `home`); format 🔴 **revision 3.22** `^[a-z][a-z0-9-]{1,31}$` (the variants `Home` / `HOME` never enter the database). 🔴 **Revision 3.22 correction (decision 6quinquies)**: the original "`≠home` triggers the dual residency track (sections 3.2 / 3.3)" is void — it is **only a label + an audit dimension + the trigger condition of a technical prerequisite** (`residencyPrerequisite`: a non-home jurisdiction must have `residency-api` installed + per-target execution roles complete), and **drives no refusal**; it still **drives x-bgp-region routing / audit labels** |
| `status` | S | 🔴 **Root fix in revision 3.15 (execution-environment stack-group construction batch): status is demoted to a [derived compatibility projection] and is no longer an authoritative field written directly.** The authoritative model = the two orthogonal field groups `spec` (desired) + `observed` (observed) (see the two rows below). `status` is computed by the pure function `deriveStatusProjection(spec, observed)` (which reads `observed.{phase, health, operation, lastError}`); **the value set is unchanged** (`registered→initializing→testing→active→degraded→failed→upgrading→draining→decommissioning→deleted`, the full set of 10 states; the arrows are an enumeration, not a linear chain; the real transitions live in `observed.phase`), so that existing readers / UI / the broker's `DEPLOYABLE_STATUS` **keep working during the transition**.<br>🔴 **Nowhere in the repository writes status directly** (AST gate: **0** write points for `status`); to change the state, change `observed.phase` (sole writer = the reconciler / `lifecycle.ts`). The projection is a **total function** and **every one of the old 10 states is reachable** (pinned by a gate, preventing lost states).<br>**Root cause (not a patch)**: before revision 3.14, `status`, one field, carried the **three orthogonal meanings lifecycle × health × in-flight operation** and was written by **6 places each hard-coding its own previous state** (the broker set it unconditionally / seed landed directly on `active` / register landed directly on `registered` / `markTargetTested` recognized 2 states / `enableTarget` recognized 1 state / the probe route copied yet another set of 2 states) ⇒ **every new business path necessarily missed one previous-state combination**. The defect where a supplementary deployment's write-back was refused by the maintenance-state gate and the defect where the target could not return to `active` after a supplementary deployment were **the same mechanism firing twice**; the real environment produced the **impossible shape** `status=initializing ∧ ready=true` (8/8 all green yet unusable at runtime, with no way back from the page). And the writers for `drain/decommission/degraded` **were not yet written**; grown the old way they would certainly repeat the mistake ⇒ split into spec/observed + a single controller, eliminating the root cause **structurally** |
| `resources` | M | **named resource bag** (not derived): core `{datalakeBucket,scriptsBucket,tableBucket,athenaWorkgroup,emrSubnetIds[],emrSecurityGroupId,flinkSubnetIds[]?,glueRoleArn,emrExecutionRoleArn?}` (`emrExecutionRoleArn` is not retroactively mandatory for existing descriptors ⇒ marked `?` under the section 3.1a rule; for non-home it is **mandatory**, judged by the admission prerequisite `hasPerTargetExecRoles`, see below); optional component fields exist together with their component (`redshiftWorkgroup?/redshiftDatabase?/redshiftSecretArn?/redshiftCopyRoleArn?/dagBucket?/mwaaEnvName?/dmsSubnetGroup?/dmsKinesisRoleArn?/flinkRoleArn?/residencyAuditTable?/residencyResultsTable?/residencyBucket?`; 🆕 since revision 3.22 the last three exist with `residency-api`, section 1.3a S4). 🔴 **Revision 3.21 (IAM compliance gates) execution-role keys** = `glueRoleArn / emrExecutionRoleArn / redshiftCopyRoleArn / dmsKinesisRoleArn` (flink was per-target from the start): **for non-home, the value must be this target's own role** (the role name equals, to the letter, the naming SSOT `resourceName(kind,{targetId})`; the deployment-orchestration phase's decision to "reference the home role" is **void** — that was the transitional form of section 6.1, passage one); home goes through env, byte-for-byte equivalent, and seed is untouched. `emrExecutionRoleArn` / `redshiftCopyRoleArn` / `dmsKinesisRoleArn` are not retroactively mandatory for **existing** descriptors (otherwise they would be condemned on the spot before a redeploy); they are guarded by the two gates of the admission prerequisite `hasPerTargetExecRoles` (residency-audit work) and data-plane resolution (missing / not this target's name ⇒ throw) |
| `components` | **L** | 🔴 **Revision 3.15: this top-level field = a compatibility projection of `observed.components`** (the truth lives in observed; writer = the reconciler). Semantics unchanged: `core` + optional `redshift/kafka/mwaa/dms/flink/agentcore/residency-api/airflow-serverless` (🆕 revision 3.27: the `airflow-serverless` contract is in section 3.15; the component stack `BgpExecEnv-<slug>-airflow-serverless` landed with step 2 of the serverless-scheduling construction ⇒ it enters the enum [the contract-drift gate pins the specification enum = the code's `TARGET_COMPONENTS`]), **must contain `core`** (admission validation, section 3.1a). 🔴 **Revision 3.4 correction `SS`→`L`**: the DocumentClient reads a DDB Set back as a JS `Set` object ⇒ `JSON.stringify` yields `{}` (the control-plane API emits empty directly), and **a DDB Set may not be empty** (clearing the components would have to become deleting the attribute). Use List, consistent with every other array attribute in the repository  🔴 **Revision 3.26**: `mwaa` moves from "legal but the stack group does not implement it" to **implemented** (in-region scheduling work; stack `BgpExecEnv-<slug>-mwaa`, which builds that target's own Airflow environment + DAG bucket + execution role); still unimplemented = `kafka` / `agentcore`.|
| `capabilities` | **L** | the capability set derived from components (for pre-deployment validation, section 3.5). 🔴 **Optional, and may not be used for permission decisions** (section 3.9b: "may be used to display capabilities, cannot replace the permission state machine"). **The capability vocabulary and derivation rules are not finalized ⇒ assigned to the deployment-orchestration construction phase** (the owner of the pre-deployment validation in section 3.5); until then admission only checks "if present, it must be an array of strings" and **may not refuse for absence** (refusing on absence would turn "an undefined vocabulary" into a gate nobody can pass)|
| `desiredVersion` / `observedVersion` | S | 🔴 **Revision 3.15 merge**: `desiredVersion → spec.desiredTemplateVersion`, `observedVersion → observed.templateVersion` (previously **declared dead fields that never had a writer**; `observedVersion` was always null); the semantics of separating desired/observed template versions are unchanged, they only move into their authoritative groups, and the reconciler writes the observed side back from DescribeStacks |
| `agentcore?` | M | `{genbiRuntimeArn,genbiMemoryId,gatewayUrl}` |
| 🆕 `access?` | M | 🔴 **Revision 3.22 (residency-audit work; generic, not specialized for cross-jurisdiction)**: `{mode:"all-projects"} \| {mode:"allowlist", projects:string[]}`, default all-projects; **any target may set it**. Single author of the judgment `accessAllows(t, projectId)` (`lib/exec-env/residency.ts`); the third parameter of `assertBindableTarget(targetId, component, {projectId})` evaluates it ⇒ refusal reason `project-not-allowed`; `listRedshiftCapableTargets({projectId})` / `GET /api/exec-targets` filter with the same function (presentation = authorization). **Only the dedicated endpoint** `POST .../[targetId]/access` may write it (bgp-admin, full-set semantics, audit `exec-env.access.set`); the PUT writable set / the reconcile allow-list / the narrow channel **never accept it** (covered by a mutation test) |
| 🆕 `residencyAck?` | M | 🔴 **Revision 3.22 (residency-audit work; supplementary decision of 2026-09-05: "a dialog states the responsibility disclaimer … retain the user's choice to avoid disputes")**: `{by:<adminSub>, at, version, textHash}` — **mandatory** when registering a target with **`jurisdiction≠home`** (the register input `residencyAck:{version, textHash}` must equal, to the letter, the current version / text hash of `lib/residency/disclaimer.ts`, otherwise 400), and **immutable** afterwards (part of the field set only dedicated endpoints may write). Wording and version have a **single author**, `disclaimer.ts`; each user's consent is stored separately in S13 (`bgp-residency-acks`, see section 1.3a) |
| `probe` | M | `{at,ok,items:[{name,ok,error?}]}` |
| `ready` | BOOL | 🔴 **Revision 3.15: demoted to a derived projection** = `observed.phase ∈ {ready, draining, decommissioning}` (= "has been fully written at least once"). Semantics unchanged (the runtime recognizes only `ready=true`), but it is **no longer written directly**; the truth is `observed.phase`. Existing items (with `ready` but no `observed`) have their phase inferred from it when the controller **adopts** them |
| `lockEpoch` | N | 🔴 **fencing epoch**: incremented for every new operation; an old operation, even if it recovers, **cannot write state or destroy resources** because its epoch is stale (section 3.5). When an operation is opened it is **snapshotted into `observed.operation.lockEpoch`**, and the completing party uses it to prove it is clearing the same session (second independent-review round, section 4.1) |
| 🆕 `spec` | M | 🔴 **Revision 3.15 desired state (written by people / API / broker, declaring intent)** = `{intent: "serve"\|"drain"\|"delete"(default serve), desiredComponents:[…](must contain core), desiredTemplateVersion?}`. It supplies the desired state that section 3.5 promised but that **had no home** (since revision 3.14 `components` is purely observed ⇒ after a failed deployment nobody remembered "what we meant to install"). The broker **writes only** `spec.desiredComponents` (taken from the allow-listed input `components`) — 🔴 **never add a broker input for this** (the input allow-list of section 12.0 is the gate on the attack surface). `intent` is the **source of intent** for the deletion flow (section 3.5) and for admission: `serve` → serviceable, `drain/delete` → draining / retiring |
| 🆕 `observed` | M | 🔴 **Revision 3.15 observed state (section 3.5; write-permission model below)** = `{phase, health, components:[…], templateVersion?, probe:{at,ok,items[]}, operation?, lastReconcileAt?, lastError?}`.<br>🔴 **Write-permission model (decisions A/B following the second independent-review round)**: `phase`/`health`/`components`/`templateVersion`/`probe`/`lastError` are **written only by the reconciler / `lifecycle.ts` through `transitionPhase`**; `operation` is **opened / attached by the broker** (the only "cross-runtime controller adapter") and **cleared by the completing party / reconciler** — the broker only opens operations and **never writes `phase`**.<br>**phase** (lifecycle, **authoritative transition table `PHASE_EDGES`**): `registered→{provisioning}` / `provisioning→{verifying}` / `verifying→{ready, provisioning}` / `ready→{draining}` / `draining→{decommissioning}` / `decommissioning→{gone}` / `gone→{}` (terminal). 🔴 **Self-transitions (`from===to`) are not ordinary edges and require restricted authorization** (second independent-review round; [the design document](./multi-region-execution-design.md), section 20.3): a failed first deployment **stays in `provisioning`** + sets `observed.lastError` (projection `failed`); a retry = `provisioning→provisioning` (must carry a legacy fence) — **no new `failed` phase, no fallback to `registered`** (contradiction B of the second review round: the old text `provisioning→registered (fallback on failure)` did not match the implementation; corrected to keep the self-loop); **a supplementary deployment of an already-ready target = `ready→ready`** (only sets / clears `operation`, the phase never leaves ready ⇒ the "cannot return to active" defect vanishes from the model), and completion must carry a completion fence (section 3.5). Health lives on the health axis and **does not occupy phase**.<br>**health**: `unknown\|healthy\|degraded` (from probes, may flap).<br>**operation?** = the in-flight deploy / drain session (opened / attached by the broker, cleared by the completing party / reconciler): `{kind:"deploy"\|"drain", operationId, lockEpoch, openSnapshotHash?(mandatory for deploy), buildId?, startedAt, disruptive, startUncertain?, attachUncertain?}`. 🔴 **`lockEpoch` enters the operation** (second independent-review round, section 4.1): the completing party uses it to prove it is clearing **the same** session, not a later-started new op. `disruptive` = whether it touches the stateful core stacks (section 12.6 / the drift-decision criterion; **always true until the baseline validation lands**). 🔴 **Write order (decision C / section 4.2 following the second independent-review round)**: the broker **first persists `operation` (in the same conditional write as the lock), then `StartBuild`**, and on success attaches `buildId` under the exact op/epoch; if `cb.send` throws = acceptance unknown ⇒ best-effort record `startUncertain`, **do not write lastError, do not clear operation / lock** (keep the block for the recoverer). **Never** `acquire lock→StartBuild→best-effort mark` (a window in which the infrastructure is already changing while the target is still admitted).<br>**components/templateVersion** are **written back** by the reconciler from DescribeStacks / probes (replacing the old purely observed top-level `components` and the dead field `observedVersion`).<br>🔴 **Three-way descriptor classification (contradiction D / decision B following the second review round, fail-closed)**: `spec`/`observed` **both absent** ⇒ `legacy` (adopted **conservatively** from the old fields — 🔴 **ready is not inferred from the stored `probe.ok`**, refusal list item 12; the stale-descriptor acceptance item self-heals only through this round's fresh probe, section 7); **both present and schema-legal** ⇒ `modern`; **only one side (half-written) / illegal fields** ⇒ `invalid`, **admission refuses outright and never guesses legacy**.<br>🔴 **Admission = a derived judgment** (a single function, replacing the old enumerated-subset check of `unusableReason`; the audit surface does not grow): `classifyDescriptor≠invalid ∧ no top-level residual deploy lock ∧ spec.intent=="serve" ∧ phase=="ready" ∧ health∈{healthy,degraded} ∧ fresh(probe) ∧ observed.operation absent`. 🔴 **health fails closed (contradiction C)**: only `healthy`/`degraded` are serviceable, **`unknown` accepts no work** (the old text `health≠down` would have treated `ready∧unknown` as serviceable). 🔴 **Refuse any operation ([the design document](./multi-region-execution-design.md), section 20.2)**: not only `disruptive` ones — corrupted data writing `disruptive` as `false` must be refused too; the top-level residual lock is checked **before** the legacy/modern split (otherwise a legacy stable item bypasses the operation check).<br>🔴 **Completion state (decision D)**: after finalize succeeds and this round's candidate is all green, close with one conditional write on `version`+`phase`+`operationId`+`operation.lockEpoch`+**this round's `probe` identity** (`probe.at`; section 8: a raw probe ≠ accepted evidence), **clearing `operation` and the deployment lock in the same write** (atomic); if any condition is not met, keep the block, re-read and retry. **During a non-disruptive upgrade the phase always stays at ready** (admission resumes automatically once the operation is cleared) ⇒ **resumeStatus is no longer needed** ("where to go back to" does not exist in the correct model).<br>🔴 The observed fields **are not in `RECONCILE_ALLOWED_FIELDS`**: they belong to the controller and may not be changed through the "patch existing data" channel |
| 🆕 `credentialIsolationState` | S | 🔴 **Revision 3.3 (decision A)**: `legacy-seeded \| provisioning \| isolated`. **Monotonic and irreversible**; missing / unknown ⇒ refuse + alert, **never implicitly treated as legacy**. Authoritative semantics in **section 3.9b** |
| 🆕 `credentialEpoch` | N | credential generation. `++` on every state transition / secret rotation; **enters the credential cache key**, so caches from an old epoch can no longer hit (section 3.9b) |
| 🆕 `credentialStateUpdatedAt` | S | timestamp of the state transition (for audit and timeout judgment) |
| 🆕 `provisioningOperationId?` / `provisioningDeadlineAt?` | S | the operation id and **deadline** of the `provisioning` window (timeouts must alert; the fallback may not be open-ended) |
| `createdBy/updatedAt/version` | — | audit + optimistic locking |

- `RemovalPolicy.RETAIN`. 🔴 **Revision 3.7 corrects the rollback semantics**: the original "rollback = delete the item to restore the status quo" is void — after the item is deleted, the paths that depend on the descriptor are **fail-closed** (not "back to the status quo"). Real rollback relies on **not wiring it** (the construction batch that introduces it has zero production callers).
- 🔴 **Revision 3.4 correction — the seed timing of the home descriptor**: the original "the home target is **auto-registered** (named after the status quo)" was too broad and was read by the implementation as "**if the read path finds it missing it writes one itself**", so **the first runtime request to arrive** would race to land a descriptor with `accountId=""`, missing core resources, yet `ready=true`, and the conditional write would **lock it in forever** (second independent-review round, a P1 finding). **Decision**:
  - **the platform's read paths are strictly read-only**; when home is found missing / incomplete ⇒ **fail closed with an error pointing to the seed entry**, 🔴 **never write the database from a read path, never self-heal**;
  - the seed is executed at **the end of deployment** (the home-descriptor entry of [the design document](./multi-region-execution-design.md), section 2.1, + the deployment-orchestration batch of its section 17; 🔴 **revision 3.5 correction**: this place originally cited "DESIGN §77/§83-85", mistaking the **line numbers** supplied by the independent review for **section numbers**; those two sections do not exist), with a **complete named descriptor** as input (not guessed from env); it passes the section 3.1a whole-package validation before writing, and **nothing is written if validation fails**;
  - 🔴 **Revision 3.5 — the single definition of "complete" (third independent-review round, a P1 finding)**: `descriptorSeedViolation()` = **section 3.1a whole-package validation ∧ "fully written and able to accept work"** (i.e. `ready === true` and `status ∈ {active, degraded}`).<br>Previously the implementation called only the whole-package validation, while `ready`/`status` belonged to another function ⇒ **each function was right on its own and together they left a gap**: with `ready:false` the item was still `created` and truly written to the database (measured). **"Complete" must be defined by this one function; separate interpretations are not allowed.**
  - 🔴 **Revision 3.5 — when it already exists it must be compared with [this run's expected values]**: after a strongly consistent read-back, the **location-identity fields** (`partition`/`accountId`/`region`/`jurisdiction`/`cellId`/`stage`) must be equal field by field for idempotent success; unequal ⇒ **`conflict-mismatch`** (measured: a home item belonging to **another account** had been judged `already-complete`; the deployment script believed it had succeeded and the platform was connected to another account). Differences in **content fields** (`resources`/`components`/…) **are reported but do not block** (manual operator edits are legitimate, which is also the original intent of "never overwrite an existing item"), but `contentDrift` must be returned for the deployer to decide.
  - 🔴 **Revision 3.28 — "add-only adoption" while home is already serving** (first serverless-scheduling real-environment correction): home's components are built by **control-plane stacks** (deploy-all 6.6 / redeploy section 2c), not through the broker ⇒ there is no deployment session to carry; `reconcileTarget` is a maintenance-state gate (active is always refused — measured: seed-home HTTP 500 "can only patch maintenance states"). Decision: for a home that already exists with `ready=true ∧ status=active`, `seed-home` goes through **`adoptHomeComponents`**: ① home only; ② **add only, no modification** (the component set only grows; resource keys may only be the component-private keys of section 3.1a, and an existing key with a different value is refused); ③ `spec.desiredComponents` / `observed.components` / `components` **synchronized in all three places**; ④ written only when this round's real probe of the whole candidate package is **all green and covers every component** (the probe is persisted with it); ⑤ conditional write `version = :expected ∧ ready = true ∧ attribute_not_exists(observed.operation) ∧ attribute_not_exists(deployLockOperationId)`. No increment ⇒ idempotent zero write. This is **not** a loosening of reconcile; it is a second narrow channel resting on the same argument as `mergeComponentResources` (adding ≠ modifying); the write point is registered in `execution-env-writer-gate`.
  - existing incomplete items are patched with a **reconcile update conditioned on `version` + `ready` + `status`**, and 🔴 **an arbitrary `ConditionalCheckFailed` may not be treated as success across the board** (that would silently turn "there is already a bad item" into "seed succeeded");
  - 🔴 **Revision 3.5 — the modification surface of reconcile uses an [allow-list]** (the heaviest P1 finding of the third independent-review round): `RECONCILE_ALLOWED_FIELDS = `resources / components / capabilities / displayName / desiredVersion / observedVersion / agentcore / probe``, **everything else is refused**.<br>The original implementation was a **deny-list** (forbidding only `pk/sk/targetId/ready`) ⇒ this "patch" function could incidentally **revert** the **monotonic, irreversible** credential state machine just established in section 3.9b from `isolated → legacy-seeded` (measured: the write request went out normally), and could silently change `accountId/region/partition` (pointing the target at another account) and `jurisdiction` (changing the cross-jurisdiction judgment). **On a security load-bearing surface, "listing what is forbidden" always leaks; you must "list what is allowed".**<br>The other fields each have their dedicated channel: identity / location → section 2.1 `register`; `status`/`lockEpoch` → section 3.5 lifecycle; `ready` → set separately once complete; **credential state → `advanceCredentialIsolationState()` of section 3.9b**.
  - 🔴 **Revision 3.7 — reconcile's write preconditions and post-image validation (fourth independent-review round, a P1 finding)**:
    - **only items "not yet fully written" may be patched**: the condition expression must bind at the same time **`version` + `ready = false` [🔴 **revision 3.11 convergence: missing counts as false**] + `status ∈ {registered, initializing, testing, upgrading, degraded, failed}`** (i.e. the **maintenance states**). [Revision 3.11's reason for the convergence: the section 2.1 register contract is "land the identity skeleton, **do not set ready**", and DDB evaluates `#r = :false` as false for a **non-existent attribute** ⇒ written literally per revision 3.7, **every freshly registered item necessarily hits ConditionalCheckFailed and the deployment write-back can never get in** — two contract clauses collide. The **intent** of this clause is to block "an online target with ready=true having its routing changed"; a missing attribute already fails closed on the read side (`unusableReason`: ready!==true means unusable) ⇒ "missing" is synonymous with false; the implementation writes `(attribute_not_exists(#r) OR #r = :false)`, giving up no safety];
      🔴 **`active` / `draining` / `decommissioning` / `deleted` are always refused**. Reason: `resources` is a **routing input** and `probe` is a **freshness input** — changing these two on a target that is accepting traffic amounts to **changing routing online** without passing any lifecycle gate; changing them during `draining` is worse (it is about to be destroyed).
    - **the merged candidate must pass the section 3.1a validation as a whole package** before writing: validating only the patch fragment cannot stop "fragments each legal, combined they violate a cross-field invariant" (e.g. switching `resources.glueRoleArn` to another account, or deleting a component's paired resources).
    - 🔴 **Revision 3.7 correction record**: revision 3.6 had **changed this clause from the "`version`/`status` condition" to "only `version`"** — that was **changing the contract to fit the implementation**, entirely the wrong direction (the contract is the sole authority; when the implementation does not match, change the implementation). Restored and the implementation completed.
  - 🔴 **The real deployment-time caller (assembling a complete descriptor from CFN Outputs / live queries) belongs to the deployment-orchestration construction phase** — because `emrSecurityGroupId` must be queried at runtime and `components` depends on the real deployment manifest (`infra/bin/app.ts` builds Realtime/Flink/EMR/OmIngestion conditionally on context), and the authoritative owner of both is that phase's deployment orchestration. **Until it lands, `getHomeTarget()` always fails closed**, and that is **deliberate** (the construction batch that introduces it has zero production callers ⇒ zero behaviour change; and it turns "must seed properly first" into a hard constraint instead of hiding it behind self-healing).
- 🔴 **A non-home target whose descriptor is missing / not ready / stale ⇒ fail-closed refusal, never fall back to home** ([the design document](./multi-region-execution-design.md), section 2.2; falling back to home = silently sending region A's task to the home data plane, possibly across jurisdictions and borders). "Falling back to env as a whole" **holds only for the home target** (🔴 **revision 3.7 clarification**: that is the semantics of **existing code paths not yet wired** — those paths do not read the descriptor at all; **at the descriptor layer, a missing home equally fails closed**, see the seed timing in section 1.1).
- 🔴 **Added in revision 3.4 — the enforceable definition of `stale`** (previously the whole specification only said "stale ⇒ refuse" without **ever defining the time source and the threshold** ⇒ neither implementable nor acceptable [an acceptance criterion was about to assert exactly this]; second independent-review round, a P0 finding):

| Item | Final |
|---|---|
| **Time source** | `probe.at` (written by the probe, section 3.5); if `probe.at` is missing, fall back to `updatedAt`. Both are ISO-8601 strings; a parse failure is **treated as missing** |
| **Threshold** | `TARGET_FRESHNESS_MAX_AGE_MS = 15min` (constant in `lib/exec-env/registry.ts`). 🔴 **Hard constraint**: the probe / reconcile period of the deployment-orchestration phase must be **≤ threshold/3** (i.e. ≤ 5 min), otherwise one slow probe condemns a whole region |
| **Scope** | 🔴 **Non-home only**. The home exemption is not leniency; it is the scope of this section's original text ("**non-home** ⇒ fail-closed" + "falling back to env as a whole holds only for home" — 🔴 the latter refers to **existing code paths not yet wired**, not the descriptor layer): home is the local deployment unit and has no "probe lost contact" failure mode, and **the probe writer itself only arrives with the deployment-orchestration phase** ⇒ if home were also judged stale, the whole platform would fail closed on the day of the first wiring |
| **Direction when the time source is missing** | 🔴 Non-home with **neither** `probe.at` **nor** `updatedAt` **present (or neither parseable) ⇒ judged stale and refused**. **Never "missing field = fresh"** — that is the same kind of error as the "missing state = legacy" already forbidden in section 3.9b (a negative inference deciding admission) |
| 🆕 **Future-clock tolerance** | 🔴 **Revision 3.5 (third independent-review round, a P1 finding)**: `TARGET_FRESHNESS_MAX_FUTURE_SKEW_MS = 2min`. A time source **in the future** by more than this tolerance ⇒ **judged stale and fail-closed, exactly like "missing time source"**.<br>The original implementation computed only `now - ts > threshold` ⇒ `probe.at = 2999-01-01` made the age permanently negative ⇒ **fresh forever** (measured: a non-home target was admitted), and the stale gate was **closed for a long time** by a clock error or a malicious future value.<br>Why 2 min: it must cover normal NTP jitter yet be **far smaller than** the 15-min stale threshold — otherwise the "future tolerance" itself becomes a 15-min bypass window (the contract-drift test asserts `tolerance < threshold/3`)|
| **No caching** | the stale judgment, like `status`/`ready`, is an **admission bit**: per section 3.1 it is re-read with strong consistency every time and **may not be cached** (caching a stale judgment = caching a conclusion that "was still fresh at the time") |

### 1.2 🔴 `bgp-task-runs` primary key and indexes (resolving the primary-key collision and the scale problem found by the independent architecture review)

| Item | Final |
|---|---|
| **Key schema** | **Unchanged**: PK=`taskId` / SK=`runId` (**no table rebuild, no dual-write migration**) |
| 🔴 **`runId` value format** | **`<original runId>#<targetId>`** — 🔴 **revision 3.0 fix: the target segment is a [suffix], not a prefix** (the prefix scheme is abandoned). Reason: a workflow's `runId` is taken directly from Airflow's `scheduled__<logical_date>` (`runtime-lib.ts:140`) = **deterministically identical** for the same cron, and `taskId` is shared across targets ⇒ without composition `(taskId,runId)` is identical and **the later write overwrites the earlier**; **but a prefix would break three classes of existing reads** (see below), while a suffix preserves all three |
| 🔴 **Why it must be a suffix (measured; a single veto of the prefix)** | A prefix `<targetId>#…` would: ① make the **6** "take the latest run" reads with `ScanIndexForward:false + Limit:1` return **the largest targetId** (`monitor/tasks/[id]/logs:19`, `sync/[id]/glue-status:47`, `sync/[id]/logs:26`, `engines/[engine]/[id]/runs:29`, `etl-jobs/[id]/runs:25`, pagination likewise); ② make all **4** `startsWith("scheduled__")` checks miss ⇒ **every scheduled run is judged manual** (`monitor/runs:71`, python `runtime-lib:135`, `workflow/dag-generator:113`); ③ break **2** lexicographic "take the latest" places (`health-service:91` `it.runId > prev.runId`, `quality/service:280` sort). **Suffix: ① by raw time order is still approximately correct, ② prefix matching is unaffected, ③ lexicographic order still has raw as the primary order** |
| **split rule** | split at the **last** `#` (`raw` may contain `#`); 🔴 **the `targetId` character set forbids `#`** (see section 1.1a) |
| **legacy compatibility** | existing runIds without `#` are interpreted as the **home target**; the read side uniformly goes through `parseRunId(runId) → {rawRunId, targetId}` (legacy → `targetId=home`) |
| **Query semantics** | `Query PK=taskId` returns the runs of all targets (approximately in raw time order); 🔴 **"the latest run of one target" goes through GSI `byTaskTarget` (pk=`<taskId>#<targetId>`, sk=`startedAt`)** (revision 3.2 correction: the original text had the abandoned `byTarget(pk=targetId)` — it has no taskId dimension and cannot answer "the latest run of a task on a target", and DDB `Limit` applies before the filter ⇒ `Limit:1` necessarily returns empty, which is exactly why section 1.2 replaced it), **no longer relying on SK order** — this is the correct answer for class ① reads |
| **New attributes** | `{projectId, targetId, startedAt}` (`startedAt` for GSI sorting; `region` is looked up from the target, not stored separately) |
| 🆕 **GSI (🔴 revision 3.1 choice corrected)** | **`byTaskTarget` (pk=`taskTargetKey` = `<taskId>#<targetId>`, sk=`startedAt`)**, `byProject` (pk=`projectId`, sk=`startedAt`), **`byStatus` (pk=`statusDay` = `<status>#<yyyy-mm-dd>`, sk=`startedAt`)**; projection **INCLUDE**{status, taskType, projectId, targetId, runId, duration/*🔴 revision 3.2: originally written durationMs — the real code writes `duration` (seconds), see etl/job-service.ts:295,397,432; projecting a non-existent attribute = that column is always empty in the GSI*/, error} (avoids KEYS_ONLY plus a fetch back to the table)|
| 🔴 **Why not `byTarget(pk=targetId)` (the original design was wrong, abandoned)** | ① the 6 class-① reads want **"the latest row of (taskId, target)"**, and `pk=targetId` has no taskId dimension ⇒ taskId can only be filtered with a `FilterExpression`; **DDB's `Limit` takes effect before the filter** ⇒ `Limit:1` **almost always returns empty** (= the corresponding acceptance criterion judges FAIL), and removing Limit scans the whole partition; ② the correct answer would be an LSI (pk=taskId, sk=startedAt), but **an LSI can only be created at table creation** ⇄ this section's "no table rebuild" ⇒ only a GSI with a **composite pk** remains; ③ `pk=targetId` in a single-target deployment has **only one pk value** = every run in the system squeezed into one partition; `pk=status` has cardinality ≈ 3 and the `succeeded` partition receives all historical writes ⇒ **GSI partition throttling back-pressures writes to the base table** |
| 🔴 **Existing data must be back-filled (otherwise all historical runs disappear)** | the GSI is a **sparse index**: existing rows **have no `targetId`/`startedAt`/`taskTargetKey` ⇒ they are not indexed at all** ⇒ on the day class-① reads go live, no historical run can be found. Hence **task-runs must enter the section 6.8 back-fill list** (the original section 6.8 listed only 4 tables and missed this one): back-fill `targetId="tgt_home"`, `taskTargetKey="<taskId>#tgt_home"`, `startedAt` (derived from the existing time fields); **until the back-fill completes, class-① reads keep the old SK path** (dual read) |
| 🔴 **Scan→Query** | `alerting/evaluate.ts:43` (Limit=500), `baseline/learn.ts:120` (Limit=2000; also `:104` Limit=500) and the other **bounded Scans all become Queries** — after multi-target amplification a bounded Scan returns only the first page **and reports no error = silent data loss** |
| 🔴 **The real write surface = 27 places (not 13)** | **13 places create rows** (`PutCommand`) + 🔴 **14 places write status back with `UpdateCommand` using `Key:{taskId,runId}`** (e.g. `workflow/[id]/runs/[runId]/status:94,125`, `sync/reconcile.ts:37`, `engines/emr/run-record:35`) — **an inconsistent runId shape on the write-back side = silently writing an orphan row** (no error). Both are **changed in the same batch** |
| 🔴 **Read-side convergence, three classes (deliverable of the first construction phase)** | **(a) sort / take-latest class (6 places)** → **all switch to GSI `byTaskTarget` + `startedAt`**; 🔴 **no "approximately correct by raw" loophole is left** — when `raw` is equal (**precisely the only reason the composite runId exists: two targets on the same cron have identical `scheduled__<logical_date>`**) the SK order degenerates into lexicographic order by targetId, and `tgt_home` is beaten by any `tgt_i…`~`tgt_z…` ⇒ home's run vanishes from "the latest"; **(b) prefix-match class (4 places)** → judge by `parseRunId(runId).rawRunId.startsWith("scheduled__")` (including the two python copies); **(c) lexicographic-comparison class = 1 place** (🔴 correction: the original "2 places" contained a false positive — `quality/service.ts:280` sorts **quality's own ULID runId**, unrelated to task-runs; the only one really affected is `governance/health-service.ts:91`) → compare `startedAt` instead. Also: log paths / diagnostic evidence / backfill / cost attribution / Copilot `list_recent_runs` / front-end run details **each enumerated and passed through `parseRunId()`** |
| 🔴 **Composition boundary (X1: prevent double suffixing + `#` entering log paths)** | **composition happens only at the moment of "writing to DDB"**; 🔴 **the `dags trigger -r <runId>` passed to Airflow always uses `raw`** (`workflow/[id]/trigger:67`, `scheduler/dependency:61`); when the python side reads `dag_run.run_id` and writes back, **the python side appends the suffix uniformly** (appending on both sides = `<raw>#<tgt>#<tgt>`); and the log path `run_id=<runId>` (`monitor/tasks/[id]/logs:45` currently only maps `:`→`_`) must **add `#` to the escape set** |
| 🔴 **The composite runId may not be spliced directly into other `#`-delimited keys (X2)** | the alert dedup key `run#<runId>` (`database-stack.ts:266`) and the incidents occurrence sk `occ#<sig>#<ts>#<ulid>` both carry a runId ⇒ after composition the number of `#` segments varies, and any `split("#")[1]`-style parse gets raw ⇒ **two targets merge into one dedup key = cross-target alerts suppress each other** (the opposite of section 3.12's "incidents with the same signature are not merged across targets"). **Rule**: before entering any other composite key, first `parseRunId()` to take raw + an explicit target segment; **the S10 lint gains a rule**: forbid splicing `runId` directly into `#`-delimited keys |
| 🔴 **Fix the literal `"manual"` self-collision in the same batch (X3)** | the `else "manual"` in `etl/dag-generator.ts:168` and `engines/emr/dag-generator.ts:101` makes every fallback run write the same `(taskId,"manual")` item, **overwriting one another**; with the target added they still overwrite one another **within the same target** ⇒ this section's "resolve the primary-key collision" does not hold for these 2 points. Change to `manual_<ulid>` |
| **Alternative (not taken by default)** | change the PK to `<projectId>#<targetId>#<taskId>`: requires an online migration + dual write / dual read + a rollback window, markedly higher risk |

### 1.1a 🔴 `targetId` format (final; sanitize-neutral, eliminating cross-language misalignment)

| Item | Final |
|---|---|
| **Format** | 🔴 **Revision 3.4 final (replacing the original `{1,40}` form)**: **`^tgt_[a-z0-9](?:[a-z0-9_]{0,14}[a-z0-9])?$`** — i.e. `tgt_` + a body of **1–16 characters**, **the body must start and end with `[a-z0-9]`, and `_` may appear only inside the body**; total length ≤ **20**. Examples: `tgt_usw2_a`, `tgt_euw1_prod` (all original examples remain legal).<br>**Why the two corrections (second independent-review round, a P1 finding; both measured)**:<br>① **length 40 → 16**: the contract's 40 (total length 44) **does not fit through the exits** — `bgp-paramadvisor-runtime-role-` + 44 = 74 **exceeds the IAM RoleName limit of 64**; tighter still is the S3 bucket name (`bgp-glue-scripts-<12-digit-account-id>` already uses 29 of the 63 limit). 16 is derived from `PER_TARGET_NAME_BUDGETS` (`lib/exec-env/target-id.ts`, which encodes each exit's `awsLimit/prefixLen/separatorLen/suffixReserve` as **data**) and is checked by a **contract-drift unit test that parses the regex on this very line**, no longer by human memory.<br>② **first and last must be alphanumeric**: the original regex allowed the body to end in `_` ⇒ `tgt_a_` was legal, while its `targetSlug` = `tgt-a-` **is not a legal DNS label** (DNS / ACM / API Gateway require a label to end in an alphanumeric) ⇒ it would blow up only at the "create certificate / create domain" step of deployment, far from the root cause. `toTargetSlug()` now **additionally asserts that the product is a legal DNS label** (defense in depth, rather than doing only a `replace`)|
| 🔴 **`targetSlug` (revision 3.1: must be added, otherwise deployment fails at the first step)** | **`targetSlug = targetId.replace(/_/g, "-")`** (e.g. `tgt-usw2-a`); **reversible in both directions** (because targetId forbids `-`). **Exits that must use the slug rather than the targetId**: ① **CloudFormation stack names** (only `[a-zA-Z][-a-zA-Z0-9]*` is allowed, **no `_`**) ⇒ the stack-group name in section 3.5 is written `BgpExecEnv-<targetSlug>-*`; ② **DNS / ACM certificates / API Gateway custom domains** (hostnames do not allow `_`) ⇒ section 6.3's `data.<targetSlug>.<platform domain>`, `aud=data.<targetSlug>`; ③ **IAM role names** (the per-target roles of section 6.1); ④ anywhere that goes into a URL / hostname / certificate SAN. **All other positions (lock attribute names, FQN / OpenMetadata segments, audit shard keys, DDB key values) use the raw `targetId`**. The slug ↔ id mapping is **provided exclusively by the naming SSOT**; scattered replace calls are forbidden |
| 🔴 **Why underscores (conclusion limited to [lock attribute names] only)** | lock attribute names are sanitized on both sides: Node `replace(/[^A-Za-z0-9_]/g,"_")` (`backfill/execute.ts:90`), python `re.sub(r"[^A-Za-z0-9_]","_")` (`runtime-lib.ts:186-188`, already pinned by a lock-parity unit test) — `[a-z0-9_]` **is invariant** under both, so the lock axis has no misalignment. ⚠️ **Revision 3.1 narrows this: the original "eliminates this class of bug at the root" was an over-broad claim** — of the 20+ sanitizers in the repository **at least 6 would mangle `_`**: `normalizeRoleName` (`role-advisor/policy-builder.ts:28`, **removes `_` and truncates to 40** ⇒ `tgt_eu_prod_1`→`tgteuprod1` **collides** with `tgt_euprod1`, while the per-target roles of section 6.1 require precisely that "execution identities are not shared between jurisdictions"), `normName` (`governance/sensitive/types.ts:69`), DMS `names()` (`realtime/dms-service.ts:147`, where `slice(-12)` **first eats the `tgt_` prefix**), `zeroEtlNames()` (:58), `costSignature` (`finops/cost-signature.ts:26`, forces upper case + collapses `__`), `tokenize` (`genbi/core/retrieval-core.ts:43` + 2 core-dist copies, **`_`→space** ⇒ `tgt_eu_prod` is cut into three tokens, while section 3.11 requires "GenBI filters by target" and an acceptance criterion asserts exactly that "home skills are not retrieved on the third target")|
| 🔴 **targetId exit list (declare per exit what is used; no assumptions)** | lock attribute names → **targetId** (neutral, tested); FQN / OpenMetadata service segment → **targetId**; audit shard keys / DDB key values → **targetId**; 🆕 **Airflow `dag_id` and the DAG's S3 key → the raw `targetId`** (landed with the fan-out deployment: non-home artifact names = `<base>__<targetId>`; Airflow's dag_id allows `_`, and by this list's rule "only exits that forbid `_` switch to the slug" ⇒ no switch, so that one name does not mix two separators. 🔴 This mapping is **one-way**: `TARGET_ID_RE` allows `__` inside the body, so the reverse is not unique ⇒ the authoritative record is the ledger `deployments[targetId].artifact`; reverse-resolving the target from dag_id is forbidden); **CFN stack names / DNS / ACM / API Gateway domains / IAM role names → `targetSlug`**; **cost signatures → do not feed the targetId** (feed a short hash code of the `targetId` instead, avoiding `costSignature`'s upper-casing and collapsing); **GenBI retrieval tokens → do not feed the targetId literal** (filter by exact equality on the `targetId` field, not through tokenize); **DMS / Zero-ETL resource names → use `targetSlug` and verify it is still unique after `slice(-12)`** (otherwise switch to a short hash code)|
| **Forbidden characters** | `#` forbidden (the runId separator, section 1.2), `-` forbidden, upper case forbidden, dots forbidden |
| **Generation** | generated server-side (the `register` API; the client may not specify it); suggested `tgt_<region abbreviation>_<sequence or cell>`; **immutable and not reusable** (a tombstone holds the place after deletion) |
| **home target** | 🔴 `targetId = "tgt_home"` (**a fixed constant**, not the region literal) — resolving the collision between "sk=`<home-region>`" in [the design document](./multi-region-execution-design.md), section 2.1, and "sk=`targetId`"; `isHome(target)` tests `targetId === "tgt_home"`, and registration writes the status-quo named resources into that item |

### 1.3 Table changes for the four axes of the design document's section 19 (modeling landing / region keys of result-type tables / access control / audit)

| Table | Change | Axis |
|---|---|---|
| code tables `CODE_TABLES` / model tables `MODEL_TABLES` | `regions?` → **`targets?: string[]`** binding; `landed:bool` → 🔴 **`landedByTarget: {[targetId]: {version, at, status, observedSchemaHash}}`** (observed state, not "what I think I pushed", preventing false green on dashboards) | A |
| `QUALITY_RESULTS` / `METRIC_VALUES` / lineage edges / `DATA_CLASSIFICATION` / findings | add a **target dimension**; 🔴 **decide per table "into pk or into sk"** (see the table below); read paths pass target through accordingly | B |
| `DATA_GRANTS` | 🔴 grant semantics change from global to **per-target** (the key includes target); the approval flow carries target; **existing grants are migrated** (jurisdiction annotated, split by target) | C |
| `bgp-audit` | 🔴 **pk sharding** `audit#<targetId>#<yyyy-mm-dd>` (currently `pk="audit"`, a single partition; **not `audit#<region>`** — two targets in one region would be merged, sections 3.3 / 6.5); for cross-jurisdiction targets, **PII / details / SQL text / queryId in clear → the regional audit store**; the center keeps only **non-PII summaries** | D |
| 🆕 `bgp-query-handles` | `{handleId(PK), statementId, targetId, projectId, ownerSub, jurisdiction, createdAt, expiresAt(TTL≈36h)}`; cleaned up automatically by TTL | standalone security fix / C |
| 🆕 regional audit store (cross-jurisdiction targets) | regional DDB / S3 (RETAIN + write-only role + deny modification and deletion), in the same frame as the regional result store of section 3.3. 🔴 **Revision 3.22 table name final**: `bgp-region-audit-<slug>` (created per target; the name enters the resource bag as `resources.residencyAuditTable`; `pk="audit#<targetId>#<yyyymmdd>"`, `sk="<ts>#<ulid>"`; PAY_PER_REQUEST + PITR + RETAIN + the foundation CMK) | D |

### 1.3a 🔴 Added in revision 3.0: table changes decided in the design document's section 10 that this specification had previously failed to carry (S1–S5; the root cause of a reproduced independent-review finding)

| # | Table | Change (final) | Notes |
|---|---|---|---|
| **S1** 🔴 **heaviest** | **the 5 resource-definition tables** (`bgp-sync-tasks` / `bgp-etl-jobs` / `bgp-engine-jobs` / `bgp-workflows` / `bgp-redshift-tasks`) **+ `bgp-flink-jobs`** | `targets?: string[]` (default `["tgt_home"]`), `deployments?: {[targetId]: {version:number, publishedAt:number, status:"ok"\|"failed", error?:string}}`, `specializedFrom?: {targetId, sourceId, at}` | **the core data model of the whole module, "which task goes to which target"**; the per-target deployment of section 5.2, the modeling fan-out of section 3.8, `offlineDag(dagId,targetId)` of section 3.12, and the fan-out acceptance criterion ("the same workflow bound to home + a second target") **all depend on it**. Purely additive attributes, zero migration |
| **S2** | 4 groups on the consumption surface | `bgp-genbi-tasks` / `bgp-genbi-history` +`targetId`; the `WidgetSource` of `bgp-bi-*` +`targetId?` (~~`bgp-data-apis`~~ **decommissioned** 2026-09-05, section 3.9c); the **sk of `bgp-cost-daily` / `cost-runs` gains a target segment**; the `bgp-settings` key `ai-model#<targetId>#global` (the per-region key of [the model-configuration design](./model-configuration.md), decision D8, **becomes per target**) | to be verified by acceptance criteria; the `bgp-settings` key shape has the same source as the three-key decision of section 6.5 |
| **S3** | 🆕 **`bgp-metadata-mirror`** (the only new table of differentiation B) | `pk = "mirror#<targetId>"`, `sk = "<kind>#<fqn>"` (kind ∈ `db\|table\|column\|lineage-edge`), attributes `{payload, mirroredAt, ttl}`; **DDB TTL = 7d** (expired counts as stale) | section 3.13 had only pseudocode and no schema until now |
| **S4** | 🆕 **regional result store** (the `residency-api` of cross-jurisdiction targets) | 🔴 **Revision 3.22 final (residency-audit work, slice 1)**: regional side **`bgp-region-results-<slug>`** (created per target; the name enters the resource bag as `resources.residencyResultsTable`; DDB: SQL history / Ask-Your-Data turns / export index; `pk="<projectId>#<targetId>"`, `sk="<kind>#<ts>"`) + **`bgp-region-audit-<slug>`** (section 1.3 D, `resources.residencyAuditTable`) + the regional S3 result bucket (`resources.residencyBucket`; result objects / exports / memory summaries; RETAIN + the foundation CMK + public access blocked + bucket policy **deny `s3:ReplicateObject` / `s3:PutReplicationConfiguration`** = the no-replication acceptance criterion); **all RETAIN**; the center stores **pointers only** (no rows). The three names enter the bag through the CFN Outputs of `residency-stack.ts` (OutputKey = field name), and the probe really probes all three | the semantics were fixed in section 8.5.7 ④, with no table definition until now; acceptance criteria must assert "hard evidence in regional DDB / S3" |
| **S5** | 🆕 **execution manifest snapshot + outbox** (phase-one mitigation of section 14bis.2, already declared "do all of it") | ① **manifest**: at publish time the task-definition snapshot is **baked into the deployed artifact** (JSON inlined in the DAG / script, with the definition version number + checksum), and at runtime **the control-plane DDB definition is not read back**; ② **outbox**: when the executor's status write-back fails, it lands in a **local buffer on the execution side** (S3 `outbox/<runId>.json` on the MWAA side), and after recovery the platform's reconcile-on-read forwards it | eliminates the "read the definition" dependency of section 14bis.2 (b); until now `manifest`/`outbox` had zero occurrences in this specification |
| **S6** | 🆕 **Revision 3.19 (the three fan-out tickets): three "data first, wiring later" fields** | ① `bgp-cost-runs` gains **`{projectId, targetId}`** (cost rows **inherit the run row's stamp**; mandatory in the write-side sweep; existing rows are back-filled by `stamp-backfill` from run rows with a **conditional write**; a run without a stamp ⇒ recorded as unresolved, **home is not guessed**; entry `POST /api/finops/collect?backfill=1`) · ② `bgp-task-runs` gains **`runGroupId`** (shape `rg_<ULID>`; **the N runs of a multi-region fan-out share the value; a single region stores no attribute**; it enters only as a first-class parameter of the write channel, and mixing it into `extra` / a write-back is refused; the run route's response echoes the field of the same name; the deterministic grouping key for scheduled triggers, `definitionId + scheduledTime + definitionVersion`, goes to the run-group objective) · ③ `bgp-datasources` gains **`ownerTargetId`** (existing rows are all `tgt_home` — before the placement concept the platform had only the home execution path, a historical fact, not a guess; new rows are stamped by the single author `placementForNewDataSource()`; **PUT cannot change it**; changing the place belongs to the authorization action of a later objective; migration entry `POST /api/admin/datasources/placement-backfill`, idempotent, does not touch `updatedAt`) | 🔴 All three land **data** only, without wiring: the gate on the cost of turning back lies in the data, not the code (recorded in the roadmap). The "cost-runs sk gains a target segment" written in S2 still follows the composite runId of section 1.2; the first ticket lands the stamp as an **attribute** first. The contract-drift gate `contract-drift.test.ts` reads this row to check the three attribute names |
| **S7** | 🆕 **Revision 3.44 (the run-group objective), new table `bgp-run-groups`** — the **persistent parent object** of a multi-region coordinated run (view the whole group / cancel all unfinished with one click / retry only the failed regions / the retry chain points back) | `pk=runGroupId`; attributes `{definitionKind, definitionId, projectId, requestedTargets[], accepted:{[targetId]:{runId?, definitionVersion?}}, skipped:{[targetId]:{reason}}, failurePolicy:"continue"\|"fail-fast-submit", status, triggeredBy, createdAt, finishedAt?, retryOfRunGroupId?}`; GSI **`byDefinition(pk=definitionId, sk=createdAt)`**; **no TTL** (run history belongs to the audit surface and may not vanish on expiry). ① **the `definitionKind` value set reuses the existing single author `ResourceType` of the versioning module** (`workflow`/`etl-job`/`sync`/`redshift-task`/`engine-job`, `lib/versions/version-service.ts`) — **no second resource vocabulary is created** (A1: two vocabularies inevitably drift apart; the `targetType` warehouse incident came from exactly that); ② **`status` is a materialized projection, not the source of truth**: the truth = the child run rows; on read, `deriveGroupStatus(children)` derives it and reconciles it back (same pattern as the execution environment's `observed`), and the UI **always shows the derived value**; ③ 🔴 **failure to write the group row ⇒ the run is refused** (deliberately **not** fail-open: letting it through would leave that batch of runs **forever ungrouped**, and run rows are append-only historical facts that cannot be repaired afterwards — the gate on the cost of turning back lies in the data, not the code); ④ `runGroupId` has two shapes: manual / API fan-out `rg_<ULID>` (already in use since S6 ②) · scheduled trigger **`rgs_<first 24 hex of sha256>`** (a deterministic key; formula in **section 3.17**); ⑤ 🔴 **`accepted` / `skipped` are maps keyed by `targetId`, not lists** — first-class per-target writes must be **idempotent** (`list_append` inherently appends duplicates; one retry would make the group page show the same region twice); a repeated report from the same target = overwrite the same cell; ⑥ **cross-region definition-version differences** land in `accepted[targetId].definitionVersion` (an acceptance criterion) — they are **a fact to be seen**, not a grouping criterion (so they do not enter the deterministic scheduled key either) | 🔴 **This row supersedes the sentence in the parenthesis of S6 ②, "the deterministic grouping key for scheduled triggers, `definitionId + scheduledTime + definitionVersion`"** — opening the run-group package (2026-09-14) overturned both of its inputs: **(a) `scheduledTime` may not be taken from Airflow's `run_id` / `logical_date`** — under MWAA Serverless it **degenerates into a constant** (measured: two different runs were both `scheduled__2026-09-07T00:00:00+00:00`; the real-environment fact is recorded in `_ledger_run_id` of `lib/scheduler/serverless/runtime-py.ts`), and using it as a key produces the failure mode of **grouping every historical scheduled run into one group** (worse than "cannot be grouped": the group page grows without bound and never reaches a terminal state); **(b) `definitionVersion` does not enter the key** — it is **per-target deployment-ledger** state (`deployments[targetId].version`); when one region fails to publish and is republished alone, the two regions have different versions ⇒ the same trigger is **split into two single-member groups**; version drift must be **visible inside the group** (`definitionVersions` recorded per target) and must not change the group's identity |
| **S12** | 🆕 **table-creation ledger** (used by [the project-isolation design](./project-isolation.md), section 3.7; the table is created by that design, the contract is registered here) | `bgp-table-ownership`: `pk="fqn"`, attributes `{projectId, targetId, kind:"business"\|"modeling-global"\|"unknown", createdBy, at}`; **stamped at table creation** (the four paths execute-ddl / codegen / sync / modeling), no after-the-fact lookup | the project-isolation design's section 1 once declared "no new control-plane tables" → **corrected: this table is new**. ✅ **The feedback has been applied (convergence check of 2026-08-29, revision 3.1)**: this cell used to say "synchronized to the project-isolation specification, section 1" but **it was never actually synchronized** (`bgp-table-ownership` had zero occurrences in the three project-isolation documents ⇒ nobody would have created the table during construction, and the corresponding acceptance criterion was left dangling); it has now landed in [the project-isolation design](./project-isolation.md) (specification revision 1.1, sections 1 + 3.7 / design revision 1.1, section 2 / acceptance revision 1.1) |
| **S13** | 🆕 **Revision 3.22 `bgp-residency-acks`** (control-plane DDB, residency-audit work) | `pk=<userSub>`, `sk=<targetId>#<disclaimerVersion>`, attributes `{textHash, at, ip, ua}`; **append-only** (the TaskRole has an explicit Deny on `UpdateItem / DeleteItem / BatchWriteItem`, same as the audit table); sole writer = `POST /api/residency/ack` (section 2.1); readers = `requireResidencyAck(identity, targetId)` (missing row ⇒ 409 `residency-ack-required`) and `GET .../[targetId]/acks` (look-back) | decided on 2026-09-05: "once the user has consented, the user's choice can be retained to avoid disputes"; the wording version and text constant have a single author, `lib/residency/disclaimer.ts`; a new wording version ⇒ a new sk, prompting once more |

**Per-table pk-vs-sk final ([the design document](./multi-region-execution-design.md), section 20.6-F)**:

| Table | Final | Rationale |
|---|---|---|
| `QUALITY_RESULTS` | pk=`fqn` kept, **sk gains the prefix `<targetId>#`** (`<targetId>#<runId>#<ruleId>`) | querying one fqn's results across targets is still a single Query; `getResults` changes to **latest per target** (no longer picking the "globally latest" across targets) |
| `METRIC_VALUES` | **pk=`<metricId>#<targetId>`**, sk=`ts` | metric values must be independent per-target series; the `lastValue` written back to the definition becomes a `lastValueByTarget` map |
| lineage edges | the composite key has **a target segment in the FQN at both ends** (the authoritative FQN function of section 3.10) | edges are naturally separated by target; impact analysis does not mix regions |
| `DATA_CLASSIFICATION` | pk=`fqn` (with target segment), sk=`column` | classification follows the FQN; EU may be stricter than US |
| findings | pk=`<scanId>`, **items carry `targetId`**; `getLatestScan` changes to **per target** | when adopting classifications, write per target without cross-target contamination |

---

## 2. Interface design

### 2.1 Control-plane API (`/api/admin/exec-envs*`, bgp-admin; enforced at `middleware.ts:104`)

| Method · path | Request | Response |
|---|---|---|
| GET `/api/admin/exec-envs` | `?region=&stage=&status=` | `TargetDescriptor[]` (the admin plane reads the **raw** view and does not judge readiness — section 3.1a: operators must be able to see a broken item in order to repair it) |
| 🆕 GET `.../[targetId]` | — | Detail of a single target (raw view; 🔴 **added in revision 3.10**: the skeleton in the [design document](./multi-region-execution-design.md), section 11, had a `get` from the start and this table had omitted it — both the detail page and the progress page need it; the list cannot stand in for it) |
| POST `.../register` | 🔴 **Corrected in revision 3.12 (decided on 2026-09-01: "initialization must not ask the user for an account; execution environments may strictly only be added in different regions of the control-center account")**: `{region, cellId?, stage?, jurisdiction?, components[], networkProfile?}` (🆕 revision 3.27: `networkProfile` standard / economy, default standard; the EIP-quota finding) — **`accountId` / `partition` are obtained by the server itself** (STS GetCallerIdentity; if the client sends them the request is rejected with 400 rather than ignored); **a region in another partition is rejected with 400 outright** (the necessary consequence of the same-account decision); cross-account targets are out of scope for the first phase (the buildspec has long had a guard rail with the same semantics). 🔴 **Revision 3.22 adds `residencyAck?:{version, textHash}`**: **required** when `jurisdiction≠home`, and it must equal the current version in `disclaimer.ts` character for character (otherwise 400 with the current text returned); the server fills in `by` / `at` into the descriptor's `residencyAck` (section 1.1) | `{targetId, status:"registered"}` (**the server generates `targetId`**; the client must not specify it) |
| 🆕 POST `.../seed-home` | — | ✅ **Delivered in revision 3.12 (execution-environment construction batch)**: the **seed entry point** for the home descriptor (the real caller of section 1.1's "the seed is executed at the end of deployment"; an explicit bgp-admin action, **not self-healing on the read path**). Flow = live-query assembly (EMR security group: look up the real id by name / subnets: take the CDK-injected `EMR_DEFAULT_SUBNET_IDS` [the same source the production EMR jobs use] / managed admin secret: take the real ARN; if any core item is missing, throw) → **probe for real first** (red ⇒ 409 and nothing is persisted; if validation fails nothing is written) → the existing `seedHomeTarget` (whole-package validation + idempotent location comparison). Gated components (dms / flink / agentcore / airflow-serverless) are probed one by one and are claimed only when found; 🔴 **revision 3.28**: the probe treats only **NotFound-class** errors as "not deployed"; other errors such as permission or network **throw a 500 that points at TaskRole permissions** (the original catch swallowed AccessDenied ⇒ 200 without claiming the component; hit in a real environment); if home already exists and is serving ⇒ the increment goes through **`adoptHomeComponents`, add-only adoption** (section 1.1, revision 3.28), and the response gains `merged: {components[], resources[]}`. Response `{targetId, outcome, probe, merged?}` |
| POST `.../[targetId]/deploy` | 🔴 **Corrected in revision 3.10: `{components[]}`; `operationId` is generated by the server** (the client must not specify it — it is **the deployment-lock token and the audit key**; specifiable = predictable = replayable; the same precedent as "the server generates `targetId`" for register in section 2.1). 🔴 **Revision 3.21 adds `approvedPlanHash?`** (same shape as add-components, a sha256 hex, passed through to the field of the same name already in the broker allow-list): **"Redeploy" on an enabled target = upgrade**; as soon as the source package changes it becomes `drift-unauthorized` and requires approval (section 3.5c ④), yet deploy previously could not carry an approval ⇒ the "Redeploy" button **could not work at all** once the source had drifted (found when the per-target execution-role work started). Upgrade path = `preview` (same set = upgrade rehearsal) → the administrator reviews the plan → `deploy{approvedPlanHash}`; a first install (`registered`) still goes without it | `{buildId, lockEpoch, operationId}` → `initializing` (the status transition is completed **inside the broker** by a conditional write on the same epoch; the platform side writes zero status); for an enabled target ⇒ phase stays `ready` and only `observed.operation` is set (section 3.5) |
| POST `.../[targetId]/add-components` | ✅ **Delivered in revision 3.14 (the add-components construction batch)**: the input **accepts only** `{components[]}` (**full-set** semantics, not a delta); `operationId` is **generated by the server** (same as deploy — it is the lock token and the audit key). Validation: must contain core / **components may not be removed** (removal is the territory of the deletion flow, see section 4.6) / only **implemented** components are allowed (`kafka` / `mwaa` / `agentcore` / `residency-api` are always rejected with a 400 that names them) / no addition ⇒ 400 (pointing to "Redeploy"; 🔴 **revision 3.21**: `preview` **no longer** rejects the same set — a full set identical to what is installed = **upgrade rehearsal** [`added=[]`], and the `planHash` it produces is handed to `deploy{approvedPlanHash}`; add-components itself still requires a real addition) / **cross-jurisdiction 403** (the same gate as deploy — without it this endpoint would be the bypass around deploy's 403). 🔴 **Not a single byte of the registry is written**: the component set is written back by finalize according to **observed** (a component is never claimed before its resources exist; a P1 finding of the code-review round) | `{buildId, lockEpoch, operationId, added[], components[]}`; **purely additive component stacks do not go through approval** (they do not touch the stateful core stack); the change-set gate for stateful stacks (section 12.6) still belongs to the execution-environment stack-group construction batch |
| GET `.../[targetId]/build-status` (🔴 **revision 3.13 adds the optional `?buildId=`**: the wizard passes it explicitly right after triggering a deployment — if the first poll relied only on the registry's `lastBuildId`, it would **race** the broker's write-back, obtain `phase:"none"`, be treated by the front end as a terminal state and **stop polling**, and the progress area would forever show "no current build" [measured at page level during the wizard construction batch]) | — | `{phase, stacks:[{name,status}], logsTail, observedVersion}` (polls the broker + region `DescribeStacks`) |
| POST `.../[targetId]/canary` | — | Canary result (conditional on components). ⬜ 🔴 **Revision 3.11 reassigned it to a later construction slice** (originally written as belonging to an earlier slice — the canary must **really run** a query; without really deployed resources it can only fabricate a green result; the probe already covers the "resource existence" layer) |
| 🆕 POST `.../[targetId]/probe` | — | ✅ **Delivered in revision 3.11 (the probe / enable construction slice)**: one call is the complete loop = ① resource bag missing and in repair state ⇒ **finalize** first (target-region CFN Outputs → through reconcile into the resource bag; the realization of the [design document](./multi-region-execution-design.md)'s statement that "DescribeStacks is the authoritative SSOT") → ② **probe every resource for real** according to the installed components → ③ `writeProbeResult` persists the `probe` field (**the time source for the stale judgement finally has a real writer**) → ④ all green and ready not yet set ⇒ `markTargetTested` (ready=true + status→testing). Response `{probe:{at,ok,items[]}, finalized, ready, status}`; failures of ① / ④ degrade to response fields, not 500 |
| 🆕 POST `.../[targetId]/enable` | — | ✅ **Delivered in revision 3.11 (the probe / enable construction slice)**: precondition `ready=true ∧ probe.ok ∧ status=testing` ⇒ `active` (conditional write bound to version+status+ready); otherwise 409 with the reason |
| 🆕 POST `.../[targetId]/access` | 🔴 **Revision 3.22 (the residency acknowledgement and audit work)** `{mode:"all-projects"} \| {mode:"allowlist", projects:string[]}` (**full-set** semantics; bgp-admin; each project is validated to exist; an empty `allowlist` array = nobody can bind, allowed but audited) | `{targetId, access}`; audit `exec-env.access.set` (before / after); **can be set on any target** (generic; cross-jurisdiction targets are not special-cased) |
| 🆕 GET `.../[targetId]/acks` | 🔴 **Revision 3.22 (the residency acknowledgement and audit work)** — | `{targetId, registration: residencyAck?, users: [{userSub, version, textHash, at}]}` (lets bgp-admin look up "who consented to which version of the notice, and when"; the single authority that forestalls disputes) |
| 🆕 GET `.../[targetId]/statements?auditId=<ulid>` | 🔴 **Revision 3.25 (second part of the residency work, corrected against a real environment)** — | `{targetId, jurisdiction, auditId, statements:[{id, status, createdAt?, updatedAt?}]}` (bgp-admin traces Redshift statements back from a regional audit row / from the `auditId` in the `audit` map of a direct-query response: in the target's region call `ListStatements(StatementName=auditId, RoleLevel=true)`, then filter on exact equality; **SQL is not returned** [the text lives only in the regional audit table]; home ⇒ empty list. **Why it must exist**: the Data API's List / Describe are isolated by caller IAM identity and DescribeStatement does not return StatementName ⇒ only the statement owner [the platform TaskRole] can see the `StatementName == auditId` correlation of section 3.2; without this endpoint that correlation is empty talk that nobody can observe; `auditId` not a 26-character ULID ⇒ 400) |
| 🆕 POST `/api/residency/ack` (**data plane**, any workspace member) | 🔴 **Revision 3.22 (the residency acknowledgement and audit work)** `{targetId, version}`: version must equal the current version in `disclaimer.ts` | Writes `(userSub, targetId, version)` into the `bgp-residency-acks` table (data contract store S13) + the central `bgp-audit` `residency.ack`; idempotent (already present ⇒ 200 without rewriting); response `{targetId, version, textHash, at}` |
| POST `.../[targetId]/drain` | 🆕 `{reason}` | `status=draining` (**rejects new bindings / new schedules / new runs**, section 3.5) |
| POST `.../[targetId]/delete-request` | — | Creates `bgp-approvals type=exec-env-delete`; **precondition: bindings=0 and already `draining`** |

🔴 **Precondition for `jurisdiction≠home` (rewritten in revision 3.22; [design document](./multi-region-execution-design.md), section 18, the no-legal-gate decision)**: the earlier wording "validate that `residency-api` is in the selected set + a legal-prerequisite switch; until passed the target may not become active and interactive queries are not opened to production" is void — **there is no legal switch**. It is now a **technical** precondition, with the criterion owned by a single author, `residencyPrerequisite(t)` (`lib/exec-env/residency.ts`), inserted into the admission kernel `serviceabilityVerdict` (one copy shared by its three callers): `jurisdiction≠home ∧ residency-api ∉ components ⇒ "the cross-jurisdiction target has no residency-api (regional audit store) installed; not accepting work"`; `missing per-target execution roles (hasPerTargetExecRoles=false) ⇒ "missing per-target execution roles (hard requirement of section 6.1)"`. The rejection reason on the admin page and on the data plane **come from the same source, character for character**; the **403 cross-jurisdiction hard blocks in deploy / preview / add-components are all removed** (they take the same path as same-jurisdiction targets).

🔴 **Deployment triggering moves to a narrow-privilege broker (an item of the independent architecture review)**: the platform **does not hold `codebuild:StartBuild`**; it holds only `lambda:InvokeFunction` → broker; the broker alone holds StartBuild, **accepts only `{targetId, components[], operationId}`**, takes the commit from the signed release manifest and **passes through no override whatsoever**; and the broker role's StartBuild carries a **deny-override condition** (the exact condition key is to be taken from the official AWS CodeBuild IAM documentation and verified before construction starts).

### 2.2 Data-plane endpoint classes (the basis for dual-track residency routing)

| Class | Routing | Examples |
|---|---|---|
| **Control class** | always central `/api` | task definitions / catalog structure / approvals / monitoring aggregates / cost |
| **Data class** (touches result rows / answers / detail) | 🔴 Revision 3.22: cross-jurisdiction → **central execution + full regional audit + central summary** (`residencyAudit`, the residency acknowledgement and audit work; results / SQL history stay in the regional store, data contract store S4) — "the browser connects directly to the regional data plane and executes nearby" is **an optimization of the follow-on residency work**, not a gate; same jurisdiction → central (unchanged, word for word) | execute / **result[id] (must carry queryHandle)** / athena / bi.query / bi.export / data-api / the data sub-calls of genbi.ask / the five warehouse direct-query endpoints / observability detail |
| **Mixed** | metadata goes central, data goes regional | genbi/ask, monitor/runs, catalog |

- The front-end **data client** (not the AuthProvider interceptor) switches the base URL according to `target.jurisdiction`; the regional API is configured with CORS / preflight.
- 🔴 **Scope does not treat localStorage as authoritative (an item of the independent architecture review)**: `targetId` is carried by **the URL / the resource identity**, and the server cross-validates it against the resource; localStorage is only a "default preference" (prevents multiple tabs from interfering with each other / an old page's request being redirected by a new global value).

### 2.3 🔴 Added in revision 3.0: target-parameterized APIs on the resource publish / consume side (until then the specification had only the control-plane exec-envs API = a systematic gap at the interface layer)

| Method · path | Request change | Response / semantics |
|---|---|---|
| POST `/api/{sync\|etl-jobs\|engines\|workflow\|redshift-tasks\|flink}/[id]/publish` | +`targets?: string[]` (default: the definition's `targets`) | `{results: [{targetId, status:"ok"\|"failed", version?, error?}]}`; 🔴 **serial per target, fail-fast** (section 5.2); successful targets are kept, failed ones become red cells on the dashboard |
| POST `.../[id]/start` (⚠️ the real route names differ: `sync/[id]/start`, `flink/jobs/[id]/start`, **ETL / EMR use `/run`**, **workflow uses `/trigger`**; map them one by one at implementation time) | +`targetId` (single value). 🔴 **Corrected in revision 3.1: there must be no "default `tgt_home`"** (the earlier wording "required; default tgt_home for compatibility" **is literally self-contradictory and fail-open** — a task with `targets=["tgt_eu"]` invoked without the parameter by an old client / an old scheduler / a stale tab would land on the home data plane = the silent cross-jurisdiction fallback that section 1.1 forbids). **Decision**: when the parameter is missing, **take the definition's `targets`** — **allowed only when it is exactly one value**; several values or none ⇒ **400 requiring an explicit value** | `{runId}` (🔴 composite form `<raw>#<targetId>`, section 1.2) |
| POST `/api/schedule/enable` · POST `/api/etl-jobs/[id]/schedule` (GET preview / POST publish) · POST `/api/engines/[engine]/[id]/schedule` | +`targets?: string[]` | Enable / disable per target; 🔴 **corrected in revision 3.27 (the serverless-scheduler work)**: the rejection reason is generalized to "missing **any** scheduler component": a target that has neither `mwaa` (or lacks `dagBucket` / `mwaaEnvName`) nor `airflow-serverless` (or lacks `workflowBucket` / `airflowServerlessRoleArn` / `airflowServerlessSgId`) ⇒ **409 `SCHEDULER_NOT_INSTALLED`** (the old code `MWAA_NOT_INSTALLED` is kept as an alias for one release; `detail.options = ["airflow-serverless","mwaa"]`; `fix.href` defaults to `highlight=airflow-serverless`); when both are installed ⇒ route by `schedulerPreference` (default serverless). The revision 3.26 wording below is kept as history: any non-home target lacking `mwaa` (`components ∌ mwaa`, or the resource bag lacks `dagBucket` / `mwaaEnvName`) ⇒ **409 `MWAA_NOT_INSTALLED`** (originally 400; like `TargetBindingRejected`, all "user-fixable" rejections site-wide use 409), `error.detail.missing[] = {targetId, region, displayName}` **lists everything at once** (the interaction principle of up-front validation), `error.detail.fix = {label: "Add MWAA in Execution Environments", href:"/exec-envs?target=<first missing>&highlight=mwaa"}`; GET preview rows `rows[].ok=false, code="MWAA_NOT_INSTALLED"`. The check runs **before any S3 write / Glue job creation** (section 3.14) |
| POST `/api/genbi/ask` · GET `/api/genbi/tasks/[id]` | +`targetId` | A conversation is anchored to a single target (section 8.2); cross-jurisdiction goes to the regional data plane (section 2.2) |
| POST `/api/bi/query` · `/api/bi/export` | `WidgetSource.targetId?` | Each widget routes on its own (section 8.3) |
| ~~POST `/api/data-apis/[id]/execute` · `/api/public/data/...`~~ | **Retired** (2026-09-05, section 3.9c): `/api/public/data/**` returns **410** for any method and is no longer a data-plane endpoint; the api-key target scope is **void** | — |
| GET `/api/monitor/runs` · `/api/finops/*` · `/api/governance/*` | +`targetId?` filter | 🔴 **Corrected in revision 3.5**: goes through the GSI **`byTaskTarget`** (the runs of one task on one target) or **`byProject` / `byStatus`** (the three indexes decided in section 1.2); no more Scan; **`byTarget` is void** (no taskId dimension; `Limit` applies before the filter) |
| 🆕 POST `/api/modeling/{codetables\|model-tables}/[id]/land` | `{targets: string[], mode:"create-or-verify"\|"force-rebuild"}` | `{results:[{targetId, status:"ok"\|"drift"\|"blocked-by-residency"\|"failed", observedSchemaHash?, diff?, error?}]}`; 🔴 **partial-failure semantics**: an independent result per target, overall 200 (one target's failure does not roll back the others); `force-rebuild` requires the second-confirmation header `x-bgp-confirm: rebuild` (section 3.8 / the [interaction design](./multi-region-execution-interaction.md), section 4ter) |
| 🆕 GET `/api/metadata-mirror` | `?targetId=&kind=` | One-screen overview of data sources; facets carry `mirroredAt` + `state` (section 3.13); 🔴 **the response contains no result rows**. 🔴 **Corrected in revision 3.18: the path moves out of `/api/admin/` (it was `/api/admin/metadata-mirror`)** — `middleware.ts` forces the whole `/api/admin/**` segment to `bgp-admin`, so implemented at the original path it was **a dashboard that no non-administrator could open** (the same criterion as `/api/exec-targets` in section 2.1: a presentation endpoint should not require an administrator). `stale:boolean` is at the same time upgraded to `state ∈ fresh\|stale\|expired\|never\|failed` — a single boolean cannot separate "never synchronized", "synchronized but old" and "last run failed", and the three are handled completely differently (settled when the metadata-mirror step of the stack-group construction batch landed) |
| 🆕 POST `/api/admin/metadata-mirror` | `{targetId, sources?}` | Manual collection (the "Sync now" / "Collect warehouse catalog" buttons). **Staying in the admin plane is deliberate**: collection really calls that region's APIs, and the warehouse path also wakes up that region's Serverless warehouse (RPU billing) ⇒ anything that "costs money on a click" belongs to administrators. `sources` is an allow-list (`glue` / `redshift`); the default collects only `glue` |

### 2.6 🆕 Revision 3.34: the "execution scope" — parameter grammar / reader / filter / counts

> - Basis: the [interaction design](./multi-region-execution-interaction.md), **revision 2.33** — section 9 (the execution-scope decision: three states · URL authoritative · six guardrails) + section 9.6 (the route capability matrix, the cross-reference table for this section).
> - (Section 9 has been frozen since interaction revision 2.15; this section only turns it into a contract and does not change the interaction wording.)
> - Construction is tracked as its own work package; acceptance has ten dedicated items, run as one segment of the acceptance gate.
> - 🔴 **About the gap in numbering**: sections 2.4 / 2.5 are **unused** (numbers reserved in work-package order when the four objectives were decided); they are not missing sections, and nobody should go looking for them.

#### 2.6.0 🔴 Single-source-of-truth prerequisite: `?scope=` must first acquire one platform-wide meaning (a same-name-different-meaning collision was measured)

**Survey result (2026-09-09, 🔵 file:line)**: `?scope=` is already taken by `platform/src/app/api/admin/model-config/route.ts:98,152`
— that is the **"model-settings scope" of the [model-configuration design](./model-configuration.md)** (`SCOPES` admits only `global` in its first phase), a **same-name-different-meaning** collision with this section's "execution scope";
the two grammars **happen to share exactly one legal value, `global`**. This is the hardest drift shape to detect: everything agrees until the day both sides grow a targetId dimension.

🔴 **And that day has already been written into the design**: the feature map's row "AI model card for this region" literally says
**`PUT model-config scope=<targetId>#global`** — that is, the per-region model override of the model-configuration design (interaction design, section 1.6)
**plans to put targetId into `?scope=`**, colliding head-on with this section's `?scope=<targetId>` on the very same parameter with a completely different meaning
(one is "which region's model settings to change", the other is "which region I am currently viewing"). ⇒ This is not a hypothetical risk; it is a **scheduled collision** and must be separated now.
Precedent of the same kind = `targetType` versus the planner's `warehouse` (the change-safety rule on second definitions).

**Decision**:

| Item | Decision |
|---|---|
| `?scope=` | **the one** platform-wide meaning = **execution scope** (the grammar of this section) |
| Model-settings scope | parameter **renamed `settingScope`**; `GET/DELETE /api/admin/model-config` receiving `scope` ⇒ **400 `ScopeParamRenamed`**, and the message names the new parameter |
| 🔴 Compatibility alias | **None.** Keeping an alias for one release = two grammars keep coexisting and the drift is merely postponed, while the caller is **in one place only** (`components/settings/AiModelCard.tsx:268` + three unit tests); changing now is the cheapest |
| Gate | unit test `scope-grammar-guard`: `searchParams.get("scope")` **must not appear** anywhere in the repository except `lib/scope/**` and `lib/exec-env/scope.ts`; the literal `"scope"` must not appear as an input parameter name inside the `model-config` route |

#### 2.6.1 Grammar (single author = `platform/src/lib/scope/scope.ts`)

```ts
export type ScopeKind = "global" | "target" | "compare";
export type TargetScope =
  | { kind: "global" }
  | { kind: "target"; targetId: string }
  | { kind: "compare"; targetIds: string[] };   // 2–4 after deduplication, order kept
```text

| Form | URL literal | Notes |
|---|---|---|
| All | `?scope=global` **or the parameter absent** | the default is `global` = current behavior (rollback point) |
| One region | `?scope=tgt_usw2_a` | the value is the **raw `targetId`** (not the region, not the slug) |
| Compare | `?scope=cmp:tgt_home,tgt_usw2_a` | prefix `cmp:` + **ASCII comma** separated; **2–4** after deduplication; the order is the sheet / column order |

🔴 **The validity of a `targetId` must be decided by calling `isValidTargetId()` from `lib/exec-env/target-id.ts`** (the single author of the regular expression of section 1.1a;
that file has zero imports ⇒ it is safe to reference from the client); `scope.ts` **must not carry a second copy of the regular expression**. Contract-drift unit test: `TARGET_ID_PATTERN`
is compared character for character with the table in this section.

**Any illegal value is `null` (no guessing, no partial acceptance)**: `cmp:` with only 1 entry / more than 4 / an illegal targetId / an empty segment / leading or trailing whitespace /
upper case / separated by semicolons or spaces / `global` mixed into the `cmp:` list ⇒ **the whole scope is judged illegal**, and the caller handles it per 2.6.5.

#### 2.6.2 Reader `readScope(req)` (server side; `platform/src/lib/exec-env/scope.ts`)

| Item | Decision |
|---|---|
| **Source** | 🔴 **URL query only** (`req.nextUrl.searchParams`). **There is no second source** |
| 🔴 **`x-bgp-target-id` is not introduced** | Repository-wide measurement: that request header **currently appears nowhere** (`grep -rn x-bgp-target-id platform/src` = 0). Decision = **never introduce it**. Reason: the global fetch interceptor in `lib/auth/AuthProvider.tsx:64-69` already injects `x-bgp-project` / `x-bgp-env` from localStorage, and adding a third injection of the same kind is **the most natural next step** — and that step would turn "the region the browser last selected" into the server's basis for authorization / execution (explicitly forbidden by the interaction design, section 9.2). **The root fix = make the header not exist** (the change-safety rule that illegal states must be unrepresentable), not a runtime check that ignores it |
| Gate | unit test `scope-header-guard`: ① a repository-wide `grep` must not find `x-bgp-target-id` (including an allow-list-style negative assertion on `AuthProvider.tsx`); ② **mutation**: temporarily make `readScope` read that header ⇒ the unit test for the acceptance item "scope comes only from the URL" must **turn red** (if it does not, the gate is empty) |
| Default | parameter missing / empty string ⇒ `{kind:"global"}` (= current behavior) |
| Illegal | parse failure ⇒ **400 `InvalidScope`**; the message contains the raw value received and the legal grammar. 🔴 **No fallback to global, no fallback to home** |
| Validation | every targetId of `target` / `compare` must pass registry visibility (2.6.5) |

#### 2.6.3 Write routes **ignore** scope (this one is load-bearing for security)

**Write routes** (POST / PUT / PATCH / DELETE) **never read `?scope=`**. The execution target comes only from: ① the explicit `targetId` / `targets` in the request body;
② the resource definition's own binding (`bindingTargets`, the missing-parameter rule of `.../start` in section 2.3); ③ the resource identity in the URL path.
Reason: scope is **view state**; what sits in the browser's address bar should not decide "in which region this really runs"; and section 2.3 has already fixed the value rules for the write path,
so letting scope participate would be a second definition.
Gate: unit test `scope-write-guard` — `readScope` must not appear in the handler source of any write method (allow-list: 0 entries).

#### 2.6.4 Filter `scopeFilter(scope, kind)` — 🔴 two resource classes, two methods, never mixed

| Class | Shape of the target dimension | Method | Tables / attributes involved |
|---|---|---|---|
| **A. Scalar stamp** | a single-valued attribute on the row | generate a **DDB `FilterExpression` fragment** shaped like `projectFilter` / `envFilter`: `{clause, values, names?}` | `bgp-task-runs`.`targetId` (section 1.2) · cost rows `.targetId` in `bgp-cost-daily` (the cost-row target stamp) · data sources `.ownerTargetId` (`DATASOURCE_OWNER_TARGET_ATTR` at `lib/datasource/placement-shared.ts:6`) |
| **B. Binding list** | the row carries `targets: string[]`, and **legacy rows without the attribute belong to home** | 🔴 **in-memory filtering, calling `bindingTargets(row)`** (`lib/exec-env/data-plane-target.ts:205`, already 20 consumers = the established SSOT) and then intersecting with the scope | batch jobs / engine jobs / workflows / sync / modeling definitions |

🔴 **Class B must not be written as a DDB expression**: `(contains(targets,:tid) OR (attribute_not_exists(targets) AND :isHome))` would
**copy the legacy fallback semantics of `bindingTargets` into a second place**, and those semantics also include the three-level fallback "if `targets` is an empty array, fall back to the single-valued `targetId`, then to home"
(:206-213) — one copy and drift is guaranteed. Measured: currently **0** occurrences of `contains(targets` in the whole repository; keep it at 0.
Gate: unit test `scope-filter-guard` asserts there is no `contains(targets` / `contains(#targets` anywhere in the repository.

**Semantics**: `global` ⇒ no target-dimension filter at all (= current behavior, rollback point); `target` ⇒ keep only that target;
`compare` ⇒ keep everything in the list (the page then splits the rows by target).
`scopeFilter` is **combined side by side (and)** with `projectFilter` / `envFilter`; it does not replace them.

🔴 **Correction at delivery in revision 3.35: when class A names home it must also fetch two more kinds of rows, otherwise the home view reports fewer rows than DDB** (the acceptance items for scope filtering compare row by row):
① legacy rows **without the attribute** (written before the target stamp was introduced) ⇒ `attribute_not_exists`;
② rows whose **attribute is the empty string** ⇒ must test **explicitly** `#attr = ""`. Item ② is a real semantic difference forced out by the parity unit test at delivery:
DDB's `attribute_not_exists` **does not match the empty string** (an empty string is "present and empty"), while the in-memory `scalarTargetOf` classifies the empty string as home.
When the two sides disagree, the correct fix is **to make the DDB side fetch the empty string too** (the bad row stays visible, lands in home, and an administrator can find it),
**not** to loosen the unit test to get green — that would make a bad row disappear from every view (fail-silent).
The two sides are compared **cell by cell** by the `scope-filter-parity` unit test (a small expression evaluator that follows DDB semantics strictly).

#### 2.6.5 Target validation and error codes (🔴 never fall back to home)

| Situation | Response (`error.code` comes from the site-wide `ApiErrorCode` vocabulary; **no second vocabulary is started**) |
|---|---|
| Illegal grammar | **400 `INVALID_SCOPE`**; the message returns `detail.received` = the raw value received |
| targetId grammatically legal but absent from the registry / already tombstoned | **404 `TARGET_NOT_FOUND`**; the text states explicitly "will not switch back to the home region automatically" |
| Exists but not visible to the current identity (workspace not authorized, section 3.12 RBAC × target) | **403 `TARGET_FORBIDDEN`**; the decision reuses `residency.accessAllows` + `accessDeniedReason` (presentation = authorization, single author) |
| Any one entry of `compare` fails | **the whole request is rejected** (with the code of the first failing entry); no "show what can be shown first" |
| Exists and visible, but **currently cannot accept work** (`draining` / phase not ready / health unknown / in-flight operation) | 🆕 **409 `TARGET_NOT_READY`**; the message carries the sentence from `serviceabilityReason()` verbatim + a pointer to Execution Environments. 🔴 **No silent switch to another region**: data that silently changes shape is far harder to debug than an error |
| Exists but the component this page needs is **not installed** (for example, no `redshift`) | **200** + `{capability:"unavailable", reason}` (the shape already fixed in section 3.4; not an error) |

🔴 **Correction at delivery in revision 3.35: the three codes go into the `ApiErrorCode` union of `lib/api-response.ts`** (the originally proposed PascalCase such as `InvalidScope` is **a second code vocabulary**
— the front end and the acceptance scripts would then have to maintain two mappings, exactly the drift that section 2.6.0 just dismantled). Final: `INVALID_SCOPE` / `TARGET_NOT_FOUND` / `TARGET_FORBIDDEN`,
in the same family as `VALIDATION_FAILED` / `UPSTREAM_ERROR`; emitted through the `apiError` envelope, not hand-built JSON.

🔴 **Three forbidden fallbacks** (each has occurred elsewhere): silent fallback to `tgt_home` (= a silent cross-jurisdiction border crossing) · silent fallback to `global`
(= the user believes they are looking at one region but is looking at all of them) · the front end catching a 4xx and switching itself to global (= swallowing the server's refusal).

#### 2.6.5a 🆕 Revision 3.36: the picker list = **only targets that are fully installed** (decided on 2026-09-09)

**The decision as stated**: "The switchable region drop-down may show only regions that are installed now; regions that do not exist or are not installed must not appear in the region-switch list.
Right after the system is installed and initialized there is, in theory, only the home region."

| Item | Decision |
|---|---|
| List source | 🔴 **Corrected against a real environment in revision 3.37**: `listTargetsRaw()` passed through four checks — ① the descriptor is valid (`descriptorViolation === null`) ② not a tombstone (`status !== "deleted"`) ③ **initialization completed** (`ready === true` ∨ `observed.phase === "ready"`) ④ `accessAllows(t, projectId)`. **`listActiveTargets()` is not used** |
| 🔴 Why `listActiveTargets()` cannot be used (the first version was written that way; the very first acceptance criterion went red on the spot) | Its criterion is `serviceabilityVerdict` = "**can it accept new work right now**", which filters out a **perfectly well installed** region because of `health=unknown` (one probe not yet confirmed) / an in-flight operation / `intent≠serve`. Measured on 2026-09-09: `tgt_usw2_a` was at `health=unknown` because of a stale probe item left behind by the previous code version ⇒ the header drop-down **showed only `tgt_home`**, and that region **vanished from the UI**. "Something disappeared and nobody said so" is precisely the number-one pain that guardrail 1 exists to eliminate — not to mention that the moment users most need to see a region is exactly when it is unhealthy |
| ⇒ Two separate things | **Whether it appears in the drop-down** = "is it installed" (the four checks above); **whether it can accept work** = `describeServiceability()`, returned to the front end as **a badge on each item** ("Not accepting work" + the reason on hover), **not as a filter condition**. The write path is still rejected by `assertBindableTarget` as before — the correct landing of "presentation ≠ authorization" is **visible ≠ runnable**, not "invisible" |
| Therefore **not in the list** | unregistered / tombstoned (`deleted`) / `registered` · `initializing` · `testing` · `failed` that never reached ready (not yet installed) / descriptor invalid / not authorized for this workspace. **`draining` · `decommissioning` · health-unconfirmed targets are still listed** (with the "Not accepting work" badge) |
| Brand-new environment | after initialization only `tgt_home` exists ⇒ the list has a single item. In that case, by the **single-target equivalence rule** of section 2.6.7, `target-only` pages do not show "Select an execution scope" |
| Endpoint | `GET /api/exec-targets?component=any` (reuses the existing presentation endpoint instead of opening a new one: the reason that route exists is "choosing a region is an everyday action of an ordinary developer and should not require an administrator"). Returns `targetId / region / jurisdiction / isHome / displayName / components[]` (for the component badges). 🔴 **Revision 3.53 (a defect fixed in October 2026): the `component=` dimension is a closed list `redshift / airflow / core / any`**, single author `platform/src/lib/exec-env/exec-targets-dims.ts` (the route validation and the parameter type of the client `fetchExecTargets` are the same copy; a value not in the list ⇒ 400 that lists the allowed values, not an empty list): `redshift` = warehouse installed (batch jobs / direct query / modeling / EMR) · `airflow` = any scheduler component installed (the multi-select on "New" in orchestration; the same criterion as `requireMwaaForTargets` when creating a workflow; the home region is always listed) · `core` = every target that is in place (governance "New table" for S3 Tables) · `any` = the execution-scope list of this section. Before the fix the orchestration page sent `airflow`, the 400 was swallowed into an empty list, and the multi-region fan-out entry on the page sat greyed out for a month |
| 🔴 List ≠ authorization | Consistent with the existing rule: the real rejection still happens on the write path. The list only solves "do not let the user pick a region that does not exist at all" |

#### 2.6.5b 🆕 Revision 3.36: cold start = **restore the last selection** (decided on 2026-09-09)

**The decision as stated**: "Show the region you displayed last time; a refresh must not force the user to choose again."

| Situation | Behavior |
|---|---|
| The URL carries `?scope=` | **the URL wins** (section 2.6.2 unchanged); it is also written to `bgp-scope:<projectId>:<env>` |
| The URL has no `?scope=`, localStorage has a last selection and it is **still** in the list | **restore it**, and **immediately `replaceState` to write `?scope=` back into the address bar** ⇒ the address bar and the view are always consistent (the URL is still the single truth; it is merely seeded from the last selection) |
| The URL has none, and the localStorage target is **no longer in the list** (deleted / not fully installed / workspace authorization revoked) | fall back to "All" and **show one explicit notice**: "The execution scope X you selected last time is no longer available; switched back to 'All'". 🔴 This **does not violate** the "no silent fallback" rule of section 2.6.5: that rule constrains the case where **the URL explicitly names** a bad target (it must error and must not rewrite the URL); here the URL says nothing, falling back to **All** loses no data, and **there is an explicit notice** |
| The URL has none and localStorage has none | "All" (= current behavior; the rollback point checked by acceptance) |
| Switching workspace / environment | the key is isolated by `projectId + env` ⇒ each naturally remembers its own; after a switch, the restored value is **validated against the list once more** |

#### 2.6.6 `GET /api/scope/counts?resource=<kind>` (the data source of guardrail 1, "do not let users lose things")

| Item | Decision |
|---|---|
| Input | `resource` ∈ `etl-job` \| `engine-job` \| `sync` \| `workflow` \| `datasource` \| `model-table` \| `code-table` \| **`backfill-plan`** (added in revision 3.38, phase 1 of the backfill scope work) (a union; illegal ⇒ **400 `VALIDATION_FAILED`** listing all the allowed values). 🔴 **Corrected in revision 3.35: `run` is removed from this endpoint** — the run list is **time-windowed**, and a full-table count without a window necessarily disagrees with the list (the row-count acceptance item would go falsely red because of it); the guardrail-1 number for runs is returned by `GET /api/monitor/runs` **as `countsByTarget` in its response** (same query, same window), under the monitor unit of construction step 5 |
| Response | `{ counts: { [targetId]: number }, total: number, unsupported?: false }` — counted **for the current workspace + environment**, **including `tgt_home`** |
| 🔴 The endpoint returns **raw** counts; the hint bar sums only the **visible** ones | Corrected against a real environment in revision 3.37: measurement found 6 jobs still bound to the **deleted** `tgt_usw2_b` / `tgt_usw2_c` (the regions were deleted; the bindings stayed on the job rows). The endpoint reports them as they are (it is the DDB truth), but guardrail 1's "N more items in other execution scopes" **sums only the targets selectable in the current drop-down** — otherwise it would give a number the user **cannot click through to**, which raises more suspicion about the UI than giving none. Those 6 belong to **unbind cleanup**, not to scope |
| Source of truth | 🔴 **Counts only the rows in the home control-plane DDB** (definition tables / the data-source table / the two modeling tables). Class B is attributed by `bindingTargets`; a row bound to N regions counts 1 under each of the N keys (**hence `total` may be smaller than the sum over the keys**; the response states this with `sumMayExceedTotal`); class A (data sources) uses the scalar stamp, and one row belongs to one region |
| 🔴 Pagination | **Must paginate to the end** (`LastEvaluatedKey` loop). A single DDB response is the amount **before filtering**; without pagination the count is silently low — the hint bar says "3 more" while there really are 30, which is exactly the thing guardrail 1 is meant to prevent (the same pit really occurred on `GET /api/monitor/runs`). The criterion carries a **mutation**: removing the pagination must go red |
| 🔴 No trimming by visibility | What is counted is **this workspace's own rows**; trimming by target visibility would make N disagree with DDB, and the acceptance item checks against DDB row by row |
| 🔴 **Binding attribute names are not uniform** (added in revision 3.38) | Class B binding lists **are not all called `targets`**: measurement shows that **backfill-plan rows use `execTargets`** (`BACKFILL_PLAN_BINDING_ATTR` in `lib/backfill/types.ts`). Decision = the registry gains an optional `bindingAttr`; `filterRowsByScope(rows, scope, bindingAttr)` / `countRowsByBinding(rows, bindingAttr)` **only swap the attribute name**, and the three-level fallback still has `bindingTargets` as its only author. 🔴 Two hard constraints: ① the registry **must not** contain a literal; it must reference the constant exported by that module itself (the `scope-filter-guard` gate asserts that the registry contains no `"execTargets"` anywhere in the repository); ② callers **must not** do `rows.map(r => ({...r, targets: r.execTargets}))` — that would stuff a field the contract does not have into the response body, and once the front end reads it, it can never be removed again. 🔴 Why this deserves a place in the contract: reading that table with the default attribute name makes **every row fall back to home** ⇒ the home view shows "everything is here", the other regions show "all empty", and **the symptom looks like the filter is working** |
| Backfill plans (added in revision 3.38) | `backfill-plan` is read by **directly reusing `listPlans(projectId)`** (`Query pk=backfill#<projectId>`; the workspace dimension is in the pk, and there is no environment dimension). 🔴 No separate Scan may be written here: that would be a second reader, and a Scan returns the plans of **all workspaces** ⇒ the hint bar would count other workspaces' items |
| The two modeling tables | `model-table` / `code-table` are **platform-wide global** (no workspace / environment dimension); they are read by **directly reusing** `listModelTables()` / `listCodeTables()` (the only readers of those two; writing another Query here would be a second reader — measurement shows the two pks are lower-case `modeltable` / `codetable`, and one letter off silently counts 0). ⚠️ **Known and recorded**: these two functions do not paginate themselves ⇒ this kind's count is bound by the same cap as the modeling list page, **under the same rule** (deliberate: a count that exceeds the list by a few rows is harder to debug); a real fix must fix the list too |
| Unsupported kinds | Warehouse direct-query kinds (governance metadata / database and table inventories) **do not enter this endpoint**: their truth lives in each region's warehouse, and counting once would wake up every region's Serverless warehouse (**money on a click**). For those pages guardrail 1 becomes **no number, only a "switch to All" entry**, and the interaction design, section 9.6 names them in its notes column |
| Permission | goes through `requireProject(req,"viewer")`; returns counts only for the targets visible to this workspace |
| Cache | none (the counts must agree with the list page at the same instant; otherwise caching would produce false reds in acceptance) |

#### 2.6.7 Route capability declaration (a **discriminated union**; since revision 3.41 each of the three states has required fields)

```ts
// 🔴 Revision 3.36 correction: `compare` is **not** in the union — "can this page show one region" and "can it compare several regions"
// are two independent things (`/finops` supports both); squeezing them into one field forces a choice and the matrix would lie.
export type ScopeCapability = "global-and-target" | "target-only" | "global-only";

// 🔴🔴 Revision 3.41 (decided on 2026-09-10: "both banner sentences are wrong; not one page across the platform may be missed"):
// `scopeWired: boolean` **is deleted** and replaced by a discriminated union — in the old type `false` was a **zero-cost** silent exemption,
// and `global-only` was even easier (one assertion exempts a whole page; `/settings` was measured doing exactly that, showing the home region's
// workgroup / buckets / VPC to all regions as "platform configuration" — that is lying, which is worse than "not filtered yet"). Each of the three states carries required fields:
export type ScopeDecl =
  | { scope: Exclude<ScopeCapability, "global-only">; wired: true;
      /** wired but **partial**: which blocks are not per-region must be registered structurally (not merely written in the page body) */
      partial?: { note: string }; scopeCompare?: true }
  | { scope: Exclude<ScopeCapability, "global-only">; wired: false;
      /** what is missing: rendered directly to the user; tautologies such as "to be wired" are not allowed */
      missing: string; scopeCompare?: true }
  | { scope: "global-only";
      /** 🔴 **closed reason code** (not free text: free text can be a tautology, and the exemption becomes zero-cost again) */
      globalReason: GlobalReasonCode;
      /** where to go for a per-region view: a real route or `self` (the gate checks that it exists; a typo sends the user into a 404) */
      insteadSee: string; scopeCompare?: true };
```

🔴 **The registration data lives in `lib/scope/route-scope.ts` (pure `.ts`) rather than on each leaf of `routes.tsx`**: this repository's vitest runs with
`environment: node` and deliberately does not process JSX (it runs the pure logic layer only) ⇒ the gate cannot import `routes.tsx`, yet this table is precisely what **the gate must
check entry by entry**. Nothing of the "illegal states unrepresentable" rule is lost — the type of `Leaf.key` is the `keyof` of this table, so adding a page to the menu without registering it ⇒ **`tsc` goes red immediately**.

| Item | Decision |
|---|---|
| Location | `Leaf` in `platform/src/components/layout/routes.tsx` (currently `{key, icon, label}`). **Both fields are required** ⇒ a new page that omits them makes `tsc` go red immediately (illegal states unrepresentable); "a new page silently renders as All" cannot happen |
| Non-menu pages | 🔴 The platform has **9** routes that have a `page.tsx` but are **not in the menu tree** (measured: `/login` `/metrics` `/schedule` `/sla` `/sync/[id]` `/workflow/[id]` `/theme-gallery` `/theme-gallery/[id]` `/theme-preview`); they cannot get a `Leaf` ⇒ a separate explicit registration, `EXTRA_ROUTE_SCOPE` in `lib/scope/route-capability.ts`, covered by the gate together with `routes.tsx`. **Total page routes = 31 + 9 = 40** |
| Value per route | = the matrix in the interaction design, section 9.6 (table A, 31 entries + table B, 9 entries, including each page's **wiring package**) |
| 🔴 `wired:false` | The third shell of ScopeGate: the page renders as usual + a **persistent** hint bar at the top; 🔴 **since revision 3.41 the bar must contain that page's own "what is missing"** — previously nine pages shared one sentence and users could not tell what was missing (that sentence was called out as "wrong" on 2026-09-10); since 2026-11-04 internal ticket numbers are no longer shown (tickets are tracked outside the product) |
| 🔴 `partial` (new in revision 3.41) | Must be registered when a page is wired **but a few blocks are not per-region**; ScopeGate renders a persistent explanatory bar. Reason: **partial is the norm** (only two of the six tabs of `/modeling` have a region dimension; the billing overview of `/finops` would need re-collection to be per-region). Hidden in the page body = the next maintainer will miss it, and a user who sees platform-wide numbers on the page with no explanation will misread in one of two ways (believing those blocks belong to this region too / believing the whole page is unfiltered) |
| 🔴 `global-only` must justify itself | Required `globalReason` (closed enum) + `insteadSee`. **A page that cannot come up with a reason code should not declare itself global** — this directly caught `/settings` (pseudo-global) and 6 more pages (Copilot plans / Skills / Business glossary / Ops dashboard / Incident knowledge base / Workspaces), which have been moved honestly into the `wired:false` list |
| 🔴🔴 Ratchet | `route-scope.ts` exports `NOT_WIRED_LIMIT`; the `scope-coverage-guard` gate asserts "the actual number of `wired:false` entries **equals it exactly**" and that it is **≤ the starting baseline of 22**. A new unwired page ⇒ red; wiring one page must decrement it by 1 in the same commit (decrementing by more is also red). This is the mechanical guarantee behind the instruction "**I do not want to say this a second time**": relying on memory forgets, a number that goes red does not |
| 🔴 Single-target equivalence rule | On a `target-only` page under the `global` view, if the current workspace has **exactly 1** visible target ⇒ render directly for that target and **do not show "Select an execution scope"**. This **is not** the fallback forbidden by 2.6.5: with one region, "All" and "that one region" are the same set. With **≥2** visible targets the choice must be explicit, and under the `global` view no region's data may be rendered (an acceptance item checks this) |
| Five shells (revision 3.41) | `global-only` ⇒ **reason + where to look** (the picker is not reset) · `target-only` under global with ≥2 visible targets ⇒ "Select an execution scope" (**the page must show no home data whatsoever**) · `wired:false` ⇒ content + **what is missing** · `wired:true` with `partial` ⇒ content + **which blocks are not per-region** · otherwise ⇒ normal content |

#### 2.6.8 Gate checklist for this section (landed together with construction step 1, against "the contract is written but the code does not follow")

| Gate | What it asserts |
|---|---|
| `scope-grammar-guard` | the grammar's regular expression ↔ the table in this section, character for character; `TARGET_ID_PATTERN` reused; exactly one `searchParams.get("scope")` in the whole repository |
| `scope-header-guard` | no `x-bgp-target-id` anywhere in the repository; the mutation (making the header effective) must go red |
| `scope-write-guard` | write-method handlers do not contain `readScope` |
| `scope-filter-guard` | no `contains(targets` anywhere in the repository; class B only through `bindingTargets` |
| `scope-capability-guard` | every `Leaf` in `routes.tsx` has `scope` + `scopeWired`; `EXTRA_ROUTE_SCOPE` covers the 9 non-menu pages; **registered total == number of `page.tsx` routes in the repository == 40** (counted with a glob and compared, not hard-coded); `global-only ⇒ scopeWired===true`; the entry counts of tables A / B in the interaction design, section 9.6 stay in step with the code entry by entry; one missing ⇒ red |
| `doc-consistency` (existing gate) | the numbering ranges of this section agree with the interaction design, section 9.6 and with the acceptance items for the execution scope |

---

### 2.7 🆕 Revision 3.44: the RunGroup interface

> - Basis: the [interaction design](./multi-region-execution-interaction.md), section 9.4 (the parent object of a linked run) · data contract section 1.3a, store S7 (`bgp-run-groups`) · mechanism section 3.17.
> - Construction is tracked as its own work package; acceptance has nine dedicated items, run as one segment of the acceptance gate.

| Endpoint | Input | Response / semantics |
|---|---|---|
| 🆕 GET `/api/run-groups/[id]` | — | `{group:{…S7 attributes…}, children:[{targetId, region, runId, status, taskType, startedAt, finishedAt?, definitionVersion?, error?}], derivedStatus, unknownChildStatuses?}`. 🔴 **If `region` cannot be resolved it is `null`; the row must not be hidden** — after an execution environment has been deleted, its historical runs must still be visible (the same discipline as Ask-Your-Data session cards: a card is listed even when its title cannot be read). 🔴 **Back-end native identifiers (`statementId` / `glueJobRunId` / `nativeRunId`) do not enter the response**; `publicChild()` projects them away (they are used on the server only when cancelling). 🔴 Child statuses the platform does not recognize are **carried out as they are** via `unknownChildStatuses` (silence would mean that nobody knows whether some run is alive or dead). 🔴 `derivedStatus` is **derived at read time** by `deriveGroupStatus(children)`; if it disagrees with the `status` materialized in the table, **the derived value is returned** and reconciled back in passing (section 3.17); when the child runs cannot be read, **an empty group must not be returned** (the front end would render an empty group as "nothing ran this time") ⇒ a read failure is always a 5xx with the original message |
| 🆕 POST `/api/run-groups/[id]/cancel` | — | For **every child run that is still running**, call the engine cancel of that run's own target (Redshift `CancelStatement` / Glue `BatchStopJobRun` / EMR `CancelJobRun`; the client is built for **that run's targetId**, the same pattern as `redshiftClientForTarget`). 🔴 **Child runs already in a terminal state are not touched** (succeeded must not be changed to stopped — that is forging history); an independent result per run, `{results:[{targetId, runId, cancelled:boolean, reason?}]}`, overall 200 |
| 🆕 POST `/api/run-groups/[id]/retry-failed` | — | 🔴 **Correction at delivery in revision 3.44: returns only a "retry plan" and deliberately does not fan out itself** — `{retryOfRunGroupId, definitionKind, definitionId, targets[]}`; the caller takes it to **the original run route** together with `retryOfRunGroupId`, and that single author creates the new group + fans out + keeps the ledger. Reason: the run route contains **four** pieces of logic — the residency-consent precondition / binding validation / per-target audit / the run lock — and copying them here would be a second author (the same family as the incident where `schedule/enable` hard-coded the legacy generator). 🔴 "Which regions count as failed" **is decided by the server** (the failed child runs ∪ the targets `skipped` in the group) — if the client chose them itself, it might rerun the successful regions too. 🔴 **The original group is not changed by a single byte** (the whole file of this endpoint may not contain any call that writes a group row; the gate scans for it). Still running ⇒ **409** `still-running`; no failed regions ⇒ **409** `nothing-failed` (an empty retry must not be created silently) |
| 🆕 GET `/api/etl-jobs/[id]/run-groups` · `/api/engines/[engine]/[id]/run-groups` · `/api/workflow/[id]/run-groups` | `?limit=` | The most recent group rows of that definition (through the GSI `byDefinition`, **no Scan**); 🔴 **a single-region run does not form a group** ⇒ it does not appear here (the run history stays one row, as before; checked by an acceptance item) |

**Two seams with existing routes** (the change surface is just these two places; the blast-radius analysis listed all consumers):
- The fan-out loop of `POST /api/etl-jobs/[id]/run` and `POST /api/engines/[engine]/[id]/run` becomes **`openRunGroup()` → submit per target → `recordAccepted()` / `recordSkipped()`**; the shape of the `runGroupId` field **already present** in both routes' responses is unchanged (zero change for existing callers).
- 🔴 `openRunGroup()` creates a group only when **`runTargets.length > 1`** (the same criterion and the same author as `runGroupIdFor()`) — otherwise the read-side criterion "a single region does not form a group" would be distorted.
- 🔴 **Correction at delivery in revision 3.44, ①: "a single region does not form a group" has exactly one exception = the retry chain**: when only **one** region failed, `runGroupIdFor(targets, {forceGroup:true})` must still create a group; otherwise the new run **cannot point back to the original group**, and the chain that the acceptance item requires breaks right here. A retry is by its nature the continuation of the previous linked run. `forceGroup` **may only be driven by `retryOfRunGroupId`** (hard-coding `true` would make every single-region run create a group with one region; the gate pins this line).
- 🔴 **Correction at delivery in revision 3.44, ②: "strict on group creation, best-effort on the ledger"**: if `openRunGroup` fails to write ⇒ **the run is refused** (checked by an acceptance item); if `recordAccepted` / `recordSkipped` fail to write, **the runs already submitted are not revoked**, and the response honestly carries `groupLedgerIncomplete[]`. Reason: **the truth source for child runs is the run row itself** (`listRunGroupChildren` reads by taskId + runGroupId); `accepted` is only an annotation ⇒ the group-status derivation **remains correct** even if that cell is never written; and at that moment the runs have already been submitted, so failing the whole request for the sake of the ledger would amount to "telling the user nothing ran while it is clearly running".
- 🔴 **Correction at delivery in revision 3.44, ③: a group's permission = the permission of its definition**: a group row has no member table ⇒ all three `/api/run-groups/**` routes go through `loadRunGroupForRequest()`, which falls back to the existing `guardResourceAccess(definition row)` (read: `viewer`; the two write actions: `editor`); which table the definition row is read from is not written as a switch either — it uses `getResourceMeta(definitionKind)` of the versioning module. Definition already deleted ⇒ **404 `definition-deleted`** (the history remains, but no operation can be performed on it anymore).
- 🔴 **Correction at delivery in revision 3.44, ④: "cancel one run" had no single author anywhere on the platform until now** (only three mutually independent entry points: the engine SPI `stop` / the sync task's `BatchStopJobRun` / the ad-hoc query's `CancelStatement`) ⇒ new `lib/monitor/run-cancel.ts`: dispatches by `taskType`, and the client is always built for **that run's own targetId** (using the home client to stop a non-home run does not raise an error — it simply stops nothing and reports success); an unrecognized `taskType` **says honestly "do not know how to cancel this"** and points to where it can be stopped manually (silent success would make the page say "cancelled" while the back end keeps burning money).

## 3. Pseudocode for the key mechanisms

### 3.1 Target registry + client factory + splitting runtime-lib across two regions

```text
// lib/exec-env/registry.ts (new): getTarget(targetId) / requireReadyTarget() / listActiveTargets() / getHomeTarget() / listTargetsByRegion()
//   only ready=true is accepted; a missing / stale non-home target ⇒ throw (fail-closed, never fall back to home)
// 🔴🔴 revision 3.4 correction (replaces the former "60s TTL"; a P0 finding of the second external review): **the admission verdict must not be cached, and it must be a strongly consistent read**.
//   The original phrase "(60s TTL)" was implemented as "the whole descriptor goes into a 60s positive cache", so the **mutable admission bits**
//   status / ready / lockEpoch / credentialEpoch were cached along with it ⇒ after the management plane atomically flips a target to draining / deleted,
//   an ECS task that already holds the cache **keeps admitting new runs as active for up to 60s** (zero DDB calls, no log anomaly); and after the TTL expires,
//   the default **eventually consistent** GetItem still cannot give the guarantee admission needs. This is not ordinary cache staleness; it is a safety verdict required by the contract being bypassed.
//   **Decision**:
//     · getTarget / requireReadyTarget: `GetItem({ConsistentRead:true})` on every call, **no cache read, no cache write**;
//     · the resource bag / region / accountId are returned by the **same** read ⇒ no second cache layer is needed (a placement cache is deliberately **not introduced**:
//       it would only serve "callers that skip admission", which is exactly what is being forbidden);
//     · 🔴 **GSI `byRegion` is eventually consistent ⇒ forbidden for admission**. `listTargetsByRegion()` is an operations view only;
//       fan-out push-down must run every candidate **through `requireReadyTarget()` once more**;
//     · list-type calls must **page through `LastEvaluatedKey` to the end** (a truncated single page = silently missing targets; the same reason as the Scan→Query change in section 1.2).
//   **Why there is no cross-instance invalidation bus**: the cache rule in section 3.9b offers a choice of "cross-instance invalidation **or** a strongly consistent cutover gate";
//   this section takes the latter ⇒ the admission bits have no cross-instance staleness window, so an invalidation bus is a redundant part (and it also keeps the credentialEpoch of section 3.9b permanently fresh).
//   Cost: one strongly consistent GetItem per admission (item < 4KB ⇒ 1 RCU). Admission happens at the level of "dispatch one run / submit one query",
//   not per data row, so the volume is negligible; correctness takes precedence over saving this one read.
// lib/aws/clients.ts (new): getClient(Service, region) (Map cache); only the multi-region code paths are changed
// lib/workflow/runtime-lib.ts: _mk(spec) is split →
function _mk_exec(spec) { region = target.region }      // glue / redshift-data: execution region
function _mk_ctrl(spec) { region = spec.controlRegion } // dynamodb: [fixed control plane]
// DAG spec: target (execution) + controlRegion (new); legacy / ETL / EMR DAGs change the same way (7 hard-coded sites)
```

🔴 Three process-level single-value caches become **composite-keyed**: `admin-secret._arn` + `zeroetl._secretArnCache` → **`(targetId, project, purpose)`** (🔴 **the `purpose` dimension is mandatory**, otherwise the class ② read-only governance identity and the class ③ admin DDL **share one cache slot = the governance identity obtains admin credentials**; aligned with [the project-isolation design](./project-isolation.md), section 3.4, and unified with the credential factory of section 3.9); `platform-env._sgIdCache` → **keyed by targetId** (a pure location axis, **no project dimension**).

### 3.1a 🔴 Added in revision 3.4: **whole-package runtime validation** of the descriptor (an admission precondition; a P1 finding of the second external review)

The original implementation **cast** any Item read back from DDB **bare** `as ExecutionTarget` and looked only at `ready` / `status` ⇒ one misspelled field name,
one partial write, one item broken by a manual edit, would all enter the execution path in the shape of "something that looks like a valid descriptor".
**Decision: the admission path must pass a whole-package schema plus cross-field invariants; a validation failure ⇒ fail-closed + alert (never admit, never treat as home).**

| Check | Final rule |
|---|---|
| **schema** | Whole-package validation with `zod` (already a dependency in the repository); unknown extra attributes are **allowed** (forward compatibility: new fields written by a newer platform version must not make an older instance condemn the item), but **a wrong type on a known field ⇒ reject** |
| **Identity triple equality** | `pk === "env"` and `sk === targetId === the requested targetId`. Any inequality ⇒ reject (guards against "queried A, got B" and key-value / attribute drift) |
| **home invariant** | `targetId === "tgt_home"` ⟺ `isHome === true`; the `jurisdiction` of home must be `home`. Violating the equivalence ⇒ reject (blocks "impersonating home" and "home marked as a foreign jurisdiction") |
| **Location format** | `accountId` = 12 digits; `region` matches `^[a-z]{2}(-[a-z]+)+-\d$`; `partition ∈ {aws, aws-cn, aws-us-gov}` |
| **Partition ↔ region cross-check** | `cn-*` ⟺ `aws-cn`; `us-gov-*` ⟺ `aws-us-gov`; everything else ⟺ `aws`. Mismatch ⇒ reject (a wrong partition makes ARNs assemble wrongly and cross-border verdicts wrong) |
| **core completeness** | At admission, `components` is mandatory and must contain `core`; `resources` must have all of **`datalakeBucket / scriptsBucket / tableBucket / athenaWorkgroup / glueRoleArn / emrSecurityGroupId / emrSubnetIds[≥1]`** (the core list of section 1.1; `flinkSubnetIds` is optional). Any one missing ⇒ reject and **name exactly which one is missing** |
| **Resource ownership** | For every ARN-shaped value in `resources`, its **partition / region / accountId segments must match this descriptor** (global services with an empty region segment, such as IAM, are exempt from the region comparison). Blocks "a descriptor pointing at resources in another account / region" |
| 🆕 **Keys that must be ARNs** | 🔴 **Revision 3.5 (a P1 finding of the third external review)**: `glueRoleArn` / `redshiftSecretArn` / `flinkRoleArn` (🔴 revision 3.21 adds `emrExecutionRoleArn` / `redshiftCopyRoleArn` / `dmsKinesisRoleArn`) **must be valid ARNs; a malformed value is rejected**.<br>The original implementation only checked "non-empty string", and the ownership check did `continue` when "no ARN could be parsed" ⇒ **the more malformed, the less it was checked** (`glueRoleArn:"not-an-arn"` passed the whole package), exactly the wrong direction |
| 🆕 **Per-item shape** | Bucket names follow S3 rules; `emrSecurityGroupId` matches `sg-<8..17 hex>`; `emrSubnetIds` / `flinkSubnetIds` match `subnet-<8..17 hex>` **element by element** (the original implementation only checked "non-empty array", so `emrSubnetIds:[null]` passed); workgroup / database / environment name / subnet-group name follow identifier rules |
| 🆕 **Component ↔ resource pairing** | 🔴 Declaring an optional component **requires its actual named resources**: `redshift` ⇒ `redshiftWorkgroup` + `redshiftDatabase` + `redshiftSecretArn`; `mwaa` ⇒ `dagBucket` + `mwaaEnvName`; 🆕 revision 3.27 `airflow-serverless` ⇒ `workflowBucket` + `airflowServerlessRoleArn` + `airflowServerlessSgId`; `dms` ⇒ `dmsSubnetGroup`; `flink` ⇒ `flinkRoleArn`; `agentcore` ⇒ `agentcore.{genbiRuntimeArn,genbiMemoryId,gatewayUrl}`; 🆕 **revision 3.22** `residency-api` ⇒ `residencyAuditTable` + `residencyResultsTable` + `residencyBucket` (the three resources of the first residency-api slice, the regional result store of section 1.3a). `kafka` has no named field in section 1.1 ⇒ **deliberately no invariant** (do not invent a contract).<br>The original implementation did not check pairing ⇒ a component declared without its resources only blew up far away, when work was pushed down to that target |
| 🆕 **Execution-role keys (revision 3.21, per-target execution roles)** | 🔴 The four keys `glueRoleArn / emrExecutionRoleArn / redshiftCopyRoleArn / dmsKinesisRoleArn` have a single author, `lib/exec-env/exec-roles.ts` (key → naming kind: glueRole / emrServerlessRole / redshiftCopyRole / dmsKinesisRole; `expectedExecRoleName(targetId,key)` = this target's name from the naming single source of truth). Three rules: ① **data-plane resolution** (`resolveTargetGlue` / `resolveTargetEmr`) for non-home: key missing **or** role name ≠ this target's name ⇒ **throw** (the rejection reason states "redeploy this execution environment to switch roles") — the platform-side structural guarantee that "shared roles remain only for home", the mirror image of the synth-gate inversion check (check 6); ② **the only exception in the narrow channel of supplemental deployment (`mergeComponentResources`)**: execution-role keys may be **added** (no previous value ∧ new value = this target's name) or **switched one way from the home name to this target's name** (previous role name = the home name of that kind ∧ new value = this target's name); every other rewrite is rejected as before — the exception is judged by the single source of truth, and not a single byte of buckets / workgroups / credentials is touched, so this is not a relaxation of "add only, never modify"; ③ home names / missing keys on existing descriptors are **not condemned by this section** (otherwise an existing non-home target would become unusable on the spot before it is redeployed); they are guarded by two doors, the admission precondition `hasPerTargetExecRoles` (`residencyPrerequisite`, from the residency-audit work) and rule ①. Probing: if the key exists, probe for real (IAM GetRole + role name = the single-source-of-truth name); if the key is absent, no probe item is emitted (the precondition is judged at admission) |
| **`capabilities`** | If present it must be an array of strings; **the content is not validated and absence is not a rejection** (the vocabulary is not finalized and belongs to the control-plane construction batch; section 3.9b already forbids it from taking part in permission decisions) |
| **`getTargetRaw()` exception** | 🔴 Management-plane reads **do not** apply the filtering above (otherwise operators cannot see a broken item and therefore cannot repair it): `getTargetRaw` returns the item as is and the caller judges for itself; **the two admission entry points (`getTarget` / `requireReadyTarget`) must pass validation** |

### 3.2 🔴 Revision 3.22: the auditable closure `residencyAudit` (replaces the withdrawn `residencyGuard` / `classifyTrack` track-based rejection)

> 🔴 **Revision 3.22 correction ([the design document](./multi-region-execution-design.md), section 18, decision 6quinquies)**: this section used to be "residency dual-track wrapper + provenance-based track selection" — `residencyGuard` returned `ROUTE_TO_REGION_ONLY` for track 2 and `PASS_REGION_EXECUTE` for track 1, and `classifyTrack` selected the track by authentication method. **The whole passage is withdrawn**: the platform does not select tracks, does not reject, and sets no legal gate. Only two things remain, and both are part of **auditability**: ① if the audit cannot be written, reject (audit integrity, not compliance intervention); ② `requireReadyTarget` never does `?? homeTarget` (the fail-open removed in revision 3.2 still stands — that is admission correctness, unrelated to legal matters). `classifyTrack` is demoted to the audit field `authKind`.

```text
// lib/exec-env/residency.ts — single author (the remaining criteria / the allow-listed entry points / the dual audit write all live here)
async function residencyAudit({identity, authKind, targetId, entry, statementId?, sqlText?, triggeredBy?}): Promise<{auditId} | null> {
  const t = requireReadyTarget(targetId)          // the kernel already includes residencyPrerequisite; miss / not-ready / stale all throw (never ?? homeTarget)
  if (jurisdiction(t) === "home") return null      // home / same jurisdiction: the central recordAudit continues unchanged, not one character different
  await requireResidencyAck(identity, targetId)    // missing consent ⇒ 409 residency-ack-required (the response carries the current text and version); the operation is not executed
  const auditId = ulid()
  await putRegionAudit(t, {auditId, operatorSub: identity.sub, sqlText, statementId, entry, triggeredBy, authKind, ts})   // regional full record (bgp-region-audit-<slug>)
  await recordAuditSummary({auditId, sqlHash: sha256(sqlText), targetId, entry, rows?, durationMs?})                    // central summary (bgp-audit, no PII / no SQL text)
  // either failure ⇒ throw AuditUnavailable ⇒ the caller returns 503 audit-unavailable and the operation is not executed (audit integrity, fail-closed)
  return {auditId}
}
// allow-listed entry points (this cut): redshift/execute · redshift/result/[id] · redshift/history · modeling landing (land / apply) · run submission (etl-jobs run / engines run)
//   ⇒ the residency-wiring-guard test enumerates the allow-list = the audit-integrity gate: when the direct-query target-awareness work later makes the 5 direct-query paths target-aware, leaving out one wiring turns the gate red
// authKind (an audit field only; it no longer drives any branch): cognito-user-jwt | api-key | service | task-token | mwaa
function residencyPrerequisite(t): string | null {           // admission precondition (the only technical precondition; lands in serviceabilityVerdict; the management page and the data plane share one source)
  if (jurisdiction(t) === "home") return null
  if (!components(t).includes("residency-api")) return "cross-jurisdiction target has no residency-api (regional audit store) installed; not accepting work"
  if (!hasPerTargetExecRoles(t)) return "per-target execution roles missing (hard gate of this specification, section 6.1)"
  return null
}
function accessAllows(t, projectId): boolean {               // project allow-list (generic, any target)
  return !t.access || t.access.mode === "all-projects" || t.access.projects.includes(projectId)
}
```

> 🆕 **Revision 3.23, second-stage construction refinement (construction steps 9–12 of the residency-audit work; contract frozen on 2026-09-05)**
> - **The `entry` enumeration (an audit field, single author `lib/exec-env/residency.ts`)**: `execute` (direct-query submission, one row per target, written **before** submission — **revision 3.24**: the row therefore has no statementId; when a cross-jurisdiction statement is submitted, `auditId` is set as the Redshift `StatementName`, which is how statement ↔ audit are correlated; for home / same jurisdiction it is not set and the path is byte-for-byte unchanged) · `result` (fetching result rows, placed by the targetId in the handle) · `history` (on-demand read of the regional SQL text) · `modeling-land` (code-table landing / dimension-table apply, per target) · `run-submit` (ETL / engine job run submission, per target; `triggeredBy=manual|backfill|rerun|dryrun|schedule`).
> - **Scheduled runs (`triggeredBy=schedule`)**: the executor is MWAA (home only; the Python bypass writes the run row) and the platform process is not on the submission path ⇒ the regional audit is written by the platform when it **first observes** that run row (the `reconcileEtlJob` / EMR provider reconcile path, the same `residencyAudit`, `identity` = the system principal `service`, `authKind=mwaa`), and `residencyAuditId` is written back to the run row (conditional write `attribute_not_exists(residencyAuditId)` ⇒ idempotent, written exactly once). 🔴 This is "audit after observation", not "audit before submission" — recorded truthfully as a boundary of the scheduled path in the acceptance criteria (runtime-lib **does not write** the regional table: a second writer = a second author; the MWAA role is not granted regional-table permissions either).
> - **SQL history stays in the region (an acceptance criterion)**: `POST /api/redshift/history` **does not store `sql`** for a target row with `jurisdiction≠home`; it stores `{ residency:"region", sqlAvailable:"on-demand", region }` instead; the SQL text is written to the regional result table `bgp-region-results-<slug>` (`pk=<projectId>#<targetId>`, `sk=sql-history#<ts>#<historyId>`, `{ sqlText, historyId, operatorSub, ts }`); 🆕 `GET /api/redshift/history/[historyId]/sql` (project members; proxies a read of the regional table; `requireResidencyAck` first, then `residencyAudit(entry=history)`). 🔴 **Revision 3.23 correction**: step ④ of the residency-audit work originally wrote `history/[handleId]/sql` — the key of a history row is `historyId` (the handle is the statement's credential for fetching results and has nothing to do with history); built as originally written it would not find the row. home / same-jurisdiction rows are **byte-for-byte unchanged**.
> - **`POST /api/residency/ack`** takes `{ targetId, version, textHash }` (same shape as `residencyAck` at register; the server checks `isCurrentDisclaimerAck` character by character and does not trust the version the client claims; **revision 3.23 correction**: section 2.1 originally wrote `{targetId, version}` and omitted textHash); it writes the consent table `bgp-residency-acks` (`pk=<userSub>`, `sk=<targetId>#<version>`, attributes `{ targetId, version, textHash, at, ip, ua, username }`, conditional write `attribute_not_exists(pk)` for idempotency) + the central `bgp-audit` `residency.ack`; a home-jurisdiction target ⇒ 400 (consent is meaningful only for cross-jurisdiction targets). **The consent table gets a GSI `byTarget(pk=targetId, sk=at)`** for the look-back of `GET .../[targetId]/acks` (no Scan).
> - **`requireResidencyAck(identity, targetId)`**: missing consent ⇒ throws `ResidencyAckRequired` ⇒ the route returns **409** `{ success:false, error:{ code:"CONFLICT", message, detail:{ reason:"residency-ack-required", targetId, disclaimer:{ version, text, textHash } } } }` (the front end opens the dialog based on `detail.reason` and retries the same request after consent); any write failure in `residencyAudit` ⇒ throws `AuditUnavailable` ⇒ the route returns **503** `{ success:false, error:{ code:"UPSTREAM_ERROR", message, detail:{ reason:"audit-unavailable", targetId } } }`, and the operation is not executed. When a direct query fans out to multiple targets, each target is judged: if any target lacks consent ⇒ **the whole request is 409** (the other targets are not allowed to run first, otherwise the user sees half the results and then a dialog); if the audit cannot be written for a target ⇒ only that target is refused (its sheet shows `audit-unavailable`) and the other targets run as usual.
> - **`GET /api/admin/exec-envs/[targetId]/acks`** (bgp-admin): the administrator's consent at registration comes from the descriptor's `residencyAck` (first row of the list, `source:"register"`); the rest come from the consent table's GSI (`source:"ack"`); the "Consents" card on the detail page reads it.
> - **Zero regional-client calls on the home path**: `residencyAudit` must not instantiate any regional client before its early `null` return for home (the unit test asserts that `dynamoDocClientFor` was not called).

### 3.3 Audit wiring (tamper-proofing + covering every egress path + fail-closed-on-audit + residency classification)

```text
// tamper-proofing: the application role has [PutItem only]; IAM denies Delete / Update; compliance export uses a separate read-only role
async function auditEgress(rec): Promise<auditId|null> {
  try { const id = uuid(); await auditStore.putImmutable(shardKey(rec), {...rec, id, ts}); return id }
  catch { return null }   // egress-path callers refuse on null (do not carry over the swallow at audit.ts:76)
}
function shardKey(rec) { return `audit#${rec.targetId ?? "ctrl"}#${yyyymmdd(rec.ts)}` }
// 🔴 revision 3.0 correction: the shard key uses **targetId** (previously written `<region|tenant>`) — two targets in the same region would **merge into one file**,
//    the same disease and the same cure as the FQN / OM passage in section 3.10; the three key shapes must be identical (end of section 3.10).
// 🔴 residency classification (axis D): PII / SQL text / plaintext queryId / operator identity → written to the [regional audit store] for cross-jurisdiction targets;
//    the center receives only a non-PII summary (queryId hash / region / row count / duration / verdict). Tamper-proofing is applied on the regional side as well.
// 🔴 revision 3.22 final shape of the dual write (residency-audit work; the two writes of residencyAudit in section 3.2):
//   regional full record bgp-region-audit-<slug>: {pk:"audit#<targetId>#<yyyymmdd>", sk:"<ts>#<auditId>", auditId, operatorSub, sqlText, statementId?, entry, triggeredBy?, authKind, ts}
//   central summary bgp-audit (same shard key as above): {auditId, action:"residency.<entry>", sqlHash, targetId, rows?, durationMs?, ts}  — no operator / no sql / no plaintext queryId
//   tamper-proofing: the TaskRole has an explicit Deny on UpdateItem / DeleteItem / BatchWriteItem for bgp-audit + bgp-region-audit-* + bgp-residency-acks (pinned by the synth-gate; an acceptance criterion)
//   consent retention: the write to the consent table bgp-residency-acks is itself recorded in the central bgp-audit as `residency.ack`
```

### 3.4 Target-aware warehouse direct query (promoted from pseudocode to a delivery contract in revision 3.39; the direct-query target-awareness work)

> Basis: the direct-query target-awareness work package (② the current-state survey was corrected by measurement: **20 bare clients in 17 files**, not 21;
> the grouping also differs from the original draft, see the table below) + the decision of **2026-09-09 that "even Ask-Your-Data may switch regions"** (the verbatim wording is on record).

#### 3.4.1 Single author `lib/redshift/direct-query.ts`

Before consolidation, the three things **place resolution / client / polling** each had **a copy in seven files**. Missing any one of them raised no error —
it would quietly send a query that "is looking at us-west-2" to the home region and return a result that looked perfectly normal. ⇒ The three things are consolidated into one place:

| Export | Semantics |
|---|---|
| `resolveDirectQueryPlace(scope)` | The four place items (region / workgroup / database / secretArn). **The single author is still `resolveRedshiftBinding`** — this function only decides "whether home passes projectId through" |
| `resolveDirectQueryPlaceSafe(scope)` | Same as above, but turns "no warehouse installed in that region" into a capability state. **Resolve once per request, run N SQL statements** |
| `directQueryRaw(place, sql, poll?)` | Execute + poll, returning `columns` / `records` (+ `totalNumRows?`) **exactly as the SDK does** |
| `directQuery(scope, sql)` | All in one (resolve + execute); when `unavailable`, **not a single SQL statement is sent** |
| `degradeIfNoWarehouse(e, targetId)` | Recognizes only `missing-component`; every other rejection reason is rethrown as is |

🔴 **Three things are deliberately not unified** (unifying them would silently change behavior; each is written in a code comment):
① **Row shape is not lifted** — in practice the seven consumers normalize cells **differently** (quality treats non-numeric strings as `null`; metrics return strings as is).
② **The polling budget is overridable** — in practice the sensitive-data scan uses **40×600ms**, the catalog **15×1000ms**, the editor schema **30×1000ms**, everything else **50×700ms**.
   Unifying them would silently change "how long counts as a timeout", and since the speed of sampling / catalog SQL directly decides how many rows come back, that kind of change is extremely hard to attribute.
③ **Error wording is overridable** — the three phrasings "query timed out" / "sampling query timed out" / "schema introspection timed out" are already read by pages, logs and
   the error handling of GenBI. The loop keeps a single implementation; the wording is supplied by the call site; the default = the wording of the majority of copies.

#### 3.4.2 🔴 The `projectId` rule **must differ** between home and non-home (pinned by unit tests)

| Branch | Pass projectId? | Reason |
|---|---|---|
| home (including the default) | **Do not pass** | Governance / quality / metrics / sensitive-data scan are platform-level read-only (statically classified `governance-read` in section 3.9) and have no project to begin with; and home's `getRedshiftSecretArn({project})` would look up per-project credentials, which fail-closed across the board until per-project credentials are delivered by [the project-isolation design](./project-isolation.md) ⇒ passing it condemns a working feature (those four files all carried this warning originally) |
| non-home | **Must pass** | On non-home, `resolveRedshiftBinding` needs project-context credentials (section 3.9b); without it the rejection reason is "no credential" rather than "no warehouse installed", pointing people in the wrong direction. Platform-level pages hand it **the current active project header** — that only satisfies the credential contract and the audit; what is actually obtained is still that target's per-target admin (`degradedToLegacyAdmin`); making it per-project belongs to the per-project credential work |

#### 3.4.3 Degradation = **a capability state**, not an error

Response shape `{ capability: "available" | "unavailable", reason?, targetId?, missing?, ...data }`.
`unavailable` appears **only** when "the target exists but the `redshift` component is not installed"; `invalid-target` / `project-not-allowed` /
`no-credential` / `warehouse-conflict` are all **rethrown as before** (4xx) — degrading them too into "No data warehouse deployed" would be
**covering the real problem with a wrong explanation**, and the user would click "Supplemental deployment" to no effect at all.
🔴 **No audit is written on degradation**: not a single SQL statement ran; writing one would add a run that never happened to the ledger.

#### 3.4.4 Three groups of consolidation (grouping by measurement; every divergence from the original work-package draft is marked)

| Group | Sites | Treatment |
|---|---|---|
| **A known target (4)** | Fetch statement result ×2 (the handle carries targetId; two home fallbacks) · SQL editor `schemas` / `databases` | Factory + `?targetId=` **following the editor's own execution-target selection** (does not read `?scope=`: these answer "which warehouse did I pick in the editor"). `ListDatabases` and the Glue Data Catalog are both **in-region** calls |
| **B five direct queries + two Ask-Your-Data sites (6)** | Quality · metrics · sensitive-data scan · governance catalog · **Ask-Your-Data SQL** · **Ask-Your-Data schema introspection** | All through `direct-query`. 🔴 The two Ask-Your-Data sites **were group C home-only in the original draft**; changed to target-aware per the decision |
| **C contractual home-only (9)** | Sync DDL ×2 (`sync-no-target-dim`) · the workflow SQL node of backfill (`workflow-no-target-dim`) · project-deletion inventory (`project-inventory`) · zero-ETL ×3 (`zeroetl-home-namespace`) · DMS bootstrap (`dms-bootstrap-home`) · modeling DDL (`modeling-ddl-credential-gap`) | `redshiftClientForHomeOnly(reason)`, where the reason is a **mandatory union literal** |
| **Delete (1)** | The module-level client in `lib/diagnostics/evidence.ts` | **Dead code** (declared, never used) ⇒ delete outright |

🔴 **Why home-only must "carry a reason"**: `redshiftClientForHomeOnly()` and "forgot to take the region from the target"
**behave identically** (both hit the home region); the only difference is that the former is a contract. Without a mandatory reason + a frozen list, it becomes a convenient back door:
the next person in a hurry writes one line and quietly reverts a path that should follow the target back to the home region, and **whoever reads the code assumes that is the contract**.
⇒ Two gates: `BARE_ALLOWLIST` **is always empty** (the only construction point is the factory) + **the home-only list matches exactly**.
Each reason must state **when it may be deleted** (the sync push-down work / the ETL orchestration target-dimension work / the DMS data-plane push-down / the narrow-privilege shared-writer work / project deletion in the project-isolation design).

#### 3.4.5 🔴🔴 Ask-Your-Data (GenBI) executes per region — **everything goes through the same AgentCore** (decided on 2026-09-10)

> - **Decision wording (verbatim)**: "Whatever your design, my requirement is: **everything goes through the same AgentCore**, nothing more."
> - ⚠️ **This section was rewritten in full in revision 3.40**: revision 3.39 said "non-home goes through an in-process engine" — **that was overruled**, on the grounds that
>   **one more thing to maintain = incompatibility sooner or later + forgetting to fix both copies**. This outranks engineering preferences such as "real-time behavior / shortest path".

**The original obstacle**: the AgentCore skill Lambda used the place from **its own env** (`AWS_REGION` / `REDSHIFT_WORKGROUP` /
the managed admin secret name) — all three are the home region's, and it had no notion of "take the place from the target".

**Decision = make the "data-fetch place" part of the payload**, wired in three segments (each with exactly one author):

| Segment | Who does it | Key constraint |
|---|---|---|
| ① Resolve the place | **The platform** (`resolveDirectQueryPlace`) | The only authority remains the registry descriptor + `resolveRedshiftBinding`. 🔴 **Never recompute it in the container / Lambda** — the failure mode of such copies is **silently hitting the home region** |
| ② Inject into the call | The single funnel `tracedCall` in the container's `agent.js` | 🔴 **Deterministic injection, not decided by the model**: if the model omits it or makes up some other region, execution happens in the wrong region and **the answer gives no sign of it** (same technique and same reason as the existing `projectId` injection) |
| ③ Execute at the place | `rsClientFor(region)` in the skill Lambda `rs.js` | Flat parameters `rsRegion` / `rsWorkgroup` / `rsDatabase` / `rsSecretArn` (no name clash with the model-supplied `sql` / `namespace`) |

🔴🔴 **The payload always carries the place (including the home region)**: the original draft said "if absent by default ⇒ the skill Lambda uses its own env set", and
the **negative list** of the contract gate caught it on the spot — that would leave non-home a path that **silently hits the home region** (the day the platform omits it,
the Lambda cannot distinguish "no target specified" from "the target's place got lost", so it runs in the home region and presents the result as that region's answer),
in direct conflict with the fail-closed rule of sections 1.1 / 2.2. ⇒ The platform computes and attaches the place **every time**; the skill Lambda's env is only the fallback for
"no caller information at all" (for example someone calling the Gateway tool directly), **not** a fallback point of the per-region execution chain.

🔴 `secretArn` carries the **ARN, not the secret value**; whether it can be read is still decided by that Lambda's role.

🔴 No IAM change is needed: that Lambda's redshift-data / secretsmanager statements are already `resources:["*"]` with **no region condition** (verified in a real environment).

🔴 `_meta.backend` is kept: normally every region is `agentcore`; its purpose now is to **expose an AgentCore failure fallback** (it will be `inprocess` when falling back to in-process).

🔴 `targetId` **is persisted in the async task row** (`bgp-genbi-tasks`): the task is taken over for execution by **another request**; not persisting it means "forgetting which region the question was asked in at the moment it is claimed".

**Page**: in target view, `/genbi` permanently shows the sentence "SQL runs on that region's data warehouse (Ask-Your-Data uses the same AgentCore; conversation memory and skills are shared across regions)";

🔴 **"In-process engine" must never appear again** — that is the overturned wording, and a dedicated acceptance criterion asserts that it does not appear.

#### 3.4.6 🔴🔴 Governance catalog — **everything goes through the same OpenMetadata** (decided on 2026-09-10)

> - **Decision wording (verbatim)**: "The governance catalog **must go through the same OpenMetadata**, otherwise there is yet another thing to maintain,
>   and it becomes extremely easy to end up with **incompatibility and forgotten fixes**."
> - ⚠️ **This section was rewritten in full in revision 3.40**: revision 3.39 said "the non-home view bypasses OM and directly queries that region" — **that was overruled** (same reason as above).

**The original obstacle**: OM is a **central single instance that ingests only the home region** (measured in section 3.13).

**Decision = express "which region" as OM's service dimension**, collapsing the chain into one:

```text
per-region Glue / warehouse catalog → (the existing per-region mirror collection) → om-mirror-push → the same OM (per-target service) → the catalog page reads OM only
```

| Item | Final rule |
|---|---|
| Service naming | Single author `lib/openmetadata/om-service.ts`: home region = `bgp-redshift` / `bgp-glue` (**names unchanged**); other regions = `bgp-redshift-<targetSlug>` / `bgp-glue-<targetSlug>` |
| 🔴 Why home gets no suffix | The existing OM already has databases / tables under `bgp-redshift` (pushed by sync / modeling / lineage). Renaming = **every FQN changes, lineage breaks, favorites and tags are all lost** ⇒ zero migration is a hard requirement |
| service → target reverse lookup | A `-<slug>` suffix belongs to that target; 🔴 **no suffix, and any unrecognized suffix, always belong to home** — the assets of the platform-level services (`bgp-sources` / `bgp-s3tables` / `bgp-physical`) are all in the home region today; and "unrecognized suffixes also belong to home" avoids conjuring up a region **the user cannot pick in the dropdown** (the same rule as N-10 in section 2.6.6) |
| Catalog routing | **Always through OM**; the target view filters by service ownership; direct query remains only as the fallback for "OM not configured / unreachable" (**not** a second path for non-home) |
| 🔴 Freshness must be returned together | That region's tables in OM come from **synchronization**, not real time ⇒ the response carries `_meta.catalogFreshness` (separate states for state / mirroredAt / warehouse), and the governance page permanently shows a line "sync status · last sync · where to refresh". **Not showing it = the user does not know what point in time the catalog they are looking at represents** |
| 🔴 Table counts must not use the facet's `tables` | That number **counts only the scheduled source (Glue)**; the warehouse catalog has its own timestamp and state ⇒ measured in a real environment it was 0 while the catalog clearly listed 21 tables. "0 tables" on the screen equals "there is nothing in this region" ⇒ the table count is given only by the catalog list itself |
| 🔴 Push failures must be visible | Both the mirror result and the `POST /api/admin/metadata-mirror` response carry `om:{tables,services,truncated,errors}` — failing to push into OM = that region's catalog **stays as it was last time**, and the page cannot tell |
| ⚠️ Recorded truthfully | When a table is deleted in some region, its row in the OM catalog **remains until it is cleaned up on the OM side** (the mirror's "delete what was not seen this round" acts only on the mirror table itself); deletion semantics belong to OM's own lifecycle |

🔴 **Compile boundary** (stepped on once, caught by the gate): the mirror is a **periodic task** running on the **edge** side of `instrumentation`,
and `om-push.ts` happened to import `genbi/athena` ⇒ the chain reached `node:crypto` and `next build` failed outright.
⇒ The four OM write primitives move to the **lightweight layer** `om-write.ts` (depending only on `om-client` / fetch), shared by both sites.
**Moving is not copying**: the load-bearing logic in `putTable` (when columns are empty, real columns must not be overwritten with `_row`, otherwise column-level lineage disappears globally) must exist exactly once.
(Neither `await import()` nor a `NEXT_RUNTIME` check **constitutes a compile boundary**.)

#### 3.4.7 Page side: read with `?scope=`, execute with `body.targetId`

| Page | Read (`?scope=`) | Execute (`body.targetId`) |
|---|---|---|
| `/governance` | Catalog | Quality run · sensitive-data scan |
| `/genbi` | — (Ask-Your-Data has no "read list" surface) | Ask a question |
| `/redshift` | — (the left-hand tree uses `?targetId=`, following the editor's own selection) | Direct query (multi-region fan-out already exists) |
| Metric computation | — | `POST /api/metrics/[id]/compute` · `compute-all` |

🔴 The dividing line is section 2.6.3: **write / execute routes never read `?scope=`** — the view state in the address bar must not decide "where it actually runs";
the `scope-write-guard` gate pins this. The page puts the current view **explicitly** into the body and repeats it on the button / notice bar (guardrail 2).

**Not included in this package** (recorded truthfully): `runSelectAthena` / `introspectS3Tables` remain home-only (making Athena / S3 Tables
target-aware is outside the scope of the direct-query target-awareness work); `/bi` (widget-level targetId, section 8.3 of this specification) · `/governance-workbench` · `/openmetadata`
(it already has its own `?targetId=`) · `/athena` — these four pages remain `scopeWired:false`.

### 3.5 Lifecycle (broker + draining + fencing + reconcile)

```text
// deploy: platform → broker.invoke({targetId, components, operationId})
//   → broker StartBuild (no override) → self-contained stack group BgpExecEnv-<targetSlug>-*
// 🔴 revision 3.9 correction: originally written `BgpExecEnv-<targetId>-*` — **targetId contains `_`, while CFN stack names allow only `[a-zA-Z][-a-zA-Z0-9]*`**,
//   so built as written, the very first step could not create a stack. Section 1.1a-① already requires stack names to use the slug; the `stackName` kind of the naming single source of truth is the only exit.
//   → CDK Outputs written back as actual names (whole package + ready bit) + observedVersion
// 🔴 fencing: every operation increments target.lockEpoch; before writing state / destroying, verify the epoch is unchanged, otherwise discard (a resurrected old op is harmless)
// 🔴 deploy lock deploy-lock#<targetId>: lease + [renewal] (a long build is not preempted)
// 🔴 revision 3.13 adds [stale-lock takeover] (exposed by a real deployment run during the control-plane construction batch: a build failed after 30s, the deploy entry stayed stuck behind the lease for 90min,
//   and "retry deployment" is exactly the action most needed right after a failure): on a lock conflict the broker checks whether **the lock holder's own build** has terminated;
//   terminated ⇒ take over with a conditional write on the observed values ((deployLockOperationId, lockEpoch) double-bound + epoch increment + audit trail).
//   Three necessary conditions: the lock is really held ∧ lastOperationId == the holder (otherwise that build is not its build) ∧ lastBuildId / lockEpoch are available.
//   **Residual risk recorded truthfully**: build terminal state ≠ CFN idle in the target region (STOPPED / TIMED_OUT in the middle of a CFN rollout) ⇒
//   after takeover the next cdk deploy hits CFN's own operation-in-progress and fails fast (**CFN is the authoritative serializer**;
//   the lock only turns an obscure error into an early clean refusal); one build is wasted, no double write (epoch fencing already blocks the old build's write-back).
//   The decision procedure would need the broker to have cross-region CFN read-only access + to reproduce the targetSlug derivation inside the broker (= a second definition of the naming single source of truth) ⇒ deferred to the data-plane push-down batch.
// 🔴 three-stage deletion check: drain (atomically refuse new work) → re-check during the approval period → a third check before destroy + epoch
//   data bucket / table bucket / residency-api regional store / regional audit store are all RETAIN (the anti-data-loss requirement of the design document)
// desired/observed: registry = desired, DescribeStacks / probe = observed, continuous reconcile (tolerates partial success)
```

### 3.5a 🔴 Periodic reconciler (lifecycle construction batch 2a; the only **periodic** writer of `observed`)

> - ✅ **Architecture choice decided (2026-09-02): an in-process lease singleton** (not a separate scheduled ECS task, not an external scheduler → internal endpoint).
> - Reason: probing already runs inside the platform's resident service process today (the probe route of section 2.1); in-process driving = the same code, the same ambient credentials,
>   **zero new infrastructure / IAM / images / HTTP endpoints**, the smallest audit surface.

**Why it must exist (a hard prerequisite of the data-plane push-down batch)**: `probe.at` is the only time source of the stale verdict (the stale table of section 1.1), and its only writer
`writeProbeResult` is today called only by two manual admin routes ⇒ a non-home target **is condemned as stale when nobody clicks probe for 15min**
(the unpaid debt of section 1.1's "the probe / reconcile period must be ≤ threshold/3"). Data-plane push-down cannot be built on "someone has to click manually".

```text
// lib/exec-env/reconciler-loop.ts (new): in-process singleton, started by register() in platform/src/instrumentation.ts
// runtime body = the existing resident platform service (ApplicationLoadBalancedFargateService, desiredCount 2~6); Next.js 14 requires experimental.instrumentationHook to be enabled
every tick (period ≤ threshold/3, ~4min):
  if (!acquireLeaderLease()) return          // 🔴 leader election: only one of the 2~6 replicas actually runs (see below)
  for (const t of listTargetsRaw())          // strongly consistent, paged through the whole table
    await reconcileOneTarget(t.targetId)     // 🔴 [the same] shared function as the probe route; removes "a person clicks the button"
  renewOrReleaseLeaderLease()
```

**tick = reuse the probe route's chain (single source of truth, no rewrite)**: the body of the probe route POST in section 2.1 (strong read → [if an in-flight operation exists and the build
has SUCCEEDED, finalize] → capture evidence → `runProbe` → write observed → `reconcileAfterProbe`) is extracted into the shared
`reconcileOneTarget(targetId)`; the probe route (a person clicks "Check initialization") and the reconciler (periodic) call **the same** function ⇒ the promised
"automatic finalize / probe on a terminal build" is **almost free** for targets with an in-flight operation (it is exactly that completion path).

🔴🔴 **Prohibition on fail-open inversion (the most load-bearing invariant of this batch)**: admission = `fresh(probe) ∧ health∈{healthy,degraded} ∧ phase=ready ∧ no operation` (section 1.1).
Once the reconciler **automatically refreshes `probe.at`** every ≤5min, `fresh(probe)` is always true ⇒ **if only `probe.at` is refreshed without writing this probe's result back to
`observed.health`, a region whose probe turns red (resources gone) stays "fresh + active" forever = today's fail-closed (stale → unavailable)
is inverted into fail-open**. Therefore the tick **must** derive health from **this** probe:
- all green and exactly covering the components (`isGreenProbeForComponents`) ⇒ `healthy`;
- probe red (core resource probe failed) ⇒ **not serviceable**, mapped to `unknown` (section 1.1's `serviceabilityReason` already defines `unknown` as fail-closed;
  the promised "down semantics" are `unknown` in this enum, **no new enum value is added**);
- reachable but not all green, i.e. degraded ⇒ `degraded` (still serviceable).

🔴 **Flap protection**: only `HEALTH_DOWNGRADE_STREAK = 2` consecutive reds downgrade (counted in `observed.unhealthyStreak`; avoids killing a healthy region on a single transient failure),
and one green immediately restores `healthy`. The downgrade window (≤2×tick≈8min) is still **< the 15min stale threshold** ⇒ fail-closed faster than the old "wait for stale".

**Narrow telemetry channel (the periodic write port of observed; added in `lifecycle.ts`, still honoring the AST gate "the only writer of observed is this file")**:
`reconcileTelemetry(targetId, {probe, health, templateVersion?})` — one conditional write of `observed.{health, probe, templateVersion,
unhealthyStreak, lastReconcileAt}` + **re-materialization** of the top-level `status` / `ready` (health change ⇒ projection active↔degraded),
**`phase` unchanged, `version` not incremented** (the promise that "probe / health do not compete for version"); the condition guard is `attribute_not_exists(observed.operation)`
(🔴 **never compete with an in-flight deploy for the write** — while an operation exists, that target belongs to the completion path / broker and telemetry skips it) + still modern + phase still `ready`.
A conflict (an operation appears / the phase changes / downgraded to legacy) ⇒ skip and come back next tick (`reconcileAfterProbe` is idempotent and side-effect free).

**The real writer of observedVersion**: the tick does `DescribeStacks` on targets that are already ready to fetch the template version and writes
`observed.templateVersion` through the same telemetry channel (reviving the dead field of section 1.1; the taskRole already has that permission today, and the probe route is already calling it).

**Leader lease (leader election)**: the platform service has desiredCount 2~6 ⇒ a leader must be elected, otherwise N replicas probe redundantly. A dedicated lock row
(`pk="lock"`, `sk="reconciler"`) with a DDB conditional-write lease (reusing the acquire / renew / release semantics of `run-lock.ts`, **short lease**), renewed every tick.

🔴 **Correctness does not depend on leader election**: `reconcileAfterProbe` is idempotent + fenced; two replicas occasionally running concurrently merely probe twice (waste, no corruption) ⇒ leader election is an **efficiency** optimization.

🔴 **Hard constraint on lease + tick period**: the "nobody probing" gap after a leader dies suddenly = lease TTL + one tick, and it **must be < the 15min stale threshold**
(with tick≈4min and lease≈8min ⇒ gap ≈12min < 15min; the renewal interval < TTL).

**Periodic adoption of existing items**: the reconciler also runs legacy items lacking `spec` / `observed` through `reconcileOneTarget` ⇒ the acceptance rule "adopt on this fresh green probe"
changes from "a person clicks the button" to **periodic and automatic** (still via `adoptLegacyAfterFreshProbe` + `LegacyCompletionFence`; ready is not inferred from a stored probe; item 12 of the rejection list in section 20.23-R is not relaxed).

**Batch boundary (lifecycle batch 2 split into 2a / 2b)**: this section = **2a** (periodic driving + leader election + telemetry health / observedVersion + periodic adoption) ⇒ lifts
"condemned as stale after 15min" = the hard prerequisite of the data plane. **2b (not in this batch)**: startUncertain / attachUncertain / no-build-window crash recovery (section 4.5 / [the design document](./multi-region-execution-design.md), sections 19.7–19.8)
+ CFN rollback / partial-success handling + deploy lock-lease renewal. 2b does not block the data plane.

🔴 **The production No-Go is not lifted by 2a** (decision E): a ≤5min reconciler is necessary but not sufficient; 2b recovery + the baseline-trust work (batch 3) are still required.

### 3.5b 🔴 Failure-path recovery (lifecycle construction batch 2b; the **only** failure writer + the reachable boundary of recovery)

**Single root cause (why there is still a hole after 2a)**: the **only clearer** of `observed.operation` and the top-level deploy lock is the "successful completion fence"
(section 3.5a / section 22). Hence **any non-successful outcome** — build `FAILED/FAULT/STOPPED/TIMED_OUT`, CFN rollback, `attachUncertain`
(StartBuild succeeded but the attach response was lost), `startUncertain` beyond the 5min resend window, a process crash after open — leaves that target
**permanently** stuck at "lock held ⇒ `activeDeployLockReason` refuses new work", with **no legitimate way out** (manual DDB edits are a forbidden red line).
⇒ The cure = **give the failure path exactly one writer**, and it may clear the lock only when it carries both "**a verified external disposition** + **an explicit administrator decision**".

**Recovery entry point (a section 19.8 release blocker)**: `POST /api/admin/exec-envs/{targetId}/recover`.
Execution order (every step is indispensable; the order is the safety argument):

```text
① Strongly consistent read of the exact item (no cache / no list result)
② Classify: modern (observed.operation present) | legacy (no dual axis but a top-level lock residue); neither ⇒ 400 "no session awaiting recovery"
③ Verify the build: query CodeBuild for **the operation's own** buildId (modern) / the top-level lastBuildId (legacy)
     · SUCCEEDED ⇒ **reject** (400): that is the job of the "Check initialization" finalize, not recovery
     · IN_PROGRESS/UNKNOWN ⇒ **reject** (409): the build is still running; clearing the lock = letting a second deployment collide with the same stacks
     · terminal failure ⇒ continue
     · CodeBuild **cannot find that buildId** (`not-found`: record expired / project recreated) ⇒ **may continue**. If the record does not even exist,
       it is structurally impossible for a build to be running; treating it as "undetermined" would create another permanent "lock held + no way out" deadlock door.
     · buildId **missing** but with `attachUncertain.candidateBuildId` (StartBuild succeeded but the attach response was lost) ⇒
       query the **candidate** build: a terminal state (including `SUCCEEDED` / `not-found`) suffices to continue, **no need to wait for the structural safety window**; still running ⇒ reject.
       🔴 Even if the candidate `SUCCEEDED`, recovery is taken here: the completion fence requires `operation.buildId`, and it is missing ⇒ the completion path
       **structurally cannot** run; refusing here as well would create yet another permanent deadlock (after recovery the administrator must rerun one idempotent deployment to complete the components).
     · buildId **missing and no candidate** (startUncertain: open succeeded, StartBuild result unknown) ⇒ no build to query ⇒ continuing is allowed only after
       `now − operation.startedAt ≥ EXEC_ENV_BUILD_TIMEOUT + margin`. 🔴 The basis is **structural**:
       CodeBuild kills the build without exception at `timeoutInMinutes` ⇒ beyond it, that session cannot still have a build running. **No guessing, no shortening**.
       The margin must be **> the broker's 5min same-token resend window** (a build resent at the end of the window is not killed until `startedAt+5min+timeout`) ⇒ take 15min.
④ Verify the CFN disposition (this target's `BgpExecEnv-*` stacks, named one by one via the naming single source of truth, zero new hard-coding; the stack list is the
   **union** `base ∪ components ∪ spec.desiredComponents` — the one that failed is often the **new component's** stack, and checking only observed would miss it):
   🔴 The criterion is a **whitelist of stable terminal states** (`CREATE_COMPLETE`/`UPDATE_COMPLETE`/`UPDATE_ROLLBACK_COMPLETE`/`ROLLBACK_COMPLETE`/
   `IMPORT_COMPLETE`/`IMPORT_ROLLBACK_COMPLETE`/`DELETE_COMPLETE`); **anything outside the whitelist is rejected** (409).
   Why it cannot be written as "block `*_IN_PROGRESS`": `UPDATE_ROLLBACK_FAILED`/`ROLLBACK_FAILED`/`CREATE_FAILED`/`DELETE_FAILED`
   do not end in `_IN_PROGRESS` — a blacklist would judge "CFN explicitly says the rollback did not succeed" as stable and release the lock (fail-open, confirmed in re-review).
   In addition: an **unexecuted change set** exists / describe or ListChangeSets **fails** ⇒ always reject.
   🔴 The **key difference** from the progress page's `fetchStackStatuses`: the progress page degrades a describe failure to UNKNOWN and keeps displaying;
   this gate **never degrades** — what cannot be seen clearly is unsafe (fail-closed).
⑤ Require an **explicit administrator decision**: the input must carry `decisionId` + `confirm:true` + `expectedOperationId`
   (naming which session to clear ⇒ if a new operation was opened in the meantime, the fence necessarily fails; the wrong one is never cleared)
⑥ **One fully fenced conditional write** (see `recordOperationFailure` below) ⇒ clear the operation + the three top-level lock fields and record the failure
⑦ Audit before / after (`exec-env.recover`, including buildStatus / stack-disposition snapshot / decisionId / operator identity)
```

**The only failure writer `lifecycle.recordOperationFailure(targetId, {fence, disposition, decision})`**
(added in `lifecycle.ts` — still honoring the gate "observed is written only in this file"; orthogonal to `transitionPhase` / `reconcileTelemetry`):

| mode | What it writes | What it does not write |
|---|---|---|
| **modern** | Clears `observed.operation`; writes `observed.lastFailure` (operationId / lockEpoch / buildId? / buildStatus / stack disposition / checkedAt / decisionId / decidedBy / at) + `observed.lastError`; `health → unknown`, `unhealthyStreak → 0`; re-materializes the top-level `status` / `ready`; `version` +1; REMOVEs the three top-level lock fields | 🔴 **`phase` is never touched** |
| **legacy** | Only REMOVEs the three top-level lock fields + `version` +1; the failure details go to the **audit** (that item has no observed axis yet; writing it would amount to adoption, and adoption must rely on one fresh green probe, item 12 of the rejection list in section 20.23-R) | Does not create spec / observed, does not touch status / ready |

🔴 **Why `phase` is never touched (rather than "roll back one phase on failure")**: the lifecycle axis **does not express health**.
- Initial installation failed (`provisioning`) ⇒ stays in `provisioning` + `lastError` ⇒ projected `status=failed`, `deploymentNeedsFinalize=false`
  (converged; an explicit retry must open a new session). **Never guess back to `registered` / `verifying`** (section 19.8).
- Upgrade failed (`ready`) ⇒ stays in `ready`, but `health=unknown` ⇒ `serviceabilityReason` **refuses service fail-closed**, projected `degraded`.
  "Whether it returns to serviceable" **is not judged by the recovery endpoint but by the next probe** (the reconciler runs within ≤4min): green ⇒ automatically back to `healthy` / `active`;
  still red ⇒ stays at unknown. And an illegal edge such as `ready→provisioning` simply never occurs.
  🔴 **Honest wording (do not overclaim)**: this satisfies the **intent** of that item in section 19.8, "serviceability is not released by human judgment", but it **does not equal** its literal requirement of
  "a verified rollback to the original baseline" — the probe only proves that resources **exist / are accessible** (the Head / List style probes of `runProbe`); it does not compare against a template baseline;
  the fields that could express a baseline, `observed.templateVersion` / `spec.desiredTemplateVersion`, are today **written but never read**, and `baselineRef` belongs to batch 3 (baseline trust).
  ⇒ This item is delivered as "**approximated by a real probe + the CFN stable-terminal-state whitelist holding back 'terminated but rollback not successful'**"; true baseline validation awaits batch 3.

**Semantic correction of `deployLockExpiresAt` (from revision 3.15; removes a fail-open hazard)**: it is a **diagnostic expected-completion deadline**
(= `operation.startedAt + LOCK_LEASE_MS`; the broker's strong read-back also verifies it literally by this formula) and **drives no automatic release / takeover**.

🔴 Therefore this batch **deliberately does not implement "lease renewal"**: ① nowhere in the repository is it compared with a clock (verified by grep), so renewal would have no reader;
② renewal would make it ≠ `startedAt + LOCK_LEASE_MS`, **breaking the exact read-back of the broker's `matchesOpenedDeploySession`**
(the no-build 5min resend path would stop working as a result) ⇒ renewal is a net negative. What really needs fixing is the error that **it is shorter than the build timeout** (90min < 2h ⇒
a legitimate 100-minute build would display as "expired", tempting a successor to add back the fail-open condition `OR deployLockExpiresAt < :now`).
⇒ Correct it to `LOCK_LEASE_MS ≥ EXEC_ENV_BUILD_TIMEOUT + margin`, and have the gate **pin it negatively**: production code must not compare
`deployLockExpiresAt` with any clock / `:now`.

**Automatic convergence of a terminal SUCCEEDED is already obtained for free from 2a** (section 3.5a): every tick the reconciler calls
`reconcileOneTarget` on every target = the same completion sequence as a person clicking "Check initialization" ⇒ **a crash after a successful build needs nobody to click**. This batch adds a **regression pin** for it
(the reconciler must finalize a target with "an in-flight operation ∧ build SUCCEEDED"), preventing a later refactor from quietly regressing it.
For **failure** classification the reconciler only **reads, never writes** (`ReconcileOutcome.recovery`: kind + buildStatus + `earliestRecoverAt`), 🔴 **and never clears the lock automatically** (section 19.8, item 5) — it is presented to the UI / operations, and a person decides according to the execution order above.

### 3.5c 🔴 P0-E Trustworthy baseline (the execution-environment stack-group construction batch; the only hole that can destroy data)

**Why it is P0**: the promise of `add-components` — "pass the full set; CDK idempotence adds but never modifies" — **holds only while the source template is unchanged** ([the design document, section 12.6](./multi-region-execution-design.md)).
As soon as the control-plane infra evolves, adding one component to a region that is **in service** may produce a changeset against the existing core stack,
and may even **REPLACE stateful resources** (Redshift namespace / MWAA environment / S3 bucket / KMS key) ⇒ downtime or **outright data loss**.
Until P0-E lands, `observed.operation.disruptive` is **always `true`** (section 10.2 fail-closed: no new work is accepted while a deployment is in progress) —
the price is that "adding a component to a live region" requires taking it out of service, and the benefit is "never optimistically admit traffic". What P0-E does is **give that verdict a real basis**.

**Four deliverables (none can be omitted)**:

| # | Deliverable | In one sentence |
|---|---|---|
| ① **Change-set dry run** | Before deploying, **create but do not execute** a change set, obtaining a machine-readable fact of "what exactly will change this time" | Without a dry run you can only guess |
| ② **Impact classification (pure function)** | Derive `disruptive` / `requiresApproval` / `planHash` from the change set entry by entry | The criterion must be **a single** pure function, exhaustively testable |
| ③ **Replace approval gate** | A REPLACE/REMOVE touching a stateful resource ⇒ an administrator must explicitly approve **that specific planHash**, otherwise the build refuses to run | No unattended replace (section 12.6) |
| ④ **baselineRef anchoring + waves** | Remember "which source is actually installed" (`observed.baselineRef`); the moment the source drifts it **must hit the approval gate**, and upgrades go through explicit `spec.desiredTemplateVersion` waves (🔴 corrected in revision 3.6: **the old source is not replayed** — see below; the replay mechanism has been forbidden by our own IAM Deny) | Make it impossible for "source drift" to happen silently |

#### ② Criteria of the impact classification (fail-closed; a single copy in `lib/exec-env/deploy-impact.ts`)

Input = the `Changes[]` of each stack's change set (`Action` / `Replacement` / `ResourceType` / `LogicalResourceId` / `Scope`).

```text
Stateful resource set (replacement or removal = downtime or data loss) = Redshift Serverless Namespace/Workgroup · MWAA Environment ·
  S3 Bucket · S3Tables TableBucket · MSK Cluster/ServerlessCluster · KMS Key · DMS ReplicationInstance/SubnetGroup ·
  DynamoDB Table · RDS DBInstance/DBCluster · Glue Database · Athena WorkGroup · EC2 VPC/Subnet/NatGateway
```

Verdict entry by entry (**the strictest wins**):
1. 🔴 **Any entry whose `Action`/`ResourceType` cannot be parsed (or that carries an unknown `Action`) ⇒ `disruptive=true` ∧ `requiresApproval=true`**
   — what cannot be read clearly is unsafe; never "guess it is an Add".
2. `Remove` ⇒ `disruptive=true`; if the resource is in the stateful set ⇒ **`requiresApproval=true`**.
3. `Replacement ∈ {True, Conditional}` ⇒ `disruptive=true`; if in the stateful set ⇒ **`requiresApproval=true`**.
   (`Conditional` = CloudFormation itself cannot tell whether it will replace ⇒ treated exactly like True.)
4. `Modify` ∧ `Replacement=Never`: **not** counted as disruptive only when `Scope ⊆ {Tags, Metadata}`; otherwise `disruptive=true`
   (an in-place property change may also interrupt running jobs), but approval is **not** required.
5. Only `Add` (or an empty change set) ⇒ `disruptive=false` ∧ `requiresApproval=false` — this, and only this, is the "add but never modify" that add-components promises.

`planHash = sha256(canonical(sorted list of per-entry {stack, logicalId, action, replacement, resourceType, scope}))`.

🔴 **Approval is bound to the planHash**: if the plan changes by a single byte after approval, the hash changes ⇒ the old approval **expires automatically** (it is not "this target was approved", it is "this plan was approved").

#### ③ The two locks of the approval gate (platform + build; each holds independently)

- **Platform side**: when `POST .../deploy|add-components` receives a plan with `requiresApproval`, the request must carry
  `{approvalId, approvedPlanHash}` with `approvedPlanHash === the planHash of this dry run`, otherwise **409 + an explicit reason**; the approval is written to the audit log.
- **Build side** (defense in depth): before the real deploy, the buildspec recomputes the change set and checks it against `EXEC_ENV_APPROVED_PLAN_HASH`;
  a mismatch, or a missing value while the plan requires approval ⇒ **the build fails outright**. 🔴 **Both** locks are required: the platform side can be bypassed (by invoking the broker directly);
  the build side is the last line (the strong deployment privilege lives only on the CodeBuild service role).

#### ④ baselineRef and waves (🔴 **mechanism corrected in revision 3.6**: changed to "drift is visible + explicit waves"; **the old source is not replayed**)

🔴 **The original text's "replay with `spec.baselineRef` / the buildspec receives `EXEC_ENV_BASELINE_REF` and checks it out" is
both impossible in this system and deliberately forbidden** — this was established during construction by re-checking the existing decisions of sections 12.0 / 12.5, and is corrected here honestly rather than forcing a contract that cannot be implemented:

- **Impossible**: the CodeBuild source is a **content-hash-addressed, immutable CDK asset (S3 zip)** (decided under P0-H in section 12.5),
  and `.git` is the first entry of the source-package exclusion list (`SOURCE_EXCLUDE` in `infra/lib/exec-env/deploy-stack.ts`)
  ⇒ there is **no git repository** inside the build container, and no ref to check out.
- **Forbidden**: the only mechanism that could switch a build to an "old source" is `sourceLocationOverride` on `StartBuild`, and it is already
  **blocked by the explicit IAM Deny of fix ① in section 12.0** (`codebuild:source.location`, listed together with `source.buildspec`/`serviceRole`)
  — because swapping the source package = borrowing CodeBuild's `cloudformation:*` + `iam:PassRole` to run arbitrary code.
  Opening that door in order to "prevent source drift" would widen the blast radius from "deploying the real template" to "taking over the whole account":
  **the opposite direction from a root fix; not done**.

**The mechanism used instead** (it removes the same root cause, "source drift happens silently", and **adds no override surface whatsoever**):

| Field / input | Axis | Semantics | Sole writer |
|---|---|---|---|
| `observed.baselineRef` | observed | **Identity of the source package used by the last successful deployment** (CDK asset content hash) = "which source is actually installed" | The success fence (the same conditional write as `observed.components`) |
| `observed.operation.sourceRef` | observed | Source-package hash used by the in-flight deployment (written when the operation is opened; promoted to `baselineRef` on success) | The broker (its own project-level env; it accepts no client input) |
| `spec.desiredTemplateVersion` | spec (**existing field, not new**) | The administrator **explicitly authorizes** which source this target may be upgraded to = **wave** | The administrator API (the spec writer) |
| `EXEC_ENV_SOURCE_REF` | build input | Source-package hash **actually** used by this build; comes from the **project-level** env (locked at CDK deploy time, protected together with the project definition at the same level as section 12.0) | CDK |

Verdict (layered on top of the change-set criteria of ②, **the strictest wins**):

1. `observed.baselineRef` **missing** (brand-new env / existing env never recorded) ⇒ `disruptive=true` (fail-closed, same as today);
   🔴 but **no** extra approval is required — otherwise a brand-new env would be blocked by itself on its very first install (the initial change set is all `Add`, which never needs approval anyway).
2. `baselineRef === sourceRef` ⇒ **zero source drift** ⇒ the existing stack templates are byte-identical ⇒ CloudFormation is naturally a no-op
   ⇒ "add but never modify" holds **structurally because the source is unchanged**, no longer by assertion.
3. `baselineRef ≠ sourceRef` ∧ `spec.desiredTemplateVersion ≠ sourceRef` ⇒ **source drift without explicit wave authorization**
   ⇒ `requiresApproval=true` (here "approval" means **I accept this drift**).
4. `spec.desiredTemplateVersion === sourceRef` ⇒ the administrator has explicitly moved this target to this version (wave)
   ⇒ no tightening because of drift; **whether approval is needed is still decided by the change set** (replacing a stateful resource still needs approval).
5. On success, `observed.baselineRef` advances to this run's `sourceRef`; **on failure nothing moves** — the same principle as "failure does not move the phase" in section 3.5b:
   without success, "which version reality is on" must not be rewritten.

🔴 `planHash` **includes `sourceRef`**: approving a plan = approving "this set of changes **as produced from this specific source**".
Otherwise the same change text under a different source could reuse an old approval (same idea as the fence of section 3.5b: the fingerprint must cover every decision input).

**What this buys / does not buy (no overstatement)**:

- **Buys**: source drift **cannot happen silently** (drift is either zero change or hits the approval gate) + per-target waves (not globally following HEAD)
  + "which version is actually installed" is auditable.
- **Does not buy**: letting a lagging target "keep deploying with the old source". If you want to add a component without accepting the new source, the only compliant path is
  **first roll the control plane back to that source, then add the component** (control-plane IaC lives in git and can be replayed). This limitation is stated here as it is; we do not pretend it can be done.

**Relation to section 3.5b**: this section gives `disruptive` a real value; the recovery endpoint of section 3.5b is unaffected
(it refuses **any** operation regardless of disruptive — even damaged data that writes disruptive as false is refused, section 20.2).
**Acceptance**: see the acceptance criteria for the trustworthy baseline (change-set dry run, approval gate and drift detection).

### 3.6 🔴 Run-lock identity includes the target (resolves an item of the independent architecture review)

```text
// Invariant: same target + same task (+ same node) = mutually exclusive; different target + same task = parallel
//
// 🔴🔴 Correction in revision 3.0 (the original `lockKey = projectId#targetId#taskId` is **not implementable** on the existing storage layout):
//   Fact from the actual code (stated explicitly in the comment at `lib/etl/run-lock.ts:14-20`) = **the lock lives in attributes on the business entity row itself; no separate lock table is created**:
//     ETL      → `bgp-etl-jobs   {userId, jobId}`      . `runLock`
//     EMR      → `bgp-engine-jobs{userId, jobId}`      . `runLock`
//     workflow → `bgp-workflows  {userId, workflowId}` . `runLock_<nodeId>`
//   ⇒ **the "key" is the business row's primary key (userId + resource id); projectId/targetId cannot be injected**; the only feasible axis = **the attribute name carries the target**:
// 🔴 Three corrections in revision 3.1 (coexistence period / separator / leak):
lockAttr = isHome(targetId)                                  // ① home exemption: **byte-identical name** to the existing one
  ? (isWorkflow ? `runLock_${nodeId}` : `runLock`)            //    ⇒ the coexistence period shrinks to zero (see below)
  : (isWorkflow ? `runLock-${targetId}-${nodeId}`             // ② separator changed to `-` (targetId forbids `-`, so it is reversible and collision-free)
                : `runLock-${targetId}`)
//         (for workflows the nodeId must be the **original node.id**, not task_id — lesson of the earlier run-lock fix)
// Semantics: on the same business row, different targets occupy **different attributes** ⇒ naturally parallel; same target + same node contend for **the same attribute** ⇒ mutually exclusive. ✅ The invariant holds
//
// 🔴 Byte-exact alignment spans **4 sites**, not 3 (revision 0.1 of this specification missed the fourth):
//   ① Node `lib/etl/run-lock.ts` (**generalized module**: shared by ETL/EMR/workflow nodes since the earlier run-lock fix)
//   ② python `lib/workflow/runtime-lib.ts:191` `_acquire_wf_lock`
//   ③ 🔴 python `lib/etl/dag-generator.ts:67-90` (ETL DAG inline lock, `runLockToken/runLockExpiresAt` hard-coded constants)
//   ④ `lib/backfill/execute.ts:91` lock acquisition (:90 is the lockAttr computation)
// 🔴 Correction in revision 3.2: the original enumeration listed **five** items ①–⑤ yet said "4 sites", and among them `lib/workflow/run-lock.ts` **does not exist anywhere in the repository**
//   (workflow has no lock module of its own; it reuses the generalized module ①) ⇒ building from the old draft would go and modify a file that does not exist,
//   and record the wrong number of sites. What the actual code confirms is exactly the 4 sites above.
// 🔴 sanitize consistency (a mismatch means "each side locks its own"): Node side `replace(/[^A-Za-z0-9_]/g,"_")` (backfill/execute.ts:90),
//   python side `_sanitize_node_id` — because section 1.1a already restricts the targetId character set to `[a-z0-9_]`,
//   **targetId is invariant under the sanitize of both sides**, which eliminates the mismatch at the root; the unit test must pin "all four sites produce the same string".
// The lock-parity unit test grows by three cases: ① different targetIds on the same business row can hold locks simultaneously; ② same targetId + same nodeId is strictly exclusive; ③ all four sites produce the same string.
//
// 🔴 ① Why the home exemption is mandatory (otherwise double runs): `etl/dag-generator.ts:67` has `_LK_TOK="runLockToken"`
//    **hard-coded and baked into DAG files already shipped to S3** ⇒ existing DAGs keep using the old attribute **until they are republished**;
//    if home switched to `runLock_tgt_home*`, the MWAA side (old attribute) and the platform side (new attribute) = two different locks
//    ⇒ the same job runs twice = the DROP+CTAS OID collision fixed earlier would recur. With the home exemption, existing DAGs and new code naturally share one lock.
//    (This is exactly the "home value == old value ⇒ zero migration" principle already established in section 6.8; section 3.6 had not applied it before, now added.)
// 🔴 ② Why the separator must change to `-`: with `runLock_<targetId>_<nodeId>`, because targetId and nodeId **are both [a-z0-9_]**,
//    the attribute name is irreversible and **collides** — target `tgt_a` + node `b_c` and target `tgt_a_b` + node `c` both become
//    `runLock_tgt_a_b_c` (both satisfy the regex of section 1.1a) ⇒ two different targets contend for the same lock, directly overturning
//    the acceptance criterion "different targets with the same taskId can run in parallel"; and `POST /api/workflow` spreads `...body`
//    (`workflow/route.ts:66`) ⇒ a client can supply its own nodeId to **construct a collision** and block or steal another target's lock.
//    Unit test to add: "lock attribute names across targets can never be equal".
// 🔴 ③ Leak and growth of lock attributes (fixed in the same batch, otherwise a rollback can "restore a live lock"):
//    · A lock is **a pair** of attributes (`run-lock.ts:43-45` `${attr}Token` / `${attr}ExpiresAt`),
//      and they are **REMOVEd only on normal release**; lease expiry only makes them "stealable" and never deletes them; nodeId contains `Date.now()`
//      (`workflow/[id]/page.tsx:367`) ⇒ deleting a node and adding one again = a new attribute pair ⇒ **unbounded growth** over the lifecycle, multiplied by the target dimension ×N;
//      a single `bgp-workflows` item already inlines the whole node graph + every node's SQL (`types/workflow.ts:11`), and there is no 400KB guard anywhere in the repository.
//    · 🔴 `versions/version-service.ts:66-74 extractConfig` copies **every non-META attribute** into the version snapshot,
//      while `META_FIELDS` (:49-56) **does not exclude `runLock*`** ⇒ lock attributes enter every version, and a rollback **restores an unexpired lock**
//      (blocking for up to the lease duration). **Fix: add `runLock*` to the META_FIELDS exclusion + REMOVE on expiry as a sweep + an item-size guard.**
// 🔴 Home DynamoDB unreachable ⇒ lock unobtainable ⇒ **fail-closed: refuse to start** (never allow a double run), and:
//   **the observable form is fixed** — the run is recorded as **`failed` + an alert is raised**; 🔴 reusing the existing ETL `AirflowSkipException` **is forbidden**
//   (section 6.3 has established that it is the culprit behind "silently skipping the whole execution"; a fail-closed path that reused it would reproduce the same bug).
```

### 3.7 🔴 queryHandle (the standalone security fix for the IDOR; unified with the project-isolation design, section 3.6)

```text
// Submission side: every path that produces a "retrievable result" goes through this wrapper
async function submitStatement(sql, ctx): Promise<{statementId, handleId}> {
  const statementId = await rsData.executeStatement(...)   // or athena.startQueryExecution
  const handleId = uuid()
  await handles.put({handleId, statementId, targetId: ctx.targetId, projectId: ctx.projectId,
                     ownerSub: ctx.identity.sub, jurisdiction: ctx.jurisdiction,
                     createdAt: now(), expiresAt: now()+36h})   // cleaned up automatically by DynamoDB TTL
  return {statementId, handleId}
}
// Retrieval side (result/[id], athena results, bi/export…):
const h = await handles.get(req.query.handleId)
if (!h || h.statementId !== params.id) DENY(403)
if (h.expiresAt < now()) DENY(410)
if (h.ownerSub !== ctx.identity.sub && !isMember(ctx, h.projectId)) DENY(403)   // ownership + project membership, both checked
// 🔴🔴 Enumeration corrected in revision 3.0 — the criterion is **whether the handle / statement id leaves the server to the client**, not "whether SQL is executed":
//   Class A **the id goes to the client ⇒ a handle must be issued and returned** (the retrieval side is protected by the handle):
//     ① app/api/redshift/execute            → returns statementId
//     ② 🆕 app/api/athena/query/route.ts:22  → returns queryExecutionId (previously missed!)
//     ③ 🆕 app/api/sync/execute-ddl:39,45    → returns statementId (previously missed!)
//     ④ the asynchronous data fetch of genbi (returns a task/statement id for the front end to poll)
//     ⑤ data-service/execute (if it returns an id for later result retrieval)
//   Class B **the id does not go to the client; rows are fetched synchronously in-process and discarded ⇒ a handle is issued only for the audit / ownership ledger and is not returned**:
//     modeling/redshift (execScalar), metrics/service, quality/service, sensitive/scan
//     (listing these together with class A earlier produced the "7 submission points" that both missed two class-A sites and treated the class-B sites as needing a returned handle)
// ✅ Feedback from implementing the standalone security fix (2026-08-29; this enumeration corrected after classifying each site against the actual code):
//   · Class A **actually has only 3 sites**, not 5: ① redshift/execute ② athena/query ③ sync/execute-ddl.
//     ④ the genbi asynchronous fetch **is not class A** — what it sends out is a taskId, not a statement id, and tasks/[taskId]:84 already has
//        the ownership check `task.userId !== getUserId(req) → 403` (equivalent protection, different mechanism).
//     ⑤ data-service/execute **is not class A** — that path does not exist at all (it is actually data-apis/*), and a repository-wide
//        grep confirms it sends out no statement id whatsoever. The original condition "if it returns an id for later result retrieval" does not hold.
//     ⇒ Lesson: the class-A criterion must be decided by grepping the outgoing fields site by site; listing too many creates dead code nobody uses, while listing too few is the real fail-closed false refusal.
//   · 🆕 **The retrieval side gains one structurally identical IDOR that the original enumeration of this specification missed: `app/api/athena/query/[id]/stop`** —
//     it only has `requireProject(req,"viewer")` and **does not check who started that queryExecutionId** (the comment even says
//     "cancel a read-only query you started yourself", but nothing enforces it) ⇒ any project viewer can stop other users' and even other projects' queries,
//     structurally identical to `redshift/cancel`. Handled with the same decision as cancel (handle-ownership check + editor fallback + audit).
//   · flink/jobs/[id]/results and etl-jobs/[id]/logs were checked and **are not in scope of the standalone security fix**: their ids are resource ids,
//     checked by `guardResourceAccess(req, item, "viewer")` against the resource's project, and the statement id comes from the server-side record, not from the client.
// 🔴 Retrieval side: **structurally identical IDORs are fixed together**: besides redshift/result/[id] —
//     🆕 app/api/athena/query/[id]/results/route.ts:8 currently has only `requireProject(req,"viewer")`,
//        **does not check that the queryExecutionId belongs to this project** = the same cross-project privilege escalation as redshift; it must go through the handle in the same batch;
//     🆕 flink/jobs/[id]/results (if result retrieval exists) is checked and fixed the same way.
// 🔴 Transport decided: the handle travels as a **query parameter** `?handleId=` (not a header, which eases the refactor of the front end's existing fetch calls and log troubleshooting);
//   **status polling** (status only, no rows) **does not require the handle** (so polling is not interrupted by handle expiry),
//   but **as soon as result rows are returned the handle must be verified**; the response body of every class-A submission route **gains a `handleId` field** (a front-end contract change; the front end must change in the same batch).
// 🔴 `redshift/cancel` decided (removes the either/or left in the project-isolation design): **judged by handle ownership** (no handle obtainable, or mismatch → 403);
//   the editor fallback applies only to legacy statements that have no handle, and **is audited**.
// 🔴 Rollback feature flag location: `bgp-settings` with `sk="security#query-handle"` (`{enforce:boolean}`),
//   default `true`; setting it to false is only for emergency rollback (**rolling back restores the IDOR**; requires approval + audit + a time limit).
```

### 3.8 Axis A — modeling landing fan-out to multiple targets (the "multi-region modeling" question)

```typescript
// The definition is globally unique (D2) + a targets[] binding; the structural DDL is materialized per target
async function landCodeTableToTargets(codeTableId, {targets}) {
  for (const targetId of targets) {                       // per target, serial, fail-fast (dispatched as in section 5.2)
    assertCapability(targetId, "redshift")                // component precondition check
    const cred = await getPrivilegedCred(targetId, {purpose:"admin-ddl"})   // 🔴 privileged credential factory of section 3.9 (enum names as defined in section 3.9)
    // 🔴 Code-table **values** pass the residency classification gate before cross-target dispatch (no blanket "reference data" exemption; design document, section 20.6-B)
    if (!isShareableReference(codeTable, targetId)) { record("blocked-by-residency"); continue }
    await execStatements(cred, buildLandStatements(codeTable, {schema: SHARED_SCHEMA}))  // lands in shared (jointly with the project-isolation design)
    // 🔴 Structural drift check (design document, section 20.6-C): compare the physical schema hash and write it back to the **observed state**
    const observed = await introspectTableSchema(cred, fqn)
    await writeLandedByTarget(codeTableId, targetId, {version, observedSchemaHash: hash(observed),
                                                     status: hash(observed)===hash(expected) ? "ok" : "drift"})
  }
}
// Dimension / fact tables: same structure (applyModelTableDDL gains a target); ⚠️ only the **structure** is pushed, business data stays in its region
// Feeds the version-consistency dashboard of section 5.3: which target is missing a table / has mismatched versions / has drift is visible at a glance
```

🔴 **Revision 3.20 (the modeling unbind work package; decided on 2026-09-05: "unbind + clean up landed artifacts") — the three explicit actions on modeling artifacts, unbind / clean up / delete definition, are finalized**. Until then the platform had no unbind action at all and a binding could only grow through landing ⇒ the "Leftover" state could not be produced in a real environment (as recorded in the acceptance notes); `DELETE` of a definition only deleted the DynamoDB row while the physical tables in every region silently became orphans — the very thing section 2bis.4 is meant to expose was being manufactured by the entry point itself.

- `POST /api/modeling/{codetables|dimensions}/[id]/unbind` `{targetId, cleanup:boolean, confirm?}` (bgp-admin):
  · `cleanup=false` "Unbind only": the target is removed from `targets[]`, **the `landedByTarget[targetId]` record is kept** ⇒ the matrix / landing panel draws "Leftover" truthfully (the physical table in that region still exists; it is never hidden);
  · `cleanup=true` "Unbind and clean up": **first** execute `DROP TABLE IF EXISTS <schema>.<table>` on that target (through `landing.ts`, the **same** execution channel as landing; observe once before and once after the DROP, and the second observation must be "table does not exist"), **and only after success** delete the landing record and shrink the binding; the order cannot be reversed (removing the record first and then failing the DROP = a real orphan). DROP is destructive ⇒ `confirm` must equal the physical table name verbatim (mechanism A, the same discipline as forced rebuild);
  · a target whose record is `status=credential-gap` (no statement was ever executed): clean-up = delete the record only, without connecting to the database (it cannot be connected to, and there is no table either);
  · unbinding the last target ⇒ `targets=[]` ⇒ falls back to home under the default semantics of section 1.3a, and the UI must state this explicitly.
- `DELETE /api/modeling/{codetables|dimensions}/[id]`: **409 `DECISION_REQUIRED` while any landing record exists** (the response lists `{targetId, table, status}`), with two ways out: "Unbind and clean up" region by region and then delete; or `?keepTables=1&confirm=<code>` to explicitly keep the physical tables and delete only the definition (the audit detail records "deliberately kept" per table).
- Impact preview: `GET .../[id]/unbind-preview?targetId=` returns `{table, rowCountEstimate, lastLandedAt, status}` (the row count reads `SVV_TABLE_INFO.tbl_rows` in that region; the estimate is labeled "approx.").
- Audit: `modeling.{codetable|dimension}.unbind` (detail `targetId / cleanup / table / dropped`).

### 3.9 🔴 Per-target privileged (admin/DDL) credential factory (new load-bearing P0 item of the design document, section 20.6-A)

```text
// Current state: getRedshiftSecretArn is pinned to home + a process-level single-value `_arn` cache + a single secret (admin-secret.ts:10-25)
// → axis A per-target materialization, per-target schema cleanup on project deletion, and the per-target creation of shared/proj_ in the project-isolation design all hang on it
//
// 🔴🔴 The single authoritative contract (corrected in revision 3.0: previously this specification and the project-isolation design, section 3.4, used different enum names,
//      and the shared name governance-read had opposite semantics — implementing the old version of this specification would have made governance / metrics / quality / sensitive-data scanning
//      all refused fail-closed = exactly the failure mode the project-isolation design's credential finding is meant to prevent.
//      The three enum values of the project-isolation design are now adopted; this specification follows them and no longer defines names of its own)
type Purpose = "project-context" | "governance-read" | "admin-ddl"
const _cred = new Map<string, Secret>()          // key = `${targetId}#${project ?? "-"}#${purpose}`

async function getPrivilegedCred(targetId, {purpose, project}: {purpose: Purpose, project?: string}) {
  const t = registry.getTarget(targetId)          // not ready ⇒ throw (never fall back to home)
  switch (purpose) {
    case "project-context":                       // ① project context: execute / genbi (data-service retired on 2026-09-05, section 3.9c)
      // 🔴🔴 Redone in revision 3.3 (2026-08-31, decided: option A; based on the root-remediation proposal for the external review's credential findings, section 3)
      //    Abandons the switch-style transition `PER_PROJECT_CRED_READY(targetId)` of revision 3.1 — the second external review confirmed two hard defects:
      //    ① it decided permissions by **negative inference** (`!capabilities.includes(...)`): a missing field / a rollback / a DynamoDB read failure
      //       would all be interpreted as legacy ⇒ an already-isolated target could regain admin = fail-open;
      //    ② the fallback result went into a **process cache without TTL** ⇒ a single fallback kept the admin capability for the whole lifetime of the process,
      //       and switching the target to ready in the provisioning phase **could not switch it away** (measured: after the switch, the second call still returned legacy admin).
      //    Decision: replaced by a **persisted, monotonic, irreversible** credential-isolation state machine (see the new fields in section 1.1 and section 3.9b below).
      assertProjectId(project)                    // 🔴 project-context **must** carry a projectId; optional is not accepted
      const st = requireCredentialIsolationState(t)          // missing / unknown ⇒ throw + alert; never implicitly treated as legacy
      const arn = await lookupProjectSecretArn(targetId, project)
      if (arn) return cachedByEpoch(arn, st.credentialEpoch)
      if (st.credentialIsolationState === "isolated")
        throw new Error(`no per-project credential ${targetId}/${project} — refuse`)  // steady state: never fall back
      // only **existing home traffic** within legacy-seeded / a controlled provisioning window may fall back explicitly:
      return legacyFallback(t, project, st)       // no indefinite caching (short TTL bound to the epoch) + audit + metrics + alert
    case "governance-read":                       // ② platform-level **read-only** controlled global reader (governance / metrics / quality / sensitive-data scanning)
      // 🔴 **Never** goes through lookupProjectSecretArn (these callers have no project ⇒ they would be wrongly refused fail-closed)
      return SYSTEM_GOVERNANCE_IDENTITY           // read-only + constrained return shape + strong RBAC + full audit (project-isolation design, section 3.4 ②)
    case "admin-ddl":
      // 🔴🔴 Redone in revision 3.2 (2026-08-29; the external review confirmed two hard defects):
      //   ① the original text called `assertWhitelistedDdl(stmt)` / `assertNotUserDataRead(stmt)` here, but **`stmt` is not
      //      among the parameters at all** ⇒ the pseudocode is not implementable; copied verbatim it would not even compile.
      //   ② more importantly: even with `stmt` added, this branch still ended with `return cached(admin)` — **handing the raw admin
      //      secret to the caller**. A one-time check of a single `stmt` constrains nothing about what the caller runs once it holds the secret;
      //      the whitelist became decoration, and class ③ amounted to "a universal admin with one check attached".
      // ⇒ **Decision: admin-ddl no longer receives credentials from this factory.** Replaced by the closed executor `executeAdminDdl()` of section 3.9a:
      //   validation and execution are closed inside one function, the credential never leaves the function, and the type layer exposes no Secret.
      throw new Error("admin-ddl is not issued credentials by getPrivilegedCred; call executeAdminDdl() (section 3.9a)")
  }
}
// 🔴 The verdict is by **static classification of the call site** (not by inspecting the SQL at run time); all three classes of calls are audited
// 🔴 Terminology alignment: wherever the rest of this document says "class ③" it means purpose="admin-ddl" ⇒ it always goes through executeAdminDdl() of section 3.9a
// 🔴 New operations surface: **creation + rotation + revocation** of regional admin/DDL credentials (merged with section 8.5.7 ⑨; listed as a deliverable of the execution-environment stack-group construction batch)
```

### 3.9b 🔴 Added in revision 3.3: credential-isolation state machine (unifies the contract conflict between this specification, section 3.9, and the project-isolation design, section 3.4)

> - ✅ **Decided on 2026-08-31 (option A)**. Based on the root-remediation proposal for the external review's credential findings, section 3.
> - 🔴 **This section is the single authority shared by this specification and [the project-isolation design](./project-isolation.md)**; section 3.4 of the project-isolation design must match this section verbatim (changing only one copy = leaving a collision behind).

**The conflict as it stood**: section 3.9 of this specification allowed a transitional fallback to the single admin before per-project credentials were provisioned (otherwise execute/GenBI would be interrupted across the board; data-service was retired on 2026-09-05);
section 3.4 of the project-isolation design required "a missing project credential must be refused; never fall back to admin". The two are **unified by state and time boundary**, not by choosing one of them.

**Authoritative contract text**:

> Every target must persist an explicit, monotonic, irreversible `credentialIsolationState`. **Only** existing home targets **explicitly registered by the deployment migration script** may enter `legacy-seeded`; new targets start at `provisioning` and may not enter `isolated` until project-credential provisioning and verification are complete. In the `isolated` state, a project-context call lacking a project credential **must fail closed**; no error, missing field, cache miss or rollback **may restore the admin fallback**.
>
> The legacy admin fallback is **allowed only** for **existing home traffic** in `legacy-seeded` or within a controlled `provisioning` window; it must have an audit trail, metrics, a deadline and an irreversible convergence plan. **A missing state must not be interpreted as legacy.**

| Item | Decision |
|---|---|
| **New descriptor fields** (section 1.1 updated in step) | `credentialIsolationState`: `legacy-seeded \| provisioning \| isolated`; `credentialEpoch` (N); `credentialStateUpdatedAt` (S); `provisioningOperationId?`; `provisioningDeadlineAt?` |
| 🔴 **Deriving the state is forbidden** | It must not be derived from a missing `capabilities`, a missing env, a DynamoDB read failure or a default value. `capabilities` may be used **to display capabilities**; **it cannot replace the permission state machine** |
| **Allowed transitions** | **Only** `legacy-seeded → provisioning → isolated`. Every transition uses a DynamoDB `ConditionExpression` that checks the **previous state + current epoch**; on success `credentialEpoch++`; **no reverse API is implemented** (rolling back application code must not roll back the persisted state) |
| 🆕 **The deadline must be enforceable** | 🔴 **Revision 3.7 (a finding of the fourth external review)**: `provisioningDeadlineAt` is not "a field stored for show".<br>**Write side**: strict RFC3339/ISO-8601 parsing + **must lie in the future** + **must not exceed `PROVISIONING_MAX_WINDOW_MS = 30 days`** (a very distant deadline is not materially different from "no deadline").<br>**Read side (admission)**: the `provisioning` state **must** have a parsable deadline; **once expired it fails closed exactly like `isolated`**; missing / unparsable **is treated as expired**.<br>🔴 **An alert cannot replace a hard refusal** — the previous version only checked "non-empty" on the write side and the read path never looked, so a past timestamp or a string such as `"soon"` could **use the shared admin indefinitely**.<br>**Extension** is only possible through a dedicated, audited operation that carries the epoch; never by "keeping the shared admin going" |
| 🆕 **Single write channel** | 🔴 **Revision 3.5 (item N1 of a finding of the third external review)**: state transitions **may only** go through `advanceCredentialIsolationState(targetId, {fromState, toState, expectedEpoch, operationId?, provisioningDeadlineAt?})`. It does three things a generic patch cannot: ① the conditional write checks **previous state + epoch**; ② on success `credentialEpoch++` (**this is the fulcrum of cache correctness** — without the ++, the state switches but the old slot still hits, which is the original defect found by the second external review); ③ **only the two forward edges are accepted**; there is no reverse function.<br>🔴 **The generic `reconcileTarget` must reject these five fields** (see the allow-list in section 1.1) — measured: the original implementation could flip `isolated` back to `legacy-seeded` through it.<br>🔴 Entering `provisioning` **must carry `provisioningDeadlineAt`** ("the fallback must not be open-ended", this section).<br>⚠️ **Recorded honestly**: this function **does not include** audit events / metrics / timeout alerts (they need a request context and an alerting channel) ⇒ wired in **the per-project credential provisioning phase**; **until then the observability loop of this section must not be claimed complete**. The callers belong to that phase as well |
| **Preconditions for entering `isolated`** | Every project in use on that target has a secret; the secret points to the correct account/region/workgroup/database; the project role can access only its own schema and the permitted `shared`; the canary succeeds; the old admin-fallback call surface has been reduced to zero or is refused by the state gate. **A failed state write / a failed audit / incomplete verification ⇒ no advance** |
| 🔴 **Cache rules** | Cache key = `targetId + projectId + purpose + credentialEpoch`. The fallback of `legacy-seeded/provisioning` **is not cached indefinitely** (if kept, a short TTL bound to the epoch); after a state switch, old-epoch cache entries can no longer hit; switching to `isolated` requires **cross-instance invalidation or a strongly consistent cutover gate** (calling `clear()` in the current process alone is not enough); secret rotation likewise increments the epoch; **a cache hit must not skip the status/ready/epoch check** |
| **Fallback observability (closed loop)** | Every fallback records at least `who / targetId / projectId / purpose / credentialIsolationState / credentialEpoch / requestId / operation / result / at`; **no secret / password / full sensitive SQL is recorded**. All of the following must exist at the same time: an audit event, metrics per target·project, alerts on provisioning timeout and on a non-zero fallback count, and a **zero-tolerance alert** for any fallback that appears in `isolated`. 🔴 **`console.warn` plus an in-process Map alone does not count as an observability loop** |
| **Zero-downtime rollout sequence** | ① extend the registry schema (read path unchanged) → ② the migration script **conditionally writes** the existing home as `legacy-seeded` and verifies count/account/region → ③ ship read logic that accepts only an explicit state (missing state ⇒ refuse) → ④ enter `provisioning` and create every project role/secret in parallel while business stays available → ⑤ freeze, or provision synchronously, newly added project bindings → ⑥ run the permission canary + cross-project negative tests + the secret integrity check → ⑦ conditionally write the switch to `isolated`, epoch++, complete the cross-instance cutover → ⑧ delete the legacy runtime path and the compatibility switches, **keeping the audit history** |
| 🔴 **Unacceptable practices** | ① deleting the legacy fallback before per-project provisioning is complete (interrupts execute/GenBI = cutting features; data-service retired on 2026-09-05); ② continuing to interpret a missing capability/field as legacy; ③ keeping the state only in env / process cache; ④ clearing only the current process's cache; ⑤ feature flags that default security logic to off, or automatically reverting to the old admin on exception |

**Acceptance (section 16 updated in step)**: before per-project provisioning, execute/GenBI on the existing home keep working (data-service retired on 2026-09-05, no longer verified); missing state / unknown state / DynamoDB error
must never fall back; after removing an isolated target's capability it still refuses to fall back; the conditional write of `isolated → provisioning/legacy-seeded` fails;
after legacy→isolated, **another process holding the old cache can no longer return admin**; a new non-home target without project credentials may not become active;
a project-context request lacking projectId is refused outright; the fallback metric in the `isolated` state is **permanently 0**.

### 3.9a 🔴 Added in revision 3.2: `executeAdminDdl()` — the closed admin-DDL executor (replaces issuing credentials for class ③)

> - 🔴 **Redone in revision 3.3 (2026-08-31, decided: option B)**. Based on the root-remediation proposal for the external review's credential findings, section 4.
> - Revision 3.2 placed `statements: string[]` in the **public parameters** and relied on an after-the-fact comparison by `assertGeneratedByTemplate` —
>   the second external review confirmed that this does not hold: once a public interface accepts free text, there is room for substitution between validation and execution;
>   and in testing, that set of regex guards could itself be bypassed (`'--'` masking the following statement, `UPDATE` on a quoted identifier,
>   `DROP DATABASE`, a cross-project `GRANT`, `CALL` — all let through).
> - ⇒ **Decision: the public interface accepts only a structured request; the SQL is generated by module-private templates that the caller can neither obtain nor modify.**
>
> - 🔴 **Feature conservation (items 5 and 6 of the list of unacceptable practices)**: what the remediation removes is "**free SQL under admin privilege**",
>   **not** the product's free-SQL feature. The following must continue to exist and genuinely pass: the **SQL editor**, execute / GenBI (**data-service was retired on 2026-09-05**; it is no longer a conservation object, see section 3.9c),
>   governance · metrics · quality · sensitive-data scanning, **model table landing**, **DMS bootstrap**, **code-table landing**, project-deletion cleanup,
>   and all 7 operations are kept. Unimplemented operations **must not** be turned into a permanent throw / 501 / no-op posing as fail-closed.

```text
// 🔴 Public interface: **does not accept sql / statements[]**. Any name that can be derived from the single source of truth may never be chosen freely by the caller.
type AdminDdlRequest =
  | { operation: "create-project-schema";  targetId: string; projectId: string }
  | { operation: "create-shared-schema";   targetId: string }
  | { operation: "create-role";            targetId: string; projectId: string }
  | { operation: "grant";                  targetId: string; projectId: string }
  | { operation: "drop-project-schema";    targetId: string; projectId: string; approvalId: string }
  | { operation: "dms-ingest-bootstrap";   targetId: string }
  | { operation: "land-code-table";        targetId: string; projectId: string; codeTableId: string }
  | { operation: "grant-shared-writer";   targetId: string; codeTableId: string }   // 🆕 revision 3.48, section 3.9d (the shared-writer work package)
  | { operation: "land-model-table";      targetId: string; modelTableId: string } // 🆕 revision 3.49, section 3.9d.6 (the model-table half: pure DDL, no narrow-privilege writer needed)
  | { operation: "alter-model-table";     targetId: string; modelTableId: string } // 🆕 revision 3.52, graphical table alteration (the plan lives in the ledger field pendingAlter; statement author lib/modeling/alter.ts)

// Private template registry: one exhaustive builder per operation; the product is a **module-private branded type** that cannot be constructed from outside.
type GeneratedAdminStatement = string & { readonly __brand: unique symbol }
type TemplateBuilders = { [K in AdminDdlRequest["operation"]]:
  (req: Extract<AdminDdlRequest, {operation:K}>, ctx: VerifiedAdminDdlContext) => GeneratedAdminStatement[] }
//   · schema names come from projectSchema(); role / table / FQN names come from their respective single sources of truth (items of the code-review round)
//   · identifiers and literals are encoded separately; string-concatenating user free text is forbidden
//   · when an operation is added, TypeScript exhaustiveness checking forces the additions: template + RBAC + audit classification + tests

async function executeAdminDdl(actor: AuthenticatedActor, request: AdminDdlRequest)
  : Promise<{ affected: number; auditId: string }> {          // 🔴 no secret / ARN in the return value
  // Internal order is fixed and may not be reordered:
  // 1) runtime schema validation of the structured request (not a TS cast)
  // 2) server-side resolution and **cross-validation** of target / project / resource ownership (not trusting header/body alone)
  // 3) **strongly consistent** check of target ready / status / credentialEpoch (section 3.9b)
  // 4) per-operation RBAC / approval / binding-count / lifecycle precondition checks
  // 5) the private template generates the SQL
  // 6) write the **execution-intent** audit record; audit failure **refuses immediately** (fail-closed-on-audit)
  // 7) read that target's admin secret inside the function — no return, no entry into any externally visible cache
  // 8) execute in the fixed target workgroup/database; **IAM fallback forbidden** (resolution failure ⇒ refuse; SecretArn is never omitted)
  // 9) write the success/failure result audit record and return the non-sensitive result
}
// ⇒ The caller never obtains the credential and cannot substitute the SQL after validation, so there is no "check A, execute B" TOCTOU.
```

**Special handling of `land-code-table` (section 4.6; otherwise wiring it in kills the feature)**: code-table landing has **both DDL and controlled DML** —
the actual code `modeling/redshift.buildLandStatements` generates `CREATE TABLE IF NOT EXISTS` / `DELETE FROM` /
`DROP TABLE` / `INSERT INTO … VALUES`. Yet revision 3.2's `assertNotUserDataRead` **blanket-forbids `INSERT`/`DELETE`**
⇒ **wiring it in directly would condemn code-table landing** (confirmed against the actual code on 2026-08-31). Decision: split into two layers:
① the admin executor only creates/verifies the `shared` code table's **structure + owner + permissions**;
② **data writes go through a narrow-privilege `shared-writer` or a fixed-parameter stored procedure**, not through admin;
   🆕 **revision 3.48 has defined and delivered this carrier ⇒ see section 3.9d** (until then it was only a sentence, which is why non-home modeling landing
   was deterministically judged `credential-gap` — a contract sentence without a carrier is exactly why the fifth state in [the interaction design, section 4ter.a](./multi-region-execution-interaction.md) exists);
③ the caller passes only `codeTableId` / structured values, never SQL;
④ throughout, verify that the object's ledger `kind` is the shareable `modeling-global`; **business tables are forbidden in shared**.
Even before the split is made, the fixed DML **must** be generated by internal templates; free SQL must not be reopened.

**Disposition of the existing regex guards**: `assertOperationAllowed()` is replaced by runtime discriminated-union validation;
`assertNotUserDataRead()` / `assertNoCrossProjectMove()` **may no longer serve as a security boundary**; they may be kept as
**non-authorizing defense-in-depth / alerting**, and must be labeled "**a hit may refuse; a miss does not mean safe**".
The following payloads **must** enter the negative regression suite: `COMMENT ON SCHEMA s IS '--'; SELECT * FROM orders` /
`UPDATE "orders" SET x = 1` / `DROP DATABASE victim` / `GRANT ALL ON SCHEMA proj_b TO ROLE role_proj_a` / `CALL evil()`.

**Batching (decided: option C)**: the **remediation batch of the code-review round** delivers only the side-effect-free foundation (structured union + 7 private template builders + exhaustiveness / naming / ownership /
negative pure-function tests; the admin-ddl branch of `getPrivilegedCred` keeps explicitly refusing to issue credentials; **no production call is migrated and no live behavior changes**),
and **explicitly marks the external review's free-SQL finding as still open**; the real closure comes in **the per-project credential provisioning phase and the execution-environment stack-group construction batch** (state machine + per-project provisioning + closed executor +
wiring into RBAC/approval/audit/target secret/the real runner + migration of every call surface + a lint rule forbidding bare calls + E2E and cross-project negative tests).

🔴 **It is not acceptable to both postpone the executor and the migration and claim that the security remediation is complete** (item 10 of the list of unacceptable practices).

### 3.9c 🆕 Revision 3.23: register of retired capabilities (decided; the reverse side of the conservation list — anything not registered here would be taken as "a lost feature")

| Capability | Retirement date / basis | Code disposition | Data disposition | External statement |
|---|---|---|---|---|
| **Data Service (data-service)** (the Data Service module: table / SQL → REST API + api-key) | Decided on 2026-09-05 (verbatim: "I no longer want to support 'Data Service' … do not support this feature"; the approach and the construction package were recorded in the planning notes) | Menu leaf / `app/data-service` page / `app/api/data-apis/**` / `app/api/data-api-keys/**` / `lib/data-service/**` (including tests) / the `TABLES.DATA_APIS·DATA_API_KEYS·DATA_API_USAGE` constants **all deleted**; `app/api/public/data/[...slug]/route.ts` **file kept**, GET / POST / PUT / DELETE / PATCH all return `410 { code:"GONE", message:"The data service capability was retired in 2026-09", since:"2026-09-05" }`, **importing no lib, reading no table, performing no authentication** (no data surface means no leakage surface); the project-deletion inventory (`lib/projects/project-resources.ts`) drops the `data-api` category | The three tables `bgp-data-apis` / `bgp-data-api-keys` / `bgp-data-api-usage` **are kept** (RETAIN discipline; measured 0 rows; dropping the tables goes separately through the destructive-change gate) | No longer a feature-conservation object of section 3.9a, no longer a submission point of section 3.7, no longer a consumption surface of the multi-region read-surface batch; the data-service branch disappears from the 18 call sites of the per-project credential provisioning phase |
| **BI data source `dataapi`** (the BI report builder's `WidgetSource.kind="dataapi"`, referencing a published DataApi) | Same as above (it depends on data-service's definitions and executor; without the data service there is no API to reference; measured `bgp-data-apis` 0 rows ⇒ zero dataapi widgets in production) | 🔴 **Type kept, capability retired**: the `dataapi` branch in `WIDGET_SOURCE_KINDS` and in the `WidgetSource` union **is kept** (existing rows deserialize without crashing; no data migration); the widget editor's "Data source" selector **no longer offers** this item; the `dataapi` branch of `executeBiDataApi` and of the three BI routes (`bi/query` / `bi/analysis-query` / `bi/export`) becomes **one and the same** business error `410 { code:"GONE", message:"The data service capability was retired in 2026-09; change this visual to a SQL or GenBI source" }` (**does not import data-service**) | None | Existing dataapi widgets render as a "Data service retired" placeholder instead of a 500 / blank page (an acceptance criterion) |

🔴 **Shared pieces that must be preserved inside the removal's blast radius**: `renderSql` / `coerceParams` in `lib/data-service/validate.ts` and `ApiParam` / `ParamType` in `types.ts` are **not** private to the data service — the safe `{{key}}` injection of BI dashboard filters (escaping in value position / select allow-list, the BI report builder's iron rule against SQL injection) reuses them. ⇒ **Move them byte-for-byte** to `lib/sql/param-render.ts` (single author; `validateApiDefinition` / `validateParamDecl`, the two functions that serve only DataApi definitions, are deleted together with the lib), and `lib/bi/query.ts` / `lib/bi/types.ts` change their import paths; the existing test cases on `renderSql` / `coerceParams` in `validate.test.ts` **move unchanged** (they are the anti-injection regression net, not tests of the data service).

### 3.9d 🆕 Revision 3.48: the narrow-privilege `shared-writer` identity class — closing the "⊘ write channel missing" state

> 🔴 **This section supplies the carrier for the sentence in section 3.9a / section 4.6 ②**. Section 4.6 splits code-table landing into two layers: "structure + owner + privileges" goes through the admin templates,
> and "**data writes do not go through admin**"; but the carrier of the second layer — "a narrow-privilege `shared-writer` or a fixed-parameter stored procedure" — **was never implemented**
> since the decision of 2026-08-31, so modeling landing on a non-home target deterministically evaluates to `credential-gap` (the fifth state in [the interaction design](./multi-region-execution-interaction.md), section 4ter.a;
> reproduced on every run against the live environment). This section defines that carrier and also pins down "how the transition period lands and when it converges".

#### 3.9d.1 Identity dimension: **per target**, not per project

| Item | Decision | Why not the alternative |
|---|---|---|
| Principal | **One** login user `shared_writer` in each target's warehouse (name from the SSOT `sharedWriterUserName()`) | Modeling is **platform-global** (it has no project) ⇒ issuing identities per project would give the same code table N writers while it has exactly one owner; `dms_ingest` is an existing precedent of the same shape |
| Secret | Named `bgp/shared-writer/<targetSlug>`, derived by the SSOT `sharedWriterSecretName(targetId)` | `bgp/` is the only self-managed prefix the platform TaskRole is authorized for (the same reason as `projectSecretName`); the target dimension goes through `toTargetSlug()` and is never concatenated by hand |
| 🔴 **Not written into the descriptor's resource bag** | At the point of use the ARN is **looked up live** by name via `describeSecretArnByName(region, name)`; **no** `sharedWriterSecretArn` is written into `resources` | The resource bag has a **single author**: the deploy-time `readExecEnvStackOutputs` (which reads CFN Outputs). Adding a non-CFN key at runtime = **a second author**, while "is the resource bag complete" is a closed-form check (`COMPONENT_REQUIRED_RESOURCES` + the probe list) ⇒ one more key from a different source forks the semantics of that check. The existing precedent `verifyProjectCredentials` likewise **Describes by name** rather than reading the descriptor: since the name is derived by the SSOT, storing an ARN in the descriptor as well is just **a copy that drifts**.<br>🔴 This item **deviates from the original work-package text, item ④** (which said "record `sharedWriterSecretArn` in the resource bag"); the work-package text has been corrected so that code and contract do not tell different stories |
| Password | Generated → into SQL → into Secrets Manager, **never leaving the provisioning function**; never in return values / audit details / logs / templates / branded statements | **Word for word the same discipline** as `provisionProjectLogin` (section 3.9a, "passwords never enter templates") |
| ❌ IAM password-less access is not chosen | The Redshift Data API can run without `SecretArn` and derive the database user from the caller's IAM identity — **this section explicitly does not take that path** | That derived user is **the platform TaskRole itself**: it is not a "narrow-privilege" identity but the very same principal shared with every other platform path; granting it write privileges equals granting them to the whole platform; and step 8 of section 3.9a states explicitly "**IAM fallback is forbidden**". Written down here so that nobody has to re-argue it |

#### 3.9d.2 Privileges: **grant per table**, no schema-level write privilege

```sql
GRANT USAGE ON SCHEMA <landing schema> TO shared_writer            -- USAGE only, no CREATE
GRANT SELECT, INSERT, UPDATE, DELETE ON <this one code table> TO shared_writer
```

🔴 **Never** `GRANT INSERT ON ALL TABLES IN SCHEMA shared`, and **no** `CREATE ON SCHEMA` either:

- a schema-level grant lets it write **any future** table that enters this schema — that is the "enumerate the violations" style of thinking, and what it misses is always table N+1;
- per-table grants are **closed-form**: "**the code table the admin template explicitly created**" is the entire set it may write; a new table cannot be written until it is granted;
- ⇒ the negative check therefore **becomes decidable**: on another table in the same schema that **was not created in this landing**, an INSERT by `shared_writer` must be refused by Redshift (the negative acceptance item);
- table creation is still done by the admin template (`land-code-table`: structure + owner + privileges) ⇒ shared-writer **needs no DDL at all**.

#### 3.9d.3 🔴 The physical landing location of a code table must first have **a single author** (this is the load-bearing part of this work package, not an incidental refactor)

**Today two authors each write a different name**:

| Author | Output | Source |
|---|---|---|
| Live landing | `<spec.schema>.dim_code_<code>` (columns `value/label/seq`) | `modeling/redshift.buildLandStatements` |
| Admin template | `shared.code_<sanitize(codeTableId)>` (columns `code/label/sort_order`) | `land-code-table` in `admin-ddl-templates.ts` |

There is **no mechanical relation whatsoever** between the two; and `grant-shared-writer` must grant on "the table that actually landed" —
if it assembled the name once more by itself, it would be **a third author** (the class of defect this repository has had to fix again and again).

⇒ **Decision: add the SSOT `codeTableLandingFqn(codeTable)`; it is the sole authority for the physical landing location of a code table**,
and all four consumers go through it: ① generation of the live landing statements; ② the admin template `land-code-table`; ③ `grant-shared-writer`;
④ the `physical` field of the consistency matrix.

🔴 **"Landing convergence" thereby collapses into one function's return value plus one migration of existing data**, instead of a repository-wide rename:

- **Transition period** (steps 1–5 of the shared-writer work): `codeTableLandingFqn` returns `<spec.schema>.dim_code_<code>` — byte-identical to the live environment,
  home behavior **unchanged**, the channel is opened first (the positive landing check, the negative grant check and the cross-jurisdiction landing check do not depend on the rename);
- **Convergence period** (step 6): switch it to return `shared.code_<id>` + migrate existing data (dual-write window → view alias → one cut-over; rollback = point the view back),
  pinned by the acceptance item "after migration, queries of existing home code tables return byte-identical results".

🔴 **Why convergence cannot be done for non-home only**: the `physical` field of the consistency matrix is **single-valued** (one physical FQN per code table;
`consistency-matrix.ts` takes it from `ct.physicalTable`). If home lands `public.dim_code_x` and non-home lands `shared.code_x`,
that field cannot express both and the dashboard will **show drift forever**. So convergence must change home as well ⇒ it must touch existing data ⇒ **it is a separate step**,
and must not be tied to "does the channel work" in the same step (otherwise an 8-hour package would have to pass a data-migration gate before it could even start).

#### 3.9d.4 Provisioning sequence and interface (the exhaustive union of section 3.9a gains **one** operation)

```text
// New operation (enters the AdminDdlRequest union; TS exhaustiveness forces a template + RBAC + audit category + tests to be added)
| { operation: "grant-shared-writer"; targetId: string; codeTableId: string }
//   Zero literals in the template: the principal name goes through sharedWriterUserName(), the landing location through codeTableLandingFqn(),
//   codeTableId → read the code-table ledger live → 🔴 verify that kind is the shareable modeling-global (section 3.9a / section 4.6 ④, "no business tables in shared")

// 🔴 Creating the user + setting the password is **not made a template**: passwords must never enter template output (iron rule of section 3.9a; template output goes into the audit log).
//    ⇒ It is the executor's **third public entry point**, same shape and same discipline as provisionProjectLogin:
async function provisionSharedWriter(actor, { targetId }): Promise<{ secretName; created; auditId }>
//   Statements are produced by this module's private builder, not cast to branded, not written to audit details; error text is redacted first;
//   idempotent: if the user already exists ⇒ ALTER USER … PASSWORD (rotation), no error;
//   🔴 The return value contains **no** secretArn / password — a caller that needs the ARN Describes it by name itself (section 3.9d.1).
// 🔴 This item **deviates from the original work-package text, item ③** (which said "provisioning templates create-shared-writer + grant-shared-writer", two templates):
//    the first cannot be a template, for the existing iron rule above. The work-package text has been corrected.
```

**Landing path (the non-home branch of `modeling/landing.ts`)**:
delete the `credential-gap` block entirely and replace it with —
① `executeAdminDdl({operation:"land-code-table"})` creates structure + owner + privileges (admin, no data loaded);
② `executeAdminDdl({operation:"grant-shared-writer"})` grants per table;
③ execute `DELETE FROM … ; INSERT INTO … VALUES …` with the shared-writer secret (**only this step uses the narrow-privilege identity**);
④ **observe once more** after landing (the same discipline as home, section 3.8).

🔴 ① and ② are **idempotent** and run on every landing (re-running provisioning is the normal case: password rotation, new code tables, re-runs after partial failure).

**Preconditions already verified in a real environment (dated, because they expire)**:

| Precondition | Measured on 2026-09-21 | What happens if it does not hold |
|---|---|---|
| Non-home has a usable admin secret | `tgt_usw2_a.resources.redshiftSecretArn` points to `redshift!bgp-namespace-tgt-usw2-a-admin-*` in **us-west-2**; `redshiftWorkgroup=bgp-workgroup-tgt-usw2-a`; `redshiftDatabase=dev` | Step 7 of `executeAdminDdl` cannot obtain credentials ⇒ the whole path is blocked |
| The target passes `requireReadyTarget` | `status=active` `ready=true` | Refused at step 3 |
| Passes `requireCredentialIsolationState` | `credentialIsolationState=provisioning`, `credentialEpoch=0`, `provisioningDeadlineAt=2026-10-19T01:50:08Z` (**parseable and in the future**) | Missing / unparseable ⇒ step 3 throws (a missing state must not be interpreted as legacy) |
| ⚠️ **Window expiry does not affect admin DDL** | `provisioningExpired()` has **exactly one consumer** in the whole repository (the `project-context` fallback branch of `privileged-cred.ts`); `executeAdminDdl` only calls `requireCredentialIsolationState` (which only checks that the deadline **is parseable**, not whether it has passed) | This is not fail-open: the deadline of section 3.9b constrains the "**legacy admin fallback**" window, whereas admin DDL is the **controlled channel** of section 3.9a and is meant to use the target's admin secret anyway. Written here because "will non-home modeling suddenly be refused everywhere once provisioning expires" is a question every successor is bound to ask — **the answer is no** |

#### 3.9d.6 🔴🔴 Revision 3.49 correction: `credential-gap` is **one gate shared by two kinds of objects**, and only one of them needs the narrow-privilege writer

**Revision 3.48 covered only code tables, which is only half right.** A second survey on 2026-09-21 (review once more after the change) established:
the `if (!isHome(targetId)) return credential-gap` in `landOne` sits before **any** modeling landing, and `landToTargets`
has **two** production callers:

| Caller | Statements issued | What it needs |
|---|---|---|
| Code tables: `service.ts` → `buildLandStatements` | `CREATE SCHEMA` / `CREATE TABLE` / `DELETE FROM` / **`INSERT INTO … VALUES`** | 🔴 **Needs the narrow-privilege writer** (the admin channel does no DML, section 4.6) |
| Dimension/fact tables: `dimensions.ts` → `buildCreateTableStatements` | `CREATE SCHEMA` / `CREATE TABLE` / `COMMENT ON COLUMN` — **not a single DML statement** | ✅ **No new identity needed**: pure DDL, which the admin channel is meant to do anyway. All that is missing is **one new template operation** |

⇒ **Contract correction**: the union of section 3.9a gains one more operation — **two** new operations in total:

```text
| { operation: "grant-shared-writer";   targetId: string; codeTableId: string }    // revision 3.48, section 3.9d.4
| { operation: "land-model-table";      targetId: string; modelTableId: string }   // 🆕 revision 3.49, this section
| { operation: "alter-model-table";     targetId: string; modelTableId: string }   // 🆕 revision 3.52, model-table alteration (same discipline as land-model-table: accepts only the id, the server reads the ledger; the plan = the ledger row's pendingAlter)
```

The three disciplines of `land-model-table`:

1. 🔴 **It does not accept schema / table name / columns from the caller** — it accepts only `modelTableId`, and the executor **reads the model-table ledger server-side**
   (word for word the same shape as `land-code-table` accepting only `codeTableId`). The physical table name the user enters on the modeling page is **product ledger data**,
   not "a name freely chosen at the call site" — this distinction must be written down, otherwise a successor will believe it violates section 3.9a.
2. 🔴 **The DDL must reuse `buildCreateTableStatements`**; the template is responsible only for branding and **never assembles the DDL again itself**.
   Assembling it = modeling DDL with **two authors** (one copy each of the column-type normalization `normalizeColumnType` / the primary-key clause / the `COMMENT` escaping)
   ⇒ "the table created on home differs from the table created on non-home", while each side looks correct on its own.
3. Column identifiers and comment literals still go through `safeIdent` / `sqlString` respectively (existing functions, nothing newly written).

🔴 **Why this correction had to be made before writing code**: with code tables only, the "🧱 Dimension/Fact" row in the UI **would still read
`⊘ write channel missing`** ⇒ the fifth state would not disappear ⇒ the closing condition of [the interaction design](./multi-region-execution-interaction.md), section 4ter.a-1, would be **only half met**,
and the inverted headless-acceptance check ("none of them is `credential-gap`") would **go red immediately**.
⇒ The acceptance criteria gain **the model-table half**; only the two halves together count as closed.

#### 3.9d.7 🔴 Revision 3.50, third survey: one more contract sentence **without a carrier** + one honestly recorded design question + one piece of good news

**(a) 🔴🔴 The guard in section 4.6 ④ cannot be implemented — `kind:"modeling-global"` and `bgp-table-ownership` exist nowhere in the repository.**
Section 4.6 ④ says "verify throughout that the object's ledger `kind` is the shareable `modeling-global`; **no business tables in shared**";
a grep on 2026-09-21 found that the literal `modeling-global` appears in the whole repository only in **one comment** in `admin-ddl-executor.ts`,
that the table `bgp-table-ownership` has **not a single line of code**, and that the `CodeTable` / `ModelTable` types have no `kind`
(only `MetricDef` has `kind:"table"|"metric"`, which is a different matter).
⇒ **This is a defect of the same family as section 3.9d itself**: the contract states a sentence, and the thing that carries it does not exist.

**Decision: the guard becomes "ledger membership"; no new field is invented.**

```text
Step 2 (cross-validation) of grant-shared-writer / land-model-table:
  codeTableId  → getCodeTable(codeTableId)   not found ⇒ refuse     (table bgp-code-tables)
  modelTableId → getModelTable(modelTableId) not found ⇒ refuse     (model-table ledger)
```

🔴 **It is stronger than a `kind` string, not a concession**: `kind` is a **string that can be written wrong**, whereas "this id can be found in the code-table ledger"
is **closed-form** — which class an object belongs to is decided by **which ledger it comes from** and cannot be made up. Business tables are not in either ledger at all
⇒ the intent "no business tables in shared" **holds exactly as written**.

⚠️ **Recorded honestly**: `bgp-table-ownership` (the table-creation stamp ledger) remains something the contract mentions and the code lacks —
it does not belong to this package, but **it must no longer be referenced as if it existed** (the original work-package text, item ②, did reference it).

**(b) 🔴🔴 Decided in revision 3.51 (revision 3.50 had written "awaiting a decision" — rejected on 2026-09-21: that was evasion):**
**Modeling artifacts do not go through the "per-project allowlist" axis — because the axis itself is wrong, not because it is hard.** See section 3.9d.8.

**(c) ✅ Good news: the execution channel **already exists** and must not be written anew.**
`execOnTarget({ warehouse, sql, secretArn, maxPolls?, pollIntervalMs? })` (`target-clients.ts`)
is **word for word the shape this section needs**: it takes the Data API client for the target's region + the given workgroup/database + an **explicit SecretArn**
(it refuses an empty ARN by itself, and the stated reason is precisely "section 3.9a forbids IAM fallback").
⇒ The shared-writer DML **uses it directly**; only `secretArn` is swapped for the narrow-privilege one.

🔴 **Never write a new Redshift client for it** — that would be the "second author" this repository keeps having to fix (`rsData = redshiftClientForHomeOnly(...)` in
`modeling/redshift.ts` is already the one pinned to home; this package must not copy it into a per-target version).

#### 3.9d.8 🔴🔴 Revision 3.51: **the authorization axis for modeling landing** — decided (the "awaiting a decision" was rejected on 2026-09-21)

**What the previous revision got wrong** (recorded because it is a class of behavior): a comment in `landing.ts` **had already stated**
"that error text is meaningless for modeling: modeling is global and has no project to begin with" —
in other words, **the axis had already been judged wrong**; but because the `return credential-gap` immediately after it masked it and the branch was currently unreachable,
it was left unfixed and instead repackaged as "⚠️ both answers are defensible, awaiting a decision" and handed off as a decision request.

🔴 **What the shared-writer work does is precisely to remove that early return** — and the moment it is removed, this defect comes alive.
⇒ **Writing a defect one has already judged dead as a multiple-choice question = evasion. Recorded as a defect (2026-09-21).**

**Decision: modeling artifacts (code-table definitions / dimension and fact table definitions) are not constrained by the "authorized projects" allowlist.** All three reasons are verifiable:

1. **The axis is wrong**. The semantics of the allowlist are stated clearly in its own code comment — "**a region used only by certain projects**";
   it governs **which region a project's business data lands in**. Modeling artifacts **have no project dimension** (`LandArgs.projectId?` is optional,
   and modeling calls never pass it). Judging an object that has no project by the project axis is exactly the counterexample to this repository's discipline
   "**a check must be anchored to the object it judges**".
2. **It is not fail-closed, it is dead-closed**. Fail-closed presupposes "there is a correct answer, the evidence is merely insufficient right now ⇒ refuse conservatively";
   here **no `projectId` whatsoever can make it pass** — that is not conservatism, it is a missing capability. **A branch that always refuses is not called safe.**
3. **It contradicts itself**. The intent of the allowlist is "this region serves only these projects", and code tables / dimension tables are
   the **precondition for those projects to run at all in that region**; blocking them ⇒ the projects on the allowlist cannot use the region either
   — the allowlist disables the very objects it wants to serve.

🔴 **Never fail-open.** Replace it with the axis that genuinely governs it; **all four gates must pass** before release:

| Gate | Content | Carrier |
|---|---|---|
| ① Admission | The target exists / is ready / has the `redshift` component installed / the cross-jurisdiction technical prerequisite (`residencyPrerequisite`) | `requireReadyTarget` — **not one character changed** |
| ② Landing location | Must land in the **platform-global schema** (derived by the single author `codeTableLandingFqn()`); **never** into any `proj_<id>` | 🆕 landing-location guard — this is where section 4.6 ④ "no business tables in shared" really lands |
| ③ Membership | The id must be **found** in `bgp-code-tables` / the model-table ledger | Decided in section 3.9d.7 (a) |
| ④ Auditable | The `modeling-land` audit entry as before (decided on 2026-09-05: "auditable is all we need") | Already present in `RESIDENCY_ENTRIES` |

**Implementation shape (hard requirements)**
- 🔴 **Do not change `accessAllows`** — that general check is correct; it is the single author of the `access` allowlist and must not be touched for this package.
- 🔴 Add a **mandatory discriminated union** `scope: "platform-global" | "per-project"` to `BindingOpts`,
  **with no default**: modeling passes `platform-global` explicitly; every other call site passes `per-project` explicitly and must carry `projectId`.
  ⇒ "Forgot to pass it" is a **compile error**, not a silent pass (engineering rule:
  **a parameter with a silent legal default is a breeding ground for a whole class of defects**; this repository has been bitten by it six times).
- When `scope === "platform-global"`, **skip exactly and only** the `accessAllows` gate; ①③④ apply as before;
  and gate ② (the landing-location guard) **must** also pass (otherwise the allowlist has merely been swapped for fail-open).
- Refusal text: after this change, the sentence "not authorized to the project **(no project context)**" in `accessDeniedReason`
  **can no longer appear on the modeling path**; the acceptance check pins it in the negative.

**The paired acceptance check** (in the acceptance criteria), 🔴 **must come as a pair**, otherwise it is "tore out the allowlist and claimed it was fixed":
set `access = {mode:"allowlist", projects:[]}` on `tgt_usw2_a` (nobody may bind) ⇒
① modeling landing **still succeeds** and lands in the platform-global schema; ② **in the same state**, binding an ETL job to that target
**is still refused** with `project-not-allowed` (proving the allowlist still holds for business data);
③ a modeling landing location forged as `proj_xxx` ⇒ **refused**; ④ restore `all-projects` at the end.

#### 3.9d.5 Acceptance checks (the seven items of this section in the acceptance criteria; 🔴 not the earlier number block — that block belongs to the per-region MWAA scheduling work)

See the acceptance criteria. This section pins only two **standards**, so that the checks are not written as "text checks":

- 🔴 The landing check must assert that **the rows really exist in that region's Redshift** (`SELECT count(*)` == the number of enumerated values) + `SELECT current_user` is of the `shared_writer` form.
  "The API returned 200" and "the record says status=ok" **do not count** — that is the platform declaring its own success.
- 🔴 The negative check must be **a real refusal by Redshift** (INSERT into an ungranted table / DROP a table using the shared-writer credentials),
  not "an if statement in the code blocked it".

### 3.10 Axis B/C — authoritative FQN (target segment in the same position) + end-to-end consistency fail-closed

```text
// 🔴 One authoritative function covers [the physical side + the metadata side] (jointly with the project-isolation design: the **9** `||"public"` sites on the metadata side are closed at the same time, including the write side glue-script-generator:344)
function authoritativeFqn({targetId, db, schema, table}) {
  // 🔴 Revision 3.0 fix: the segment value is **targetId**, not regionOf(targetId) —
  //    with the region name, "blue/green or primary/standby twin targets in the same region" would generate [the same FQN / OM service name] = a guaranteed collision,
  //    exactly the kind of collision targetId was introduced to eliminate (this line previously read `bgp-redshift-${regionOf(targetId)}`, a leftover, now fixed)
  const svc = isHome(targetId) ? "bgp-redshift" : `bgp-redshift-${targetId}`   // OM-side service name
  return `${svc}.${db}.${schema}.${table}`      // the platform side redshift.<db>.<schema>.<table> inserts the target segment in the same position
}
// 🔴 The same decision entails three key shapes that must agree (otherwise twin targets in the same region merge records / collide on names):
//   ① FQN / OM service name = the expression above (with targetId)
//   ② audit shard key = `audit#<targetId>#<yyyy-mm-dd>` (**not** `audit#<region>#…` — twin targets in the same region would merge into one record)
//   ③ ownership key of regional results / audit storage = targetId
//   ⚠️ If the final decision is "only one target per region" (section 6.5, pending), the three can degrade to the region value;
//      but **default to targetId**, because section 1.1 already allows several targets in one region (blue/green / primary-standby / migration coexisting).
// 🔴 bareKey / fqnVariants redefined: the normalization hack that strips the service segment must be rewritten for [with target segment], otherwise the bridge between the two conventions breaks
// 🔴 End-to-end invariant (the design document, sections 20.3 / 20.6-E): scan→findings→classification→masking — the target must agree across all four hops;
//    on mismatch [fail-closed for sensitivity levels L3/L4] (masking is currently fail-open: on exception it returns the raw rows = silently leaked PII)
// 🔴 Authoritative masking layer = the server side in the region where the data lives (cross-jurisdiction must mask on the regional side); central masking only for home / the same jurisdiction; browser-side masking = last resort
// 🔴 Grants per target: keys contain targetId; approvals carry the target; existing grants are split per target (not auto-copied to every target = that would recreate over-privilege)
```

### 3.11 Consumption surface — cookbook context injection / advisor target pass-through

```text
// 🔴 cookbook (the design document, section 20.6-D, resolving the doctrine conflict): at **generation time** the platform substitutes targetId → the real workgroup/schema/bucket names
//    into the recipe template before handing it to the LLM / the artifact ⇒ the artifact still contains [real values, no <placeholders>] (the "real values, no placeholders" doctrine of the fissure-B fix is not broken)
renderRecipe(recipe, {targetId, projectId}) → text with the real values already substituted
// codegen prompt: "schema/workgroup are injected by the platform; do not hard-code bgp-workgroup/dev; do not GRANT PUBLIC"
// the compiled core-dist copy follows core-prebuild [change the source + redistribute]
// 🔴 network-advisor / param-advisor: req.targetId passes through to probe/apply; the client goes through getClient(svc, regionOf(target));
//    apply hits [the region of the target in question] (today apply.ts:56 runs ModifyVpcAttribute/CreateVpcEndpoint on the home VPC = changes the wrong region)
//    changing infrastructure across targets must pass RBAC×target (section 3.12)
// GenBI retrieval: business definitions / skills / OM descriptions are filtered by [the target in question]; DataApi definitions + api-keys carry a target scope (on anonymous paths the target is derived from the key/definition; headers are not trusted)
```

### 3.12 Operations surface — RBAC×target / per-target alerting / cross-target reclamation on project deletion / per-target offlining

```text
// 🔴 RBAC×target (phase one; the deferral to phase two is cancelled): authorization axes project × env × [target];
//    🔴 Revision 3.22 landed form (with the cross-jurisdiction target go-live work): the **project allowlist** `access` (section 1.1; general, settable on any target, default all-projects, **no special-casing for cross-jurisdiction**),
//    the single-author check accessAllows(t, projectId) serves both list filtering and write validation (presentation = authorization);
//    "regional administrator role / guard.ts requireTarget(min, targetId)" → a later work item; the former wording "forbid indiscriminate push-down to arbitrary cross-jurisdiction targets" is void (no legal gate is set)
// 🔴 Alerts bucketed per target (today evaluate.ts:124 win#<bucket> blends runs across targets into one number = a stalled region gets averaged away):
//    rule.scope += targetId; success-rate / no-run [bucketed per target]; event.trigger carries targetId;
//    baseline learning pooled per target (the key gains target); incidents with the same signature [do not merge across targets]
// 🔴 Cross-target reclamation on project deletion: deleteProject → per target (including cross-jurisdiction) DROP proj_<id> schema/role/secret
//    (using the class-③ credentials of section 3.9) + precheck bindings=0 + leave a trace (right to be forgotten)
// ✅ Revision 3.26 landed (the per-region MWAA work): offline a DAG per target — offlineDag(dagId, targetId=tgt_home) goes through the MWAA endpoint resolver of section 3.14,
//    deletes the DAG bucket files of **that region** + pauses **that region's** MWAA (the former mwaa-offline.ts deleted only the home bucket / paused home = orphaned schedules on non-home; fixed at the root)
// 🔴 Notification content: run error text for cross-jurisdiction targets is [redacted] or routed through the target's own channel (does not leave the jurisdiction via home SES)
// 🔴 Cross-target dependency fan-out: downstream multi-target twins default to "same target first"; cross-target dependency [edges] are still out of phase one (section 9)
```

### 3.13 Differentiator — one-screen read-only cross-geography metadata overview

```text
// A central read-only mirror of each region's metadata, per target (AWS has no global catalog, so it must be self-built; RAM does not cross regions)
async function mirrorMetadata(targetId, {sources}) {          // scheduled (glue only) + manual (may include redshift)
  const meta = await pullReadOnly(targetId, sources)          // pull metadata only, no rows
  await mirror.upsert(meta)                                   // pk=mirror#<targetId>, sk=<kind>#<fqn>
  await mirror.deleteUnseen(targetId, sources)                // 🔴 see below [deleted tables must disappear]
  await mirror.putFacet(targetId, {sources: reports, mirroredAt, ttl: now()+7d})
}
// 🔴 Boundary: moves [metadata] only, zero data egress; the mirror is [eventually consistent] — the UI shows mirroredAt/state explicitly;
//    a table deleted on the target side → the mirror entry lapses in the next round (with TTL, no long-term residue); opening a region's data still goes through that region's data plane (section 3.2)
// Presentation: data map / lineage / asset inventory "all-target overview" (faceted by target); data referenced across targets is tagged [read-only + type marker]
```

🔴 **Six rules fixed when revision 3.18 landed (each corresponds to something that "looks normal")**:

| # | Decision | Why (what happens otherwise) |
|---|---|---|
| ① **Collection sources** | **Glue Data Catalog (refreshed on a schedule)** + **the Redshift warehouse catalog (🔴 collected only when a person clicks)**. The **LF / OM** named in the original text are **not sources** | Lake Formation permissions are not yet per-target (axis C, a later construction batch), and OM is **a single central instance that ingests home only** ⇒ "pull from OM per target" is meaningless in this platform's topology. 🔴 **Not collecting the warehouse catalog on a schedule is a cost decision**: Redshift Serverless pauses when idle, and firing one `SVV_*` query at every region every 30 min would keep every region's warehouse **awake permanently** — a read-only dashboard must not generate a standing warehouse bill |
| ② **What `kind` is actually written** | Only `db` / `table` are written; **column names travel in the table entry's payload** (`columns:[{name,type}]`); `column` / `lineage-edge` **remain reserved** in the key space | Splitting columns into separate items would raise one refresh from ~10² to ~10⁴ writes (500 tables × 20 columns), and the read side never once needs "query by column"; as for `lineage-edge`, **the platform's lineage edges have no target dimension at all** (one central table; same-named tables in two regions share one edge = a pending axis-B item of section 4 for a later construction batch) ⇒ **do not fabricate** per-region lineage counts; the facet shows "Not collected" + the reason, as is |
| ③ **The facet index lives in a separate partition** | The summary goes to `pk="mirror#__facets"`, `sk=targetId` (entries stay at `pk="mirror#<targetId>"` as the contract says) | The one-screen overview needs "the facets of all targets"; if facets were also partitioned per target, the only way to discover a target that "has a mirror but is no longer active" would be to **Scan the whole table**, and a Scan's Filter is applied **after the read** = every page open reads thousands of table entries and pays for them. `__facets` is not a legal targetId ⇒ it can never collide with a real partition |
| ④ **Deleted tables disappear on the spot** | After one successful collection, entries from **the same source** not seen in this round are deleted immediately, without waiting for the 7-day TTL. 🔴 Delete only for **the sources actually collected in this round** | Waiting for the TTL = "that region's table was deleted long ago and the overview still lists it" = a false green in reverse; and without the source restriction, the glue-only scheduled refresh would wipe the **manually collected warehouse-catalog entries** every 30 min (visible in the UI as the warehouse catalog inexplicably vanishing) |
| ⑤ **`stale` is upgraded to five states** | `fresh` / `stale` (over the threshold) / `expired` (**the read side evaluates `ttl` itself**) / `never` (never succeeded) / `failed` (data still fresh but the latest collection failed). Threshold = 3 × the refresh cadence | 🔴 DynamoDB TTL deletion **lags by up to 48 h**, and expired items are still returned by Query ⇒ trusting "the item is still there" would paint a half-vanished mirror as a green light. The threshold is 3× because hugging the cadence would make a healthy environment flash ⚠ constantly (crying wolf ⇒ users learn to ignore it) |
| ⑥ **Partial failures must not be swallowed by the totals** | Record `{ok, at, attemptedAt, error, counts}` per source; on failure **keep the previous successful `at` and counts** | One network hiccup turning "collected 3 minutes ago" into "never synced" makes users believe the feature is broken; and showing "assets 0" is more dangerous than showing an error — on screen, 0 looks like "this region is clean" |

---

### 3.14 🆕 Revision 3.26: in-region scheduling — every execution environment has its own MWAA (the per-region MWAA scheduling work; the design document, section 18, decision 6sexies)

> Decided on 2026-09-06: "Every region's scheduled tasks are executed by that region's own MWAA; cross-region scheduling is not allowed." Corollary A: scheduling / orchestration artifacts land, per target, on **that target's own MWAA**; B: a non-home target without MWAA **cannot be given a schedule**, and the refusal must lead the person to the install entry point; C: cost is not a design constraint (the wizard shows it truthfully).

```text
// ── Component ─────────────────────────────────────────────────────────────────
// The `mwaa` component stack BgpExecEnv-<slug>-mwaa (depends on base + core):
//   DAG bucket resourceName("dagBucket") [versioned (required by MWAA) / SSE-S3 / public access blocked / TLS / RETAIN without autoDelete]
//   Airflow environment resourceName("mwaaEnvName") [2.10.3 / mw1.small / dags/ / PUBLIC_ONLY; base VPC private subnets ×2 + self-referencing SG; RETAIN]
//   Execution role resourceName("mwaaRole") [🆕 kind; trusts airflow + airflow-env, each with aws:SourceAccount; every policy is a boundStatement bound to this region:
//     PublishMetrics / S3 read-only on this DAG bucket / logs airflow-<env>-* / sqs airflow-celery-* / kms via sqs / glue Start·Get /
//     emr-serverless Get·Start·StartJobRun·GetJobRun·Cancel + iam:PassRole **only to this target's EMR role** / redshift-data + GetCredentials /
//     secretsmanager redshift!* and bgp/project/<slug>/* of this region]
//   Outputs = descriptor field names: dagBucket / mwaaEnvName (the component↔resource pairing of section 1.1 is unchanged)
// 🔴 Control-plane write-back = the **only** cross-region exception (section 1.1, a single control plane; the design document, section 6.3, "direct DDB writes to the control plane go through IAM"):
//   dynamodb:GetItem/Query/PutItem/UpdateItem on arn:aws:dynamodb:<homeRegion>:<acct>:table/bgp-*   // the ARN carries the region itself, no *
//   kms:Decrypt/GenerateDataKey/DescribeKey on * [conditions kms:ViaService=dynamodb.<homeRegion>.amazonaws.com ∧ kms:ResourceAliases=alias/bgp-data ∧ aws:RequestedRegion=<homeRegion>]
//   <homeRegion> comes from 🆕 -c exec-env-home-region (the buildspec passes CodeBuild's own $AWS_REGION = the control-plane region; required only when mwaa ∈ components; missing ⇒ synth throws)
//   synth-gate has a dedicated check for the mwaa role: apart from this one kms statement, which may use RequestedRegion=home, every other * statement must equal this region.
// Platform TaskRole: airflow:CreateCliToken/CreateWebLoginToken/GetEnvironment/InvokeRestApi on environment/bgp-mwaa-* + role/bgp-mwaa-*/Admin (axis execution).

// ── Platform-side single author lib/scheduler/mwaa-endpoint.ts ────────────────
interface MwaaEndpoint { targetId; region; envName; dagBucket; home: boolean }
homeMwaaEndpoint()                       // synchronous; env MWAA_ENV_NAME / MWAA_DAG_BUCKET / AWS_REGION — the only entry point that keeps home byte-identical
mwaaEndpointFor(targetId)                // home ⇒ the above; non-home ⇒ descriptor components ∋ mwaa ∧ resources.dagBucket ∧ resources.mwaaEnvName; missing ⇒ throw MwaaNotInstalled
requireMwaaForTargets(targets)           // checks all of them at once and lists every missing one together (principle B6); missing ⇒ throw MwaaNotInstalled{ missing:[{targetId, region, displayName}] }
mwaaErrorResponse(e)                     // 409 apiError code=MWAA_NOT_INSTALLED, detail {missing, fix:{label, href}}
mwaaCli(ep, cmd) / unpauseWhenLoaded(ep, dagIds)   // CreateCliToken in ep.region; the 4 copies of the unpause polling loop are collapsed into 1
offlineDag(dagId, targetId = tgt_home)   // section 3.12: pause that region's environment + delete that region's bucket files
// 🔴 The literals MWAA_ENV_NAME / MWAA_DAG_BUCKET **may appear only in this file** (pinned by a grep in the mwaa-wiring-guard unit test); the other 14 consumers all go through the resolver.

// ── Routing rules (the dag_id convention of section 5.2 is unchanged: home = the base name; non-home = <base>__<targetId>) ────────────
publishFanout / publishEmrFanout: requireMwaaForTargets(targets) first, before any S3 write ⇒ **zero side effects** when MWAA is missing;
  per target: DAG text EXEC_REGION = that region / CTRL_REGION = home; write to ep.dagBucket (s3ClientFor(ep.region)); ledger deployments[targetId]; unpause via ep.
EMR engine scheduling per target (absorbing the EMR scheduling work): resolveEmrBinding → network facts → script / jar into that region's bucket → application (applicationIdByTarget) → DAG (EXEC_ROLE = this target's EMR role) → that region's bucket.
Offlining offlineFanout / offlineEmrFanout: coverage = bindings ∪ ledger (section 5.2, "unbind ≠ offline"), offlineDag(dagId, targetId) per target.
workflow (bgp-workflows has no targets yet, still a home executor): publish / schedule-enable / trigger / status / logs all go through homeMwaaEndpoint(); the target dimension → a later work item.
```

### 3.14bis 🔴🔴 Revision 3.45: classic MWAA **deployment stopped entirely (including home)** (decided on 2026-09-14)

The decision as recorded: "If MWAA Serverless has been tested and is reasonably stable, we can consider removing the deployed version of MWAA — first remove it from the deployment,
and afterwards neither initialization nor execution-region creation should include this MWAA; everything goes through MWAA Serverless, because deployment is very efficient. The usage is about the same too."

The move of all scheduling to MWAA Serverless (decided on 2026-09-11) had already marked classic MWAA on the **execution-environment side** as `RETIRED` (no new installs; the type still recognizes existing ones). This clause goes one step further:

| Surface | Change | Why |
|---|---|---|
| **Deployment** | Step 7 of `deploy-all.sh` is **skipped** by default; `infra/bin/app.ts` instantiates `MwaaStack` only with **`-c classic-mwaa=1`** (switched on by `DEPLOY_CLASSIC_MWAA=1`) | Classic MWAA is an **always-on** environment (≈$350/month, ~30 min to build the stack — the longest step of the entire deployment chain); serverless bills per task-second and builds its stack in minutes |
| **Home descriptor** | 🔴 `"mwaa"` in `seed-home.ts` changes from **hard-coded** to **claimed only when detected** (`GetEnvironment`, the same shape as dms / flink / agentcore); `resources.mwaaEnvName` is gated the same way | Hard-coded = **the descriptor lies** once home no longer installs it ⇒ scheduler routing picks classic MWAA and calls `CreateCliToken` with a non-existent environment name ⇒ scheduling breaks as a whole, with a symptom far removed from "one stack fewer deployed" |
| **`resources.dagBucket`** | **Always claimed** (not gated) | It is created by the **platform stack**; neither classic nor serverless owns it |
| **Stack class** | 🔴 `infra/lib/mwaa-stack.ts` is **kept** | The one already created in existing accounts must remain claimable and deletable by CFN; deleting the class would orphan it (the same discipline as marking the component `RETIRED` instead of removing it from the legal set) |

**Acceptance checks**: the three in `seed-home.test.ts` (gated by facts / both shapes pass the whole-package validation of section 3.1a / the deployment side does not deploy it by default + infra has the context gate + the stack class must not be deleted); all 4 mutations go red.

⚠️ **Consequence**: the acceptance-gate segment for classic MWAA (nine checks) verifies the behavior of **an existing installed environment**, and a fresh account no longer has a carrier for it ⇒ recorded as a known no-carrier condition in the acceptance criteria.

### 3.14ter 🔴🔴 Revision 3.46: the cross-region private path **changes design**: cross-region peering + a "same-region" interface endpoint on the home side + a PHZ (decided on 2026-09-14 from live measurements)

**Background**: in the zero-egress base of the network work, a non-home VPC would create a **cross-region** DynamoDB interface endpoint (`XEpDynamodb`) + a private hosted zone
(`XZoneDynamodb`) to carry **the only** cross-region call — the run-ledger write-back to the home region (section 3.14).
Live measurement: this path **cannot be built** in this account (nor in the two earlier temporary test accounts):

```text
BgpExecEnv-tgt-usw2-a-base  CREATE_FAILED → ROLLBACK   only one resource is the root failure
LogicalResourceId : XEpDynamodb            (X prefix = cross-region)
Reason            : cdk-hnb659fds-cfn-exec-role-…-us-west-2 not authorized to perform
                    ec2:CreateVpcEndpoint  **because no identity-based policy allows
                    the `vpce:AllowMultiRegion` action**   (403 AccessDenied)
```

🔴 **This is a block at the organization SCP layer and cannot be lifted inside the account** (hard evidence from the IAM policy simulator):

| Principal / action | Verdict | Allowed by the organization |
|---|---|---|
| The role's attached `AdministratorAccess` (`Action:"*"`) | — | — |
| `vpce:AllowMultiRegion` | **implicitDeny** | **False** |
| `ec2:CreateVpcEndpoint` | allowed | True |

The same simulator allows **every other cross-region means**: `ec2:CreateVpcPeeringConnection` / `AcceptVpcPeeringConnection` /
`CreateTransitGateway` / `CreateTransitGatewayPeeringAttachment` / `dynamodb:CreateGlobalTable` /
`events:PutRule` / `events:PutTargets` / `s3:PutBucketReplication` — **only `vpce:AllowMultiRegion` is blocked**.

#### Decided form (confirmed by measurement, see the table below)

| Piece | Where | Why |
|---|---|---|
| DynamoDB **interface endpoint** | **Home VPC**, `com.amazonaws.<homeRegion>.dynamodb`, **same region** | Same region ⇒ does not touch `vpce:AllowMultiRegion`. All non-home regions **share this one** |
| 🔴 `privateDnsEnabled` on that endpoint | **`false`** | Enabled, it would hijack **home's own in-region** DynamoDB traffic from the **free gateway endpoint** onto the **hourly billed interface endpoint**. Only the PHZ on the non-home side points to it |
| **Cross-region VPC peering** | Each non-home VPC ←→ the home VPC (+ route-table entries on both sides) | Allowed by the SCP; no hourly charge (only cross-region data-transfer charges) |
| **PHZ** | In the non-home VPC, `dynamodb.<homeRegion>.amazonaws.com` → the private IPs of that endpoint's ENIs | ⇒ **not one character of platform code changes** (the SDK keeps using the default domain name) |

#### Measured evidence (2026-09-14, a one-off probe: one throwaway VPC in each of two regions + a zero-egress Lambda)

| | The default name `dynamodb.us-east-1.amazonaws.com` resolves to | Writing a us-east-1 table via the **default name** |
|---|---|---|
| Peering + home-side same-region endpoint built, **PHZ not yet added** | a public AWS address | **TimeoutError** ⇒ hard evidence: the subnet **really has zero egress** (it is not getting through via NAT) |
| **After adding the PHZ** | the private addresses `10.91.2.219 / 10.91.1.35` (the endpoint ENIs) | **PutItem succeeds** ⇒ usable with **zero changes on the application side** |

Also: with **the endpoint-specific name** (`vpce-…-…dynamodb.<region>.vpce.amazonaws.com`) writes succeeded even before the PHZ was added
⇒ this independently confirmed the least certain premise of this design: **an interface endpoint can be reached across a cross-region peering** (AWS has historically documented restrictions here;
this does not rely on memory — a real write is the criterion).

#### Relation to existing clauses

- Section 3.14 "control-plane write-back = the only cross-region exception" is **unchanged**: there is still exactly one cross-region call; only **the network piece that carries it** has changed;
- Zero egress (`natGateways: 0` / zero EIPs / no default route) is **unchanged**, and the first row of the table above is its positive evidence;
- The `crossRegion` semantics of the pure endpoint-plan function `endpointPlanFor()` change to "**whether to build peering + PHZ**";
  it no longer yields a "cross-region endpoint" resource; the `CROSS_REGION_ENDPOINTS` constant is renamed / redefined accordingly.

#### 🔴🔴 Revision 3.47, a **premise** discovered during construction: the execution-environment VPC must change its address range (otherwise the peering physically cannot be built)

**The decision above missed one premise, and it had been sitting in a code comment of the network work for six days**: VPC peering **strictly requires the two CIDRs not to overlap**, whereas

| | Address range | Source |
|---|---|---|
| Home-region VPC (`BgpVpcStack/BgpVpc`) | `10.0.0.0/16` | `vpc-stack.ts` gives no `ipAddresses` ⇒ **the CDK default** |
| Execution-environment VPC (`base-stack.ts`) | `10.0.0.0/16` | Same: none given either ⇒ **the same default** |

⇒ The two sides are bit-for-bit identical, and `CreateVpcPeeringConnection` refuses outright. The one-off probe used two throwaway VPCs
(`10.90.0.0/16` / `10.91.0.0/16`) ⇒ **what the probe confirmed is "this path works", not "our base can take this path"**.

**Decision (revision 3.47)**:

| Clause | Content |
|---|---|
| **Address pool** | An execution-environment VPC takes one **/16** from `10.128.0.0/9` (that is, `10.128.0.0/16` … `10.255.0.0/16`, 128 slots in total). Single author `infra/lib/exec-env/vpc-cidr.ts` (the platform-side file of the same name is pinned by the parity gate) |
| 🔴 **Why this pool** | It is **disjoint from the home region's `10.0.0.0/16` by construction** — the legal value range simply contains no address that could collide (the change-safety rule "make illegal states unrepresentable"), rather than "check for a collision at runtime". Hence the home-side SG ingress rule can be **one static rule** (the whole pool on 443) that never changes as targets come and go |
| **/16 only** | Changing the mask width changes every subnet's `CidrBlock` ⇒ **the subnets get replaced** (forbidden: subnets must never be replaced). Changing only the second octet ⇒ for any value in the pool the subnet layout is byte-for-byte the same shape (the private subnets are still the 3rd and 4th /24) |
| **Who allocates** | `registerTarget` takes the **lowest free slot** from "all values in use" **at the moment of registration** and writes it into the descriptor as `vpcCidr` (immutable); the broker only reads the descriptor and passes it through as `-c exec-env-vpc-cidr=` |
| **Home exception** | Home's execution-environment stack group keeps the existing `10.0.0.0/16` (`HOME_EXEC_ENV_VPC_CIDR`) — it does not peer with itself; behavior is byte-identical |
| 🔴 **No silent default allowed** | `ExecEnvContext.vpcCidr` is **required**; a non-home without it makes `cdk synth` throw on the spot. Leaving a "use 10.0.0.0/16 if not passed" fallback would produce the symptom **deployment all green, peering creation failed, ledger write-back silently timing out** |
| **Guard for existing stacks** | When the base stack already exists, the buildspec compares the live VPC's `CidrBlock` with the descriptor's `vpcCidr` and **fails fast** on mismatch (changing the range = replacing every subnet) |
| ⚠️ **Known narrow window** | Two **concurrent** registrations may compute the same range (the conditional write protects only the uniqueness of `sk`). Deliberately **no** extra CIDR index table is opened for it (one more lifecycle that would have to be deleted cleanly) ⇒ the backstop is a **loud failure at the physical layer**: the home-side return route `CreateRoute` hits `RouteAlreadyExists`, and the custom resource **names** the conflicting pcx and rolls the whole stack back |

#### Revision 3.47: the contract on the home-region side (who provides what)

| Provider | Output | Consumer |
|---|---|---|
| `BgpVpcStack` (platform stack) | `XregionDdbEndpoint` (same-region interface endpoint, **`privateDnsEnabled: false`**) + `XregionDdbEndpointSg` (allows only **the whole pool** on 443) | Shared by all non-home regions |
| Same | Outputs `VpcId` / **`VpcCidr`** / **`XregionDdbEndpointId`** | Read by the deployment buildspec and passed to the non-home stack group via `-c exec-env-home-vpc-id / -home-vpc-cidr / -home-ddb-endpoint-id` |
| 🔴 Why Outputs rather than CFN Exports | **`Fn::ImportValue` does not work across regions**; and running `describe-vpcs` on the non-home side to guess "the VPC that looks like the home region's" = yet another source of drift (pick the wrong one and the peering is built to somebody else's VPC) |  |
| ⚠️ When the home region uses an **imported existing VPC** | The platform deliberately does not touch somebody else's VPC ⇒ there is **no** such endpoint ⇒ the buildspec fails fast and states plainly "this account does not support non-home execution environments for now" |  |

**The three inputs are bundled into one object** (`ctx.homeLink`): either all three are present, or the object is absent altogether. With three individually optional fields, "only two of them" is expressible in the type,
and that state deploys as "peering built, return route not added" = requests go out, responses never come back.

#### Revision 3.47: the `HomeLink` custom resource (the only code that **modifies home-region route tables**)

`infra/lambda/xregion-peering/index.mjs`, instantiated by the non-home base stack (the Lambda runs in the non-home region, all EC2 calls go to home;
IAM is narrowed with `aws:RequestedRegion = <homeRegion>`).

| Lifecycle | Action |
|---|---|
| Create / Update | ① `pending-acceptance` ⇒ **accept** (a cross-region peering is **not** auto-accepted by CFN even within the same account) → poll until `active` (5-minute cap; the terminal states rejected/failed throw immediately with the note "do not retry this same one"); ② add the return routes in **two phases**: first verify **all** relevant route tables, then create them together — verifying and creating as you go would leave **half a set of routes** if the conflict shows up on the second table (one AZ reachable, the other not = intermittent failures); ③ read back the private IPs of the endpoint ENIs (returned sorted; order jitter = meaningless changesets) |
| Delete | Delete only routes whose "destination = **this environment's** range **and** next hop = **this** peering" (both conditions required, otherwise it would delete somebody else's); failing to read anything **must not** fail the deletion (a stack that cannot be deleted is worse than leaving one blackhole route) |
| 🔴 Why it must be a custom resource | All three actions can only be done on the home side, while home's route tables belong to **another stack in another region**, and the return routes are **per target** (the platform stack cannot enumerate in advance which execution environments will be built). Doing it in the buildspec has the fatal flaw that it **cannot be undone**: after an environment is retired a blackhole route remains, and the next environment allocated the same range hits `RouteAlreadyExists` |
| **How the relevant route tables are determined** | The route tables associated with the subnets of the endpoint ENIs; a subnet **without an explicit association** counts as the VPC's **main** route table (missing it = return packets have no route, and the symptom is "the request went out and never gets a response" rather than an error) |

#### Revision 3.47: descriptor fields and resource keys (change list)

| Field | Change |
|---|---|
| Top-level `vpcCidr` | 🆕 Allocated at registration, immutable; a non-home descriptor without it = created before the address-pool change ⇒ **the broker refuses before starting the build** (the refusal says "re-register", not "retry") |
| `resources.homeLinkPeeringId` | 🆕 Replaces `resources.crossRegionDdbEndpointId` (the latter is **retired**: that shape is blocked dead by the organization SCP; keeping it = having the probe judge red against a shape that cannot be built) |
| `resources.homeLinkHostedZoneId` | Unchanged |
| `resources.vpcCidr` / `resources.endpointIds` | **Network observation** keys of the base stack: written when read, missing does not count as a contract breach; the supplementary deployment channel allows **additions only** (they are not routing inputs and are read only by the probe) |
| 🔴🔴 **A real "written but never wired" defect (fixed in the same batch)** | The network work made the base stack output `endpointIds` / `homeLinkHostedZoneId`, and the probe wrote two checks against them, but `finalizeTargetResources` assembled the resource bag from a **hard-coded key list** that never included them ⇒ `res.endpointIds` was always `undefined` ⇒ the rollout gate `switchedToZeroEgress` was **always false** ⇒ the two checks `network:egress-none` / `network:home-link` **never ran** (while each side was correct on its own, and unit tests and gates were all green) |

#### Revision 3.47: two existing statements corrected

1. **The home side has no DynamoDB gateway endpoint at all** — `vpc-stack.ts` creates only an S3 gateway endpoint (verified in a real environment: the home VPC has only the `s3` Gateway + one Interface endpoint).
   So "with privateDns enabled, home traffic would be hijacked away from the **gateway endpoint**" is corrected to "hijacked from the **public path** onto the **billed interface endpoint**";
   the acceptance check is adjusted accordingly (it must no longer assert "home still uses the free gateway endpoint" — that shape simply does not exist; see the home-side endpoint item of the acceptance criteria).
2. The special grant for `vpce:AllowMultiRegion` **has been removed from `platform-stack.ts`**. Keeping a grant that the organization layer will always deny
   = making the next person believe "the permission is already granted, the error is somewhere else" — which is exactly why it hung for three days without being seen through.

### 3.15 🆕 Revision 3.27 Serverless scheduling endpoint — component `airflow-serverless` (the serverless-scheduling work package; [the design document](./multi-region-execution-design.md), section 18, decision 6septies)

> Decided on 2026-09-06: "Keep the existing MWAA for now, add an MWAA Serverless entry point, and only after scheduling works end to end in every region consider removing the existing MWAA." Guiding principle: "as serverless as possible at the service layer". Section 3.14 is unchanged word for word; this section only adds.

```text
// ── Component stack BgpExecEnv-<slug>-airflow-serverless (depends on base + core; minute-scale start-up, zero always-on resources) ────────────────
//   Definition / code bucket resourceName("workflowBucket") = bgp-airflow-sls-<acct>-<slug> [versioned (the service snapshots by VersionId) / SSE-S3 / block public access / TLS / RETAIN;
//     🔴 must be in the same region as the workflow (a cross-region bucket returns 301); a brand-new bucket may return 307 for several hours ⇒ create it when the component is installed and back off exponentially on 307 at publish time, ≤ 5 min]
//   🔴 Revision 3.32 (the orphan-workflow fix) offline semantics: StopWorkflowRun **→ poll until no STARTING/QUEUED/RUNNING/STOPPING remains** → DeleteWorkflow (retry on conflict with back-off, 5 attempts);
//     a timeout must never be treated as "already offline" (throw). **A failed offline does not clear the ledger**; the route reports 502 and `scheduleEnabled` keeps its previous value — the state must stay consistent with "the workflow is still running".
//   🔴 Revision 3.31 (the run-key and trigger-source findings) ledger and trigger source:
//     · Ledger row key = `(taskId, runId)`, where **runId = `<service-side per-run dag_id>#<targetId>`** (`AIRFLOW_CTX_DAG_ID` = `ex_<uuid>`, unique for every run);
//       also stored: `taskTargetKey = <taskId>#<targetId>`, `workflowArn`, `airflowRunId` (for troubleshooting). Sole author of the rule = `lib/monitor/run-key.ts`.
//       🔴 **Never use the Airflow `run_id` as the key**: under MWAA Serverless it degenerates into a constant (two different runs were both observed as `scheduled__<the same logical_date>`).
//     · **If the ledger cannot be written, refuse**: any put_item failure throws so that this run shows red (swallowing it = the task reports success while this run does not exist on the dashboard).
//     · The runtime **does not write runType**; the trigger source (SCHEDULED / ON_DEMAND) is taken only from the service-side `GetWorkflowRun.RunType` and shown in the run-log dialog.
//   🔴 Revision 3.30 (the code-package finding): the runtime **Code package = a zip with the module `bgp_runtime.py` at the root** (key `code/bgp_runtime-<content hash>.zip`, ContentType application/zip; sole packaging author `lib/scheduler/serverless/code-package.ts`; zip header timestamps are fixed ⇒ same content, same bytes, and the versioned bucket does not pile up meaningless versions).
//   Worker SG resources.airflowServerlessSgId [name resourceName("airflowServerlessSg") = bgp-airflow-sls-sg-<slug>; self-referencing inbound all + egress all (service requirement)]; subnets = core privateSubnetIds (the NAT lives in base)
//   Execution role resourceName("airflowServerlessRole") = BgpExecEnv-<slug>-airflow-sls-role [🆕 kind; trusts airflow-serverless.amazonaws.com;
//     every policy statement is a boundStatement bound to this region: logs / S3 (this bucket + scripts + datalake) / redshift-data + GetCredentials / secrets redshift!* of this region /
//     glue StartJobRun·GetJobRun·GetJob·CreateJob·UpdateJob (job/bgp-*; GlueJobOperator uses the idempotent CreateJob) / emr-serverless Get·Start·StartJobRun·GetJobRun·Cancel /
//     iam:PassRole only to this target's emr + glue roles]
//   Control-plane write-back = exactly the same single cross-region exception as in section 3.14 (home bgp-* tables + kms via dynamodb.<home>)
//   Outputs = descriptor field names: workflowBucket / airflowServerlessRoleArn / airflowServerlessSgId
//   home: platform stack BgpAirflowServerlessStack (deploy-all step 6.6); seed-home recognizes it as an installed component
// Platform TaskRole (execution axis):
//   🔴 Revision 3.29 (found in a real environment on 2026-09-07): airflow-serverless:CreateWorkflow gets a statement of its own with **Resource "*"** (execution axis; aws:RequestedRegion blocks lateral movement)
//     [this action **does not support resource-level permissions**: the service reports "on resource: …:workflow/*", so a bgp* qualifier never matches ⇒ AccessDenied; the IAM simulator was observed to deny even the literal workflow/*];
//   the remaining {Update,Delete,Get,List}Workflow(s|Versions) / StartWorkflowRun / StopWorkflowRun / GetWorkflowRun / ListWorkflowRuns / ListTaskInstances /
//     GetTaskInstance / TagResource on …:workflow/bgp* [ARN = workflow/<Name>-<10 random characters>, so the name-prefix qualifier holds];
//   iam:PassRole → BgpExecEnv-*-airflow-sls-role + bgp-airflow-sls-role (iam:PassedToService=airflow-serverless.amazonaws.com);
//   logs:GetLogEvents/DescribeLogStreams/FilterLogEvents on log-group:/aws/mwaa-serverless/* (resource type = log group);
//   🔴 Revision 3.29 (confirmed by CloudTrail): + logs:CreateLogGroup on the same resource — during CreateWorkflow the service creates the default log group /aws/mwaa-serverless/<workflow>/ **as the caller** (invokedBy=airflow-serverless.amazonaws.com);
//     without it the service answers "Access denied to logGroup or KmsKey";
//   🔴 Revision 3.29 (confirmed by CloudTrail): + iam:CreateServiceLinkedRole on role/aws-service-role/airflow-serverless.amazonaws.com/AWSServiceRoleForAmazonMWAAServerless
//     (condition iam:AWSServiceName) — CreateWorkflow calls it **every time** as the caller, even when the SLR already exists (the resulting InvalidInputException is tolerated); without the permission:
//     "Insufficient permissions to create a Service Linked Role". The complete FAS set on the success path = these two calls (no delegated retention / tags / KMS / ec2 / s3 calls).
//   🔴 IAM simulation gate (the structural root fix for the resource-pattern finding): infra/iam/platform-taskrole-calls.json = the manifest of the platform's **real calls** (action × ARN shape as reported by the service × condition context);
//     scripts/iam-simulate-gate.py runs SimulatePrincipalPolicy against the TaskRole after every platform-stack deployment (redeploy-platform.sh step 4) and in the IAM step of the serverless acceptance segment;
//     any entry that is not allowed turns red; the unit test iam-call-manifest.test pins "every XxxCommand the code imports ⇒ the manifest has <service>:Xxx ⇒ platform-stack.ts contains that literal".
//     Missing actions (two earlier findings) and wrong resource patterns (this finding) are thereby exposed within 10 seconds of deployment instead of exploding at dispatch time.

// ── Endpoint resolution still has a single author (lib/scheduler/mwaa-endpoint.ts extended into a discriminated union; the file name is unchanged so the gate keeps working) ──────────
type SchedulerEndpoint =
  | ({ kind: "mwaa" } & MwaaEndpoint)
  | { kind: "serverless"; targetId; region; workflowBucket; roleArn; subnetIds; sgIds; home: boolean };
schedulerEndpointFor(targetId, prefer?)   // both installed ⇒ prefer ?? descriptor schedulerPreference ?? "serverless"; only one installed ⇒ that one; neither ⇒ throw SchedulerNotInstalled
requireSchedulerForTargets(targets)       // checks all targets at once; any missing ⇒ 409 SCHEDULER_NOT_INSTALLED { missing[], options, fix }

// ── Artifacts and lifecycle (dag_id rule as in section 5.2: home uses the base name; non-home <base>__<targetId>; workflow Name = dag_id) ────
Definition = dag-factory YAML (lib/scheduler/serverless/yaml-generator.ts): tasks = PythonOperator bgp_runtime.run_job + op_kwargs{job spec JSON};
  schedule = cron; start_date = generation day + 1 (the service validates "must be in the future"); default_args.execution_timeout ≤ 3600, retries ≤ 3; a single file < 50KB (larger ⇒ refuse to publish + plain-language message);
  🔴 no on_*_callback / trigger_rule / ExternalTaskSensor / Branch / Empty (unsupported or ignored by the service) — the ledger write-back happens inside the task body (same table and attributes as the classic _record).
Code package = bgp_runtime.py (the inline functions of the classic DAG extracted into a module; **both artifacts are generated from the same source**; uses only the pre-installed boto3) zip → s3://<workflowBucket>/code/<runtimeVersion>.zip
Publish = ensureWorkflow: no arn in the ledger ⇒ CreateWorkflow{Name, DefinitionS3Location, Code, RoleArn, 🔴 NetworkConfiguration (subnets + SG, mandatory: the default network cannot reach cross-region endpoints), TriggerMode=scheduled}
      arn present ⇒ UpdateWorkflow (same parameters; every call = a new version, and the old version stops being scheduled automatically); deployments[targetId] = {scheduler:"serverless", workflowArn, workflowVersion, codeVersionId}
Trigger = StartWorkflowRun; offline = StopWorkflowRun for running runs + DeleteWorkflow (quota-friendly; section 3.12 semantics "no further triggers + no leftovers"); status = GetWorkflowRun (RunType SCHEDULED | ON_DEMAND)
Task logs = GetTaskInstance.LogStream → CloudWatch /aws/mwaa-serverless/<full workflow name>/; run row scheduler="serverless"
// ── Quota and timeout rules (checked in us-west-2; all adjustable) ──────────────────────────────────────────────
workflows 100 / 100 concurrent per account / 20 concurrent per workflow / task timeout 60 min / definition 50KB / XCom 100KB; run_job polling > 50 min without a final state ⇒ ledger timeout-pending + plain-language message "raise the quota / split into submit + sensor (phase 2)"
// ── Network profile (top-level field networkProfile of section 1.1; written at registration, changed via POST .../network-profile, which requires that no session is in flight) ────────────────────────────────────────────────────────────────
The execution-environment base stack defaults to 2 NAT gateways = 2 EIPs; the EC2-VPC EIP default quota is 5 per region ⇒ at most 2 execution environments per region. 🆕 networkProfile = "standard" (2 NAT, default) | "economy" (1 NAT) [top-level descriptor field; the broker reads it only from the registry and derives EXEC_ENV_NAT_GATEWAYS → -c exec-env-nat-gateways (context.ts validates 1..3); the preflight endpoint GET /api/admin/exec-envs/preflight?region=&networkProfile= asks two read-only questions (ec2:DescribeAddresses + servicequotas:GetServiceQuota) and does not block when they cannot be read];
wizard step 1 / the "Trigger deployment" action on the details page run a **quota preflight** first (describe-addresses usage + get-service-quota limit ≥ usage + required EIPs; if insufficient ⇒ a page Alert with quota code L-0263D0A3 and the increase command, fail-fast without starting a build);
the failure condenser translates a CFN reason containing "maximum number of addresses" into "insufficient EIP quota".
```

🆕 **Revision 3.43: multi-node orchestration also runs on serverless (the serverless-orchestration work) — the only shape is `tasks`; `external` is rejected at publish time**

> - Decided on 2026-09-11: "Connect all scheduling to the MWAA Serverless version; from now on all scheduling goes through the serverless MWAA. **The regular MWAA will no longer be deployed either.**"
> - 🔴 Every service-side fact below was **actually run** in `tgt_use1_a` on 2026-09-11 (seven CreateWorkflow calls / four successful runs) and **overturns one sentence in the revision 3.27 header above**; the checks are in the headless acceptance segment for serverless workflows.

```text
// ── Service-side facts as measured (every design decision in this section rests on these eight; hard-coding any other assumption = a time bomb) ────────────────────
// F1 `tasks` + per-task `dependencies` **really are supported**: __start → {n1,n2} → __finish, four tasks ran through in one go (fan-out and fan-in both correct).
// F2 🔴 **`trigger_rule` is supported** (the revision 3.27 header's "unsupported or ignored" was wrong; corrected in this section):
//    · `all_done` takes effect as measured — and (dangerously) with one task FAILED the whole run's `RunDetail.RunState` is still **SUCCESS**
//      ⇒ "did this run succeed" **must never be judged from RunState alone**; __finish **must never** be given all_done.
//    · `none_failed_min_one_success` behaves correctly on both sides: upstream skipped ⇒ it still runs (run=SUCCESS); upstream FAILED ⇒ **UPSTREAM_FAILED, AttemptNumber=0** (run=FAILED).
// F3 🔴 **Operators are allow-listed**: `PythonOperator` / `BashOperator` work; `BranchPythonOperator` and `ExternalTaskSensor` are **explicitly rejected** by CreateWorkflow:
//    `Workflow validation failed: Task 'x' 's operator '…' is not supported` — a hard error at **publish time** (not run time, which is a good thing: failing to publish beats running wrong).
//    ⇒ Contract: the generated YAML may contain **only PythonOperator** (every additional operator kind is one more service-side path that can be verified only by a real run).
// F4 per-task `retries` / `retry_delay` take effect (the same node was observed with two attempts n1_1 / n1_2); the service limits remain retries ≤ 3, execution_timeout ≤ 3600.
// F5 By default (no trigger_rule written) an upstream FAILED ⇒ the downstream task is `UPSTREAM_FAILED` and **never runs at all** (AttemptNumber=0).
// F6 🔴 All tasks of one run share the same `ex_<uuid>` (`TaskInstanceId` = `<ex_uuid>_<task_id>_<attempt>`)
//    ⇒ the `runId` computed at the three ledger write points (__start / the failed node / __finish) is necessarily the same (the premise on which the composite run key rests — now **measured**, not inferred).
// F7 🔴 Two pitfalls when reading task status: ① `ListTaskInstances` **does not return TaskId** (only TaskInstanceId, and a task_id may itself contain `_`, so splitting on the separator is wrong),
//    and **old attempts may remain in a non-final state** (n1_1 was observed stuck in QUEUED while n1_2 had already FAILED); ② **a skipped node has state `NONE`, not SKIPPED**,
//    and **downstream nodes skipped by propagation do not appear in the list at all** (n1d had no entry whatsoever).
//    ⇒ Task-level status is taken only from `GetTaskInstance` (which has `TaskId` / `AttemptNumber` / `LogStream` / `Xcom`); a check that expects `SKIPPED` or "reconciles by the number of tasks" produces a false red.
// F8 XCom works across tasks: `ti.xcom_pull(task_ids=...)` retrieves the upstream `return_value` inside the service-side worker (observed br → n1/n2).
//    `AirflowSkipException` also works (a node raising it ⇒ that task records `NONE`, and its downstream tasks are skipped by propagation under the default all_success).

// ── Shape: **only `tasks`** (🔴 the `inline` shape of route A in the earlier roadmap is cancelled) ─────────
// Settled by F2 + F3 + F8: six of the seven node types can be expressed **node by node** in the tasks shape (per-task retries and visibility are fully present); only external has no counterpart.
//   sql / python / sync / setvar / empty → PythonOperator + `bgp_runtime.run_node`
//   join                                → the same (no-op body) + per-task `trigger_rule` (F2)
//   branch                              → **not BranchPythonOperator** (rejected, F3); the platform's own PythonOperator takes over:
//       the branch node body = evaluate the conds and push the matched task_id to XCom as `return_value`;
//       each of its **direct successors** first compares that XCom in its own body and, if it is not the chosen one, does `raise AirflowSkipException` (F8)
//       ⇒ the skip propagates downward naturally along the default all_success (F7: downstream nodes skipped by propagation get no entry at all),
//         and the convergence points (join / __finish) tolerate skips with `none_failed_min_one_success` (F2) — the same pattern as the classic `_status_done`.
//   foreach (static items)              → **expanded at generation time into N tasks** (`<task_id>__i<0..N-1>`): no dynamic task mapping is needed,
//       and it offers per-item visibility the classic path lacks; items given as an XCom key (dynamic lists = phase 2) ⇒ expands to 0 tasks ⇒ the node degenerates into a single no-op task (honest, same as the classic static stage).
//   external                            → 🔴 **honestly rejected at publish time** (registered as a known limitation in the acceptance checklist):
//       ExternalTaskSensor is rejected by the allow-list (F3), and a service-side run **has no logical date** (`RunDetailSummary` only has CreatedOn / StartedAt and
//       `RunId` is a random string) ⇒ impersonating it with "was there a success today" **changes the semantics** and silently gives wrong answers across day boundaries and in backfill scenarios.
//       The rejection must be in plain language with a way out (turn it into upstream and downstream nodes within the same graph; execution environments that already have the classic mwaa installed keep working as before).

// ── Single authors and artifacts ─────────────────────────────────────────────────────────────
// lib/workflow/node-registry.ts 🆕 field `serverless: "task" | "unsupported"`
//   (the node-metadata SSOT is this table; writing a separate ["branch","join","foreach","external"] array = a second definition ⇒ adding an eighth node type is guaranteed to drift).
// 🆕 lib/scheduler/serverless/workflow-yaml.ts (shares toYaml / futureStartDate / MAX_DEFINITION_BYTES with the single-job yaml-generator):
//   assertServerlessExpressible(nodes)  // any node with serverless === "unsupported" ⇒ throw ServerlessNodeUnsupported{ types[] }
//   buildWorkflowTasksYaml({ dagId, cron, env, nodes, edges, now? }): string
//     · tasks = `__start` + one per node (foreach expanded) + `__finish`; dependencies: nodes with no incoming edge = ["__start"], all others = the sources of their incoming edges;
//       `__finish` = all leaves (nodes without outgoing edges), `trigger_rule: none_failed_min_one_success` (F2)
//     · 🔴 **no root (a cycle) ⇒ throw**: otherwise `__start` becomes an orphan and the whole graph waits forever (the service does not report this)
//     · 🔴 per-node `retryCount` / `timeout` are **clamped at generation time** to the service limits (retries 0..3, execution_timeout ≤ 3600):
//       without clamping, what a person sees is CreateWorkflow's ValidationException rather than "the retry count of this node of yours exceeds the limit"
//     · 🔴 op_kwargs **does not repeat the whole spec**: every task carries only `{ env, node }` (env ≈ a few hundred bytes × N);
//       copying the whole spec into every task would make N nodes hit the 50KB limit N times faster
//     · empty cron (a manual workflow) ⇒ no `schedule` written, TriggerMode = manual_only
// 🔴 Reserved task_ids: `__start` / `__finish` join the reserved set of dag-generator-v2 `buildIdMap` (which today holds only `_status_done`),
//   otherwise a node a user names `__start` collides; the foreach `__i<N>` suffix goes through the same uniqueness check.
// 🆕 Node semantics have a **single author**: lib/workflow/node-exec-py.ts exports `NODE_EXEC_PY` (an executor + job lock + ledger primitives that **do not depend on Airflow**):
//   the classic runtime-lib (v6 → **v7**) and the serverless code package `bgp_runtime.py` **both splice in this one copy**;
//   gate: in both artifacts `def _exec_sql(` / `def _exec_sync(` / `def _exec_python_safe(` / `def _eval_cond_safe(` / `def _lock_attr_for(`
//   may each appear **exactly once**, and both artifacts must contain a **byte-identical** `NODE_EXEC_PY` (pinned by a unit test — the lesson of an earlier task whose two copies drifted apart).

// ── Ledger settlement protocol (the substitute for the forbidden callbacks; invariant: exactly one row per run) ───────────────────────
// `__start`        put_item creates the row: status=running, startedAt, runId = `<ex_uuid>#<targetId>` (the composite run-key rule; F6 guarantees the three write points share the key)
//                   + bgp-workflows.lastRunStatus=running
// the failed node  update_item: status=failed, finishedAt, duration, error (truncated to 500) — **written by the node itself, not by a callback**; it throws only after writing
// `__finish`       update_item: status=succeeded, finishedAt, duration
//                   (`none_failed_min_one_success`: when a node FAILED it becomes UPSTREAM_FAILED and never runs ⇒ no false green, measured in F2/F5)
//                   🔴 Added in revision 3.43 step 2: this write must be a **conditional write** (set succeeded only if `status <> failed`) —
//                   when a user sets the rule of some `join` to a permissive one, `__finish` may still run after the failed node has written `failed`,
//                   and an unconditional overwrite would **turn the audit truth green** (the classic side has exactly this flaw; here we deliberately go stricter than classic).
// 🔴 The second and third write points use **update_item, not put_item**: put would wipe the startedAt / stamp written by `__start`.
// 🔴 **If the ledger cannot be written, throw** (the same rule as the run-key finding: swallowing it = the task reports success while this run does not exist on the dashboard).
// 🔴 `target_id` / `project_id` (the stamp) must come from the **place**, not from fields on the row: both workflow generators call
//   `resolveRunStamp(workflow, opts.targetId)` (ETL / EMR have done so for a long time). Otherwise, once `targets[]` and `targetId` diverge,
//   the DAG runs in region A while the ledger is stamped with region B, **the lock attribute name follows the wrong region** (the two executors lock separately), and the composite segment of `runId` is wrong too.
// 🔴 The node-level job lock **keeps the classic rule** (`_lock_attr_for(target_id, original nodeId)`, same table and attribute, mutually exclusive with backfill) —
//   deliberately **no** "workflow-level lock" is introduced: the classic side has none ⇒ the two executors would each lock their own (a lock that adds nothing); and when the service hard-kills a task it would leak for the full 90-min lease.
//   (This **corrects** the earlier roadmap's "`__start` acquires the lock", for the reasons above; `__start` only creates the ledger row.)
// 🔴 The only remaining hole (honestly registered as a known limitation): when a node task is hard-killed by the service (60-min limit / infrastructure) no code of ours is running ⇒ the ledger stays at running
//   (`__finish` is UPSTREAM_FAILED at that point); when a branch skips **all** of its exits, `__finish` is skipped too (same as the classic `_status_done`).
//   Settlement = the presentation layer corrects it using the **service-side `GetWorkflowRun.RunDetail.RunState` as the truth** (reconcile-on-read, the same discipline as "status truth lives on the service side");
//   **no scheduled compensator is added** (that would be another thing to deploy, monitor, and watch break on its own).

// ── Publish / offline / trigger (the serverless branch of publish-dag.ts replaces the `WorkflowSchedulerUnsupported` throw) ────
// publish: **place resolution still comes before generation** (the lesson from the revision 3.41 headless acceptance: generating before resolving ⇒ scheduled in this region while the body referenced home-region resources throughout);
//   artifacts = `dags/<dagId>.yaml` + `code/bgp_runtime-<ver>.zip` written to **that target's** workflowBucket;
//   ensureWorkflow (Name = dagId; TriggerMode = cron present ⇒ scheduled / absent ⇒ manual_only); the ledger deployments[targetId] records scheduler:"serverless" / arn / version.
// 🔴 `publish.ts` gains a "YAML supplied directly" entry (the single-job path is **byte-for-byte unchanged**: it still goes through buildWorkflowYaml).
// 🔴 unpublish (delete workflow): the serverless branch today is `if (isServerlessEndpoint(ep)) return { removed: false }` —
//   an assumption from the era when "serverless had never been published to"; once this section lands it **must be replaced** by offlineServerlessWorkflow
//   (Stop the running run → wait for the final state → DeleteWorkflow + delete the definition object), otherwise we get another batch of **orphan workflows that cannot be deleted** (the orphan-workflow fix already paid this tuition).
// Trigger / status / logs: reuse the existing StartWorkflowRun / GetWorkflowRun / task-logs of section 3.15, reading values with the two F7 pitfalls in mind.

// ── Disposition of the classic mwaa (revision 3.43; **non-destructive**) ────────────────────────────────────────
// **Existing installations stay usable** (the currently deployed tgt_home / tgt_use1_a both have it), but: the wizard and the component list **no longer offer it** · a registration carrying `mwaa` is rejected ·
// the default `schedulerPreference` becomes serverless · the contract text of section 3.14 is kept in full (existing semantics unchanged word for word).
// Deleting an already deployed MWAA environment is a destructive action nobody asked for ⇒ not done (migration / decommissioning would be a separate piece of work).
```

### 3.16 🆕 Revision 3.33 Zero-egress execution-environment network — VPC endpoints + cross-region PrivateLink (the zero-egress networking work package; [the design document](./multi-region-execution-design.md), section 18, decision 6octies)

> Basis: decided on 2026-09-06 ("it definitely has to go through endpoints and private connectivity") + **ten facts measured in a spike on 2026-09-08**.
> The spike overturned the "cross-region VPC peering" of the original design: the home VPC and the three execution-environment VPCs **all use the CIDR `10.0.0.0/16`**
> (neither VPC stack passes `ipAddresses`, so both take the CDK default), and peering strictly requires non-overlapping ranges ⇒ **switch to cross-region interface endpoints** (PrivateLink
> is an ENI inside my own VPC and independent of CIDR).

**A. Three invariants** (pinned one by one by synth-gate section 14; see D)

1. In the execution-environment base stack the **`AWS::EC2::NatGateway` count = 0** and the **`AWS::EC2::EIP` count = 0**;
2. the private subnet type = `PRIVATE_ISOLATED`, and its route table **contains no `0.0.0.0/0` at all**;
3. every call a task makes to an AWS API lands on an endpoint — the **sole author** of the endpoint list = `infra/lib/exec-env/endpoints.ts`.

**B. Endpoint list (determined by the "real boto3 calls at run time", not inferred backwards from IAM policies)**

| Class | Service | Condition | Notes |
|---|---|---|---|
| Gateway (free) | `s3` · `dynamodb` (**this region**) | always created | attached to the private route tables; 🔴 **gateway endpoints do not change DNS** (they work through the route-table prefix list `pl-…`) ⇒ a probe must not conclude "resolves to a private address" (spike finding) |
| Same-region interface (`privateDnsEnabled: true`) | `sts` · `logs` · `monitoring` · `kms` · `secretsmanager` · `glue` · `emr-serverless` · `redshift-data` · `s3tables` · `redshift-serverless` | always created | 🔴 `s3tables` and `redshift-serverless` were added by the spike (missing from the original list) — the former is on the mandatory path of data-lake landing, the latter is really called by the COPY-role discovery logic in `lib/sync/glue-script-generator.ts` (spike finding) |
| Same-region interface | `sqs` · `ecr.api` · `ecr.dkr` · `airflow.api` · `airflow.env` · `airflow.ops` | only when `mwaa` ∈ components | official requirement of classic MWAA |
| Same-region interface | `airflow-serverless` | only when `airflow-serverless` ∈ components | service name = `com.amazonaws.<region>.airflow-serverless` (confirmed by the spike; the earlier open item "endpoint name to be confirmed" is closed) |
| 🔴 **Cross-region interface** | `dynamodb` @ **home region** | always created (non-home targets) | `--service-region <homeRegion>`; private DNS **can only be off** ⇒ must be paired with the private hosted zone of C |
| ~~Cross-region interface `kms` @ home~~ | — | **not created** | spike finding: although the target table is CMK-encrypted, the spike created no cross-region KMS endpoint and the conditional write still succeeded — SSE-KMS calls KMS on the DynamoDB service side, so **the caller needs no network reachability to KMS** |

Endpoint SG: allows only **443 from this VPC's CIDR**; one ENI per AZ.

**C. The only cross-region path = cross-region DynamoDB interface endpoint + private hosted zone (zero product-code change)**

```text
exec-env VPC (us-west-2, zero egress)
  ├─ VPCEndpoint(Interface, com.amazonaws.us-east-1.dynamodb, ServiceRegion=us-east-1, PrivateDnsEnabled=false)
  │    └─ DnsEntries[0] = vpce-<id>-<hash>.dynamodb.us-east-1.vpce.amazonaws.com  (HostedZoneId Z…)
  └─ Route53 PrivateHostedZone "dynamodb.us-east-1.amazonaws.com" (associated with this VPC)
       └─ A record (apex) ALIAS → the DnsEntries[0] above + its HostedZoneId, EvaluateTargetHealth=false
```

- 🔴 **Not a single byte of product code changes**: `boto3.resource("dynamodb", region_name=CTRL_REGION)` keeps using the default FQDN,
  and the private hosted zone resolves it to the endpoint ENI. The spike measured the resolution result = the private address of the endpoint ENI (spike finding).
- **The job-lock semantics are preserved across regions** (spike finding, load-bearing): the conditional write `attribute_not_exists(runId)` succeeds the first time and **the second write with the same key
  must raise `ConditionalCheckFailedException`**. This was the reason **Global Tables were rejected** back then (cross-region eventual consistency would
  break the lock semantics), and it is now confirmed in a real environment ⇒ the ledger table stays **a single table in a single region**, with no replication of any kind.
- Latency figures (measured by the spike, us-east-1 ↔ us-west-2 mirror direction): conditional write 281 ms (including the first TLS handshake),
  strongly consistent read-back 62 ms, conditional rejection 63 ms. A **same-region** endpoint's first call takes 99–525 ms, then on the order of ~100 ms.

**D. 🔴 Pre-authorization (spike finding; decided on 2026-09-08: "grant it only to the CDK cfn-exec role")**

- The cross-region variant of `ec2:CreateVpcEndpoint` additionally requires the caller to be allowed **`vpce:AllowMultiRegion`**, and this action
  **is not matched by wildcards**: `PowerUserAccess` (a `NotAction` wildcard) and `AdministratorAccess` (`Action: "*"`)
  were **both denied** as measured (the message verbatim: no identity-based policy allows the `vpce:AllowMultiRegion` action).
- ⇒ Contract requirement: the **home-side platform stack** adds one `iam.Policy` that attaches `vpce:AllowMultiRegion` (Resource `*`)
  **verbatim** to `cdk-hnb659fds-cfn-exec-role-<account>-<region>` (one per execution region;
  IAM roles are **global** resources, so managing them in one place from home suffices).
  - Ordering: `deploy-all` deploys the platform stack first ⇒ the authorization is in place **before** any execution-environment deployment; `redeploy-platform` likewise.
  - **Not granted** to the platform TaskRole, **not granted** to the acceptance identity (minimum surface; cross-region endpoints are created only by CFN).
- The IAM simulation gate (`infra/iam/platform-taskrole-calls.json` + `scripts/iam-simulate-gate.py`) gains one check
  for the **cfn-exec role**; the synth gate gains: whenever the template contains an `AWS::EC2::VPCEndpoint` whose `ServiceRegion ≠ stack region`,
  the place where that authorization lands must be found in the source code (otherwise it blows up only when the deployment reaches that step).

**E. The resource bag (section 1.1 `resources`) gains three observation-only keys**

| Key | Shape | Description |
|---|---|---|
| `endpointIds?` | `string[]` | all VPC endpoint ids of this target (gateway + interface), used by the details page and the probe |
| `crossRegionDdbEndpointId?` | `vpce-…` | the cross-region DynamoDB interface endpoint; mandatory for non-home targets |
| `homeLinkHostedZoneId?` | `Z…` | the private hosted zone id |
| ~~`peeringConnectionId?`~~ | — | **not set** (route P does not use peering; the spike proved it cannot be created under the current IP plan) |

`networkProfile` (the standard/economy field of the network-profile item) has **empty semantics** from this work onward: the value is kept for compatibility with existing descriptors,
the broker no longer derives the NAT count from it, and the `exec-env-nat-gateways` input of `context.ts` is **deleted** (passing it makes synth fail — a review item:
leave no opening to "re-enable NAT" later); the wizard no longer shows network size or the EIP preflight.

**F. Two probe items (section 2.1 probe; 🔴 both must retry with back-off)**

| Item | Check |
|---|---|
| `network:egress-none` | the route tables of this target's private subnets (`describe-route-tables`) **contain no `0.0.0.0/0`**; `describe-nat-gateways` for this VPC counts 0 non-deleted gateways |
| `network:home-link` | endpoint `State=available` ∧ the apex A record exists in the private hosted zone ∧ **one real `GetItem` against the home ledger** succeeds |

🔴 **Spike finding: an interface endpoint in `State=available` is not yet usable** — right after it became available a `ConnectTimeout` was observed, after 45 s a
`ConnectionClosedError`, and only about another minute later did real calls all succeed (the private DNS record propagation window ≈ 2–3 minutes).
⇒ The probe and the network acceptance check always **retry with back-off** (suggested 6 × 30 s); a single red must not be judged as "endpoint missing".

**G. Switch-over path for existing targets**

Use the upgrade path defined by the per-target execution-role work: `preview` (the same full component set as installed = an upgrade rehearsal) ⇒ the rehearsal detects **state changes** (NAT removed / route tables changed /
endpoints added) ⇒ approval ⇒ `deploy` with `approvedPlanHash`. Data buckets / table buckets / regional results / regional audit **stay RETAIN and untouched**;
during the switch-over window the target is set to "Not accepting new work" (the `draining` semantics already exist). **The VPC itself is not replaced** (the CIDR is unchanged) ⇒
the MWAA environment / Redshift subnet group / EMR network configuration are **all left as they are**, which is precisely the core advantage of route P over the fallback route R.

**H. Classic MWAA**: `webserverAccessMode` becomes `PRIVATE_ONLY` (the platform does not use its web UI); `requirements` uses only pre-installed packages
and does not depend on egress to pull packages.

**I. Environment-side hard constraints (to be recorded during construction; not product defects)**

- In this account the **us-west-2 VPC quota is full at 5/5**, and `servicequotas:RequestServiceQuotaIncrease` is denied by an SCP
  ⇒ **no additional execution environment can be created** during construction and acceptance; this work itself **creates no new VPC** (it converts the existing ones), so it is not blocked.
- The account allows only **us-east-1 / us-west-2** (`ec2:CreateVpc --dry-run` measured region by region); a third region is still unavailable.

### 3.17 🆕 Revision 3.44 RunGroup — group status derivation + deterministic group key for scheduled runs (the run-group work package; data contract in section 1.3a)

#### 3.17.1 Group status derivation (the only source of truth = the child run rows)

```text
deriveGroupStatus(children):            # pure function, exhaustive; no children ⇒ "submitting"
  if children is empty:        return "submitting"      # the fan-out loop has not submitted its first run yet
  if any running:              return "running"
  if any failed:               return any succeeded ? "partial-failed" : "failed"
  if any stopped:              return "cancelled"       # no failed and no running
  if all succeeded:            return "succeeded"
```

🔴 **Three properties that must never be violated** (they are exactly what the acceptance check for group status pins):
1. **`partial-failed` ≠ `failed`** — "one region failed" is never folded into a group-wide `failed`; that would stop users from looking at the artifacts of the region that did succeed (the mirror image of the customer requirement "afraid of missing a region and the data not reconciling": overlooking the successful region).
2. **The `status` in the table is only a cache**: every read path must derive first and then compare with the table; on mismatch the derived value wins and is reconciled back. It is **not allowed** to go the other way and use the table value to fix child runs.
3. **`cancelled` ≠ `failed`**: cancellation is a user action, failure is a system outcome; once they are merged, the "cancel in one click" feature can no longer be verified as successful.

#### 3.17.2 Deterministic group key for scheduled runs `rgs_<first 24 hex of sha256>`

**The problem to solve**: the same cron fires on the schedulers of N regions independently, and the N runs **must land in the same group**, while the regions **do not communicate** (regional autonomy, a hard constraint of the per-region scheduling and serverless-orchestration work) ⇒ the group id can only be **a deterministic function each region can compute on its own**.

**Inputs (single author `scheduledRunGroupId()`, the same formula in TS and Python + a parity unit test comparing byte for byte)**:

```text
canonical = definitionKind + "\n" + definitionId + "\n" + slotIso
rgs_<first 24 hex of sha256(canonical)>
slotIso = "the most recent cron fire point ≤ the moment of this trigger", normalized to whole seconds in UTC: %Y-%m-%dT%H:%M:%SZ
```

🔴 **The source of `slotIso` was pinned by measurement, not picked at will**:

| Candidate | Why it does not work |
|---|---|
| Airflow `run_id` / `logical_date` | **degenerates into a constant under MWAA Serverless** (two different runs were both observed as `scheduled__2026-09-07T00:00:00+00:00`; `runtime-py.ts:_ledger_run_id` records this real-environment fact, and it is why the ledger runId was switched to `AIRFLOW_CTX_DAG_ID`) ⇒ the failure mode is **every scheduled run in history collapsing into one group**, and that group never reaches a final state |
| `AIRFLOW_CTX_DAG_ID` (`ex_<uuid>`) | different for every run — but **also different for every region** ⇒ cannot group across regions |
| The wall clock at trigger time, taken to the second | the trigger instants of two regions differ by a few hundred milliseconds ⇒ two groups every time (**never grouped**, and it looks like a broken feature) |
| ✅ **Round down to the cron slot** | both regions are triggered **after** the same cron fire point ⇒ both round down to the same slot; to end up apart, one region would have to be delayed by **more than a whole cron period** (24 h for daily), which is itself a fault that should be reported |

**`definitionVersion` is deliberately kept out of the key** (replacing the earlier wording in section 1.3a): it is per-target dispatch-ledger state, and a failed publish in one region followed by a separate re-publish produces a **cross-region version difference**; putting it in the key would split one trigger into two groups of one. Version differences must be **visible inside the group** (group row `definitionVersions:{[targetId]:number}`, shown per region on the group page) and must not change the group's identity.

**Landing surface (landed in construction step 5 of revision 3.44)**:
- At **publish time** the platform injects `{definitionKind, definitionId, cron, table, projectId, requestedTargets}` into the artifact as `spec.scheduledGroup`; at run time the injected Python twin computes `slotIso` and the whole key. The **single author** of both formulas = `lib/monitor/scheduled-run-group.ts` (it emits the Python source), and the parity unit test really runs `python3` and compares byte for byte (including **consistent failure**: a non-existent cron throws on both sides).
- 🔴 **"Is this run coordinated" is decided by the TS side at publish time, and the criterion is "all bindings", not "the subset published this time"**: the Python side knows only its own region; if the subset were used, the region re-published alone would **have no** `scheduledGroup` while the other region still carries one ⇒ the same cron silently splits into two groups.
- 🔴 **The key must be computed before acquiring the run lock**: lock acquisition waits up to 300 s, and computing after a cron slot boundary has passed diverges from the other region (the only symptom is "not grouped", with no error).
- 🔴 **The group row is created by each region with a conditional write** (`attribute_not_exists(runGroupId)`; the first one wins, the rest join); on the Python side a failure to create it **does not fail this run** (deliberately the opposite of the TS side: that region's run row already carries `runGroupId`, the source of truth for the child run lives there, and the group row can be created by the next region).
- The run-time code package version is a **content hash** (`BGP_RUNTIME_VERSION` = first 12 of sha256) ⇒ changing the Python automatically changes the S3 key, **no manual version bump is needed** (this replaces the earlier plan wording "runtime-lib v5").
- ⚠️ **This batch connects MWAA Serverless only (the platform's default scheduler)**. Classic MWAA is a **legacy** path (decided with the serverless-orchestration work: no longer deployed), and its scheduled runs show up **ungrouped** (no `runGroupId`, no group row) — that is an **honest degradation**, not a wrong grouping. Registered as a known limitation in the acceptance checklist.
- ⚠️ **Scheduled / manual runs of workflows (`taskType=workflow`) are not grouped in this batch either**: their ledger goes through the three write points `__start`/`__finish`, and **the manual trigger route takes only the first target of the binding** (`bindingTargets(...)[0]`) ⇒ it does not fan out at all. Registered as a known limitation, in the same domain as the fan-out-at-creation work.

### 3.18 🆕 Revision 3.54 Unified long-running-operation protocol — the long-running-operation framework (one cure for the four defects with the same root cause: governance column sync, project deletion, AI routes and modeling landing)

> The implementation-level contract is in [the long-running-operations design](./long-running-operations.md), **version 1.0, section 2** (tables / primitives / HTTP / client transport layer / kind list / gates); this section only fixes the **scope and the invariants**, and the relationship to the other sections of this document. Decided on 2026-10-21: "no patching; solve it at a high level of abstraction, once and for all".

| Item | Decision |
|---|---|
| Scope | **Any** write route that waits inside the request handler for an external system to reach a final state (Redshift Data / Athena / Glue / EMR / DMS / OpenMetadata / large language models). First batch = modeling land / apply / unbind / unbind preview (the modeling-landing timeout defect) + the seven AI routes (migrated from the earlier AI asynchronous protocol); second batch = governance schema-sync (the column-sync timeout defect) / project deletion (the warehouse cold-start defect, replacing the warming protocol) / catalog create table · alter table (the route layer of section 3.9a `land-model-table` / `alter-model-table`) / sync execute-ddl / data-source check / direct-query submission; third batch = Ask-Your-Data `ask` (keeping its result contract) |
| Invariant ① single primitive | On the server only `lib/long-ops/submitLongOp` knows "how long to wait, how to switch to 202, how to settle"; the closed kind list `LONG_OP_KINDS` (a new kind is **registered first, wired second**; tsc pins the one-to-one correspondence kind ↔ executor ↔ Chinese label ↔ parameter type; discipline 2) |
| Invariant ② hybrid response | Wait in-process for `LONG_OPS_SYNC_WAIT_MS` (default 45 s, < the 60 s edge); final state reached ⇒ the synchronous response is **unchanged word for word** (success and failure alike); not reached ⇒ 202 `{ taskId, kind, label, status:"running", async:true, protocol:"long-op/1" }`; the final state is fetched via `GET /api/long-ops/[taskId]` (ownership must match exactly, otherwise 403; heartbeat 8 s · stale after 30 s then re-claimed; a 300 s ceiling forces timeout and **never re-runs**); `GET /api/ai/tasks/[taskId]` is kept as an alias for one version |
| Invariant ③ client transport layer | The global fetch interceptor (`AuthProvider`, through which every `/api/*` call passes) reacts **only** to a 202 carrying `protocol:"long-op/1"`, polls to the final state and reshapes it into a Response **of the same shape** as the synchronous 200 (for failed, the original status code is restored from the task row's `errorStatus`; timeout ⇒ 504 `UPSTREAM_TIMEOUT`) ⇒ zero changes at page call sites; the Ask-Your-Data 202 `{taskId,status:"pending",async:true}` and the project-deletion warming 202 `{status:"warming"}` are **unaffected**; meanwhile a global hint "Running in the background: <label>" is shown |
| Invariant ④ gate | The sole author of the polling primitive that waits for an external final state is `lib/long-ops/await-terminal.ts`: without a long-operation context (`currentLongOp()`) and without a legitimate `BACKGROUND_WAITERS` owner ⇒ throw `LongOpContextMissing`; the list of existing polling files only shrinks; the list of files in which the route layer calls long service entry points directly (`landToTargets` / `unlandFromTarget` / `estimateRows` / `executeAdminDdl` / `startOrJoinSchemaSync` …) only shrinks; the request path may not pass an owner |
| Invariant ⑤ defense in depth | The 60 s edge (CloudFront origin readTimeout / ALB idle / Node keepAlive 65 s) is **not relaxed** |
| Relationship to sections 3.9a / 3.9d | The **execution channel** of modeling landing / alter table (`executeAdminDdl` templated statements, the narrow-privilege `shared-writer` identity) and the **authorization axis** do not change by a single word; this section only takes over "how long the route waits and what it answers when the wait is exceeded". Place / project / identity-derived values all go into the task row's `params` (the task may be picked up and executed by another request); the explicit `requestedTargetId`, authorization / validation and the audit actor **stay in the route** |
| Table | `bgp-long-ops` (replaces `bgp-ai-tasks`; the earlier AI task table was never released, so zero migration; pk `taskId` ULID, TTL 7 days, `hardened`); `TABLES.LONG_OPS`; the table totals 72 / 63 are unchanged |
| Environment variables | `LONG_OPS_SYNC_WAIT_MS` (**one new key in the container env**, CDK context `-c long-ops-sync-wait-ms`; not given in production = 45000; test accounts use 500 to force 202 for acceptance) · `LONG_OPS_MAX_MS` 300000 · `LONG_OPS_STALE_MS` 30000 · `LONG_OPS_HEARTBEAT_MS` 8000 · `LONG_OPS_ASYNC` on by default (`0` falls back to purely synchronous); the earlier AI protocol's `AI_SYNC_WAIT_MS` / `AI_ASYNC_MAX_MS` / `AI_ASYNC_STALE_MS` / `AI_ASYNC_HEARTBEAT_MS` / `AI_ASYNC` are deleted |
| Acceptance checks | The headless acceptance segment for long-running operations (ten checks; the seventh is the closing check for the modeling-landing timeout defect) + the twelve offline gates ①–⑫ in [the long-running-operations design](./long-running-operations.md), section 2.7 |

## 4. List of change points (implementation level)

| Domain | New | Changed |
|---|---|---|
| **Standalone security fix** | `bgp-query-handles` table + `submitStatement()` | `result/[id]` + all submission points (section 3.7) |
| Registry | `bgp-execution-envs` + `lib/exec-env/registry.ts` | home registered automatically; `targetId` generator |
| Naming SSOT | `platform/naming.json` + re-export on both sides | absorb the 🔴 **30 lines / 23 files** (measured in revision 3.8, see [the design document](./multi-region-execution-design.md), section 3.1) of `bgp-workgroup` fallbacks; the home exemption converges into the authoritative function `isHome(target)`. 🔴 **Split into two slices**: **the first slice** delivers only the SSOT itself + exports on both sides + three gates (zero call-site changes, class A); **absorbing the existing fallbacks stays in the lossless-refactor batch** (it touches live paths and requires headless contract snapshots before and after) |
| Lifecycle | **narrow-privilege broker (Lambda)** + CodeBuild project + buildspec + management page | the platform holds `lambda:InvokeFunction` instead (**StartBuild revoked**); the state machine gains failed/draining; epoch / lease renewal |
| Client cross-cutting | `lib/aws/clients.ts` | only the multi-target paths change |
| runtime-lib | — | `_mk`→`_mk_exec/_mk_ctrl` (7 places) + **lock identity includes the target** + lock-parity extended |
| **task-runs** | GSI×3 | **13 row creations + 14 write-backs = 27 places** get `{projectId,targetId}` + **composite runId** + read-side settlement through `parseRunId()` + Scan→Query |
| 4 atomic functions + 5 warehouse direct queries | — | add `target?` |
| Auditable closure (corrected in revision 3.22) | `residencyAudit` / `residencyPrerequisite` / `accessAllows` / `auditEgress` (the former `residencyGuard` / `classifyTrack` track-judging rejection **is withdrawn**, decision 6quinquies) | no track judgment and no rejection; audit **sharded + residency classification**; if it cannot be written, refuse |
| **Axis A modeling** | `landCodeTableToTargets` / drift check | `landCodeTable`/`applyModelTableDDL` gain target; `landedByTarget`; the land route gains a target parameter |
| **Axes B/C** | authoritative FQN function | pk/sk of the 5 result tables; grants per target; masking **lookup side passes the target through + pushed down to the regional side + L3/L4 fail-closed**; **9 places** of `\|\|"public"` on the metadata side settled (including the write side `glue-script-generator:344`; jointly with the project-isolation design) |
| **Axis D audit** | regional audit storage | `audit.ts` sharding + PII classification routing |
| **Section 3.9 credentials** | `getPrivilegedCred` factory | `admin-secret._arn`/`zeroetl._secretArnCache`→**`(targetId, project, purpose)`**; `_sgIdCache`→targetId |
| Consumer surface | — | cookbook injection at generation time + core-dist redistribution; advisor target pass-through (apply hits the target region); Ask-Your-Data retrieval filtered by target; DataApi/api-key target scope |
| Operations surface | — | RBAC×target; alerts bucketed by target; project deletion reclaims across targets; `offlineDag(dagId,targetId)`; notification masking |
| Differentiation | metadata mirror + single-screen overview page | — |
| IAM | — | `aws:RequestedRegion` at **19 places** changed to a list (platform-stack 16 + emr 1 + netadvisor 1 + paramadvisor 1); broker/deny-override; **per-target roles (decided in section 6.1: two stages, hard switch before cross-jurisdiction go-live)** |

---

## 5. Acceptance (implementation level) + open items

**Standalone security fix (independent, first)**: see the acceptance line in section 0 — A fetching B's statementId gets **403**, its own gets 200, with an audit trace; all submission points covered (no legitimate query wrongly rejected).

- [ ] **Lossless-refactor batch**: zero FAIL in the headless contract snapshot comparison; naming / lock-parity unit tests (**including "the same taskId on different targets may run in parallel / on the same target strictly mutually exclusive"**); the defaults of the 4 atomic functions byte-for-byte unchanged; **the task-runs matrix of 13 write points** each carries `{projectId,targetId}` and **runId is composite**; **the runId read-side list verified point by point** (logs / diagnostics / backfill / cost / Copilot / front end can all find the run); GSIs built, the bounded Scans changed to Query.
- [ ] **Second-target batch (core-only)**: wizard → broker → deployment → probe all green → canary succeeded; hard evidence for the data-lake chain S3 Tables / Athena; synth-gate; **deploy-lock rejects concurrency + lease renewal**; **negative: the platform identity calling `StartBuild` directly must be denied** (already moved to the broker), **inline `buildspecOverride`/`imageOverride`/`serviceRoleOverride` denied by AWS**.
- [ ] **Lifecycle + push-down + axis A batch**: the DAG really runs on each of the 2 targets, and a red cell on the version dashboard can be re-published; the 5 warehouse direct queries hit the right target; **three-stage deletion validation + draining rejects new bindings + an old op whose epoch has expired cannot destroy**; hard evidence that data buckets / table buckets / regional results / regional audit are **RETAIN**; **modeling landing materializes per target + the `landedByTarget` observed state + drift detection** (deliberately create a heterogeneous table with the same name in B → status `drift` rather than a false-green `ok`); **per-target privileged credentials** (B's DDL uses B's secret, not home's); **DAG taken offline per target** (a non-home DAG really goes offline, no orphans).
- [ ] **Consumer-side + residency + axes B/C/D + differentiation batch**:
  - Track 2: the background profiler / sensitive-scan / quality **compute in the region** across jurisdictions, the center holds no row-level or column-value profiles, CRR is off, the agentcore fallback is restricted to the region; track 1: a cross-jurisdiction interactive query **returns normally** and the response carries `auditId`, **a failed audit write means refusal**; a scheduled fetch through execute **is classified as track 2** (hard negative evidence for provenance).
  - **queryHandle**: fetching results across project/target gives 403; expired gives 410.
  - **Axis B**: quality results / metric values / lineage edges / classifications of same-named tables on two targets **do not overwrite each other** (the real status source is read table by table); health scores aggregate per target and are not mixed.
  - **Axis C**: a US grant **does not unlock** the same-named EU table (negative); cross-jurisdiction results are **masked on the regional side** (neither the center nor the browser can obtain unmasked rows); **when the classification target and the masking target disagree, L3/L4 is refused** (not silently allowed).
  - **Axis D**: for cross-jurisdiction operations the **operator PII / SQL text / plaintext queryId do not exist in the central audit** and live only in the regional audit store; the center holds only summaries; after **sharding** the audit has no single-partition hot spot; the regional audit denies deletion and modification (negative test via CLI).
  - **Consumer surface**: SQL generated by the cookbook hits **B's workgroup/schema** (not home, no `<placeholder>`); the network advisor's one-click fix changes **B's VPC** (not home's); Ask-Your-Data in B does not retrieve home-only skills / descriptions.
  - **Operations surface**: an outage of B alone **triggers an alert** (not averaged away by home's healthy data); after project deletion **no proj_ schema / role / secret remains on any target**; RBAC×target negative (someone without permission on B cannot push down to B).
  - **Differentiation**: the single-screen overview lists the metadata of all targets with a `mirroredAt` annotation; the mirror **contains no result rows**.
- [ ] The review's permission-boundary item, which is not covered by headless acceptance, is replaced by a static check of the permission boundary plus the negative probes above.

## 6. ✅ The four former "open before construction" items — decided (2026-08-28: "go with the recommendations")

### 6.1 IAM role granularity = **per-target role + ABAC**, but **landed in two stages** (an item of the independent architecture review)

| Stage | Approach | Rationale |
|---|---|---|
| **Lossless-refactor and second-target batches** | keep the **shared fixed roles + `aws:RequestedRegion` region list** (the current design) | first close the loop for the second target; at this stage there are only same-jurisdiction targets, so the lateral-movement risk is acceptable |
| 🔴 **Before a cross-jurisdiction target goes live (inside the lifecycle batch; hard gate)** | switch to **per-target execution roles**: `bgp-<kind>-role-<targetId>` (one set each for glue/emr/flink/redshift-copy/dms-kinesis), with trust policy and permissions both **bound to this target** (`aws:RequestedRegion` = that target's region + resource ARNs limited to this target's resources + tag condition `bgp:targetId`). 🔴 Revision 3.22: the hard gate is **mechanized** into `residencyPrerequisite.hasPerTargetExecRoles` (the residency work); a cross-jurisdiction target without the roles accepts no work | **Not sharing execution identities between jurisdictions** is a necessary condition for hard residency / jurisdiction isolation; with shared roles, "any compromised target can access the other targets laterally" (a finding of the independent architecture review) equals **a cross-border data risk** in the cross-jurisdiction scenario |
| **Cost and mitigation** | number of roles = kind × target (linear growth); the exec-env stack group **creates / destroys them together with the target** (no longer "created once in home only"), and names come from the naming SSOT; `Role.fromRoleName` references change to the per-target names | the roles follow the stack group's lifecycle and create no manual operations burden |
| **Acceptance** | negative: using target A's execution role to access target B's buckets / workgroup → **denied** (one check added to the acceptance checklist) | — |

**🔴 Revision 3.21 stage-two landing rules (the per-target execution-role work, started 2026-09-05)** — re-verification at the start of the work overturned one assumption: the earlier review note's "Glue is already per-target" was right only in the half "the ARN is taken from the descriptor"; the `glueRoleArn` emitted by the core stack **is still the home role** (`core-stack.ts` assembles the home name; synth-gate check 6 still pins "fail as soon as a slug appears"). All four role kinds glue / emr / redshift-copy / dms-kinesis exist only once, in home; the naming SSOT has had target templates for the five kinds for a long time, but only flink was actually done.
1. **Where they are created**: the core stack creates `glueRole` + `emrServerlessRole` (Glue / EMR are not components but core capabilities) → Output `glueRoleArn` (**now emitting this target's name**) + `emrExecutionRoleArn`; the redshift stack creates `redshiftCopyRole` and attaches it to the namespace `iamRoles` + `defaultIamRoleArn` (`COPY … IAM_ROLE default` works outside home from now on) → `redshiftCopyRoleArn`; the dms stack creates `dmsKinesisRole` (trust includes `dms.<region>.amazonaws.com`) → `dmsKinesisRoleArn` (**wiring the consumer is not part of this work**: DMS real-time sync is not yet target-aware; it belongs to the user-source onboarding and regional-API work). Role names are always `resourceName(kind,{targetId})`, with the stack tag `bgp:targetId`.
2. **Three layers bound to this target**: ① trust = service principal + `aws:SourceAccount` (EMR Serverless additionally gets `ArnLike aws:SourceArn arn:<p>:emr-serverless:<region>:<acct>:/applications/*`, pinning the trust to this region); ② resource ARNs point only to this target's three buckets / table bucket / this region's secrets; ③ every statement with `Resource:*` (glue / lakeformation / logs / cloudwatch / ec2 ENI / redshift-data / dynamodb read) **always** carries `StringEquals aws:RequestedRegion = <this region>`. The action set **copies the home role of the same kind** (functionality is conserved; no separate narrowing here); the only deliberate narrowing = **no arbitrary user S3 / arbitrary buckets** (exactly the surface the lateral-movement negative check must reject; user-source access in non-home targets belongs to the explicit allow-list of the source-onboarding work).
3. **Platform side**: the TaskRole gains the ManagedPolicy `ExecEnvPerTargetRolePass`: `iam:PassRole` → `BgpExecEnv-*-glue-role / -emr-role / -redshift-copy-role / -dms-kinesis-role` (resource patterns converged; the same rule as the existing four fixed home names, no PassedToService; `iam:GetRole BgpExecEnv-*` existed already); **the PassRole for flink is still registered as not granted** (creating MSAF applications outside home is not part of this work). Data plane: `resolveTargetGlue` asserts for non-home that the role name = the SSOT name of this target; new `resolveTargetEmr` / `resolveEmrBinding` (home goes through `EMR_EXECUTION_ROLE_ARN`, byte-for-byte equivalent; that env literal may from now on appear **only** in `target-clients.ts`); EMR submission / scheduling use it. The S3 surface of `BgpEmrStack` is **pulled back** to the full names of home's two buckets (the earlier review's relaxation is revoked).
4. **Gates**: synth-gate check 6 is **inverted** (a non-home `glueRoleArn` must contain the slug and must not contain the home name) + synth-gate section 7b gains role assertions for the three stacks (the name comes from the SSOT / buckets point only to this target / every `Resource:*` carries the region condition / the EMR trust carries SourceArn / the namespace `DefaultIamRoleArn` references this stack's role) + synth-gate section 9 gains "the S3 surface of `BgpEmrStack` is byte-for-byte = home's two buckets, and the TaskRole contains the four PassRole patterns"; the platform wiring-guard pins the single author of the env literal; descriptor section 3.1a, execution-role key rules ① ② (see that table).
5. **Switching existing targets**: after the platform deployment, `tgt_usw2_a` goes through "Redeploy" = upgrade (`preview` with the same set → `deploy{approvedPlanHash}`, section 2.1, revision 3.21) → finalize switches `glueRoleArn` from the home name to this target's name through the narrow-channel exception and adds `emrExecutionRoleArn` / `redshiftCopyRoleArn` / `dmsKinesisRoleArn`; before the switch, Glue / EMR submissions on that target **fail closed and point the way** according to rule ①.

### 6.2 CodeBuild `cfn-exec-role` = **narrowed, but collect first and narrow second** (a leftover from [the design document](./multi-region-execution-design.md), section 12.0)

- **Second-target batch**: keep the CDK default bootstrap (admin-equivalent) to **get the exec-env stack group working**; 🔴 **at the same time turn on CloudTrail collection of the role's actual API call set** (run each of the three paths once: deploy / add component / destroy).
- 🔴 **Lifecycle batch**: **narrow in one step** using the collected results — `cdk bootstrap --cloudformation-execution-policies` attaches a **precise policy** (from the collected manifest + the component matrix), without a hand-guessed enumeration (**a guessed enumeration is bound to miss permissions → the deployment fails midway → repeated trial and error**; that is the real reason for not narrowing first).
- **The safety net is unchanged**: the platform **does not hold** StartBuild (the broker of section 2.1) + the broker deny override + the right to modify the buildspec / project is protected at the same level as the right to deploy + end-to-end audit.
- **Acceptance**: after narrowing, **re-run** the three paths deploy / add component / destroy, all green (proving no permission was missed); negative: use the cfn-exec-role to attempt an action unrelated to exec-env (such as creating an IAM user) → denied.
- 🔴 **Revision 3.21 correction of the collection window (surveyed when the per-target execution-role work started)**: the collected set is complete only after **every newly added stack resource has really been deployed at least once** — the four role kinds of the per-target role work and the residency stack of the residency work each bring new CFN call families (IAM Create/Put/Tag/Delete, DDB, S3 bucket policies). ⇒ Order = the role stacks and the residency stack go live → first deployment of the third test target (path ①) + add component (path ②) + **destruction of a temporary target** (path ③, permitted on 2026-09-05) → from the existing `bgp-management-trail` (multi-region management events are already being recorded; **no new trail is opened**) extract the `eventSource:eventName` set for `sessionIssuer.arn = cfn-exec-role` (script `scripts/collect-cfn-exec-actions.sh`) → policy file `infra/bootstrap/cfn-exec-actions.<region>.txt` (what actually lands is a text list of actions, not a policy json) (the synth gate pins "exists and is referenced by bootstrap") → attach it **preferably with an exec-env-specific qualifier** (a separate `CDKToolkit-<qualifier>`; the default bootstrap of the home region stays with the control-plane deployment, and narrowing it would break deploy-all) → re-run the three paths. **The narrowing itself comes after step 7 of the residency work and before the first passing acceptance stamp**; this work only prepares the collection script.

### 6.3 DNS / TLS / WAF / JWT / network of the regional API (an item of the independent architecture review)

| Item | Decision |
|---|---|
| **Domain name** | 🔴 **Corrected in revision 3.5: `data.<targetSlug>.<platform domain>`** (originally written `data.<targetId>` — **host names do not allow `_`**, and targetId contains `_` ⇒ creating the domain name / certificate as originally written **fails at deployment**; the export list of section 1.1a already requires DNS/ACM/APIGW to use `targetSlug`). It is still "use the identity, not the region name" (one region may have several targets); the central control plane keeps its current domain name |
| **TLS certificate** | issued by **ACM in that target's own region** (a regional API Gateway needs a same-region certificate); the certificate renews automatically |
| **WAF** | **one set attached per region** (rate-limiting / geo / common-attack rules take effect in that region); the rate-limit threshold is set from that target's expected traffic |
| **CORS** | **exact allow-list**: only the central front-end origin is allowed (no `*`); the `OPTIONS` preflight allows the necessary headers (`Authorization`/`x-bgp-*`); data responses carry `Cache-Control: no-store` ([the design document](./multi-region-execution-design.md), section 8.5.7 ⑧) |
| **JWT** | issuer = **the central Cognito** (seamless SSO, no user pool per region); 🔴 **the audience is distinguished per target** (🔴 **corrected in revision 3.5: `aud=data.<targetSlug>`** — same origin as the domain name, avoiding two mismatched value sets "domain uses the slug, aud uses the id"; prevents a token from region A being used in region B); the regional side **verifies signatures locally** (JWKS cache + periodic refresh for rotation, no round trip to the center) |
| **CSRF** | all data APIs use `Authorization: Bearer` (no dependency on cookies) ⇒ CSRF-immune by construction; cookie authentication is forbidden on the regional API |
| **PrivateLink / private network** | **not in phase 1** (public network + TLS + WAF + JWT suffice; saves VPCe cost and complexity); **hard-residency customers** (the option in [the design document](./multi-region-execution-design.md), section 8.5.6) can add PrivateLink + a private entry point, listed as a deployment option rather than the default |
| **Acceptance** | using a token across targets (`aud` mismatch) → **401**; a cross-origin request from a non-allowed origin → preflight rejected; data responses contain `no-store` |

### 6.4 Replication as a first-class object = **only the "minimal skeleton" is defined, not implemented** (an item of the independent architecture review)

**Rationale**: cross-region replication **has no explicit customer demand today**, but since "cross-region must be explicit and governable" is already settled ([the design document](./multi-region-execution-design.md), section 19.0, principle 1), **it will inevitably be needed in the future** — so only the **data model is fixed now**, to avoid changing the foundation later; **no API / UI / scheduling** (no workload taken on).

🆕 `bgp-replications` (skeleton; not implemented in phase 1):

| Field | Description |
|---|---|
| `replicationId` (PK) | immutable |
| `scope` | `table` \| `schema` \| `namespace` \| `dataset` |
| `sourceTargetId` / `destTargetId` | both are `targetId` values (not regions) |
| `objectSelectors` | an explicit list of objects / prefixes (**no "all" wildcard**, to prevent accidentally opening a full cross-border copy) |
| `mode` | `snapshot-copy` \| `incremental` \| `datashare-live` (Redshift cross-region datashare, zero copy) |
| `schedule` / `lastReplicationPoint` / `lagSeconds` | frequency and replication point (the lag is published openly, following the honest-disclosure practice of mature streaming platforms) |
| ~~`residencyApproval`~~ | 🔴 **Withdrawn in revision 3.22 ([the design document](./multi-region-execution-design.md), section 18, decision 6quinquies: no legal gate)** — originally `{status, approvedBy, at, legalBasis}` with "a cross-jurisdiction replication can become active only with a legal document"; the skeleton keeps only `auditTrail`, and cross-jurisdiction replication takes the same path as same-jurisdiction replication and writes the audit |
| `status` | `draft` → `pending-approval` → `active` → `paused` → `failed` → `deleted` |
| `auditTrail` | creation / approval / start-stop / failure go into the tamper-proof audit |

**Phase 1 does only this**: the table definition is written in this specification (no table created, no code written); **explicitly state** that "cross-region data replication is not provided in phase 1" (already in the capability boundary of [the design document](./multi-region-execution-design.md), section 14).

---

### 6.5 ✅ Decision on the second open question: **multiple targets per region are allowed**; the three keys adopt the `targetId` form uniformly

**Problem**: the very argument for `targetId` in section 1.1 is that "blue/green, primary/standby, and old/new migration environments can coexist in one region", yet [the design document](./multi-region-execution-design.md), section 14, says "in phase 1 at most one environment per region", and the three keys FQN / OM / audit are derived from the region ⇒ the three cannot all hold at once.

**Decision (adopting the review's recommendation)**: **multiple targets per region are allowed** (otherwise the reason for `targetId` to exist is removed, and introducing blue/green later = **a second metadata migration**, an order of magnitude more expensive); **the "at most one environment per region" restriction in the design document, section 14, is withdrawn** (replaced by "not limited in phase 1, but several targets in one region is advanced usage; the wizard defaults to one per region"). The three keys **all switch to the `targetId` form**:

| Key | Old | Decision |
|---|---|---|
| Platform-side FQN segment | `regionOf(targetId)` | **`targetId`** (already changed in section 3.10) |
| OM service name | `bgp-redshift-<region>` / `bgp-s3-<region>` | **`bgp-redshift-<targetId>` / `bgp-s3-<targetId>`**; home keeps the old name under the unchanged exemption; **the OM ingestion loop iterates per target rather than per region** (synchronized with the design document, section 7.2) |
| Audit shard key | `audit#<region\|tenant>#<day>` | **`audit#<targetId>#<day>`** (already changed in section 3.3) |
| Model-configuration key ([model-configuration design](./model-configuration.md)) | `ai-model#<region>#global` | **`ai-model#<targetId>#global`** |
| Naming SSOT signature | `resourceName(kind,{account,region,isHome})` | 🔴 **Re-settled in revision 3.8: `resourceName(kind,{targetId, account?, component?})`** — the derived key uses **`targetSlug`** and appends `-<targetSlug>` to **all** non-home resources (not only buckets); the signature **does not accept `isHome`** (it is derived from targetId; accepting it = a forgeable bypass). 🔴 The revision 3.0 wording "`{account,region,targetId,cellId?,isHome}`; only a target that is **not the first** in that region gets `-<cellId>`" **is withdrawn**: "first" is registration-order state that a pure naming function cannot obtain ⇒ the name could not be reproduced from the descriptor alone; and the two segments `region`+`slug` would overflow S3's 63-character limit. The complete convergence rationale for the three mutually conflicting contracts is in [the design document](./multi-region-execution-design.md), **section 3.2** (synchronized) |

### 6.6 ✅ Decision on the first open question: add a **shared-foundation batch G** and split the project-isolation data-plane batch into a **supply layer and a migration layer** (resolving two circular dependencies)

**The cycles, confirmed**: ① axis A of this design's lifecycle batch must land into the `shared` schema (created only by the project-isolation data-plane batch) ⇄ that data-plane batch needs the per-target credential factory (created only by this design's lifecycle batch) = **deadlock**; ② the metadata FQN settlement of the project-isolation data-plane batch needs this design's authoritative FQN of section 3.10 (scheduled in the consumer-side batch) ⇄ the consumer-side batch in turn comes after the data-plane batch = **reverse order**; moreover `bareKey`/`fqnVariants` is **one and the same function** changed once by each of the two phases, violating the iron rule "change it completely in one go".

**Decision (adopting the review's recommendation) — the construction order becomes**:

```text
Standalone security fix: queryHandle (independent, no prerequisite, can ship / roll back on its own)
 ↓
G   shared-foundation batch (new; builds only [functions / SSOT / ledger writes], moves no data ⇒ lossless and reversible)
    G0 clean up the 68 naming leftovers + narrow the acceptance gate of the design document's section 20.4 (7 of them are credential composite keys and 6 are summary-table fields of the design document's section 10 — exactly the contracts batch G is to write)
    G1 targetId registry + isHome() (tgt_home)                                        [formerly in the lossless-refactor batch]
    G2 getPrivilegedCred() three factory classes (project dimension built first, idling)  [moved forward from the lifecycle batch]
    G3 authoritativeFqn() + redefinition of bareKey/fqnVariants                          [moved forward from the consumer-side batch]
    G4 projectSchema() SSOT                                                              [moved forward from the project-isolation data-plane batch]
    G5 table-ownership ledger bgp-table-ownership, "write only, not yet read"              [start accumulating stamps for existing tables early]
    G6 the three process-level caches switched in one go to the (targetId, project, purpose) composite key
 ↓  Project-isolation guard batch: 13 guard surfaces + permission tightening + L1 GRANT revocation (gradual rollout)
 ↓  Lossless-refactor batch (naming SSOT / composite runId + GSI / client factory) + project-isolation monitoring batch (read and write in the same batch)
 ↓  Second-target batch (core-only; the second test target)
 ↓  🆕 Project-isolation data plane [supply layer]: proj_<id> + role_proj_* + shared schema + GRANT (using G2 class ③)
 ↓  Lifecycle + push-down + axis A batch (shared already exists → land directly, no double work)
 ↓  🆕 Project-isolation data plane [migration layer]: existing public → proj_/shared + metadata FQN write-back (using G3/G5)
 ↓  Consumer-side + dual-track residency + axes B/C/D + consumer / operations / differentiation batch
 ↓  Project-isolation sharing batch → copy batch (incremental features, lowest risk; last or in parallel)
```

🔴 **The sole owner of the `shared` schema = the data-plane supply layer** (axis A of this design only consumes it and never creates it), so that the two designs do not each create it once.

🔴 **Stamping the table-ownership ledger must start with the project-isolation guard batch** (G5); otherwise tables created in the window between the guard batch and the migration layer carry no stamp → they all fall into `proj_default` at migration time.

🔴 **Axis B phase correction (resolving a review finding)**: the target segment in the pk/sk of the 5 result tables is a **breaking key change** and conflicts with the lossless-refactor batch's definition of "zero behavior change" ⇒ **axis B moves to the consumer-side batch** (consistent with the acceptance checklist), with a **dual-read + backfill + rollback** mechanism (see section 6.8).

### 6.7 ✅ Decision on the third open question: the lifecycle batch is accepted on **a same-jurisdiction second target with Redshift installed**; cross-jurisdiction items move to the consumer-side batch together with the third test target

**Deadlock**: the acceptance checklist defines the third test target as "Redshift installed + `jurisdiction≠home`", and the lifecycle batch's checks (warehouse queries hitting the right target, per-target materialization, code-table residency gating, per-target credentials) all depend on it; but a target with `jurisdiction≠home` **needs `residency-api` (delivered by the consumer-side batch) + a legal document (then rated a blocking prerequisite)** before it can be set active ⇒ the lifecycle batch cannot be accepted.

**Decision**: the acceptance target of the lifecycle batch becomes **a same-jurisdiction second target with Redshift installed** (warehouse queries hit the right target's workgroup / materialization per target / drift / per-target credentials — **these four are independent of jurisdiction**); the **cross-jurisdiction-only items** (code-table value residency gating, track 1 / track 2, axis C regional-side masking, axis D audit residency) **all move to the consumer-side batch and are verified with the third test target**. → The legal prerequisite blocks only the consumer-side batch, not the technical main line [🔴 withdrawn in revision 3.22: no legal gate, design decision 6quinquies; the code-table value residency gating is withdrawn as well].

🔴 **And the third test target does not require actually enabling an overseas region**: `jurisdiction` is only a descriptor attribute ⇒ **a second / third region in the same partition tagged `jurisdiction=eu-sim` can simulate it** (the acceptance checklist must say so, otherwise it is misread as "a European region must be enabled before acceptance").

🔴 **Revision 3.22 decision (the residency work; [the design document](./multi-region-execution-design.md), section 18, decision 6quinquies)**: the **go-live conditions of a cross-jurisdiction target = residency-api slice 1 (regional audit + result storage) + per-target execution roles (section 6.1, stage two) + the auditable closure (section 3.2 `residencyAudit`)**; **no legal gate** (the legal document in the paragraph above, "needs residency-api + a legal document before it can be set active", is withdrawn). Regional-side masking / direct regional API access → the regional-API work (an optimization, not a go-live condition). The third test target = `eu-west-1` / `jurisdiction=eu-sim` / `core + redshift + residency-api`, with all three engines really running ⇒ a 3×3 matrix.

### 6.8 🔴 Added in revision 3.0: migration mechanism for pk/sk changes (axes B/D + cost; retracting the wrong "zero table migration" assertion in the design document, section 10)

| Table | Change | Migration mechanism (decision) |
|---|---|---|
| `METRIC_VALUES` (pk becomes `<metricId>#<targetId>`) | breaking | **dual write + dual read + backfill**: during rollout write both the new and the old key; the read side queries the new key first and falls back to the old key on a miss; a background batch backfills existing data (metricId by metricId); once the backfill is complete and the observation window has passed, stop writing the old key. 🔴 **Home exemption**: for `targetId=tgt_home` the **new key == old key** (no suffix on the pk) ⇒ existing metric history needs **zero migration** (consistent with the home-exemption principle of FQN / OM) |
| `QUALITY_RESULTS` (sk gains the `<targetId>#` prefix) | breaking | as above; **home exemption**: home's sk gets no prefix ⇒ existing results stay readable |
| `bgp-audit` (pk sharded as `audit#<targetId>#<day>`) | breaking | 🔴 **read-side fan-out**: today `audit.ts:87` relies on the single key `pk="audit"` + `:88 ScanIndexForward:false` for a reverse-order read ⇒ change to **concurrent Query per shard key + in-memory merge** (per target × date window); the existing `pk="audit"` is kept read-only as **shard number 0** and is not migrated |
| `cost-daily`/`cost-runs` (sk gains a target segment) | breaking | the same home exemption + dual read; cost history is not migrated |
| 🔴 **The direction of the dual read must be gated by `isHome` (mandatory fix in revision 3.1)** | — | the original wording "the read side queries the new key first and **falls back to the old key on a miss**" is **dangerous**: for a non-home target a miss on the new key (e.g. `<metricId>#tgt_eu`) ⇒ falls back to `<metricId>` = **home's series** ⇒ **the "fall back to home" that this whole document forbids is resurrected at the result-table layer**, and in the cross-jurisdiction scenario = **an EU dashboard silently showing US numbers = a cross-border read**. **Decision**: only `isHome` may fall back to the old key; **a non-home miss = return empty (fail-closed)** and count a warning |
| 🆕 **task-runs must be backfilled too** (the original section 6.8 missed this table) | sparse GSI | a GSI does not index rows that lack the attribute ⇒ existing runs **all disappear** from the type-① reads. Backfill `targetId="tgt_home"` / `taskTargetKey="<taskId>#tgt_home"` / `startedAt`; **until the backfill is complete, type-① reads read both ways (a GSI miss falls back to the old SK path)** — the fallback is **safe** here because existing rows are home by definition |
| **Principle** | — | 🔴 **Any key design where "the home value == the old value"** (home exemption) downgrades a breaking change to **zero migration of existing data**; revision 3.0 applies it uniformly to the four tables + the lock attribute name (section 3.6). The closing sentence of [the design document](./multi-region-execution-design.md), section 10, "all attributes purely additive, zero table migration" **must be corrected** to "control-plane attributes are purely additive; the key changes of axes B/D and cost use the home exemption + dual read and backfill (**fallback limited to home**)" |

### 6.9 🔴 Added in revision 3.0: other decided items the specification had not yet carried + magnitude corrections

| Item | Topic | Decision |
|---|---|---|
| **Capability matrix** | **the `source-type × engine × target` capability matrix** (an adopted item of the independent architecture review; [the design document](./multi-region-execution-design.md), section 20.1, lists it as a specification deliverable) | build one matrix: rows = the 8 data-source types (MySQL/PG/Oracle/SQLServer/S3/DDB/Kinesis/MSK), columns = engine (Glue/EMR/Flink/DMS/ZeroETL) × target relationship (same target / cross-target same jurisdiction / cross-jurisdiction); each cell is marked `✅ supported / ⚠️ needs network connectivity / ⊘ unsupported / 🔴 needs residency approval`. 🔴 **JDBC sources are `tgt_home`-only in phase 1** (a Glue Connection is region-scoped and is not recreated in the target region; section 6.4); "can specify a remote region" ≠ "allowed to read across regions" — **a cross-target read is treated as data movement by default** and must pass the residency gate + cost estimate + audit, not merely a connectivity test |
| **Alerting** | two alerting sub-items | ① **SLA targets can be bound per region**: `SlaTarget` gains `targetId?` (defaults to inheriting the project level; a slow region may get a wider threshold); ② **a new "regional outage" rule type**: **zero runs** within the window for a target raises an alert (the current `no-run` never fires in merged mode) |
| **Diagnostic evidence** | diagnostic evidence collection `evidence.ts` | besides the CloudWatch read path, **Glue `GetJobRun` + Redshift-Data `DescribeStatement` + the region name in the prompt** all build their client / take their values from **the execution target of that run** (previously only the "CloudWatch read path" had been claimed) |
| **Lint guardrails** | **the mechanical lint guardrails extended to the new settlement points of the 4 axes** | forbid bare `new RedshiftDataClient/GlueClient` (must go through `getClient`), forbid bare task-runs `PutCommand/UpdateCommand` (must go through the stamping wrapper), forbid bare Bedrock `InvokeModel` (must go through `resolveModelIdRuntime`), 🆕 forbid hand-built FQN strings (must go through `authoritativeFqn`), 🆕 forbid bare `runId` string comparisons (must go through `parseRunId`), 🆕 forbid concatenating `runId` directly into a `#`-separated key. **Lands with batch G**. ⚠️ 🔴 **Exception: the rule "forbid bare `getRedshiftSecretArn` (must go through `getPrivilegedCred`)" is deferred to the data-plane supply layer** — during batch G the per-project secret does not exist yet and the `project-context` of `getPrivilegedCred` is in its transitional state (section 3.9); forbidding the old path while the new factory is "idling" **cannot both hold at the same time** |
| **Zero-ETL region check** | validation that both ends of Zero-ETL are in the same region | when the target is selected in the front end, validate that the source RDS and the destination namespace are **in the same region** (a research finding); if they differ, gray out + explain |
| 🔴 **Magnitude corrections** | three earlier underestimates (affecting the effort estimate) | ① the `bgp-workgroup` fallbacks 🔴 **re-measured in revision 3.8: 30 lines / 23 files** (the `\|\|`/`??` fallback form; all hits 67 lines / 39 files; all `bgp-*` fallbacks 73 lines / 51 files. The "46 lines / 28 files" and "15+" written in revision 3.1 are both withdrawn); plus ~20 places with the `"dev"` default database; ② process-level single-value caches: **at least 8 of the same kind** (originally written as 3): besides `admin-secret._arn`/`zeroetl._secretArnCache`/`platform-env._sgIdCache` there are also `realtime/dms-service.ts:50 _instanceArnCache`, `openmetadata/om-client.ts:8,10`, `diagnostics/devops-agent.ts:20 _spaceId`, `auth/verify-token.ts:21`, `middleware.ts:18` — 🔴 **the scope of this change explicitly covers only the first 3** (the others are unrelated to target; stated so that nothing looks omitted); ③ `aws:RequestedRegion` is **actually 19 places** (platform-stack 16 + emr 1 + netadvisor 1 + paramadvisor 1; originally written as ~16) |

## 7. No remaining "open before construction" items

All four items are decided (sections 6.1–6.4). The only remaining **external prerequisites** are: ① the **legal document** (for cross-jurisdiction target go-live; [the design document](./multi-region-execution-design.md), section 18, decision 6quater; non-technical); ② **the exact condition key names related to AWS CodeBuild overrides** (to be verified against the official IAM documentation when work starts; noted in section 2.1).

> Acceptance scripts follow the rule "verification scripts stay local and are never committed" (reused on the developer's machine, not checked into the repository).
