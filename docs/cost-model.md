# Kingfisher Platform Cost Model (v1.1, 2026-10-26; v1.0 created 2026-10-23)

> v1.1 (2026-10-26): item 1 of §7, "upgrade the OpenMetadata database to MySQL 8.4", has been implemented
> (merged into the development branch on 2026-10-26 and pending release at the time of writing; it shipped in the release of 2026-10-27).
> Measured in a test account: 8.0.46 → 8.4.11, the database-stack step took 9.5 minutes and OpenMetadata lost its database connection for about 2 minutes.
> No other figure has been recomputed.

> This document answers three questions: **what an idle home region costs, what each idle execution region costs, and roughly what running workloads cost by workload size**.
> All amounts are **USD per month** (730 hours) at **`us-east-1` on-demand public prices**, with no discounts of any kind (no Savings Plans, no enterprise agreement).
> Unit prices come from the AWS Pricing API (read on 2026-10-23); measurements come from the Cost Explorer bills of three test accounts (broken down by usage type to the hour or to the event count).
> Measurement anchor: **production mode, 1 home region + 1 execution region, two full days without any human activity** (2026-10-20 / 21) — the bill matches this model item by item (see the "Measured" columns in §3 / §4).

---

## 0. Summary

| Shape | Monthly cost (us-east-1) | Notes |
|---|---|---|
| **Idle home region (baseline)** | **≈ $460** | Mandatory standing components: platform + OpenMetadata (containers / RDS / OpenSearch) + networking (NAT × 2 / ALB × 2) + security (WAF / KMS / secrets) |
| Idle home region + RDS extended-support fee | ≈ $750 | OpenMetadata's RDS **MySQL 8.0** has been charged "Extended Support" by AWS since 2026-08-01 at $0.10 per vCPU-hour; Multi-AZ 4 vCPU ⇒ **+$292 / month**; upgrading to MySQL 8.4 removes it (§7 item 1) |
| Idle home region + extended support + second CloudTrail trail | ≈ $820 (measured $822) | When the account **already has** another CloudTrail trail, the platform's own multi-region trail is the second one and management events are billed at $2 per 100,000 events; an idle platform produces about 110,000 events per day ⇒ +$68 / month |
| **Each idle execution region** | **≈ $165 (measured $180)** | Almost entirely the **11 VPC interface endpoints × 2 AZs = $161** that zero-egress networking requires; warehouse / scheduler / data lake cost **$0** while idle |
| Demo-mode extra | +≈ $320 | Demonstration source database RDS MySQL db.t3.micro Multi-AZ (including $292 of extended support). **Absent in production mode** |
| Real-time compute enabled (per region) | +$11 standing, +$27 after the first real-time sync | Kinesis source stream with 1 shard, $11 / month; the DMS replication instance dms.t3.small is created lazily when the first real-time sync task is set up and then stays at $27 / month |
| **Running workloads (per execution region)** | small ≈ $140 · medium ≈ $2,100 · large ≈ $22,500 | Tier definitions and formulas in §6; model Q&A is extra (small $90 · medium $540 · large $3,600 per month, at Kimi K3 prices) |

**In one sentence**: the smallest production shape (1 home region + 1 execution region) costs **≈ $620–990 per month** idle (depending on whether the extended-support fee and the second CloudTrail trail are eliminated);
every additional idle execution region adds **+≈ $165 per month**; workload cost is entirely usage-driven and zero when idle, and the largest items are, in order,
**warehouse active time (Redshift Serverless at $3 per hour), Spark jobs (EMR Serverless), sync jobs (Glue), continuously running stream jobs (Flink, ≈ $170 per job per month) and model tokens**.

---

## 1. Basis

| Item | Basis |
|---|---|
| Region | `us-east-1` on-demand prices. Other regions add **+10% to +30%** on top (Fargate / interface endpoints / Redshift RPU are generally more expensive in Asia-Pacific and South America regions; the AWS pricing pages are authoritative) |
| Month | 730 hours |
| Deployment shape | Production mode (`BGP_DEPLOY_MODE=production`), a complete execution environment in every region, no component trimming (a non-negotiable rule, see [AGENTS.md §3](../AGENTS.md#3-non-negotiable-rules)) |
| Not included | Data egress traffic (internet / cross-region), customer-owned source databases, customer-owned MSK, Support plans, taxes |
| Measured accounts | Test account A: production mode, home region us-east-1 + execution region us-west-2, two full days without human activity on 2026-10-20 / 21; test accounts B / C: demo mode with two / three regions, running acceptance workloads continuously from 10-19 to 10-23 (used as the workload yardstick) |
| Excluded | Items that belong to the test accounts and are unrelated to the platform: a desktop EC2 m6i.xlarge, its EBS volumes, GuardDuty |

---

## 2. Standing resource inventory (from the CDK stack definitions, not estimated)

Engine and image versions named below are listed with their code locations in [Supported versions](supported-versions.md).

| Region | Resource | Specification (code location) |
|---|---|---|
| Home | Platform ECS Fargate | 0.5 vCPU / 1 GB × **2 tasks** (auto-scales to 6; `infra/lib/platform-stack.ts`) |
| Home | OpenMetadata ECS Fargate | 2 vCPU / 4 GB × 1 (`om-service-stack.ts`) |
| Home | OpenMetadata RDS MySQL 8.0 (8.4 from the 2026-10-27 release onward, see §7 item 1) | db.t3.small **Multi-AZ**, 20 GB gp2, 30-day backups (`om-database-stack.ts`) |
| Home | OpenMetadata OpenSearch 2.11 | data nodes t3.small.search × 2 + dedicated master nodes t3.small.search × 3, EBS 20 GB × 2 (`om-search-stack.ts`) |
| Home | VPC | 2 AZs, **NAT gateways × 2**, S3 gateway endpoint (free), DynamoDB interface endpoint × 1 (2 AZs) for cross-region write-back (`vpc-stack.ts`) |
| Home | Load balancing | ALB × 2 (platform, OpenMetadata) + CloudFront + two WAF web ACLs (6 rules for the platform, 2 for OpenMetadata) |
| Home | Public IPv4 | 6 addresses (NAT 2 + ALB 2 × 2) |
| Home | KMS CMK | 2 (data / logs); Secrets Manager about 5 secrets |
| Home | Redshift Serverless | base 8 RPU (no compute charge while idle) |
| Home | DynamoDB, 72 tables | all on-demand (PAY_PER_REQUEST) |
| Home | CloudTrail | multi-region management-event trail × 1 + S3 bucket (transitions to Glacier after 90 days); VPC flow logs → CloudWatch Logs (30 days) |
| Home | MWAA Serverless / AgentCore Runtime × 3 / CodeBuild / Lambda / Cognito / ECR | all usage-billed |
| Execution | VPC (zero egress) | 2 AZs, **no NAT**; **11** interface endpoints (sts · logs · monitoring · kms · secretsmanager · glue · emr-serverless · redshift-data · s3tables · redshift-serverless · airflow-serverless; `infra/lib/exec-env/endpoints.ts`) + S3 / DynamoDB gateway endpoints (free) |
| Execution | KMS CMK × 1; about 2 secrets; private hosted zone × 1 (cross-region write-back) | `exec-env/base-stack.ts` |
| Execution | Redshift Serverless base 8 RPU · MWAA Serverless · S3 Tables table bucket · Glue · EMR Serverless | all usage-billed |
| Execution (real-time enabled) | Kinesis source stream, 1 shard (standing) · Flink applications (billed only while running) · DMS replication instance dms.t3.small (standing after lazy creation) | `realtime-stack.ts` · `platform/src/lib/realtime/dms-service.ts` |

---

## 3. Idle home region cost breakdown

| # | Item | Specification | Unit price | Monthly | Measured (two full days, per day) | Notes |
|---|---|---|---|---|---|---|
| 1 | OpenSearch nodes | 5 × t3.small.search | $0.036 per node-hour | **$131.4** | $4.32 | 2 data + 3 dedicated master nodes, high-availability design |
| 2 | OpenMetadata container | Fargate 2 vCPU / 4 GB | $0.04048 per vCPU-hour + $0.004445 per GB-hour | **$72.1** | $2.37 | |
| 3 | NAT gateways | × 2 | $0.045 per hour each | **$65.7** | $2.16 | + $0.045 per GB processed (≈ 0 while idle) |
| 4 | OpenMetadata RDS | db.t3.small Multi-AZ MySQL | $0.068 per hour | **$49.6** | $1.63 | |
| 5 | Platform containers | Fargate 0.5 vCPU / 1 GB × 2 | same as #2 | **$36.0** | $1.18 | upper bound $108 when auto-scaled to 6 |
| 6 | ALB | × 2 | $0.0225 per hour each | **$32.9** | $1.08 | + LCU at $0.008 per LCU-hour (≈ 0 while idle) |
| 7 | Public IPv4 | × 6 | $0.005 per IP-hour | **$21.9** | $0.72 | |
| 8 | WAF | 2 web ACLs + 8 rules | $5 per ACL + $1 per rule | **$18.0** | $0.58 | + $0.60 per million requests |
| 9 | Cross-region write-back interface endpoint | DynamoDB × 1, 2 AZs | $0.01 per AZ-hour | **$14.6** | $0.48 | the floor price of the multi-region capability; + $0.01 per GB |
| 10 | OpenSearch EBS | gp2 20 GB × 2 | $0.135 per GB-month | $5.4 | $0.18 | |
| 11 | RDS storage | gp2 20 GB Multi-AZ | $0.23 per GB-month | $4.6 | $0.15 | backups free up to 100% of storage |
| 12 | KMS CMK | × 2 | $1 per month | $2.0 | $0.07 | + $0.03 per 10,000 requests |
| 13 | Secrets Manager | ≈ 5 | $0.40 per month | $2.0 | $0.07 | |
| 14 | VPC flow logs → CloudWatch Logs | ≈ 0.08 GB per day | $0.50 per GB | ≈ $1.5 | $0.04 | |
| 15 | Cognito | Essentials | $0.015 per MAU | < $1 | $0.07 (9 MAU) | 50 users ≈ $0.75 |
| 16 | Redshift Serverless (home) | base 8 RPU | $0.375 per RPU-hour | **$0** | $0 | no charge while idle; storage $0.024 per GB-month |
| 17 | DynamoDB, 72 tables | on-demand | storage $0.25 per GB-month (first 25 GB free) | ≈ $0 | < $0.05 | |
| 18 | CloudFront | | free allowance of 1 TB / 10 million requests | ≈ $0 | $0.05 | |
| 19 | MWAA Serverless / AgentCore × 3 / CodeBuild / Lambda / Glue / EMR / ECR | usage-billed | | $0 | $0 | |
| | **Baseline subtotal** | | | **≈ $458** | **$15.1 per day** | |
| 20 | **RDS extended-support fee** | MySQL 8.0, Multi-AZ 4 vCPU | $0.10 per vCPU-hour (2026-08 to 2028-07); $0.20 (from 2028-08) | **$292** | $9.60 | disappears once upgraded to MySQL 8.4 (§7 item 1) |
| 21 | **CloudTrail paid management events** | ≈ 110,000 events per day | $2 per 100,000 events | **$68** | $2.23 | **only when the account already has another trail** (the platform's trail becomes the second one); otherwise $0 |
| | **Total including #20 and #21** | | | **≈ $818** | **$27.0 per day (measured $27.04)** | |

The repository pins a database engine within standard support, so line 20 does not apply to a fresh install. It appears only on environments whose engine has been left on a retired version.

---

## 4. Idle execution region cost breakdown (per region)

| # | Item | Specification | Unit price | Monthly | Measured per day | Notes |
|---|---|---|---|---|---|---|
| 1 | **VPC interface endpoints** | 11 × 2 AZs | $0.01 per AZ-hour | **$160.6** | $5.28 | the price of zero egress and the floor price of an execution region; + $0.01 per GB processed |
| 2 | KMS CMK | × 1 | $1 per month | $1.0 | $0.03 | |
| 3 | Secrets Manager | ≈ 2 (including the warehouse administrator) | $0.40 per month | $0.8 | $0.03 | |
| 4 | Private hosted zone (cross-region write-back) | × 1 | $0.50 per month | $0.5 | — | absent for a second target in the same region as the home region |
| 5 | Redshift Serverless | base 8 RPU | $0.375 per RPU-hour | **$0** | $0 | no charge while idle; RMS storage $0.024 per GB-month |
| 6 | MWAA Serverless | | $0.08 per task-hour | $0 | $0 | billed only while tasks run |
| 7 | S3 Tables table bucket | | $0.0265 per GB-month + maintenance | ≈ $0 | $0 | linear in data volume |
| 8 | Glue / EMR Serverless / Flink / CloudWatch Logs | usage-billed | | $0 | $0 | |
| | **Baseline subtotal** | | | **≈ $163** | **$5.3 per day** | |
| 9 | CloudTrail paid events (same condition as §3 #21) | ≈ 20,000 events per day | $2 per 100,000 events | $12 | $0.39 | |
| 10 | Real-time compute enabled: Kinesis source stream | 1 provisioned shard | $0.015 per shard-hour | $11 | (test accounts B / C: 1 shard standing per region) | |
| 11 | After the first real-time sync task: DMS replication instance | dms.t3.small single-AZ, 20 GB | $0.0372 per hour | $27 | (test account B: 79 h measured) | created lazily, standing afterwards |
| | **Total including #9 (real-time off)** | | | **≈ $175 (measured $180, including a small amount of test residue)** | | |

The measured $180 includes a small amount of test residue. The interface endpoints are the price of zero-egress networking and cannot be removed.

---

## 5. Unit prices per task (what one run or one hour costs, at the platform's default capacity)

| Task type | Platform default capacity | Unit price | Typical single run | Notes |
|---|---|---|---|---|
| Data sync (Glue job) | G.1X × 2 workers = **2 DPU** (`lib/sync/start-run.ts`) | $0.44 per DPU-hour, billed per second, 1-minute minimum | small table, 5 minutes ≈ **$0.07**; 10 minutes ≈ $0.15 | test account B, all acceptance runs: 21 DPU-hours = $9.3 |
| Batch compute (EMR Serverless Spark) | driver / executors as configured by the user (x86) | $0.0526 per vCPU-hour + $0.0058 per GB-hour (ARM 20% cheaper) | 10 vCPU / 40 GB for 10 minutes ≈ **$0.13** | test account B: 17 vCPU-hours + 76 GB-hours = $1.1 |
| Warehouse query (Redshift Serverless) | base **8 RPU** | $0.375 per RPU-hour ⇒ **$3.00 per active hour**, 60-second minimum per wake-up ≈ $0.05 | one dashboard refresh (30 seconds) ≈ $0.05; one hour of continuous queries $3 | **active whenever anything queries the warehouse**; the leading item among the large ones; recovery time after a cold start is billed too |
| Orchestration / scheduling (MWAA Serverless) | | **$0.08 per task-hour** (by the actual run time of each task) | 10 tasks of 5 minutes each ≈ $0.07 per run | test account B: 13.7 task-hours = $1.1 |
| Stream job (Flink, MSAF) | parallelism 1 ⇒ **2 KPU** (1 + coordinator) | $0.11 per KPU-hour + 50 GB per KPU of running storage at $0.10 per GB-month | **≈ $170 per month per continuously running stream job** | test account B: 163 KPU-hours in each of its two regions = $18 over 3.4 days, consistent with 2 KPU standing |
| Real-time sync (DMS) | dms.t3.small | $0.0372 per hour | standing $27 per month (one instance per region, shared by all tasks) | |
| Ask-Your-Data / Copilot / advisors (Bedrock, **Kimi K3**) | the platform scales output tokens × 2.1 (reasoning blocks) | input **$3.30 per million tokens**, output **$16.50 per million tokens**, cache read $0.165 | one question ≈ 8k input + 2k output ≈ **$0.06** | a cache hit can cut the input part to 1/20 |
| Same, Claude Opus 4.5 (factory default) | | input $5 per million, output $25 per million | one question ≈ 8k + 1k ≈ $0.065 | |
| Agent runtime (AgentCore) | by consumption | $0.0895 per vCPU-hour + $0.00945 per GB-hour, active time only | one question ≈ $0.002 | test account B, all acceptance runs: $0.4 |
| New execution region (CodeBuild) | Linux small | $0.005 per minute | one build ≈ 40 minutes ≈ **$0.20** | one-off |
| Data lake storage (S3 Tables) | | $0.0265 per GB-month + compaction $0.05 per GB + monitoring $0.025 per 1,000 objects-month | 1 TB ≈ $27 per month + maintenance | |
| Warehouse storage (Redshift RMS) | | $0.024 per GB-month | 1 TB ≈ $24.6 per month | |
| Audit / metadata writes (DynamoDB on-demand) | | write $0.625 per million WRU, read $0.125 per million RRU | 100,000 operations per day ≈ $2 per month | |
| Logs (CloudWatch Logs) | | $0.50 per GB ingested + $0.03 per GB-month | 1 GB per day ≈ $16 per month | the more jobs, the more logs |

---

## 6. Three-tier estimates with workloads (per execution region, us-east-1, per month)

**Tier definitions**

| Dimension | Small (department pilot) | Medium (one business domain) | Large (whole company) |
|---|---|---|---|
| Sync tasks | 10 runs per day, 2 DPU × 5 minutes | 100 runs per day, 2 DPU × 10 minutes | 1,000 runs per day, 3 DPU × 10 minutes on average |
| Spark batch jobs | 5 runs per day, 10 vCPU / 40 GB × 10 minutes | 30 runs per day, 20 vCPU / 80 GB × 20 minutes | 200 runs per day, 40 vCPU / 160 GB × 30 minutes |
| Orchestration tasks | 50 task-minutes per day | 500 task-minutes per day | 5,000 task-minutes per day |
| Warehouse active | 1 hour per day at 8 RPU | 8 hours per day at 8 RPU | 24 hours per day at 16 RPU on average |
| Continuously running stream jobs | 0 | 2 (+ Kinesis + DMS) | 10 (+ Kinesis + DMS) |
| Data volume | 100 GB lake + 100 GB warehouse | 1 TB + 1 TB | 10 TB + 10 TB |
| Model Q&A (whole account, Kimi K3) | 50 questions per day | 300 questions per day | 2,000 questions per day |

**Estimates**

| Item | Small | Medium | Large | Formula |
|---|---|---|---|---|
| Sync (Glue) | $22 | $440 | $6,600 | runs × DPU × duration (h) × $0.44 × 30 |
| Batch (EMR Serverless) | $19 | $455 | $9,100 | runs × (vCPU × $0.0526 + GB × $0.0058) × duration (h) × 30 |
| Orchestration (MWAA Serverless) | $2 | $20 | $200 | task-hours × $0.08 × 30 |
| **Warehouse (Redshift Serverless)** | **$90** | **$720** | **$4,320** | RPU × active hours × $0.375 × 30 |
| Stream jobs (Flink + Kinesis + DMS) | $0 | $378 | $1,738 | jobs × $170 + $11 + $27 |
| Storage (S3 Tables + RMS) | $5 | $52 | $517 | GB × ($0.0265 + $0.024) |
| Logs / audit / endpoint traffic | ≈ $3 | ≈ $30 | ≈ $150 | linear in job count |
| **Workload subtotal per execution region** | **≈ $140** | **≈ $2,100** | **≈ $22,600** | |
| Execution-region idle floor | $165 | $165 | $165 | §4 |
| **Total per execution region** | **≈ $305** | **≈ $2,265** | **≈ $22,800** | |
| Model Q&A (whole account, billed in the home region) | $90 | $540 | $3,600 | questions × $0.06 × 30 |

**Whole-platform examples** (home region at the §3 "Baseline subtotal" of $458, without the extended-support fee and the second CloudTrail trail)

| Shape | Monthly cost |
|---|---|
| 1 home + 1 execution region, idle | ≈ $620 |
| 1 home + 1 execution region, small workload | ≈ $850 |
| 1 home + 2 execution regions, medium workload in each | ≈ $5,500 |
| 1 home + 3 execution regions, large workload in each | ≈ $72,500 |

**Scaling rule**: workload cost is **linear** in workload volume; 10× the workload ≈ 10× the cost, with warehouse active time and Spark job size setting the ceiling.
From the "medium" tier upward the idle floor is already less than 10% of the bill.

---

## 7. Optimization opportunities (for decision; this document does not change the product)

| # | Item | Current monthly cost | Approach | Saving | Risk / cost |
|---|---|---|---|---|---|
| 1 | **RDS MySQL 8.0 extended-support fee** | $292 ($584 from 2028-08) | **Done (merged into the development branch on 2026-10-26, pending release at the time of writing; shipped in the release of 2026-10-27)**: upgrade the OpenMetadata database to **MySQL 8.4** (within RDS standard support); CDK `om-database-stack.ts` pins the engine to 8.4 and the `redeploy-platform.sh` database-stack step upgrades the database in place during the upgrade (measured in a test account, 8.0.46 → 8.4.11: the database-stack step took 9.5 minutes, OpenMetadata lost its database connection for about 2 minutes, the container was not restarted) | **$292** | OpenMetadata 1.6.1 compatibility with 8.4 was verified in a test account by headless-browser acceptance on the pages; one maintenance window (about 2 minutes of OpenMetadata database-connection loss measured); RDS does not support major-version downgrade (see [Deployment § 6.2](deployment.md#62-upgrade-the-control-plane)) |
| 2 | OpenSearch with 5 nodes | $131 | drop the 3 dedicated master nodes, keep only the 2 data nodes | $79 | loses split-brain protection and master-election stability (a high-availability decision of the production-hardening design) |
| 3 | NAT gateways × 2 | $66 | a single NAT gateway | $33 | single point of failure; conflicts with the production-hardening design decision of "one NAT gateway per AZ" |
| 4 | Second CloudTrail trail | $68 + $12 per execution region | when the account already has a trail, deploy with `-c skip-cloudtrail=1` (`deploy-all.sh` exposes it as `SKIP_CLOUDTRAIL=1`) | $80+ | audit evidence depends on the customer's own trail |
| 5 | Warehouse frequently woken by dashboards | $3 per active hour | concentrate dashboard refreshes into fixed windows; lengthen the refresh interval of Ask-data cards | depends on usage | none |
| 6 | Flink minimum of 2 KPU | $170 per job | merge several streams into one job | by job count | less isolation |
| 7 | Execution-region interface endpoints | $161 per region | not removable (zero egress is a non-negotiable rule, see [AGENTS.md §3](../AGENTS.md#3-non-negotiable-rules)) | — | — |

The repository already pins a standard-support database engine; the upgrade script applies the engine change in place, with about two minutes of lost database connection in rehearsals.

---

## 8. Not included and uncertain items

- Data egress (internet / cross-region) traffic: NAT $0.045 per GB, cross-region $0.02 per GB, CloudFront $0.085 per GB beyond 1 TB;
  the platform's own traffic is tiny, and the volume depends on user downloads / exports.
- Customer-owned source databases (RDS / MSK / MySQL on EC2 and the like) are outside this model.
- Price factors for other regions: the AWS pricing pages are authoritative; this model is entirely at `us-east-1`.
- Redshift Serverless "active" time is driven by queries; the platform's health probes do not wake the warehouse, but users opening dashboards or asking questions do.
- Model unit prices are the Bedrock standard tier (not batch, not flex); Kimi K3's reasoning blocks make its output tokens roughly 2× those of Claude, which is already reflected in "one question ≈ $0.06".
- Unit prices are the public prices read on 2026-10-23; re-check them with the AWS Pricing Calculator before the next report.

---

## 9. Data sources (verifiable)

- Standing specifications: `infra/lib/*.ts`, `infra/lib/exec-env/*.ts` (§2 of this document lists the file for every item).
- Unit prices: `aws pricing get-products` (us-east-1, 2026-10-23); the price table used by the FinOps page in this repository, `platform/src/lib/finops/pricing.ts`, agrees (Glue $0.44 / Redshift $0.375).
- Measurements: `aws ce get-cost-and-usage` split by `SERVICE × USAGE_TYPE` and by `REGION × SERVICE`, for the two full days 2026-10-20 to 21 (production-mode account) and for 2026-10-19 to 23 (demo-mode accounts, used as the workload yardstick).
