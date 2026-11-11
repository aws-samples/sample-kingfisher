# Deployment

| Item | Content |
|---|---|
| Audience | Operators who perform the installation; platform admins waiting for the login URL |
| Estimated time | 15 minutes of reading; a production installation takes about 60–90 minutes, an evaluation environment about 3.5 hours with one command |
| Prerequisites | The checklist in [Plan the deployment](05-plan-deployment.md) is complete; the deployment machine is ready; an AWS profile is available |
| What you get | You know the installation steps, which manual section covers each step, what you have after installing, how to verify the version, and how to add regions later |

This chapter is only a roadmap. The **single authoritative source** for a production installation is [`../deployment.md`](../deployment.md) (the customer production deployment manual); its commands and criteria are authoritative, and this chapter does not repeat its details.

## 1. Who does it and how long it takes

| Role | What to do | Time |
|---|---|---|
| Operator (with a deployment identity) | Pre-flight check → one-command deployment → post-deploy truth check → hand the login URL and the password file to the admin | 60–90 minutes + verification |
| Platform admin | First login and password change → create accounts → create workspaces and add members → configure the AI model | 30 minutes |
| Adding execution regions later | The admin works through the page wizard; regions that were not pre-authorized are released once by the operator | about 40 minutes of build per region |

## 2. Production installation in four steps

| Step | What to do | Manual section |
|---|---|---|
| ① Pre-flight check | `./scripts/01-preflight-account.sh <profile> <home-region> <execution-region>`; ❌ do not start until every failure is fixed | §1 |
| ② Deploy | `BGP_DEPLOY_MODE=production ./scripts/deploy-all.sh <profile> <home-region>`; both positional parameters are required; to pre-authorize candidate regions, prefix the command with `EXEC_REGION_CANDIDATES=<region1,region2,…>` | §2 |
| ③ Post-deploy truth check | `./scripts/02-postdeploy-truth.sh <profile> <home-region>`; exit code 0 does not mean the platform is in place — go through every item and accept only when all of them are ✅; **run it before you change the admin password** | §3 |
| ④ First login | Sign in with the initial password from the password file → avatar menu "Change password" → "Users" to create accounts → "Workspace" to add members | §4 |

- Getting the code: `git clone --branch <release-tag> …`, then `npm ci` in both `infra/` and `platform/`; or use the delivered product package `kingfisher-<tag>.tar.gz` (run `sha256sum -c` before unpacking).
- Do not run `cdk deploy` by hand: the deployment scripts take care of the wiring, the deploy mode, the IAM simulation gate and the agent images; a bare run wipes the wiring.
- The deploy mode must be given explicitly; once `production` has been written to SSM it cannot be changed.
- A failed step does not mean starting over: the infrastructure is usually already in place; rerun only the steps from the checklist as described in [`../operations.md`](../operations.md) §4.

## 3. Evaluation / demo environment: one command

For developer or evaluation accounts only; **not a production step**. Details are in [`../development.md`](../development.md).

```bash
./scripts/35-rebuild-account.sh <profile> <home-region> <second-region>
```

- Eight phases run in order and stop at the first failure: pre-flight check → deployment (demo mode) → post-deploy truth check → seed the game user-acquisition dataset in the home region → bring up an execution environment in the second region through the page wizard → seed an isomorphic dataset in that region → run the nine capability classes in every region and leave `Showcase-*` sample objects behind → headless-browser acceptance region by region.
- The whole run takes about 3.5 hours; if the environment already exists and you only want to re-verify, add `--only headless`.
- The sample objects left after installation (the `GameData-MySQL` data source, the `GameSync-7tables` sync task, the `ETL-*` jobs, the `Flow-ROI-Daily` workflow, the `RT-*` streaming jobs, the `Ask-*` GenBI examples, the `dim_*` models) are the running examples used by the scenarios in this guide.

## 4. What you have after installing

| Item | Where to find it |
|---|---|
| Platform login URL | The `PlatformUrl` output of the `BgpPlatformStack` CloudFormation stack in the home region (a CloudFront domain name); the deployment script also prints it at the end |
| Governance Center (OpenMetadata) URL | Open it from the platform page "Data Governance → Governance Center"; it has its own CloudFront distribution |
| Admin account | `admin`; the initial password is in the password file on the deployment machine (the path is named after the profile and can be set with `BGP_PW_FILE`), and the deployment output prints it once |
| Role groups | bgp-admin / bgp-manager / bgp-developer / bgp-analyst already exist in the Cognito user pool |
| Default workspace | "Default Workspace" exists but **has no members**; non-admins must be added to it first |
| Home-region execution environment | `tgt_home` is already running under "System → Execution Environments"; no other regions exist at this point |
| Demo content (demo mode only) | Four role test accounts (already members of the Default Workspace: `pm-tester` owner, `rbac-tester` editor, `ops-analyst` / `biz-tester` viewer), a demo MySQL source database, sample datasets; what the install script seeds at the end is the e-commerce sample dataset; the game user-acquisition database `gamedata` and the `Showcase-*` sample objects used by the scenarios exist only if you ran the evaluation-environment orchestration script |
| AI model | The first usable model the deployment script picked from the candidate chain by really invoking it; after go-live you can change it under "Settings → AI model" |

- Verification points for production mode: there is no demo source-database stack in the account; the Cognito user pool contains only `admin`; unauthenticated calls to the API return 401; the platform does not serve requests when authentication is not configured (returns 503).
- Destroy the password file and the deployment log after the first login and password change.

## 5. Adding an execution region later

1. Under "System → Execution Environments" the admin clicks "New execution environment", selects the region, fills in "Jurisdiction tag (jurisdiction)", the component set is the complete one (read-only), ticks "I have read and agree" when crossing jurisdictions, and clicks "Start deployment" in the last step.
2. Wait until the page reports a successful build (about 12–40 minutes). When you select the region, the wizard states "N of them are pre-authorized by the control plane (usable right after the build)"; those regions go straight to the next step. For regions marked "ops must release it once after the build", the operator runs `BGP_DEPLOY_MODE=production ./scripts/redeploy-platform.sh <profile> <home-region>` once (the details page shows "Control plane has not enabled region …").
3. Back on that execution environment's details page, click "Check initialization"; once every probe is green click "Enable"; then choose all projects or an allow-list in the "Authorized projects" card.

The full page steps and screenshots are in the scenario [Data stays in its region](22-scenario-multi-region-residency.md); the operator-side verification commands and exception handling are in [`../adding-a-region.md`](../adding-a-region.md); the manual's authoritative section is §7.

## 6. Verifying the version

| Where to look | What you see |
|---|---|
| Login page footer | The current release tag (such as `v2.2.0`); test environments deployed from a branch show the short product commit hash + "unreleased" |
| The "Platform version" card under "System → Settings" | Fields such as "Release tag" and "Product commit", the same facts as the footer |
| The `GET /api/public/version` endpoint | The same facts in machine-readable form; no login required |

- If the footer shows "Build info unavailable (the image was not built from a git clone)", the deployment machine did not get the code with `git clone` or from the product package as described in §2.
- Verify in the same place after an upgrade or rollback; see [Upgrade and decommissioning](41-upgrade-and-uninstall.md).

## 7. Common problems

| Symptom | Cause | Next step |
|---|---|---|
| The deployment script exits 0, but the page does not open or errors appear after login | Exit 0 does not mean the platform is in place; the wiring or account-creation steps may have failed to record their results | Run the post-deploy truth script and rerun the failed steps from its checklist (manual §3, runbook §4) |
| "Stream Compute" jobs fail as soon as they start | Maven + JDK 17 are not installed on the deployment machine, so the Flink runner JAR was never built | Install them and rerun the upgrade script; it uploads the JAR to the scripts bucket |
| A new execution environment build fails right at the start and the log says there are not enough Availability Zones or an endpoint service is unsupported | The region does not meet the prerequisites (fewer than 2 Availability Zones, or one interface endpoint service is not supported) | Click "Discard" on the page to free the slot; choose another region or contact AWS |
| The footer shows "Build info unavailable" | The code is neither a git clone nor the product package | Get the code again from the tag and redeploy |
| A non-admin gets 403 "No access to this workspace" when asking a question after login | The default project has no members initially | The admin adds the person under "Workspace" |

## 8. Further reading

- Customer production deployment manual: [`../deployment.md`](../deployment.md)
- Evaluation environment orchestration: [`../development.md`](../development.md)
- What the admin does after go-live: [Platform admin guide](10-guide-admin.md)
- First use: [Quick start](01-quick-start.md)
