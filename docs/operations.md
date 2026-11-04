# Operations Guide

This guide covers running a deployed Kingfisher platform: what to watch every day, how to find facts in the account, where the logs are, how to work through common symptoms, what keeps billing and what is retained.
Installation, upgrade and rollback procedures are in [deployment.md](deployment.md).

All commands are read-only unless stated otherwise. Replace `<profile>` and `<home-region>` before running them.

## 1. Daily operations

### 1.1 Pages to watch

| Page | Route | What it shows |
|---|---|---|
| Task monitor | `/monitor` | Run instances across all regions with a trigger column (manual, automatic, backfill); run logs; the schedule configuration tab |
| Multi-region dashboard | `/multi-region` | Per-region health and the consistency matrix of execution environments |
| Backfill centre | `/backfill` | Backfill plans, per-instance progress, rows written and error text |
| Alert centre | `/alerting` | Alert rules (failure, timeout, success rate, stream stall), channels with test delivery, deduplicated events, SLA and baseline views |
| Cost governance | `/finops` | Spend by service and region with the platform's unit prices |
| Operations dashboard | `/ops` | Summary of alerts, runs and health |
| Incident knowledge base | `/incidents` | Incidents grouped by failure signature, with handling notes and AI diagnosis |
| Execution environments | `/exec-envs` | Status of every region, probe results, redeploy and decommission actions |
| Audit log | `/audit` | Every write operation: who, when, which object, which region |
| System settings | `/settings` | AI model, platform version, AI wiring health, external table buckets, data-source network objects |

Every page has a "how to use this page" help entry in the top-right corner.

### 1.2 Routine checklist

Daily:

- Open the task monitor and filter for failed or timed-out runs since the previous day. Open the run log from the row before touching the job.
- Open the alert centre and clear or acknowledge events; confirm that channels still pass a test delivery.
- Glance at the execution environments page: every region should be `active` with a green probe.

Weekly:

- Review the cost governance page against Cost Explorer; look for warehouses kept awake by dashboards and for stream jobs that nobody uses.
- Check **System settings → Data source network objects** for orphaned platform-managed security groups or connections.
- Review the audit log for administrative actions (user resets, project membership changes, environment changes).

After any deployment:

- Run `./scripts/02-postdeploy-truth.sh <profile> <home-region>` and compare `GET /api/public/version` with the intended tag.

## 2. Finding facts in a deployed account

Set two shell variables once:

```bash
P=<profile>; R=<home-region>
```

### 2.1 Which region is the home region

The platform stack exists only in the home region.

```bash
for r in $(aws --profile $P ec2 describe-regions --query "Regions[].RegionName" --output text); do
  aws --profile $P --region $r cloudformation describe-stacks --stack-name BgpPlatformStack \
    --query "Stacks[0].StackName" --output text 2>/dev/null && echo "home region = $r"
done
```

### 2.2 Stacks and outputs

```bash
aws --profile $P --region $R cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query "StackSummaries[?starts_with(StackName,'Bgp')].StackName"
aws --profile $P --region $R cloudformation describe-stacks --stack-name BgpPlatformStack \
  --query "Stacks[0].Outputs"
```

`BgpPlatformStack` outputs include the platform URL; `BgpOmServiceStack` outputs include the OpenMetadata URL; `BgpAuthStack` outputs include the user pool id.

### 2.3 Deploy mode and wiring

```bash
aws --profile $P --region $R ssm get-parameters-by-path --path /bgp/ --recursive
```

`/bgp/deploy-mode` tells you whether the environment is `production` or `demo`.
`/bgp/wiring/*` holds the OpenMetadata URL, the agent runtime ARNs and memory ids.
`/bgp/wiring/execution-region-candidates` lists pre-authorised regions.

### 2.4 Execution environments

```bash
aws --profile $P --region $R dynamodb scan --table-name bgp-execution-envs \
  --projection-expression "targetId,#r,#s,components" \
  --expression-attribute-names '{"#r":"region","#s":"status"}'
```

The home target is `tgt_home`. Status `active` means the region accepts work; `draining`, `decommissioning` and `deleted` are the decommission states.

### 2.5 Platform runtime configuration

```bash
TD=$(aws --profile $P --region $R ecs describe-services --cluster bgp-cluster --services bgp-platform \
  --query 'services[0].taskDefinition' --output text)
aws --profile $P --region $R ecs describe-task-definition --task-definition "$TD" \
  --query 'taskDefinition.containerDefinitions[0].environment'
```

The meaning of each variable is in [deployment.md](deployment.md) section 9. `BGP_DATAPLANE_CREDS` should read `taskrole` in production.

### 2.6 Running version

```bash
curl -s https://<platform-host>/api/public/version
```

The same facts appear in the login page footer and under **System settings → Platform version**.
For the three agent runtimes, `./scripts/redeploy-agents.sh <profile> <home-region> --check` prints the image tag each runtime is using and whether it differs from the checked-out code; it changes nothing.

### 2.7 Execution-environment deployer

```bash
aws --profile $P --region $R lambda get-function-configuration --function-name bgp-exec-env-broker
aws --profile $P --region $R codebuild batch-get-projects --names bgp-exec-env-deploy \
  --query 'projects[0].environment.environmentVariables'
aws --profile $P --region $R codebuild list-builds-for-project --project-name bgp-exec-env-deploy
```

### 2.8 OpenMetadata database

```bash
aws --profile $P --region $R rds describe-db-instances --db-instance-identifier bgp-openmetadata-db \
  --query "DBInstances[0].[EngineVersion,DBInstanceStatus]"
```

### 2.9 Residual resources after a decommission

S3 buckets are global; the other commands are per region.

```bash
aws --profile $P s3api list-buckets --query "Buckets[?starts_with(Name,'bgp-')].Name"
aws --profile $P --region <region> s3tables list-table-buckets
aws --profile $P --region <region> redshift-serverless list-snapshots
aws --profile $P --region <region> kms list-aliases --query "Aliases[?starts_with(AliasName,'alias/bgp-')]"
```

## 3. Logs and diagnostics

| Source | Where to look | Notes |
|---|---|---|
| Platform application | CloudWatch log group prefixed `BgpPlatformStack-BgpServiceTaskDef` | One stream per ECS task; API errors and long-operation progress |
| OpenMetadata service | CloudWatch log group of `BgpOmServiceStack`, stream prefix `openmetadata` | One-week retention |
| Sync jobs | Glue job runs in the execution region | Run id is shown in the task monitor and the sync task detail page |
| Scheduled runs | MWAA Serverless workflow runs in the execution region | Run records are mirrored into the task monitor |
| Spark jobs | EMR Serverless job runs; logs in the EMR log bucket | Run history is in the offline compute page |
| Stream jobs | Managed Flink application in the execution region | Status also on the real-time compute page |
| Real-time integration | DMS replication task status in the execution region | Reconciled into the sync list and detail page |
| Execution-environment builds | CodeBuild project `bgp-exec-env-deploy` | Preview builds exit non-zero by design when approval is required |
| Account audit | CloudTrail trail and VPC flow logs from the audit stack | Flow logs kept one month |
| Platform audit | Table `bgp-audit`, page `/audit` | Every write operation with user, time, object and region |
| IAM coverage | `python3 scripts/iam-simulate-gate.py --profile <profile> --home-region <home-region> --regions <r1,r2>` | Offline, read-only, three-state exit code |

Find the platform log group:

```bash
aws --profile $P --region $R logs describe-log-groups --log-group-name-prefix BgpPlatformStack \
  --query 'logGroups[].logGroupName'
```

### 3.1 Run diagnosis with the DevOps agent

Failed runs and Flink jobs can be sent to **Diagnose** from the task monitor and the real-time compute page.
The platform discovers or creates an AWS DevOps Agent space named `bgp-devops-agent`, opens a session, submits the evidence and polls for the investigation result every few seconds.
The result is attached to the run and to the matching incident signature in the knowledge base.

### 3.2 IAM simulation gate exit codes

| Exit code | Meaning |
|---|---|
| 0 | Every recorded platform call is allowed in every listed region |
| 1 | At least one call is denied; the output names action and resource |
| 2 | The gate itself could not run (permissions or environment) |
| 4 | No denial, but some rows could not be evaluated in this account; not a pass |

## 4. Troubleshooting runbook

| Symptom | Likely cause | Action |
|---|---|---|
| Script created resources in the wrong region or account | Positional arguments omitted; silent defaults | Always pass `<profile>` and `<home-region>` [1] |
| `VpcLimitExceeded` on the first stack | VPC quota exhausted in that region | Raise the quota; do not import a VPC in production |
| Install fails late with `AccessDeniedException` on `cognito-idp` | Administrative Cognito writes denied | Rerun `10-bootstrap-cognito.sh`; the Lambda fallback is used [2] |
| OpenMetadata page errors, agents fall back to in-process | Platform stack deployed with bare `cdk deploy` | Run `redeploy-platform.sh`; check truth check item 7 |
| An agent runtime disappeared | Agent stack deployed with bare `cdk deploy` | Run `redeploy-agents.sh` |
| Agents behave like the previous version after an upgrade | Only the platform was redeployed | Run `redeploy-agents.sh --check`, then without `--check` |
| `CATALOG_NOT_FOUND: s3tablescatalog/...` in lake queries | Federated catalog not opened in that region | Run `redeploy-platform.sh`; truth check item 10 |
| `ExpiredTokenException` during a script | Credentials expired | Refresh and rerun; scripts stop before changing anything |
| `BgpPlatformStack` rolled back with "Uploaded file must be a non-empty zip" | Corrupt CDK asset in the bootstrap bucket | Delete the failed stack and rerun; current scripts pre-upload healthy assets [3] |
| New environment wizard reports `Function not found: ...bgp-exec-env-broker` | Deployer stack missing | Run `redeploy-platform.sh`; it deploys the deployer stack |
| Probe rows red with access denied after a region build | Control plane has not authorised the region | Run `redeploy-platform.sh`, then **Check initialization** [4] |
| Redeploy preview says "source drifted, approval required" | Normal after a control-plane upgrade | Approve the plan |
| Build log shows `ChangeSet ... does not exist` after a preview | Harmless confirmation read after cleanup | None |
| Exec-env build fails at `cdk bootstrap` with a default-model geography message | CodeBuild project runs an older source package | Redeploy the control plane; current builds bootstrap with `--app ''` [5] |
| IAM gate prints `env-blocked` | Rows blocked by organisation policy or no probe region | Record it; rerun in an account without the restriction |
| Platform returns 503 on every page | Cognito not configured | Check `BgpAuthStack` outputs and the task definition |
| Non-administrator gets 403 in natural-language query | User is not a member of the project | Add the user in **Project space** |
| Sole administrator locked out | No other administrator can reset | Account owner runs the Cognito reset command [6] |
| Sync run fails with `SYNC_REFUSED_CLEAR_FOREIGN_TABLE` | Target table exists and was not created by the platform | Confirm overwrite per table in the wizard, or change the target |
| Sync run refused: merge keys missing | Write mode `merge` without keys | Add merge keys in the wizard |
| Glue run reports `Security Group Not Found` | A platform-managed `bgp-ds-*` group was deleted externally | The platform rebuilds it on next use; review network objects [7] |
| Spark job fails with "unrecognized arguments" | Strict `argparse` in a user script | Use `parse_known_args()` or read `sys.argv` by name [8] |
| Delete data source returns 409 `DATASOURCE_IN_USE` | Sync or real-time tasks still reference it | Remove or repoint the listed tasks first |
| Action returns 409 "operation in progress" | Another long operation holds the object | Wait for it to finish; check the toast in the lower right |
| UI shows "running in background" toast for a long time | Warehouse cold start or model latency | Wait; do not click again [9] |
| Automation receives 202 with `protocol: "long-op/1"` | Long-operation protocol | Poll `GET /api/long-ops/<taskId>` until terminal |
| Real-time task start takes many minutes the first time | Replication instance created lazily per region | Wait; a second click returns 409 `START_IN_PROGRESS` |
| Flink job errors immediately on start | Runner JARs missing from the scripts bucket | Install Maven and rerun `deploy-all.sh` [10] |
| Model probe reports "not available for this account" | Model not enabled at account level | Ask the AWS account team; choose another model meanwhile |
| OpenMetadata unavailable for about two minutes during upgrade | Database engine upgrade step | Expected; do not interrupt the script |
| `git fetch` refuses to update a tag | Tag moved on the remote | `git fetch --tags --force` |
| Decommission stalls | Dependency ordering in the target region | **Retry destruction** on the detail page |
| Delete project returns 400 listing resources | Project still owns objects | Release the listed objects first |
| Delete project returns 503 | Credential revocation could not be queued | Retry |

Notes:

1. The scripts default to profile `temp-account` and region `us-east-1` when arguments are missing.
   They also align `AWS_REGION`, `AWS_DEFAULT_REGION` and `CDK_DEFAULT_REGION` with the home region and refuse to synthesise when they differ.
2. `BgpAuthStack` includes a bootstrap Lambda `bgp-cognito-bootstrap` whose roster is fixed by CDK.
   It refuses to change the password of a confirmed user and only accepts the roster's user names, so it cannot be used to create extra administrators.
3. Current `deploy-all.sh` reads the CDK asset manifest and uploads healthy archives before CDK does, so the symptom only appears with older scripts.
   Delete the `ROLLBACK_COMPLETE` stack with `cloudformation delete-stack`, wait for completion, then rerun.
4. IAM region conditions are baked in at synthesis time. The allow-list is home region plus every non-deleted environment plus the candidate list from SSM.
   Pre-authorise with `EXEC_REGION_CANDIDATES` to avoid this step.
5. The execution-environment build runs `cdk bootstrap --app ''` so that no application code (and therefore no control-plane guard) executes.
   Older source packages ran the application during bootstrap and tripped the default-model geography guard when the home region was outside the United States.
   Redeploying the control plane refreshes the source package.
6. The command is in [deployment.md](deployment.md) section 4.4.
7. Platform-owned objects (security groups, Glue connections, platform-chosen subnets) carry `bgp:managed`, `bgp:datasourceId` and `bgp:targetId` tags.
   They are rebuilt at the moment of use, and the rebuild is written to the audit log and the alert centre. Objects you supplied are only reported.
   **System settings → Data source network objects** lists orphans and offers one-click cleanup.
   Never delete a `bgp-*` cloud object before checking whether a data source still references it.
8. The platform appends business-date parameters (`--ds`, `--ds_nodash`, `--yesterday_ds`, `--bizdate` and others) after the script's own arguments for Glue and EMR jobs.
9. Requests that wait on an external system (warehouse DDL, model calls, environment builds) answer synchronously when they finish within the configured wait, otherwise they return 202 and the browser polls.
   Clicking again is refused with 409 while the first operation runs.
10. Runner JARs are built with Maven during `deploy-all.sh` and uploaded to `s3://bgp-glue-scripts-<account-id>/flink/`.
    Without Maven the install exits 0 but the JARs are absent. The upload step is idempotent, so rerunning the installer after installing Maven is safe.

## 5. What keeps billing

The detailed model with measured figures is in [cost-model.md](cost-model.md). In short:

- Home region, always on: platform and OpenMetadata containers, the OpenMetadata database and search domain, two NAT gateways, two load balancers, the cross-region DynamoDB interface endpoint, WAF, customer-managed keys and secrets.
- Each execution region, always on: the interface endpoints that make zero-egress networking possible, one customer-managed key and a few secrets.
  Warehouse, scheduler, lake and compute bill nothing while idle.
- Per execution region once real-time features are used: a provisioned stream shard, and a DMS replication instance that is created on the first real-time task and then stays.
- Usage-driven: warehouse active time, Spark jobs, Glue jobs, scheduler task time, model tokens, storage and logs. A continuously running Flink job is the largest fixed per-job item.
- After a decommission: data buckets, table bucket, warehouse namespace and workgroup with final snapshot, the regional key and the DAG bucket are retained and keep billing until removed by you.

Watch the cost governance page (`/finops`) for the platform's view and Cost Explorer for the account's view.

## 6. Backup and retention behaviour

| Resource | Policy |
|---|---|
| DynamoDB tables | Retained on stack deletion; point-in-time recovery enabled |
| OpenMetadata database | Multi-AZ, 30-day automated backups, deletion protection, retained on stack deletion |
| Customer-managed keys (home and per region) | Retained with a deletion waiting period; aliases retained |
| Home data lake, scripts and DAG buckets | Retained on stack deletion |
| Home S3 Tables table bucket and Athena workgroup | Retained on stack deletion |
| Execution-region buckets and table bucket | Retained, never auto-emptied |
| Execution-region warehouse namespace and workgroup | Retained; a final snapshot is taken at decommission |
| CloudTrail bucket and search domain | Retained on stack deletion |
| Long-operation records (`bgp-long-ops`) | Expire automatically after seven days |
| OpenMetadata container logs | One week |
| VPC flow logs | One month |

Behaviour to keep in mind:

- Decommissioning an execution region deletes compute, networking and roles but leaves every data-bearing resource in place (see the list in [deployment.md](deployment.md) section 8.3).
  Removing them is a manual, deliberate action.
- A relational database engine upgrade performed during a platform upgrade takes an automatic pre-upgrade snapshot. Engine downgrades are not supported; code rollback leaves the engine as is.
- Deleting a project does not drop its warehouse schema (`proj_*`).
- Scheduler artefacts and Glue scripts are generated when workflows are published or sync tasks are saved. They are regenerated by publishing or saving again; they are not backed up separately.
- Residues can be listed with the read-only commands in section 2.9.
