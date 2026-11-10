# AGENTS.md — entry point for AI coding tools

Read this file first. It tells an AI coding tool (Codex, Claude Code, Cursor and others) what Kingfisher is, where every document lives, which rules must never be broken, and how to find facts about a deployed environment.

Keep file paths, commands and identifiers exactly as written here. Answer the human in their own language.

## 1. What this project is

- Kingfisher is a data governance and development platform that a customer installs into their **own AWS account**.
- It covers data integration (sync and change data capture), data development (offline compute, orchestration, interactive SQL), scheduling and operations, governance (catalog, lineage, quality, modeling), AI-assisted analytics and cost governance.
- Deployment shape: **one account, one home region, N execution regions**. The home region runs the control plane; every execution region runs a complete data plane and data never leaves its region.
- Code: `platform/` (Next.js application), `infra/` (AWS CDK), `scripts/` (install, upgrade, gates), `flink-sql-runner*/` (Flink SQL runners).
- The current version is in `VERSION`; release notes are in `CHANGELOG.md`; pinned runtime and service versions are in `docs/supported-versions.md`.

## 2. Where every document lives

| I want to… | Read |
|---|---|
| Understand the product and see every page | `README.md`, `docs/features.md`, `docs/screenshots/` |
| Understand topology, stacks, core concepts, flows and storage | `docs/architecture.md` |
| Install, add a region, upgrade or roll back a customer deployment | `docs/deployment.md` |
| Operate and troubleshoot a deployed environment | `docs/operations.md` |
| Set up a workstation, run gates, follow the engineering rules | `docs/development.md` |
| Review the security model | `docs/security.md` |
| Check a runtime, engine or driver version | `docs/supported-versions.md` |
| Estimate monthly cost | `docs/cost-model.md` |
| Read the multi-region overview, contract, design and interaction | [`docs/design/multi-region-execution.md`](docs/design/multi-region-execution.md), [`multi-region-execution-spec.md`](docs/design/multi-region-execution-spec.md), [`multi-region-execution-design.md`](docs/design/multi-region-execution-design.md), [`multi-region-execution-interaction.md`](docs/design/multi-region-execution-interaction.md) |
| Read other design documents (one Markdown file per topic, flat directory) | [`docs/design/README.md`](docs/design/README.md) (index with status) |
| Learn to use the platform page by page, from first login to proficiency | [`docs/user-guide/README.md`](docs/user-guide/README.md) |
| Find a figure or its source | `docs/diagrams/`, `docs/diagrams/src/` |
| See what changed between versions | `CHANGELOG.md` |

Precedence when documents disagree: code (`platform/src`, `infra`, `scripts`) first, then `docs/deployment.md`, then `docs/design/multi-region-execution-spec.md` and `docs/design/multi-region-execution-design.md`, then other documents.

## 3. Non-negotiable rules

1. **Explicit `--profile` on every AWS command.** Never rely on the default profile or on environment credentials. Scripts take `<profile>` and `<home-region>` as positional arguments; always pass both.
2. **Never run a bare `cdk deploy`.** Use `scripts/deploy-all.sh`, `scripts/redeploy-platform.sh` or `scripts/redeploy-agents.sh`. They carry SSM wiring, the deployment mode, the IAM simulation gate and the agent image tags that a bare deploy would silently drop.
3. **`BGP_DEPLOY_MODE` is explicit and immutable.** Set `production` or `demo` on the install command. Once written to SSM `/bgp/deploy-mode` it must never change.
4. **No `-c dataplane-creds=...` in production.** The default `taskrole` is the production mode; `observe` and `enforce` are acceptance switches.
5. **The home region is fixed at install time.** It is the second argument of `scripts/deploy-all.sh` and is never changed afterwards.
6. **Other regions are created only through the web wizard** (Execution Environments → New). Never deploy `BgpExecEnv-*` stacks by hand, call the register API directly or write the registry table.
7. **Acceptance means a headless browser operating the pages.** Evidence is page DOM and screenshots. API, CLI and DynamoDB reads are debugging truth only.
8. **Never guess runtime facts.** Account ids, regions, stack names, URLs, table contents and passwords are read from the deployed account with the commands in section 4. This repository contains none of them.
9. **Never commit secrets.** Account ids, ARNs, keys and passwords do not enter the repository; the pre-commit hook and CI scan for them.
10. **In a customer account, read only.** Do not modify source databases, security groups, secrets or the customer's own jobs unless the human asks for that exact change.
11. **One execution region holds one complete execution environment.** Components are never trimmed. Production multi-region deployments never import an existing VPC.

## 4. Finding facts in a deployed account

All commands below are read-only. Replace `<profile>` and `<home-region>`.

```bash
P=<profile>; R=<home-region>

# Which stacks are installed
aws --profile $P --region $R cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query "StackSummaries[?starts_with(StackName,'Bgp')].StackName"

# Platform outputs, including the CloudFront entry point
aws --profile $P --region $R cloudformation describe-stacks \
  --stack-name BgpPlatformStack --query "Stacks[0].Outputs"

# Deployment mode and wiring facts
aws --profile $P --region $R ssm get-parameters-by-path --path /bgp/ --recursive

# Registered execution regions
aws --profile $P --region $R dynamodb scan --table-name bgp-execution-envs \
  --projection-expression "targetId,#r,#s,components" \
  --expression-attribute-names '{"#r":"region","#s":"status"}'

# Platform runtime parameters (replace with the latest BgpPlatformStack task definition)
aws --profile $P --region $R ecs describe-task-definition \
  --task-definition <task-definition> \
  --query "taskDefinition.containerDefinitions[0].environment"

# Which release the local checkout is
git describe --tags --exact-match
```text

- To find the home region, look for the one region where `BgpPlatformStack` exists.
- The deployed release is shown in the login-page footer, under Settings → Platform version, and by `GET /api/public/version`.
- Platform logs are in the ECS log group of `BgpPlatformStack`; region deployments log under the CodeBuild project `bgp-exec-env-deploy`.
- After any deployment run `./scripts/02-postdeploy-truth.sh <profile> <home-region>` and trust its output, not the exit code of the deploy script.

## 5. Engineering rules in brief

- Place is explicit and never defaults to the home region.
- Read routes filter by `?scope=`; write routes ignore scope.
- Every fact has a single author; enumerations are closed lists with validation.
- Tests mock only true externals and pin facts, not shapes.
- New functions need call-site evidence; async work needs a settled-state assertion; deletes leave no orphans.
- Full text and the local gates are in `docs/development.md`.

Before committing, run from the repository root:

```bash
(cd platform && npx tsc --noEmit -p tsconfig.json && npx vitest run && node scripts/naming-parity.mjs)
(cd infra && npx tsc --noEmit && npm run synth-gate)
bash scripts/redline-scan.sh
```

## 6. Working with this repository as an AI tool

- Follow `docs/development.md` for branches, Conventional Commits in English and `vX.Y.Z` tags.
- When you change a feature, read its design contract under `docs/design/<module>/` first and update the documentation in the same change set.
- When you change deployment shape or versions, update `CHANGELOG.md` and `docs/supported-versions.md`; diagrams never carry versions.
- Codex reads this file natively. Claude Code reads it through `CLAUDE.md` if present. Other tools can load it as a project rules file.
