# Cost Model

This page answers three questions: what an idle control plane costs, what an idle execution region costs, and what running workloads cost at three sizes.
It also lists the levers that reduce the bill and what the model leaves out.

Scope and method:

- All amounts are **USD per month** (730 hours) at `us-east-1` on-demand public prices, with no discounts (no Savings Plans, no enterprise agreement).
- Unit prices were read from the AWS Pricing API on 2026-10-23. Re-check them with the AWS Pricing Calculator before quoting.
- Idle figures were reconciled line by line against the Cost Explorer bill of a production-mode test account (one home region plus one execution region) left untouched for two full days, 2026-10-20 and 2026-10-21.
- Workload unit costs were cross-checked against two demonstration-mode test accounts that ran acceptance workloads from 2026-10-19 to 2026-10-23.
- Other regions are typically 10 to 30 percent more expensive than `us-east-1` for Fargate, interface endpoints and Redshift RPU hours.

## 1. Summary

| Shape | Monthly cost | Notes |
|---|---|---|
| Idle home region, baseline | about $460 | Platform, OpenMetadata (containers, database, search), NAT and ALB pairs, WAF, keys, secrets |
| Idle home region plus database extended-support fee | about $750 | Only when the OpenMetadata database engine is on a version outside standard support; adds $292 |
| Idle home region plus extended support plus second CloudTrail trail | about $820 (measured $822) | Only when the account already has another trail; adds about $68 |
| Idle execution region | about $165 (measured $180) | Almost entirely the 11 interface endpoints across 2 AZs ($161); warehouse, scheduler and lake idle at $0 |
| Demonstration mode extra | about +$320 | Demonstration source database (Multi-AZ, including extended support); absent in production mode |
| Real-time features enabled, per region | +$11 standing, +$27 after the first real-time task | One provisioned stream shard; a DMS replication instance created on first use and kept |
| Running workloads, per execution region | small about $140, medium about $2,100, large about $22,500 | Tier definitions in section 6; model usage is extra |

In one sentence: the smallest production shape (one home region plus one execution region) costs about $620 to $990 per month idle, each additional idle execution region adds about $165, and workload cost is fully usage-driven.
The largest usage items, in order, are warehouse active time (Redshift Serverless at $3 per active hour), Spark jobs (EMR Serverless), sync jobs (Glue), continuously running Flink jobs (about $170 per job per month) and model tokens.

## 2. Standing resources

These come from the CDK stack definitions, not from estimates.

| Region | Resource | Specification |
|---|---|---|
| Home | Platform containers | Fargate 0.5 vCPU / 1 GB x 2 tasks, auto-scales to 6 |
| Home | OpenMetadata container | Fargate 2 vCPU / 4 GB x 1 |
| Home | OpenMetadata database | RDS db.t3.small Multi-AZ, 20 GB gp2, 30-day backups |
| Home | OpenMetadata search | 2 data nodes t3.small.search, 3 dedicated master nodes t3.small.search, 20 GB EBS x 2 |
| Home | VPC | 2 AZs, 2 NAT gateways, S3 gateway endpoint, 1 DynamoDB interface endpoint (2 AZs) |
| Home | Load balancing and edge | 2 ALBs, 2 CloudFront distributions, 2 WAF web ACLs with 8 rules in total |
| Home | Public IPv4 | 6 addresses (2 NAT, 2 x 2 ALB) |
| Home | Keys and secrets | 2 customer-managed keys, about 5 secrets |
| Home | Redshift Serverless | Base 8 RPU, no compute charge while idle |
| Home | DynamoDB | All tables on-demand |
| Home | CloudTrail and flow logs | 1 multi-region management trail with S3 bucket, VPC flow logs to CloudWatch Logs |
| Home | Usage-billed services | MWAA Serverless, 3 AgentCore runtimes, CodeBuild, Lambda, Cognito, ECR |
| Execution | VPC, zero egress | 2 AZs, no NAT, 11 interface endpoints, S3 and DynamoDB gateway endpoints |
| Execution | Keys, secrets, DNS | 1 customer-managed key, about 2 secrets, 1 private hosted zone for the home link |
| Execution | Usage-billed services | Redshift Serverless base 8 RPU, MWAA Serverless, S3 Tables bucket, Glue, EMR Serverless |
| Execution, real-time enabled | Stream and replication | 1 provisioned stream shard, Flink applications (billed while running), DMS replication instance after first use |

The 11 execution-region interface endpoints are: sts, logs, monitoring, kms, secretsmanager, glue, emr-serverless, redshift-data, s3tables, redshift-serverless and airflow-serverless.

## 3. Idle home region

| # | Item | Specification and unit price | Monthly | Measured per day |
|---|---|---|---|---|
| 1 | Search nodes | 5 x t3.small.search at $0.036 per node-hour | $131.4 | $4.32 |
| 2 | OpenMetadata container | 2 vCPU / 4 GB at $0.04048 per vCPU-hour plus $0.004445 per GB-hour | $72.1 | $2.37 |
| 3 | NAT gateways | 2 at $0.045 per hour each, plus $0.045 per GB processed | $65.7 | $2.16 |
| 4 | OpenMetadata database | db.t3.small Multi-AZ at $0.068 per hour | $49.6 | $1.63 |
| 5 | Platform containers | 0.5 vCPU / 1 GB x 2, same Fargate rates | $36.0 | $1.18 |
| 6 | Load balancers | 2 at $0.0225 per hour each, plus LCU at $0.008 per LCU-hour | $32.9 | $1.08 |
| 7 | Public IPv4 | 6 at $0.005 per IP-hour | $21.9 | $0.72 |
| 8 | WAF | 2 web ACLs at $5 plus 8 rules at $1, plus $0.60 per million requests | $18.0 | $0.58 |
| 9 | DynamoDB interface endpoint | 1 endpoint, 2 AZs at $0.01 per AZ-hour | $14.6 | $0.48 |
| 10 | Search EBS | gp2 20 GB x 2 at $0.135 per GB-month | $5.4 | $0.18 |
| 11 | Database storage | gp2 20 GB Multi-AZ at $0.23 per GB-month | $4.6 | $0.15 |
| 12 | Customer-managed keys | 2 at $1 per month, plus $0.03 per 10,000 requests | $2.0 | $0.07 |
| 13 | Secrets Manager | about 5 at $0.40 per month | $2.0 | $0.07 |
| 14 | VPC flow logs | about 0.08 GB per day at $0.50 per GB | about $1.5 | $0.04 |
| 15 | Cognito | Essentials at $0.015 per monthly active user | under $1 | $0.07 (9 users) |
| 16 | Redshift Serverless | base 8 RPU at $0.375 per RPU-hour; idle $0; storage $0.024 per GB-month | $0 | $0 |
| 17 | DynamoDB | on-demand; storage $0.25 per GB-month after the first 25 GB | about $0 | under $0.05 |
| 18 | CloudFront | within the free allowance of 1 TB and 10 million requests | about $0 | $0.05 |
| 19 | MWAA Serverless, AgentCore, CodeBuild, Lambda, Glue, EMR, ECR | usage-billed | $0 | $0 |
| | **Baseline subtotal** | | **about $458** | **$15.1** |
| 20 | Database extended-support fee | Multi-AZ 4 vCPU at $0.10 per vCPU-hour; only for an engine outside standard support | $292 | $9.60 |
| 21 | CloudTrail paid management events | about 110,000 events per day at $2 per 100,000; only as a second trail | $68 | $2.23 |
| | **Total with #20 and #21** | | **about $818** | **$27.0 (measured $27.04)** |

The repository pins a database engine within standard support, so line 20 does not apply to a fresh install. It appears only on environments whose engine has been left on a retired version.

## 4. Idle execution region

| # | Item | Specification and unit price | Monthly | Measured per day |
|---|---|---|---|---|
| 1 | Interface endpoints | 11 x 2 AZs at $0.01 per AZ-hour, plus $0.01 per GB processed | $160.6 | $5.28 |
| 2 | Customer-managed key | 1 at $1 per month | $1.0 | $0.03 |
| 3 | Secrets Manager | about 2 (includes the warehouse administrator) at $0.40 | $0.8 | $0.03 |
| 4 | Private hosted zone | 1 at $0.50 per month; absent when the region equals the home region | $0.5 | — |
| 5 | Redshift Serverless | base 8 RPU at $0.375 per RPU-hour; idle $0; RMS storage $0.024 per GB-month | $0 | $0 |
| 6 | MWAA Serverless | $0.08 per task-hour, only while tasks run | $0 | $0 |
| 7 | S3 Tables bucket | $0.0265 per GB-month plus maintenance | about $0 | $0 |
| 8 | Glue, EMR Serverless, Flink, CloudWatch Logs | usage-billed | $0 | $0 |
| | **Baseline subtotal** | | **about $163** | **$5.3** |
| 9 | CloudTrail paid events (same condition as home #21) | about 20,000 events per day at $2 per 100,000 | $12 | $0.39 |
| 10 | Real-time enabled: stream shard | 1 provisioned shard at $0.015 per shard-hour | $11 | — |
| 11 | After first real-time task: DMS instance | dms.t3.small single-AZ, 20 GB at $0.0372 per hour | $27 | — |
| | **Total with #9, real-time off** | | **about $175 (measured $180)** | |

The measured $180 includes a small amount of test residue. The interface endpoints are the price of zero-egress networking and cannot be removed.

## 5. Unit prices per task

| Task type | Platform default capacity | Unit price | Typical single run |
|---|---|---|---|
| Data sync (Glue job) | G.1X x 2 workers = 2 DPU | $0.44 per DPU-hour, per second, 1-minute minimum | 5 minutes on a small table about $0.07; 10 minutes about $0.15 |
| Offline compute (EMR Serverless Spark) | driver and executors as configured (x86) | $0.0526 per vCPU-hour plus $0.0058 per GB-hour; ARM about 20 percent cheaper | 10 vCPU / 40 GB for 10 minutes about $0.13 |
| Warehouse query (Redshift Serverless) | base 8 RPU | $0.375 per RPU-hour = $3.00 per active hour; 60-second minimum per wake-up | one dashboard refresh (30 s) about $0.05; one hour of queries $3 |
| Orchestration (MWAA Serverless) | — | $0.08 per task-hour of actual run time | 10 tasks x 5 minutes about $0.07 |
| Stream job (Managed Flink) | parallelism 1 = 2 KPU | $0.11 per KPU-hour plus 50 GB per KPU of running storage at $0.10 per GB-month | about $170 per month per continuously running job |
| Real-time replication (DMS) | dms.t3.small | $0.0372 per hour | $27 per month, one instance per region shared by all tasks |
| Natural-language query, Copilot, advisors (Bedrock, Kimi family) | output tokens scaled x2.1 for reasoning blocks | input $3.30 per million tokens, output $16.50 per million, cache read $0.165 | one question about 8k input + 2k output about $0.06 |
| Same, Claude Opus family (factory default) | — | input $5 per million tokens, output $25 per million | one question about 8k + 1k about $0.065 |
| Agent runtime (AgentCore) | — | $0.0895 per vCPU-hour plus $0.00945 per GB-hour, active time only | one question about $0.002 |
| New execution region (CodeBuild) | Linux small | $0.005 per minute | one build about 40 minutes about $0.20, one-off |
| Lake storage (S3 Tables) | — | $0.0265 per GB-month plus compaction $0.05 per GB plus monitoring $0.025 per 1,000 objects-month | 1 TB about $27 per month plus maintenance |
| Warehouse storage (Redshift RMS) | — | $0.024 per GB-month | 1 TB about $24.6 per month |
| Audit and metadata writes (DynamoDB on-demand) | — | write $0.625 per million WRU, read $0.125 per million RRU | 100,000 operations per day about $2 per month |
| Logs (CloudWatch Logs) | — | $0.50 per GB ingested plus $0.03 per GB-month | 1 GB per day about $16 per month |

Measured anchors from the demonstration accounts:

- Sync acceptance runs: 21 DPU-hours in total ($9.3).
- Spark runs: 17 vCPU-hours plus 76 GB-hours ($1.1).
- Orchestration: 13.7 task-hours ($1.1).
- Flink: 163 KPU-hours per region over 3.4 days ($18), consistent with 2 KPU standing.
- AgentCore: $0.4 in total.

The warehouse is active whenever anything queries it; platform health probes do not wake it, but dashboards and natural-language queries do. Cold-start recovery time is billed as active time.

## 6. Three workload tiers per execution region

Tier definitions:

| Dimension | Small (department pilot) | Medium (one business domain) | Large (whole company) |
|---|---|---|---|
| Sync runs | 10 per day, 2 DPU x 5 min | 100 per day, 2 DPU x 10 min | 1,000 per day, 3 DPU x 10 min on average |
| Spark jobs | 5 per day, 10 vCPU / 40 GB x 10 min | 30 per day, 20 vCPU / 80 GB x 20 min | 200 per day, 40 vCPU / 160 GB x 30 min |
| Orchestration | 50 task-minutes per day | 500 task-minutes per day | 5,000 task-minutes per day |
| Warehouse active | 1 hour per day at 8 RPU | 8 hours per day at 8 RPU | 24 hours per day at 16 RPU on average |
| Continuous stream jobs | 0 | 2 (plus stream shard and DMS) | 10 (plus stream shard and DMS) |
| Data volume | 100 GB lake + 100 GB warehouse | 1 TB + 1 TB | 10 TB + 10 TB |
| Model questions (whole account, Kimi family) | 50 per day | 300 per day | 2,000 per day |

Estimates:

| Item | Small | Medium | Large | Formula |
|---|---|---|---|---|
| Sync (Glue) | $22 | $440 | $6,600 | runs x DPU x hours x $0.44 x 30 |
| Offline (EMR Serverless) | $19 | $455 | $9,100 | runs x (vCPU x $0.0526 + GB x $0.0058) x hours x 30 |
| Orchestration (MWAA Serverless) | $2 | $20 | $200 | task-hours x $0.08 x 30 |
| **Warehouse (Redshift Serverless)** | **$90** | **$720** | **$4,320** | RPU x active hours x $0.375 x 30 |
| Stream (Flink + shard + DMS) | $0 | $378 | $1,738 | jobs x $170 + $11 + $27 |
| Storage (S3 Tables + RMS) | $5 | $52 | $517 | GB x ($0.0265 + $0.024) |
| Logs, audit, endpoint traffic | about $3 | about $30 | about $150 | linear in job count |
| **Workload subtotal per region** | **about $140** | **about $2,100** | **about $22,600** | |
| Idle baseline per region | $165 | $165 | $165 | section 4 |
| **Total per execution region** | **about $305** | **about $2,265** | **about $22,800** | |
| Model questions (whole account, billed in the home region) | $90 | $540 | $3,600 | questions x $0.06 x 30 |

Whole-platform examples, with the home region at its $458 baseline (no extended-support fee, no second trail):

| Shape | Monthly cost |
|---|---|
| 1 home + 1 execution region, idle | about $620 |
| 1 home + 1 execution region, small workload | about $850 |
| 1 home + 2 execution regions, medium workload in each | about $5,500 |
| 1 home + 3 execution regions, large workload in each | about $72,500 |

Workload cost scales linearly with workload: ten times the jobs cost about ten times as much.
Warehouse active hours and Spark job size set the ceiling. From the medium tier upward the idle baseline is under 10 percent of the bill.

## 7. Optimisation levers

| # | Lever | Current monthly cost | Change and saving | Trade-off |
|---|---|---|---|---|
| 1 | Database extended-support fee | $292 (doubles after two years) | Keep the OpenMetadata database engine on a standard-support version; saves $292 | Short OpenMetadata outage during the engine upgrade; no engine downgrade |
| 2 | Search domain with 5 nodes | $131 | Drop the 3 dedicated master nodes, keep 2 data nodes; saves $79 | Loses split-brain protection and election stability |
| 3 | Two NAT gateways | $66 | Single NAT gateway; saves $33 | Single point of failure across AZs |
| 4 | Second CloudTrail trail | $68 plus $12 per execution region | Install with `SKIP_CLOUDTRAIL=1` when the account already has a trail; saves $80 and up | Audit evidence depends on the existing trail |
| 5 | Warehouse woken by dashboards | $3 per active hour | Concentrate dashboard refreshes into fixed windows; lengthen card refresh intervals | none |
| 6 | Flink minimum of 2 KPU per job | $170 per job | Combine several streams into one job; saves $170 per job removed | Less isolation between streams |
| 7 | Execution-region interface endpoints | $161 per region | Not removable: zero-egress networking is a design rule | — |

The repository already pins a standard-support database engine; the upgrade script applies the engine change in place, with about two minutes of lost database connection in rehearsals.

## 8. Not included and uncertain

- Data transfer out of the platform: NAT at $0.045 per GB, cross-region at $0.02 per GB, CloudFront at $0.085 per GB beyond 1 TB.
  The platform's own traffic is small; the total depends on user downloads and exports.
- Your own source databases (RDS, MSK, self-managed databases) are outside this model.
- Regional price factors: everything above is `us-east-1`; apply the AWS price list for other regions.
- Redshift Serverless activity is query-driven. Health probes do not wake the warehouse; users opening dashboards or asking questions do.
- Model prices are the Bedrock standard tier (not batch, not flex).
  The Kimi family emits reasoning blocks that roughly double output tokens;
  the "about $0.06 per question" figure already includes that.
- Unit prices are public prices as read on 2026-10-23.

## 9. Sources

- Standing specifications: `infra/lib/*.ts` and `infra/lib/exec-env/*.ts`.
- Unit prices: `aws pricing get-products` for `us-east-1`, read on 2026-10-23; the platform's own price table in `platform/src/lib/finops/pricing.ts` agrees on Glue ($0.44) and Redshift ($0.375).
- Measurements: `aws ce get-cost-and-usage` split by service and usage type and by region and service, for 2026-10-20 to 2026-10-21 (production-mode account) and 2026-10-19 to 2026-10-23 (demonstration-mode accounts).
