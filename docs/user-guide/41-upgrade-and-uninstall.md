# Upgrade and decommissioning

| Item | Content |
|---|---|
| Audience | Platform admins (what users will experience during an upgrade, what to click to decommission a region); operators (where to find the authoritative commands) |
| Estimated time | 20 minutes of reading; the page actions to decommission one execution region take about 10 minutes + approval + the destroy build |
| Prerequisites | You have read the [Architecture overview](04-architecture.md); you have a bgp-admin account |
| What you get | You know the phases of an upgrade, what users see, and which objects must be republished afterwards; you know how to stop accepting work on and delete an execution region, and which resources are kept and keep billing; you know the real boundaries of decommissioning the whole platform |

The **authoritative commands** for upgrade and rollback live only in [`../deployment.md`](../deployment.md) §7ter / §7ter.2; this chapter covers "what it means for users" and what to do on the pages.

## 1. What an upgrade means for users

The operator runs the upgrade on the deployment machine in several phases; users experience each phase differently.

| Phase | What the operator does | What you see | What you do |
|---|---|---|---|
| Control plane | Check out the new tag → `npm ci` in both places → run the platform upgrade script | Platform containers restart in a rolling fashion and the pages stay available; if the new version upgrades the metadata database engine, "Governance Center" is unavailable for about 2 minutes while other pages are unaffected | Nothing; avoid starting long-running operations during the upgrade |
| Agents | When the new version changes the agent containers, run the agent refresh script (`--check` first) | GenBI conversations already in progress may keep running on the old container for a few minutes; new conversations use the new version | Nothing |
| Execution regions | The admin clicks "Redeploy" on each execution environment details page: a dry run first (lists which stacks would change and whether the source has drifted, without executing changes) → approve → build → "Check initialization" | The details page shows the build progress; roles / buckets / endpoints that the new version adds to execution regions appear only after this step | The platform admin approves as the page prompts; do this only when that version's upgrade notes require it. The confirmation button after the dry run states whether this run is "Confirm deployment (additions only)" or "Confirm deployment (will interrupt running jobs)"; pick an off-peak time for the latter |
| Version check | — | The login page footer and the "Settings → Platform version" card show the new tag | Glance at the footer after the upgrade |

### 1.1 Things you may have to redo on the pages after an upgrade

| Object | When to redo it | How |
|---|---|---|
| Workflows / scheduled jobs already published to the scheduler | The new version changed the scheduling runtime (for example the carrier that writes the run row as soon as it starts) | "Publish to scheduler" again from the "ETL Orchestration" details page; republish scheduled batch jobs with "Publish to MWAA schedule". Jobs that are not republished keep running on the old artifacts and do not break |
| Running Flink streaming jobs | The new version updated the Flink runner JAR | On the "Stream Compute" page, "Stop" and then "Start" every running job (about 2–3 minutes, during which no data is processed); jobs that are not stopped and started keep running the old package |
| Existing sync tasks | The new version added save-time guards (for example target table name collisions, or the table-bucket route must be writable) | Follow the prompt when the next save / start is rejected; Glue jobs already running are unaffected |
| Execution-region sync tasks writing to your own table bucket | The new version widened the execution-region roles' permissions to table buckets in the same region | First "Redeploy" the execution region as in §1, then register the bucket under "Settings → Lake table buckets and routes" |

- What has to be redone for each version is defined by that version's upgrade notes in `CHANGELOG.md` and manual §7ter.1x; this table only lists the types that have occurred so far.
- An upgrade does not touch business data, the OpenMetadata catalog or Cognito accounts; new tables are created by the upgrade script together with the database stack.

### 1.2 Who does it and how to schedule it

- The operator runs it on the deployment machine, with the same AWS profile, deploy mode and (if one was given explicitly at first install) the same model id as the first installation; the deployment machine needs Docker, Node 20, Maven + JDK 17.
- Pick an off-peak time: the control-plane rollout takes about 40–50 minutes; each execution-region "Redeploy" takes about 5–15 minutes.
- The upgrade command can carry `EXEC_REGION_CANDIDATES=…` to pre-authorize candidate regions in one go; adding regions afterwards is then done entirely on the pages.
- After the upgrade the operator runs the post-deploy truth script once, and the admin signs in for a round of smoke tests (data source list, sync task list, Athena query).

### 1.3 Rollback

- Rollback exists and is run by the operator: check out the rollback-capable tag of the previous version and run its platform upgrade script; the wiring parameters are read back from the live environment and are not lost.
- A rollback **usually does not** require redeploying execution regions; only if the new version changed the execution-region stacks do you "Redeploy" once on the page, and that uses the old code.
- The metadata database engine is not downgraded (RDS does not support major-version downgrades); the old version runs as before on the new engine.
- Workflows / scheduled jobs that were republished and sync tasks that were saved after the upgrade must be published / saved once more on the pages after the rollback before their artifacts are regenerated on the old version.
- After the rollback the footer shows the old tag; the old version's known issues reappear as expected.

## 2. Decommissioning an execution region

Page path: "System → Execution Environments" → click the environment to open its details page → "Danger zone" at the bottom. The details page offers only the one path that matches the environment's actual state.

### 2.1 An environment that never came up

- The deployment failed and the target region holds none of its resources: in the "Discard this execution environment" section of the "Danger zone", click "Discard this environment", type the environment's identifier in the dialog and click "Discard".
- The environment shows "Deleted", the region's slot is released and you can register again.

### 2.2 An environment that was once up

| Step | Action | What you should see |
|---|---|---|
| ① Drain | On the details page "Drain (stop accepting new work)" → "Drain this execution environment?" → "Confirm drain"; or in the "Delete execution environment" panel click "1. Stop accepting work (drain)" → "Stop accepting work"; the two are equivalent | "Current intent: draining — not accepting new work (in-flight jobs still run to completion)"; "Stopped accepting work: new bindings / schedules / runs are all rejected"; no resources are destroyed |
| ② Request deletion | "2. Request deletion" in the "Delete execution environment" panel → look at "Bound resources", "Enable scheduling" and "Running runs" under "Pre-delete checks (all must be 0):" | You can continue only when all three are 0; when a source cannot be read it says so honestly, "Some sources could not be read, so zero cannot be confirmed (unreadable is not the same as none)", and refuses |
| ③ Confirm | Fill in "Reason (required, recorded in the audit log)", type the region name under "Type the region name to confirm:" and click "Confirm deletion" | "Deletion request submitted; waiting for a platform admin to approve" |
| ④ Approve | The platform admin clicks "Approve" (or "Reject") on the "Delete execution environment" item in the "Pending my approval (N)" card at the top of the "System → Workspace" page; on approval the server recomputes the impact preview and refuses if it differs from the one at request time | "Deletion approved, but destruction has not started yet" → "Destroying" |
| ⑤ Destroy | The platform deletes the managed services first, then the component stacks in reverse dependency order; if it gets stuck the panel offers "Retry destruction" (reusing the same deletion plan and the same final snapshot name) | Status "Deleted" |
| ⑥ Wrap-up | The operator runs the platform upgrade script once to withdraw the control plane's release of that region | — |

- When "Bound resources" is not 0, click "Go unbind these tasks" and rebind or delete the jobs / sync tasks / workflows bound to that region; turn off enabled schedules first; wait for running runs to finish.
- Draining can be undone: on the details page "Resume accepting new work" → "Resume accepting new work?" → "Confirm"; after resuming, the environment returns to "Running" only after the next probe is all green, "If the probes are not all green it stays in Draining and shows the reason."
- The page says it verbatim: "Drain ≠ delete: deleting an environment uses a separate destruction flow (impact preview → type the name to confirm → approval → destroy; data buckets are kept)".
- You cannot drain while a deployment session is still in flight (the page tells you to finish it before draining); the per-region warehouse credentials managed by the system are deleted automatically by the reclaim job, and an in-flight reclaim job blocks the deletion of the execution environment — wait for it to finish, then request again.

### 2.3 Which resources are kept and keep billing

| Resource | When the environment is deleted | Afterwards |
|---|---|---|
| Data-lake bucket, S3 Tables table bucket | Kept | Billed for storage; clean up separately after a human confirms |
| Warehouse namespace / workgroup and the final snapshot | Kept | Snapshot storage keeps billing |
| The region's data-domain CMK and its alias | Kept | A fixed monthly fee per key; deleting the key makes the data permanently undecryptable |
| The MWAA Serverless DAG bucket | Kept | Storage billing |
| Regional audit table, result table and residency bucket of a non-home jurisdiction | Kept | This is the customer's audit and result data; the platform does not decide for you |
| VPC, interface endpoints, IAM roles, Glue / EMR / Flink / DMS and other compute resources | Destroyed | The idle base price of the interface endpoints disappears with them |

- The page text "Retained (not deleted): data resources must be cleaned up separately after a human confirms; the platform does not decide for you" refers to the first five rows above.
- The read-only commands for listing leftovers (S3 buckets, table buckets, warehouse snapshots, KMS aliases) are in [`../deployment.md`](../deployment.md) §7bis and `AGENTS.md` §4.
- The full page steps and screenshots are in [Scenario: data stays in its region](22-scenario-multi-region-residency.md).

## 3. Decommissioning the whole platform

Stated plainly:

- The product has **no** "Uninstall platform" button and the manual has no procedure for decommissioning the whole platform; taking the whole platform down is a write operation by the operator on the customer's account, handled stack by stack, and every step needs the customer's explicit confirmation.
- Suggested order: first decommission every execution region one by one as in §2 (so the fate of data resources is decided region by region), then stop the scheduled and streaming tasks in the home region, and finally have the operator delete the home-region CDK stacks. The manual does not list a deletion order;
  deleting in the reverse order of the install script is safest: first the six stacks EMR / Flink / Realtime / Audit / home-region MWAA Serverless entry / execution-environment deployer, then the platform stack, then the three agent stacks, then the three OpenMetadata stacks (service / search / database), then the demo source database (demo mode only) and the home-region Redshift, and last FinOps / DynamoDB / Cognito / VPC / WAF / KMS; when a stack cannot be deleted, follow the export dependency that CloudFormation reports and delete the referencing stack first.
- Deleting stacks **does not delete data**: every object below is set to be retained; after the stacks are deleted they remain in the account and keep billing, and each must be confirmed by a human before it is deleted.

| Retained object | Notes |
|---|---|
| All `bgp-*` DynamoDB tables | Platform metadata, run ledgers, audit; point-in-time recovery is on |
| Cognito user pool | All accounts and role groups |
| The two KMS CMKs (data / logs) | Deleting them makes the related data permanently undecryptable; there is a deletion waiting period |
| Home-region data-lake bucket, Glue scripts bucket, DAG bucket, S3 Tables table bucket, Athena workgroup, Redshift namespace | Business data and artifacts |
| OpenMetadata's RDS MySQL (deletion protection on) and OpenSearch domain | Catalog and lineage |
| CloudTrail log bucket, VPC flow log group | AWS-level audit evidence |
| Platform secrets in Secrets Manager (such as the OpenMetadata admin password and the origin verification header) | Password-type objects |
| Retained items of each execution region | See §2.3 |

- The deletion order and whether each object is deleted should be written down as a checklist signed by the customer before anything is executed; neither the platform nor the handover engineer deletes data on your behalf.
- Export the data you need before decommissioning: a snapshot or UNLOAD for the warehouse, leave the data lake in its buckets, export audit logs as needed.

## 4. Common problems

| Symptom | Cause | Next step |
|---|---|---|
| After the upgrade, creating / redeploying an execution region fails at the very first step | The old version has a known deployment-guard false positive when the home region is outside the US | Follow the transition steps in that version's manual §8, then "Resume" → "Redeploy"; the new version fixes it at the root |
| "Request deletion" is refused because a source cannot be read | One source of the impact preview is temporarily unreadable, and the platform does not treat "unreadable" as "none" | Retry later; if it stays unreadable, have the operator look at that region's probes |
| The bill does not drop to zero after deletion | Data resources are kept by design | Clean up by hand against the §2.3 list |
| After a rollback, workflows run on the new version's artifacts | Scheduler artifacts are generated at publish time | "Publish to scheduler" again on the page |
| After the upgrade the new version number does not appear in the Flink job logs | The runtime is provided by the managed service; the JAR is loaded only after a stop / start | "Stop" → "Start" once; the application's code version is authoritative |

## 5. Further reading

- Authoritative commands for upgrade / rollback / decommissioning an execution region: [`../deployment.md`](../deployment.md) §7bis, §7ter, §7ter.2
- Upgrade notes for each version: `CHANGELOG.md` at the repository root
- Adding an execution region: [Deployment](06-deployment.md) §5, [`../adding-a-region.md`](../adding-a-region.md)
- Monthly cost and the cost of retained resources: [`../cost-model.md`](../cost-model.md), [Plan the deployment](05-plan-deployment.md)
