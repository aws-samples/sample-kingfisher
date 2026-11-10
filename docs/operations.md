# Deployment Runbook — Pre-flight Checks Before Switching AWS Accounts and Workarounds for Restricted Accounts

> - 🔴 **Customer production deployments follow [`deployment.md`](deployment.md).** This runbook is the detailed explanation of the pre-flight checks, the restricted-account workarounds,
>   resuming after a failed step, and the post-deploy truth criteria; the demo / acceptance orchestration (moved to the development-environment runbook, which is not published
>   with this repository; one-command rebuild, seeding, all-region acceptance) is used only for demo / acceptance accounts.
> - Version: **v1.8** (2026-10-14, wording of the candidate-chain change on the development branch: pre-flight item 7 / row 5 of the table below now walks the **candidate chain**
>   with one real call per candidate (`scripts/resolve-home-model.sh`; how to read the stderr lines "✗ candidate → id —— verbatim message");
>   `BGP_MODEL_CANDIDATES` is for troubleshooting only), ships with the next release) · v1.7 (2026-10-14 02:xxZ, §6 pitfall table: the row "bare `cdk deploy` of AgentCore"
>   now says to use `scripts/redeploy-agents.sh`, and a new row "an upgrade that only runs redeploy-platform does not refresh the agents (defect identified 2026-10-14)" was added;
>   development-branch wording, ships with the next release) · v1.6 (2026-10-14, corrections after checking the document against the scripts item by item: §1 removed leftover
>   fragments of old commands, separated script segment numbers from table row numbers, marked the closing example command and the EIP wording as outdated ·
>   §3 path C gained the SSM parameter name, and the password file is explained per mode ·
>   §4 the re-run of user creation gained the warning "the script does not check the SSM mode" ·
>   §5 `x-cache` is only printed, not judged ·
>   §6 the AgentCore context key names were written precisely, and a row "a redeploy without `-c dataplane-creds=observe` silently falls back to taskrole" was added ·
>   **§2 and §4ante–§4quater, the demo / acceptance orchestration, were moved as a whole to the development-environment runbook (not published)**;
>   this document keeps only the production-relevant mechanisms) · v1.5 (2026-10-13, reconciled against release `release-2026-10-13`: §1 the model check command changed
>   to the `converse` form the script really uses ·
>   the number of pre-flight segments follows the script output ·
>   §3 Cognito user creation gained a third path (passwords written to SSM, then `cdk deploy BgpAuthStack -c bootstrapUsers=1`) · §4 the re-run of user creation must carry
>   the same `BGP_DEPLOY_MODE` as the first install ·
>   §5 gained item 9 (`tgt_home` in `bgp-execution-envs` is active) · removed the reference to `scripts/README.md`, which is not in the repository;
>   positioning: this document is about **mechanisms and troubleshooting**; §4ante–§4quater are demo / acceptance environment orchestration, **not production steps**;
>   production follows `deployment.md` only) · v1.4 (2026-10-12, reconciled against `release-2026-10-12`: every `deploy-all` command gained `BGP_DEPLOY_MODE` ·
>   the home region is chosen by the customer (no longer "only `us-east-1`") · §2 import-VPC gained the "not supported for multi-region" warning ·
>   password file path per profile · §5 changed to 9 items and points to the script · removed the outdated EIP statement)
> - v1.3 (2026-09-19, night: the §4ter matrix extended from 7 to **9** capability classes (adding stream compute / Ask-Your-Data, whose semantics differ from batch jobs)
>   + 🆕 §4quater "the shortest path to bring an account up quickly and verify it quickly after switching" (five commands + three time-saving lessons:
>   where the password lands on disk / clear `cdk.out` first / 202 is not failure))
> - v1.2 (2026-09-19, switching accounts in practice: new §4ante "bring up from zero and verify in one command" + §1 pre-flight and §5 truth criteria each consolidated
>   into a script + §4ter close-out through a headless browser)
> - v1.1 (2026-08-31, **four deployment defects fixed at the root**: ① §5bis the "first-deployment blind spot" of the CDK empty zip,
>   ② §4 cascading abort, ③ §5 exit 0 false green, ④ §3 Cognito cannot be set up in a restricted account; all four verified in a temporary workshop account)
> - v1.0 | Date: 2026-08-31 | Status: ✅ verified in practice
>
> Purpose: **before running `scripts/deploy-all.sh`**, complete the pre-flight checks in this document and pick the deployment path according to the results.
> Companion documents: the development-environment runbook (development / acceptance environment orchestration, not production; not published with this repository),
> the usage comments at the top of each script (there is no `scripts/README.md`; the script overview is in the repository index [`AGENTS.md`](../AGENTS.md)),
> and the archived record of the 2026-07 round of "deployment-time precondition" fixes (historical, not published).

## 0. Why this runbook must exist

On 2026-08-29 a deployment on a shared workshop account ran `deploy-all` for **40 minutes** before it hit the wall, and the two failure points
— **the VPC quota was full** and **Cognito administrative writes were denied** — **could both have been found in 30 seconds beforehand**.

Temporary / shared accounts of this kind (`WSParticipantRole`, Event Engine and the like) have trimmed permissions, and **every account is trimmed differently**:
of two accounts used on the same day, one denied every Cognito administrative write and the other allowed everything. So **the pre-flight check must be rerun whenever you switch accounts**;
do not start a deployment on the strength of last time's experience.

## 1. Pre-flight check — ✅ consolidated into one command (2026-09-19; the number of segments follows the script output, the figures in this text are no longer maintained)

```bash
./scripts/01-preflight-account.sh <profile> [home-region] [second-region]
# ❌ hard failure ⇒ non-zero exit (do not start until it is fixed) · ⚠️ soft warning ⇒ you can run, but know the boundary
```text

🔴 **Why it was consolidated**: the table below used to be just "a string of commands in the runbook", and temporary accounts often last only 3 days ⇒ every few days
someone had to type it all by hand, **and hands miss things**. On 2026-09-19 the item "`cdk.out` still holds the asset bucket name of the previous account" was missed,
and 40 minutes were almost wasted (the self-heal in step 2.5 has a fail-closed guard: a bucket that does not belong to this account is refused on the spot).
The script checks four more items than the table below, all learned the hard way: **foreign-account bucket names in `cdk.out`** / **EIP usage** (historical item:
since execution regions became zero-egress they no longer consume EIPs, so the item is for reference only; the wording of script segment 3 still says
"every execution environment consumes EIPs", which is outdated) / **whether other people's stacks exist in the target region** (in a shared account,
other people's `workshop-infra` must not be touched) / **the region allow-list measured with a reversible real write** (create a bucket and delete it — read-only probes
are not trustworthy; "denied ≠ this path is blocked" must be measured region by region).
All write probes are reversible (create a role and delete it, create a user pool and delete it, create a bucket and delete it); account ids are printed with the last 4 digits only.

The table below is kept as the explanation of **each item's criterion and what to do when it fails** (the script was written from it).
First set `P="--profile <your-profile>"` and `R=<target-region>`.

| # | What to check | Command / criterion | What to do when it fails |
|---|---|---|---|
| 1 | **Which region to choose** | Glance at each of `aws cloudformation list-stacks $P --region $R`, `describe-vpcs`, `eks list-clusters` | The home region is chosen by the customer (a home region of us-west-2 has been rehearsed from zero in a brand-new account), but that region must offer Bedrock Claude Opus 4.5, Redshift Serverless, S3 Tables, AgentCore and MWAA Serverless. 🔴 **Pass both positional arguments explicitly** (the defaults fall back to `temp-account` / `us-east-1`): `BGP_DEPLOY_MODE=production deploy-all.sh <profile> <home-region>`. When the home region is not us-east-1, the organization SCP must not block us-east-1 (WAF has to be created there). And pick a region **without other people's workloads** — pushing resources into a region where someone else's workshop is running collides with quotas and creates drift for them |
| 2 | **VPC quota** | `aws ec2 describe-vpcs $P --region $R --query 'length(Vpcs)'`; **the regional default limit is 5** | Full ⇒ creating a VPC fails immediately with `VpcLimitExceeded` and **the deployment dies at its first step**. Switch to §2 "import an existing VPC" |
| 3 | **IAM role creation** | Create one and delete it (the platform creates dozens of roles) | If this is not allowed the whole deployment is hopeless. ⚠️ When probing, **do not write Chinese (or any other non-Latin text) in `--description`**: the regex of that IAM field accepts Latin only, and the resulting ValidationError is misread as "no permission" (this happened) |
| 4 | 🔴 **Cognito administrative writes** (the most frequently trimmed, and the latest to fail) | Create a throwaway user pool, probe `CreateGroup` / `AdminCreateUser` / `AdminSetUserPassword` / `AdminAddUserToGroup` one by one, then `delete-user-pool` | Any one denied ⇒ see §3. **Note where it fails**: `deploy-all` step 11 creates groups and users. ✅ **Since 2026-08-31 its failure no longer aborts the whole deployment** (it goes through `run_step` bookkeeping): step 12 seeding and step 13 wiring check **run to completion as usual**, and the close-out lists the "steps that did not succeed" and **exits with a non-zero code**. So at that point **the infrastructure is ready** and only the login users are missing — follow the §3 workaround and re-run step 11 per §4 |
| 5 | **Bedrock model** | The script calls `scripts/resolve-home-model.sh <profile> <home-region>`: following the candidate chain in `platform/ai-model.json` (`candidateModelIds`: Claude Opus 4.5 → GLM 5.3 → Kimi K3) it expands each candidate into this region's inference profile and makes one real call with `aws bedrock-runtime converse … maxTokens=1`; the first one that answers becomes the deployment-time default (it does not use `list-foundation-models`: being listable does not mean being invocable) | If not one link of the chain works ⇒ all 9 AI consumers are down; each stderr line "✗ candidate <C> → <id> —— <verbatim Bedrock message>" is the troubleshooting lead ("not available for this account" = not enabled at account level, ask your AWS account team; "on-demand throughput isn't supported" = the bare id cannot be invoked on demand, look at the expanded `us.` / `global.` line; AccessDenied + Marketplace = the subscription is blocked by an SCP). 🔴 **ACTIVE in the listing does not mean usable**; the real criterion is a real invoke that gets through. `BGP_MODEL_CANDIDATES="<id> <id>"` overrides the candidate chain explicitly, **for troubleshooting only** (stderr marks "candidates from env") |
| 6 | **CDK bootstrap** | `aws ssm get-parameter $P --region $R --name /cdk-bootstrap/hnb659fds/version` | Absent is fine (step 2 does it); when it exists with a higher version the tool says "will not downgrade", which is normal |
| 7 | **Docker** | `docker version` + `docker buildx version` | Required: the ECS image and the 3 AgentCore ECR images are all built locally |
| 8 | **Dependencies installed** | `ls infra/node_modules platform/node_modules` | A fresh clone **must run `npm ci` first** (once in infra, once in platform), otherwise CDK synth fails straight away with TSError |

> - Pre-flight all green ⇒ run `BGP_DEPLOY_MODE=production ./scripts/deploy-all.sh <profile> <home-region>` directly (about 60–90 minutes; the example command printed
>   at the end of the script lacks `BGP_DEPLOY_MODE`, this line is authoritative). 🔴 `BGP_DEPLOY_MODE` must be given explicitly (`production` / `demo`);
>   without it the script exits 2 immediately.
> - ❌ results that may be ignored in the pre-flight: the third argument defaults to us-west-2 and is blocked by the organization SCP ⇒ rerun with the execution region
>   you really intend to use. (Since the candidate-chain change on the development branch (released 2026-10-27), segment 7 / row 5 of the table above derives
>   the foundation model from the true home region and expands this region's inference profile, so a home region outside the United States **no longer** necessarily
>   reports ❌; the script on the release tag then in production, `release-2026-10-13`, still probes the factory `us.` id directly, so with a non-US home region
>   keep ignoring that one item and go by the model chosen in deployment step 2.)

## 2. Import an existing VPC (moved out)

> "Import an existing VPC when the VPC quota is full" applies only to development / demo accounts; **multi-region production does not support importing a VPC**
> (see the red lines in [`deployment.md`](deployment.md), section 10.2); the content was moved to the development-environment runbook, which is not published
> with this repository (the demo-only import switch is summarized in `deployment.md`, Appendix A).

## 3. ✅ Fixed at the root: Cognito administrative writes denied (formerly "the platform cannot be installed in a restricted account")

**Symptom**: `AccessDeniedException ... cognito-idp:AdminSetUserPassword`; and the pool usually has self-registration turned off
(`AdminCreateUserConfig.AllowAdminCreateUserOnly=true`) ⇒ **the platform has not a single user who can log in**.

**The root cause is not "some API throws an error"**; it is that **the platform placed "create groups and users" on [the caller's IAM permissions] instead of on
[the deployment role / execution by an AWS service on your behalf].** The key insight is that **CloudFormation / CDK use the execution role created at bootstrap time
(AdministratorAccess), not the restricted role in your hands** — any operation that can be expressed as "run by an AWS service on your behalf"
is not limited by your role.

### Decision (landed 2026-08-31, no manual workaround needed)

`BgpAuthStack` now creates the function **`bgp-cognito-bootstrap`** (`infra/lambda/cognito-bootstrap/index.py`),
which carries permission for 5 Cognito actions **scoped to this user pool only**. `scripts/10-bootstrap-cognito.sh` has three paths (A direct Cognito API ·
B creation through the Lambda · C passwords written to the SSM parameter `/bgp/bootstrap-passwords` followed by
`cdk deploy BgpAuthStack -c bootstrapUsers=1 -c bootstrapPwParam=/bgp/bootstrap-passwords`; the script picks automatically according to permissions;
the table below expands only A / B):

| Path | When it is taken | Notes |
|---|---|---|
| **A direct** | Default | Accounts with the permissions **behave exactly as before** (zero regression, no extra dependency) |
| **B fallback invoke** | Only when A hits `AccessDenied` | Run by the deployment role, independent of your IAM. The password travels only through a mode-600 temporary file → invoke payload: **never on the command line** (no shell history / `ps` exposure), **never in the CFN template**, **never in CloudWatch** (the function never prints the event) |

### 🔴 Password hand-over: generated in step 11 → written to disk → read by step 11.5 and the acceptance layer (fixed at the root 2026-09-16)

When no `BGP_*_PASSWORD` is given, step 11 **generates random** passwords. It used to only `echo` them to the log, while step **11.5** (home seed)
of the **same** `deploy-all` run needs the admin password to log in ⇒ the parent script could not read it ⇒ **every first install in a brand-new account failed at 11.5**
(the error even said "rerun this step", and rerunning could not read it either — the value lived only in the child process's memory and the log).

Now `10-bootstrap-cognito.sh` writes the passwords of the users it created (production: only `admin`; demo: five) into **`${BGP_PW_FILE:-/tmp/bgp-cognito-pw-<profile>.json}`**
(mode **600**, content `{"admin": "...", ...}`), and `seed_home` in `deploy-all.sh` reads them in the order
**env → that file**. The acceptance layer can use it the same way:

```bash
export BGP_USER_PW_JSON="$(cat /tmp/bgp-cognito-pw-<profile>.json)"
export BGP_ADMIN_PASSWORD="$(python3 -c 'import json;print(json.load(open("/tmp/bgp-cognito-pw-<profile>.json"))["admin"])')"
```

🔴 General lesson: **"the value exists only in child-process memory / the log" = a seam inside a single run** — whoever generates it is responsible for handing it over
(write one single source of truth), rather than relying on the downstream "remembering to export".

**Why not a CFN custom resource** (an earlier version of this runbook called it "the proper solution"; corrected here): a custom resource executes **at deployment time**,
so the password would have to be available at deployment time ⇒ it would enter the template / parameters / stack events. With "an invocable function + a script that
falls back on demand", the generation and transport of the password stay on the caller's side, which is safer than "runs automatically at deployment time".

**Why the function is written in Python rather than the repository's Node style**: boto3 is **guaranteed to be bundled** in the Python runtime, whereas AWS is withdrawing
the bundling of AWS SDK v3 in the Node runtime. This path is precisely the one taken "when every other path is blocked"; reliability outranks stylistic uniformity.

### 🔴 Privilege-escalation surface and the three narrowings (must read)

A function that "can set any user's password" living permanently in the account is a privilege-escalation path for anyone who obtains `lambda:InvokeFunction`. Therefore:

| # | Narrowing | What happens without it |
|---|---|---|
| ① | **The roster is fixed on the function side** (`ROSTER_JSON` injected by CDK); the payload **can carry only passwords**, not "who goes into which group" | Otherwise the caller could create `attacker` for themselves and put it into `bgp-admin` = invoke permission ≡ the power to mint administrators |
| ② | When a user's status is already `CONFIRMED` (bootstrap completed), **password changes are refused** | Otherwise it is a permanent password-reset backdoor rather than a one-time bootstrap tool |
| ③ | A genuine reset requires setting the function's environment variable `BOOTSTRAP_ALLOW_RESET` to 1 | Changing the environment variable means having CFN/CDK permissions already (≈ administrator); that is the permission boundary between "reset" and "bootstrap" |

**Residual risk, recorded honestly**: in the window "stack created, not yet bootstrapped", someone holding invoke permission can set the admin password.
To leave no such function at all: `-c cognitoBootstrapFn=0` (the price: restricted accounts cannot be installed again, back to the manual workaround).

### Measured evidence (2026-08-31, temporary workshop account)

A PATH shim forced every direct `cognito-idp` call to fake `AccessDenied`, to force path B (the function prints its verdicts in Chinese; they are rendered here in English):
① all 9 direct calls were judged "permission denied → use the bootstrap Lambda"; ② the bootstrap Lambda judged the 4 groups `exists` (idempotent);
③ the 4 already `CONFIRMED` users were judged `skipped: not a password-reset backdoor` (**narrowing ② proven live**);
④ `biz-tester`, deleted beforehand, was really created and given a password — `admin-get-user` shows `CONFIRMED`,
and `initiate-auth` with the known password **logged in successfully** (proving that the whole "create user + set password" path really works);
⑤ invoking directly with a payload containing `attacker`/`admin2` → both `refused: not in the fixed roster`,
and `list-users` confirmed that the two users **did not appear** in the account (**narrowing ① proven live**).

## 4. How to make up a step after it fails

✅ **Since 2026-08-31, failure of step 11/12 no longer aborts the whole deployment**: they go through `run_step`, which **keeps the books instead of flipping the table**,
and the later steps that can run independently (especially step 13, the wiring check) run to completion as usual; the close-out prints the "steps that did not succeed" and
**exits with a non-zero code** (previously a detected wiring anomaly only printed red text and then exit 0: "the script succeeded" and "the platform is usable" were decoupled).
So when you see that close-out list: **the infrastructure is fine**; only the steps in the list need to be rerun. Once permissions / credentials are fixed, rerun them individually:

```bash
BGP_DEPLOY_MODE=<same as first install> ./scripts/10-bootstrap-cognito.sh <profile> <region>   # step 11: create groups and users (passwords can be given explicitly with BGP_*_PASSWORD; without a mode it follows production and creates only admin; 🔴 on the release tag then in production the script does not check the deployment mode in SSM, and passing `demo` by mistake creates 4 test accounts in production; since the 2026-10-27 release the script first reads SSM `/bgp/deploy-mode`, refuses with exit 2 when the given value differs, and follows env only when SSM cannot be read)
./scripts/20-seed-data.sh        <profile> <region>   # step 12: seed the e-commerce dataset (🔴 demo mode only; production seeds nothing)
BGP_DEPLOY_MODE=<same as first install> ./scripts/redeploy-platform.sh <profile> <region>   # equivalent of step 13: re-wire + check (no bare cdk deploy); its step 2b also redeploys BgpExecEnvDeployStack (the execution-environment deployer of step 6.5; without it, creating an execution environment fails with Function not found)
```text

> The **demo / acceptance environment orchestration** — the one-command bring-up after switching accounts, the multi-region end-to-end run, the headless close-out
> and the shortest path — was moved to the development-environment runbook, which is not published with this repository (these are not production steps).

## 5. The post-deploy "truth" criteria (exit 0 does not count)

`deploy-all` exiting 0 **still does not equal** being truly in place. On 2026-08-31 two "false greens" were closed (failures of step 11/12 are recorded,
a wiring anomaly in step 13 also counts as a failure ⇒ **any problem means a non-zero exit**), but the exit code covers only what the script itself checked —
**"green is only the criteria someone thought of at the time"**, so the items below still have to be checked against the truth one by one —
✅ consolidated into `./scripts/02-postdeploy-truth.sh <profile> <home-region>` (10 items; run it **before** changing the admin password, item 5 logs in with
the initial password the deployment wrote to disk). When the home region is not us-east-1, also check that `BgpWafStack` in **us-east-1** is COMPLETE
(the script only inspects the home region):

| What to check | Command / criterion |
|---|---|
| All stacks green | In `aws cloudformation describe-stacks` every `Bgp*` stack is `CREATE_COMPLETE`/`UPDATE_COMPLETE`, none `ROLLBACK`/`FAILED` |
| The application is really running | ECS `bgp-cluster/bgp-platform` has **running==desired** and `deployments` contains exactly 1 entry |
| The entry point is really reachable | `curl -s https://<PlatformUrl>/` returns `<title>Kingfisher</title>` (not a cached page; the script only prints the `x-cache` header and does not judge it — a human glances at whether it says `Miss from cloudfront`) |
| The authentication gate is in force | Unauthenticated `curl /api/projects` → **401** |
| Login works | `aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH` returns an IdToken whose decoded `cognito:groups` contains `bgp-admin` |
| Tables in place | `aws dynamodb describe-table` spot-checks key tables (for example `bgp-query-handles` must have primary key `handleId` and TTL attribute `ttl` ENABLED) |
| Wiring not wiped | Env values such as `GENBI_BACKEND` in the ECS task definition are non-empty (a bare `cdk deploy BgpPlatformStack` silently resets them to defaults) |
| 🆕 **The execution-environment deployer exists** | Both `aws lambda get-function-configuration --function-name bgp-exec-env-broker` and `aws codebuild batch-get-projects --names bgp-exec-env-deploy` return a result (= `BgpExecEnvDeployStack` is deployed). 🔴 Hit for real in a new account on 2026-09-06: an old version of deploy-all never deployed this stack, all 21 stacks were green, yet **Start deployment** in the wizard reported `Function not found: …bgp-exec-env-broker`; it is now folded into deploy-all step 6.5 + the step 13 check with self-heal + `redeploy-platform.sh` step 2b, which refreshes it together with HEAD; the **AI Wiring Health** card on the Settings page also has an "execution-environment deployer" item |
| 🆕 **The home execution environment is active** | In `aws dynamodb get-item --table-name bgp-execution-envs` the `status` of `tgt_home` = `active` (script item 9; when it is not active, creating or dispatching is refused by the admission check) |
| 🆕 **The S3 Tables federated catalog is open** (opened explicitly by the installer since the 2026-10-27 release) | `aws glue get-catalog --catalog-id s3tablescatalog` has `FederatedCatalog.ConnectionName` = `aws:s3tables` (script item 10; without it lake queries / Ask-Your-Data always fail with `CATALOG_NOT_FOUND`; it is opened by `deploy-all` step 6.3 / `redeploy-platform` step 3c and is not a CDK resource) |

## 5bis. ✅ Fixed at the root: CDK "empty zip" → `BgpPlatformStack` ROLLBACK (formerly "every first deployment in a new account hits it")

**Symptom** (measured in a brand-new account on 2026-08-31, same point as the 2026-08-24 occurrence):

```
Custom::S3AutoDeleteObjectsCustomResourceProvider/Handler  CREATE_FAILED
  AWS::Lambda::Function → "Uploaded file must be a non-empty zip" (400)
⇒ BgpPlatformStack ROLLBACK_COMPLETE (step 6)
```text

Some versions of the CDK CLI package the built-in `S3AutoDelete` handler as a **22-byte empty zip** and upload it to the bootstrap asset bucket;
and CDK uses the S3Key (content hash) to decide "already exists, do not re-upload" ⇒ **once the bad zip is in the bucket, every retry reuses it = guaranteed recurrence**.

### Root cause: the step 2.5 self-heal had two defects that made it effectively non-existent for a "first deployment in a new account"

| # | Defect | Why the first deployment was bound to fail |
|---|---|---|
| ① | **`MISSING` was simply skipped** (the old comment's reason: "CDK deploy uploads it itself") | The asset bucket of a brand-new account **is empty to begin with** ⇒ every asset is MISSING ⇒ **the whole self-heal is a no-op**; CDK then uploads the bad zip itself and the Lambda creation fails. The self-heal only took effect on "the second run" |
| ② | **objectKey was guessed from directory names** (glob `cdk.out/asset.*/` then append `<hash>.zip`) | `cdk.out` is littered with stale leftovers from past synths (**measured: 95 directories, only 5 of them really to be published according to the manifest**) ⇒ wasted work, and possibly uploading orphan objects nobody references; and as soon as the real key is not named `<hash>.zip` the repair misses it |

### The fix as decided (landed 2026-08-31 in `scripts/deploy-all.sh` step 2.5)

- **`MISSING` is pre-uploaded proactively too**: we put the good zip into the bucket first, and when CDK finds the key already present it skips its own upload
  — using the very **same mechanism** by which "a bad zip, once in the bucket, is reused", **turned around**. The first deployment is immune.
- **Enumeration now reads CDK's own asset manifest `cdk.out/*.assets.json`**: `objectKey` / `bucketName` both come from the manifest
  (authoritative); only `packaging=="zip"` is taken (docker images are in the `dockerImages` section, templates are `packaging=="file"`,
  neither is related to this bug); deduplicated across stacks by `(bucket,key)`.
- **Abort on failure** (upload / packaging failure `return 1`), instead of letting the deployment run 40 minutes before the platform stack ROLLBACKs; the upload retries once
  so that a single S3 hiccup does not abort. When the `zip` command is not installed it errors explicitly instead of skipping silently.
- Idempotent: a healthy zip in the bucket (≥64 B) is skipped. For debugging, `HEAL_DRY_RUN=1` only prints the verdicts without uploading.

### 🔴 Two preconditions that must both hold (stumbled on in measurement 2026-08-31, now written into the code)

| # | Precondition | What happens otherwise (measured) |
|---|---|---|
| ① | **`cdk synth` must carry `--profile`** | Without it CDK resolves the environment with the **machine's default profile** and writes **another account's** bucket into `bucketName` of `cdk.out/*.assets.json` (two foreign accounts appeared in measurement). The self-heal then uses this account's credentials to `head-object`/`PutObject` **on another account's bucket** ⇒ all 6 `AccessDenied`; worse, **requests were really sent to a foreign account** |
| ② | **The bucket in the manifest must belong to this account; if not, refuse on the spot** | `bucketName` is external input that we trust. One synth not bound to the right profile turns the "self-heal" into "using this account's credentials to touch another account's bucket". Hence the fail-closed guard: when `*-<account>-<region>` does not match, refuse and suggest deleting `infra/cdk.out` and rerunning. ⚠️ **This must be re-reviewed when multi-target / multi-account deployment lands** (then each target's account should be allowed individually) |

Also: when an upload fails, **the `aws` stderr must be printed**. Earlier versions swallowed it with `2>&1`, and a failure only said "upload failed" without the reason —
troubleshooting could only be done by manual reproduction, and a lot of time was wasted in measurement because of it (the true cause was precisely the item above:
hitting another account's bucket).

### Measured evidence (2026-08-31)

**Decisive verification with an empty bucket (= first deployment in a brand-new account)**: the CDK asset bucket of this account was **emptied** to recreate the initial state
of a virtual account → the self-heal was run → "manifest 6, provisioned/repaired 5, failed 0" (the 6th was healthy to begin with and correctly skipped).
Then `cdk deploy BgpAuthStack` → **only the template was published, that zip was not re-uploaded**, output `✅ (no changes)`
— this is the direct observation of "when the key already exists CDK skips its own upload": **our pre-upload is reused**.
While the bucket was emptied, production was unaffected (20 stacks still green / entry point 200 / unauthenticated 401): these objects are read only at deployment time.

**The three segments that close the mechanism**: empty bucket → we pre-upload (above); CDK sees the key present and does not upload its own (above);
Lambda can be created from the artifact of our `zip -X -r` — proven by **that day's real deployment**: after the self-heal overwrote 22 B with 2173 B,
`Custom::S3AutoDeleteObjectsCustomResourceProvider/Handler` **was created successfully** and the whole stack reached CREATE_COMPLETE.

**The other three**: real bucket (already healthy) → "provisioned/repaired 0"; manifest key changed to one that does not exist in the bucket → all judged
"missing in bucket (first deployment)"; run again right after a real upload → "provisioned/repaired 0" (idempotent).

### If you still hit it (old script version / other causes)

```bash
# 1) Delete the failed stack (a ROLLBACK_COMPLETE left by a failed CREATE must be deleted before it can be rebuilt)
aws cloudformation delete-stack --stack-name BgpPlatformStack --profile <p> --region <r>
aws cloudformation wait stack-delete-complete --stack-name BgpPlatformStack --profile <p> --region <r>
# 2) Rerun (the 10+ earlier stacks are already in place and are skipped idempotently; or rerun only the platform stack)
BGP_DEPLOY_MODE=<same as first install> ./scripts/deploy-all.sh <profile> <region>      # or ./scripts/redeploy-platform.sh <profile> <region>
```

**Criterion**: step 2.5 should print "provisioned/repaired zip: <hash>.zip (… → NNNN B)", and the closing line "manifest N, provisioned/repaired M, failed 0"
(the script prints these lines in Chinese; they are rendered here in English).

**Known residual (not hidden)**: step 2.5 covers only the assets that `cdk synth --all` could synthesize at that moment. **New zip-type assets** that later steps synthesize
with extra context are not covered (measured: this platform has none of those — the step 5 AgentCore assets are
**docker image assets**, which go to ECR and not to the asset bucket). If a "Lambda that is only synthesized with context" is ever added,
call `heal_cdk_empty_assets --no-synth` once more before that step.

## 6. Known pitfalls quick reference

| Pitfall | Symptom | Handling |
|---|---|---|
| Positional arguments not written / the machine's `AWS_REGION` differs from the home region | Silently falls back to the defaults `temp-account` / `us-east-1`; or the control plane is built into another region | Write both positional arguments explicitly; the deployment scripts already force alignment with the home region, and refuse at synth time when the target region ≠ home region |
| `redeploy-platform.sh` with extra cdk arguments | The script comment says `[-- extra cdk arguments]`, but `--` is passed to cdk verbatim | Put the extra arguments directly after the second positional argument; **do not** write `--` |
| VPC quota full | `VpcLimitExceeded` at the first step | §2 import an existing VPC |
| Cognito administrative writes denied | Step 11 fails (**since 2026-08-31 it no longer drags down 12/13**; close-out bookkeeping + non-zero exit) | §3 workaround + §4 rerun |
| Mixing `AWS_PROFILE` and `--profile` | The SSM self-heal section of `bin/app.ts` only recognizes `process.env.AWS_PROFILE`; a missing export silently skips the self-heal | `deploy-all`/`redeploy-platform` already export it; export it too when running cdk by hand |
| Bare `cdk deploy BgpPlatformStack` | The AI wiring is silently reset to empty defaults and pages break without a sound | Use only `scripts/redeploy-platform.sh` |
| Bare `cdk deploy` of AgentCore | Deletes the Runtime | Use `scripts/redeploy-agents.sh <profile> <home-region>` (automatically carries `-c <agent>-runtime=1 -c <agent>-agent-tag=<git short hash>`, deploys one by one, reads the Runtime tag back to verify); when running cdk by hand both context values are mandatory, and cdk must not run concurrently |
| Upgrading with `redeploy-platform.sh` only | The three agent images and stacks are **not** refreshed (defect identified 2026-10-14); Ask-Your-Data / the advisors keep running the old core and recipes, and the pages show no error | Upgrade = `redeploy-platform.sh` + `redeploy-agents.sh`; first run `redeploy-agents.sh <profile> <home-region> --check` to see whether a refresh is needed |
| Going to lake query / Ask-Your-Data without ever having run a "sync that writes S3 Tables" | Athena `CATALOG_NOT_FOUND: Catalog 's3tablescatalog/<table-bucket>' does not exist` (does not change however long you wait; it is not propagation delay) | The federated catalog is a region-level Glue resource; the version then in production created it lazily only on the sync start path; since the 2026-10-27 release `deploy-all` step 6.3 / `redeploy-platform` step 3c open it explicitly and lake query self-heals; for existing environments one run of `redeploy-platform.sh` fills it in; verify with truth item 10 |
| An acceptance account redeploys the platform stack without `-c dataplane-creds=observe` | The task definition **silently** returns to the default `taskrole`, and whole segments of acceptance criteria written for `observe` mode turn red | `-c dataplane-creds` is not written to SSM; every `redeploy-platform.sh` must carry it explicitly; production must **not** carry it (the default taskrole is the production setting) |
| Expired credentials | Any AWS call fails with `ExpiredTokenException`; `redeploy-platform` aborts cleanly at step 1 (reading CFN outputs) | Refresh credentials and rerun; **there is no half-applied change in production** |
| ✅ **CDK empty zip** (formerly "every first deployment in a new account hits it") | Step 6 `BgpPlatformStack` ROLLBACK, "Uploaded file must be a non-empty zip" | **Fixed at the root 2026-08-31**: the step 2.5 self-heal became "read the asset manifest + pre-upload MISSING too + abort on failure". Only an old version needs delete-stack-and-rerun, see **§5bis** |

## Appendix A. Operating a deployed platform

The sections below cover running a deployed Kingfisher platform: what to watch every day, how to find facts in the account, where the logs are,
how to work through common symptoms that are not already in §6, what keeps billing, and what is retained.
Installation, upgrade and rollback procedures are in [deployment.md](deployment.md).
All commands are read-only unless stated otherwise. Replace `<profile>` and `<home-region>` before running them.

### A.1 Daily operations

#### A.1.1 Pages to watch

| Page | Route | What it shows |
|---|---|---|
| Task Monitor | `/monitor` | Run instances across all regions with a trigger column (manual, automatic, backfill); run logs; the schedule configuration tab |
| Multi-Region Dashboard | `/multi-region` | Per-region health and the consistency matrix of execution environments |
| Backfill Center | `/backfill` | Backfill plans, per-instance progress, rows written and error text |
| Alerting Center | `/alerting` | Alert rules (failure, timeout, success rate, stream stall), channels with test delivery, deduplicated events, SLA and baseline views |
| Cost governance (FinOps) | `/finops` | Spend by service and region with the platform's unit prices |
| Ops Dashboard | `/ops` | Summary of alerts, runs and health |
| Incident Knowledge Base | `/incidents` | Incidents grouped by failure signature, with handling notes and AI diagnosis |
| Execution Environments | `/exec-envs` | Status of every region, probe results, redeploy and decommission actions |
| Audit Log | `/audit` | Every write operation: who, when, which object, which region |
| Settings | `/settings` | AI model, Platform version, AI Wiring Health, external table buckets, Data source network objects |

Every page has a **How to use this page** help entry in the top-right corner.

#### A.1.2 Routine checklist

Daily:

- Open the Task Monitor and filter for failed or timed-out runs since the previous day. Open the run log from the row before touching the job.
- Open the Alerting Center and clear or acknowledge events; confirm that channels still pass a test delivery.
- Glance at the Execution Environments page: every region should be `active` with a green probe.

Weekly:

- Review the cost governance page against Cost Explorer; look for warehouses kept awake by dashboards and for stream jobs that nobody uses.
- Check **Settings → Data source network objects** for orphaned platform-managed security groups or connections.
- Review the Audit Log for administrative actions (user resets, workspace membership changes, environment changes).

After any deployment:

- Run `./scripts/02-postdeploy-truth.sh <profile> <home-region>` (§5) and compare `GET /api/public/version` with the intended tag.

### A.2 Finding facts in a deployed account

Set two shell variables once:

```bash
P=<profile>; R=<home-region>
```text

#### A.2.1 Which region is the home region

The platform stack exists only in the home region.

```bash
for r in $(aws --profile $P ec2 describe-regions --query "Regions[].RegionName" --output text); do
  aws --profile $P --region $r cloudformation describe-stacks --stack-name BgpPlatformStack \
    --query "Stacks[0].StackName" --output text 2>/dev/null && echo "home region = $r"
done
```

#### A.2.2 Stacks and outputs

```bash
aws --profile $P --region $R cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query "StackSummaries[?starts_with(StackName,'Bgp')].StackName"
aws --profile $P --region $R cloudformation describe-stacks --stack-name BgpPlatformStack \
  --query "Stacks[0].Outputs"
```text

`BgpPlatformStack` outputs include the platform URL; `BgpOmServiceStack` outputs include the OpenMetadata URL; `BgpAuthStack` outputs include the user pool id.

#### A.2.3 Deploy mode and wiring

```bash
aws --profile $P --region $R ssm get-parameters-by-path --path /bgp/ --recursive
```

`/bgp/deploy-mode` tells you whether the environment is `production` or `demo`.
`/bgp/wiring/*` holds the OpenMetadata URL, the agent runtime ARNs and memory ids.
`/bgp/wiring/execution-region-candidates` lists pre-authorized regions.

#### A.2.4 Execution environments

```bash
aws --profile $P --region $R dynamodb scan --table-name bgp-execution-envs \
  --projection-expression "targetId,#r,#s,components" \
  --expression-attribute-names '{"#r":"region","#s":"status"}'
```text

The home target is `tgt_home`. Status `active` means the region accepts work; `draining`, `decommissioning` and `deleted` are the decommission states.

#### A.2.5 Platform runtime configuration

```bash
TD=$(aws --profile $P --region $R ecs describe-services --cluster bgp-cluster --services bgp-platform \
  --query 'services[0].taskDefinition' --output text)
aws --profile $P --region $R ecs describe-task-definition --task-definition "$TD" \
  --query 'taskDefinition.containerDefinitions[0].environment'
```

The meaning of each variable is in [deployment.md](deployment.md), Appendix A.1. `BGP_DATAPLANE_CREDS` should read `taskrole` in production.

#### A.2.6 Running version

```bash
curl -s https://<platform-host>/api/public/version
```text

The same facts appear in the login page footer and under **Settings → Platform version**.
For the three agent runtimes, `./scripts/redeploy-agents.sh <profile> <home-region> --check` prints the image tag each runtime is using and whether it differs
from the checked-out code; it changes nothing.

#### A.2.7 Execution-environment deployer

```bash
aws --profile $P --region $R lambda get-function-configuration --function-name bgp-exec-env-broker
aws --profile $P --region $R codebuild batch-get-projects --names bgp-exec-env-deploy \
  --query 'projects[0].environment.environmentVariables'
aws --profile $P --region $R codebuild list-builds-for-project --project-name bgp-exec-env-deploy
```

#### A.2.8 OpenMetadata database

```bash
aws --profile $P --region $R rds describe-db-instances --db-instance-identifier bgp-openmetadata-db \
  --query "DBInstances[0].[EngineVersion,DBInstanceStatus]"
```bash

#### A.2.9 Residual resources after a decommission

S3 buckets are global; the other commands are per region.

```bash
aws --profile $P s3api list-buckets --query "Buckets[?starts_with(Name,'bgp-')].Name"
aws --profile $P --region <region> s3tables list-table-buckets
aws --profile $P --region <region> redshift-serverless list-snapshots
aws --profile $P --region <region> kms list-aliases --query "Aliases[?starts_with(AliasName,'alias/bgp-')]"
```

### A.3 Logs and diagnostics

| Source | Where to look | Notes |
|---|---|---|
| Platform application | CloudWatch log group prefixed `BgpPlatformStack-BgpServiceTaskDef` | One stream per ECS task; API errors and long-running-operation progress |
| OpenMetadata service | CloudWatch log group of `BgpOmServiceStack`, stream prefix `openmetadata` | One-week retention |
| Sync jobs | Glue job runs in the execution region | Run id is shown in the Task Monitor and the sync task detail page |
| Scheduled runs | MWAA Serverless workflow runs in the execution region | Run records are mirrored into the Task Monitor |
| Spark jobs | EMR Serverless job runs; logs in the EMR log bucket | Run history is on the Batch Compute page |
| Stream jobs | Managed Flink application in the execution region | Status also on the Stream Compute page |
| Real-time integration | DMS replication task status in the execution region | Reconciled into the sync list and detail page |
| Execution-environment builds | CodeBuild project `bgp-exec-env-deploy` | Preview builds exit non-zero by design when approval is required and no approved plan matches |
| Account audit | CloudTrail trail and VPC flow logs from the audit stack | Flow logs kept one month |
| Platform audit | Table `bgp-audit`, page `/audit` | Every write operation with user, time, object and region |
| IAM coverage | `python3 scripts/iam-simulate-gate.py --profile <profile> --home-region <home-region> --regions <r1,r2>` | Offline, read-only, three-state exit code |

Find the platform log group:

```bash
aws --profile $P --region $R logs describe-log-groups --log-group-name-prefix BgpPlatformStack \
  --query 'logGroups[].logGroupName'
```

#### A.3.1 Run diagnosis with the DevOps agent

Failed runs and Flink jobs can be sent to **Diagnose** from the Task Monitor and the Stream Compute page.
The platform discovers or creates an AWS DevOps Agent space named `bgp-devops-agent`, opens a session, submits the evidence and polls for the investigation result
every few seconds.
The result is attached to the run and to the matching incident signature in the knowledge base.

#### A.3.2 IAM simulation gate exit codes

| Exit code | Meaning |
|---|---|
| 0 | Every recorded platform call is allowed in every listed region |
| 1 | At least one call is denied; the output names action and resource |
| 2 | The gate itself could not run (usage, permissions or environment) |
| 4 | No denial, but some rows could not be evaluated in this account (organization policy, or no probe region for the any-region axis); not a pass |

### A.4 Troubleshooting (symptoms not covered in §6)

| Symptom | Likely cause | Action |
|---|---|---|
| OpenMetadata page errors, agents fall back to in-process execution | Platform stack deployed with bare `cdk deploy` | Run `redeploy-platform.sh`; check truth item 7 (§5) |
| New environment wizard reports `Function not found: ...bgp-exec-env-broker` | Deployer stack missing | Run `redeploy-platform.sh`; its step 2b deploys the deployer stack (§4, §5) |
| Probe rows red with access denied after a region build | Control plane has not authorized the region | Run `redeploy-platform.sh`, then **Check initialization** [1] |
| Redeploy preview reports that approval is required | Normal after a control-plane upgrade: the change-set rehearsal found a replacement or deletion of a stateful resource, or an undecidable change, and no approved plan hash matches | Review and approve the plan in the UI; the build refuses to deploy without a matching approval |
| CloudFormation answers `... does not exist` while the platform inspects a stack or change set right after a preview or at the very start of a build | The stack has not been created yet, or the rehearsal change set was already cleaned up | None; the platform treats this window as "not created yet" |
| Execution-environment build fails at `cdk bootstrap` with a default-model geography message | CodeBuild project runs an older source package | Redeploy the control plane; current builds bootstrap with `--app ''` [2] |
| IAM gate exits 4 | Some rows could not be evaluated in this account (organization policy, or no probe region for the any-region axis) | Record it; rerun in an account without the restriction. Exit 4 is not a pass |
| Platform returns 503 on every page | Cognito not configured and `BGP_AUTH_DISABLED` not set explicitly | Check `BgpAuthStack` outputs and the task definition |
| Non-administrator gets 403 in Ask-Your-Data | User is not a member of the workspace | Add the user in **Workspace** |
| Sole administrator locked out | No other administrator can reset | Account owner runs the Cognito reset command [3] |
| Sync run fails with `SYNC_REFUSED_CLEAR_FOREIGN_TABLE` | Target table exists and was not created by the platform | **Confirm overwrite** per table in the wizard, or change the target |
| Sync run refused with `MERGE_KEY_MISSING` | Write mode `merge` without merge keys | Add merge keys in the wizard |
| Glue run reports `Security Group Not Found` | A platform-managed `bgp-ds-*` group was deleted externally | The platform rebuilds it on next use; review network objects [4] |
| Spark job fails with "unrecognized arguments" | Strict `argparse` in a user script | Use `parse_known_args()` or read `sys.argv` by name [5] |
| Delete data source returns 409 `DATASOURCE_IN_USE` | Sync or real-time tasks still reference it | Remove or repoint the listed tasks first |
| Action returns 409 `LONG_OP_IN_PROGRESS` | Another long-running operation holds the object | Wait for it to finish; check the toast in the lower right |
| UI shows a "running in background" toast for a long time | Warehouse cold start or model latency | Wait; do not click again [6] |
| Automation receives 202 with `protocol: "long-op/1"` | Long-running-operation protocol | Poll `GET /api/long-ops/<taskId>` until terminal |
| Real-time task start takes many minutes the first time | Replication instance created lazily per region | Wait; a second click returns 409 `START_IN_PROGRESS` |
| Flink job errors immediately on start | Runner JARs missing from the scripts bucket | Install Maven and rerun `deploy-all.sh` [7] |
| Model probe reports "not available for this account" | Model not enabled at account level | Ask the AWS account team; choose another model meanwhile |
| OpenMetadata unavailable for about two minutes during an upgrade | Database engine upgrade step | Expected; do not interrupt the script |
| `git fetch` refuses to update a tag | Tag moved on the remote | `git fetch --tags --force` |
| Decommission stalls | Dependency ordering in the target region | **Retry destruction** on the detail page |
| Delete project returns 400 listing resources | Workspace still owns objects | Release the listed objects first |
| Delete project returns 503 | Credential revocation could not be queued | Retry |

Notes:

1. IAM region conditions are baked in at synthesis time. The allow-list is the home region plus every non-deleted environment plus the candidate list from SSM.
   Pre-authorize with `EXEC_REGION_CANDIDATES` to avoid this step.
2. The execution-environment build runs `cdk bootstrap --app ''` so that no application code (and therefore no control-plane guard) executes.
   Older source packages ran the application during bootstrap and tripped the default-model geography guard when the home region was outside the United States
   (a production incident on 2026-10-29). Redeploying the control plane refreshes the source package.
3. The command is in [deployment.md](deployment.md), section 4.4.
4. Platform-owned objects (security groups, Glue connections, platform-chosen subnets) carry `bgp:managed`, `bgp:datasourceId` and `bgp:targetId` tags.
   They are rebuilt at the moment of use, and the rebuild is written to the audit log and the Alerting Center. Objects you supplied are only reported.
   **Settings → Data source network objects** lists orphans and offers one-click cleanup.
   Never delete a `bgp-*` cloud object before checking whether a data source still references it.
5. The platform appends business-date parameters (`--ds`, `--ds_nodash`, `--yesterday_ds`, `--bizdate` and others) after the script's own arguments for Glue and EMR jobs.
6. Requests that wait on an external system (warehouse DDL, model calls, environment builds) answer synchronously when they finish within the configured wait,
   otherwise they return 202 and the browser polls.
   Clicking again is refused with 409 while the first operation runs.
7. Runner JARs are built with Maven during `deploy-all.sh` and uploaded to `s3://bgp-glue-scripts-<account-id>/flink/`.
   Without Maven the install exits 0 but the JARs are absent. The upload step is idempotent, so rerunning the installer after installing Maven is safe.

### A.5 What keeps billing

The detailed model with measured figures is in [cost-model.md](cost-model.md). In short:

- Home region, always on: platform and OpenMetadata containers, the OpenMetadata database and search domain, two NAT gateways, two load balancers,
  the cross-region DynamoDB interface endpoint, WAF, customer-managed keys and secrets.
- Each execution region, always on: the interface endpoints that make zero-egress networking possible, one customer-managed key and a few secrets.
  Warehouse, scheduler, lake and compute bill nothing while idle.
- Per execution region once real-time features are used: a provisioned stream shard, and a DMS replication instance that is created on the first real-time task and then stays.
- Usage-driven: warehouse active time, Spark jobs, Glue jobs, scheduler task time, model tokens, storage and logs. A continuously running Flink job is the largest fixed per-job item.
- After a decommission: data buckets, table bucket, warehouse namespace and workgroup with final snapshot, the regional key and the DAG bucket are retained
  and keep billing until removed by you.

Watch the cost governance page (`/finops`) for the platform's view and Cost Explorer for the account's view.

### A.6 Backup and retention behavior

| Resource | Policy |
|---|---|
| DynamoDB tables | Retained on stack deletion; point-in-time recovery enabled |
| OpenMetadata database | Multi-AZ, 30-day automated backups, deletion protection, retained on stack deletion |
| Customer-managed keys (home and per region) | Retained with a 30-day deletion waiting period; aliases retained |
| Home data lake, scripts and DAG buckets | Retained on stack deletion |
| Home S3 Tables table bucket and Athena workgroup | Retained on stack deletion |
| Execution-region buckets and table bucket | Retained, never auto-emptied |
| Execution-region warehouse namespace and workgroup | Retained; a final snapshot is taken at decommission |
| CloudTrail bucket and search domain | Retained on stack deletion |
| Long-running-operation records (`bgp-long-ops`) | Expire automatically after about seven days |
| OpenMetadata container logs | One week |
| VPC flow logs | One month |

Behavior to keep in mind:

- Decommissioning an execution region deletes compute, networking and roles but leaves every data-bearing resource in place
  (see the list in [deployment.md](deployment.md), section 8.3). Removing them is a manual, deliberate action.
- A relational database engine upgrade performed during a platform upgrade takes an automatic pre-upgrade snapshot. Engine downgrades are not supported;
  a code rollback leaves the engine as is.
- Deleting a workspace does not drop its warehouse schema (`proj_*`).
- Scheduler artifacts and Glue scripts are generated when workflows are published or sync tasks are saved. They are regenerated by publishing or saving again;
  they are not backed up separately.
- Residues can be listed with the read-only commands in A.2.9.
