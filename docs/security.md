# Security

This document describes how the Kingfisher data platform is secured when it is deployed into a customer's AWS account.
It covers the trust boundary, identity and access, network design, data protection, auditing, and the secure development process.
Component versions are not repeated here; see [Supported versions](./supported-versions.md).

To report a vulnerability, see section 7. For a short operational checklist, see section 8.

## 1. Security model overview

### 1.1 Trust boundary

- The platform runs entirely inside **one customer-owned AWS account**. There is no vendor-hosted component and no cross-account role.
- Nothing in the platform calls back to the authors of the software. All traffic stays between the customer's browser, the customer's account, and AWS service endpoints.
- Deployment is performed by the customer's own operator with an explicit AWS CLI profile. CI never deploys; it only validates.
- The code base is open; the security of a deployment rests on the AWS account, the IAM design described below, and the operational checklist in section 8.

### 1.2 Control plane and execution regions

A deployment has one **home region** that hosts the control plane and zero or more **execution regions** that each host a complete data plane.

| Plane | What runs there | Where data lives |
|---|---|---|
| Control plane (home) | Web application, metadata tables, OpenMetadata, AI agents, scheduler for the home region | Definitions, run ledgers, audit summaries |
| Execution region | Warehouse, lake table bucket, Spark and Flink engines, replication, per-region scheduler | Business data, query results, full audit of that region |

- Business data is processed in the region where it is stored. Jobs, syncs, queries, and natural-language analytics run in the region that owns the data.
- Every object and every run carries an explicit **place** (the target region). A request without a place is rejected; the platform never silently falls back to the home region.
- Reading across regions is filtered by an explicit **scope**. Writes never read the scope.
- The home region is chosen at installation and is not changed afterwards. Additional execution regions are created only through the console wizard.

### 1.3 Principles enforced in code

- **Fail closed.** Missing authentication configuration, a missing place, an unknown enumeration value, or a failed audit write all stop the operation.
- **No silent defaults.** Mode-like parameters are required, validated against a closed list, and persisted once.
- **Single author.** Each security-relevant fact (role name, region condition, table name, error code) is defined in one module and imported elsewhere.
- **Declared permissions.** Every AWS API call the platform makes is registered in a manifest and simulated against the real task role after deployment.
- **Audit every write.** All write operations record who did what, to which resource, in which region.

## 2. Identity and access

### 2.1 User authentication

- Users are managed in an Amazon Cognito user pool created by the platform. Self sign-up is disabled; accounts are created by an administrator.
- The pool enforces long passwords with mixed character classes. Login uses the standard SRP and password flows of Cognito.
- Every `/api/*` request passes through an edge middleware that verifies the Cognito ID token: signature against the pool's JWKS, issuer, audience, and token type.
- The only unauthenticated routes are `/api/public/*` (login bootstrap and version) and `/api/internal/*` (see 3.5).
- Authentication has exactly three states. Configured: tokens are verified. Explicitly disabled: local development and unit tests only.
- Unconfigured: every API request is refused with a service-unavailable error, so a missing variable can never open the platform.

### 2.2 Roles and gateway rules

Four Cognito groups define platform roles.

| Group | Role | Gateway rule |
|---|---|---|
| `bgp-admin` | Platform administrator | Required for every `/api/admin/*` route |
| `bgp-manager` | Project manager | Full platform routes; project rights decided per resource |
| `bgp-developer` | Developer | Full platform routes; project rights decided per resource |
| `bgp-analyst` | Analyst | Allow-list only: analytics, requirements, read-only project list |

- Gateway rules are enforced in the middleware before any route code runs. Route-level guards repeat the check as a second layer.
- Resources belong to **projects**. Access to a resource is decided by the caller's membership in the owning project; there is no implicit membership.
- Publishing to a protected environment goes through an approval record and is executed under the approver's identity.

### 2.3 Administrator bootstrap

- The platform creates no users in infrastructure code. Groups and the initial administrator are created by a bootstrap script after the authentication stack is deployed.
- The initial password comes from an environment variable or is generated at random. It is written once to a local file with owner-only permissions.
- The password is also printed once to the deployment output. Deployment logs must be protected and disposed of after the first login.
- In **production** mode only the administrator account is created. In **demo** mode test accounts and sample data are also created.
- The mode is written to SSM Parameter Store once; later runs refuse a different value.
- For accounts whose operator lacks Cognito write permissions, a bootstrap Lambda can create the roster instead.
- That Lambda accepts only passwords, never user-to-group mappings. It refuses to change a confirmed user, a reset requires infrastructure-level permissions, and it can be left out of the deployment.
- Password resets are done by another administrator in the user management page. If the only administrator loses the password, the customer resets it with a Cognito admin command in their own account.

### 2.4 Platform task role

- The web application runs on ECS Fargate under a dedicated **task role**. Its policies are derived from the calls the code actually makes, not from AWS managed full-access policies.
- Resources are narrowed to platform namespaces (`bgp-*` tables, buckets, secrets, roles, stacks) wherever the service supports resource-level permissions.
- Secrets Manager read and write are limited to platform prefixes such as `bgp/project/*`, `bgp/datasource/*`, and `bgp/shared-writer/*`, plus the warehouse-managed admin secret.
- The task role holds **no deployment power**. It can invoke one broker Lambda, read build status and logs, and describe execution-region stacks.
- The task role cannot start builds, update the build project, or run CloudFormation.
- Creating or redeploying an execution region works through a **broker Lambda** that alone may start the CodeBuild project.
- The broker accepts only a target id, a component list, and an operation id. It reads the region and account from the registry and rejects any override field.
- The build specification ships inside an immutable, content-addressed source asset. Changing it requires a control-plane redeployment, which is itself audited in CloudTrail.
- Honest positioning: CDK bootstrap roles in the account are administrator-equivalent.
- The isolation above minimises the **resident** attack surface of the web process; it does not claim a least-privilege deployment path.

### 2.5 Per-region execution roles

- Each execution region receives its own stack group with its own IAM roles.
- Those roles are: Glue job role, EMR Serverless job role, Flink application role, warehouse COPY role, replication roles, and a platform data-plane role.
- Role names derive from the target id, so roles of different regions never collide and never share policies.
- Service trust policies are scoped with source conditions, and storage permissions point at the buckets of that region.
- Deleting an execution region is an approved operation. Data stores, keys, and audit tables are retained.

### 2.6 Execution roles chosen per job

- Offline Spark jobs, EMR Serverless jobs, sync jobs, and Flink applications can each run under an IAM role chosen by the user, exactly as in the AWS console.
- Any role in the account that the engine service may assume is eligible.
- The task role may pass roles only to the Glue, EMR Serverless, and Managed Flink services, enforced by the `iam:PassedToService` condition.
- A **preflight at save time** checks the ARN format, that the role exists, and that its trust policy names the engine service.
- The preflight also simulates access to everything the job references, including script and dependency locations.
- Missing permissions reject the save with a list of action, resource, and reason; nothing is stored. Leaving the field empty selects the platform default role of the target region.

### 2.7 Region conditions baked at synthesis

- Statements of the task role that may act across regions carry an `aws:RequestedRegion` condition. The allowed list is computed at synthesis time and baked into the template.
- The list is the home region, the regions of registered execution environments, and any candidate regions declared by the operator at install or upgrade time. Wildcards are refused; region names are validated for form.
- Every regional statement declares its axis (home-only or execution regions) together with a written reason, and an offline synthesis gate asserts the shape.
- Adding a region that was not pre-authorised requires one control-plane redeployment. The platform cannot widen its own permissions at run time.

### 2.8 Data-plane credential modes

The environment variable `BGP_DATAPLANE_CREDS` selects how data-plane clients obtain credentials.

| Mode | Behaviour | Use |
|---|---|---|
| `taskrole` | Data-plane calls use the task role | Default; production |
| `observe` | Try the region's data-plane role, record denials, then retry with the task role | Acceptance in test accounts |
| `enforce` | Only the region's data-plane role | Acceptance in test accounts |

- Any other value is treated as `taskrole`; there is no half-open fourth state.
- The region's data-plane role is resolved from the registry and must be unique per region. Production deployments should not set the acceptance flag; a redeploy without it returns to `taskrole`.

### 2.9 Least-privilege manifest and simulate gate

- `infra/iam/platform-taskrole-calls.json` lists every AWS API call the platform process issues, with the resource form, the region axis, the source file, and the reason.
- Adding an SDK call without registering it fails unit tests and the pull-request checklist.
- After each platform stack deployment, `scripts/iam-simulate-gate.py` runs `SimulatePrincipalPolicy` for the live task role against the manifest.
- Verdicts are three-way: allowed, blocked by an organisation policy of this account, or a real gap. Only a real gap fails the upgrade.
- Organisation blocks are reported separately, so a restricted test account never hides a missing permission.

## 3. Network

### 3.1 Public edge

- The only public entry points are two CloudFront distributions: one for the platform and one for OpenMetadata. Both redirect HTTP to HTTPS.
- Both distributions are protected by AWS WAF web ACLs with AWS managed rule groups for common attacks, known bad inputs, and IP reputation.
- The platform ACL also applies a per-client rate-based rule. The threshold is a stack parameter chosen with the customer and is not published here.
- Application load balancers accept traffic only from the CloudFront origin-facing prefix list of their region and from inside the VPC.
- The OpenMetadata origin additionally requires a secret origin-verification header injected by CloudFront.

### 3.2 Control-plane VPC

- Application containers, the metadata database, and the search cluster run in private subnets. The warehouse is not publicly accessible.
- The search cluster enforces HTTPS and node-to-node encryption and is reachable only from the VPC.
- VPC flow logs are enabled and encrypted.

### 3.3 Execution regions: zero egress

- Execution-region VPCs have no NAT gateway, no internet gateway, and no elastic IP. Private subnets are isolated with no default route.
- All AWS API traffic from the data plane uses VPC endpoints: gateway endpoints for S3 and DynamoDB and interface endpoints for every other service the engines need.
- Run ledgers are written back to the control plane over a private VPC peering connection; DNS for control-plane endpoints resolves to the peered endpoints, not to the internet.
- Multi-region production deployments do not import existing VPCs. One execution environment is allowed per region, and its component set is not trimmable.

### 3.4 Data-source connectivity

- Security groups created for JDBC data sources are named `bgp-ds-*` and tagged as platform-managed with the owning data source and target. Customers may supply their own subnets and security groups instead.
- Platform-owned network objects that are removed outside the platform are rebuilt at use time with an alert; customer-owned objects are only reported.
- The platform does not build cross-region network paths (peering or transit gateways) to customer databases. That remains customer network engineering.

### 3.5 Internal endpoints

- `/api/internal/*` serves the action dispatcher and background pumps. It refuses any request that carries the CloudFront origin header, so the public internet never reaches the secret check.
- Callers must present a registered source header and a shared secret stored in Secrets Manager; each route accepts only its expected source. Internal callers are audited under system principals.

## 4. Data protection

### 4.1 Encryption keys

- The control plane creates two customer-managed KMS keys: one for data and one for logs. Both rotate automatically and are retained if the stack is deleted.
- Each execution region creates its own data key with a retained alias, so data in a region is never decryptable with another region's key.

### 4.2 Encryption at rest

| Store | Encryption | Additional controls |
|---|---|---|
| DynamoDB tables | Customer-managed key | Point-in-time recovery; retained on stack deletion |
| Redshift Serverless | Customer-managed key | Not publicly accessible; VPC-only port |
| OpenMetadata database | Customer-managed key | Automated backups; deletion protection |
| OpenSearch | Customer-managed key | Node-to-node encryption; HTTPS enforced |
| S3 buckets | SSE-S3, or KMS for audit and residency buckets | Block Public Access; TLS required |
| CloudTrail and flow logs | Logs key | Log file validation |

### 4.3 Secrets

- Database credentials, project warehouse credentials, writer credentials, the OpenMetadata administrator password, and the origin-verification header are all stored in AWS Secrets Manager.
- Containers receive secrets through ECS secret references, not through plain environment variables or templates.
- The OpenMetadata factory password is replaced during deployment with a generated secret, and the deployment fails unless the new password works and the factory password does not.
- Audit records never contain passwords, secret values, or full sensitive SQL; executors record a SQL skeleton only.

### 4.4 Protection of query results

- Column classifications drive server-side masking of query results for the warehouse query page, BI, and natural-language analytics. Stored data is never altered.
- Masking resolves aliased and computed result columns back to their physical columns, so renaming a column in SQL does not bypass it. Administrators and users with an approved grant see the columns unmasked.
- Natural-language analytics and lake exploration accept read-only statements only; a SQL guard rejects writes.

### 4.5 No secrets in the repository

- `scripts/redline-scan.sh` scans tracked, staged, and addable files for access keys, private keys, bearer tokens, hard-coded passwords, and account ids. A hit fails the commit or the CI run.
- `.githooks/pre-commit` runs the scan on staged changes; enable it with `scripts/install-hooks.sh`.
- `.gitleaks.toml` extends the default gitleaks rules and lists only verified non-secret patterns, each with a written reason.
- Real values belong in `*.local.md` or `.env.local`, both ignored by git. Documentation uses placeholders.

## 5. Auditing

### 5.1 Application audit

- Every write operation records an entry in the audit table: actor derived from the verified token, action, resource type and id, target region, HTTP method and path, and a non-sensitive detail object.
- Most writes audit best-effort so that logging can never break a user operation. Privilege-boundary changes, such as administrative DDL, audit **fail-closed**: if the audit write fails, the operation is refused.
- Background callers (dispatcher, pumps) are recorded under fixed system principals. The audit page lets administrators filter by actor, action, resource, and region.

### 5.2 Cross-jurisdiction residency

- Each execution environment carries a jurisdiction. Environments outside the home jurisdiction must install the residency component before they can be enabled.
- The component provides, inside that region, a full audit table, a results table, and a results bucket. All are encrypted with the region's key, retained on deletion, and the bucket policy denies replication.
- Each cross-jurisdiction data operation writes the full record to the regional audit table and a summary without personal data to the central audit table. If either write fails, the operation does not run.
- Users must acknowledge the current residency disclaimer for a target before operating on it; the acknowledgement is stored.
- The platform task role is explicitly denied update and delete on regional audit tables, so the platform cannot rewrite its own trail.

### 5.3 AWS-level audit

- The audit stack creates a multi-region CloudTrail trail with global service events and log file validation, delivered to a bucket encrypted with the logs key.
- VPC flow logs are retained for at least thirty days in an encrypted log group.
- Execution-region deployments run as CodeBuild builds, so every build start and project change is also visible in CloudTrail.

## 6. Secure development

### 6.1 Dependency hygiene

- Application and infrastructure dependencies are audited with the package manager and fixed within semver ranges; transitive packages that upstream does not fix are pinned with explicit overrides.
- `npm audit --omit=dev --audit-level=high` runs in continuous integration for `platform/` and `infra/`; a high or critical advisory in a production dependency fails the job.
- Every container image, including the three AI agent images, is built from a committed lockfile with development and optional dependencies omitted.
- All containers run as a non-root user.

### 6.2 Static analysis configuration

- `.bandit`, `.gitleaks.toml`, and `.semgrepignore` are committed.
- They exclude only directories that do not ship with the product and patterns verified as non-secrets; every exclusion carries a reason.
- Product paths are always scanned. Inline suppressions in code must state why.

### 6.3 Continuous integration gates

| Gate | What it checks |
|---|---|
| Redline scan | No secrets or account ids in tracked files |
| Dependency advisories | No high or critical advisory in production dependencies |
| Platform tests and build | Unit tests, type check, lint, production build |
| Agent artefact consistency | Committed agent bundles equal their compiled sources |
| Infrastructure | TypeScript compile and CDK synthesis without credentials |
| Synthesis gate | Offline assertions on IAM shape, region conditions, and deployment isolation |

CI runs on pull requests and pushes to `main`. It validates only; it never deploys.

### 6.4 Triage policy for findings

Every finding from a scanner, an audit, or a report is classified into exactly one of three outcomes.

| Outcome | Meaning | Required action |
|---|---|---|
| Real defect | Code, configuration, or dependency must change | Fix, add a regression test, note in the changelog |
| False positive | The tool misread a non-issue | Record the reason; suppress at the narrowest scope |
| Accepted | Intentional behaviour with understood risk | Record why it is kept and when to revisit |

- Each release candidate is rescanned with the same tool set before the tag is cut.
- Suppressions without a reason are not accepted in review. Finding lists and counts live in the internal scan record, not in this document.

### 6.5 Change discipline

- Shared security facts have one author module; a change there is reviewed for its blast radius first.
- Tests mock only true external systems (AWS SDK clients, OpenMetadata, models), never sibling modules, so wiring defects surface.
- Deleting an object removes everything it created (connections, jobs, scripts, security groups) or reports the failure honestly.
- Features are accepted only by driving the real UI in a headless browser against a deployed test account.

## 7. Reporting a vulnerability

- Please report suspected vulnerabilities to AWS/Amazon Security through the [vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/). Do not open a public issue or pull request.
- Include the affected component, a reproduction or proof of concept, the impact you expect, and any suggested fix. Do not include customer data or real credentials.
- Maintainers acknowledge the report, triage it according to section 6.4, and fix confirmed defects in a patch release. Reporters are credited in the changelog unless they prefer otherwise.
- Vulnerabilities in AWS services themselves should be reported to AWS Security.

## 8. Operational security checklist

| Area | Check | When |
|---|---|---|
| Deployment identity | Deploy with an explicit profile; never run raw `cdk deploy` | Every deployment |
| Deploy mode | `BGP_DEPLOY_MODE=production` for customer accounts; never change it later | Installation |
| Initial password | Protect and delete the password file and deployment log after first login | Installation |
| Credential mode | Leave the data-plane credential flag unset in production | Every upgrade |
| Region authorisation | Declare candidate regions explicitly; no wildcards | Installation and upgrades |
| IAM gate | Confirm the simulate gate reports no real gap | Every platform deployment |
| Post-deploy truth | Run `scripts/02-postdeploy-truth.sh` and read every item | Every deployment |
| Secrets | Rotate data-source credentials in Secrets Manager; never in the repository | Periodically |
| Access review | Review Cognito groups, project memberships, and job execution roles | Periodically |
| Audit | Review the audit page and CloudTrail for unexpected write actions | Periodically |
| Edge | Keep WAF managed rule groups enabled; adjust the rate rule with the customer | Periodically |
| Dependencies | Rescan with the configured tools before each release candidate | Every release |
