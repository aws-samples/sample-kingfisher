# Production Hardening — Top-Level and Detailed Design

> - 📌 **Scope note (reconciled 2026-10-13)**: this document was written in the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. Multi-region behavior — place,
>   execution scope, per-region scheduling and the like — is described in the [multi-region execution specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current state of each module is tracked in the design index; a path mentioned below that no
>   longer exists means that the idea was not implemented as described here or has since been superseded.
> - ⚠️ **Implementation differences**: the `platform/e2e` Playwright suite, `infra/lib/backup-stack.ts`, `infra/lib/alerting-stack.ts` and `DR-RUNBOOK.md` planned in this document were not implemented as described: alerting is implemented at the application layer by the [intelligent operations and
>   alerting design](./intelligent-ops-alerting.md) (`platform/src/lib/alerting/`), the headless acceptance suite is kept outside the repository (not checked in), the rules for retaining / snapshotting data resources are in the [deployment guide](../deployment.md), section 7bis, and the current
>   production-hardening rules are in the [deployment guide](../deployment.md), sections 6 and 8.
> - The phrases "deploy only with `--profile temp-account`" and "`.session-state.local.md`" used below are development-period conventions of 2026-07: the current rule is any **explicit** `--profile` (see [`AGENTS.md`](../../AGENTS.md), non-negotiable rules), and that state file is not in the
>   repository.

> - Revision: 1.0 (design draft) | Date: 2026-06-23 | Status: pending review
> - Benchmark: the production form of a leading cloud data-development suite (HA/DR, defense in depth, intelligent operations, observability)
> - Target milestone: **release 2.0.0** ("from an advanced demo to a platform that can carry production")
>
> - 🔴 This document follows the project red lines: ① deploy only with `--profile temp-account`; ② no hard-coded secrets or account values of any kind (everything goes through Secrets Manager / IAM roles); ③ every new capability must be verified by headless Playwright; ④ never push without permission.
> - This document contains no real account ids / ARNs / URLs; placeholders are used; the real values are in `.session-state.local.md`.

---

## 0. Why "hardening" rather than "more features"

By release 1.29.0 the platform already covers about **13 of 23** capability domains of the main chain of a leading cloud data-development suite (data integration / development / scheduling / governance / quality / security / GenBI / multi-tenancy …) — **breadth of functionality is not what is missing**. The real gap to "production grade" lies in two cross-cutting weaknesses, and the first one is fatal:

1. **Production-grade depth ≈ 0** (what this design addresses): the entire data layer is single-AZ, a single NAT, ECS `desiredCount=1` with no autoscaling, no PITR / backups, stateful resources on `RemovalPolicy.DESTROY`, the task role carrying `IAMFullAccess`, Cognito without MFA, no WAF / CMK / CloudTrail / Flow Logs, zero tests, zero alarms, no CI/CD.
2. **Five strategic capability domains are missing** (handled by the follow-on designs): real-time CDC, warehouse modeling, data-service APIs, an intelligent-operations baseline, and FinOps.

> **Decision (2026-06-23)**: do the phase-0 hardening first; position the product as an enterprise-internal platform (logical multi-tenancy + RBAC is sufficient); EMR / Flink / MSK may be introduced, but phase 0 only reserves an "engine driver SPI" abstraction, and the concrete engines go to phase 1.

**This design covers phase 0 only**: hardening the existing functionality to production standard. The one-sentence principle — **if the foundation is weak, new features are still a demo**.

---

## 1. Design principles → mechanisms (no empty talk)

| Principle | How this platform implements it (verifiable mechanism) |
|---|---|
| Defense in depth | Identity (MFA + OIDC) → network (private subnets / minimal security groups / WAF / VPC endpoints) → IAM (one role per service + permission boundary + narrowed `Resource`) → data (CMK + row/column permissions + dynamic masking) → audit (CloudTrail + Flow Logs + data-access audit). If any one layer fails, the next one still holds |
| Least privilege | Split up `*FullAccess`; separate roles by **control plane / data plane / scheduling plane**; use **STS AssumeRole** across capabilities instead of one shared broad permission set; add a **permission boundary** to prevent privilege escalation |
| No single point of failure / fault isolation | Multi-AZ (NAT per AZ, ECS ≥ 2, RDS Multi-AZ, OpenSearch 3 nodes across 2 AZs); control plane decoupled from data plane; tenant blast radius isolated |
| Resilience | Idempotency (optimistic lock `version`) + retries (exponential backoff + jitter + circuit breaker) + timeout degradation + **DLQ** + compensation (Saga) |
| Observability as a first-class citizen | Structured JSON logs + **end-to-end correlation-id** + OTel traces + RED/USE metrics + SLO alarms + operations dashboard |
| Everything as code | IaC (already CDK) + CI/CD gates (synth / diff / test / security scan / red-line scan) + blue-green / rolling deployment |
| Zero hard-coded credentials | Secrets Manager + automatic rotation; all runtime identities are IAM roles; the CI red-line scan blocks secrets from entering the repository |

---

## 2. Target architecture (after hardening)

```
                    ┌──────────────────── Access layer ────────────────────┐
   Users ───► CloudFront + AWS WAF ─► (HTTPS) ─► internal ALB (multi-AZ) ─► ECS Fargate (≥2, across AZs, autoscaling)
                    │  Cognito (MFA + OIDC, USER_PASSWORD_AUTH disabled)   │
                    └──────────────────────────────────────────────────────┘
                                               │
        ┌─────────────── Control plane (Next.js BFF) ────────────────────────────────────────────┐
        │  Writes only "intent" to the state store + emits events; no longer carries *FullAccess │
        └───────────────┬────────────────────────────────────────────────────────────────────────┘
                        │ EventBridge / SQS (+DLQ)
        ┌───────────────▼──────────────────── Data plane (execution workers) ────────────────────────────────┐
        │  Step Functions / Lambda / ECS Task (each with its own least-privilege role, idempotent + retried) │
        │  → Glue / Redshift Data API / Athena / MWAA / (phase 1: EMR/Flink/MSK)                             │
        └────────────────────────────────────────────────────────────────────────────────────────────────────┘

   Cross-cutting: KMS (CMK) encrypts everything · Secrets Manager (rotation) · CloudTrail + VPC Flow Logs ·
        OpenTelemetry → CloudWatch/X-Ray · Alerting center (SNS → e-mail / DingTalk / WeCom) · Backup (AWS Backup) · DR
```

**The two most critical architecture upgrades** (running through all of phase 0):

1. **Control plane / data plane decoupling**. Today the Next.js process calls a pile of AWS APIs directly and carries `IAMFullAccess` — one design that simultaneously violates security (overly broad permissions), robustness (no retries / idempotency; a UI request timeout means the work is lost) and availability (execution is tied to the UI). The production form: the control plane writes the "intent" to DynamoDB + emits an EventBridge event, and **dedicated workers** (Step Functions / Lambda, each with a least-privilege role) execute it. **Land it first on the most dangerous write paths (sync start, ETL run, publish, promote) and migrate incrementally; a one-shot rewrite is not required.**

2. **Pluggable kernel (SPI)**. Abstract "data-source driver / engine driver / scheduling node type / sync channel" into unified interfaces. Phase 0 only builds the interfaces and the adapters for the existing implementations; when phase 1 connects EMR / Flink / MSK, it "registers a plugin" instead of changing the core.

---

## 3. Phase-0 workstream breakdown (WS0–WS6)

Ordered by dependency: **WS0 must come first** (it is the foundation for verifying everything else); the rest can run in parallel. For each WS: goal / evidence of the current state / design / key changes / risks and rollback / acceptance (including headless).

| WS | Topic | Depends on | Key risk |
|---|---|---|---|
| **WS0** ✅ | Quality-gate foundation: CI/CD + tests + structured logs / correlation-id | None | Low (purely additive) |
| **WS1** ✅ | Encryption foundation: full KMS CMK coverage | None | Medium (deleting a key by mistake = data undecryptable) |
| **WS2** ✅ | High availability: multi-AZ / autoscaling / removing single points of failure | None | Medium (rebuilding stateful resources) |
| **WS3** | Disaster recovery: backups / PITR / RETAIN / deletion protection | WS1 | High (migrating stateful resources can lose data) |
| **WS4a** ✅ | Defense in depth (1): IAM least-privilege narrowing | WS0 | High (removing permissions from a live platform; staged + regression) |
| **WS4b-1** ✅ | Defense in depth (2): WAF + CloudTrail + VPC Flow Logs + password policy | WS0, WS1 | Low (purely additive, does not touch login) |
| **WS4b-2** | Defense in depth (3): MFA + disabling USER_PASSWORD_AUTH + SRP | WS4b-1 | **High (breaks the existing headless login; requires an e2e client and a changed login flow first)** |
| **WS5** | Resilience: idempotency + retries / circuit breaker + DLQ + control/data-plane decoupling | WS0 | Medium |
| **WS6** | Observability + alerting center | WS0, WS5 | Low |

---

### WS0 — Quality-gate foundation (first; the prerequisite for all verification)

**Goal**: make "production grade" measurable and regressable. Current state: 0 tests, no CI/CD, errors reduced to `e.message`.

**Design**:
1. **Structured logs + end-to-end correlation-id**
   - Add `platform/src/lib/observability/logger.ts`: a unified JSON logger (`{ts, level, msg, correlationId, actor, projectId, route, latencyMs, ...}`).
   - `middleware.ts` injects / propagates `x-correlation-id` (generating a ULID when absent), stores it in `AsyncLocalStorage`, and every log line carries it automatically.
   - Replace the scattered `console.log/catch(e){...e.message}` with structured `logger.error(e, {correlationId})`, keeping the stack trace.
2. **Error model**: extend `lib/api-response.ts` so that `apiError(message, status, code?)` gains a `code` (machine-readable, such as `RBAC_DENIED`/`UPSTREAM_TIMEOUT`/`VALIDATION_FAILED`) + a `correlationId` returned to the frontend, for support and troubleshooting.
3. **Test pyramid** (pragmatic, not aiming at 100%):
   - Unit (Vitest): pure logic first — `sql-guard`, `masking`, `dag-generator`, `sql-lineage`, `run-params`, RBAC `resolveRole`. These are **security / correctness critical** and have no AWS dependency, so they must have tests.
   - Contract / integration: API routes against DynamoDB Local + mocked AWS (`aws-sdk-client-mock`).
   - E2E: **move the Playwright assets from `/tmp/qa/*.js` into the repository** at `platform/e2e/` (they are currently scattered in /tmp and easily lost), forming a regression suite.
4. **CI/CD gates** (`.github/workflows/ci.yml`): triggered on PR → `lint` → `tsc` (platform + infra) → `vitest` → `cdk synth` → **red-line scan** (gitleaks / custom grep that blocks keys / ARNs / account ids) → `cdk diff` (commented on the PR). **No automatic deployment** (red line ④; deployment stays manual with `--profile temp-account`).

**Acceptance**: CI is all green on the PR; a deliberately committed change containing a fake key is blocked by the red-line scan; the core unit tests pass locally with `npm test`.

**✅ Implemented (2026-06-23)**:
- Error model: `apiError` in `lib/api-response.ts` gained `code` (the ApiErrorCode enum) + `correlationId`, backward compatible.
- Structured logging: `lib/observability/logger.ts` (single-line JSON, safe on both edge and node, no ALS dependency, never throws); `middleware.ts` generates / propagates `x-correlation-id` (forwarded in the request header + echoed in the response header).
- Tests: introduced Vitest 4.1.9 with coverage (the currently supported test-runner version is listed in [supported versions](../supported-versions.md)); 6 test files under `src/**/__tests__/`, **66 cases all passing** (sql-guard / run-params / sql-lineage / masking.applyMask / RBAC roleAtLeast·isAnalystOnly / logger). tsconfig excludes the test files; `next build` has zero regressions.
- Red-line scan: `scripts/redline-scan.sh` (scans for account ids / AKIA / private keys / JWTs / hard-coded password literals; exempts placeholders and env reads; two modes, tracked and --staged). Self-test: 0 false positives on the real repository; all 3 classes of planted leaks caught.
- CI: `.github/workflows/ci.yml` (redline-scan + platform [test + build] + infra [tsc + cdk synth]; validation only, no deployment). Verified locally: `cdk synth --all` (placeholder env) and `npm ci --dry-run` both pass.
- Verification: the four gates run back to back locally, all green (red line / 66 tests / build exit 0 / tsc exit 0). **Nothing deployed, nothing pushed.**

---

### WS1 — Encryption foundation (full KMS CMK coverage)

**Goal**: upgrade from "AWS managed keys (rotation not auditable)" to **customer-managed CMKs**, with key access auditable, rotatable, and isolated per data domain.

**Evidence of the current state**: RDS / Redshift / OpenSearch / S3 / DynamoDB have no explicit encryption configuration; OpenMetadata↔MySQL runs with `DB_USE_SSL=false` (plaintext).

**Design**:
- Add `infra/lib/kms-stack.ts`: one CMK per data domain (`bgp/data` (lakehouse + RDS), `bgp/logs`, `bgp/secrets`), with **automatic annual rotation** enabled and a minimal key policy (only the corresponding service roles get `kms:Decrypt/GenerateDataKey`).
- Wire each stack to the CMK: S3 `BucketEncryption.KMS`, DynamoDB `encryption: CUSTOMER_MANAGED`, RDS `storageEncrypted+kmsKey`, Redshift `kmsKeyId`, OpenSearch `encryptionAtRest`+`nodeToNodeEncryption`+`enforceHttps`.
- Encryption in transit: OpenMetadata↔MySQL switched to `DB_USE_SSL=true`; TLS enforced end to end.

**Risks and rollback**: ⚠️ **Deleting a CMK by mistake = data permanently undecryptable** — CMKs always get `RemovalPolicy.RETAIN` + deletion protection; changing the encryption of RDS / Redshift **requires a rebuild or a snapshot restore** (coordinated with WS3: snapshot first → restore encrypted). Rollback: keep the old resources until the new encrypted resources are verified, then switch.

**Acceptance**: `aws kms list-keys` shows 3 CMKs with rotation enabled; S3 / DDB / RDS describe calls show the CMK ARN; OpenMetadata is healthy and connects over SSL; a headless smoke test of the whole site shows no regression.

**✅ Implemented and verified by deployment (2026-06-23, test account `temp-account` `<account-id>`)**:
- Added `kms-stack.ts`: 2 CMKs (`alias/bgp-data`, `alias/bgp-logs`) + automatic annual rotation + RETAIN.
- 25 DynamoDB tables encrypted with the CMK; RDS×2 `storageEncrypted`+CMK; the Redshift namespace `kmsKeyId` + a grant to the service principal; OpenSearch at-rest CMK + node-to-node encryption + HTTPS enforced; the three S3 buckets SSE-S3 + public access blocked + TLS enforced; OpenMetadata↔MySQL `DB_USE_SSL=true`.
- **Key pitfalls (fixed, recorded in the runbook)**: ① the RDS generated password's `excludeCharacters` omitted `/` and the space → `MasterUserPassword` invalid → completed the exclusion set;
  - ② **under a DynamoDB customer-managed CMK, callers must explicitly have `kms:Decrypt`+`GenerateDataKey`** (previously assumed to be transparent) — granted `dataKey.grant(...)` to each of the Platform TaskRole / MWAA role / AgentCore skill Lambda, otherwise reading or writing an encrypted table returns 500 `KMS key access denied` (caught by the headless test; CloudFormation does not report it).
- Moving S3 to the CMK is deferred to WS4 as designed (it requires an exact mapping of each role's grants).

---

### WS2 — High availability (HA / removing single points of failure)

**Goal**: eliminate every SPOF; the failure of any one AZ does not affect availability.

**Evidence of the current state** (verified by inspection): `vpc-stack.ts` has `maxAzs:2` but `natGateways:1`; `platform-stack.ts` `desiredCount:1` with no scaling; `rds-stack.ts`/`om-database-stack.ts` `multiAz:false`; `om-search-stack.ts` hard-codes a single node in `availabilityZones[0]`; Redshift single-AZ.

**Design**:

| Resource | Current | Hardened | File |
|---|---|---|---|
| NAT | 1 | `natGateways: 2` (one per AZ) | `vpc-stack.ts` |
| Platform ECS | desiredCount=1 | `desiredCount: 2` + **target-tracking autoscaling** (CPU / request count; min 2, max 6) | `platform-stack.ts` |
| RDS (business + OpenMetadata) | Single-AZ | `multiAz: true` | `rds-stack.ts`/`om-database-stack.ts` |
| OpenSearch | 1 node, single-AZ | `dataNodes: 3` + `zoneAwareness(2 AZ)` + 1 replica | `om-search-stack.ts` |
| Redshift | Single-AZ | Explicit multi-AZ configuration (Serverless supports in-region redundancy) / evaluate a managed workgroup | `redshift-stack.ts` |
| OpenMetadata ECS | desiredCount=1 | desiredCount=2 (stateless; safe once the DB is HA) | `om-service-stack.ts` |

**Risks and rollback**: enabling Multi-AZ on RDS has one restart window (choose the maintenance window); changing the OpenSearch node count rebuilds the domain (snapshot first). Cost rises (NAT×2, OpenSearch×3, RDS×2), acceptable for an enterprise-internal platform; non-critical environments (dev) can be scaled down with a context switch.

**Acceptance**: `describe` shows multi-AZ; killing one ECS task does not interrupt the service (autoscaling brings one up); NAT present in both AZs.

- **✅ Implemented and verified by deployment (2026-06-23)**: VPC `natGateways:2`;
- Platform ECS `desiredCount:2` + target-tracking autoscaling (CPU 60 / Mem 70, min 2 max 6) + 100% rolling update;
- RDS×2 `multiAz:true`;
- OpenSearch 2 data nodes + 3 dedicated master nodes + zoneAwareness (2 AZs).
- **Verified against real AWS**: `describe-db-instances` MultiAZ=true;
- `describe-domain` InstanceCount=2/MasterCount=3/ZoneAware=true.
- The OpenMetadata service stays at a single replica for now because it runs the schema migration at startup (true multi-replica needs the migration moved out; left for later).

---

### WS3 — Disaster recovery (DR / backups / protection against accidental deletion)

**Goal**: recover from accidental deletion / failures / regional events, meeting RPO/RTO.

**Evidence of the current state**: almost every stateful resource is on `RemovalPolicy.DESTROY` + S3 `autoDeleteObjects:true`; DynamoDB has no PITR; OpenSearch has no snapshots; RDS has only the default backups; `deletionProtection:false`. **A single `cdk destroy` wipes the databases.**

**Design**:
1. **RemovalPolicy governance**: all stateful resources (RDS×2, Redshift, OpenSearch, DynamoDB×24, S3 data buckets, S3 Tables, Cognito) switched to **`RETAIN`**; database-type resources get `deletionProtection: true`; `autoDeleteObjects` removed.
2. **Backups**:
   - DynamoDB: `pointInTimeRecoveryEnabled: true` on every table (35 days).
   - RDS: `backupRetention: 30 days` + maintenance / backup windows; cross-region replicas for critical databases (to be evaluated).
   - Redshift: a scheduled snapshot plan (EventBridge→Lambda or managed snapshots).
   - **A unified AWS Backup plan**: add `infra/lib/backup-stack.ts`, a BackupVault (CMK-encrypted) + plans (daily / weekly / monthly) + cross-region copy (critical data), selecting resources by tag.
3. **DR drill runbook**: `DR-RUNBOOK.md` alongside this design document, with RPO/RTO targets, recovery steps and periodic drills.

**Risks**: after switching to `RETAIN`, `cdk destroy` leaves orphan resources (they must be cleaned up manually — but that is exactly the point); migrating existing DESTROY resources to RETAIN does not affect data (only the deletion behavior changes).

**Acceptance**: the DynamoDB console shows PITR on; AWS Backup shows a successful recovery point; one "accidental deletion → PITR restore" drill passes.

---

### WS4 — Defense in depth (IAM + authentication + network + audit)

> ⚠️ **This WS contains the only changes that break the existing headless tests (MFA / disabling USER_PASSWORD_AUTH); see "Test impact" below.**

**Goal**: least privilege + strong authentication + perimeter protection + full audit.

**Evidence of the current state**: the platform TaskRole carries `IAMFullAccess`/`EC2FullAccess`/`S3FullAccess`/`DynamoDBFullAccess` + a pile of `*:*`; Cognito has `USER_PASSWORD_AUTH` enabled, no MFA, and a weak password policy (uppercase / symbols not required); no WAF; no CloudTrail / Flow Logs.

**Design**:

**(a) IAM narrowing (the most critical security debt)**
- Remove all `*FullAccess` managed policies. Split roles by operational surface, in step with the control/data-plane decoupling of WS5:
  - **Control-plane role** (the ECS platform): read-only metadata + DynamoDB CRUD limited to the `bgp-*` tables + emitting EventBridge events + reading Secrets (only the ones it needs). **No more** Glue / EC2 / IAM / S3 write permissions.
  - **Data-plane roles** (one per worker, as needed): for example `sync-worker` only `glue:StartJobRun` (limited to this platform's job ARNs) + writing the target; `query-worker` only Redshift Data API read-only + the results bucket.
  - Resource-level `Resource` narrowed to `arn:aws:...:bgp-*`; dangerous actions get a `Condition` (such as `aws:SourceVpce`).
- Attach a **permission boundary** to every role (no `iam:*`, no cross-account, no deleting CMKs / logs) to prevent any role from escalating privileges.

**(b) Authentication hardening (Cognito)** — `auth-stack.ts`
- **Add a dedicated test app client** `bgp-e2e-client` with `ALLOW_ADMIN_USER_PASSWORD_AUTH` enabled (for Playwright only, restricted); **the main web client disables `USER_PASSWORD_AUTH` and keeps only SRP + refresh**.
- Enable **MFA (TOTP; optional → enforced for admin / manager)** + AdvancedSecurityMode (ENFORCED).
- Password policy: minimum 12 characters + upper and lower case + digits + symbols; account recovery by e-mail only.

**(c) Network** — add `infra/lib/waf-stack.ts`
- **AWS WAF** in front of CloudFront (AWSManagedRules + rate limiting + optional geo rules).
- Critical AWS calls go through **VPC endpoints** (S3 Gateway, DynamoDB Gateway, Secrets / KMS / ECR Interface), reducing the NAT exposure surface and traffic cost.

**(d) Audit** — add `infra/lib/audit-stack.ts`
- **CloudTrail** (management + data events; log bucket CMK-encrypted + Object Lock).
- **VPC Flow Logs** (→ CloudWatch / S3).
- S3 access logs.
- Complements the existing application-level `bgp-audit` table (the application layer records "who did what on the platform"; CloudTrail records "who touched which AWS resource").

**Test impact (must be handled at the same time, otherwise red line ③ — the headless tests — breaks)**:
- The Playwright login flow currently signs in directly with `USER_PASSWORD_AUTH`. Once the main client disables that flow: the tests switch to `bgp-e2e-client` + `ADMIN_USER_PASSWORD_AUTH` (server-side `aws cognito-idp admin-initiate-auth`), or use SRP in the tests.
- MFA is **not enforced** for the test accounts (by group: only admin / manager are enforced, and the tests use ordinary developer / analyst accounts; or the e2e account is seeded with a TOTP secret and the tests generate the codes).
- Update the login logic in `RESUME.local.md` and `platform/e2e/helper.js`.

**Risks and rollback**: if the IAM narrowing misses a permission, functionality returns 500 — **staged rollout**: narrow the dev role first + full headless regression, then prod; keep the old role for 24 h so it can be switched back in seconds.

**Acceptance**: `aws iam list-attached-role-policies` shows no `*FullAccess`; a simulated over-privileged call is denied; a WAF test rule is hit; CloudTrail / Flow Logs contain data; **full headless regression of the whole site with 0 errors** (including the new login flow + the admin MFA path).

---

### WS5 — Resilience (idempotency / retries and circuit breaking / DLQ / control·data-plane decoupling)

**Goal**: failures are recoverable, repeats do not corrupt data, slow dependencies do not drag the system down.

**Evidence of the current state**: CRUD has no optimistic locking (concurrent overwrites); Glue polling is a fixed 15 s × 40 with no backoff and no circuit breaker; exceptions in fire-and-forget downstream triggers are swallowed; no DLQ; multi-step operations (publish DAG → write DDB) have no compensation. Existing highlight: dependency triggers use conditional writes for idempotency (keep and generalize this pattern).

**Design**:
1. **Optimistic locking**: configuration resources (datasource / sync / workflow / etl-job) gain a `version` attribute; updates use DynamoDB `ConditionExpression: version = :expected`, and a conflict returns `409 CONFLICT` (the frontend shows "modified by someone else").
2. **A unified retrier** `lib/utils/retry.ts`: exponential backoff + jitter + maximum attempts + **circuit breaker** (consecutive failures open the breaker — fail fast instead of avalanche) + an allow-list of retryable errors (throttling / 5xx / timeouts). Every AWS call goes through it.
3. **Asynchronous execution + DLQ**: the dangerous write paths (sync start, ETL run, publish, promote) move to **EventBridge → SQS (with DLQ) → Step Functions / Lambda worker**. Workers are idempotent (deduplicated by runId); failures go to the DLQ + an alarm and can be replayed.
4. **Saga compensation**: multi-step operations (such as "create Glue job → write DDB → register in OpenMetadata") are orchestrated with Step Functions; a failure at any step triggers compensation (deleting the half-finished artifacts), avoiding dirty state.
5. **Polling upgrade**: Glue / Redshift status polling switches to backoff (2 s → 4 s → … capped) + an overall timeout; on timeout the run enters an "unknown, to be reconciled" state instead of being silently lost.

**Risks**: going asynchronous changes the UX (from synchronous waiting to submit-then-poll / notify) — GenBI and publishing already work this way; reuse the frontend polling convention (users are already used to the ~60 s polling).

**Acceptance**: concurrent updates of the same resource — one succeeds, the other gets 409; an injected transient fault is retried successfully, a persistent fault trips the breaker and fails fast; a forced worker failure → DLQ + alarm + replayable; a Saga that fails midway leaves no dirty data behind.

---

### WS6 — Observability + alerting center

**Goal**: from "zero alarms + short log retention" to SLO-driven proactive operations.

**Evidence of the current state**: metrics are partially enabled (Athena / MWAA / X-Ray for GenBI), but **zero alarms, no dashboard, and logs retained for only 1–2 weeks**.

**Design**:
1. **OpenTelemetry**: the platform + workers adopt the OTel SDK; traces span "UI → control plane → event → worker → AWS", joined with the WS0 correlation-id (trace-id = correlation-id).
2. **Metrics system**: RED (request Rate / Error / Duration, per route) + USE (ECS / RDS / Redshift resource saturation) + business metrics (task success rate, scheduling latency, GenBI latency / cost). Emitted directly to CloudWatch via EMF (following the existing GenBI EMF pattern).
3. **SLOs + alarms**: define SLOs (such as API availability 99.9%, on-time scheduling rate, sync success rate), implemented with CloudWatch Alarms + composite alarms, with **multi-window burn-rate** alarms (avoiding alarm storms).
4. **Alerting center** (application layer, benchmarked against the alerting of a leading cloud data-development suite): add `infra/lib/alerting-stack.ts` with an SNS topic + `lib/alerting/` channel adapters (e-mail / DingTalk / WeCom webhook / SMS), severity levels (P1 phone / P2 IM / P3 e-mail) + silencing / aggregation / on-call rotation. Add the DDB tables `bgp-alert-rules`/`bgp-alert-events`.
5. **Operations dashboard**: add the page `/ops` (an embedded CloudWatch dashboard + key cards drawn by the platform: live task states, SLO burn, top slow tasks, recent alarms).
6. **Log retention**: unified ≥ 30 days (90 days where compliance requires it), cold data archived to S3.

**Acceptance**: force one failure that triggers an alarm → received in IM; the dashboard reflects task states in real time; a trace can be drilled down from one UI action to the specific AWS call; log retention takes effect.

---

## 4. Data-model delta (DynamoDB)

| Table | PK / SK | Purpose | WS |
|---|---|---|---|
| `bgp-alert-rules` | `projectId` / `ruleId` | Alert rules (metric / threshold / channel / severity / silencing) | WS6 |
| `bgp-alert-events` | `ruleId` / `ts#ULID` | Alert event stream (TTL 90 d) | WS6 |
| Existing configuration tables | (new attribute `version:number`) | Optimistic locking | WS5 |

> No new partition hot spots: alert events are partitioned by `ruleId` (naturally spread). The existing ULID sort-key convention is kept.

---

## 5. CDK stack delta and dependencies

```
New:          kms-stack (WS1) · backup-stack (WS3) · waf-stack (WS4) · audit-stack (WS4) · alerting-stack (WS6)
Modified:     vpc (WS2 NAT) · platform (WS2 scaling / WS4 IAM narrowing / WS4 VPC endpoints) ·
              rds/om-database (WS2 multiAz / WS1 encryption / WS3 backup protection) · redshift (WS1/WS2/WS3) ·
              om-search (WS2 3 nodes / WS1 encryption) · auth (WS4 MFA/SRP) · mwaa/agentcore (WS4 IAM narrowing)
Dependencies: kms before the data stacks; backup depends on the data stacks being tagged; the rest follow the existing injection pattern of bin/app.ts
```

**Deployment discipline** (the existing red lines): every command with `--profile temp-account`; `get-caller-identity` to confirm the account before deploying; the platform deployment carries `-c openmetadata-url=...`; a separate `--output` to avoid conflicts.

---

## 6. Implementation order and milestones (proposed)

```
Sprint 1   WS0 in full (CI/CD + test foundation + structured logging)                           → makes everything after it regressable
Sprint 2   WS1 (KMS) + WS2 (HA)                                                                  → encryption and no single points of failure (verify in dev first)
Sprint 3   WS3 (DR / backups / RETAIN)                                                           → protection against accidental deletion, recoverability
Sprint 4   WS4 (IAM narrowing + authentication hardening + network + audit) ★ includes the test changes → defense in depth (staged)
Sprint 5   WS5 (resilience + control/data-plane decoupling on the critical paths)                → resilience
Sprint 6   WS6 (observability + alerting center + operations dashboard)                          → proactive operations
Milestone  Everything done + full headless regression with 0 errors + DR drill passed            → release 2.0.0
```

When each WS is done: both build gates → deploy (`temp-account`) → **headless Playwright regression** → update VERSION / CHANGELOG / the project status document → local commit (**no push until approved**).

---

## 7. Verification strategy (red line ③: new functionality must be verified headlessly)

- **Regression suite consolidated**: move `/tmp/qa/*` into `platform/e2e/` and run it in CI (against the staging environment).
- **Dedicated headless cases per WS**:
  - WS2: the UI stays usable after a simulated task failure.
  - WS4: the new login flow (SRP / admin-auth) + the admin MFA path + over-privileged access denied.
  - WS5: the 409 prompt on concurrent edits, replay of failures.
  - WS6: trigger an alarm → received in IM, dashboard rendering.
- **Non-functional verification**: fault injection (killing tasks / simulating an AZ outage), IAM over-privilege simulation, DR recovery drill, autoscaling under load.

---

## 8. Risk register (top)

| Risk | Impact | Mitigation |
|---|---|---|
| MFA / disabling USER_PASSWORD_AUTH breaks the headless login | All tests red, red line ③ | WS4 changes the test login flow at the same time (dedicated e2e client + admin-auth); MFA enforced only for admin / manager |
| CMK / RETAIN misconfiguration | Data undecryptable / orphan resources | CMKs always RETAIN + deletion protection; verify in dev first; keep the old resources until the switch |
| IAM narrowing misses a permission | Functionality returns 500 | Staged in dev + full headless regression + the old role can be switched back for 24 h |
| HA changes rebuild stateful resources | Data risk | Coordinated with WS3: snapshot first → restore; choose the maintenance window |
| Cost increase (multi-AZ / CMK / Backup / WAF) | The bill | Acceptable at enterprise grade; dev uses the context scale-down switch |

---

## 9. Hand-off to the follow-on designs (phases 1 and 2)

- This design's **control/data-plane decoupling + engine-driver SPI abstraction** is the prerequisite for phase 1 connecting **EMR / Flink / MSK real-time CDC and multiple engines** (the follow-on real-time and multi-engine designs) — at that point it is "register a data-plane worker + an engine plugin" without touching the control plane.
- This design's **alerting center + SLOs** is the foundation for the phase-1 **intelligent-operations baseline** (the follow-on intelligent-operations design).
- The **data-service API** (a planned follow-on design) will reuse this design's WAF / OpenAPI gateway / least privilege and observability.

---

## Appendix: index of evidence for the current gaps (probed facts, for reviewer cross-checking)

- HA single points: `infra/lib/vpc-stack.ts` (natGateways:1), `platform-stack.ts` (desiredCount:1), `rds-stack.ts`/`om-database-stack.ts` (multiAz:false), `om-search-stack.ts` (single node in AZ[0]).
- Security: `platform-stack.ts` (IAMFullAccess/EC2FullAccess/S3FullAccess/`*:*`), `auth-stack.ts` (USER_PASSWORD_AUTH / no MFA / weak passwords), no waf / audit stacks, `om-service-stack.ts` (DB_USE_SSL:false).
- DR: `RemovalPolicy.DESTROY` in every stack, S3 `autoDeleteObjects:true`, no DDB PITR, `deletionProtection:false`.
- Resilience / observability: no `*.test.ts`, errors reduced to `e.message`, fixed-interval polling, zero CloudWatch Alarms, logs retained 1–2 weeks, no `.github/workflows`.
