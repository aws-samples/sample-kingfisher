# Kingfisher

**A big-data governance and development platform that runs inside your own AWS account: one account, one console, many regions.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Infrastructure: AWS CDK](https://img.shields.io/badge/Infrastructure-AWS%20CDK-orange)](infra/)
[![Documentation](https://img.shields.io/badge/Docs-docs%2F-blue)](docs/)

Kingfisher brings data integration, data development, scheduling and operations, data governance, AI-assisted analytics and cost governance into one web console.
Everything underneath is a managed AWS service: Redshift Serverless, S3 Tables, Glue, EMR Serverless, Athena, MWAA Serverless, DMS,
Managed Service for Apache Flink and Amazon Bedrock with AgentCore, plus a self-hosted OpenMetadata.
You deploy it with the AWS CDK; no data and no metadata leave your account.

<p align="center"><img src="docs/screenshots/home.webp" width="920" alt="Kingfisher home page: resource counts, run status, 7-day trend and business metrics"></p>

## Why Kingfisher

Many organisations must keep the data of each country or jurisdiction inside its own AWS region, yet the platform team wants one console, one login and one set of rules.
Kingfisher solves this with a **home region** that hosts the control plane and **N execution regions** that each host a complete data plane.
Switching the "execution scope" selector in the top bar moves your work to another region; data, schedules, logs and audit records stay where they were produced.

- One account, one console, one identity provider, one metadata catalog, one AI agent runtime.
- Every object and every run carries an explicit execution target; a request without a target is rejected instead of silently defaulting to the home region.
- Execution-region VPCs have no internet egress; AWS API calls go through interface endpoints.
- Adding a region is a wizard in the web console, not a CLI procedure.

## Who it is for

| Role | What Kingfisher gives you |
|---|---|
| Data engineers | Sync, batch, streaming and orchestration jobs that run in the region where the data lives |
| Analysts and business users | Natural-language questions over the warehouse and lake, a report builder, curated metrics |
| Governance and compliance teams | Catalog, lineage, classification, masking, quality rules and a per-region audit trail |
| Platform operators | Task monitor, alerting, SLA baselines, backfill, FinOps per region, incident knowledge base |

## Capability map

The console has seven menu groups plus the home page.
Every page has an execution-scope selector, a "How to use this page" help panel and an interactive tour on first visit.
The full page-by-page description with screenshots is in [`docs/features.md`](docs/features.md).

| Menu group | Pages | Highlights |
|---|---|---|
| AI Hub | Copilot Plan Center | Describe a goal in plain language; get a reviewable, step-by-step plan that creates objects but never runs them |
| Data Integration | Data Sources, Data Sync | JDBC, S3, DynamoDB, Kinesis and MSK sources; Glue batch sync to S3 Tables and Redshift; DMS, Zero-ETL and Flink CDC |
| Data Development | Batch Compute, ETL Orchestration, Redshift Query, Athena Query, Stream Compute | Glue PySpark, Redshift SQL and EMR Serverless jobs; visual DAGs published to each region's MWAA Serverless; Flink SQL |
| Smart Analytics | Ask-Your-Data, Skills, Observability, Report Builder, Requests | AgentCore-based NL2SQL that queries the region's warehouse with automatic masking; self-service BI; request workflow |
| Data Governance | Data Governance, Governance Workbench, Data Modeling, Business Glossary & Rules, Governance Center | Catalog, table- and column-level lineage, classification and masking, quality rules, modeling, OpenMetadata |
| Scheduling & Ops | Task Monitor, Multi-Region Dashboard, Backfill Center, Alerting Center, FinOps, Ops Dashboard, Incident Knowledge Base | One run ledger for every region; AI run diagnosis; SLA baselines; cost per region reconciled with Cost Explorer |
| System | Workspaces, Execution Environments, Users, Audit Log, Settings | Project-level RBAC; add a region with a wizard; Cognito users; full write audit; runtime switch of the AI model |

## Architecture at a glance

![AWS service view: CloudFront, WAF, ALB and ECS Fargate entry chain; one control plane in the home region; one data plane per execution region](docs/diagrams/aws-overview.png)

- **Entry chain.** CloudFront is the only public entry point, in front of AWS WAF and an Application Load Balancer that accepts CloudFront traffic only.
  The application is a Next.js full-stack service on ECS Fargate; Cognito validates the ID token of every `/api/*` call.
- **Control plane (home region, one per platform).** Cognito, DynamoDB control tables, Secrets Manager, KMS, OpenMetadata on ECS with RDS and OpenSearch,
  Amazon Bedrock with three AgentCore agents, CodeBuild as the execution-environment deployment broker, CloudWatch and CloudTrail.
- **Data plane (one per region).** A VPC without internet egress, S3 data lake and S3 Tables (Apache Iceberg), Glue, EMR Serverless, Athena,
  Redshift Serverless, MWAA Serverless, DMS, Managed Service for Apache Flink and a region-locked execution role.
- **Two cross-region channels, zero cross-region data.** The control plane sends definitions, deployments and health probes down to each region.
  Each region sends run metadata back over a private VPC peering. The platform never copies data between regions.

| Mechanism | What it means in practice |
|---|---|
| Execution scope first | Top bar: workspace, environment, execution scope. Read APIs filter by `?scope=`; invalid or unauthorised scopes get a 4xx, never a fallback |
| Explicit target | Every object and run carries a `targetId`; a request without one is a 400 |
| No cross-region reads | A job and its source must be in the same region; execution roles are region-locked; data-plane VPCs have no egress |
| Autonomous scheduling | One MWAA Serverless per region; DAGs, triggers and logs stay local; only run metadata is reported to the home region |
| One of each | One AgentCore, one OpenMetadata, one Cognito user pool and one audit trail serve all regions |

<p align="center"><img src="docs/screenshots/scope-dropdown.webp" width="920" alt="Execution-scope selector: all regions, home region, or one execution region"></p>

Component details, request flow, stack list and data flow are in [`docs/architecture.md`](docs/architecture.md).
The design contracts for multi-region execution are in [`docs/design/multi-region-execution.md`](docs/design/multi-region-execution.md).

## Quick start

The full procedure, prerequisites and acceptance checks are in [`docs/deployment.md`](docs/deployment.md). This is the skeleton.

**Before you start**

- An AWS account and an administrative deployment identity (IAM roles, VPC, Cognito, CloudFront and WAF must be creatable).
- A home region of your choice that offers Amazon Bedrock, Redshift Serverless, S3 Tables, Bedrock AgentCore and MWAA Serverless.
  Organisation policies must not block `us-east-1`, because the WAF for CloudFront lives there.
- A deployment machine with git, Docker with buildx, Node.js, the AWS CLI, Python, zip, curl, Maven and a JDK.
  Without Maven the deployment still succeeds, but Stream Compute is unusable. Pinned versions: [`docs/supported-versions.md`](docs/supported-versions.md).
- The repository must be cloned with git at a release tag; archive downloads without `.git` are rejected by the deployment scripts.

**Deploy the home region**

```bash
# 1) Get the code at a release tag and install dependencies
git clone --branch <release-tag> <repository-url> kingfisher && cd kingfisher
(cd infra && npm ci) && (cd platform && npm ci)

# 2) Account pre-flight: fix every hard failure before you continue
./scripts/01-preflight-account.sh <aws-profile> <home-region> <first-execution-region>

# 3) One command deploys the whole control plane and the home-region data plane (about 60-90 minutes)
#    Optional: EXEC_REGION_CANDIDATES=<region-1,region-2,...> pre-authorises future execution regions
BGP_DEPLOY_MODE=production ./scripts/deploy-all.sh <aws-profile> <home-region>

# 4) Post-deploy truth: every check must be green; exit 0 of the deploy script is not enough
./scripts/02-postdeploy-truth.sh <aws-profile> <home-region>
```

`BGP_DEPLOY_MODE` is mandatory: `production` creates no sample data and only the `admin` user; `demo` adds demo data and test accounts.
The mode is recorded in SSM and cannot be changed afterwards.
Always pass both positional arguments and always use `--profile`; never run `cdk deploy` directly, because the scripts also handle wiring, IAM checks and agent images.

**First login**

1. Read the platform URL from the `BgpPlatformStack` CloudFormation outputs (the CloudFront domain).
2. The initial `admin` password is written to a file on the deployment machine (path set by `BGP_PW_FILE`); change it right after the first login.
3. Create users under *System → Users*, then add them to a workspace under *System → Workspaces*; most features check workspace membership.

**Add an execution region**

1. Open *System → Execution Environments → New* and pick an enabled region of your account.
2. The platform triggers a CodeBuild run that deploys the region's CDK stack group.
3. Click *Detect initialization*, then *Enable*. Regions pre-authorised with `EXEC_REGION_CANDIDATES` need no further command.

## Repository layout

| Path | Contents |
|---|---|
| `platform/` | Next.js application: pages under `src/app/<route>/page.tsx`, APIs under `src/app/api/<group>/`, libraries under `src/lib/` |
| `infra/` | AWS CDK app: control-plane stacks in `lib/`, execution-environment stacks in `lib/exec-env/`, Lambda functions, agent containers |
| `scripts/` | Deployment and operations scripts: pre-flight, `deploy-all.sh`, post-deploy truth, platform and agent redeploy, release cut |
| `flink-sql-runner*/`, `flink-connector-modules/` | Flink SQL runner JARs (generic, S3 Tables, Kafka) and connector modules built with Maven |
| `docs/` | Documentation, screenshots, diagrams and design documents |

## Documentation

| Document | What you will find |
|---|---|
| [`README.md`](README.md) | This overview and the quick start |
| [`docs/architecture.md`](docs/architecture.md) | Components, request chain, CDK stacks, key flows and data flow |
| [`docs/features.md`](docs/features.md) | Every page of the console with purpose, capabilities and a screenshot |
| [`docs/deployment.md`](docs/deployment.md) | Production deployment, adding and removing regions, upgrade and rollback |
| [`docs/operations.md`](docs/operations.md) | Day-two operations: monitoring, troubleshooting, logs and routine checks |
| [`docs/security.md`](docs/security.md) | Identity, network isolation, encryption, audit and the security scanning policy |
| [`docs/supported-versions.md`](docs/supported-versions.md) | The single source for every runtime, engine, driver and tool version |
| [`docs/development.md`](docs/development.md) | Local development, tests, quality gates and the branching and release model |
| [`docs/cost-model.md`](docs/cost-model.md) | Idle cost of the home and execution regions, unit prices and workload estimates |
| [`docs/design/`](docs/design/) | Design documents and contracts for the current platform generation |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history and upgrade notes |

**Languages.** Documentation is written in English. Source comments, test titles and the console output of the deployment
scripts are written in Chinese, the working language of the engineering team. The console ships complete Chinese and English
locales: the language is suggested from the visitor's location and can be switched by the user at any time.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This project is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.
