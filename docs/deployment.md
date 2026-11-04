# Deployment Guide

This guide describes how to install, verify, extend, upgrade, roll back and decommission a Kingfisher production deployment in your own AWS account.
It is the operator-facing path; day-two operations are in [operations.md](operations.md) and the cost picture is in [cost-model.md](cost-model.md).
Versions of runtimes, engines and tools are listed once in [supported-versions.md](supported-versions.md) and are not repeated here.

All commands use `<profile>` for the AWS CLI profile and `<home-region>` for the home region.
Replace both before running anything; the deployment scripts fall back to silent defaults when a positional argument is missing (see section 10).

## 1. Overview and prerequisites

### 1.1 Deployment topology

Kingfisher is deployed as **one AWS account, many regions**.

- The **home region** hosts the control plane: the web application, metadata tables, OpenMetadata and the three AI agents.
- Each **execution region** hosts a complete data plane: Redshift Serverless, an S3 Tables data lake, Glue, EMR Serverless, MWAA Serverless scheduling, DMS and Managed Flink.
- Data stays in the region where it is processed; the control plane only stores metadata and run records.
- A region can hold at most one execution environment, and its component set is fixed (no trimmed variants).
- The only public entry points are two CloudFront distributions (platform and OpenMetadata), both behind WAF. The origin load balancers accept traffic only from the CloudFront prefix list.

The home region is chosen once, at install time, and cannot be changed afterwards.

### 1.2 Account requirements

| Requirement | Detail |
|---|---|
| Deployment identity | Can create IAM roles, VPCs, Cognito user pools, CloudFront distributions and WAF web ACLs |
| `us-east-1` reachable | CloudFront WAF rules live in `us-east-1`; organisation policies must not block it |
| Home region services | Bedrock (at least one candidate model), Redshift Serverless, S3 Tables, AgentCore, MWAA Serverless |
| Execution region services | Redshift Serverless, S3 Tables, Managed Flink, DMS, MWAA Serverless |
| VPC quota | Headroom for one new VPC per region; the platform always creates its own VPC |
| Model access | Enable at least one model of the candidate chain in Bedrock for the home region |

Do not plan a multi-region production install around an imported VPC.
In import mode the home VPC does not get the cross-region DynamoDB interface endpoint, and the execution-environment deployer refuses every non-home region.

Model access notes:

- The candidate chain is defined in `platform/ai-model.json` (`candidateModelIds`). The installer calls each candidate for real and keeps the first one that answers.
- A Bedrock reply containing "not available for this account" means the model is not enabled at account level. Ask your AWS account team; it is not a region or permission problem.
- The first invocation of a model may require the `aws-marketplace:Subscribe` permission.
- After installation the default model can be changed at any time in **System settings → AI model**.

### 1.3 Deployment machine

| Tool | Why it is needed |
|---|---|
| `git` | The agent images are tagged with the git short hash; a ZIP export without `.git` fails at step 4 |
| Docker with buildx | Platform image and three ARM64 agent images are built locally |
| Node.js and npm | CDK and the platform build |
| AWS CLI | Every call uses `--profile <profile>` |
| `python3`, `zip`, `curl` | Used by the deployment and verification scripts |
| Maven and a JDK | Flink SQL runner JARs are built on the fly; without Maven the install still exits 0 but real-time compute is unusable |

Exact versions: see [supported-versions.md](supported-versions.md).

### 1.4 Get the code

Always clone the repository and check out a release tag.

```bash
git clone --branch <release-tag> <repository-url> kingfisher
cd kingfisher
(cd infra && npm ci)
(cd platform && npm ci)
```

Release tags are named `v<version>`; older tags named `release-<date>` remain checkable. The login page footer and `GET /api/public/version` recognise both forms.
A fresh clone has no `node_modules`; skipping `npm ci` makes CDK synthesis fail immediately.

## 2. Pre-flight checks

Run the account check before the first install and again whenever you switch accounts.
Permissions differ between accounts, and the checks surface in thirty seconds what the installer would otherwise hit forty minutes in.

```bash
./scripts/01-preflight-account.sh <profile> <home-region> <first-execution-region>
```

Pass all three arguments. The third one defaults to `us-west-2`; if an organisation policy blocks that region the check reports a hard failure that has nothing to do with your plan.

What the script checks:

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

Behaviour and side effects:

- Hard failures make the script exit non-zero. Fix them before installing.
- All write probes are reversible: a role, a user pool and S3 buckets are created and deleted immediately.
  The S3 probe uses three buckets: home region, execution region and a comparison region (`KF_T3_REGION`, default `eu-west-1`).
  A denial in the comparison region is only a soft warning.
- Account ids are printed with the last four digits only.
- Listing a Bedrock model as active is not proof that it can be invoked; only the real call counts.

## 3. Install the control plane

### 3.1 The command

```bash
BGP_DEPLOY_MODE=production ./scripts/deploy-all.sh <profile> <home-region>
```

To pre-authorise the regions in which you expect to create execution environments later, add `EXEC_REGION_CANDIDATES`:

```bash
EXEC_REGION_CANDIDATES="eu-central-1,ap-northeast-1" \
BGP_DEPLOY_MODE=production ./scripts/deploy-all.sh <profile> <home-region>
```

Pre-authorised regions can be added entirely from the web UI (section 5). Regions that were not pre-authorised need one control-plane redeploy after their build.

### 3.2 Options

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

Rules for `EXEC_REGION_CANDIDATES`:

- Region names must be full names of regions that are enabled in the account. The wildcard `*` is rejected.
- `all-enabled` resolves to every region currently enabled in the account and stores the resolved list.
- The list is persisted in SSM `/bgp/wiring/execution-region-candidates` and applied again by every later `redeploy-platform.sh` run.
- `none` revokes the candidate list at the next redeploy.
- Pre-authorised regions allow the platform role to call that region's data-plane APIs before an execution environment exists there. Name regions deliberately rather than opening everything.

### 3.3 What the installer does

The script is idempotent where it matters and runs these phases in order:

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

Additional actions performed during the install:

- The OpenMetadata factory administrator password is replaced by a random secret stored in Secrets Manager under `bgp/om/admin-password`.
  The script verifies that the new password logs in and the factory password no longer does; otherwise the install fails.
- Wiring facts (OpenMetadata URL, agent runtime ARNs and memory ids) are written to SSM under `/bgp/wiring/*`. Later deployments read them back, so a bare redeploy cannot silently clear them.
- The default model is selected by real invocation of the candidate chain unless `BEDROCK_MODEL_ID` is given.
  When a model is pinned explicitly, validate it yourself first with `aws bedrock-runtime converse`.
- When the home region is not `us-east-1`, the installer prints an old warning that only `us-east-1` is tested. Ignore it; other home regions are rehearsed.

### 3.4 What gets created

Control-plane stacks (all named `Bgp*Stack`):

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

Each execution region later receives its own stack group `BgpExecEnv-<slug>-*` (section 5).

### 3.5 Duration and failures

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

## 4. Post-deploy verification

### 4.1 Truth check

Exit code 0 from the installer is not proof that the platform is usable.
Run the truth check **before** you change the `admin` password;
check 5 logs in with the initial password from the password file.

```bash
./scripts/02-postdeploy-truth.sh <profile> <home-region>
```

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

Two manual checks complete the picture:

- When the home region is not `us-east-1`, confirm that `BgpWafStack` in `us-east-1` is complete; the script only inspects the home region.
- Confirm the Flink runtime JARs: `s3://bgp-glue-scripts-<account-id>/flink/` must hold three runner JARs and a `modules/` prefix. If they are missing, the deployment machine had no Maven.

### 4.2 Production-specific checks

| Check | Expected |
|---|---|
| OpenMetadata factory password rejected | `POST /api/v1/users/login` with the factory password returns 401; the secret password returns 200 |
| No demonstration content | No `BgpRdsStack`; the Cognito user pool contains only `admin` |
| Authentication configured | The platform redirects to the login page; an unconfigured Cognito results in 503, never open access |

The OpenMetadata login body is `{"email":"admin@open-metadata.org","password":"<base64-encoded password>"}`; OpenMetadata expects the password base64-encoded.

### 4.3 Version check

The running version is visible in three places, all fed by build-time git facts baked into the image:

- The login page footer.
- **System settings → Platform version**.
- `GET /api/public/version`, which returns `releaseTag`, `productCommit`, `productCommitAt`, `version` and `known`.

```bash
curl -s https://<platform-host>/api/public/version
```

`releaseTag` must equal the tag you checked out. A build from a branch shows the product commit hash and `unreleased`.
A build that was not made from a git clone reports that build information is unavailable; that indicates the code was not obtained as described in section 1.4.

### 4.4 First login and password handling

1. The initial `admin` password is generated during the user-creation step and written to a password file on the deployment machine.
   The path is `BGP_PW_FILE` if set, otherwise `/tmp/bgp-cognito-pw-<profile>.json` (mode 600, JSON key `admin`).
   The same password is printed once to the installer's standard output. Treat the log like the password and destroy both after the password has been changed.
2. For production, set `BGP_PW_FILE` to a controlled location before installing, and delete the file after the first login.
3. Log in as `admin` and change the password immediately: avatar menu → **Change password**. Passwords need at least 12 characters including upper case, lower case, digits and symbols.
4. Create users and assign roles in **System management → User management**.
   Administrators reset forgotten passwords there with **Reset password**;
   the audit log records who reset whom, never the password.
5. Add users to a project in **Project space**. The default project starts with no members, so a non-administrator receives 403 in natural-language query until added (`viewer` reads and asks questions, `editor` develops).

If the only administrator forgets the password, the account owner resets it with Cognito. This is a write to your account and is deliberately not performed by the platform:

```bash
P=<profile>; R=<home-region>
POOL=$(aws --profile $P --region $R cloudformation describe-stacks --stack-name BgpAuthStack \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
aws --profile $P --region $R cognito-idp admin-set-user-password --user-pool-id "$POOL" \
  --username admin --password '<new password>' --permanent
```

Then log in and change the password once more from the UI.

### 4.5 Operating agreements worth stating before go-live

- Sync tasks require an explicit write mode (append, overwrite or merge).
  Overwriting a table that the platform did not create needs per-table confirmation in the wizard;
  unconfirmed runs fail without touching a row.
- Real-time (DMS) tasks leave existing target tables untouched by default (`DO_NOTHING`).
- Deleting a data source removes only platform-created security groups (`bgp-ds-*`); security groups you supplied are never deleted.
- Home-region data lake, script and DAG buckets, the table bucket, the Athena workgroup and the Redshift namespace are retained when stacks are deleted.
- Users with the `editor` role on a project can write to the warehouse through ETL jobs. Keep `editor` for trusted users.

## 5. Add an execution region

An execution region is created only through the web UI. The flow has five stages: register → build → authorise → detect → enable.

### 5.1 Register and build

1. Open **System management → Execution environments** and choose **New execution environment**.
2. Select the region. The list is read live from the account, and each entry carries a status:
   - Regions that already host an environment are not selectable.
   - Regions blocked by organisation policy are listed but disabled, with the blocked action named.
   - Regions marked "could not verify organisation policy" stay selectable; press **Refresh** to re-check.
   - Each region is labelled "pre-authorized, usable right after the build" or "ops must release it once after the build".
3. Set the jurisdiction label. The default `home` means the same jurisdiction as the home region.
   A different value (for example `eu-sim`) adds a residency API stack, a disclaimer that must be accepted before deployment, dual audit records and local-only SQL history.
4. Step 2 lists the component set. It is complete and read-only; the set depends only on the jurisdiction.
5. Step 3 is **Start deployment**. The button stays disabled until the disclaimer is ticked.

Behind the button the platform calls the broker Lambda, which starts the CodeBuild project `bgp-exec-env-deploy`. The build bootstraps the target region and deploys the stack group:

| Stack | Purpose |
|---|---|
| `BgpExecEnv-<slug>-base` | Regional VPC with no internet egress, interface endpoints, customer-managed key |
| `BgpExecEnv-<slug>-core` | Regional execution roles, data lake bucket, scripts bucket, table bucket, Athena workgroup |
| `BgpExecEnv-<slug>-redshift` | Redshift Serverless namespace and workgroup |
| `BgpExecEnv-<slug>-dms` / `-flink` | Real-time integration and stream compute |
| `BgpExecEnv-<slug>-airflow-serverless` | Regional MWAA Serverless scheduling |
| `BgpExecEnv-<slug>-residency-api` | Only for non-`home` jurisdictions |

Wait for the build to succeed; the detail page shows the status and the CodeBuild project shows `SUCCEEDED`.

### 5.2 Authorise the region

The platform task role and other IAM policies carry an `aws:RequestedRegion` condition that is baked in at synthesis time.
The control plane therefore has to include the new region before it can probe it.

- If the region was pre-authorised (`EXEC_REGION_CANDIDATES` at install or upgrade time), skip this stage.
  The wizard shows "pre-authorized" and the detail page shows no yellow "control plane has not enabled this region" notice.
- Otherwise, after the build succeeds, redeploy the control plane once:

```bash
BGP_DEPLOY_MODE=production ./scripts/redeploy-platform.sh <profile> <home-region>
```

The script derives the allow-list from the registry (home region, every non-deleted execution environment, plus the candidate list) and rolls the ECS service once.
To avoid this stage for future regions, run the same command with `EXEC_REGION_CANDIDATES=<region1,region2,...>`.

`BGP_DEPLOY_MODE=production` is mandatory on this command. If your account cannot use the default model, pass `BEDROCK_MODEL_ID` with the same id used at install time.

### 5.3 Detect and enable

1. Back on the environment's detail page, press **Check initialization**.
   The platform probes every resource (buckets, roles, workgroup, endpoints, scheduler, no-egress network) and opens the regional S3 Tables federated catalog idempotently. Every row must be green.
2. Press **Enable**. The status becomes `active` and the region starts accepting bindings, schedules and runs.

If a probe row is red with an access-denied message, the control plane has not yet authorised the region (section 5.2).

### 5.4 Rules

- Never create execution regions with `cdk deploy BgpExecEnv-*`, by writing to the registry table, or by calling the registration API directly. The wizard is the only supported path.
- One execution environment per region; components cannot be removed.
- Jurisdiction labels are set by the administrator, are not derived from the region and cannot be changed after registration.

## 6. Upgrade

Read the upgrade notes for the target version in `CHANGELOG.md` first. Then:

### 6.1 Fetch the new tag

```bash
git fetch --tags && git checkout <new-tag>
(cd infra && npm ci)
(cd platform && npm ci)
```

If `git fetch` refuses to update a tag that moved, use `git fetch --tags --force`.

### 6.2 Upgrade the control plane

```bash
BGP_DEPLOY_MODE=production ./scripts/redeploy-platform.sh <profile> <home-region>
```

Add `EXEC_REGION_CANDIDATES=...` to extend or keep the pre-authorised regions. The mode must match SSM `/bgp/deploy-mode`; a mismatch is rejected.

What the script does, in order:

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

Impact during the upgrade:

- The platform ECS service rolls with minimum healthy percent 100, so pages stay available.
- If the new version changes the OpenMetadata database engine or instance class, the database stack step performs an in-place upgrade.
  OpenMetadata loses its database connection for a short window (about two minutes in rehearsals); other platform pages are unaffected.
  Run such upgrades in a quiet period and do not interrupt the script during that step.

### 6.3 Refresh the agents

`redeploy-platform.sh` does not rebuild the agent images or deploy the agent stacks. Check whether the new version changed them:

```bash
./scripts/redeploy-agents.sh <profile> <home-region> --check
```

The check is read-only. It prints the image tag each runtime currently uses, the local `HEAD` short hash and whether agent-related sources differ between the two. If a refresh is needed:

```bash
./scripts/redeploy-agents.sh <profile> <home-region>
```

This recompiles the shared core, builds and pushes the three ARM64 images (tag = git short hash), deploys the three agent stacks one by one and reads the runtime image tags back.
Runtime ARNs and memory ids do not change, so the platform wiring is untouched.

Sessions already in progress may finish on the old container; new sessions use the new image.
Both scripts take positional arguments and refuse a leading `--flag` as the first argument.

### 6.4 Redeploy each execution region

Open each execution environment's detail page and press **Redeploy**.

1. A **preview** build lists the stacks that would change and whether the baseline has drifted. Nothing is modified.
2. Approve the plan. A deployment build applies it.
3. Press **Check initialization** after the build succeeds.

Resources that the new version adds to execution regions (roles, buckets, endpoints) only appear through this step.
A preview that says the source has drifted and needs administrator approval is the normal case after an upgrade.

### 6.5 Verify

```bash
./scripts/02-postdeploy-truth.sh <profile> <home-region>
curl -s https://<platform-host>/api/public/version
```

`releaseTag` must equal the new tag. Then run a short smoke test from the UI: data sources list, sync task list, data lake query.

## 7. Rollback

Rollback means deploying the previous release's templates with that release's own scripts.

### 7.1 Control plane

```bash
git fetch --tags && git checkout <previous-tag>
(cd infra && npm ci)
(cd platform && npm ci)
BGP_DEPLOY_MODE=production ./scripts/redeploy-platform.sh <profile> <home-region>
```

- The script reads the wiring back from the live account, so nothing has to be remembered. Images are rebuilt from the old source and reused when the content is identical.
- If agent-related sources differ between the two tags, also run `./scripts/redeploy-agents.sh <profile> <home-region>` on the old checkout.
- If `BEDROCK_MODEL_ID` was pinned at upgrade time, pin the same id at rollback time.

### 7.2 Execution regions

Execution-region stacks are deployed from the source package that the control-plane deployment uploaded.
After the control plane is rolled back, **Redeploy** on an environment's detail page uses the old code.

Only do this when the newer version had changed the execution-region stacks; otherwise leave the regions alone.
A wider IAM policy left behind by a newer version is harmless.

### 7.3 Constraints

- The WAF and OpenMetadata service stacks are deployed with `--exclusively`.
  Without it CDK would also redeploy the OpenMetadata database stack, and a relational database engine cannot be downgraded.
  Every current release tag's script carries the flag; older tags may not.
- The database engine stays at the upgraded version after a code rollback.
  To return to the earlier engine, restore a new instance from the pre-upgrade snapshot and repoint the OpenMetadata service manually; this is outside the scripts.
- DynamoDB tables added by the newer version remain (retain policy). Fields written by newer code are ignored by older code.
- Scheduler artefacts and Glue scripts are generated when a workflow is published or a sync task is saved.
  Anything republished or saved on the new version must be published or saved again after rollback to regenerate it with the old code.
- OpenMetadata content, Cognito users and business data are not affected by a rollback.

### 7.4 After rollback

Run the truth check and a UI smoke test exactly as in section 6.5.

## 8. Decommission a region

The detail page offers one of two paths depending on the environment's history.

### 8.1 Never successfully deployed

Press **Discard**. The environment shows as deleted and the region becomes available for a new registration.

### 8.2 Deployed at least once

1. **Stop accepting work (drain)** with a reason. The region immediately rejects new bindings, schedules and runs; in-flight work finishes; nothing is destroyed.
2. **Request deletion**. The impact preview must show zero bound resources, zero enabled schedules and zero running runs. If any source cannot be read, the preview says so and the request is refused.
3. Enter the reason, type the region name to confirm, and let a platform administrator approve.
4. The platform destroys managed services first, then the component stacks, then the `core` and `base` stacks.
   If destruction stalls, **Retry destruction** reuses the same plan and the same final snapshot name.
5. Redeploy the control plane once to revoke the region from the allow-list:

```bash
BGP_DEPLOY_MODE=production ./scripts/redeploy-platform.sh <profile> <home-region>
```

### 8.3 What is retained

Data-bearing resources are never deleted by the platform and continue to bill until you remove them deliberately:

- Data lake bucket, scripts bucket and S3 Tables table bucket of the region.
- Redshift Serverless namespace and workgroup, plus the final snapshot.
- The regional customer-managed key and its alias.
- The MWAA Serverless DAG bucket.
- For non-`home` jurisdictions: the regional audit tables and result bucket.

Read-only commands to list residues are in [operations.md](operations.md).

### 8.4 Interaction with project deletion

- Deleting a project is refused while it still owns resources; the response lists them by type.
- Per-region database credentials managed by the platform are revoked by a background job. An in-flight revocation blocks execution-environment deletion until it finishes.
- A project's warehouse schema (`proj_*`) is not dropped automatically.

## 9. Configuration reference

### 9.1 Platform container environment

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
| `PER_PROJECT_CRED` | Per-project warehouse identity | Context `per-project-cred`, default `off` |
| `BGP_DATAPLANE_JOBS_PAUSED` | Emergency stop for data-plane job pumps | Context `dataplane-jobs-paused`, default `0` |
| `BGP_DATAPLANE_AUTO_SUPPLY` | Auto-provision credentials on binding | Context `dataplane-auto-supply`, default `off` |
| `BGP_DATAPLANE_CREDS` | Data-plane credential mode | Context `dataplane-creds`, default `taskrole` |
| `LONG_OPS_SYNC_WAIT_MS` | In-process wait before a long operation returns 202 | Context `long-ops-sync-wait-ms`, default `45000` |
| `ATHENA_WORKGROUP` | Home Athena workgroup | Platform stack resource |
| `ATHENA_OUTPUT_LOCATION` | Athena result location | Platform stack resource |
| `S3TABLES_BUCKET` | Home table bucket name | CDK constant |
| `S3TABLES_CATALOG` | Federated catalog name `s3tablescatalog` | CDK constant |
| `S3TABLES_NAMESPACE` | Default lake namespace | CDK constant |
| `GENBI_BACKEND` | `agentcore` or `inprocess` | Wiring context from SSM |
| `GENBI_RUNTIME_ARN` | Query agent runtime | Wiring context from SSM |
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

### 9.2 SSM parameters

| Parameter | Content | Written by |
|---|---|---|
| `/bgp/deploy-mode` | `production` or `demo`; immutable | `deploy-all.sh` |
| `/bgp/wiring/*` | OpenMetadata URL, agent runtime ARNs and memory ids | `deploy-all.sh`, `redeploy-platform.sh` |
| `/bgp/wiring/execution-region-candidates` | Pre-authorised execution regions | `EXEC_REGION_CANDIDATES` |

### 9.3 Secrets

| Secret | Content |
|---|---|
| `bgp/om/admin-password` | OpenMetadata administrator password, replaces the factory default |
| `bgp/dms/redshift-target` | Warehouse target credentials used by DMS |

## 10. Deployment modes and red lines

### 10.1 Modes

| Aspect | `production` | `demo` |
|---|---|---|
| Seed data | none | demonstration dataset |
| Demonstration source database | not deployed | `BgpRdsStack` deployed |
| Initial Cognito users | `admin` only | `admin` plus test accounts |
| Stored in | SSM `/bgp/deploy-mode` | SSM `/bgp/deploy-mode` |

The mode is written once. `redeploy-platform.sh` and `10-bootstrap-cognito.sh` compare their mode with SSM and refuse a mismatch. There is no supported path from one mode to the other.

### 10.2 Red lines

- Always pass `--profile <profile>` explicitly to the AWS CLI, and both positional arguments to every script. Missing arguments do not error; they fall back to `temp-account` and `us-east-1`.
- Never run a bare `cdk deploy`. Use `deploy-all.sh`, `redeploy-platform.sh` and `redeploy-agents.sh`.
  They carry the wiring context, the mode, the region allow-list, the agent image tags and the IAM gate.
  A bare deploy of the platform stack silently clears the AI wiring; a bare deploy of an agent stack deletes its runtime.
- Do not pass `-c dataplane-creds=...` in production. It is an acceptance switch, is not persisted in SSM, and the next redeploy silently returns to `taskrole`.
- Do not pass `-c long-ops-sync-wait-ms=...` in production. It forces every long operation onto the asynchronous path for acceptance testing.
- Do not import an existing VPC for a multi-region production install.
- Do not create execution regions outside the UI wizard, and do not trim their components.
- Do not run the deployment scripts with `AWS_REGION` pointing elsewhere.
  The scripts align `AWS_REGION`, `AWS_DEFAULT_REGION` and `CDK_DEFAULT_REGION` to the home region and refuse to synthesise when the target differs.
- Protect the password file and the installer log until the initial password has been changed; then delete both.

## Appendix A. Demo and acceptance mode

Demo mode exists for developer and demonstration accounts only. It is not a production path.

- Install with `BGP_DEPLOY_MODE=demo ./scripts/deploy-all.sh <profile> <home-region>`. The installer adds a demonstration MySQL source database, a seeded dataset and test user accounts.
- A single-region demo in an account with no VPC quota can import an existing VPC with `EXISTING_VPC_ID=<vpc-id>`.
  The imported VPC needs at least two availability zones, each with a private subnet that has NAT egress.
  Import mode is incompatible with execution regions.
- `scripts/20-seed-data.sh <profile> <home-region>` reseeds the demonstration dataset.
- `scripts/32-verify-all-regions.sh <profile> <home-region>` runs the nine capability classes in every active execution region and leaves long-lived showcase objects behind.
- `scripts/35-rebuild-account.sh <profile> <home-region> <second-region>` chains pre-flight, install, truth check, seeding, a UI-driven region build and the headless acceptance suite.

The headless acceptance suite depends on a local, non-versioned test directory and is not part of a customer deployment.
