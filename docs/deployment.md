# Customer Production Deployment Manual (Multi-Region Edition)

> Document revision: **v1.33** (2026-11-09: section 7ter step 2 documents the two new upgrade-script steps 2c‴ (auto-registers external buckets referenced by existing home-region sync tasks as routes) and 2f (refreshes the EMR / Flink stacks);
> new section 7ter.1j, four things to know when upgrading to the version with lake table-bucket routing; section 8 marks the cross-bucket entry as fixed in 2.2.0, the 2.1.2 transition stays) ·
>
> Earlier revisions (39) are in the collapsible list below.

<details><summary>Revision history</summary>

- **v1.32** (2026-11-03: section 8 adds the production transition for "one batch job reading from and writing to several S3 Tables table buckets"
  (Job parameters `--conf` registering several catalogs + three-part names; the root fix ships with the lake-bucket-routing work, see [lake-bucket-routing.md](design/lake-bucket-routing.md));
  the customer has separately received the "Cross-table-bucket read/write handbook (2.1.2)") ·
- **v1.31** (2026-10-30 00:3xZ: **section 8 — the four data-source deletion / security-group entries changed to "fixed in the next version" + two new production transitions
  (stream-compute sample data producing few or no aggregation rows, Spark engine "Run" reporting 504 on cold start)**: all six were fixed on the development branch and verified in a test account by page-driven
  headless-browser acceptance; production `release-2026-10-29` still has them; transition measures as written in that section) ·
- **v1.30** (2026-10-29 07:4xZ: **hotfix 2.1.2.1 (`release-2026-10-29-b134`) upgrade path rehearsed in a test account in production mode ✅ (one paragraph added to the section 7ter.2 notice + the section 8 row
  on the bootstrap guard recurrence completed)**: from `release-2026-10-29` check out `release-2026-10-29-b134` + `npm ci` in both directories + `EXEC_REGION_CANDIDATES=all-enabled BGP_DEPLOY_MODE=production redeploy-platform.sh`
  **exited 0** (step 2b ExecEnvDeploy stack source package refreshed at 06:56Z, steps 2c / 2c′ / 2c″ all no-op, platform stack rolled 06:59–07:02Z, no downtime; IAM gate green),
  `GET /api/public/version` = `release-2026-10-29-b134` / the hotfix product commit / 2.1.2, the CodeBuild project `bgp-exec-env-deploy` carried only the variable `EXEC_ENV_SOURCE_REF` (**no** `BEDROCK_MODEL_ID`)
  ⇒ the page "Redeploy" preview got through bootstrap (build log `npx cdk bootstrap --app '' … ⇒ Environment … bootstrapped (no changes)`)
  ⇒ dialog "7 stacks, 0 changes in total; source has drifted and there is no explicit wave authorization ⇒ approval required" (the preview build exits 1 by design = the approval checkpoint of the preview gate)
  ⇒ approve ⇒ deployment build SUCCEEDED ⇒ "Check initialization" ⇒ active;
  the test account's home region is in the United States ⇒ the half of the fix where the guard would actually fire can still only be covered by the offline synth gate + a regression after it lands in customer production) ·
- **v1.29** (2026-10-29 04:0xZ: **record of the customer production upgrade `release-2026-10-13` → `release-2026-10-29` (2.1.2) (one paragraph added to the section 7ter.2 notice) + 🔴 new section 8 entry for the bootstrap guard
  recurrence + section 7ter.1c row 2 corrected**: control plane 47.5 minutes, exit 0 (step 2c″ OpenMetadata database 8.0.46 → 8.4.11 in 11 minutes / IAM gate green across 18 regions), three agents refreshed,
  truth check 16 ✅ + 1 not run (password file path);
  the first "Redeploy" preview of an execution region hit the **bootstrap guard** — the `cdk bootstrap` line of the buildspec carries no `-c` and still executes the CDK app ⇒ a non-US home region hits the "default model geography guard",
  a recurrence of the 2026-10-19 incident; the statement in section 7ter.1c row 2 that "the new version no longer needs the transition variable" was wrong ⇒ after the transition variable was added back both regions redeployed successfully;
  the root fix `cdk bootstrap --app ''` is coded as a hotfix and ships with the hotfix tag / the next version) ·
- **v1.28** (2026-10-29 00:5xZ: **2.1.2 (`release-2026-10-29`) forward upgrade rehearsed once more in a test account in production mode ✅ (one paragraph added to the section 7ter.2 notice)**:
  a production-mode test account rehearsed with `release-2026-10-29` ✅ (2026-10-28 15:34–16:27Z: platform `redeploy-platform.sh` 37 minutes, exit 0, steps 2c′ / 2c″ no-op, no downtime window;
  agents `--check` said "matches local HEAD, no refresh needed for this version";
  execution region page "Redeploy" 9 minutes, the preview dialog truthfully said "source has drifted and there is no explicit wave authorization ⇒ administrator approval required";
  truth check 17 ok / 0 bad;
  footer / version card / `GET /api/public/version` = `release-2026-10-29` + 2.1.2;
  10 continuity checks, 0 failures, 0 recorded — the two scheduled syncs / the orchestration / the job all succeeded at the first tick after the upgrade, the DMS real-time task stayed running across the upgrade,
  editing and saving existing objects worked, Glue job version / scripts / warehouse counts unchanged);
  in addition a two-region demo account upgraded to the same tag ran the customer-facing feature walkthrough: 31 segments, 29 green, 2 non-product reds (a template segment blocked by the "only run in seed accounts" guard;
  a chaining script passed the second region's variable as an empty string ⇒ the fixture CLI endpoint was invalid, the product was not exercised);
  **all prerequisites for upgrading `customer-prod` are met, waiting for the user to give a time window**;
  this version is not yet installed in customer production, which is still `release-2026-10-13`) ·
- **v1.27** (2026-10-28 15:3xZ: **release 2.1.2 (`release-2026-10-29`;**
  **root fix for the home-region "New data source" request path having no timeout budget)**: section 1 row 0 code retrieval switched to the new tag;
  new **section 7ter.1h** "three things to know when upgrading to the version with that fix" (data-source creation follows the long-running-operation protocol: 201 within 45 seconds, otherwise 202 + page polling, never 504 / no fork / no duplicate creation;
  Glue role verification moved out of the request path;
  network budget for every SDK client;
  2.1.1 → 2.1.2 differs in only 15 `platform/` files ⇒ only the platform ECS service rolls, execution regions / database stack / agents zero diff, no downtime window;
  rollback = check out the 2.1.1 or 2.1.0 tag itself);
  the section 8 row for that defect changed to "fixed, from `release-2026-10-29`";
  the full headless acceptance round on the 2.1.2 product bytes stamped fail at 12:39Z ⇒ three-state breakdown: 0 product reds (78/78 segments produced a regular summary, 0 interruptions;
  three red items were criteria defects (counting only the first page / counting the whole table inside a parallel pool), 28/28 · 5/5 after fixing and rerunning them singly;
  one was the already registered orphan-security-group boundary + a rerun 43/43;
  two were caused by an operator deleting a showcase data source's platform security group by mistake at 07:33Z ⇒ the same product bytes rerun in another test account 17/17 · 27/27) ⇒ qualified as pass;
  the production-mode rehearsal with 2.1.2 is still to run, result written back in the next revision) ·
- **v1.26** (2026-10-27 09:3xZ: **2.1.1 (`release-2026-10-28`) forward upgrade rehearsed once more in a test account in production mode ✅ (one paragraph added to the section 7ter.2 notice)**:
  platform 38 minutes, exit 0; agents `--check` "no refresh needed for this version"; execution region page "Redeploy" preview 0 changes (that environment had already received the IAM of the 2026-10-27 fix batch;
  customer production upgrading from `release-2026-10-13` will list `-base` / `-core` / `-redshift` IAM changes); truth check 0 red; footer / version card / version endpoint = tag + 2.1.1;
  10 continuity checks, 0 failures, 0 recorded — scheduled sync / orchestration / job all succeeded at the first tick after the upgrade, **the DMS real-time task stayed running across the upgrade** (a real carrier this time),
  editing and saving existing objects worked, Glue job version / scripts / warehouse counts unchanged) ·
- **v1.25** (2026-10-27 08:2xZ: **release 2.1.1 (`release-2026-10-28`;**
  **root fixes for the customer feedback of 2026-10-27 (own table bucket in execution regions / DMS failure not shown in the list) + template-table sample columns + the Redshift table-marker transient error)**:
  section 1 row 0 code retrieval switched to the new tag;
  new **section 7ter.1g** "four things to know when upgrading to that version" (execution region page "Redeploy" to pick up the new IAM of the `-core` / `-redshift` stacks;
  external table bucket registration = visible + writable;
  the target-table name collision guard rejects saving and the next start of existing colliding tasks;
  transition for the unmarked empty table;
  2.1.0 → 2.1.1 scripts / database stack / agents zero diff ⇒ no downtime window, no agent refresh);
  section 8 gains two rows (fixed, from `release-2026-10-28`);
  section 7ter.2 rollback wording unchanged (back to 2.1.0 ⇒ check out `release-2026-10-27` itself);
  this version is not yet installed in customer production, which is still `release-2026-10-13`) ·
- **v1.24** (2026-10-26 23:4xZ: **round-trip rehearsal, all three phases green, written back (section 7ter.2 notice)**: upgrade → hotfix rollback → upgrade again, scheduled tasks ran normally throughout;
  rollback does not require redeploying execution regions;
  figures in the notice) ·
- **v1.23** (2026-10-26 13:4xZ: **release `release-2026-10-27` (`VERSION` 2.1.0;**
  **every fix batch from 2026-10-13 to 2026-10-26 ships with this tag)**: section 1 code retrieval / section 2 / section 7 / section 7ter steps 2 · 4 / the five section titles 7ter.1b–1f / every "development branch …, pending release"
  in section 8 changed to "from `release-2026-10-27`";
  section 7ter.1f row 3 corrected the residual "the old tag's script does not touch the database stack" to the rollback fact (the original tag's script does touch the database stack and is refused by RDS; roll back with the hotfix tag);
  this version is not yet installed in customer production,
  which is still `release-2026-10-13`,
  upgrade per section 7ter + the production baseline record) ·
- **v1.22** (2026-10-26 10:1xZ: **rollback wording rewritten (section 7ter.2)**: rolling back to `release-2026-10-13` must check out the hotfix tag `release-2026-10-13-rollback` (= `release-2026-10-13-b103` + one line `--exclusively`
  in `redeploy-platform.sh`, product bytes unchanged) — the original tag's script would, in the "WAF / OM service stack" step, also downgrade the OpenMetadata database stack back to MySQL 8.0,
  be refused by RDS and abort,
  leaving the platform stack not rolled back;
  confirmed by a real production-mode rehearsal in a test account on 2026-10-26 (the original script fails / the hotfix rollback succeeds in 17 minutes, IAM gate green, truth check all green, sync / orchestration / job each ran one round successfully on the old version);
  the notice "rollback has not been rehearsed in a real environment" withdrawn) ·
- **v1.21** (2026-10-26 03:5xZ, development branch, pending release: new section 7ter.1f "four things to know when upgrading to the version with the OpenMetadata database MySQL 8.0 → 8.4" —
  `redeploy-platform.sh` gains step 2c″ deploying the database stack; the RDS in-place major version upgrade has one downtime window (test account, Multi-AZ db.t3.small, measured: database stack step 9.5 minutes,
  OpenMetadata database connection interrupted about 2 minutes, containers not restarted);
  the master user omadmin logs in as usual under the 8.4 default parameter group `mysql_native_password=ON`;
  RDS does not support downgrades, rolling back the code does not roll back the database version, restore from the pre-upgrade snapshot when needed (section 7ter.2 item 3 supplemented);
  eliminates the RDS extended support fee ≈ $292 / month) ·
- **v1.20** (2026-10-26 01:3xZ, development branch, pending release: new section 7ter.1e — upgrading to the version where the network advisor probes by the place's region **must** also run `redeploy-agents.sh` —
  the skill Lambda is deployed only by the agent stack; refreshing only the platform leaves the "Analyze network" advice based on the home-region network (two test accounts hit it on 10-25);
  the fixes of the same batch (field masking by physical column, DMS "Start" accepted immediately, per-node orchestration configuration, S3 object-store sources through the sync wizard) need no customer action;
  product code see the CHANGELOG `[Unreleased]` section) ·
- **v1.19** (2026-10-23 05:5xZ, development branch second batch, pending release: section 7ter.1d four things → five things, row 5 = the second batch of 14 operations joining the unified framework
  (governance "Sync column information" / delete workspace / sync wizard generate DDL · execute table creation / stream job start / stop / delete / orchestration publish · take offline · trigger · delete / S3 external table / metrics and model-metric computation),
  the dedicated 202 protocols of catalog column sync and workspace deletion retired, enable/disable schedule shares the same guard;
  section 8 "Connected shown right after creation" row changed to "fixed on the development branch, pending release", the catalog column-sync row notes "replaced by the second batch") ·
- **v1.18** (2026-10-22 08:3xZ, development branch, pending release: new section 7ter.1c row 5 — when upgrading with `EXEC_REGION_CANDIDATES=all-enabled`, the old script reports
  "the allow-list covers every candidate probe region…" and exits 1 right before the final IAM simulation gate, although the platform is in fact already upgraded;
  the script with the fix picks the probe region from the regions the account has not opted in to, does not abort when none can be found, and the gate verdict honestly distinguishes "green / cannot be verified in this account") ·
- **v1.17** (2026-10-22 03:1xZ, development branch, pending release: the long-running-operation framework — section 7 red lines add "`-c long-ops-sync-wait-ms` is an acceptance knob, do not pass it in production";
  new section 7ter.1d "four things to know when upgrading to the version that includes it" (new table `bgp-long-ops` created by step 2c′ / the empty `bgp-ai-tasks` shell in pre-release test environments / `AI_*` environment variables removed /
  operations longer than 45 seconds show "Running in background" and modify / delete on the same object is blocked with 409);
  the section 8 row on modeling landing 504 changed to "root-fixed on the development branch, still present on the production tag") ·
- **v1.16** (2026-10-21 09:27Z, development branch, pending release: section 7ter gains step 4 "verify the version" — the login page footer / "Settings → Platform version" / `GET /api/public/version` show the release tag directly
  (baked in from git facts at image build time); where the production tag does not have this item yet, use the three-carrier method of [AGENTS.md](../AGENTS.md);
  product code see the CHANGELOG `[Unreleased]` section) ·
- **v1.15** (2026-10-20 05:2xZ, development branch, pending release: section 7ter step 2 and section 7ter.1 row 8 state that the upgrade script gains step 2c′ deploying the DynamoDB database stack —
  until then the upgrade path did not deploy the database stack, so tables added by a new version (in this batch `bgp-ai-tasks`) were never created and every endpoint using them returned 500;
  hit for real when upgrading a test account to the version with AI long calls) ·
- **v1.14** (2026-10-19 afternoon, development branch candidate pre-authorization wording, pending release: section 2 adds `EXEC_REGION_CANDIDATES` pre-authorizing candidate execution regions ·
  section 7 steps 1 / 2 / 3 rewritten as "pre-authorized regions need no authorization run" · new section 7ter.1c "four things to know when upgrading to the version with candidate pre-authorization + the CodeBuild guard and advisor-role fixes"
  (the upgrade wipes the CodeBuild transition variable but the new version no longer needs it;
  the advisor-role fix requires `redeploy-agents.sh`);
  product code see the CHANGELOG `[Unreleased]` section) ·
- v1.13 (2026-10-19, the record of adding the Frankfurt region in customer production written back (same content as manual v1.10 on tag `release-2026-10-13`): section 7 points to the new customer-reality expansion
  [adding-a-region.md](adding-a-region.md) (customer deployment machine obtaining the code from scratch, the three code gates, the "will change / will not change" list of the authorization step, the operations-side automation script)
  and pins that the step 2 command must carry `BGP_DEPLOY_MODE=production` / `BEDROCK_MODEL_ID` when needed ·
  section 8 adds the **non-US home region incident** (creating an execution region from the page is hit by the default-model geography guard; transition = add `BEDROCK_MODEL_ID` to the CodeBuild project, root fix pending);
  product code unchanged) ·
- v1.12 (2026-10-16, development branch federated-catalog wording, pending release: section 3 truth check 9 → 10 items (item 10 S3 Tables federated catalog `s3tablescatalog`) ·
  section 7ter step 2 notes that the upgrade script's step 3c opens the federated catalog in the home region and every execution region ·
  section 8 adds "an environment that never ran a sync writing S3 Tables ⇒ Lake Query / Ask-Your-Data CATALOG_NOT_FOUND", fixed pending release, with the production transition command) ·
- v1.11 (2026-10-14, development branch multi-vendor model channel wording, pending release: section 1 rows 1 / 2b / 5 model requirement changed to "any one of the candidate chain suffices"
  (Claude Opus 4.5 → GLM 5.3 → Kimi K3, pre-flight item 7 makes a real call per candidate) · section 2 ③ candidate-chain algorithm ·
  new section 7ter.1b "upgrading to the version with the multi-vendor channel: the agent containers changed, **`redeploy-agents.sh` must be run**" ·
  section 8 adds three entries: GLM 5.3 account-level enablement / Kimi K3 reasoning blocks and token cost / GPT series still gated) ·
- v1.10 (2026-10-14 02:xxZ, development branch wording: **section 7ter step 2b changed from a manual command block to `scripts/redeploy-agents.sh`** (written, pending one real run in a test account, ships with the next release;
  the repository at the production tag `release-2026-10-13` has no such script — when upgrading from that tag check out the new tag first, then run it) · section 7ter.2 rollback wording synchronized ·
  section 8 adds the "agents not refreshed by the upgrade script" row marked "fixed, pending release") ·
- v1.9 (2026-10-14, corrections after an item-by-item comparison of the document against the scripts: section 0 origin-verification wording ·
  section 7 button label "Start deployment" · section 7bis retention list adds CMK / namespace·workgroup / DAG bucket / regional audit ·
  **section 7ter gains step 2b "refresh the three AgentCore images and stacks when the new version changed the agent containers" (redeploy-platform does not do it)** ·
  section 7ter.1 row 7 Ask-Your-Data recipes ·
  section 7ter.2 rollback wording adds the agents ·
  section 8 data-source probe row made precise to "Detect / Browse tables" and the agents row added ·
  the section 7 reference moved to the development-environment runbook) ·
- v1.8 (2026-10-13, development branch wording: the five known boundaries in section 8 (saving a sync task with an existing Glue job 502 / Glue version for S3 Tables / data-source probe from the control plane /
  own table bucket invisible / scheduler page false alarm) marked "fixed (development branch), delivered with the next release;
  production tag `release-2026-10-13` still has them", plus two new entries ("Connected" right after creation only checks that the Glue connection exists, registered but not fixed /
  catalog "Sync column information" over 60 seconds reported as "sync failed" by the load balancer, fixed pending release);
  after a cold-start handover rehearsal added section 7ter.2 rollback · section 4 item 4, the Cognito command for a sole administrator who forgot the password) ·
- v1.7 (2026-10-13, reconciled line by line with the code of release `release-2026-10-13`: section 1 the real model call happens only when `BEDROCK_MODEL_ID` is **not** given explicitly · factory model written with its full id ·
  pre-flight probes 3 S3 buckets · section 4 the initial password is also printed to the deployment stdout · section 8 adds five known boundaries;
  new AI handover entry `AGENTS.md`) ·
- v1.6 (2026-10-13 early morning, section 8 adds two known boundaries: the customer's own table bucket is not yet visible in the platform (transition = hand-written three-part names in Lake Query) ·
  a failed data-source probe from the control plane does not affect sync) ·
- v1.5 (2026-10-12 late night, release `release-2026-10-13` = the data-sync capability completion batch + multi-region placement of the backfill center: section 1 code retrieval switched to the new tag ·
  section 7ter.1 title pinned to release-2026-10-13 ·
  section 8 backfill center restriction row changed to "fixed and verified in a real environment") ·
- v1.4 (2026-10-12, reconciled line by line with the code of release `release-2026-10-12`: section 1 adds code retrieval / tool list / model version / the two ignorable ❌ classes of the pre-flight check / no VPC import ·
  section 3 changed to running `02-postdeploy-truth.sh` ·
  new section 7bis retiring an execution region ·
  section 7ter upgrading ·
  section 8 adds the data-plane credential default taskrole) ·
- v1.3 (2026-10-11, section 8 writes back the cross-jurisdiction real-environment verification conclusions ·
  the three scheduling / landing capabilities delivered ·
  section 7 adds "Check initialization → Enable") ·
- v1.2 (2026-10-10, section 8 adds known boundaries: jurisdiction label ·
  cross-jurisdiction not yet verified in a real environment ·
  execution regions cannot be trimmed ·
  the three scheduling / landing capabilities in progress ·
  phase-two items) ·
- v1.1 (2026-10-10, section 8 writes back the conclusions of the from-scratch production rehearsal in a second account) ·
- v1.0 (2026-10-09, first production go-live batch)

</details>

> Applies to: deploying the Kingfisher multi-region edition into the **customer's own AWS account** as the production environment
>
> - Companion document: [operations.md](operations.md) (pre-flight check when switching accounts / workarounds for restricted accounts / post-deploy truth criteria; referenced in several places below).
>   The disposition and acceptance status of every item of the first production go-live batch is tracked in the engineering defect records.
> - 🔴 This document describes the **production** path only. Demonstration / acceptance environments (seed data, demonstration MySQL, 5 test accounts) use `BGP_DEPLOY_MODE=demo` and are out of scope here.

## 0. Deployment topology (align on this first)

- **One account × many regions**: one **home region** (control plane: web pages, metadata, OpenMetadata, the Ask-Your-Data agent) + N **execution regions** (each with its own warehouse / data lake / scheduling / compute).
  The customer chooses the home region; execution regions are listed from the regions **actually enabled** in the account (the "New execution environment" wizard queries them live every time it is opened or "Refresh" is pressed).
- **A region can hold only one execution environment** (a product guard; regions already taken are listed in the wizard but cannot be selected).
- The only public entry points are CloudFront (one for the platform pages, one for OpenMetadata), both behind WAF; the security groups of the origin ALBs admit only the CloudFront prefix list
  (the OpenMetadata ALB additionally verifies an origin header).

## 1. Before deployment (customer-side preparation + pre-flight check)

| # | Item | How / criterion |
|---|---|---|
| 0 | 🔴 **Get the code** | You must `git clone` and check out the release tag: `git clone --branch release-2026-10-29 <repository-url>` (for an already installed environment being upgraded, use `git fetch --tags && git checkout release-2026-10-29` instead, section 7ter). **From 2.2.0 on, release tags are uniformly named `v<version>` (for example `git clone --branch v2.2.0 …` / `git checkout v2.2.0`); `release-<date>` tags are historical and remain checkable; the footer and `GET /api/public/version` recognize both naming forms.** The delivery archive produced by the release machine can be used instead of a clone: after receiving `kingfisher-<tag>.tar.gz` and its `.sha256`, first run `sha256sum -c kingfisher-<tag>.tar.gz.sha256`, then `tar -xzf` to unpack and enter `kingfisher-<tag>/`; the archive contains no tests or developer tooling, and `BUILD-INFO.json` at its root lets the footer and the version endpoint still show the release tag. Do not use a ZIP exported by hand from a web page (it carries no build facts; the footer would show "build information unavailable"). 🔴 **An export without `.git`, such as GitHub "Download ZIP", cannot be used** — deployment step 4 tags the three AgentCore agent images with the git short hash, and without `.git` the script exits on the spot (by then the dozen-plus stacks of step 3 are already built, and the only way forward is to resume the run) |
| 1 | Choose the **home region** | The customer's choice. 🔴 The region must offer all of: Bedrock (candidate chain Claude Opus 4.5 → GLM 5.3 → Kimi K3, **any one** callable is enough; since the multi-vendor model channel), Redshift Serverless, S3 Tables, AgentCore, MWAA Serverless. The deployment script validates the candidate chain **by real calls, one candidate after another** (see section 2 item ③) and stops if none works — 🔴 only when **no** explicit `BEDROCK_MODEL_ID` is given; when a model is specified explicitly the script adopts it without a real call; validate it yourself beforehand with `aws bedrock-runtime converse`. Every execution region must also offer Redshift Serverless / S3 Tables / Managed Flink / DMS / MWAA Serverless |
| 2 | Administrator permissions | The deployment identity must be able to create IAM roles, VPCs, Cognito, CloudFront, WAF (us-east-1) and so on. 🔴 **The organization SCP must not block us-east-1**: when the home region is not us-east-1 the script bootstraps us-east-1 and creates the CloudFront WAF there |
| 2b | Pre-flight check | `./scripts/01-preflight-account.sh <profile> <home-region> <execution-region>` — 🔴 **the third argument (the first execution region you plan) must be given explicitly**: it defaults to us-west-2, and when that region is blocked by the organization SCP the check reports a hard failure. Do not start the deployment with an unfixed ❌ (details in [operations.md](operations.md)), but two classes of ❌ can be ignored: ① when using the script of the production tag `release-2026-10-13` with a home region outside the United States, item 7 (a real call with the factory `us.` model id) always reports ❌ — the model chosen in deployment step 2 from the home region's real values is what counts (since the multi-vendor model channel, item 7 expands the candidate chain one by one into the region's inference profiles and makes real calls, naming "which candidate is usable", so this false alarm no longer occurs); ② a ❌ caused by the third argument defaulting to a region blocked by the SCP — rerun with the execution region you actually intend to use. 🔴 **Inform the customer**: the pre-flight check **really creates and immediately deletes** one IAM role / one Cognito user pool / S3 buckets in the customer account (the S3 probe actually creates **3** buckets: home region, execution region and a comparison region `KF_T3_REGION` (default eu-west-1; a denial in that region is only a soft warning)) (reversible write probes) |
| 3 | Network | The platform creates its own VPC (a brand-new network; no connectivity to the customer's existing network is required). 🔴 **A multi-region production install cannot use "import an existing VPC"** (see [operations.md](operations.md)): in import mode the home region does not create the DynamoDB interface endpoint used for cross-region private networking, after which **no non-home execution environment can be built** (the deployment mechanism refuses outright). If the VPC quota is full, raise the quota first |
| 4 | Deployment machine tools | git, Docker + buildx, Node 20+, AWS CLI v2, python3, zip, curl, 🔴 **plus Maven + JDK 17**: the Flink runner JARs are built on the spot with mvn by the deployment script; without mvn the deployment **still exits 0**, but "Stream Compute" is unusable end to end (a job fails as soon as it starts). Run `npm ci` once in each of the repository's `infra/` and `platform/` |
| 5 | Model access | In the home region (and in every execution region where Ask-Your-Data will be used) enable **at least one** model of the candidate chain in Bedrock: **Claude Opus 4.5** (factory default `us.anthropic.claude-opus-4-5-20251101-v1:0`, full id; when copying it into `BEDROCK_MODEL_ID` do not drop the `us.anthropic.` prefix), **GLM 5.3** (`zai.glm-5.3`), **Kimi K3** (`moonshotai.kimi-k3`); the latter two can only be invoked on Bedrock through `us.` / `global.` inference profiles; the deployment script expands them automatically from the home-region account's real values, the customer does not write the prefix. 🔴 GLM 5.3 may be **not enabled at account level** (Bedrock's words: "not available for this account"); that is not a region / permission problem — ask your AWS account team to enable it; the script falls through to the next candidate automatically. To pin a model, prefix the deployment command with `BEDROCK_MODEL_ID=<id>`. The first invocation may require the `aws-marketplace:Subscribe` permission to complete the subscription. After go-live the default can also be hot-switched under "Settings → AI model" among the four families Claude Opus / GPT-5.6 / GLM 5 / Kimi K3 (the server probes the model for real first; GLM / Kimi / GPT additionally need the tool-use probe to pass before the change takes effect) |

**What the pre-flight script checks** (retained from the earlier English edition of this manual; it expands row 2b):

| # | Check | Result class |
|---|---|---|
| 0 | Caller identity resolves for the profile | Hard failure if credentials are missing or expired |
| 1 | Foreign stacks in the target regions | Soft warning (shared or busy account) |
| 2 | VPC quota in both regions | Hard failure when the region is at its limit |
| 3 | Elastic IP usage | Soft warning (the home VPC needs two NAT gateways) |
| 4 | IAM role creation | Hard failure; creates and deletes a probe role |
| 5 | Cognito administrative writes | Hard failure if no user pool can be created; otherwise soft warning (Lambda fallback) |
| 6 | Foreign asset bucket names in `infra/cdk.out` | Hard failure; delete `infra/cdk.out` |
| 7 | Bedrock candidate chain, real `converse` call | Hard failure when no candidate answers |
| 8 | CDK bootstrap, Docker, buildx, `node_modules` | Hard failure when a tool or dependency is missing |
| 9 | Region allow-list measured with a reversible write | Hard failure when a planned region is denied |

Hard failures make the script exit non-zero; fix them before installing. Account ids are printed with the last four digits only.
Listing a Bedrock model as active is not proof that it can be invoked; only the real call counts.

## 2. Deployment (one command)

```bash
BGP_DEPLOY_MODE=production ./scripts/deploy-all.sh <profile> <home-region>
```

- 🔴 **Both positional arguments must be written**: when omitted they silently fall back to defaults (profile `temp-account` / region `us-east-1`).
  When the home region is not us-east-1 the script prints one English WARNING line saying "only us-east-1 is tested" — that is an old notice and **can be ignored**
  (a us-west-2 home region has been rehearsed from scratch in a brand-new account, see section 8).
- Optional switches: `SKIP_CLOUDTRAIL=1` (skip when the organization SCP forbids creating a CloudTrail trail; VPC Flow Logs are still created) · `OM_INGESTION=1` (also installs the OpenMetadata ingestion connector stack; not installed by default).
- 🆕 **Pre-authorize candidate execution regions (released 2026-10-27, from `release-2026-10-27`)**: `EXEC_REGION_CANDIDATES="eu-central-1,ap-northeast-1" BGP_DEPLOY_MODE=production ./scripts/deploy-all.sh <profile> <home-region>` —
  authorizes **once, at install time** the regions in which execution regions may be created later (written into the platform IAM region condition and SSM `/bgp/wiring/execution-region-candidates`),
  - after which creating an execution region in those regions is **done entirely on the page** (New → build → Check initialization → Enable),
  - and the authorization command of section 7 step 2 is no longer needed.
  - Write full region names (no abbreviations); they must be regions enabled in the account; `*` is not accepted;
  - `all-enabled` = every region currently enabled in the account;
  - when not given, only the home region is authorized (as before; any later `redeploy-platform.sh` run can add the declaration, `none` revokes it).
  - The cost: in these regions the platform role is allowed to call the data-plane APIs before an execution environment exists there (the application-layer place check still blocks it); name regions deliberately, do not open everything for convenience.
- `BGP_DEPLOY_MODE` **must be given explicitly** (otherwise the script exits 2 immediately). `production` = no seed data, no demonstration MySQL, Cognito gets only the single user `admin`;
  the mode is written to SSM `/bgp/deploy-mode`, and later redeployments are **not allowed** to switch the mode silently.
- Three things the script does itself that relate to "the customer chooses the home region" (from the first production go-live batch):
  ① when the home region is not us-east-1 it **additionally bootstraps us-east-1** — the WAF rules used by CloudFront can only be created in us-east-1 (an AWS rule), and their ARN is handed to the home region through a CDK cross-region reference;
  ② the CloudFront origin prefix list is looked up by name **at deployment time** from the region's real values (there is no longer a hard-coded region table);
  ③ the default model is chosen from the **candidate chain** against the **home-region account's real values** (since the multi-vendor model channel; `candidateModelIds` in `platform/ai-model.json`: Claude Opus 4.5 → GLM 5.3 → Kimi K3):
  for each candidate, list the region's inference profiles → derive the real base model the profile points to → make real calls in turn with "the region's geographic profile → `global.` → the base id", one each → the first success takes effect (`scripts/resolve-home-model.sh`);
  - if nothing in the whole chain works ⇒ the deployment stops and lists, item by item, "candidate → ids tried — Bedrock's message".
  - To pin a model: put `BEDROCK_MODEL_ID=<id>` in front of the command (an explicit value is not validated by a real call; validate it yourself first with `aws bedrock-runtime converse`).
- The OpenMetadata factory administrator password `admin/admin` is replaced during deployment by the random password in Secrets Manager `bgp/om/admin-password`
  (`scripts/om-secure-admin.sh`, with verification: the new password can log in ∧ the factory password cannot, otherwise the deployment fails).
- 🔴 Keep the platform data-plane credential mode at its default `taskrole`: **do not** add `-c dataplane-creds=…` to the deployment (that is the observe / enforce switch for acceptance; it is not written to SSM, and the next redeploy silently returns to taskrole).
- 🔴 Keep the long-running-operation synchronous wait at its default 45 seconds: **do not** add `-c long-ops-sync-wait-ms=…` to the deployment (since the long-running-operation framework; it is an acceptance knob that forces every long operation onto the 202 path;
  it is not written to SSM, and the next redeploy silently returns to 45000).
- Duration about 60–90 minutes. Resuming after a failed step: see [operations.md](operations.md).

**Installer options** (retained from the earlier English edition; all are environment variables placed in front of the command):

| Variable | Meaning | Default |
|---|---|---|
| `BGP_DEPLOY_MODE` | `production` or `demo`; required, written to SSM `/bgp/deploy-mode`, immutable afterwards | none, exit 2 |
| `EXEC_REGION_CANDIDATES` | Comma-separated full region names, `all-enabled`, or `none` | only the home region |
| `BEDROCK_MODEL_ID` | Pin the default model; skips the real-call validation | chosen from the candidate chain |
| `BGP_PW_FILE` | Where the initial `admin` password is written | `/tmp/bgp-cognito-pw-<profile>.json` |
| `BGP_ADMIN_PASSWORD` | Supply the initial `admin` password instead of generating one | random |
| `SKIP_CLOUDTRAIL` | `1` skips the CloudTrail trail (VPC flow logs still created) | `0` |
| `OM_INGESTION` | `1` also deploys the OpenMetadata ingestion connector stack | `0` |
| `DEPLOY_REALTIME` / `DEPLOY_FLINK` / `DEPLOY_EMR` | `0` skips the corresponding optional base stack | `1` |

**What the installer does** (retained from the earlier English edition). The script is idempotent where it matters and runs these phases in order:

1. Tool and credential pre-flight; dependency self-heal (`npm ci` if `node_modules` is missing).
2. Account-level prerequisites (service-linked roles, DMS roles).
3. CDK bootstrap of the home region, plus `us-east-1` when the home region differs (CloudFront WAF).
4. Candidate-region declaration and CDK asset integrity repair.
5. Foundation stacks: KMS, WAF, VPC, DynamoDB, FinOps tables, Cognito, Redshift Serverless, OpenMetadata database, search and service, AI base stacks.
6. Build and push the three AgentCore agent images (ARM64, tag = git short hash), then create the three runtimes.
7. Platform stack (ECS Fargate, ALB, CloudFront) wired to OpenMetadata and the three agents.
8. Execution-environment deployer stack (broker Lambda and CodeBuild project) and the home MWAA Serverless entry stack.
9. Audit stack (CloudTrail and VPC flow logs); real-time, Flink and EMR base stacks (near-zero standing cost).
10. Optional OpenMetadata ingestion stack; compute-engine JARs uploaded to the scripts bucket (Flink runners built with Maven if missing).
11. Cognito groups and the initial `admin` user; registry row for the home execution target `tgt_home`.
12. Post-deploy wiring gate with automatic repair.

Wiring facts (OpenMetadata URL, agent runtime ARNs and memory ids) are written to SSM under `/bgp/wiring/*`. Later deployments read them back, so a bare redeploy cannot silently clear them.

**What gets created** (retained from the earlier English edition). Control-plane stacks, all named `Bgp*Stack`:

| Stack | Purpose | Condition |
|---|---|---|
| Kms | Two customer-managed keys: data and logs | always |
| Waf | Web ACLs for both CloudFront distributions | always, in `us-east-1` |
| Vpc | Home VPC with two NAT gateways and a DynamoDB interface endpoint | always |
| Database | Platform DynamoDB tables | always |
| FinOps | Cost-governance tables | always |
| Auth | Cognito user pool and client | always |
| Audit | CloudTrail trail and VPC flow logs | always |
| Platform | Web application on ECS Fargate, task role, ALB, CloudFront, two tables | always |
| OmDatabase / OmSearch / OmService | OpenMetadata database, search domain and service | always |
| Redshift | Home Redshift Serverless namespace and workgroup | always |
| AirflowServerless | Home MWAA Serverless entry (bucket, security group, role) | always |
| ExecEnvDeploy | Broker Lambda `bgp-exec-env-broker` and CodeBuild project `bgp-exec-env-deploy` | always |
| AgentCore / NetAdvisorAgentCore / ParamAdvisorAgentCore | Three agent runtimes | always |
| Realtime / Flink / Emr | DMS, Managed Flink and EMR Serverless base roles | `DEPLOY_*` flags |
| Rds | Demonstration MySQL source database | demo mode only |
| Mwaa | Classic MWAA environment | `-c classic-mwaa=1` only |
| OmIngestion | OpenMetadata scheduled ingestion | `OM_INGESTION=1` |

Each execution region later receives its own stack group `BgpExecEnv-<slug>-*` (section 7).

**Duration and failures** (retained from the earlier English edition):

- A fresh install takes roughly 60 to 90 minutes, dominated by image builds and the OpenMetadata and search stacks.
- The user-creation and seed steps do not abort the run. Their failures are recorded, the remaining independent steps continue, and the script exits non-zero at the end with the list of failed steps.
  The infrastructure is in place; only those steps need a rerun.
- Expired credentials stop the scripts before any change is applied. Refresh and rerun.
- To rerun a single late step:

```bash
BGP_DEPLOY_MODE=production ./scripts/10-bootstrap-cognito.sh <profile> <home-region>   # groups and admin user
BGP_DEPLOY_MODE=production ./scripts/redeploy-platform.sh <profile> <home-region>      # wiring and platform stack
```

`10-bootstrap-cognito.sh` compares its mode with SSM `/bgp/deploy-mode` and refuses a mismatch.

## 3. After deployment: post-deploy truth check (exit 0 does not count)

🔴 Run it once **before changing the admin password in section 4** (item 5 logs in with the initial password the deployment wrote to disk):

```bash
./scripts/02-postdeploy-truth.sh <profile> <home-region>
```

- 10 truth queries (all stacks green / ECS running == desired / entry point reachable / unauthenticated 401 / can log in and carries the bgp-admin group / key table / AI wiring / execution-environment deployment mechanism /
  registry home already active / S3 Tables federated catalog `s3tablescatalog` opened (since the federated-catalog fix; the script of `release-2026-10-13` has 9 items)); only all ✅ counts as in place;
- the meaning of each item: see [operations.md](operations.md) and the table below.
- When the home region is not us-east-1, also check that `BgpWafStack` in us-east-1 is COMPLETE.
- Also check the Flink JARs: `s3://bgp-glue-scripts-<account-id>/flink/` must hold 3 runner JARs and a `modules/` directory (missing ⇒ the deployment machine had no mvn, see section 1 row 4).

The ten checks in detail (retained from the earlier English edition):

| # | Check | Pass condition |
|---|---|---|
| 1 | All `Bgp*` stacks | `CREATE_COMPLETE` or `UPDATE_COMPLETE`; deleted stacks are ignored |
| 2 | ECS service `bgp-platform` in cluster `bgp-cluster` | running equals desired, exactly one deployment |
| 3 | Platform URL | Home page title is `Kingfisher`; the `x-cache` header is printed for inspection |
| 4 | Authentication gate | Unauthenticated `GET /api/projects` returns 401 |
| 5 | Admin login | Cognito login succeeds and the token carries group `bgp-admin` |
| 6 | Key table | `bgp-query-handles` has partition key `handleId` and TTL attribute `ttl` enabled |
| 7 | Wiring intact | `OPENMETADATA_URL`, `GENBI_BACKEND` and the three runtime ARNs are non-empty in the task definition |
| 8 | Execution-environment deployer | Lambda `bgp-exec-env-broker` and CodeBuild project `bgp-exec-env-deploy` exist |
| 9 | Home target | `tgt_home` in table `bgp-execution-envs` has status `active` |
| 10 | S3 Tables federated catalog | Glue catalog `s3tablescatalog` exists with connection `aws:s3tables` |

Plus three production-specific checks:

| What to check | Criterion |
|---|---|
| OpenMetadata cannot be entered with the factory password | Through OpenMetadata's CloudFront address, `POST /api/v1/users/login` with body `{"email":"admin@open-metadata.org","password":"<base64 password>"}` (OpenMetadata requires the password base64-encoded): factory password `admin` ⇒ **401**; the password in `bgp/om/admin-password` ⇒ 200 |
| No demonstration content | The account has no `BgpRdsStack`; the Cognito user pool contains only `admin` |
| Authentication configured | The page redirects to the login page; the platform **does not** let anyone through when Cognito is unconfigured (unconfigured ⇒ 503) |

## 4. First login and accounts

1. The initial `admin` password is generated at random by deployment step 11 and lands in a local password file on **the machine that ran the deployment** (the path is given by `BGP_PW_FILE`; by default it is in the machine's temporary directory, named per profile;
   later step logs print "admin password taken from …"; 🔴 step 11 also **prints the generated password in clear text to the deployment stdout**, so the deployment log must be protected like the password and destroyed together with it after the password change).
   🔴 For customer production, set `BGP_PW_FILE` explicitly to a controlled location and delete the file after logging in and changing the password. **Change it immediately after the first login**: avatar at the top right → "Change password"
   (at least 12 characters, with upper case, lower case, digits and symbols).
2. Under "System → Users" create an account and assign a role for every user; a forgotten password is reset by a platform administrator on that page with "Reset password" (including admin's own). The audit log records only who reset whom, never the password.
3. 🔴 **Add users to a workspace**: Ask-Your-Data / saving cards / direct warehouse queries and so on are all checked against **workspace membership**. The default workspace starts **without any members** ⇒ until a non-administrator is added to a workspace,
   Ask-Your-Data returns 403 "no access to this workspace". Add people on the "Workspace" page (viewer = read / ask only, editor = can develop).
4. **When the only administrator has forgotten the password** (nobody else on the page can reset it for them), the customer's own account administrator runs one Cognito command (this is a write to the customer account; neither the platform nor the handover person does it on their behalf):
   ```bash
   P=<profile>; R=<home-region>
   POOL=$(aws --profile $P --region $R cloudformation describe-stacks --stack-name BgpAuthStack --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
   aws --profile $P --region $R cognito-idp admin-set-user-password --user-pool-id "$POOL" --username admin --password '<new password: at least 12 characters, with upper case, lower case, digits and symbols>' --permanent
   ```
   Then log in and change the password once more as in item 1.

## 5. Connecting the customer's existing warehouse tables (important)

- The write mode of a sync task **must be chosen explicitly** (append / overwrite / merge); it no longer defaults to overwrite.
- When the target table already exists and **was not created by the platform** (that is, a table the customer already has):
  - the wizard's "Create table preview" flags it in red: "table already exists (not created by the platform; overwriting requires confirmation)";
  - submitting with "overwrite" selected pops up "Confirm overwriting the existing tables?" listing them one by one, and **each table must be confirmed** before the task can be created;
  - the last line of defense is at run time: a task created through any entry point (scheduler / API / Copilot) that has not been confirmed **fails outright and deletes not a single row** when it meets a non-platform table of the same name
    (refusal code `SYNC_REFUSED_CLEAR_FOREIGN_TABLE`).
- Real-time sync (DMS) defaults the target-table preparation mode to **leave existing tables untouched** (`DO_NOTHING`).
- Deleting a data source removes only the security groups the platform created itself (`bgp-ds-*`); security groups specified by the customer are never deleted.

## 6. Go-live agreements (🔴 inform the customer in writing)

- **Open only one workspace, and give editor only to trusted users.** Direct warehouse queries are already read-only for non-platform-administrators (DROP / INSERT and the like are always 403), but **ETL jobs write to the database by design**,
  and warehouse data isolation between workspaces is not in place until a later phase of the project-isolation work ([project-isolation.md](design/project-isolation.md)) — until then, anyone who can create / edit ETL jobs can write to any schema in the platform warehouse.
- The home region's data lake / scripts / DAG buckets, the table bucket, the Athena workgroup and the Redshift namespace are all **RETAIN**: deleting the stacks does not delete data (deleting data requires manual confirmation, object by object).
- Logs keep their defaults, with no expiry (user decision of 2026-10-09).
- Alert channels (WeCom / DingTalk / Feishu / e-mail) are not connected yet; this is a known gap (recorded as deferred in the engineering defect records).

## 7. Adding an execution region (after go-live)

Three steps, in this order and no other (development / acceptance environments orchestrate these three steps as one command in the development-environment runbook; that is not a production step):

1. "Execution Environments" page → New execution environment → choose the region (the list comes from the account's real values; regions that already have an execution environment cannot be selected;
   regions where the organization SCP blocks an action required for deployment are **listed but not selectable**, with the blocked action named; regions marked "Organization policy could not be verified" remain selectable — press "Refresh" first to re-check;
   since candidate pre-authorization every region is also labeled "pre-authorized, usable right after the build" or "ops must release it once after the build") → step 2 shows the component set, which is the **complete set, read-only**
   (determined automatically by jurisdiction) → on the step 3 "Confirm and deploy" page press "Start deployment" (the button is disabled until the disclaimer is ticked);
2. 🔴 **Wait for the deployment build of step 1 to succeed** (status on the detail page / CodeBuild project `bgp-exec-env-deploy` shows SUCCEEDED), then: **if the region was pre-authorized at install / upgrade time**
   (the wizard shows "pre-authorized, usable right after the build" and the detail page has no yellow "control plane has not enabled this region" notice; from `release-2026-10-27`) ⇒ **skip this step**;
   - otherwise run `BGP_DEPLOY_MODE=production ./scripts/redeploy-platform.sh <profile> <home-region>` — the control plane authorizes the new region according to the registry (ECS rolls once).
   - To never have to do this step again: prefix the same command with `EXEC_REGION_CANDIDATES=<region1,region2,…>` to pre-authorize once (section 2);
3. Back on that execution environment press "Check initialization" (every resource is probed and must be all green; since candidate pre-authorization this also opens the region's S3 Tables federated catalog idempotently) → "Enable" ⇒ status becomes active and the region starts accepting work.

> - The step-by-step operating manual expanded along the customer's real situation (customer deployment machine obtaining the code from scratch, the three code gates, the "will change / will not change" list before the step 2 authorization command,
>   verification commands for every step, exception handling, the operations-side automation script `kf-add-region.sh`, the record of adding the Frankfurt region on 2026-10-19): **[adding-a-region.md](adding-a-region.md)**.
> - 🔴 `BGP_DEPLOY_MODE=production` in the step 2 command cannot be omitted (the command shown in the page's "control plane has not enabled this region" notice lacks it; copying it verbatim is refused by the script);
>   when the Anthropic model is not enabled at account level in the customer account, also give `BEDROCK_MODEL_ID=<the same id as at first install>` explicitly.

The execution-region stack group that the build deploys (retained from the earlier English edition):

| Stack | Purpose |
|---|---|
| `BgpExecEnv-<slug>-base` | Regional VPC with no internet egress, interface endpoints, customer-managed key |
| `BgpExecEnv-<slug>-core` | Regional execution roles, data lake bucket, scripts bucket, table bucket, Athena workgroup |
| `BgpExecEnv-<slug>-redshift` | Redshift Serverless namespace and workgroup |
| `BgpExecEnv-<slug>-dms` / `-flink` | Real-time integration and stream compute |
| `BgpExecEnv-<slug>-airflow-serverless` | Regional MWAA Serverless scheduling |
| `BgpExecEnv-<slug>-residency-api` | Only for non-`home` jurisdictions |

Behind the "Start deployment" button the platform only calls the broker Lambda, which starts the CodeBuild project; the build bootstraps the target region and deploys the stack group.
Never create execution regions with `cdk deploy BgpExecEnv-*`, by writing to the registry table, or by calling the registration API directly; the wizard is the only supported path.

## 7bis. Retiring an execution region (deleting an execution environment)

Two paths; the detail page offers only the one that matches the environment's actual state:

- **Never built** (deployment failed, no resources of it in the target region): press "Discard" ⇒ it shows as "Deleted" and frees the region's slot, so you can register in that region again.
- **Built at least once**: ① "Stop accepting work" (the region immediately stops accepting new bindings / new schedules / new runs; in-flight jobs finish; no resource is destroyed) → ② "Request deletion":
  review the impact preview (bound resources, enabled schedules and running runs must all be 0; if a source cannot be read it honestly says "cannot confirm it is 0" and refuses) → enter the reason, **type the region name to confirm** →
  a platform administrator approves → destruction (managed services first, then component stacks in reverse dependency order, then core, then base).
- 🔴 **Data-bearing resources are retained**: the data bucket, the table bucket, the warehouse namespace / workgroup and the final snapshot, the data-domain CMK and its alias, the MWAA Serverless DAG bucket,
  and for non-home jurisdictions the regional audit tables / result bucket **are not deleted by the destruction and continue to bill**; they must be cleaned up separately after manual confirmation
  (the platform does not decide on your behalf; read-only listing commands are in [operations.md](operations.md) and [AGENTS.md](../AGENTS.md)).
- When destruction stalls, the detail page offers "Retry destruction" (it reuses the same deletion plan and the same final snapshot name; no second snapshot is taken).
- After the deletion, run `BGP_DEPLOY_MODE=production ./scripts/redeploy-platform.sh <profile> <home-region>` once more to revoke the control plane's authorization of that region.
- Rules for deleting a workspace (related to deleting an execution environment): unsettled resources cause a refusal (400, named by type); the per-region database credentials managed by the system are deleted automatically by a revocation job,
  and **an in-flight revocation job blocks deleting the execution environment**; if enqueueing the revocation fails ⇒ deleting the workspace returns 503 and can be retried; the workspace's warehouse schema (`proj_*`) is not dropped automatically.

## 7ter. Upgrading (bringing a new version live)

1. On the deployment machine `git fetch --tags && git checkout <new-tag>`, then `npm ci` in each of the two directories;
2. `BGP_DEPLOY_MODE=production ./scripts/redeploy-platform.sh <profile> <home-region>` upgrades the control plane (a mode that disagrees with SSM `/bgp/deploy-mode` is refused);
   - from `release-2026-10-27` (the federated-catalog fix) the script's step 3c also opens the S3 Tables federated catalog `s3tablescatalog` idempotently in the home region and every registered execution region
     (in an environment that never ran a sync writing to S3 Tables, Lake Query / Ask-Your-Data become usable for the first time only after the upgrade; the deployment identity needs `glue:CreateCatalog` and `glue:PassConnection`);
   - from `release-2026-10-27` (the database-stack fix) the script's step 2c′ deploys the DynamoDB database stack `BgpDatabaseStack` before the platform stack, so **tables added by the new version are created by the upgrade**
     (the upgrade path did not deploy the database stack before; the retain policy + point-in-time recovery of every table are unchanged; with no new table it is a no-op of a few seconds;
     the deployment identity must be able to `cloudformation:UpdateStack` that stack and `dynamodb:CreateTable`);
   - from 2.2.0 (lake table-bucket routing) the script has two more steps: **2c‴** registers, as routes, the customer-owned S3 Tables buckets that existing home-region sync tasks already write to but that were never registered (alias derived from the bucket name, tier `other`, writable, note `auto-registered by upgrade`, audit actor `upgrade`; idempotent, a no-op when there is nothing to register; uses only the `aws` CLI),
     and **2f** runs `cdk deploy … --exclusively` for `BgpEmrStack` / `BgpFlinkStack` when they exist, so the home-region EMR / Flink roles may access any table bucket of the region (`bucket/*`). Execution-region Flink roles get the same change only through step 3 (console "Redeploy"); the post-deploy truth check gains an eleventh item (no home-region sync task references an unregistered customer bucket); see section 7ter.1j.

   2b. 🔴 **If the new version changed the agent containers** (the version's `CHANGELOG.md` has an "agents / recipes" entry,
   or `git diff <old-tag> <new-tag> --stat -- infra/agent platform/src/lib/genbi/core platform/src/lib/param-advisor/core platform/src/lib/network-advisor/core platform/src/lib/cookbook` is non-empty):
   `redeploy-platform.sh` **does not rebuild** the three AgentCore images and does not deploy the three agent stacks,
   so the agent refresh script must be run separately.
   It is independent of step 2 and can run before or after it (the Runtime ARNs / Memory ids do not change with the image, so the platform wiring does not need to be touched).
   Run from the repository root:

   ```bash
   ./scripts/redeploy-agents.sh <profile> <home-region> --check   # read-only: the image tag each agent's live Runtime is using vs the local HEAD, and whether the agent sources differ between the two ⇒ whether a refresh is needed
   ./scripts/redeploy-agents.sh <profile> <home-region>           # recompile core-dist → build and push the three ARM64 images (tag = git short hash) → deploy the agent stacks one by one → read the Runtime image tags back to verify
   ```

   🔴 Both positional arguments must be written (the script provides no silent defaults; a missing argument stops it, and a leading `--flag` in place of the profile is refused); the deployment machine needs Docker + buildx;
   the script **exists only in the new tag** (`release-2026-10-13` does not have it) — when upgrading from that tag, `git checkout <new-tag>` first, then run it.
   The pair `release-2026-10-12` → `release-2026-10-13` was such a case (the Ask-Your-Data recipes, section 7ter.1 row 7); at that time only the manual commands in the `release-2026-10-13` manual were available.
   Ask-Your-Data sessions already in progress may keep running on the old container for a few minutes; new sessions always use the new image.
3. For each execution region: detail page "Redeploy" ⇒ first a **preview** (lists which stacks this run would change and whether the baseline has drifted; nothing is changed) → after confirmation "Approve and deploy" → after a successful build "Check initialization".
   🔴 Resources the new version adds to execution regions (for example new roles / buckets / endpoints) **appear in existing execution regions only through this step**.
4. **Verify the version** (from `release-2026-10-27`): open the platform login page and look at the footer, or `curl -s https://<platform-host>/api/public/version` — `releaseTag` must equal the new tag checked out in step 1 (the endpoint returns `releaseTag`, `productCommit`, `productCommitAt`, `version` and `known`)
   (a test environment deployed from a branch shows the product commit short hash + "unreleased"; an image not built from a git clone shows "build information unavailable", which means the deployment machine did not use `git clone` as in section 1).
   The production tag `release-2026-10-13` does not have this item yet; there, verify the version with the three-carrier method of [AGENTS.md](../AGENTS.md).

**What `redeploy-platform.sh` does, in order** (retained from the earlier English edition):

1. Reads the real wiring from CloudFormation outputs (OpenMetadata URL, agent runtime ARNs, memory ids) and stops if any value is empty.
2. Derives the region allow-list and writes the wiring to SSM `/bgp/wiring/*`.
3. Deploys the execution-environment deployer stack (refreshing the source package), the home MWAA Serverless stack, the DynamoDB stack (new tables appear here) and the OpenMetadata database stack.
4. Deploys the WAF and OpenMetadata service stacks with `--exclusively`, so dependency stacks are not touched implicitly.
5. Deploys the platform stack with the complete wiring context, re-secures the OpenMetadata administrator password, and opens the S3 Tables federated catalog in the home region and every registered execution region.
6. Runs the IAM simulation gate: the task role is simulated against the platform's recorded AWS calls (`infra/iam/platform-taskrole-calls.json`) across the allow-list.

Gate outcomes printed as `IAM_GATE_VERDICT=`:

| Verdict | Meaning | Action |
|---|---|---|
| `green` | Every recorded call is allowed | none |
| `env-blocked` | No denial, but some rows could not be evaluated in this account | record it; it is not a pass |
| `unknown` | Gate did not run or found a denial | read the output; fix and rerun |

The platform ECS service rolls with minimum healthy percent 100, so pages stay available during the upgrade.

### 7ter.1c Five things to know when upgrading to the version with "candidate-region pre-authorization + the fixes for the non-US home region CodeBuild guard, the advisor role allow-list and the all-enabled IAM gate" (`release-2026-10-27`)

| # | Change | Impact on the customer | What to do |
|---|---|---|---|
| 1 | **Authorization can be pre-granted once**: prefix the upgrade command with `EXEC_REGION_CANDIDATES=<region1,region2,…>` (full region names; `all-enabled` = every region enabled in the account; `none` revokes), written to SSM `/bgp/wiring/execution-region-candidates` and carried automatically by every later authorization / upgrade | Creating an execution region in a candidate region no longer needs the authorization command of section 7 step 2; regions not pre-authorized behave as before. In a candidate region the platform role is allowed to call the data-plane APIs before an execution environment exists there (the application-layer place check still blocks it) | Name regions as needed at upgrade time: `EXEC_REGION_CANDIDATES="…" BGP_DEPLOY_MODE=production ./scripts/redeploy-platform.sh <profile> <home-region>`; leave it out if you do not want to pre-authorize |
| 2 | **Root fix for the 2026-10-19 incident**: the control plane's "default model geography guard" no longer hits the CodeBuild of an execution region created from the page (with a non-US home region, not a single stack could be built before) | The upgrade wipes the transition variable `BEDROCK_MODEL_ID` that was added by hand to the CodeBuild project `bgp-exec-env-deploy` for that incident. 🔴 **Measured in customer production on 2026-10-29: the original statement "the new version no longer needs it" was wrong (bootstrap guard recurrence)** — in `release-2026-10-27` through `release-2026-10-29` the buildspec's `cdk bootstrap` line carries no `-c exec-env-target`, the CDK CLI still executes the CDK app and takes the control-plane branch, so a non-US home region still hits the guard in the bootstrap step | **With a non-US home region, after upgrading to 2.1.2 or an earlier version and before pressing "Redeploy / New" on any execution region, add the transition variable back first** (value = the platform container's current `BEDROCK_MODEL_ID`; command in the section 8 row on the bootstrap guard recurrence), then "Resume" → "Redeploy"; only from the version that includes the bootstrap root fix (`cdk bootstrap --app ''`, hotfix of 2026-10-29) is the variable truly no longer needed |
| 3 | **Advisor role allow-list**: the skill roles of the network advisor / parameter advisor and the home EMR role never received the region allow-list before and were always authorized for the home region only (the advisors could not probe a data source in another region) | These three stacks are not deployed by `redeploy-platform.sh` | 🔴 **Run `./scripts/redeploy-agents.sh <profile> <home-region>` once** at upgrade time (section 7ter step 2b; this version changed the agent containers themselves, so the run is needed anyway); if the EMR stack (`-c enable-emr=1`) is deployed, run `cd infra && npx cdk deploy BgpEmrStack -c enable-emr=1 --profile <profile>` once in the same shell in which `BGP_EXECUTION_REGIONS` is exported (or wait for the next `deploy-all` path), otherwise EMR jobs reading DynamoDB sources in a non-home region are still denied |
| 4 | "Check initialization" gains one item `lake:s3tablescatalog` (the region's S3 Tables federated catalog; opened on the spot when missing) | Pressing "Check initialization" again on an existing execution region shows this extra item; the catalog was already created by the upgrade script's step 3c ⇒ always green | None |
| 5 | **All-enabled IAM gate**: when the upgrade command carries `EXEC_REGION_CANDIDATES=all-enabled` (or so many candidate regions that every candidate probe region is covered), the old script reports "the allow-list covers every candidate probe region…" before the step 4 IAM simulation gate and exits 1 — the platform stack / wiring / password / federated catalog are in fact all done, only the gate did not run | The script with this fix picks the probe region from the regions the account has **not opted in to** (they can never enter the allow-list; the IAM simulation only evaluates the region name as a condition value, the region need not be enabled), and does not abort when none can be found: the gate still verifies the other axes and records the any-region axis as "cannot be verified in this account" (exit 4, machine-readable `IAM_GATE_VERDICT=env-blocked`) | If an upgrade with the old script hits this message: the platform is already upgraded, **do not roll back**; switch to the code with this fix and rerun `redeploy-platform.sh` once (idempotent) so the gate completes; a ⚠️ "cannot be verified in this account" must be recorded as such, it is not a pass |

### 7ter.1d Five things to know when upgrading to the version with the "unified long-running-operation framework" (`release-2026-10-27`)

| # | Change | Impact on the customer | What to do |
|---|---|---|---|
| 1 | New DynamoDB table **`bgp-long-ops`** (long-running-operation tasks + object leases; TTL 7 days), created by step 2c′ of `redeploy-platform.sh` together with the database stack | The upgrade script must be the version that deploys the database stack (this version includes it); without this table, landing / altering tables / AI calls all fail with 500 | After the upgrade `aws --profile <p> --region <home-region> dynamodb describe-table --table-name bgp-long-ops` should be ACTIVE (`02-postdeploy-truth.sh` checks it too) |
| 2 | The `bgp-ai-tasks` table, which existed only in a pre-release version (the AI long-call fix), is removed from the stack (RETAIN) | **Customer production never had it** (it appeared only after `release-2026-10-13`), no impact; a test environment that installed the pre-release version keeps an empty shell table, which can be deleted by hand as needed | None |
| 3 | Container environment variables: the five `AI_*` removed, `LONG_OPS_SYNC_WAIT_MS` added (default 45000; **in production do not** change it with `-c long-ops-sync-wait-ms`, see the section 7 red lines) | Any operation longer than 45 seconds (landing / table creation while the warehouse cold-starts, AI calls to a reasoning model) no longer ends in a page 504; instead the bottom right shows "Running in background: <operation> (n s elapsed)" and the result appears unchanged when done | None |
| 4 | Object leases: while a long-running operation on an object is in progress, landing / editing / deleting the same object is blocked with 409 "'<operation>' is in progress (n s elapsed), please wait for it to finish" | The behavior changes only in the single case "pressing again before the long-running operation has ended"; wait for it to finish, then operate | None |
| 5 | **A second batch of 14 operations joins the same framework** (merged on the development branch 2026-10-23): governance "Sync column information" (its dedicated 200 / 202 protocol retired) · delete workspace (its "waking up the warehouse" protocol retired) · sync wizard "Generate DDL" / "Execute table creation" · stream compute job start / stop / delete · ETL orchestration publish / take offline / trigger / delete · S3 data source "create Athena external table" (API) · metrics and model metrics "Compute" | Page behavior is unchanged (results still arrive synchronously within 45 seconds); only beyond 45 seconds does it switch to "Running in background" at the bottom right; editing / deleting the same object (workspace / stream job / orchestration / data source) while its long-running operation is in progress is likewise blocked with 409; "enable/disable schedule" on the monitor page is blocked with 409 while an orchestration publish / take-offline / delete is in progress | None |

### 7ter.1e Two things to know when upgrading to the version with "page-driven acceptance, second pass (network advisor probes by the region of the place)" (`release-2026-10-27`)

| # | Change | Impact on the customer | What to do |
|---|---|---|---|
| 1 | The network advisor ("New stream job" / data source "Network configuration" → "Analyze network") probes and advises by **the region of the place**; its skill Lambda lives in the agent stack `BgpNetAdvisorAgentCoreStack`, and **`redeploy-platform.sh` does not refresh it** | When only the platform upgrade script is run, the probe results on the panel are already per region, but the "advice" half is still based on the home-region network (two test accounts hit this on 2026-10-25) | Upgrading to this version **must** also run `scripts/redeploy-agents.sh <profile> <home-region>` (`--check` first; it truthfully reports "agent-related sources differ ⇒ refresh needed"); step 2b is not optional |
| 2 | Same batch: DMS sync task "Start" is accepted immediately and only one start orchestration per task is allowed; S3 object-store sources can create tasks through the sync wizard; orchestration node configuration is saved per node; field masking takes the strongest policy by physical column | Page behavior only becomes more correct; no action requires the customer's cooperation | None |

### 7ter.1f Four things to know when upgrading to the version with "OpenMetadata database MySQL 8.0 → 8.4" (`release-2026-10-27`)

| # | Change | Impact on the customer | What to do |
|---|---|---|---|
| 1 | OpenMetadata database engine MySQL 8.0 → **8.4** (`infra/lib/om-database-stack.ts` pins major version 8.4 + `allowMajorVersionUpgrade`; RDS takes the latest 8.4 minor version, 8.4.11 as measured on 2026-10-26); `redeploy-platform.sh` gains **step 2c″ deploying `BgpOmDatabaseStack`** (before step 2d, the OpenMetadata service stack; until now the upgrade script never deployed the database stack, so changes to the database stack itself never landed) | When the upgrade script reaches 2c″, RDS **upgrades the major version in place, and OpenMetadata has one downtime window**: measured in a test account with Multi-AZ db.t3.small, the CloudFormation database stack step took 9.5 minutes, of which OpenMetadata's database connection was interrupted for about 2 minutes (03:10:10 → 03:12:03Z); the OpenMetadata container did not restart (ECS 1/1); afterwards governance "Sync Redshift columns" wrote OpenMetadata metadata as usual; inside the window the governance catalog / lineage / OpenMetadata console are unavailable; the platform's other pages are not affected | Upgrade in a business off-peak period; before the upgrade `aws --profile <p> --region <home-region> rds describe-db-instances --db-instance-identifier bgp-openmetadata-db --query "DBInstances[0].[EngineVersion,DBInstanceStatus]"` must be available; **do not** interrupt the script while 2c″ is in progress; after the upgrade the same command should return `8.4.x available`, and the "Governance Center" page should show status "Running" + the version |
| 2 | The database master user omadmin was created in the 8.0 era under `default_authentication_plugin=mysql_native_password` | In the RDS MySQL 8.4 default parameter group `mysql_native_password=ON` (engine default, not changeable), so after the upgrade OpenMetadata connects as omadmin as before (measured: zero "Access denied" in the OpenMetadata log; governance column sync wrote to OpenMetadata successfully after the upgrade) | None. Only if a customer-built parameter group has turned that plugin off, run `ALTER USER omadmin IDENTIFIED WITH caching_sha2_password BY '<the same password>'` before the upgrade |
| 3 | RDS takes a snapshot automatically before a major version upgrade (built in); the daily 30-day automated backups are unchanged | **RDS does not support a major version downgrade**: rolling back the code per section 7ter.2 does not take the database back to 8.0 (🔴 the script of the original `release-2026-10-13` tag **does** touch the database stack in the "WAF / OM service stack" step and is refused by RDS — exactly the rollback defect found on 2026-10-26; the rollback must check out the hotfix tag `release-2026-10-13-rollback`, see section 7ter.2; OpenMetadata 1.6.1 runs as usual on 8.4) | If you must return to 8.0, restore a new instance from the pre-upgrade snapshot and switch the OpenMetadata service's database address by hand (not in the script path) |
| 4 | Cost: eliminates the RDS extended-support fee for MySQL 8.0 (Multi-AZ 4 vCPU ≈ $292 / month, doubling from 2028-08; [cost-model.md](cost-model.md) section 7 item 1) | Monthly cost goes down, no functional change | None |

### 7ter.1g Four things to know when upgrading to the version with "root fixes for the customer feedback of 2026-10-27 (own table bucket in execution regions / DMS failure not shown in the list) + template-table sample columns + Redshift table-marker transient error" (`release-2026-10-28`, 2.1.1)

> The product difference 2.1.0 → 2.1.1 is only in `platform/` and in the IAM of the execution-region stack group (the Glue / EMR roles of the `-core` stack, the COPY role of the `-redshift` stack);
> `scripts/`, the DynamoDB database stack, the OpenMetadata database stack and the three agent containers have **zero diff** ⇒ upgrade script steps 2c′ / 2c″ are both no-op, **there is no downtime window**,
> and `redeploy-agents.sh --check` truthfully says no refresh is needed. When upgrading from `release-2026-10-13` straight to this version, all of sections 7ter.1b–1f still apply, plus this section.

| # | Change | Impact on the customer | What to do |
|---|---|---|---|
| 1 | **Own table bucket in execution regions**: the `s3tables:*` of the execution-region Glue / EMR roles and the warehouse COPY role widens from "the platform table bucket of that region" to "**any table bucket of the same region**" (still bound to the region, never cross-region, consistent with the home-region roles); the registry under "Settings → Data lake external table buckets" becomes the single source of truth for **writable** external buckets of an execution region (one registration = visible + writable) | A sync task in an execution region can land ODS in the customer's own table bucket (before, only the platform table bucket could be written: start returned 409 "the task's own table bucket … does not match ⇒ refused", and refused even after registration); a task carrying an **unregistered** bucket ⇒ wizard "Done" 400, "Start" 409, both pointing to the registration; home-region tasks behave unchanged | After the upgrade press "Redeploy" on the page of **every execution region** (the preview should list only IAM changes of the `-core` / `-redshift` stacks; without this step, jobs writing to an own bucket get AccessDenied on the Glue side); to use an own bucket the customer first registers it per execution region in Settings; unregistered buckets in the table-bucket dropdown are labeled "not registered" with a clickable link to register |
| 2 | **DMS failure in the list**: list-time reconciliation of sync tasks dispatches by channel (DMS / Zero-ETL share the same verdict and write-back as the detail page) | After a DMS real-time task fails on the DMS side, the list shows "failed" and offers "Start" **without opening the detail page** (before it lingered at "running" + "Stop" until someone opened the detail page); Zero-ETL failures are likewise persisted; the detail page of a non-home-region DMS task no longer shows status unknown forever | None. Tasks that had already failed before the upgrade but still showed "running" in the list are corrected at the first list refresh after the upgrade |
| 3 | **Template-table sample columns + target-table name collision guard**: a table name with a date variable can name a "sample table" whose column structure is read only (the sample table itself is not synced); when two source tables of the same task resolve to the same target table name ⇒ save / start are refused | If an existing task has a plain table and a variable table landing in the same target table name (or two table names that become identical after identifier normalization), saving and **the next start (including scheduled triggers)** after the upgrade are refused with an explanation of how to change it; Glue jobs already running are not affected | After the upgrade check in "Data Sync" whether the next run of scheduled tasks succeeds; for refused tasks follow the hint: make the plain table the template's sample table and untick it, or change one target table name |
| 4 | **Redshift table-marker transient error**: for syncs writing Redshift, table creation and the platform marker go into the same transaction, and transient errors of the Data API connection layer are retried up to 3 times | A single transient I/O error no longer leaves an unmarked empty table that makes every later sync refused with `SYNC_REFUSED_CLEAR_FOREIGN_TABLE`; unmarked empty tables **already** left behind on 2.1.0 / 2.0.1 are not repaired automatically | Tasks that hit this before or after the upgrade are handled once by the transition: delete that unmarked empty table, or "Confirm overwrite" in the task and rerun |

🔴 **Rolling back to 2.1.0**: check out `release-2026-10-27` itself and run its `redeploy-platform.sh` (section 7ter.2 item 1; it already carries `--exclusively`); leaving the wider IAM in the execution regions is harmless, no redeploy needed;
returning to `release-2026-10-13` is still only possible with `release-2026-10-13-rollback`.

### 7ter.1h Three things to know when upgrading to the version with the "root fix for the home-region data-source creation request path having no timeout budget" (`release-2026-10-29`, 2.1.2)

> The product difference 2.1.1 → 2.1.2 is **only in `platform/`** (15 files: the data-source creation provision segment joining the long-running-operation framework, the Glue role verification cache, the network budget in `lib/aws/clients.ts` — three source changes + tests);
> `infra/` (including the execution-region stack group and the IAM call manifest), `scripts/`, the DynamoDB database stack, the OpenMetadata database stack and the three agent containers have **zero diff** against 2.1.1
> ⇒ upgrade script steps 2c′ / 2c″ are both no-op, `redeploy-agents.sh --check` truthfully says no refresh is needed, **execution regions need no page "Redeploy"**, **there is no downtime window** (only the platform ECS service rolls, 2 tasks, minHealthy 100%).
> When upgrading from 2.1.0 to this version, additionally do the "Redeploy every execution region on the page" of section 7ter.1g;
> when upgrading from `release-2026-10-13` straight to this version, all of sections 7ter.1b–1g still apply, plus this section.

| # | Change | Impact on the customer | What to do |
|---|---|---|---|
| 1 | **Fix part ①**: the provision segment of "New data source" (JDBC sources) (verify the Glue job role → probe the subnet / create the security group → create the Glue connection → persist → settle) joins the unified long-running-operation framework (kind `datasource-create`, object lease by workspace + name) | If creation finishes within 45 seconds of pressing "Done" ⇒ the same 201 as before, byte for byte; beyond 45 seconds ⇒ the bottom right shows "Running in background: New data source (n s elapsed)" and polls automatically for the result, **the fork "page 504 while the server creates it anyway" no longer occurs**; pressing "Done" again for the same name while the background is still creating ⇒ 409 "in progress, please wait for it to finish"; failure midway ⇒ the Glue connection / security group / secret the platform created are removed in reverse order (customer-specified security groups are not touched) | None. If a 504 was hit on 2.1.1 or earlier, refresh the data-source list before upgrading and delete the surplus duplicate of any same-name source; automation that calls `POST /api/datasources` directly must handle 202 `protocol:"long-op/1"` and poll `GET /api/long-ops/<taskId>` |
| 2 | **Fix part ②**: `bgp-glue-role` verification leaves the request path — verified once on first use within the process and cached; the role is created only when IAM explicitly returns NoSuchEntity (before, any error including a timeout was treated as "role missing" and led to CreateRole) | One synchronous IAM round trip fewer per source creation; when the role is really missing, an honest 503 "the home-region Glue job role is not in place" instead of a hang | None (the role is created by the CDK platform stack and exists as soon as the upgrade is in) |
| 3 | **Fix part ③**: every AWS SDK client of the platform process gets an explicit network budget — connect 5 seconds / idle 60 seconds / at most 3 bounded retries (the model-invocation and AgentCore clients have no idle timeout) | Before, a stall on any hop to IAM / EC2 / Glue / DynamoDB and so on hung until the CloudFront 60-second wall; now a readable error arrives within seconds or the retry succeeds automatically; the normal path behaves unchanged | None |

🔴 **Rolling back to 2.1.1 / 2.1.0**: check out `release-2026-10-28` / `release-2026-10-27` itself and run its `redeploy-platform.sh` (section 7ter.2 item 1; it already carries `--exclusively`); there is no table / IAM / execution-region difference against 2.1.1, so execution regions stay untouched;
returning to `release-2026-10-13` is still only possible with `release-2026-10-13-rollback`.

### 7ter.1i Three things to know when upgrading to the version with "Flink 1.20.4 + runner JARs refreshed by content" (ships with 2.2.0)

1. **Why**: Apache Flink 1.20.0 has a remote code execution defect in SQL code generation (GHSA-2f54-v4hm-fx73, high), fixed in 1.20.4; in this version the three Flink SQL runners and the connector modules are all built against 1.20.4, the Managed Flink runtime environment stays `FLINK-1_20`, and existing job SQL does not change.
   - Honest boundary: the defective component is `flink-table-planner` (SQL code generation). In all three runner POMs it has `provided` scope — at run time it comes from the Managed Service for Apache Flink `FLINK-1_20` environment, whose patch level is maintained by AWS, and it is **not** inside the JARs of this repository; this upgrade brings the Flink artifacts that are bundled into the JARs (`flink-json` / `flink-connector-files` / `flink-metrics-dropwizard`, …) to the same 1.20.4 as the planner and clears the repository's dependency alert.
   - So the string `1.20.4` does not appear in CloudWatch logs; whether the new JAR has been loaded is read from the application's `CodeMD5` / `ApplicationVersionId` (`aws kinesisanalyticsv2 describe-application`).
2. **The upgrade script sends the new JARs to the home-region scripts bucket automatically** (`redeploy-platform.sh` step 2e): the deployment machine needs Maven + JDK 17; the script rebuilds a JAR from source when it is missing or older than its sources, compares by sha256 and uploads only what differs (identical objects are skipped); without Maven it only prints `WARNING: Flink`, installation / upgrade continues, but the live Flink jobs keep running the old JARs — run `mvn -v` before upgrading. Jobs in execution regions get the new JAR copied into that region's bucket by the platform on their next start, based on the identity of the source object; execution regions do not need to be redeployed.
3. **Running stream jobs do not switch JARs by themselves**: Managed Flink reads the code object only when the application is created or updated. After upgrading, open "Realtime compute" and "Stop" then "Start" every running job once (about 2–3 minutes, during which that job does not process data; KPU billing stops once it has settled); after the start the job loads the new JAR.

### 7ter.1j Four things to know when upgrading to the version with "lake table-bucket routing" (ships with 2.2.0)

1. **What it is**: "Settings → Lake table buckets and routes" registers customer-owned S3 Tables buckets as **routes** (alias / tier / namespace ownership / writable). Batch Glue and EMR Serverless jobs declare, under "Advanced Properties → Lake table buckets", which buckets they read and write (default: every route of the region);
   the platform registers one Spark catalog per bucket (the alias is the catalog name) and a default catalog, so scripts address tables as `alias.namespace.table` and the hand-written `--conf` transition of section 8 is no longer needed (jobs that still carry it keep working; when alias and bucket match a route the platform takes the catalog over).
   A sync task's target bucket must be a writable route, otherwise the save is rejected with a 400 naming the bucket and the next action. No new table: the external-bucket registry rows are reused.
2. **The upgrade script does two things by itself**: **2c‴** registers, as routes, the customer-owned buckets that **existing** home-region sync tasks write to but that were never registered (alias derived from the bucket name, tier `other`, writable, note `auto-registered by upgrade`, audit actor `upgrade`; idempotent, a no-op when nothing is pending; the deployment identity must be able to read the sync-task table and write the registry rows);
   **2f** runs `cdk deploy --exclusively` once for `BgpEmrStack` / `BgpFlinkStack` when they exist, changing the home-region EMR / Flink roles' s3tables resources from the platform bucket ARN to `bucket/*` of the region. After the upgrade, item 11 of `02-postdeploy-truth.sh` must be ✅ ("no home-region sync task references an unregistered customer bucket"); if it reports that a bucket no longer exists, revoke that route in Settings or change the task.
3. **Every execution region must be redeployed from the console** (section 7ter step 3): the `-flink` stack's Flink role changes to `bucket/*` the same way, and without the redeploy a Flink job in that region writing to a customer bucket is still denied (403). Glue / EMR jobs in execution regions are governed by the role bound to the job and by the save-time preflight, which take effect together with the control-plane upgrade.
4. **What changes for custom and advisor-generated roles**: the save-time preflight probes, for every declared bucket, `s3tables:GetTableBucket / GetTable / GetTableMetadataLocation / GetTableData` (plus `PutTableData / UpdateTableMetadataLocation` for write) and the federated catalog's `glue:GetCatalog / GetDatabase / GetTable`, and rejects the save with a 400 listing each gap as "action → resource → why";
   the engine baseline no longer demands write access to the platform data-lake bucket (the TempDir probe now targets the real TempDir, the scripts bucket `temp/` prefix), and roles generated by the role advisor no longer carry that blanket write grant — a job that needs the platform data-lake bucket declares it like any other bucket. Developers no longer need the administrator role to read the route table or the bucket candidates (read-only paths `GET /api/lake-routes` and `GET /api/lake-buckets/candidates`).

### 7ter.1 Six things to know when upgrading to the "data-sync capability completion" version (`release-2026-10-13`)

| # | Change | Impact on existing objects | What to do |
|---|---|---|---|
| 1 | **Sync "overwrite" writing to S3 Tables now also has the foreign-table guard** (same rule as Redshift): overwriting an entire existing Iceberg table **not created by the platform** must be confirmed table by table in the task, otherwise that run fails without touching a row | Sync tasks that **had already run successfully** before the upgrade: at their first run after the upgrade the platform records the target tables of that moment as confirmed (visible in the task configuration under `overwriteConfirmedTables`, one-off, timestamped) **without interruption**; tasks driven purely by the scheduler that were never run by hand after the upgrade make the same record at their first **save** or first manual / backfill run after the upgrade; tasks that never succeeded and new tasks are fully protected by the guard | Usually nothing. If a task reports `SYNC_REFUSED_CLEAR_FOREIGN_TABLE` at its first run after the upgrade, save it once more in the wizard and confirm table by table as prompted |
| 2 | **The "Merge" write mode now really merges by key** (Iceberg `MERGE INTO` / Redshift delete-then-insert in one transaction); before, it was effectively append and produced duplicate rows | Existing tasks with writeMode=merge and no merge key are refused explicitly at run time after the upgrade ("merge write mode requires merge keys (mergeKeys, at least one column)") instead of silently appending | Add "Merge keys" to those tasks in the wizard; duplicate rows appended historically must be cleaned up once by yourself |
| 3 | **The full set of 15 business-date parameters** (`--ds / --ds_nodash / --yesterday_ds(_nodash) / --tomorrow_ds(_nodash) / --run_date / --yesterday / --ds_month / --last_month(_std) / --bizdate(_std) / --bizmonth(_std)`) is passed to Glue batch jobs, and EMR Serverless jobs start receiving them too (appended after the script's own arguments) | ① The artifacts of published EMR / Glue **scheduled jobs** are generated at publish time: republish the schedule on the page after the upgrade to get the new parameters (old artifacts keep passing the old 4; nothing breaks); ② an EMR script using strict `argparse.parse_args()` reports "unknown argument" because of the newly appended parameters | ① Republish scheduled jobs that use the new variables; ② change EMR scripts to `parse_known_args()` or read parameters by name from `sys.argv` (the job starter template already uses that style) |
| 4 | **Data-sync nodes in a workflow can be backfilled**; the backfill center fixes concurrency at 1 for workflows containing sync nodes | None | The linked sync task must use the Glue channel, be a full load and use date variables, otherwise that node's instance fails honestly |
| 5 | **Workflow SQL nodes support several statements executed as one transaction** (before, the executor accepted a single statement only; several statements were refused by the Redshift Data API) | Published workflow artifacts are generated at publish time: a workflow containing multi-statement nodes must be **republished** once to run as a single transaction; single-statement nodes are unchanged | For "drop then create" atomic recomputation, put DROP and CREATE TABLE AS in **the same** SQL node (separated by semicolons) and republish; splitting them into two nodes leaves a window in which the table does not exist, and cards / queries reading the table at that moment fail |
| 6 | **Saving a sync task refreshes its script**: for a task that has already run, saving regenerates the Glue script immediately and updates the job, so the next scheduled run follows the new definition (before, a manual run was needed first); if the refresh fails, "save did not take effect" is shown and the task is left unchanged | No migration; saving takes one or two seconds longer than before | No manual run is needed anymore after changing WHERE / partitions / merge keys / per-table confirmations |
| 7 | **The script-generation recipes inside the Ask-Your-Data agent container are updated** (Glue / EMR / S3 Tables overwrite facts and so on under `cookbook/seed`) | The recipes travel with the agent image: when only `redeploy-platform.sh` is run, the Ask-Your-Data agent still uses the old recipes (the platform side `platform/src/lib/cookbook` is already new; other features unaffected; environments without Bedrock can ignore this) | Refresh the three agent images and stacks per section 7ter step 2b |
| 8 | **Database-stack upgrade fix** (from `release-2026-10-27`): the upgrade script `redeploy-platform.sh` used to **not deploy the DynamoDB database stack** (there is no CDK dependency between the platform stack and the database stack; tables are read and written by name), so tables added by a new version were not created by the upgrade; `bgp-ai-tasks` (AI long-call tasks) of that batch was the first such table | Without the fix, after upgrading to the version with AI long calls the seven entry points Copilot Q&A / network advisor / parameter advisor / three AI code generators / Flink SQL generation all fail with 500 ("Requested resource not found"), and the page gives no hint that the table is missing | Upgrade with a script that includes the fix (the same tag satisfies this naturally): its step 2c′ runs `cdk deploy BgpDatabaseStack` before the platform stack (the retain policy + point-in-time recovery of every table are unchanged; with no new table it is a no-op of a few seconds); after the upgrade you can check with `aws --profile <profile> --region <home-region> dynamodb describe-table --table-name bgp-ai-tasks --query Table.TableStatus` that it is ACTIVE |

### 7ter.1b Four things to know when upgrading to the version with the "multi-vendor model channel (GLM 5 / Kimi K3)" (`release-2026-10-27`)

| # | Change | Impact on the customer | What to do |
|---|---|---|---|
| 1 | **The three agent containers changed** (they now carry the `core-dist/ai` vendor profiles and request shaping; Ask-Your-Data retrieval re-ranking / Strands budgets go through it) | When only `redeploy-platform.sh` is run the agents remain on the old image, and platform and container handle the model inconsistently (under Kimi the container returns 400) | 🔴 **Must** run `./scripts/redeploy-agents.sh <profile> <home-region> --check` and then `./scripts/redeploy-agents.sh <profile> <home-region>` per section 7ter step 2b |
| 2 | The selectable set under "Settings → AI model" grows from two families to four (Claude Opus / GPT-5.6 / GLM 5 / Kimi K3) | The existing global default is unchanged; the GPT family is still kept closed by the transport gate | To switch to GLM / Kimi: select on the card → test (including the tool-use second probe) → save; a probe saying "this model is not enabled for this account" = account-level enablement, ask your AWS account team |
| 3 | The deployment-time default model is chosen from the candidate chain (new field `candidateModelIds` in `platform/ai-model.json`; an old json without the field falls back to the factory default, backward compatible) | If the upgrade redeploy has no explicit `BEDROCK_MODEL_ID`, the script re-selects from the candidate chain; **the runtime configuration (set on the page) has higher priority and is not affected** | None |
| 4 | Kimi K3 always carries reasoning blocks and its output tokens are about 2× Claude's (the platform already scales maxTokens by a factor) | After choosing Kimi as the global default, Bedrock cost and response time rise accordingly | Be aware; see the "FinOps" page for cost |

### 7ter.2 Rollback (returning to the previous tag)

> 🔴 Rollback was rehearsed for real on 2026-10-26 in a test account (production mode + one execution region, OpenMetadata database already on 8.4): **checking out the original tag `release-2026-10-13` and running its script fails**
> (the "WAF / OM service stack" step also downgrades `BgpOmDatabaseStack` back to MySQL 8.0, RDS refuses with "Cannot upgrade mysql from 8.4.11 to 8.0.46", the script aborts, and the platform stack is not rolled back = half new, half old);
> checking out the hotfix tag **`release-2026-10-13-rollback`** (= `release-2026-10-13-b103` + one line `--exclusively` in `redeploy-platform.sh`, product bytes unchanged) rolled back successfully
> (17 minutes, IAM gate green, truth check all green, sync / orchestration / job each ran one round successfully on the old version).
> For a customer production rollback **use the hotfix tag only**;
> from now on the script of every release tag carries `--exclusively`, so rolling back from a newer version to `release-2026-10-27` or any later tag means simply checking out that tag.
>
> - **Full round-trip rehearsal (2026-10-26, test account in production mode + one execution region, with sync / orchestration / batch-job fixtures on a `*/20` schedule created on the old version)**:
>   ① upgrade to `release-2026-10-27`: platform 40 minutes (including the `all-enabled` pre-authorization IAM simulation gate), agents 4 minutes (agent sources identical between the two versions, `--check` reported no refresh needed),
>   execution region page "Redeploy" 14 minutes (the preview listed IAM changes only),
>   truth check 14 items all green,
>   page-driven checks 10 items 0 failures (at the first scheduled tick after the upgrade sync / orchestration / job all succeeded, editing and saving existing data sources / sync tasks worked, footer and "Platform version" card == tag,
>   Glue jobs still 5.1, scripts differ by only the one line of the MySQL zero-timestamp fix, warehouse counts unchanged);
>   ② roll back with the hotfix tag: 10.75 minutes, database stack untouched (still UPDATE_COMPLETE / 8.4.11), truth check all green, scheduled tasks kept running normally on the old version for 7 hours (orchestration / job heartbeat 39 rows),
>   checks 10 items 0 failures (the old version's known defect — renaming a data source while editing it returned 500 — appeared as expected and was recorded, not judged red);
>   **the rollback does not require redeploying execution regions** (the execution-region stacks of the two versions differ only in IAM additions of the `-base` stack, which the old control plane uses as before);
>   ③ upgrade again: 34 minutes, checks 10 items 0 failures 1 recorded (DMS fixture), the upgrade fixtures removed cleanly.
>
> - **2.1.1 rehearsal (2026-10-27, same test account in production mode, from the 2.1.0 product bytes up to `release-2026-10-28`;**
>   **fixtures = two `*/20` scheduled syncs + orchestration + batch job + one DMS real-time task (the source database had binlog on this time, the task was really running))**: platform `redeploy-platform.sh` 38 minutes, exit 0 (2c′ / 2c″ no-op, **no downtime window**;
>   the IAM simulation gate recorded "cannot be verified in this account" for the regions the temporary account's SCP blocks, per the all-enabled gate fix), agents `--check` concluded "matches local HEAD, no refresh needed for this version",
>   execution region page "Redeploy" 8 minutes (preview 7 stacks 0 changes, because that environment had already installed branch bytes containing the 2026-10-27 fix batch;
>   **customer production upgrading from `release-2026-10-13` will list IAM changes of the three stacks `-base` / `-core` / `-redshift`**), truth check 0 red, footer / "Platform version" card / `GET /api/public/version` all = `release-2026-10-28` + 2.1.1;
>   page-driven continuity checks **10 items 0 failures 0 recorded**: at the first scheduled tick after the upgrade both syncs / the orchestration / the job all succeeded, **the DMS task list still "running" and running on the DMS side (uninterrupted across the platform ECS roll)**,
>   editing and saving existing data sources / sync tasks worked, Glue job version and scripts differ by only the two permitted lines, the warehouse overwrite-table count unchanged, the heartbeat table kept growing.
>
> - **2.1.2 rehearsal (2026-10-28 15:34–16:27Z, same test account in production mode, from an unreleased build of the 2.1.2 product bytes (footer `<product commit> · unreleased`, VERSION 2.1.1) up to tag `release-2026-10-29`;**
>   **fixtures = two `*/20` scheduled syncs + orchestration + batch job + one DMS real-time task running)**: platform `redeploy-platform.sh` 37 minutes, exit 0 (`EXEC_REGION_CANDIDATES=all-enabled`;
>   2c′ / 2c″ no-op, **no downtime window**), agents `--check` concluded "matches local HEAD, no refresh needed for this version", execution region page "Redeploy" 9 minutes
>   (the preview dialog truthfully said "source has drifted and there is no explicit wave authorization ⇒ administrator approval required"; after approval the build succeeded;
>   **customer production upgrading from `release-2026-10-13` will still list IAM changes of the three stacks `-base` / `-core` / `-redshift`**), truth check 17 ok / 0 bad, footer / "Platform version" card / `GET /api/public/version` all = `release-2026-10-29` + 2.1.2;
>   page-driven continuity checks **10 items 0 failures 0 recorded**: at the first scheduled tick after the upgrade both syncs / the orchestration / the job all succeeded, the DMS task list still "running" and running on the DMS side,
>   editing and saving existing data sources / sync tasks worked, Glue job version and scripts differ by only the two permitted lines, the warehouse overwrite-table count unchanged, the heartbeat table kept growing.
>   The three mechanisms of the customer production upgrade `release-2026-10-13` → `release-2026-10-29` (database stack 8.0 → 8.4 / new table `bgp-long-ops` / agent refresh / execution-region IAM) were each exercised once
>   in the three production-mode rehearsals: the round trip of 10-26 (→ 2.1.0), 10-27 (→ 2.1.1) and this one (→ 2.1.2).
> - **Customer production record (2026-10-29, home region ap-southeast-1, three execution regions, `release-2026-10-13` → `release-2026-10-29`)**: control plane `redeploy-platform.sh` **47.5 minutes, exit 0** (02:00:53–02:49:08Z;
>   `EXEC_REGION_CANDIDATES=all-enabled` ⇒ 18 enabled regions authorized;
>   2c′ new table `bgp-long-ops`;
>   2c″ OpenMetadata database 8.0.46 → 8.4.11 in **11 minutes**, database connection interrupted about 2 minutes;
>   the platform ECS roll did not interrupt the pages;
>   IAM gate 18 regions × 136 rows green), agents `--check` three times "refresh needed"
>   ⇒ real refresh **6 minutes**, all ✅; truth check **16 ✅ + item 5 not run** (the script looks for the deployment-time password file by profile, and the deployment machine's password is kept elsewhere; a page login + the footer served as equivalent evidence);
>   footer / version endpoint = `release-2026-10-29` + 2.1.2;
>   **the first "Redeploy" preview of an execution region failed in the `cdk bootstrap` step = the bootstrap guard recurrence** (section 8; after the upgrade wiped the transition variable of the 2026-10-19 incident,
>   the buildspec's bootstrap line still executed the CDK app ⇒ the guard's message); after adding the variable back (value changed to the platform's current default model id) Frankfurt succeeded in **5 minutes**
>   (the preview listed 4 in-place IAM modifications in `-base` / `-core` / `-redshift` + "source has drifted, approval required" ⇒ approved) and US East in **6 minutes** (same three stacks; residency-api and three other stacks unchanged);
>   after "Check initialization" all three regions active;
>   no scheduled task fired during the upgrade (the customer's cron schedules all run on Mondays).
>   Two non-product reds: the first run of the upgrade script stopped at `git fetch --tags` (the deployment clone's stale local tag refused to be overwritten by the moved tag of the same name on origin ⇒ the script's fetch gained `--force`; zero writes by the customer);
>   the `aws: [ERROR] … ChangeSetNotFound` log line after the preview gate cleans up its change set is a harmless confirmation read.
>
> - **Hotfix 2.1.2.1 upgrade rehearsal (2026-10-29 06:55–07:42Z,**
>   **test account in production mode + one `eu-sim` execution region,**
>   **from 2.1.2 up to the hotfix tag)**: from `release-2026-10-29` check out `release-2026-10-29-b134` + `npm ci` in both directories + `EXEC_REGION_CANDIDATES=all-enabled BGP_DEPLOY_MODE=production redeploy-platform.sh` **exited 0**
>   (step 2b ExecEnvDeploy stack source package refreshed at 06:56Z, 2c / 2c′ / 2c″ all no-op, platform stack rolled 06:59–07:02Z,
>   no downtime;
>   IAM gate green), `GET /api/public/version` = `release-2026-10-29-b134` / the hotfix product commit / 2.1.2, the CodeBuild project `bgp-exec-env-deploy` carried only the variable `EXEC_ENV_SOURCE_REF` (**no** `BEDROCK_MODEL_ID`)
>   ⇒ the page "Redeploy" preview got through bootstrap (build log `npx cdk bootstrap --app '' … ⇒ Environment … bootstrapped (no changes)`)
>   ⇒ dialog "7 stacks, 0 changes in total; source has drifted and there is no explicit wave authorization ⇒ approval required" (the preview build exits 1 by design = the approval checkpoint of the preview gate)
>   ⇒ approve
>   ⇒ deployment build SUCCEEDED
>   ⇒ "Check initialization"
>   ⇒ active;
>   the test account's home region is in the United States ⇒ the half where the guard would fire can still only be covered by the offline synth gate + a regression after it lands in customer production.
>   Customer production will take the same path (once the user gives a window, the operations-side upgrade script with `release-2026-10-29-b134`, about 25 minutes); after landing, delete the CodeBuild transition variable + "Redeploy" any one execution region as a regression.

1. **Control plane**: on the deployment machine `git fetch --tags && git checkout <the rollback-capable tag of the old version>` (returning to `release-2026-10-13` ⇒ `release-2026-10-13-rollback`;
   returning to `release-2026-10-27` or later ⇒ that tag itself), `npm ci` in each of the two directories, then `BGP_DEPLOY_MODE=production ./scripts/redeploy-platform.sh <profile> <home-region>`
   (when the Anthropic model is not usable in the customer account, give `BEDROCK_MODEL_ID` explicitly here too, the same id as at upgrade time).
   - The script reads the wiring parameters back from the live environment (OpenMetadata address, agent Runtimes and so on) and assembles the complete deployment parameters, so the wiring is not lost;
   - images are rebuilt by CDK from the old source (an existing image is reused when the content is identical).
   - When agent-related sources differ between the two versions (`release-2026-10-12` ↔ `release-2026-10-13` do: the Ask-Your-Data recipes), the rollback must also refresh the agent images and stacks:
     when the rollback target version carries `scripts/redeploy-agents.sh`, run it on the old tag's checkout;
   - when rolling back to `release-2026-10-13` or earlier (which have no such script), follow the manual commands of that version's manual, section 7ter step 2b.
2. **Execution regions**: execution-region stacks are deployed by CodeBuild from "the code packaged in at the most recent control-plane deployment" (the source package is a CDK asset uploaded by content hash at control-plane deployment time)
   ⇒ after the control plane has returned to the old tag, "Redeploy" on the execution environment page (preview first, then approve) uses the old code.
   - **Only when the new version changed the execution-region stacks** (see that version's section 7ter.N migration note or `CHANGELOG.md`) is this step needed;
   - between `release-2026-10-12` ↔ `release-2026-10-13`, `infra/lib/` differs only in 3 lines of `platform-stack.ts` (1 IAM action + 2 comment lines); the execution-region stacks have no difference;
   - there are also changes to the Ask-Your-Data agent recipes (`infra/agent/genbi/core-dist`), the IAM call manifest and the production-layer manifest ⇒ rolling back between this pair of versions = step 1
     (plus the agent refresh if the Ask-Your-Data recipes matter); redeploying the execution regions is not needed.
3. **Data and artifacts**: there are no new tables between those two versions;
   - **the version that includes the OpenMetadata database upgrade moved the database in place to MySQL 8.4, and RDS does not support a major version downgrade ⇒ after rolling back the code the database stays on 8.4
     (🔴 the original tag's script **does** go on to touch the database stack and is refused by RDS — exactly the rollback defect of 2026-10-26, which is why the rollback must use the hotfix tag above; OpenMetadata 1.6.1 runs as usual on 8.4);**
   - **if you must return to 8.0, the only way is to restore a new instance from the pre-upgrade RDS snapshot and switch the OpenMetadata service's database address by hand (section 7ter.1f row 3)**;
   - new fields written by the new version (such as a sync task's `overwriteConfirmedTables`) are not read by the old code and are harmless.
   - But scheduler artifacts and Glue scripts are **generated at publish / save time**: workflows / scheduled jobs republished and sync tasks saved after the upgrade must be published / saved once more on the page after the rollback to be regenerated by the old version;
   - OpenMetadata, Cognito and business data are not affected by the rollback.
4. After the rollback run `./scripts/02-postdeploy-truth.sh <profile> <home-region>` and log in for a smoke test (data-source list, sync task list, Lake Query).

## 8. Known boundaries (as they are)

- **Data modeling "Land in this region" / "Apply" may wait 60 seconds while the target region's warehouse cold-starts and then report "service response error (HTTP 504) … the request may still be continuing in the background"
  (measured in a test account on 2026-10-21, also present on the production tag; root-fixed on the development branch by the unified long-running-operation framework, from `release-2026-10-27`, see section 7ter.1d)**:
  on the production tag the landing has in fact completed in the background; refresh the page and it shows "landed";
  - do not press again, and do not press "Delete" at that moment (on the production tag, deleting during a landing leaves an orphaned physical table in the target region; the new version blocks it with 409).
  - Once the region's warehouse is warm (do it again within a few minutes) it is a matter of seconds.
- **The whole chain with a home region other than us-east-1 — rehearsed from scratch in a real account** (2026-10-10, a second temporary account, brand-new and empty, `BGP_DEPLOY_MODE=production`, home region us-west-2, the code of that day):
  `deploy-all.sh` EXIT=0, about 70 minutes, all 19 stacks in us-west-2 completed with zero rollbacks, the WAF stack in us-east-1.
  - Checked per section 3: ECS platform 2/2, OpenMetadata 1/1 · login page 200, unauthenticated API call 401 · no `BgpRdsStack`, Cognito has only `admin`, deploy-mode=production ·
    both ALBs admit only **their own region's** CloudFront prefix list (the ids of us-west-2 and us-east-1 differ; looked up per region at deployment time) · both CloudFront distributions carry the us-east-1 WAF ·
    the OpenMetadata factory password replaced and verified both ways · the default model chosen from the home-region account's real values and its real call passed.
  - 🔴 The rehearsal caught on the spot, and fixed, two defects that only appear when "home region ≠ us-east-1" (the test accounts' home region happened to be us-east-1, so they were invisible there):
    ① **`AWS_REGION` in the deployment machine's environment overrides the home region**, and the whole control plane was silently built in another region — the deployment scripts now force the alignment, and synthesis refuses as soon as the
    target region ≠ home region (not a single stack is deployed);
    ② asset provisioning validated buckets against the home region and rejected the legitimate assets of the WAF (us-east-1).
  - **Requirement for the customer**: always deploy through `scripts/deploy-all.sh` / `redeploy-platform.sh`, never a bare `cdk deploy` (a bare run does not compare the home region).
  - Sections 3-5 / 4 at page level were also run for real in the rehearsal account (scripted, headless browser): OpenMetadata factory password 401, new password 200 · admin logs in on the page with the initial password written to disk by the deployment ·
    after avatar menu [Change password] the new password logs in and the old one does not, then changed back · the Users page has [Reset password] · the default workspace starts with zero members — all passed.
  - Not yet done in the rehearsal account: section 5, connecting existing customer tables (the rehearsal account is in production mode and has no demonstration source database;
    the page-level criterion for that item passed in the full acceptance gate in a test account).
- **Non-US home region, creating an execution region from the page (hit for real in customer production in Frankfurt on 2026-10-19; the fix is in the tag from `release-2026-10-27`, but 🔴 **it recurred after customer production was upgraded to 2.1.2 on 2026-10-29 = the next entry**):
  when the home region is not in the United States, the CodeBuild of an execution region created from the page fails the moment `cdk bootstrap` loads the CDK app, and not a single stack is built.**
  The log line reads: "default model us.anthropic.claude-opus-4-5-20251101-v1:0 is a 'us.' geographic inference profile and cannot be invoked from home region ap-southeast-1".
- **Bootstrap guard recurrence (hit for real after customer production was upgraded to 2.1.2 on 2026-10-29;**
  **a recurrence of the 2026-10-19 incident;**
  **present in `release-2026-10-27` through `release-2026-10-29`;**
  **coded as a hotfix on 2026-10-29, ships with the hotfix tag `release-2026-10-29-b134` / the next version): when the home region is not in the United States, the CodeBuild of "Execution Environments → Redeploy / New" on the page fails at its very first command `cdk bootstrap`;
  the page shows "preview ended but no impact verdict could be obtained (buildPhase=FAILED) — cannot confirm what this run would change, aborted", and the log line is identical to the 2026-10-19 incident.**
  - Root cause: that `cdk bootstrap` line carries no `-c exec-env-target`, the CDK CLI still executes the CDK app and takes the control-plane branch, so the 2026-10-19 fix (calling the guard only on the control-plane branch) has no effect on it.
  - **Transition (to be done after every control-plane deployment / upgrade until the version with the root fix is installed)**: add the environment variable `BEDROCK_MODEL_ID` = the platform container's current default model id to the CodeBuild project `bgp-exec-env-deploy`
    (a `global.` prefix passes the guard; read the current state and write the whole block back, do not retype `EXEC_ENV_SOURCE_REF` by hand):
  ```bash
  aws --profile <profile> --region <home-region> codebuild batch-get-projects --names bgp-exec-env-deploy --query 'projects[0].environment' --output json > /tmp/cb-env.json
  jq '.environmentVariables = ([.environmentVariables[] | select(.name!="BEDROCK_MODEL_ID")] + [{"name":"BEDROCK_MODEL_ID","value":"<the platform's current default model id>","type":"PLAINTEXT"}])' /tmp/cb-env.json > /tmp/cb-env-new.json
  aws --profile <profile> --region <home-region> codebuild update-project --name bgp-exec-env-deploy --environment file:///tmp/cb-env-new.json --query 'project.environment.environmentVariables[].name' --output text
  ```
  - The last command should print `EXEC_ENV_SOURCE_REF BEDROCK_MODEL_ID`;
  - then, on the execution environment detail page, "Resume" → "Redeploy".
  - Root fix = the buildspec's bootstrap becomes `cdk bootstrap --app ''` (bootstrap does not need a CDK app; `--app ''` makes the CLI execute no app code at all), and the offline synth gate really runs that line;
  - once the version with the root fix is installed, the variable can be removed.
  - Incidentally: the log lines `aws: [ERROR] … ChangeSet [bgp-p0e-preview] does not exist` (one per stack) after the preview gate cleans up its change sets are harmless confirmation reads, not failures.
  - Root cause of the original incident: the "default model geography guard" at the top level of `infra/bin/app.ts` (part of the hardening for a freely chosen home region, meant to stop a bare `cdk deploy` from putting a `us.` model into a European / Asia-Pacific home region)
    sits before the "control plane / execution-environment stack group" fork, so the execution-environment path also passes through it; CodeBuild has no `BEDROCK_MODEL_ID`, the guard takes the factory default `us.anthropic.…`,
    compares it with the home region `ap-southeast-1` and throws. The execution-environment stack group does not use a model at all — a pure collateral hit; the test accounts' home regions were all us-east-1, so it was never hit there.
  - Transition measure (production tag): add the environment variable `BEDROCK_MODEL_ID=<the same id as at first install>` to the CodeBuild project `bgp-exec-env-deploy` (command in [adding-a-region.md](adding-a-region.md)).
    An authorization redeploy within the same version does not wipe it; **upgrading to a new version does wipe it**, and the next version must include the root fix (guard runs only on the control-plane path).
  - Handling after a failure: detail page "Recover (record failure and unlock)" → add the variable → "Redeploy".
  - **The hotfix upgrade path was rehearsed in a test account ✅ (2026-10-29 06:55–07:42Z,**
    **test account in production mode + one `eu-sim` execution region)**: from `release-2026-10-29` check out `release-2026-10-29-b134` + `npm ci` in both directories + `EXEC_REGION_CANDIDATES=all-enabled BGP_DEPLOY_MODE=production redeploy-platform.sh` **exited 0**
    (step 2b ExecEnvDeploy stack source package refreshed at 06:56Z, 2c / 2c′ / 2c″ all no-op, platform stack rolled 06:59–07:02Z,
    no downtime;
    IAM gate green), `GET /api/public/version` = `release-2026-10-29-b134` / the hotfix product commit / 2.1.2, the CodeBuild project `bgp-exec-env-deploy` carried only the variable `EXEC_ENV_SOURCE_REF` (**no** `BEDROCK_MODEL_ID`)
    ⇒ the page "Redeploy" preview got through bootstrap (build log `npx cdk bootstrap --app '' … ⇒ Environment … bootstrapped (no changes)`)
    ⇒ dialog "7 stacks, 0 changes in total; source has drifted and there is no explicit wave authorization ⇒ approval required" (the preview build exits 1 by design = the approval checkpoint of the preview gate)
    ⇒ approve
    ⇒ deployment build SUCCEEDED
    ⇒ "Check initialization"
    ⇒ active;
    the test account's home region is in the United States ⇒ the half where the guard would fire can still only be covered by the offline synth gate + a regression after it lands in customer production.
- **Jurisdiction label** (the "jurisdiction" field of the "New execution environment" wizard, default `home`): filled in **by hand** by the administrator; the platform **does not derive it from the region**, it **cannot be changed** after registration, and no legal judgment is made.
  When the execution region is not in the same jurisdiction as the home region it must be changed to a value other than `home` (for example `eu-sim`); the wizard shows a hint at the input field but does not block.
  A non-`home` execution environment has four extra things: a disclaimer to accept before deployment (retained) · residency-api must be installed (the region's regional audit table / regional result table / residency bucket) ·
  dual audit for every data operation (full record in that region + a PII-free summary in the home region; if either write fails the operation is not executed, 503) · the SQL history text stays only in that region.
  - **Cross-jurisdiction execution environments were verified in a real environment** (2026-10-10/11, a second temporary account, production mode, home region us-west-2): the page wizard created an execution environment of jurisdiction `eu-sim` in us-east-1
    (step 2 read-only list = the complete component set + residency-api; the jurisdiction field shows its hint; without ticking the disclaimer deployment is impossible) → 7 stacks deployed → `redeploy-platform` authorized the region →
    "Check initialization" 20 items all green → "Enable".
    - The cross-jurisdiction acceptance segment passed all 36 checks, including: the region's two residency tables and the residency bucket RETAIN + replication forbidden · the three engines Redshift / Glue / EMR really ran in that region ·
      workspace whitelist · merged direct query · each user's first data operation pops up the disclaimer (cancel commits nothing, agreement is retained, bypassing the front end and calling directly gets 409) ·
      dual audit (full record in that region + a summary without the SQL text in the home region) · saving an Ask-Your-Data card across jurisdictions really writes the regional audit · the platform role can only append to the audit table (modify / delete explicitly denied by IAM).
    - That segment is part of the full acceptance gate (run for real in the second account in every round since).
  - One item still covered only by offline criteria and not rehearsed in a real environment: "regional audit write fails ⇒ the operation is refused (503)" (making the audit table write really fail would require changing live IAM or redeploying with a different table name).
- **Every execution region is a complete set** (user decision of 2026-10-10): a region has exactly one execution environment, and components cannot be trimmed (there is no reduced form such as "core only / no warehouse").
- **Objects the scheduling center can run automatically on a schedule**: sync tasks, workflows, batch jobs (Glue / Redshift / EMR), **governance tasks** (quality checks / sensitivity scans / catalog sync; a scheduled catalog sync samples
  the warehouse and incurs warehouse compute cost, the UI says so),
  **scheduled refresh of Ask-Your-Data cards** (refreshes the same card and keeps a run history, without consuming card quota). Scheduling runs on **each region's own** MWAA Serverless and only reports run records to the home region;
  the governance and card items have both been run automatically by the scheduler in two regions (run instance page "trigger = automatic").
- **Modeling (code tables / dimension tables) landing in a non-home execution region**: delivered — each region has a writer account with per-table permissions only (cannot create tables, cannot read other tables); table creation goes through the platform administrator channel;
  the model table structures of the two regions are byte-for-byte identical.
- **Phase two**: schema / column-level lineage of non-home-region sync tasks in OpenMetadata presented per region (that region's tables are carried by the metadata mirror; the home-region view is not pushed over them).
- **No seed data in production**: the scheduled dispatch of demonstration seed data is outside the production scope.
- The protection "when AWS refuses to stop a sync task ⇒ the platform reports 502 and leaves the record unchanged" is covered by offline criteria (a real environment cannot make AWS really refuse) and has not been rehearsed in a real environment.
- **Backfill center, multi-region placement (fixed in this version and verified in a real environment)**: ① backfilling an **EMR job** bound to several regions runs each region's instance **in its own region**
  (verified in a full acceptance round: one run in each of two regions, both succeeded); ② a backfill request for a workflow bound to a non-home region is refused explicitly, naming that region
  (the workflow execution contract is still the home region; to backfill, backfill the individual batch job, or change the workflow to bind the home region only);
  ③ the backfill plan is advanced by a background pump and completes even with the page closed (verified in a full acceptance round: page closed, 2 regions × 3 days = 6 instances all succeeded, one row per day in each region's warehouse).
- **Tables synced into the customer's own S3 Tables table bucket are temporarily invisible in the platform** (**fixed on the development branch, delivered with the next release — in the new version, after registering the external table bucket per region under "Settings",
  the table tree / governance catalog / Ask-Your-Data see it; production `release-2026-10-13` still has this boundary**): the table tree on the left of Lake Query, the governance catalog and Ask-Your-Data currently list only **the platform's own table bucket** of each region;
  - a sync task can write its target into the customer's own table bucket and the data is written correctly, but it does not appear in the table tree / catalog / Ask-Your-Data.
  - Transition: in the Lake Query editor hand-write a three-part-name query `"s3tablescatalog/<customer-table-bucket>"."<namespace>"."<table>"` (the platform role only needs read permission on that table bucket).
- **The data-source page's "Detect (heartbeat)" and "Browse tables" connect to the source database directly from the platform control plane** (**fixed in the next release — the new "Detect" / "Browse tables" start a discovery job through the data source's own Glue connection to log in to the source,
  bringing back the table list on success and Glue's message on failure; the production tag still has this boundary**): when the source database is in another VPC or its public endpoint admits only its own network, it shows unreachable and the table list is empty,
  while Glue sync jobs running in the customer's subnets are **not affected**; do not change the customer's source security groups for this. In the creation wizard, "Test connection" only checks that the Glue connection exists for JDBC sources
  (see the "Connected right after creation" entry), and "Network configuration" only reads subnet / security-group facts.
- **The scheduler configuration page** in a region that has only MWAA Serverless falsely reports "this region has no Airflow environment yet" (**fixed in the next release; the production tag still has it**): scheduling (enabling a schedule / publishing a workflow) actually works;
  the component list on the execution environment page is authoritative.
- **A sync task that already has a Glue job** may report 502 "save did not take effect" after changing workers / target table bucket and so on (**fixed in the next release — saving updates or creates depending on whether the Glue job exists, and failures are reported honestly;
  the production tag still has it**): transition = delete and recreate the task (the configuration takes effect on recreation); **a sync task writing to S3 Tables must use Glue version 5.1** (not validated on the production version;
  5.0 fails at run time with `Invalid S3 URI … arn:aws:s3tables`; **fixed in the next release — wizard / create / save / start all write 5.1 uniformly**).
- **In an environment that has never run a "sync task writing to S3 Tables", Lake Query (`/athena`) and Ask-Your-Data's lake queries always report `CATALOG_NOT_FOUND`** (**fixed on the development branch, with the next release —
  the new install / upgrade scripts open the federated catalog explicitly and Lake Query self-heals; production `release-2026-10-13` still has it**): the production version creates the Glue federated catalog `s3tablescatalog` only incidentally,
  on the start path of a sync task writing to S3 Tables; it is not a CDK resource.
  - Production transition (run by the customer in their own account, idempotent; once in the home region and once in every execution region, replacing `<region>` / `<account-id>` with that region and the account):

  ```bash
  aws glue create-catalog --profile <profile> --region <region> --name s3tablescatalog --catalog-input '{"Description":"Federated catalog for S3 Tables","FederatedCatalog":{"Identifier":"arn:aws:s3tables:<region>:<account-id>:bucket/*","ConnectionName":"aws:s3tables"},"CreateDatabaseDefaultPermissions":[{"Principal":{"DataLakePrincipalIdentifier":"IAM_ALLOWED_PRINCIPALS"},"Permissions":["ALL"]}],"CreateTableDefaultPermissions":[{"Principal":{"DataLakePrincipalIdentifier":"IAM_ALLOWED_PRINCIPALS"},"Permissions":["ALL"]}]}'
  ```

  Or start any sync task with S3 Tables as its target once; the criterion is that `aws glue get-catalog --profile <profile> --region <region> --catalog-id s3tablescatalog` returns `FederatedCatalog.ConnectionName = aws:s3tables`.
- **Right after creating a data source its status cell shows "Connected (N ms)", which only means the Glue connection is in place, not that the source database is reachable** (**fixed from `release-2026-10-27`; the previous tag still has it**:
  in the new version "Connected" may only come from a real connection; after creation the status is first "Testing", and an unreachable source honestly shows "Unreachable"): the creation flow of the production tag only checks that the Glue connection exists + JDBC URL + subnet,
  without logging in to the source database; to confirm that the source is really reachable press "Detect".
- **A sync task of a non-home execution environment that names its own S3 Tables table bucket ⇒ start returns 409 "the task's own table bucket … does not match ⇒ refused", and still refuses after registration as an external table bucket**
  (customer feedback of 2026-10-27; **fixed from `release-2026-10-28`** — registration = visible + writable, execution-region roles allowed on any table bucket of the same region, unregistered buckets flagged in the wizard with a path to registration;
  the upgrade requires "Redeploy" on every execution region's page, section 7ter.1g): transition on the production tag = use own buckets only in home-region tasks, and leave the table bucket empty in execution-region tasks to use that region's platform table bucket.
- **After a DMS real-time sync task fails on the DMS side, the sync list keeps showing "running" with a "Stop" entry until someone opens the task's detail page** (**fixed from `release-2026-10-28`** — list-time reconciliation dispatches by
  channel and honestly shows "failed" without opening the detail page;
  the Zero-ETL channel likewise): on the production tag, opening the task's detail page writes the real status back.
- **Governance catalog "Sync column information" may wait 60 seconds in an environment with many tables and then report "sync failed", while the sync has already completed in the background** (**fixed in the next release — the new version
  returns "in progress" when not done within 45 seconds and the page polls to the conclusion;
  from the second batch of the long-running-operation framework it takes the same path as modeling landing (section 7ter.1d row 5); the production tag still has it**): on the production version the load balancer's 60-second timeout cuts the long call;
  refresh the governance catalog to see the result, do not press again.
- **An upgrade that runs only `redeploy-platform.sh` does not refresh the three AgentCore agents** (**fixed on the development branch with the new `scripts/redeploy-agents.sh`, pending one real run in a test account, delivered with the next release;
  the repository at the production tag `release-2026-10-13` has no such script**): the agent containers carry the Ask-Your-Data / advisor core and the script-generation recipes; when a new version changes these and only the platform is redeployed, the agents keep running the old code.
  - Upgrading from the production tag to the next version: `git checkout <new-tag>` first, then run the script per section 7ter step 2b (`--check` first to see whether a refresh is needed).
- **Boundaries of the multi-vendor model channel (from `release-2026-10-27`)**: ① GLM 5.3 (`zai.glm-5.3`) may be **not enabled at account level** on Bedrock (its words: "not available for this account"); this has nothing to do with region /
  IAM / Marketplace and can only be enabled by your AWS account team;
  - the platform classifies it separately as "not enabled for this account" and shows it as such; the deployment-time candidate chain falls through to the next candidate automatically;
  - ② Kimi K3 always carries reasoning blocks and its output tokens are about 2× Claude's (the platform scales maxTokens by a factor; the reasoning blocks are transparent to the page), so cost and response time rise accordingly;
  - ③ the GPT-5.6 family is still kept closed by the transport gate (as in the previous version);
  - ④ the field support / tool-use / reasoning blocks of GLM 5.3 itself can only be measured once an account has it enabled; in this wave the channel was verified with `zai.glm-5` of the same family.
- **Data-plane credentials**: this version creates a "platform data-plane role" in every region, but production still uses the platform task role by default (`taskrole`, same behavior as the previous version).
  🔴 That is, the defense-in-depth layer "the platform task role no longer holds data-plane permissions and IAM stops cross-region access" **is not yet in effect in this version** (a later batch of the place-first work); cross-region access is refused by the application-layer place check.
- **Home-region "New data source" 504 (present in 2.1.1 and every earlier version; **fixed from `release-2026-10-29` (2.1.2)** — the creation provision segment joins the long-running-operation framework + Glue role verification leaves the
  request path + network budget for every SDK client, section 7ter.1h)**:
  from the home-region view, after pressing "Create Data Source" in "New data source", if one network hop from the platform process to IAM / EC2 / Glue stalls for more than about 60 seconds the page reports 504 while the server creates the source anyway
  ⇒ when you see the error, **refresh the list first** to see whether the row has appeared, and do not press "Done" again (pressing again creates a second source with the same name).
  - From 2.1.2 creation follows the background-execution protocol: done in one go within 45 seconds, otherwise the bottom right shows "Running in background: New data source" until it is created, and a second press for the same name is refused.
- **Orphaned security group after deleting a data source (all versions; fixed in the next version — fixed on the development branch, verified in a test account by page-driven acceptance on 2026-10-30)**: after deleting a data source, the
  platform-created security group `bgp-ds-<last 8 characters of the source id>`
  occasionally stays in the VPC — when the source is deleted shortly after creation (while the network interface of the connectivity-probe Glue job is still attached), the platform's background retry gives up after 5 minutes.
  It can be deleted by hand once the group's network interface count is 0; the root fix (a persistent record of groups awaiting cleanup, persistent retries driven by network-interface facts) ships with the next version (not in 2.1.2).
- **Deleting a referenced data source (all versions; fixed in the next version — fixed on the development branch, verified in a test account by page-driven acceptance)**: "Delete" on a data source does not check whether the source is still referenced by sync / real-time tasks —
  after the source is gone the tasks referencing it stay in the list, and only the next scheduled trigger or "Start" reports "Glue connection does not exist / secret does not exist". Before deleting a source, filter "Data Sync" by data source and confirm no task references it;
  if one was deleted by mistake, edit those tasks to a new source or delete them. From the next version, deleting a source that is still referenced is refused, listing the tasks one by one.
- **Ghost row after deleting a data source (all versions; fixed in the next version — fixed on the development branch, verified in a test account by page-driven acceptance)**: within a few minutes after deleting a data source the list may
  gain one row **without a name and with status "Unreachable"** —
  a connectivity probe that was still running at the moment of deletion wrote its conclusion back to the deleted record. It is not a real data source; press "Delete" on it to clear it; it affects no task.
- **Platform-created security groups deleted by cleanup tools (all versions; fixed in the next version — fixed on the development branch, verified in a test account by page-driven acceptance: when a platform-created group / connection has
  been deleted, a sync "Start" or the 10-minute patrol rebuilds it automatically and writes an audit / alert;
  when a user-supplied group has been deleted ⇒ the source is flagged "Network object missing", "Start" returns 409 naming it, and choosing another group under "Network configuration" recovers it)**: the security groups `bgp-ds-*` the platform creates for data sources
  carry a network interface only while a sync / probe job is running and have zero interfaces the rest of the time — **do not let any tool or process that cleans up security groups by "no interface = orphan" touch them**.
  - Once deleted, that source's sync / scheduled runs fail with "Security Group Not Found …" while the data source still shows "Connected";
  - this version has no self-healing and no repair entry point; the only way is to delete the data source, recreate it and point the referencing tasks at the new source (first check the references as in the previous entry's transition).
  - From the next version the platform rebuilds these objects automatically at use time and raises an alert, and tags them `bgp:managed` so cleanup processes can exclude them.
- **Stream compute sample data (all versions; fixed in the next version — fixed on the development branch, verified in a test account with two-region showcase data + page-driven acceptance)**: after "Generate Data" on the Stream Compute page the aggregation result may be very small or even 0 rows —
  the sample events are written in random order while the sample SQL's watermark tolerates only 5 seconds of disorder, so most records are dropped as late. Transition: press "Generate Data" several times (a new wave closes the windows the previous wave left open);
  incomplete results remain a known boundary; from the next version the sample data is written in ascending event-time order and every window is complete once it closes.
- **Spark engine job "Run" on a cold EMR application (all versions; fixed in the next version — fixed on the development branch, verified in a test account by page-driven acceptance)**: while the EMR application cold-starts, the page may report 504 / "service response error" after 60 seconds,
  although the run has in fact been submitted and will succeed — after the error, check "Run history" first for a new run and **do not press again** (a second press is a second run).
  From the next version the submission segment goes through the long-running-operation framework: beyond 45 seconds it moves to the background automatically and polls, and pressing "Run" / editing / deleting during submission returns 409 "in progress".
- **One batch job across several S3 Tables table buckets (read from the detail bucket, write to the summary bucket;**
  **root fix shipped with lake table-bucket routing and is in 2.2.0 — "Settings → Lake table buckets and routes" registers the buckets, the job declares them under "Advanced Properties → Lake table buckets", the platform registers the Spark catalogs itself with no `--conf`; upgrade notes in section 7ter.1j; production 2.1.2 still uses the transition below)**: 2.1.2 can do this without a code change — in the batch compute job's "Advanced Properties → Job parameters" add one parameter named `--conf`
  whose value is one group of 5 Iceberg catalog settings per bucket (`spark.sql.catalog.<catalog-name>=org.apache.iceberg.spark.SparkCatalog` ·
  `.catalog-impl=org.apache.iceberg.aws.glue.GlueCatalog` ·
  `.glue.id=<account-id>:s3tablescatalog/<bucket>` ·
  `.io-impl=org.apache.iceberg.aws.s3.S3FileIO` ·
  `.warehouse=arn:aws:s3tables:<region>:<account-id>:bucket/<bucket>`, several groups joined with ` --conf `), and the script uses three-part names `<catalog-name>.<namespace>.<table>`;
  - the platform Glue role is already allowed on any table bucket of its own region;
  - the Athena Query page can query any bucket of the same region with `"s3tablescatalog/<bucket>"."<namespace>"."<table>"` (that page is read-only).
  - Full steps and screenshots are in the "Cross-table-bucket read/write handbook (2.1.2)" delivered to the customer.
- Deferred items (least-privilege narrowing, secret rotation, OpenSearch sizing and snapshots, alerting and so on) are recorded as deferred in the engineering defect records.

## Appendix A. Configuration reference

This appendix is not part of the original manual; it is retained from the earlier English edition of this document because [operations.md](operations.md) refers to it for the meaning of each platform variable.

### A.1 Platform container environment

The platform container receives these variables from the CDK platform stack. "Set by" tells you where the value originates; none of them is edited by hand.

| Variable | Purpose | Set by |
|---|---|---|
| `AWS_REGION` | Home region | CDK stack region |
| `AWS_ACCOUNT_ID` | Account id | CDK stack account |
| `KEEP_ALIVE_TIMEOUT` | Node keep-alive, kept above the ALB idle timeout | CDK constant |
| `ACTION_DISPATCH_SECRET_ARN` | Shared secret for internal action endpoints | Platform stack resource |
| `ACTION_COMMANDS_TABLE` | Action command table | Platform stack resource |
| `NEXT_PUBLIC_COGNITO_USER_POOL_ID` | User pool for the browser | Auth stack output |
| `NEXT_PUBLIC_COGNITO_CLIENT_ID` | App client for the browser | Auth stack output |
| `COGNITO_USER_POOL_ID` | User pool for the server | Auth stack output |
| `COGNITO_CLIENT_ID` | App client for the server | Auth stack output |
| `REDSHIFT_WORKGROUP` | Home warehouse workgroup | Naming convention |
| `REDSHIFT_DATABASE` | Home warehouse database | CDK constant |
| `BEDROCK_MODEL_ID` | Default model | Installer, candidate chain or pinned |
| `GLUE_SCRIPTS_BUCKET` | Script bucket `bgp-glue-scripts-<account-id>` | Naming convention |
| `GLUE_ROLE_ARN` | Glue job role | Platform stack resource |
| `MWAA_DAG_BUCKET` | DAG bucket `bgp-mwaa-dags-<account-id>` | Naming convention |
| `MWAA_ENV_NAME` | Classic MWAA environment name | CDK constant |
| `EXECUTION_REGIONS` | Region allow-list baked into IAM | Derived by `redeploy-platform.sh` |
| `WORKFLOW_DAG_ENGINE` | DAG generator selector | Context `workflow-dag-engine`, default `legacy` |
| `PER_PROJECT_CRED` | Per-workspace warehouse identity | Context `per-project-cred`, default `off` |
| `BGP_DATAPLANE_JOBS_PAUSED` | Emergency stop for data-plane job pumps | Context `dataplane-jobs-paused`, default `0` |
| `BGP_DATAPLANE_AUTO_SUPPLY` | Auto-provision credentials on binding | Context `dataplane-auto-supply`, default `off` |
| `BGP_DATAPLANE_CREDS` | Data-plane credential mode | Context `dataplane-creds`, default `taskrole` |
| `LONG_OPS_SYNC_WAIT_MS` | In-process wait before a long-running operation returns 202 | Context `long-ops-sync-wait-ms`, default `45000` |
| `ATHENA_WORKGROUP` | Home Athena workgroup | Platform stack resource |
| `ATHENA_OUTPUT_LOCATION` | Athena result location | Platform stack resource |
| `S3TABLES_BUCKET` | Home table bucket name | CDK constant |
| `S3TABLES_CATALOG` | Federated catalog name `s3tablescatalog` | CDK constant |
| `S3TABLES_NAMESPACE` | Default lake namespace | CDK constant |
| `GENBI_BACKEND` | `agentcore` or `inprocess` | Wiring context from SSM |
| `GENBI_RUNTIME_ARN` | Ask-Your-Data agent runtime | Wiring context from SSM |
| `GENBI_MEMORY_BUCKET` | Long-term memory bucket | Naming convention |
| `GENBI_MEMORY_BACKEND` | `agentcore` or `selfmanaged` | Wiring context from SSM |
| `GENBI_MEMORY_ID` | Agent memory id | Wiring context from SSM |
| `GENBI_ASYNC` | Asynchronous query execution | Context `genbi-async`, default `1` |
| `NETADVISOR_BACKEND` | Network advisor backend | Wiring context from SSM |
| `NETADVISOR_RUNTIME_ARN` | Network advisor runtime | Wiring context from SSM |
| `NETADVISOR_MEMORY_BACKEND` | Network advisor memory backend | Wiring context from SSM |
| `NETADVISOR_MEMORY_ID` | Network advisor memory id | Wiring context from SSM |
| `PARAMADVISOR_BACKEND` | Parameter advisor backend | Wiring context from SSM |
| `PARAMADVISOR_RUNTIME_ARN` | Parameter advisor runtime | Wiring context from SSM |
| `PARAMADVISOR_MEMORY_BACKEND` | Parameter advisor memory backend | Wiring context from SSM |
| `PARAMADVISOR_MEMORY_ID` | Parameter advisor memory id | Wiring context from SSM |
| `OPENMETADATA_URL` | OpenMetadata endpoint | OpenMetadata service stack output |
| `OPENMETADATA_PUBLIC_URL` | OpenMetadata public endpoint | OpenMetadata service stack output |
| `PLATFORM_ALB_DNS` | Platform load balancer DNS | Platform stack resource |
| `DEFAULT_VPC_ID` | Home VPC | VPC stack |
| `DEFAULT_SUBNET_ID` | First private subnet | VPC stack |
| `DEFAULT_AZ` | First availability zone | VPC stack |
| `REDSHIFT_NAMESPACE` | Home warehouse namespace | CDK constant |
| `REDSHIFT_HOST` | Home warehouse endpoint | Derived from account and region |
| `DMS_REPLICATION_INSTANCE_ID` | Replication instance id `bgp-dms` | CDK constant |
| `DMS_ROLE_ARN` | DMS role | Derived from account |
| `DMS_TARGET_SECRET_ID` | Warehouse target secret for DMS | CDK constant |
| `FLINK_RUNTIME_ENVIRONMENT` | Managed Flink runtime | Context `flink-runtime`, default pinned in CDK |
| `FLINK_RUNTIME_ROLE_ARN` | Flink application role | Derived from account |
| `FLINK_SOURCE_STREAM` | Sample source stream name | CDK constant |
| `FLINK_CODE_BUCKET` | Bucket holding runner JARs | Naming convention |
| `FLINK_CODE_KEY` | Generic runner JAR key | CDK constant |
| `FLINK_OUTPUT_BUCKET` | Output bucket | Naming convention |
| `FLINK_SUBNET_IDS` | Private subnets for Flink | VPC stack |
| `FLINK_S3T_CODE_KEY` | Runner with S3 Tables sink | CDK constant |
| `FLINK_S3T_KAFKA_CODE_KEY` | Runner with Kafka source and S3 Tables sink | CDK constant |
| `FLINK_S3TABLES_BUCKET` | Table bucket for stream output | CDK constant |
| `FLINK_S3TABLE_DB` | Lake namespace for stream output | CDK constant |
| `EMR_EXECUTION_ROLE_ARN` | EMR Serverless execution role | Derived from account |
| `ROLE_PERMISSIONS_BOUNDARY_ARN` | Boundary attached to roles created by the role advisor | Platform stack resource |
| `EMR_RELEASE_LABEL` | EMR Serverless release | Context `emr-release`, default pinned in CDK |
| `EMR_CODE_BUCKET` | Script bucket for EMR | Naming convention |
| `EMR_OUTPUT_BUCKET` | Output bucket for EMR | Naming convention |
| `EMR_LOG_BUCKET` | Log bucket for EMR | Naming convention |
| `EMR_DEFAULT_SUBNET_IDS` | Private subnets for EMR | VPC stack |
| `EMR_S3TABLES_JAR` | S3 Tables catalog JAR location | Naming convention |
| `EMR_S3TABLES_WAREHOUSE_ARN` | Home table bucket warehouse ARN | Derived from account and region |

A key-only template of the same list is in `platform/.env.example`; a unit test keeps the two in step.
To read the live values of a deployment:

```bash
TD=$(aws --profile <profile> --region <home-region> ecs describe-services --cluster bgp-cluster \
  --services bgp-platform --query 'services[0].taskDefinition' --output text)
aws --profile <profile> --region <home-region> ecs describe-task-definition --task-definition "$TD" \
  --query 'taskDefinition.containerDefinitions[0].environment'
```

### A.2 SSM parameters

| Parameter | Content | Written by |
|---|---|---|
| `/bgp/deploy-mode` | `production` or `demo`; immutable | `deploy-all.sh` |
| `/bgp/wiring/*` | OpenMetadata URL, agent runtime ARNs and memory ids | `deploy-all.sh`, `redeploy-platform.sh` |
| `/bgp/wiring/execution-region-candidates` | Pre-authorized execution regions | `EXEC_REGION_CANDIDATES` |

### A.3 Secrets

| Secret | Content |
|---|---|
| `bgp/om/admin-password` | OpenMetadata administrator password, replaces the factory default |
| `bgp/dms/redshift-target` | Warehouse target credentials used by DMS |

## Appendix B. Deployment modes and red lines

Retained from the earlier English edition; it gathers in one place the rules that the sections above state where they apply.

| Aspect | `production` | `demo` |
|---|---|---|
| Seed data | none | demonstration dataset |
| Demonstration source database | not deployed | `BgpRdsStack` deployed |
| Initial Cognito users | `admin` only | `admin` plus test accounts |
| Stored in | SSM `/bgp/deploy-mode` | SSM `/bgp/deploy-mode` |

The mode is written once. `redeploy-platform.sh` and `10-bootstrap-cognito.sh` compare their mode with SSM and refuse a mismatch. There is no supported path from one mode to the other.

- Always pass `--profile <profile>` explicitly to the AWS CLI, and both positional arguments to every script. Missing arguments do not error; they fall back to `temp-account` and `us-east-1`.
- Never run a bare `cdk deploy`. Use `deploy-all.sh`, `redeploy-platform.sh` and `redeploy-agents.sh`.
  They carry the wiring context, the mode, the region allow-list, the agent image tags and the IAM gate.
  A bare deploy of the platform stack silently clears the AI wiring; a bare deploy of an agent stack deletes its runtime.
- Do not pass `-c dataplane-creds=...` in production. It is an acceptance switch, is not persisted in SSM, and the next redeploy silently returns to `taskrole`.
- Do not pass `-c long-ops-sync-wait-ms=...` in production. It forces every long-running operation onto the asynchronous path for acceptance testing.
- Do not import an existing VPC for a multi-region production install.
- Do not create execution regions outside the UI wizard, and do not trim their components.
- Do not run the deployment scripts with `AWS_REGION` pointing elsewhere.
  The scripts align `AWS_REGION`, `AWS_DEFAULT_REGION` and `CDK_DEFAULT_REGION` to the home region and refuse to synthesize when the target differs.
- Protect the password file and the installer log until the initial password has been changed; then delete both.

## Appendix C. Demo and acceptance mode

Retained from the earlier English edition. Demo mode exists for developer and demonstration accounts only; the manual above describes the production path only, and demo mode is not a production path.

- Install with `BGP_DEPLOY_MODE=demo ./scripts/deploy-all.sh <profile> <home-region>`. The installer adds a demonstration MySQL source database, a seeded dataset and test user accounts.
- A single-region demo in an account with no VPC quota can import an existing VPC with `EXISTING_VPC_ID=<vpc-id>`.
  The imported VPC needs at least two availability zones, each with a private subnet that has NAT egress.
  Import mode is incompatible with execution regions.
- `scripts/20-seed-data.sh <profile> <home-region>` reseeds the demonstration dataset.
- `scripts/32-verify-all-regions.sh <profile> <home-region>` runs the nine capability classes in every active execution region and leaves long-lived showcase objects behind.
- `scripts/35-rebuild-account.sh <profile> <home-region> <second-region>` chains pre-flight, install, truth check, seeding, a UI-driven region build and the headless acceptance suite.

The headless acceptance suite depends on a local, non-versioned test directory and is not part of a customer deployment.
