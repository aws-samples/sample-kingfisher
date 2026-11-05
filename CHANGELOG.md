# Changelog

All notable changes to the Kingfisher data platform are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release tags are named `vX.Y.Z` and match the `VERSION` file and the headings below.
A hotfix increments the patch number. Dates are release dates.
Component versions are listed in [docs/supported-versions.md](docs/supported-versions.md), not here.

## [Unreleased]

### Added

- Release cut with GitHub Release: `scripts/cut-release.sh <version> --yes --github-release` packages the tag and creates the Release (body = the CHANGELOG section, assets = archive + SHA-256); it refuses to start without an authenticated `gh` or with an empty `[Unreleased]` section.
- Release packaging: `scripts/package-release.sh <tag>` builds a deterministic customer delivery archive from a git tag without tests or developer tooling, with a SHA-256 file and a `BUILD-INFO.json` that keeps the release tag visible in deployments made from the archive.
- Per-job execution role selection: offline Spark, EMR Serverless, sync, and Flink jobs can run under any IAM role the engine service may assume, as in the AWS console.
- Execution role picker groups roles into platform default, advisor-generated, and custom, refreshes inside the page, and keeps a manual ARN entry as fallback.
- Saving a job now preflights the chosen role: trust policy, existence, and permissions on everything the job references. Gaps are listed with action, resource, and reason.
- Dependency libraries of multi-region jobs are uploaded once per bound region and submitted from that region's bucket.
- System Settings shows platform-created data-source network objects (security groups, Glue connections) with ownership and in-use status, and a background cleanup card.
- Design specification for an offline job node in workflow orchestration, so sync tasks and offline jobs can form one DAG published to the serverless scheduler (implementation planned).
- Design specification for lake table-bucket routing, letting one job read and write several S3 Tables buckets per region (core and read-side phases planned for the next release).
- Supported versions matrix (`docs/supported-versions.md`), feature tour with screenshots, and architecture diagrams drawn with official AWS icons.
- Complete English translations of all module design documents (71 files under `docs/design/`, index in `docs/design/README.md`); the six design pages that were previously condensed summaries are replaced by the full translations, and the modules overview links to every design document.

### Changed

- Product source no longer carries internal tracking identifiers (defect, schedule, module, work-package, phase, batch and acceptance ids) in comments, test titles, annotations or operator-facing text.
  A repository guard (`internal-identifier-guard`) keeps it that way across all code, tests and offline judges.
- The execution-scope banner on pages that are not yet scope-filtered no longer shows an internal ticket number; it states what is missing. The `ticket` field and its type were removed from the scope declarations.
- Scheduler runtime template comments changed, so `BGP_RUNTIME_VERSION` changes: workflows republished after upgrading use the new runtime package, already published ones keep working on the old one. No action required.
- Major upgrade of the web framework and UI runtime; route handlers follow the new asynchronous request API. Pages and the container layout are unchanged.
- Release naming: tags are `vX.Y.Z`, matching `VERSION` and this file; hotfixes bump the patch number; `main` is the trunk and CI runs on it.
- A newer Glue runtime is available as the default for new sync jobs, with a compatibility layer for older source databases; existing jobs keep their recorded runtime.
- Real-time sample data is produced in event-time order, so windowed aggregates in the sample pipeline are complete instead of partially dropped as late.
- Architecture and flow diagrams no longer carry service version labels.

### Fixed

- Deleting an offline job while one of its runs is still in flight is refused with `409 JOB_RUN_IN_PROGRESS` that lists the run ids, so a Glue job definition is no longer removed under a running job and its run record no longer stays "running" forever in the task monitor. The job-row delete is conditional on no live run lock, which also closes the narrow window between the check and the delete; EMR engine jobs apply the same check and refuse while the application still has running jobs.
- The run poller distinguishes "lock taken over by another run" from "job row gone": when the job row disappears it stops renewing the lock but keeps tracking the run to its real terminal state, and when Glue or EMR report the definition itself gone it closes the run as failed with an explicit message and releases the lock. Job-row status writes are conditional everywhere (TypeScript and the Python scheduler carriers), so a deleted job is never recreated as a ghost row, and running a deleted job returns 409.
- Scheduler and workflow job-node carriers record a `running` run row as soon as a run starts (runtime package v12), so scheduled and node runs are visible to the delete check, and `timeout-pending` is recognised as an in-flight state. Upgrade note: republish existing DAGs and workflow packages to pick up the new carriers; until republished, their runs are only protected by the lock held by the platform process.
- Backfill of a workflow bound to a non-home region now runs its SQL nodes in that region's warehouse: the warehouse binding is resolved per instance, the statement is submitted and polled with a same-region client, and the node lock and run record carry that region. The former "workflow backfill only supports the home region" rejection is removed and plans expand once per bound region.
- The backfill wizard renders the cascade switch, the sync-node notice and the forced-concurrency state as soon as a target is selected instead of only after "Preview instances", and a failed preview shows the server's message instead of nothing (the error envelope object was being passed to the toast).
- The task monitor applies filters carried in the URL (`?name=&triggeredBy=`) on the first load instead of only after the next auto-refresh.
- Unit tests and CI are hermetic: tests no longer depend on the developer machine's AWS credentials, temporary files or pre-installed infrastructure dependencies, and the infrastructure job installs the platform dependencies so the agent skills Lambda bundles at synth time. Product bytes are unchanged.
- Release packaging wrote an empty tag list into `BUILD-INFO.json` and exited with code 141 when the packaged commit carried a tag, which is exactly the release case; the tag list is now passed as an argument and the offline judge covers a tagged ref.
- Deleting a data source that is still referenced by sync or real-time tasks is refused with a list of the referencing tasks instead of orphaning them.
- Deleting a data source no longer leaves orphaned `bgp-ds-*` security groups; cleanup is persisted and completes once network interfaces are released.
- Connectivity probes that finish after a data source was deleted no longer create nameless "unreachable" ghost rows.
- Platform-owned security groups or Glue connections removed outside the platform are rebuilt at use time with an alert; rebuilt connections carry the correct availability zone.
- Running a Spark engine job during an application cold start no longer times out at the edge; long submissions continue in the background and duplicate submissions are blocked.
- Creating or redeploying an execution region from the console no longer fails during bootstrap when the home region is outside the United States.
- First start of a replication-based sync task waits long enough for the replication instance to be created; the UI text reflects the real duration.
- Several pages no longer flicker or report hydration errors on first render.
- Offline job page shows the full reason when a save is rejected, and run, dry run, backfill, preview, and publish stop instead of using the previous definition.
- Installation and upgrade synchronize the Flink runner and connector-module JARs by content hash (sha256 stored in the S3 object metadata): a JAR that is missing or older than its sources is rebuilt with Maven, identical objects are skipped, and the upgrade script now ships new JARs (before, installation skipped any object that already existed and upgrade did not touch the JARs at all). Execution regions refresh their runner copy from the identity of the home-region object on the next start, and the cache key of the modular connector assembly includes the identity of every source JAR, so an upgraded module is reassembled instead of served from the cache. Running stream jobs load the new JAR after one stop and start; see `docs/deployment.md`, section 7ter.1i.

### Security

- Vitest and its coverage package were upgraded to 4.1.12 (GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8). The three agent packages pin patched versions of optional transitive dependencies (simple-git, @simple-git/argv-parser, zod, @modelcontextprotocol/server) through `overrides`; the agent images never install them (`--omit=optional`), so runtime bytes are unchanged.
- Dependency security updates for the platform and infrastructure packages, with explicit overrides for transitive packages that upstream does not fix.
- The transitive `postcss` package bundled by the web framework is pinned to a patched release through `overrides`, and continuous integration now fails on high or critical advisories in production dependencies.
- AI agent images are built from committed lockfiles with development and optional dependencies omitted.
- All container images run as a non-root user.
- Scanner configurations (`.bandit`, `.gitleaks.toml`, `.semgrepignore`) are committed with a written reason for every exclusion.
- The Cognito bootstrap function accepts only HTTPS callback URLs and no longer silences callback failures.
- Flink runner and connector-module JARs are built against Flink 1.20.4 (GHSA-2f54-v4hm-fx73, remote code execution in Flink SQL code generation). The planner itself is a `provided` dependency supplied by the Managed Service for Apache Flink `FLINK-1_20` runtime, whose patch level is maintained by AWS; the Flink artifacts bundled into the JARs move to the same patch level and the repository's dependency alert is cleared.

## [2.1.2] - 2026-10-29

### Fixed

- Creating a JDBC data source from the home-region view no longer returns an edge timeout while the source is still created; slow creations continue in the background with a progress notice.
- Pressing "Finish" again while a data source is still being created returns "in progress" instead of creating a duplicate.
- A failed data-source creation removes the Glue connection, platform security group, and secret it created, in reverse order.
- Every AWS SDK client now has an explicit network budget (connect and idle timeouts, bounded retries), so a stalled connection yields a readable error instead of hanging.
- Glue role verification moved out of the request path and is cached per process.

### Upgrade notes

- Only the platform service is rolled; no new tables, no agent refresh, and no execution-region redeployment are needed when upgrading from 2.1.1.
- Upgrading from 2.1.0 still requires redeploying each execution region from the console (see 2.1.1).
- Automation that calls the data-source creation API must handle the long-operation protocol: a `202` with a task id, followed by polling `GET /api/long-ops/{taskId}`.

## [2.1.1] - 2026-10-28

### Added

- Sync wizard: a table name with a date variable (a template) can borrow its column structure from a sample table, so field mappings, previews, and merge keys include the template.
- Guards flag a selected table that is an instance of a template and refuse two source tables that resolve to the same target table name.

### Fixed

- Sync tasks in a non-home execution region can write to a customer-owned S3 Tables bucket once it is registered as an external bucket; registration now means visible and writable.
- Replication-based and Zero-ETL sync tasks that fail on the service side show the real state in the task list without opening the detail page; non-home detail pages no longer show "unknown".
- First-time warehouse table creation and the platform marker are written in one transaction, and transient connection errors are retried, so a transient failure can no longer block later runs.

### Upgrade notes

- Redeploy each execution region from the console so engine and COPY roles receive the widened S3 Tables permissions.
- Existing non-home sync tasks that target an unregistered bucket are rejected on the next save or start until the bucket is registered.
- Existing tasks whose source tables collide on the target name are rejected on the next save or start with an explanation.

## [2.1.0] - 2026-10-27

### Added

- Unified long-operation handling: requests that finish within the synchronous window respond as before; longer ones return `202` and the page polls to completion with a background notice.
- Object leases: a second long operation, edit, or delete on the same object while one is in progress is refused with "in progress".
- Multi-vendor model channel: System Settings offers several model families; the vendor profile is shared with the AI agents; saving requires a successful probe including tool use.
- Deploy-time default model chosen from a candidate chain by real invocation, with per-account availability reported honestly.
- Release information is visible on the login page footer, in System Settings, and at `GET /api/public/version`.
- Execution-region candidate pre-authorisation: regions declared at install or upgrade can be added later from the console without an operations command.
- Execution-region health check provisions the S3 Tables federated catalog when missing.
- "Publish to environment" with an environment switcher, per-environment publish status, and approval hand-off for protected environments.
- Backfill center instance drawer with rows written, error text, logs, and links to monitoring; the monitor distinguishes backfill, dry run, rerun, and dependency triggers.
- Data catalog: graphical create table (warehouse and S3 Tables), alter table for the warehouse with explicit refusal of unsupported changes, approvals for the production environment, and a filter bar.
- S3 data sources: "Create external table" action that builds an Athena table in the source's region and opens the lake query page.
- External S3 Tables bucket registration per region; registered buckets appear in the lake explorer, catalog, and analytics.
- Network advisor analyses the network of the selected execution region instead of the home region.
- Sync wizard: local draft recovery, table search and bulk selection, sensible defaults on the first step, schema dropdown with free entry, auto-refresh of the task list.
- Data sources accept additional JDBC connection parameters applied to the Glue connection, sync scripts, discovery, and Flink sinks.
- Table bucket dropdowns in the sync wizard and System Settings list the buckets of the target region.
- Multi-tab close actions (close others, close right, close all).
- `scripts/redeploy-agents.sh` rebuilds and deploys the AI agent images; `--check` compares the running images with the checkout.
- Cost model documentation and an environment variable template for local development.

### Changed

- Major engine upgrade of the OpenMetadata metadata database, performed in place by the upgrade script with a short downtime window.
- The demo data-seeding panel is removed from the UI; seeding remains available to test fixtures through the API.
- English UI coverage completed, with a guard that fails tests on untranslated text.
- Model dropdown shows family and friendly name first.

### Fixed

- Result masking applies to aliased and computed columns by resolving them to physical columns, closing a gap where renamed columns were shown in clear text.
- Rolling back to an older release no longer attempts to downgrade the metadata database.
- External tables for S3 sources are created in the source's region rather than the home region.
- Delete actions on five list pages wait for the server response before reporting success.
- Replication-based sync tasks show "starting" with a stop action during provisioning instead of allowing a second start.
- Data-source status shows "connected" only after a real connectivity check; otherwise "testing" or "unreachable".
- Governance "sync columns" no longer fails at the edge timeout on large catalogs.
- Data-modeling landing and apply during a warehouse cold start continue in the background instead of timing out.
- Editing a data source name no longer fails; changing host, port, database, or credentials updates the Glue connection and secret.
- MySQL zero-value dates are read as NULL by default instead of failing the sync job.
- Switching the data source while editing a sync task clears stale table selections and rejects cross-region sources.
- Workflow publish refreshes the page header; serverless runs are labelled correctly in run history.
- The S3 Tables federated catalog is provisioned at install and upgrade and self-heals at run time.
- Alert rule editing no longer fails on reserved attribute names.
- Workflow creation lists all regions with a scheduler for multi-region binding.
- The upgrade script creates DynamoDB tables added by a new version and tolerates fully pre-authorised region lists.
- Console-created execution regions no longer fail at CDK synthesis when the home region is outside the United States.
- Advisor skill roles and the home EMR role receive the full authorised region list.
- Model probing budgets fit slow-first-token models; AI endpoints switch to background execution instead of edge timeouts.
- Table discovery refresh right after a previous run no longer fails on concurrency limits.
- Schedule configuration page recognises regions that only have the serverless scheduler.
- Saving a sync task updates or creates the Glue job honestly; the Glue runtime required for S3 Tables writes is applied consistently.
- First start of a replication task in a fresh account moves instance creation to the background and blocks duplicate starts.
- Workflow node configuration drawer shows the values of the selected node, not the previous one.
- Agent bundles are checked against their sources so stale compiled artefacts cannot be deployed.

### Upgrade notes

- Run `scripts/redeploy-agents.sh` after `scripts/redeploy-platform.sh`; the agent containers changed in this release.
- The metadata database upgrade causes a short outage of governance pages; schedule the upgrade in a low-traffic window. The database cannot be downgraded afterwards.
- The upgrade script now deploys the database stack, creating the new long-operations table; the pre-release AI task table is retained but no longer used.
- Rolling back to the previous release requires the dedicated rollback tag of that release.
- Declare candidate execution regions with `EXEC_REGION_CANDIDATES` when upgrading to avoid a later redeployment.

## [2.0.1] - 2026-10-13

### Added

- Sync tasks: atomic full-table overwrite via a staging table, refusal to overwrite with an empty result, row-count reconciliation, monthly partitioned tables with derived partition columns.
- Sync tasks: date variables in pushed-down filters, backfill from the task page, and alignment with existing customer tables by column name.
- Data sources can be created with user-chosen subnets and several security groups.
- Workflow sync nodes support backfill; EMR jobs share one set of business-date variables.
- Backfill center runs each region's instances in that region and refuses workflows bound to other regions explicitly.

### Fixed

- Guards for S3 tables not created by the platform require explicit confirmation; merge, row counts, and ledger ordering are correct.
- Workflow SQL nodes run multiple statements in one transaction; saving a sync task refreshes its script and Glue job.

### Upgrade notes

- The analytics agent recipes changed; refresh the AI agent images after the platform upgrade.

## [2.0.0] - 2026-10-12

### Added

- Multi-region execution: one control plane in a home region and a complete data plane per execution region, created from a console wizard and managed through a full lifecycle.
- Explicit place on every object and run; jobs, syncs, schedules, queries, and analytics execute in the region that owns the data, and cross-region reads are refused.
- Per-region serverless scheduler, zero-egress execution regions, private write-back of run ledgers, and a multi-region dashboard.
- Page-level execution scope filter across the whole platform.
- Cross-jurisdiction execution environments with a residency component, user disclaimer, and dual audit.
- Runtime model configuration in System Settings with probe-before-save.
- Project isolation with per-project, per-region warehouse credentials and automatic reclamation on project deletion.
- Saved analytics cards with scheduled refresh; governance tasks and card refreshes run on the scheduler.
- Cost view by region; interactive onboarding tour.

### Changed

- Production deployment mode creates only the administrator and no sample data; the OpenMetadata factory password is replaced during deployment.
- The home region is chosen at installation; the edge web ACL is created in the region CloudFront requires.
- All scheduling moved to the serverless scheduler; the classic environment is no longer provisioned by default.

### Removed

- The standalone data service capability.

## [1.x] - 2026-04 to 2026-08

Single-region era. Highlights, oldest first:

- Initial platform: data sources, sync, warehouse queries, ETL orchestration, governance, and monitoring on a single-account, single-region deployment.
- Natural-language analytics on the warehouse, later rebuilt on a managed agent runtime with multi-turn conversations, memory, semantic table retrieval, and lake queries.
- Standard Cognito authentication enforced on every API route; OpenMetadata removed from the public internet and authenticated with a service token.
- Projects, resource-level RBAC, approvals, strict membership, dev/staging/prod environments, and resource versioning with rollback.
- Code-first job development with AI-generated code, parameterised runs, dry run, backfill, and rerun.
- Governance depth: SQL lineage and impact analysis, classification and column masking, quality rules with scoring and SLA, and a metrics store.
- Insight-to-delivery pipeline from analytics questions to requirements and delivery, with an analyst-only role.
- Operations: AI-assisted run diagnostics, incident knowledge base, FinOps cost attribution, and a consolidated operations menu.
- Advisors for parameters, networks, and IAM roles, including custom least-privilege execution roles.
- Real-time compute on managed Flink with modular connectors and verified writes to S3 Tables from Flink, EMR Serverless, and Glue.
- Data-source SPI covering JDBC, object storage, NoSQL, and streaming sources.
- Unified agent framework and engine cookbook shared by all AI capabilities.
- Deployment runbook hardening: no hard-coded credentials, reproducible from a fresh account, redline scan and pre-commit hook.
- Stable baseline tagged before the multi-region work began.

Older per-release history for the single-region era lives in the previous repository.
