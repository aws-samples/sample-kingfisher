# Plan the deployment

| Item | Description |
|---|---|
| Audience | Platform admins, IT leads responsible for the account and budget, operations staff about to run the installation |
| Estimated time | 30 minutes of reading; about half a day to prepare the account and the deployment machine from the checklist |
| Prerequisites | You have read the [architecture overview](04-architecture.md); you have a usable AWS account and a deployment identity that can create IAM / VPC / Cognito / CloudFront in it |
| What you will have | A completed planning checklist: home region and execution regions, deployment mode, budget magnitude, account and quota self-check results, deployment machine ready, hand-over method for the admin password |

## 0. Four things to decide first

| Decision | Description | Changeable later? |
|---|---|---|
| Home region | The region hosting the control plane; chosen by the customer; it must offer Bedrock (at least one model of the candidate chain callable), Redshift Serverless, S3 Tables, AgentCore and MWAA Serverless at the same time | No |
| First batch of execution regions | The regions where the data lives; each must offer Redshift Serverless, S3 Tables, Managed Flink, DMS and MWAA Serverless; candidate regions can be pre-authorized in one go at installation | Can be added / retired later on the page |
| Deployment mode | `production` (customer production: no seeded data, no demo database, only the admin account) or `demo` (demonstration / acceptance: demo source database + test accounts + seeded data) | No (written to SSM; later redeployments may not change it) |
| Who is the platform admin | The person holding the initial `admin` account and the password file; other accounts are created later under "Users" | Can be added / removed on the page |

## 1. Cost

The figures come from [`../cost-model.md`](../cost-model.md) (public on-demand prices in us-east-1, 730 hours / month, no discounts; other regions are generally +10% to +30%).

### 1.1 Idle base cost (paid even when nobody uses it)

| Topology | Monthly cost (approx., USD) | What it consists of |
|---|---|---|
| Idle home region (base) | 460 | OpenSearch node, OpenMetadata containers and RDS, NAT gateways ×2, platform containers, ALB ×2, public IPv4, WAF, cross-region write-back endpoints, KMS, Secrets Manager |
| Home region + a second CloudTrail | About 530 (derived: idle base + 68) | When the account already has another CloudTrail, the platform's own multi-region trail is billed per management event (about +68 when idle) |
| Each idle execution region | 165 | Almost entirely the 11 VPC interface endpoints × 2 availability zones required for zero egress; warehouse / scheduling / data lake cost 0 when idle |
| Demo mode extra | About +320 | The demo source database RDS MySQL (Multi-AZ, including the extended support fee); absent in production mode |
| After enabling real-time (per region) | +11 standing; another +27 after the first real-time sync | Kinesis source stream with 1 shard; the DMS replication instance is created lazily when the first real-time sync task starts and is reclaimed 10 minutes after the region's last DMS task is deleted |

In one sentence: the minimum production topology (1 home region + 1 execution region) costs about 620 to 990 USD / month when idle (lower bound = 460 + 165; the upper bound includes the second CloudTrail and the database extended support fee, and removing those two brings it close to the lower bound); each additional execution region adds about 165 USD / month.

### 1.2 Usage-based items (pay for what you use)

| Task type | Billing basis | Typical single run |
|---|---|---|
| Data sync (Glue job) | DPU-hours, billed per second with a 1-minute minimum; platform default 2 DPU | A small table for 5 minutes, about 0.07 USD |
| Batch compute (EMR Serverless) | vCPU-hours + GB-hours | 10 vCPU / 40 GB for 10 minutes, about 0.13 USD |
| Warehouse queries (Redshift Serverless) | RPU-hours, base 8 RPU ⇒ about 3 USD per active hour, minimum 60 seconds per wake-up | One dashboard refresh about 0.05 USD; 1 hour of continuous querying 3 USD |
| Orchestration / scheduling (MWAA Serverless) | Task-hours | 10 tasks of 5 minutes each, about 0.07 USD per run |
| Real-time streaming jobs (Managed Flink) | KPU-hours, minimum 2 KPU standing | About 170 USD / month per standing streaming job |
| Real-time sync (DMS) | Replication instance per hour, one per region shared by all tasks | About 27 USD / month standing |
| GenBI / Copilot / advisors (Bedrock) | Per input / output token | About 0.06 USD per question |
| Storage | S3 Tables and warehouse managed storage per GB-month | 1 TB of lake about 27 USD / month, 1 TB of warehouse about 25 USD / month |

- Three-tier workload estimates (per execution region / month): small (department pilot) about 140 USD, medium (one business domain) about 2,100 USD, large (whole company) about 22,500 USD; task costs scale linearly with task volume, and the biggest items are, in order, warehouse active time, Spark jobs, sync jobs, standing streaming jobs and large-model tokens.
- The real bill after go-live is on the "Scheduling & Ops → FinOps" page, which reconciles with Cost Explorer by region; see the scenario [FinOps](28-scenario-finops.md).
- After an execution region is retired, its data resources (data buckets, table buckets, warehouse snapshots, CMK, DAG bucket) are **retained and keep billing**; see [upgrade and uninstall](41-upgrade-and-uninstall.md).

## 2. Security: what the customer side must prepare

| Item | What to do |
|---|---|
| Account | One customer-owned AWS account; the whole platform is installed in it, with no cross-account roles |
| Deployment identity | An AWS CLI profile that can create IAM roles, VPCs, Cognito, CloudFront, WAF (in us-east-1), CodeBuild, Secrets Manager and so on; deployment always uses an explicit `--profile` |
| Organization policy | The organization SCP **must not block us-east-1**: the WAF rules used by CloudFront can only be created there, and even when the home region is not us-east-1 the scripts still bootstrap there |
| Admin password | The initial `admin` password is generated randomly by the deployment script and written to a password file on the deployment machine (specify a controlled path explicitly); it is also **printed once in the deployment output**; change it immediately at first sign-in, then destroy the password file and the deployment log |
| Who joins bgp-admin | Only the people who really administer the platform: this group manages users, execution environments and AI models and approves execution environment deletions; daily development uses bgp-developer, project configuration management goes to bgp-manager |
| Project members | The default project starts with **no members at all**; non-admins must be added to the workspace first, otherwise GenBI and other features return 403 "No access to this workspace" |
| OpenMetadata password | The deployment automatically replaces the factory password with a random one and verifies it; no customer action needed |
| Edge rate limiting | The WAF rate-limit threshold is adjusted to the customer's value; it is a deployment parameter |
| Data-plane credentials | Keep the production default (platform task role); do not add the credential-mode switch used for acceptance testing |
| Candidate regions | To add regions directly on the page later, name the full region names explicitly with `EXEC_REGION_CANDIDATES` at installation (`*` is not accepted; `all-enabled` = all regions enabled in the account, `none` = revoke); the manual recommends naming them as needed rather than opening everything for convenience |

The full list is in [`../deployment.md`](../deployment.md) sections 1 and 4; the identity model is in [identity management](13-identity-management.md).

## 3. Supported regions and constraints

| Constraint | Description |
|---|---|
| Single account | Execution environments can only be created in other regions of the same account as the control plane |
| One set per region | A region can have only one execution environment; regions already taken are listed in the wizard but not selectable |
| Complete components | Every execution region installs all components; there is no reduced variant |
| Fixed home region | Specified at installation and never changed afterwards; other execution regions can only be created through the page wizard |
| Candidate regions from the account's actual state | The wizard lists the regions **actually enabled** in the account; regions where an organization SCP blocks an action required for deployment are **listed but not selectable**, with the blocked action spelled out; regions marked "Organization policy could not be verified" can be re-checked with "Refresh" |
| Availability zones | Execution regions have no internet egress and all AWS calls go through interface endpoints, so the region must have ≥ 2 availability zones supported jointly by **all** interface endpoint services; the deployment build checks this at the very start and creates no resource at all when it is not met; "Discard" on the page frees the slot |
| No importing of existing VPCs | The multi-region production platform creates its own VPCs (a brand-new network, not connected to the customer's existing network); import mode prevents every non-home execution environment from being created |
| Jurisdiction | When creating an execution environment you enter the "Jurisdiction tag (jurisdiction)" by hand (default `home`); the platform does not derive it from the region, it cannot be changed after registration, and no legal judgment is made; when the jurisdiction differs from the home region's it must be changed to another value, and that region gets the extra regional audit component |

## 4. Quotas and account self-check

Before installation, operations runs the pre-flight script: `./scripts/01-preflight-account.sh <profile> <home-region> <execution-region>`; the third argument must explicitly name the planned first execution region.

| What it checks | Why | If it fails |
|---|---|---|
| VPC count (regional default limit 5) | The home region and every execution region each create one VPC; when the limit is reached the very first step fails with `VpcLimitExceeded` | Request a VPC quota increase (do not use VPC import in production) |
| Elastic IPs | The 2 NAT gateways of the home-region control-plane VPC use 1 each; execution regions have no egress and use none | When 4 or more are already in use in the home region, free some or request a quota increase first |
| IAM role creation | The platform creates dozens of roles | Without it the whole deployment is impossible |
| Cognito administrative writes | Creates groups and accounts; the most commonly restricted permission, and the one that fails latest | Restricted accounts have a bootstrap channel; see [`../operations.md`](../operations.md) section 3 |
| Bedrock models | One real call along the candidate chain (ACTIVE in the list does not mean callable) | "not available for this account" means the account is not enabled at the account level; contact your AWS account team |
| Interface endpoints × availability zones | See §3 "Availability zones" | Choose another region or contact AWS |
| Whether the target region hosts someone else's workload | In a shared account, putting resources into someone else's region collides with quotas | Pick a clean region |

- The pre-flight check **actually creates and immediately deletes** one IAM role, one Cognito user pool and S3 buckets in the account (one S3 probe bucket each in the home region, the execution region and a control region); it is a reversible write probe, so inform the customer in advance.
- When the account already has another CloudTrail, the platform's multi-region trail is a second one and its management events are billed (§1.1); when organization policy forbids creating CloudTrail, the installation can skip it with `SKIP_CLOUDTRAIL=1`.

## 5. Deployment machine

| Tool | Requirement | What happens without it |
|---|---|---|
| git | You must `git clone` and check out the release tag, or use the product package `kingfisher-<tag>.tar.gz` delivered by the release machine (run `sha256sum -c` first) | A web "Download ZIP" exits on the spot when tagging the agent images; the page footer shows "Build info unavailable" |
| Docker + buildx | Builds the platform image and the three agent images locally | Cannot deploy |
| Node.js 20 or later | Run `npm ci` once each in `infra/` and `platform/` | A fresh clone without dependencies fails CDK synthesis immediately |
| AWS CLI v2 | All commands use an explicit `--profile` | — |
| python3 · zip · curl | Script dependencies | — |
| Maven + JDK 17 | The deployment script builds the Flink runner JARs on the spot | Without Maven the deployment **still exits 0**, but the whole "Stream Compute" feature is unusable; also required for upgrades |

- The deployment machine does not need to be inside AWS; it needs access to GitHub (or the product package) and to the target account.
- Deployment takes about 60 to 90 minutes; resuming after a failed step is described in [`../operations.md`](../operations.md) section 4.

## 6. Deployment modes: production and demo

| Item | production | demo |
|---|---|---|
| Purpose | Customer production | Demonstration, evaluation, acceptance |
| Initial accounts | Only `admin` | `admin` + four role test accounts |
| Demo source database | Not created | A demo MySQL is created (RDS, Multi-AZ, billed separately) |
| Seeded data | None | Sample datasets are seeded at the end of the deployment; the game user-acquisition dataset and the `Showcase-*` demo objects are created separately by the evaluation-environment orchestration script |
| Changeable later? | No: the mode is written to SSM, and a redeployment with a different value is rejected | Same as production |

- The page features are identical in both modes; the only differences are the initial content and the demo source database.
- The scenario walkthroughs in this guide use a demo installation as the example; in production, replace the demo objects with your own databases and tables.
- The one-command setup of an evaluation environment is described in [deployment](06-deployment.md) and [`../development.md`](../development.md) (**not a production procedure**).

## 7. Supported versions

- The platform runtime, CDK, Glue (4.0 to 6.0; at least 5.1 for writing S3 Tables), EMR Serverless release labels, the Flink runtime, DMS engines, OpenMetadata, data source drivers, JDK / Maven, browsers and the version policy are all maintained in one place only, [`../supported-versions.md`](../supported-versions.md) (in English).
- Architecture diagrams carry no version numbers; the authoritative version in the text is the one on the sign-in page footer and the "Settings → Platform version" card.
- From 2.2.0 on, release tags are uniformly `v<version>`; customer deployments / upgrades always use a tag.

## 8. Planning checklist

- [ ] The home region is chosen, and Bedrock / Redshift Serverless / S3 Tables / AgentCore / MWAA Serverless are available there
- [ ] The first batch of execution regions is listed; each has ≥ 2 availability zones and is not blocked by organization policy
- [ ] The organization SCP does not block us-east-1
- [ ] The deployment mode is decided (always `production` for production)
- [ ] The budget magnitude has been estimated per §1 and you know which costs are standing
- [ ] The deployment identity and profile are ready; the pre-flight script is all green (or the red items have been handled)
- [ ] The deployment machine has all tools (including Maven + JDK 17)
- [ ] The location of the admin password file and the time of its destruction are set; who joins bgp-admin is decided
- [ ] The candidate regions to pre-authorize are listed

## 9. Further reading

- Installation steps at a glance: [deployment](06-deployment.md)
- The single production authority: [`../deployment.md`](../deployment.md)
- Mechanisms and troubleshooting: [`../operations.md`](../operations.md)
- Monthly cost model: [`../cost-model.md`](../cost-model.md)
