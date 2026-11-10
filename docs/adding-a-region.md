# Kingfisher Customer Production Environment: Adding an Execution Region (Operations Manual)

> Version: v1.5 (2026-10-29 04:0xZ, development-branch copy: **after the customer's production environment was upgraded to `release-2026-10-29` (2.1.2) on 2026-10-29, the transition variable of section 5.1 was found to still be required (the 2026-10-29
> recurrence: the `cdk bootstrap` line of the buildspec still executes the CDK application); it was added back the same day after the upgrade wiped it, with its value changed to the platform's current default model id (for this customer,
> `global.moonshotai.kimi-k3`);**
>
> Earlier revisions (7) are in the collapsible list below.

<details><summary>Revision history</summary>

**it is only no longer needed from the version that contains the root fix (hotfix `45e322a`, `cdk bootstrap --app ''`)**;
  the applicable-version line of section 0, section 5.1 and the transition-measure table row were updated accordingly) · v1.4 (2026-10-26, development-branch copy: the "from the next version (candidate-region pre-authorization)" wording in section 0 now means
  "from `release-2026-10-27`" — once `EXEC_REGION_CANDIDATES=all-enabled` has pre-authorized the candidate regions at install / upgrade time,
  adding a region inside the candidate set from the web UI no longer needs an operations-side authorization, and the rehearsal record in section 6c is the current behavior;
  the get-the-code example in section 3 was changed to the new tag;
v1.1 on `release-2026-10-13` is unchanged) · v1.3 (2026-10-19 evening, development-branch copy: new section 6c — a complete rehearsal record of the next version's "candidate-region pre-authorization" in the test environment (from web-UI creation to enabling with zero authorization commands;
  the rehearsal caught and fixed the probe-contract defect described in section 6c);
  the tag version v1.1 is unchanged) · v1.2 (2026-10-19 afternoon, development-branch copy: the "authorization must be done from the CLI" row in section 0 gained "from the next version, candidate regions can be pre-authorized";
v1.1 on tag `release-2026-10-13` is unchanged, and it describes exactly the behavior of the production tag) · v1.1 (2026-10-19;
v1.0 was written from the actual end-to-end region addition in Frankfurt (`eu-central-1`) on that day;
v1.1 added the handover notes in section 0b, the one-page quick reference in section 1b, the rehearsal switch and verified facts of the appendix script, and the full test-environment rehearsal record in section 6b)

</details>

> - Audience: customer administrators (operating the platform web UI) + customer operations staff (running commands on the deployment machine)
> - Applicable version: production **`release-2026-10-29`** (2.1.2, upgraded 2026-10-29; **the transition variable of section 5.1 is still required**, see the 2026-10-29 recurrence described there). Once the version is upgraded, this manual defers to the new
>   version's [deployment guide, section 7 "Adding an execution region"](deployment.md#7-adding-an-execution-region-after-go-live).
> - This manual is the **customer-specific, step-by-step expansion** of the [deployment guide's section 7 "Adding an execution region"](deployment.md#7-adding-an-execution-region-after-go-live); where the two conflict, that section takes precedence.
> - Location: `docs/adding-a-region.md` in the repository (online, or in a local clone).
> - **If you only want to read one page before acting, jump straight to section 1b "One-page quick reference"**; the explanation, expected output and exception handling for each step are in sections 2 to 5.
> - **AI tools or new colleagues taking over: read section 0b first** (system model, the design decision behind each step, how the 2026-10-19 model-guard incident came about, red lines, decision table, six self-check questions), then act.

---

## 0. Read first: three things that must be pinned down

| Item | Conclusion |
|---|---|
| **Code version** | The customer's production environment runs git tag `release-2026-10-13`, **product commit** `2b181dcefa52a9653f9d9c38d99d023e9fcc5ffa`. This tag is moved on GitHub as documentation is supplemented (only `*.md` files and images under `docs/diagrams/` are added; the product bytes do not change), so **do not trust the commit id; trust two things**: ① HEAD must be exactly tag `release-2026-10-13` (`git describe --tags --exact-match`); ② inside `platform / infra / scripts / flink-*`, everything except `*.md` must be byte-identical to product commit `2b181dc` (`git diff … ':!*.md'`; the README files inside product directories also change as documentation is supplemented). Only when both hold can the code be used; the development trunk contains a large amount of unreleased code; using it is equivalent to upgrading production and is absolutely forbidden |
| **Authorization must be done from the CLI** | The stacks of the new region are built by CodeBuild, triggered from the web wizard; but the step "authorize that region in the control plane" (changing the platform's own IAM region condition) can, in the current design, **only be done by operations redeploying the control plane from the deployment machine**; the web UI has no entry point for it (a security decision: the platform must not grant itself more power). Do it once per added region. **From `release-2026-10-27` (candidate-region pre-authorization; the tag version of this document on `release-2026-10-13` does not have it)**: at upgrade time, `EXEC_REGION_CANDIDATES=<region1,region2,…>` pre-authorizes candidate regions in one go, and adding a region inside the candidate set no longer needs step 3 of this document (the wizard labels it "pre-authorized, usable right after the build"); the security design is unchanged; only the moment at which "a human decides which regions the platform may touch" is moved forward to the upgrade |
| **The current transition measure** | On 2026-10-19 a defect was found in the current version: the CodeBuild run that builds an execution region is wrongly blocked by the "default-model geography guard" and fails when the home region is not in the United States. The transition = add the environment variable `BEDROCK_MODEL_ID=global.anthropic.claude-opus-4-5-20251101-v1:0` to the CodeBuild project `bgp-exec-env-deploy`; **the administrator added it on the same day**. As long as it is present, building any new region will not hit the guard again; it is wiped on **every control-plane deployment / upgrade**; 🔴 **Verified on 2026-10-29 after the upgrade to 2.1.2: it is still required (the `cdk bootstrap` line of the buildspec still executes the CDK application); it was added back the same day after the upgrade, with the value changed to `global.moonshotai.kimi-k3` (= the platform container's current default model)**; it is only no longer needed from the version that contains the root fix for that recurrence (hotfix `45e322a`, `cdk bootstrap --app ''`) |

---

## 0b. For the AI tool or new colleague taking over: what the system looks like, why the procedure is what it is, which lines must not be crossed (do not act before finishing this)

> Reading order: `AGENTS.md` at the repository root (project index and red lines) → this section → the [deployment guide](deployment.md), sections "5. Add an execution region" and "8. Decommission a region" → back to section 1b of this document to act. This
> section describes **mechanisms and reasons**, so that you can judge for yourself when a situation arises that the document does not cover; code locations are given for the production tag `release-2026-10-13` (product commit `2b181dc`); when taking over, run
> `git grep` once to confirm them before citing them.

### 0b.1 System model (the parts relevant to this procedure)

| Component | Where it is | How it relates to adding a region |
|---|---|---|
| **Control plane** | Home region `ap-southeast-1`: the ECS Fargate platform container (2 tasks, cluster `bgp-cluster`, service `bgp-platform`), Cognito, DynamoDB (71 `bgp-*` tables), OpenMetadata, three AgentCore agents, CloudFront + WAF | The web UI, the registry and the authorized-region list all live here. The add-region procedure only **updates** its `BgpPlatformStack` and touches no other control-plane stack |
| **Execution-environment registry** | DynamoDB `bgp-execution-envs` (home region), one row per region keyed by `targetId` (the home region is fixed to `tgt_home`; others such as `tgt_euc1_a`), with `region / status / lockEpoch / observed.operation` and so on | The web wizard writes it; the authorization script of section 1b derives "which regions should be authorized" from it (the `region` field, excluding `status=deleted`); code `platform/src/lib/exec-env/registry.ts` |
| **Execution-environment stack group** | CloudFormation stacks in the target region: `BgpExecEnv-<slug>-base / -core / -redshift / -dms / -flink / -airflow-serverless` (a non-`home` jurisdiction adds `-residency-api`); `infra/lib/exec-env/stack-group.ts` | This is the "execution region" itself: a self-built VPC (zero internet egress; every AWS call goes through interface endpoints) + CMK + warehouse + sync / real-time / scheduling components |
| **Execution-environment deployment mechanism** | The control-plane stack `BgpExecEnvDeployStack` (`infra/lib/exec-env/deploy-stack.ts`) = one CodeBuild project `bgp-exec-env-deploy` in the home region + one narrowly privileged broker Lambda `bgp-exec-env-broker` (`infra/lambda/exec-env-broker/index.mjs`). The source for CodeBuild is **the zip packaged and uploaded from the deployment machine's code directory at the last control-plane deployment** (project environment variable `EXEC_ENV_SOURCE_REF`); buildspec `infra/buildspec/exec-env-deploy.yml` | **New / Redeploy** in the web UI only calls the broker; the broker alone issues `StartBuild`; CodeBuild runs `cdk bootstrap` + `cdk deploy "BgpExecEnv-<slug>-*" -c exec-env-target=…` in the target region. 🔴 Therefore **whatever code is used on the deployment machine to redeploy the control plane is the code every later execution-region build will use** — this is the second reason why "the code must be the production tag" |
| **Authorized-region list** | Two places, one source: ① the `aws:RequestedRegion` condition on each IAM policy of the platform TaskRole (`infra/lib/shared/execution-regions.ts`, **baked in at synth time**, from `-c execution-regions=`); ② the platform container environment variable `EXECUTION_REGIONS` (the same resolved list) | For a region not in the list, the platform's own IAM **denies** reading secrets / listing table buckets in that region. The platform process only reads this list in order to phrase "the control plane has not authorized this region yet" in plain language (`platform/src/lib/exec-env/control-plane-regions.ts`); it **never authorizes automatically** |
| **Authorization script** | `scripts/redeploy-platform.sh <profile> <home-region>`, step 1 reads the real wiring from CloudFormation → 1b derives the region list from the registry → 2 writes SSM `/bgp/wiring/*` → 2b/2c/2d three control-plane stacks → 3 the platform stack (with `-c execution-regions=`) → 3b OpenMetadata password check → 4 the IAM simulation gate (`scripts/iam-simulate-gate.py` runs SimulatePrincipalPolicy against the TaskRole using `infra/iam/platform-taskrole-calls.json`) | This is the **only legitimate path** for authorization; a bare `cdk deploy` would wipe the wiring and shrink the authorized-region list back to the home region only |
| **Execution-environment detail page** | `platform/src/app/exec-envs/TargetDetail.tsx`: the **Trigger deployment / Redeploy** buttons appear only for statuses in `DEPLOYABLE_STATUS` (line 31); `deployBlocked` = the recovery verdict says "session in flight" or "unknown" (line 200); the recovery verdict lives in `platform/src/lib/exec-env/recovery.ts` | Explains "why Redeploy is grayed out after a failed build": the previous session has not been closed, the product forbids silent retries, and a human must press **Recover (record failure and unlock)** |

### 0b.2 Why the procedure is what it is (the design decision behind each step)

| Step | Why |
|---|---|
| Execution regions are built from the web wizard; CLI `cdk deploy BgpExecEnv-*` / writing the registry directly are not allowed | A user red line of 2026-10-14 (`AGENTS.md`, non-negotiable rules): the home region = the one chosen at install time; every other region may only be created through the web wizard (register → broker → CodeBuild → authorize → Check initialization → Enable). The wizard enforces a read-only component set, the jurisdiction, the disclaimer, address-range allocation (from an internal address pool, such as `10.128.0.0/16`), the one-environment-per-region quota and other checks; bypassing it from the CLI creates environments the platform does not recognize |
| Authorization can only be done by operations redeploying the control plane; the web UI has no entry point | The security decision of the multi-region design ([design note, "Deployment mechanism and privilege isolation"](design/multi-region-execution.md#45-deployment-mechanism-and-privilege-isolation)): **the platform must not grant itself more power**, and the highly privileged pipeline that builds execution regions **must not touch control-plane IAM**. The price is that adding a region is half web UI, half CLI (a known product gap, since closed by candidate-region pre-authorization at install time, released 2026-10-27). Whoever takes over must **not** try to add "automatic authorization" to the web UI or the broker |
| The code must be the production tag (`git describe --tags --exact-match` must match exactly) and the product directories must be byte-identical to `2b181dc` | ① Running `redeploy-platform.sh` on any other commit = upgrading production (the platform image, IAM and wiring would all change); ② it also packages the code on the deployment machine as the source for every later execution-region build (0b.1); ③ the tag itself moves as documentation is supplemented, so the gate does not trust the commit id but "exact tag match + product directories excluding `*.md` byte-identical" |
| `BGP_DEPLOY_MODE=production` must be given explicitly | The script compares it with SSM `/bgp/deploy-mode` and refuses to run on a mismatch; the mode decides whether demo data is seeded and test accounts created, and once set it must never be changed. The command shown in the web UI hint omits it; copying that command verbatim is rejected |
| `BEDROCK_MODEL_ID` must be given explicitly | Without it, the script **really invokes** Bedrock along the candidate chain to pick a model; in this account Anthropic models are unavailable at the account level ("not allowed from unsupported countries"), so no model can be selected and the script fails. Giving it explicitly only writes the value into the platform container's environment variables and triggers no call; the value is the same as at the initial install |
| Wait for the six stacks to reach `CREATE_COMPLETE` before authorizing | Two reasons: ① step 2b of the authorization script also redeploys `BgpExecEnvDeployStack` (the very CodeBuild project itself) along the way; changing it while a build is halfway through is asking for trouble; ② **Check initialization** needs both "stacks built" and "authorized". Step 1b of the script only checks that the registry has the row, not the stacks, so it will not keep this order for you; a human must |
| Press **Check initialization** → **Enable** only after authorizing | Check = the platform uses its new IAM to probe each resource in the target region and writes the resource bag (`datalakeBucket / tableBucket / …`) back to the registry; Enable = the status becomes `active` and the region starts accepting work. Pressing Check before authorization is denied by the platform's own IAM; the web UI shows the derived symptom "descriptor is missing resources.*", while the real cause is in the API's `finalizeError` |
| Do not press Ctrl+C halfway | Once a CloudFormation update has started, it does not stop because the CLI exits; interrupting only prevents step 4 (IAM gate) and the closing checks of the script from running, leaving a state of "not knowing whether it succeeded" |

### 0b.3 How the 2026-10-19 model-guard incident came about (the trap a successor is most likely to hit again)

- **Symptom**: in an account whose home region is not in the United States, building any execution region from the web UI makes CodeBuild fail after 75 seconds at the `npx cdk bootstrap` step, and not a single stack is created. The verbatim log line is in section 5.1.
- **Root cause**: the two "control-plane go-live hardening" guards in `infra/bin/app.ts` lines 38 to 47 (`homeRegionMismatch` / `modelRegionMismatch(resolveModelId(), env.region)`) are written at module top level, **before** the "control plane /
  execution-environment stack group" fork at line 237 (`readExecEnvContext`), so the execution-environment path also runs through them;
  - inside CodeBuild only the `EXEC_ENV_*` variables exist (`deploy-stack.ts` injects only `EXEC_ENV_SOURCE_REF`, the broker injects only `EXEC_ENV_*`), so `resolveModelId()` falls back to the factory default `us.anthropic.…` in `platform/ai-model.json`, which
    does not match `ap-southeast-1`, and the guard throws.
  - The execution-environment stack group contains not a single model reference (in `infra/lib/exec-env/`, agentcore belongs to `EXTERNAL_COMPONENTS`); it is pure collateral damage.
- **Why it was not found earlier**: the home region of all three developer test accounts is us-east-1, so `us.` happened to match; the offline synth gate had no "non-US home region + exec-env-target" case.
- **Transition**: add `BEDROCK_MODEL_ID=<the same id as at the initial install>` to the CodeBuild project; `global.` is not one of the guard's three prefixes us. / eu. / apac., so it passes. It survives authorization redeployments within the same version
  (`BgpExecEnvDeployStack` is not updated when there is no difference) but **is wiped when upgrading to a new version**.
- **Root fix**: move the two guards into the `else { synthControlPlane() }` branch; add two cases to the synth gate: "non-US home region + exec-env-target must pass" and "under the same conditions the control plane must fail with the guard's verbatim message".
  After the fix, a region must be really added once more through the web wizard in a test account as a regression check. This is the incident of 2026-10-19 described in section 5.1.

### 0b.4 Red lines for whoever takes over (from the non-negotiable rules in `AGENTS.md` and repeated by the user many times; breaking any one of them is worse than not finishing)

1. **Everything in the customer account is read-only by default**: use only `describe / list / get / scan`-type calls; the only write operation in this procedure is the single authorization command of section 3.3, and it may be run **only after a human has
   explicitly said "execute"**. The customer's source databases / security groups / secrets / the customer's own Glue jobs / the customer's own VPCs and table buckets are never touched.
2. For any production command shown to a human, **first list the three columns "what it changes / what it does not change / how to roll back", then give the command, and state "to be executed after you confirm"**; do not put a directly runnable production command inside an "explanation".
3. The code is judged only by the two criteria of section 0; **never** run `git fetch / pull / checkout` in the code directory; **never** use the development trunk or any non-tag commit; **never** run a bare `cdk deploy`.
4. Do not add IAM permissions on the customer's behalf and do not modify any resource other than the CodeBuild project; anything an administrator must do (the transition variable of section 5.1, the administrator credentials used for authorization, the revocation
   afterwards) is written out clearly for the human to do.
5. Passwords are never printed or logged (both the web administrator password and the OpenMetadata password); in reports, write only the last digits of an account id; ARNs are never written into documents.
6. Acceptance is judged **by the web UI**: the evidence that a region was added successfully is the execution-environment card showing **Running / Accepting work**, not some CLI call returning 200; CLI and logs are used only to locate causes.
7. If an operation is stopped by a tool's safety policy, do not retry by another route; note it and tell the human.

### 0b.5 Decision table (what you see → where to look → what to do)

| Situation | Look first at | Conclusion / action |
|---|---|---|
| The web UI shows "deployment failed" | The log of the most recent CodeBuild build: `aws --profile <profile> --region ap-southeast-1 logs tail /aws/codebuild/bgp-exec-env-deploy --since 1h` (or the console) | Classify by the ❌ line in the log: model guard ⇒ the 2026-10-19 incident (section 5.1); "fewer than 2 usable AZs" / "no supported AZ found for the endpoint service" ⇒ the region does not meet the prerequisites; anything else ⇒ record the verbatim text, do not guess |
| The **Redeploy** button is grayed out | The banner on the detail page: red "Manual recovery required … build=FAILED" | This is the product's session lock. Press **Recover (record failure and unlock)** → confirm → the button lights up. If the banner says "Deployment session in flight … build still running", **wait**; do not recover |
| Banner "this deployment's build has SUCCEEDED; complete it through Check initialization" | — | The build succeeded and the session is waiting for **Check initialization** to close it. Authorize first (section 3.3), then press Check |
| The card status is one of `registered` / `initializing` / `testing` / `active` and you do not know what to do | The lifecycle of the registry `status` | `registered` = just registered, build not yet triggered; `initializing` = building (or the build just finished and the page has not refreshed); `testing` = build succeeded, waiting for **Check initialization**; `active` = enabled. Only `testing` (and already authorized) is the state in which to press **Check initialization** |
| The region list printed by step 1b of the authorization script does not contain the new region | The registry `status` of that region | Only rows whose status is not `deleted` are counted; go back to the web UI and look at that environment's status; do not continue |
| The authorization script ends with "⚠️ the IAM simulation gate did not run / some rows could not be evaluated (SCP)" | The following sentence "the platform stack has been deployed … the authorized-region list has also been written" | Authorization **is complete**; proceed to section 3.4. Only a red `ERROR:` is a failure |
| `BgpPlatformStack` goes to `UPDATE_ROLLBACK_*` | `ResourceStatusReason` of the `FAILED` rows in `describe-stack-events` | The platform automatically returns to the previous task definition and the service is not interrupted; record the verbatim text for the developers, fix, then rerun the authorization |
| **Check initialization** is still red after authorization | The verbatim text of the red items; `ecs describe-task-definition` to see whether `EXECUTION_REGIONS` contains the new region | Not contained ⇒ ECS has not finished rolling or the authorization did not succeed; contained ⇒ give the verbatim red items to the developers |
| You want to verify "what exactly did the authorization change" | `describe-stack-events --stack-name BgpPlatformStack`, tally `ResourceType` within the time window | Only `AWS::IAM::ManagedPolicy / AWS::IAM::Policy / AWS::ECS::TaskDefinition / AWS::ECS::Service` should appear; any DynamoDB / S3 / Redshift / RDS / Cognito / KMS type is abnormal — stop immediately and escalate |
| You suspect the rollout affected tasks / schedules | Scan `bgp-task-runs` over the time window by `updatedAt / startedAt / finishedAt` (ISO strings); MWAA Serverless `list-workflow-runs`; Glue `get-job-runs` | Jobs run inside their own AWS services and DAG steps call boto3 directly (`platform/src/lib/scheduler/serverless/runtime-py.ts`), not through the platform API; measured on 2026-10-19: 0 changes within the window |

### 0b.6 Handover self-check (if you cannot answer any one of these, go back and read `AGENTS.md` and this section)

1. Which two same-source lists does authorization change? Why can the web UI not do it?
2. Why must `redeploy-platform.sh` not be run on the development trunk? Give two reasons.
3. What happens if `BGP_DEPLOY_MODE` and `BEDROCK_MODEL_ID` are not given explicitly?
4. Why is **Redeploy** grayed out after a failed build? What is the correct unlocking action?
5. In which file and which lines is the root cause of the 2026-10-19 model-guard incident? When does the transition variable disappear?
6. Which is the only write operation in this procedure? What must be shown to the human before it?

---

## 1. Division of work and overall procedure

| Step | Who | Where | What | Duration (measured in Frankfurt) |
|---|---|---|---|---|
| One-time preparation | Operations | Deployment machine | Install tools, get the code at the tag, install dependencies, prepare AWS credentials (section 2) | 30 minutes |
| 0 Pre-check | Operations | Deployment machine (read-only) | Three code gates + CodeBuild variables + availability of the new region (section 3.0) | 2 minutes |
| 1 Register | Administrator | Platform web UI | **Execution Environments → New execution environment** wizard (section 3.1) | 1 minute |
| 2 Wait for the build | Administrator | Platform web UI | **Deployment progress** on the detail page reaches **Build succeeded**; six stacks CREATE_COMPLETE (section 3.2) | 12 minutes |
| 3 Authorize | Operations | Deployment machine (**write**) | `redeploy-platform.sh`: platform IAM region condition + task definition + ECS rollout (section 3.3) | 8 minutes |
| 4 Verify | Operations | Deployment machine (read-only) | The new task definition contains the new region; the truth check script is all green (section 3.4) | 1 minute |
| 5 Enable | Administrator | Platform web UI | **Check initialization** all green → **Enable** (section 3.5) | 2 minutes |
| 6 Wrap-up | Administrator | AWS console | Revoke the permissions temporarily widened for the authorization (section 3.6) | 1 minute |

Impact on data: **zero**. The whole procedure reads or writes no business data and touches no object in DynamoDB / S3 / Redshift / RDS / Cognito / KMS (section 3.3 has an item-by-item checklist). Impact on users: during the two minutes of the ECS rollout in
step 3, someone operating the web UI may see one request fail; refreshing is enough and the login session is not lost; running jobs (Glue / EMR / Redshift / Flink / DMS) and scheduled runs (MWAA Serverless) do not live in the platform container and are
unaffected.

### 1b. One-page quick reference (do it in this order; replace `<new-region>` with the actual region name, such as `ap-northeast-1`; replace `<profile>` with the name of an AWS profile with administrator permissions on the customer's deployment machine)

All commands are run on **the customer's own deployment machine**, inside the code directory `~/kingfisher/kf-prod-deploy`. The first time, finish section 2 first (install tools, clone at the tag, `npm ci`); every later region addition starts at step ①.

| # | Who | What | How to tell you can proceed to the next step |
|---|---|---|---|
| ① | Operations | `cd ~/kingfisher/kf-prod-deploy && bash ~/kingfisher/kf-add-region.sh precheck <profile> <new-region>` (the script is in Appendix A; or run the four command groups of section 3.0 by hand) | The last line prints "Pre-check passed". Do not go on if any line shows ❌; handle it as the message says |
| ② | Administrator | Platform web UI: **System → Execution Environments → New execution environment** → select `<new-region>` → step 2 components are read-only defaults → step 3 tick the disclaimer → **Start deployment** | The card for that region appears with status **Deploying** |
| ③ | Administrator | Wait. Open the region's card and watch **Deployment progress** | It shows **Build succeeded** and the six stacks below are all `CREATE_COMPLETE` (about 12 minutes). At this point there is also a yellow notice "Control plane has not enabled region …"; **this is normal**; do not press **Check initialization** |
| ④ | Operations | `bash ~/kingfisher/kf-add-region.sh release <profile> <new-region>` (or run the command of section 3.3 by hand). The script first reruns the three gates and the "six stacks are CREATE_COMPLETE" check, then requires you to **type `ap-southeast-1` to confirm** before it really runs | You see "✅ platform stack redeployment complete (IAM simulation gate all green)" and `[redeploy] IAM_GATE_VERDICT=green` (about 8 minutes). **Do not press Ctrl+C halfway** |
| ⑤ | Operations | `bash ~/kingfisher/kf-add-region.sh verify <profile> <new-region>` (or run section 3.4 by hand) | The two lines "platform service rollout complete" and "authorized-region list contains <new-region>" show ✅; the truth check script is all green apart from the known false red described in section 3.4 |
| ⑥ | Administrator | Back on the region's card, press **Refresh**, confirm the yellow "Control plane has not enabled region" notice **has disappeared**, press **Check initialization** | All probe items are green and the **Enable** button becomes clickable |
| ⑦ | Administrator | Press **Enable** | Card status **Running**, **Accepting new work** = accepting |
| ⑧ | Administrator | Revoke the permissions temporarily widened for step ④ (if a dedicated IAM user for operations was used); while at it, confirm that the cards of the home region and the existing execution regions still show **Running** | — |

If something goes wrong, see section 4; if the build in step ③ fails and the log contains the words "the default model … is a `us.` geo inference profile", first add the CodeBuild variable as described in section 5.1, then press **Recover** → **Redeploy** on the card.

---

## 2. One-time preparation (customer deployment machine)

### 2.1 Deployment machine requirements

| Item | Requirement | Self-check |
|---|---|---|
| Operating system | Linux x86_64 (Amazon Linux 2023 or Ubuntu 22.04), with access to the public internet and the AWS APIs | |
| git | ≥ 2.30 | `git --version` |
| Node.js | **20.x** (both CDK and the platform build target 20) | `node -v` |
| Docker | Available, including buildx (the platform image is a CDK Docker asset; when the code is unchanged the existing image is reused, but CDK still requires Docker to be present) | `docker version && docker buildx version` |
| AWS CLI | v2 | `aws --version` |
| python3 / jq | The IAM simulation gate of the authorization script uses python3 (standard library only; **no** pip install of boto3 is needed); wiring parsing and the OpenMetadata password check use jq / python3 | `python3 --version && jq --version` |
| Network | Able to reach the AWS APIs, GitHub, and the public CloudFront addresses of the platform and of OpenMetadata (step 3b of the authorization script checks the OpenMetadata administrator password over HTTPS) | `curl -sI https://<platform-address>/login` returns 200 |
| Disk | ≥ 10 GB free (node_modules + CDK artifacts) | |

Maven / JDK are not needed (they are only needed to build the Flink runner at the initial install; adding a region does not build it).

### 2.2 Get the code (must be a git clone; a ZIP without `.git` cannot be used)

The customer machine previously had **no** code at all. Choose one of two methods:

**Method A: clone directly from GitHub** (read access to the repository must first be granted to the customer's account; use the repository URL you were given)

```bash
mkdir -p ~/kingfisher && cd ~/kingfisher
git clone --branch release-2026-10-27 <repository-url> kf-prod-deploy
cd kf-prod-deploy
```

🔴 Do not add `--depth` (a shallow clone has no history; the third gate needs product commit `2b181dc` for the comparison and would report "unknown revision").

**Method B: we deliver a git bundle (when the customer has no GitHub access)**. On our side we run `git bundle create kingfisher-release-2026-10-13.bundle release-2026-10-13` on the deployment machine and hand the file to the customer; the customer then runs:

```bash
mkdir -p ~/kingfisher && cd ~/kingfisher
git clone kingfisher-release-2026-10-13.bundle kf-prod-deploy
cd kf-prod-deploy && git checkout -q release-2026-10-13
```

**Run the three gates immediately after getting the code** (and again before every authorization; if any gate fails, stop and do not continue):

```bash
cd ~/kingfisher/kf-prod-deploy
TAG=release-2026-10-13
PRODUCT_SHA=2b181dcefa52a9653f9d9c38d99d023e9fcc5ffa
[ "$(git describe --tags --exact-match 2>/dev/null)" = "$TAG" ] && echo "Gate 1 passed: HEAD is $TAG ($(git rev-parse --short HEAD))" || { echo "❌ Gate 1: HEAD is not $TAG"; exit 1; }
[ -z "$(git status --porcelain)" ] && echo "Gate 2 passed: working tree clean" || { echo "❌ Gate 2: working tree not clean"; exit 1; }
[ -z "$(git diff "$PRODUCT_SHA" --stat -- platform infra scripts flink-sql-runner flink-sql-runner-s3t flink-sql-runner-s3t-kafka flink-connector-modules ':!*.md')" ] \
  && echo "Gate 3 passed: product directories match the production bytes" || { echo "❌ Gate 3: product directories differ from production"; exit 1; }
```

🔴 From now on, **never** run `git pull` / `git fetch` / `git checkout <anything else>` or modify any file in this directory. Its only purpose is authorization and verification. To upgrade the version, follow the upgrade procedure instead ([deployment guide,
section 7ter "Upgrading"](deployment.md#7ter-upgrading-bringing-a-new-version-live)).

### 2.3 Install dependencies

```bash
cd ~/kingfisher/kf-prod-deploy
(cd infra && npm ci --no-audit --no-fund) && (cd platform && npm ci --no-audit --no-fund)
```

About 5 to 10 minutes. After installing, run the three gates of section 2.2 once more (`npm ci` must not change any tracked file; if gate 2 fails, something is wrong with the environment — stop).

### 2.4 AWS credentials

| Item | Requirement |
|---|---|
| profile | A dedicated one is recommended, written `<profile>` below; **every command carries `--profile` explicitly**; a missing positional argument to the scripts does not error (a default value is used silently), so always spell out both the profile and the home region |
| Permissions | The authorization step must be able to update `BgpPlatformStack` in CloudFormation, push to ECR and update ECS — in practice administrator-level permissions. **Attach them only for the duration of step 3 and revoke them in step 6**. Pre-check and verification need only read-only permissions |
| Region | The home region is fixed to `ap-southeast-1`. Do not set an `AWS_REGION` / `AWS_DEFAULT_REGION` in the local shell that conflicts with it |

Verify the identity (read-only; only check that the last digits of the account id are the customer's account):

```bash
aws --profile <profile> sts get-caller-identity --query '[Account,Arn]' --output text
```

---

## 3. Adding an execution region, each time (general steps; replace `<new-region>` in the commands with the actual region name; the text occasionally uses `ap-northeast-1` as an example, but it is not limited to that region)

### 3.0 Pre-check (operations, read-only, 2 minutes)

```bash
cd ~/kingfisher/kf-prod-deploy
# ① The three code gates (the block in section 2.2, rerun verbatim)

# ② The transition variable is still there: should print the two names EXEC_ENV_SOURCE_REF and BEDROCK_MODEL_ID; if BEDROCK_MODEL_ID is missing, have the administrator add it as described in section 5.1 first, otherwise step 2 is bound to fail
aws --profile <profile> --region ap-southeast-1 codebuild batch-get-projects --names bgp-exec-env-deploy \
  --query "projects[0].environment.environmentVariables[].name" --output text

# ③ The new region is enabled, has at least 2 availability zones, and has no execution-environment stacks of this platform yet
aws --profile <profile> account get-region-opt-status --region-name <new-region> --query RegionOptStatus --output text
aws --profile <profile> --region <new-region> ec2 describe-availability-zones --query "length(AvailabilityZones)" --output text
aws --profile <profile> --region <new-region> cloudformation list-stacks \
  --query "StackSummaries[?starts_with(StackName,'BgpExecEnv') && StackStatus!='DELETE_COMPLETE'].StackName" --output text

# ④ The deployment mode must be production (the script compares against it and refuses to run on a mismatch)
aws --profile <profile> --region ap-southeast-1 ssm get-parameter --name /bgp/deploy-mode --query Parameter.Value --output text
```

Expected: ② two names; ③ `ENABLED` or `ENABLED_BY_DEFAULT`, availability-zone count ≥ 2, empty stack list; ④ `production`.

### 3.1 Register (administrator, web UI, 1 minute)

**System → Execution Environments → New execution environment**:

1. Step 1, choose the region: select the target region (example: `ap-northeast-1`). The list comes from the account's real state; regions that already have an execution environment cannot be selected; regions blocked by an organization policy are listed but not
   selectable, with the reason stated; for regions marked **Organization policy could not be verified**, press **Refresh** to re-check once before selecting.
2. Step 2, components: **the complete set, read-only** (core / redshift / dms / flink / airflow-serverless; determined automatically by the jurisdiction, cannot be trimmed).
3. Step 3, read the disclaimer and tick it → **Start deployment** (the button is disabled until ticked).

Leave the jurisdiction tag at the default `home` (the same as for Frankfurt). Setting it to anything else installs an additional residency-api stack (7 in total) and enters the cross-jurisdiction flow (dual audit records; every user must accept the disclaimer
before their first data operation), which is a separate product line — confirm with us before doing so.

After registration the platform calls the broker automatically to trigger CodeBuild; nothing else needs to be pressed.

### 3.2 Wait for the build to succeed (administrator, web UI, about 12 minutes)

**Deployment progress** on the region's detail page goes from **Building** to **Build succeeded**, and below it the six stacks are all listed as `CREATE_COMPLETE`:
`BgpExecEnv-<slug>-base / -core / -redshift / -dms / -flink / -airflow-serverless` (the slug is generated by the platform from the region, for example ap-northeast-1 → `tgt-apne1-a`, eu-central-1 → `tgt-euc1-a`; what the web UI shows is authoritative).

At the same time the detail page shows a yellow notice "Control plane has not enabled region <new-region>: Probe will fail until it is enabled" (Probe here is the **Check initialization** action) — **this is normal**; it is exactly the reminder to do step 3.
Do not press **Check initialization** before authorizing.

Operations can also watch from the command line (read-only):

```bash
aws --profile <profile> --region <new-region> cloudformation list-stacks \
  --query "StackSummaries[?starts_with(StackName,'BgpExecEnv') && StackStatus!='DELETE_COMPLETE'].[StackName,StackStatus]" --output table
aws --profile <profile> --region ap-southeast-1 codebuild batch-get-builds \
  --ids "$(aws --profile <profile> --region ap-southeast-1 codebuild list-builds-for-project --project-name bgp-exec-env-deploy --sort-order DESCENDING --query 'ids[0]' --output text)" \
  --query "builds[0].[buildStatus,currentPhase,startTime,endTime]" --output table
```

What to do if the build fails is in section 4.

### 3.3 Authorize (operations, **write operation**, about 8 minutes)

**Read before executing: what this step changes and what it does not change**

| Changes | Does not change |
|---|---|
| `BgpPlatformStack`: the `aws:RequestedRegion` condition of each IAM managed policy of the platform TaskRole gains the new region; the ECS task definition environment variable `EXECUTION_REGIONS` gains the new region (the task definition gets a new revision); the ECS service rolls once (2 tasks, no interruption) | Any DynamoDB table, S3 bucket, Redshift, RDS, OpenSearch, Cognito user pool, KMS, Secrets; the OpenMetadata service; the three agents; the stacks of any execution region (including the new one) |
| SSM `/bgp/wiring/*` is rewritten with **the same values** (the script reads them back from the CloudFormation truth and writes them again; idempotent) | `/bgp/deploy-mode` |
| The script also runs `cdk deploy` against `BgpExecEnvDeployStack / BgpAirflowServerlessStack / BgpWafStack / BgpOmServiceStack`, but the code is the same tag as production ⇒ CDK finds "no changes" and **not a single resource is touched** (measured 2026-10-19: the timestamps of the four stacks did not change) | |

The command (run in place inside the code directory; both environment variables **must be given explicitly**; the script stops at its first step if either is missing):

```bash
cd ~/kingfisher/kf-prod-deploy
# First rerun the three gates of section 2.2, then:
BGP_DEPLOY_MODE=production \
BEDROCK_MODEL_ID=global.anthropic.claude-opus-4-5-20251101-v1:0 \
./scripts/redeploy-platform.sh <profile> ap-southeast-1
```

Script steps and expected output (they appear on screen in this order; the script prints these lines in Chinese — the quotes below are translations):

| Step | What you see on screen | Notes |
|---|---|---|
| 1 | "1) Reading the real wiring from CloudFormation (zero hard-coding)" | Read-only |
| 1b | "1b) Deriving the region list from the execution-environment registry" → `execution-regions = ap-southeast-1,eu-central-1,<new-region>` (order does not matter; every existing region is listed) | **The new region must be on this line**; if it is not, stop with Ctrl+C (no write has happened yet) and go back to the web UI to look at that environment's status |
| 2 | "2) Idempotent write of SSM /bgp/wiring/*" | Writes back the same values |
| 2b / 2c / 2d | Three `cdk deploy` runs, each printing `(no changes)` or finishing quickly | No differences under the same tag |
| 3 | "3) Deploying the platform stack (full -c wiring)", followed by a stream of CloudFormation events | Only `AWS::IAM::ManagedPolicy` / `AWS::IAM::Policy` / `AWS::ECS::TaskDefinition` / `AWS::ECS::Service` appear in the events; about 4 to 6 minutes |
| 3b | "3b) OM administrator password …" | Idempotent check, no change |
| 4 | "4) IAM simulation gate …" | Simulates the TaskRole against the platform's real call inventory |
| Closing | **"✅ platform stack redeployment complete (IAM simulation gate all green)"** + `[redeploy] IAM_GATE_VERDICT=green` | This is the sign of success |

Two closing outcomes that do not count as failure: "⚠️ the IAM simulation gate did not run (exit 2 = environment / permission reason)" or "⚠️ IAM simulation gate: no real red, but some rows could not be evaluated in this account (blocked by an organization
SCP)", both followed by "the platform stack has been deployed, the wiring has been persisted, and the authorized-region list has been written according to the registry" — authorization is complete; proceed to section 3.4 as usual. A real failure starts with a
red `ERROR:` and exits (for example "IAM simulation gate red: the TaskRole has a deny against a real platform call"); see section 4.

🔴 **Do not press Ctrl+C halfway**. Interrupting does not stop CloudFormation; it only prevents step 4 (IAM gate) and the closing checks from running. If CloudFormation rolls back by itself, the platform returns to the previous task definition and keeps serving; find the cause and rerun.

Why `BEDROCK_MODEL_ID` must be given explicitly: in the customer account, Anthropic models are unavailable at the account level; without an explicit value the script would really invoke the models to select one and fail; this value is the same as at the
initial install, only affects the platform container's default-model environment variable, and triggers no real call.

### 3.4 Verify (operations, read-only, 1 minute)

```bash
# ① The platform service has finished rolling: PRIMARY / COMPLETED / 2 / 2
aws --profile <profile> --region ap-southeast-1 ecs describe-services --cluster bgp-cluster --services bgp-platform \
  --query "services[0].deployments[].[status,rolloutState,runningCount,desiredCount]" --output table

# ② The authorized-region list of the new task definition contains the new region
aws --profile <profile> --region ap-southeast-1 ecs describe-task-definition \
  --task-definition "$(aws --profile <profile> --region ap-southeast-1 ecs describe-services --cluster bgp-cluster --services bgp-platform --query 'services[0].taskDefinition' --output text)" \
  --query "taskDefinition.containerDefinitions[0].environment[?name=='EXECUTION_REGIONS'].value" --output text

# ③ Post-deploy truth check
cd ~/kingfisher/kf-prod-deploy && ./scripts/02-postdeploy-truth.sh <profile> ap-southeast-1
```

③ has one known false red on this version: if the account contains historically deleted `Bgp*` stacks, the script reports "stacks not in COMPLETE state … DELETE_COMPLETE"; this one item can be ignored; every other item must be green.

### 3.5 Check initialization → Enable (administrator, web UI, 2 minutes)

Back on the region's detail page, press **Refresh** first and confirm that the yellow "Control plane has not enabled region" notice has disappeared (the new platform tasks now carry the new region), then:

1. **Check initialization**: probes each resource (about 17 items); once all are green, the **Enable** button becomes clickable. For red items see section 4.
2. **Enable**: the status becomes **Running (active)** and **Accepting new work** becomes **accepting**.

Enabling only means the region can accept new tasks; it **does not** automatically move any existing task there; all existing tasks remain bound to their original regions.

After enabling, check three things while you are at it (web UI, read-only): ① on the Execution Environments page, the cards of the home region and the existing execution regions still show **Running**; ② the new region can be selected in the execution-scope
switcher in the top bar; ③ in the wizards for a new sync task / batch job, the **Execution environment** drop-down shows the new region (no need to actually create one). If all three are right, you are done; if any is not, see section 4.

### 3.6 Wrap-up (administrator, 1 minute)

Revoke the administrator permissions temporarily attached to the operations credentials for step 3; if an IAM user's access key was used, rotating it at the same time is recommended.

---

## 4. Exception handling

| Symptom | Handling |
|---|---|
| The build in step 2 fails and the detail page shows a red "Manual recovery required … build=FAILED" | Press **Recover (record failure and unlock)** in the banner → confirm in the **Recover this failed deployment session?** dialog. Then look at the failure reason (CodeBuild console → project `bgp-exec-env-deploy` → most recent build → logs, or the command `aws --profile <profile> --region ap-southeast-1 logs tail /aws/codebuild/bgp-exec-env-deploy --since 1h`). After fixing the cause, press **Redeploy** on the same environment: it first runs a **dry run** (1 to 3 minutes; CodeBuild runs cdk synth + a change-set preview) and then shows the impact verdict; only after you confirm does it really deploy. **Do not** create a second environment for the same region |
| The build log contains "the default model … is a `us.` geo inference profile and cannot be called from home region ap-southeast-1" | This is the 2026-10-19 model-guard incident. It means `BEDROCK_MODEL_ID` is no longer on the CodeBuild project (usually because the version was just upgraded). Have the administrator add it as described in section 5.1, then **Recover** → **Redeploy** |
| The beginning of the build log reports "fewer than 2 usable AZs" / "endpoint service … no supported AZ found" / "fewer than 2 AZs supported by all interface endpoint services" | The region does not meet the prerequisites (availability zones, or an interface endpoint of some AWS service is not supported); choose another region or contact AWS; not a single resource was created, so press **Discard this environment** directly to free the quota |
| The region list printed by step 1b of the step-3 script does not contain the new region | The region's status in the registry is abnormal (for example deleted); go back to the web UI and look at that environment's status; do not continue |
| CloudFormation rolls back in step 3 | The platform automatically returns to the previous task definition and the service is not interrupted; look at the FAILED rows in the `BgpPlatformStack` events for the cause, fix, and rerun |
| **Check initialization** in step 5 has red items | Open the red item to see the reason. "Control plane has not enabled region" = step 3 was not completed or the page was not refreshed; "descriptor is missing resources.*" is usually a derived symptom — confirm the authorization first, then re-check; for other red items contact us |
| You want to abandon this region | No stack was created at all: **Discard this environment** on the detail page (only changes the registry and frees the quota for that region). Stacks were created: follow the decommission procedure ([deployment guide, section "8. Decommission a region"](deployment.md#7bis-retiring-an-execution-region-deleting-an-execution-environment): stop accepting work → impact preview → type the region name to confirm → approval → destroy); data buckets / table bucket / final snapshot / CMK are retained and keep billing |

---

## 5. Known boundaries (this version)

### 5.1 The 2026-10-19 incident: building an execution region from a non-US home region is blocked by the model guard (transition measure)

Scope: only environments whose home region is **not** `us-*` are affected (the guard compares the factory default `us.` prefix with the home region's prefix); environments whose home region is in the United States (for example the developers' test accounts) do
not have this problem and do not need the transition variable — which is exactly why it went undetected for so long. This customer's home region is ap-southeast-1, so it **is needed**.

Symptom: when CodeBuild loads the CDK application during `cdk bootstrap`, the top-level "default-model geography guard" compares the factory default `us.anthropic.…` with the home region `ap-southeast-1`, throws on the mismatch, and the build fails after 75
seconds without creating a single stack. The execution-environment stack group does not use a model at all; it is collateral damage.

- Transition measure (administrator, console or command): add the environment variable `BEDROCK_MODEL_ID` to the CodeBuild project `bgp-exec-env-deploy`, with the value = **the platform container's current default model id** (for this customer
  `global.moonshotai.kimi-k3` from 2026-10-29; on 10-19 it was `global.anthropic.claude-opus-4-5-20251101-v1:0`; the guard only looks at the geographic prefix, and `global.` passes).
- 🔴 Verified on 2026-10-29 on `release-2026-10-29` (2.1.2): **still required** (the `cdk bootstrap` line of the buildspec still executes the CDK application, so the fix for the original incident does not apply to it); no longer needed from the version that contains hotfix `45e322a`;
- if you do not want to copy `EXEC_ENV_SOURCE_REF` by hand, a `jq`-based command that reads the whole existing `environment` block and writes it back with `BEDROCK_MODEL_ID` appended does the same job.
- Console path: CodeBuild → Build projects → bgp-exec-env-deploy → Edit → Environment → Additional configuration → Environment variables → Add.
- From the command line, the existing `EXEC_ENV_SOURCE_REF` must be carried along unchanged (`update-project --environment` replaces the whole block):

```bash
# First read the existing environment and copy the value of EXEC_ENV_SOURCE_REF into the block below
aws --profile <profile> --region ap-southeast-1 codebuild batch-get-projects --names bgp-exec-env-deploy --query "projects[0].environment"
aws --profile <profile> --region ap-southeast-1 codebuild update-project --name bgp-exec-env-deploy --environment '{
  "type": "LINUX_CONTAINER", "image": "aws/codebuild/standard:7.0", "computeType": "BUILD_GENERAL1_SMALL",
  "privilegedMode": false, "imagePullCredentialsType": "CODEBUILD",
  "environmentVariables": [
    {"name": "EXEC_ENV_SOURCE_REF", "value": "<copy the existing value>", "type": "PLAINTEXT"},
    {"name": "BEDROCK_MODEL_ID", "value": "<the platform container's current BEDROCK_MODEL_ID>", "type": "PLAINTEXT"}
  ]}'
```

Lifecycle: an authorization within the same version does not wipe it (`BgpExecEnvDeployStack` is not updated when there is no difference); **upgrading to a new version wipes it**; the new version must already contain the root fix, and the upgrade guide states whether it is still needed.

### 5.2 Other

- Authorization can only be done from the CLI (section 0). On the product side this is registered as an improvement item (pre-authorize candidate regions at install time), shipping in a later version.
- The known false red of the truth check script (section 3.4).
- Only one execution environment is allowed per region, and components cannot be trimmed; execution regions have zero internet egress and every AWS call goes through VPC interface endpoints, so the region must have ≥ 2 availability zones supported in common by
  the endpoint services of all components (checked at the start of the build).
- The VPC address range of the new region is allocated by the platform from an internal address pool (such as `10.128.0.0/16`); it is peered only with the home-region VPC and does not interconnect with the customer's other VPCs in that region, so whether the
  address ranges of the customer's existing VPCs overlap does not affect this procedure.
- The command given in the "Control plane has not enabled region" notice in the web UI omits `BGP_DEPLOY_MODE=production`; copying it verbatim is rejected by the script; the command in section 3.3 of this manual is authoritative.

---

## 6. Record of the 2026-10-19 Frankfurt region addition (for comparison)

| Time (UTC) | Event |
|---|---|
| 08:50 | `eu-central-1` registered in the web UI; CodeBuild failed after 75 seconds (the model-guard incident) |
| 09:3x | The administrator added `BEDROCK_MODEL_ID` to CodeBuild |
| 09:41 to 09:46 | **Recover** → **Redeploy** in the web UI; dry run passed (6 stacks, 70 changes, no approval required) |
| 09:46 to 09:57 | Six stacks CREATE_COMPLETE (11.5 minutes) |
| 10:06 to 10:14 | Authorization: only IAM managed policies 10 / inline policy 1 / task definition 1 / service 1 changed; zero changes to data stacks; 0 run records changed within the window |
| 10:1x | **Check initialization** → **Enable**; Frankfurt active |

---

## 6b. Complete rehearsal record in the developers' test environment (2026-10-19, proving that the steps and criteria of this manual hold in a real environment)

Environment: a developer test account in demo mode (home region us-east-1; the code is the commit actually deployed in that environment, **not** the customer tag; therefore the authorization command used `BGP_DEPLOY_MODE=demo` and did not need
`BEDROCK_MODEL_ID`; every other step was identical to this manual, item by item). The administrator created `us-west-2` (`tgt_usw2_a`) in the web wizard; CodeBuild SUCCEEDED from 10:28 to 10:40Z; six stacks CREATE_COMPLETE; before authorization the platform's
authorized-region list contained only us-east-1.

| Manual step | Actual result |
|---|---|
| Section 3.2, verify stacks | All six stacks CREATE_COMPLETE; registry status `testing` |
| Section 3.3, authorize (11:55 to 12:0xZ) | 1b printed `execution-regions = us-east-1,us-west-2`; 2b / 2c / 2d and the other control-plane stacks all `(no changes)`; 3 platform stack updated; 4 IAM simulation gate allowed row by row (including the secretsmanager / s3tables / redshift-serverless actions for us-west-2); closing "✅ platform stack redeployment complete (IAM simulation gate all green)" + `IAM_GATE_VERDICT=green`, exit code 0 |
| Section 3.4, verify | ECS `PRIMARY COMPLETED 2 2`; new task definition `EXECUTION_REGIONS=us-east-1,us-west-2`; truth check script (16 items in that environment's version) all green |
| Section 3.5, web UI | Headless-browser login → the region's card → **Check initialization**: 17 probe items, 0 red; the "Control plane has not enabled region" notice gone → **Enable** → status `active` (completed by the in-repository script `scripts/34-add-region-headless.py --no-enable-region`, which is the automated version of the web wizard) |
| Appendix A script | On another test account in production mode: `precheck` / `verify` / `KF_DRY_RUN=1 release` passed as expected; `precheck` reported ❌ as expected when the CodeBuild variable was missing; running it in a development-trunk directory was stopped by gate 1 |

Facts added to the manual during the rehearsal: the real reason authorization must wait for the build to finish (step 2b redeploys the CodeBuild project itself); the card status lifecycle (`registered → initializing → testing → active`); cloning must not use
`--depth`; the transition variable for the model-guard incident only matters for non-US home regions.

## 6c. Complete rehearsal record of the next version's "candidate-region pre-authorization" in the test environment (2026-10-19, development branch; **the production tag does not have this feature yet**)

> Purpose: to prove that after upgrading to a version containing candidate-region pre-authorization, **operations names the candidate regions once at upgrade time, and from then on adding a region inside the candidate set is done entirely in the web UI, without
> running the authorization command of section 3.3**. Environment: the same demo test account as section 6b (home region us-east-1, with an existing us-west-2 execution region); code = the development build of that feature (commits `66cc2ce` → `bf400ea`), not
> the customer tag.

| Step | Command / web UI action | Actual result |
|---|---|---|
| Declare candidate regions at upgrade / authorization time (operations, once) | `BGP_DEPLOY_MODE=demo EXEC_REGION_CANDIDATES=us-west-1 ./scripts/redeploy-platform.sh <profile> us-east-1` | 1b printed "candidate regions = us-west-1 (written to SSM /bgp/wiring/execution-region-candidates; carried automatically on every later authorization / upgrade) · execution-regions = us-east-1,us-west-1,us-west-2"; IAM simulation gate allowed row by row for all three regions, `IAM_GATE_VERDICT=green`; new task definition `EXECUTION_REGIONS=us-east-1,us-west-1,us-west-2`. Later redeployments **no longer need to pass** `EXEC_REGION_CANDIDATES` (a second redeployment in this rehearsal verified that it is picked up from SSM automatically) |
| Section 3.1, register (administrator, web UI) | Select us-west-1 in wizard step 1 | Web UI text verbatim: "3 of them are pre-authorized by the control plane (usable right after the build); the others need ops to run the release command once after the build, then 'Probe'."; drop-down entry "us-west-1 — pre-authorized, usable right after the build"; after registration the list API returned `controlPlaneRegionEnabled=true`, and step 3 showed **no** "Control plane has not enabled region" notice |
| Section 3.2, wait for the build | Automatic | CodeBuild SUCCEEDED from 13:44 to 13:55Z; six stacks CREATE_COMPLETE; the CodeBuild project had **no** model-guard transition variable (the new version does not need it) |
| Section 3.3, authorize | **Not done** | The candidate region is already in the IAM condition; this step disappears entirely |
| Section 3.5, Check initialization → Enable (administrator, web UI) | Drawer **Check initialization** → **Enable** | **Check initialization**: 18 items, 0 red (the first item, `lake:s3tablescatalog` = the region's data lake federated catalog, opened on the spot by the probe); **on the first run, Enable was grayed out and the card stayed at Deploying** ⇒ a defect was caught (see below); after the fix was redeployed, one periodic reconciliation round (about 4 minutes) automatically advanced the status to "can be enabled"; pressing **Enable** ⇒ card **Running**, web UI message "Enabled; now accepting pushed work" |
| Section 3.4, verify | `./scripts/02-postdeploy-truth.sh <profile> us-east-1` | 16 items all green (21 Bgp* stacks COMPLETE, ECS 2/2, tgt_home active, federated catalog present) |

**Defect caught and fixed during the rehearsal (inside the development branch; it never reached the customer)**: a new probe item was not registered in the "probe item → component" contract, so the probes of the new region were all green yet the region stayed
at **Deploying**, and **regions already in use would be judged Degraded after a few cycles**. Fix = register one line + two offline ratchets (adding a probe item without registering it now fails the unit tests on the spot). What it means for the customer:
**when upgrading to a version that contains candidate-region pre-authorization, the tag must also contain this probe-contract fix** (the `CHANGELOG.md` of that tag is authoritative); this is also why every new version must first walk the whole "create in the
web UI → Enable" path in a test account.

---

## Appendix A: Operations-side automation script `kf-add-region.sh`

Save the content below as `~/kingfisher/kf-add-region.sh`. It only wraps the three operations-side tasks (pre-check / authorize / verify); the web UI steps are still performed by the administrator. **It never runs any `git fetch / pull / checkout`**, it allows
authorization only when all three gates pass, and before authorizing it requires a human to type the home region name as confirmation.

```bash
#!/usr/bin/env bash
# kf-add-region.sh — operations-side script for adding an execution region to the Kingfisher customer production environment (home region ap-southeast-1, release-2026-10-13)
#   bash kf-add-region.sh precheck <profile> <new-region>   read-only: three code gates + CodeBuild transition variable + new-region availability + deployment mode
#   bash kf-add-region.sh release  <profile> <new-region>   write:     authorize (control-plane redeployment; three gates first, then human confirmation)
#   bash kf-add-region.sh verify   <profile> <new-region>   read-only: ECS rollout complete + authorized-region list contains the new region + post-deploy truth check
set -euo pipefail

# The three values are hard-coded for the customer's production environment; override them with environment variables only when rehearsing elsewhere (for example in a developer test account)
HOME_REGION="${KF_HOME_REGION:-ap-southeast-1}"
TAG=release-2026-10-13
PRODUCT_SHA=2b181dcefa52a9653f9d9c38d99d023e9fcc5ffa
MODEL_ID="${KF_MODEL_ID:-global.anthropic.claude-opus-4-5-20251101-v1:0}"
REPO="${KF_REPO:-$HOME/kingfisher/kf-prod-deploy}"
DRY_RUN="${KF_DRY_RUN:-0}"   # release subcommand: when =1, run all the gates and print the command that would be executed, without really authorizing

die() { echo "❌ $*" >&2; exit 1; }
ok()  { echo "✅ $*"; }
CMD="${1:-}"; P="${2:-}"; NEW_REGION="${3:-}"
[ -n "$CMD" ] && [ -n "$P" ] || die "Usage: $0 precheck|release|verify <profile> <new-region>"
[[ "$NEW_REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "Invalid new-region name: $NEW_REGION (example: ap-northeast-1)"
A="aws --profile $P"

gates() {
  cd "$REPO" 2>/dev/null || die "Code directory does not exist: $REPO (clone it as described in section 2.2 of the manual)"
  [ -f scripts/redeploy-platform.sh ] || die "$REPO is not the platform code directory"
  [ "$(git describe --tags --exact-match 2>/dev/null)" = "$TAG" ] || die "Gate 1: HEAD ($(git rev-parse --short HEAD)) is not tag $TAG"
  ok "Gate 1: HEAD is $TAG ($(git rev-parse --short HEAD))"
  [ -z "$(git status --porcelain)" ] || die "Gate 2: working tree not clean: $(git status --short | head -3 | tr '\n' ' ')"
  ok "Gate 2: working tree clean"
  [ -z "$(git diff "$PRODUCT_SHA" --stat -- platform infra scripts flink-sql-runner flink-sql-runner-s3t flink-sql-runner-s3t-kafka flink-connector-modules ':!*.md')" ] \
    || die "Gate 3: product directories differ from the production release bytes"
  ok "Gate 3: product directories match the production bytes"
  [ -d infra/node_modules ] && [ -d platform/node_modules ] || die "Dependencies not installed: run npm ci as described in section 2.3 of the manual first"
  for t in aws node npx docker python3 jq; do command -v "$t" >/dev/null || die "Missing tool $t"; done
  [ -z "${AWS_REGION:-}" ] || [ "$AWS_REGION" = "$HOME_REGION" ] || die "Local AWS_REGION=$AWS_REGION differs from the home region; unset it first"
  [ -z "${AWS_DEFAULT_REGION:-}" ] || [ "$AWS_DEFAULT_REGION" = "$HOME_REGION" ] || die "Local AWS_DEFAULT_REGION differs from the home region; unset it first"
  local acct; acct=$($A sts get-caller-identity --query Account --output text) || die "Credentials unusable"
  ok "Credential account ends in …${acct: -4} ($($A sts get-caller-identity --query Arn --output text | sed 's#.*/##'))"
  [ "$($A --region "$HOME_REGION" ssm get-parameter --name /bgp/deploy-mode --query Parameter.Value --output text)" = "production" ] \
    || die "SSM /bgp/deploy-mode is not production; stopping (this is not the customer environment we know)"
  ok "Deployment mode production"
}

precheck() {
  gates
  # The pre-check evaluates all four items before summarizing, so everything is visible at once; if any item fails, exit non-zero at the end
  local fails=0 names opt azs stacks
  names=$($A --region "$HOME_REGION" codebuild batch-get-projects --names bgp-exec-env-deploy --query "projects[0].environment.environmentVariables[].name" --output text)
  if grep -q BEDROCK_MODEL_ID <<<"$names"; then ok "CodeBuild transition variable BEDROCK_MODEL_ID is present"; else echo "❌ The CodeBuild project lacks BEDROCK_MODEL_ID — have the administrator add it as described in section 5.1 of the manual first, otherwise building a region from the web UI is bound to fail (current variables: ${names:-none})"; fails=$((fails+1)); fi
  opt=$($A account get-region-opt-status --region-name "$NEW_REGION" --query RegionOptStatus --output text)
  if [[ "$opt" == ENABLED* ]]; then ok "$NEW_REGION is enabled ($opt)"; else echo "❌ $NEW_REGION is not enabled ($opt)"; fails=$((fails+1)); fi
  azs=$($A --region "$NEW_REGION" ec2 describe-availability-zones --query "length(AvailabilityZones)" --output text 2>/dev/null || echo 0)
  if [ "$azs" -ge 2 ]; then ok "$NEW_REGION has $azs availability zones"; else echo "❌ $NEW_REGION has fewer than 2 availability zones (or the region is not reachable)"; fails=$((fails+1)); fi
  stacks=$($A --region "$NEW_REGION" cloudformation list-stacks --query "StackSummaries[?starts_with(StackName,'BgpExecEnv') && StackStatus!='DELETE_COMPLETE'].StackName" --output text 2>/dev/null || echo "")
  if [ -z "$stacks" ]; then ok "$NEW_REGION has no execution-environment stacks of this platform yet"; else echo "❌ $NEW_REGION already has stacks: $stacks (only one execution environment is allowed per region; to redeploy an existing environment, use Redeploy in the web UI instead of creating a new one)"; fails=$((fails+1)); fi
  echo
  [ "$fails" -eq 0 ] || die "Pre-check: $fails item(s) failed, see the ❌ lines above; fix them and rerun precheck"
  echo "Pre-check passed. Next: the administrator selects $NEW_REGION in the web UI (Execution Environments → New execution environment); after the six stacks are CREATE_COMPLETE, run: $0 release $P $NEW_REGION"
}

release() {
  gates
  local stacks; stacks=$($A --region "$NEW_REGION" cloudformation list-stacks --query "StackSummaries[?starts_with(StackName,'BgpExecEnv') && StackStatus=='CREATE_COMPLETE'].StackName" --output text | wc -w)
  [ "$stacks" -ge 6 ] || die "Only $stacks execution-environment stack(s) of $NEW_REGION are CREATE_COMPLETE (<6) — wait for Build succeeded in the web UI before authorizing"
  ok "Execution-environment stacks of $NEW_REGION are built ($stacks CREATE_COMPLETE)"
  echo
  echo "About to authorize (control-plane redeployment): only changes the IAM region condition of BgpPlatformStack + the task definition + one ECS rollout; touches no data resources and no execution-region stacks."
  echo "Will execute: BGP_DEPLOY_MODE=production BEDROCK_MODEL_ID=$MODEL_ID ./scripts/redeploy-platform.sh $P $HOME_REGION"
  if [ "$DRY_RUN" = "1" ]; then echo "KF_DRY_RUN=1: all gates passed; authorize with the command above; not executing this time."; exit 0; fi
  echo "Type the home region name ($HOME_REGION) to confirm (must be typed by a human in an interactive terminal):"
  read -r ans; [ "$ans" = "$HOME_REGION" ] || die "Not confirmed; exiting"
  BGP_DEPLOY_MODE=production BEDROCK_MODEL_ID="$MODEL_ID" ./scripts/redeploy-platform.sh "$P" "$HOME_REGION"
  echo; echo "Authorization script finished. Next, run: $0 verify $P $NEW_REGION"
}

verify() {
  gates
  local dep td regions
  dep=$($A --region "$HOME_REGION" ecs describe-services --cluster bgp-cluster --services bgp-platform --query "services[0].deployments[].[status,rolloutState,runningCount,desiredCount]" --output text | tr '\t' ' ')
  echo "ECS deployment: $dep"
  grep -q "PRIMARY COMPLETED" <<<"$dep" && [ "$(wc -l <<<"$dep")" -eq 1 ] && ok "Platform service rollout complete" || die "Platform service is still rolling or an old deployment remains; verify again later"
  td=$($A --region "$HOME_REGION" ecs describe-services --cluster bgp-cluster --services bgp-platform --query "services[0].taskDefinition" --output text)
  regions=$($A --region "$HOME_REGION" ecs describe-task-definition --task-definition "$td" --query "taskDefinition.containerDefinitions[0].environment[?name=='EXECUTION_REGIONS'].value" --output text)
  echo "EXECUTION_REGIONS=$regions"
  grep -q "$NEW_REGION" <<<"$regions" && ok "Authorized-region list contains $NEW_REGION" || die "Authorized-region list does not contain $NEW_REGION"
  ./scripts/02-postdeploy-truth.sh "$P" "$HOME_REGION" || echo "⚠ The truth check has red items: if the only one is the DELETE_COMPLETE item, that is the known false red; every other red item must be handled"
  echo; echo "Verification complete. Administrator, back to the web UI: on the region's detail page, Refresh → Check initialization all green → Enable; then revoke the temporary permissions."
}

case "$CMD" in precheck) precheck;; release) release;; verify) verify;; *) die "Unknown subcommand $CMD";; esac
```

Order of use: `precheck` → the administrator registers in the web UI and waits for the build to succeed → `release` → `verify` → the administrator presses **Check initialization** → **Enable** in the web UI → revoke permissions.

A few facts about this script (whoever takes over must know them):

- It only chains the manual commands of sections 3.0 / 3.3 / 3.4 together and adds gates; **it does nothing the manual commands cannot do**; when a gate stops it, the manual commands would fail at the same place.
- The three gates and "the deployment mode must be production" **cannot be bypassed with environment variables**; this is deliberate: in an environment that is not the customer's production tag or not production mode (for example a developer's demo test
  account), it is stopped at the gates — that is the expected behavior, not a broken script; to rehearse in such an environment, use the manual commands of section 3 directly and replace `BGP_DEPLOY_MODE` with that environment's real mode.
- The human confirmation in `release` uses `read` from the terminal and **must be typed by a human in an interactive terminal**; an AI or an automation running in a non-interactive environment reaches this step and exits straight away with "Not confirmed; exiting", which is also deliberate.
- Verification already done (2026-10-19): syntax with `bash -n`;
  - in a developer test account in production mode (home region us-east-1, overridden with `KF_HOME_REGION=us-east-1`, code directory = a clone of the production tag), real runs of `precheck` (three gates and deployment mode passed; with the CodeBuild variable
    missing it reported ❌ and exited non-zero as expected), `verify` (ECS rollout complete / authorized-region list contains the region / truth check script) and `KF_DRY_RUN=1 release` (all gates passed, printed the command that would be executed, did not
    execute);
  - negative case: running it in a development-trunk directory was stopped by gate 1.
  - It has **not** been run as such in the customer's production environment — the authorization done there (Frankfurt) ran `redeploy-platform.sh` directly, which is the same command that the script's `release` executes.
