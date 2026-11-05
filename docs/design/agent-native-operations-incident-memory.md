# Part A — Incident knowledge base (Incident Memory) + diagnosis agent upgraded to AgentCore

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is summarized in the [modules overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.
> ⚠️ **Implementation differences**: `infra/agent/devopsdiag` was not implemented; the operations diagnosis agent runs inside the platform process at `platform/src/lib/diagnostics/devops-agent.ts` (API `platform/src/app/api/diagnostics/`). The Backfill Center (Part C) was implemented as the `/backfill` page plus `platform/src/lib/backfill/`.

> Revision: 1.0 **✅ implemented (in-process path)** (documentation audit calibration of 2026-08-26: the original status header was out of date; the "diagnosis upgraded to AgentCore / independent devopsdiag stack" proposed by this document was not adopted) | Created: 2026-07-12 | Priority: **P0** (core of the moat) | Capability groups: diagnosis agent upgraded to AgentCore + incident memory (new)
> Upstream master design: [agent-native operations](./agent-native-operations.md) | Reuse: the fault-diagnosis module's `lib/diagnostics/` · `bgp-diagnostics` · the [AgentCore standard](./agentcore-standard.md) · [GenBI semantic retrieval](./genbi-semantic-retrieval.md) · `bgp-task-runs`
> **Purely additive; does not change the main flow of the fault-diagnosis module.** A hook attached after diagnosis completion persists the incident; a new, independent AgentCore agent is added while the old in-process path is kept as the fallback.

---

## 1. Feature overview

Current state (the [fault-diagnosis module](./devops-agent-diagnostics.md)): a task fails → a DevOps Agent investigation is triggered manually or automatically → a structured RCA is produced and stored in `bgp-diagnostics` → **used once and thrown away**. When the same kind of failure happens again, the agent gathers evidence from scratch, which is slow and may give inconsistent conclusions, and **the platform has no memory at all of how this customer fixed it last time**.

This design adds two things and thereby forms the moat:

1. **Incident knowledge base (Incident Memory)**: after every diagnosis reaches `done`, it is normalized into one **structured incident** (symptom fingerprint / root cause / suggested fix / whether verified / recurrence count) and **merged by signature** — when the same kind of failure recurs, the count is incremented and the timeline is appended instead of a duplicate entry being created. Over time this accumulates "symptom → verified fix" pairs specific to this deployment.
2. **Diagnosis agent upgraded to the AgentCore standard**: copying the [AgentCore standard](./agentcore-standard.md)'s "each AI capability = an independent Gateway + Runtime + Memory", add a `devopsdiag` agent and give it two MCP skills — `lookup_incident_history` (look up historical verified fixes in this knowledge base) and the reused GenBI skill `lookup_business_context` (inject business definitions). The diagnosis prompt goes from "evidence gathering with zero context" to "gathering evidence with this customer's historical fixes and business semantics in hand": more accurate RCA, shorter MTTR.

**Differentiation**: the copilot of a leading cloud data-development suite only generates code and knows nothing about operations history; AWS DevOps Agent understands infrastructure but is a "stranger" every time and does not remember your pipelines. **"A diagnosis agent that understands your pipelines better the more you use it"** is a capability that compounds with each customer and that a competitor holding an empty framework cannot catch up with.

---

## 2. User stories

- As a **data operations engineer**, when `dim_channel` fails yet again with `REQUIRES_SINGLE_PART_NAMESPACE`, I want the diagnosis report to tell me directly "this has the same cause as the incident on 07-08; the fix last time was X and it has been verified to work", instead of reading the logs all over again.
- As a **data developer**, I want to search historical failures on the knowledge-base page by "most recurrences / unresolved / a given task" and see the **verified fix runbook** for each failure class, so that even a newcomer can fix it by following the runbook.
- As an **architect / director**, I want to see the "health of the incident knowledge base" — how many failure classes already have a verified fix, the average MTTR trend, the top recurring failures — to quantify the operational maturity of the platform and to back the external narrative (the moat) with data.
- As the **platform**, I want this knowledge base to be structured enough to be **exported in redacted form** as evaluation scenarios (the raw material of DataOps-Bench).

---

## 3. Interaction design

**Entry 1 — enhanced diagnosis report (reuses the fault-diagnosis module's `DiagnosisButton` dialog; a purely additive block)**:
If the report hits history, an Alert is shown at the top of the report:
```
🔁 Similar incident history: this failure shares its signature with 3 historical incidents (signature: glue::REQUIRES_SINGLE_PART_NAMESPACE).
   Most recently fixed and verified on 2026-07-08 by admin:
   "Register the S3 Tables catalog (spark.sql.catalog.s3tablescatalog=...) and rerun"
   [View fix details]  [Apply this fix to this run]
```

**Entry 2 — new page `/incidents` (Incident Knowledge Base)**:
- Four cards at the top (reusing the `charts.tsx` style): number of failure classes / verified-fix coverage / MTTR over the last 30 days / top recurring failure.
- Main list: one row per **failure class**, merged by signature — signature / number of affected tasks / recurrence count / first and last occurrence / status (unresolved / verified fix / silenced) / actions.
- Expanding a row: the timeline (runId / time / trigger of every occurrence) + the verified fix runbook (markdown) + links to the related diagnosis reports + the "Mark fix as verified / Edit fix runbook" buttons.
- Filters: status / task type / time window / search by signature keyword.

**Entry 3 — knowledge-base health (can be embedded as one read-only card on the Ops Dashboard `/ops`)**: reuses the dashboard card style; does not change the existing cards of `/ops`, only appends one.

The prototype is a plain antd Table plus hand-drawn SVG cards, unrelated to ReactFlow, consistent with `/alerting` / `/monitor`.

---

## 4. API design (new `app/api/incidents/**`; does not occupy any existing segment)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/api/incidents` | viewer | Knowledge-base list (merged by signature); supports `?status=&taskType=&q=&window=` |
| GET | `/api/incidents/[signature]` | viewer | Details of one failure class: timeline + fix runbook + related diagnoses |
| PUT | `/api/incidents/[signature]/resolution` | editor | Maintain the "verified fix runbook" (markdown) + mark `verified` (optimistic lock `version`) |
| POST | `/api/incidents/[signature]/silence` | editor | Silence this class (known harmless / scheduled for later), `silenceUntil` |
| GET | `/api/incidents/health` | viewer | Knowledge-base health aggregate (number of classes / fix coverage / MTTR / top recurrences) |
| GET | `/api/incidents/export` | admin | Redacted export (raw material of DataOps-Bench, see section 8), `?format=jsonl` |
| POST | `/api/incidents/lookup` | internal / gateway | Callback for the AgentCore `lookup_incident_history` skill, `{signature|errorText}` → historical verified fixes |

> **No `POST /api/incidents` (create) is added**: incidents are written only internally by the diagnosis-completion hook; external creation is not exposed, which keeps the data source single and trustworthy.

---

## 5. Data model (DynamoDB, 1 new table `bgp-incidents`, `hardened`)

Merged by signature — **one master record per signature + a number of occurrence sub-items**. A single table with two item kinds (copying the pk / sk spreading idea of `bgp-alert-events`):

| Item | PK | SK | Purpose |
|---|---|---|---|
| Failure-class master record | `pk="incident#<projectId>"` | `sk="sig#<signature>"` | The merged class: recurrence count / status / verified fix runbook / first and last occurrence |
| Single occurrence record | `pk="incident#<projectId>"` | `sk="occ#<signature>#<ts-iso>#<ulid>"` | A snapshot of each occurrence: runId / taskId / diagnosis report digest / evidence fingerprint, **TTL 180d** (the master record has no TTL; it is persisted permanently) |

**Key fields of the master record**:
```
projectId, signature, title,
status: "unresolved" | "resolved-verified" | "silenced",
occurrenceCount,                 // recurrence count
affectedTasks: string[],         // deduplicated task names
firstSeenAt, lastSeenAt,
rootCauseSummary,                // root cause summarized by the most recent diagnosis (may be overridden by the fix runbook)
resolution: {                    // the manually maintained "verified fix runbook"
  markdown, verified: boolean, verifiedBy, verifiedAt,
  fixKind?: "config" | "code" | "backfill" | "infra" | "data",
  backfillHint?: { taskId, dateRange }   // if the fix is a backfill, used by Part C for one-click linkage
},
mttrStats: { lastMttrSec?, avgMttrSec?, samples },
silenceUntil?, version,          // optimistic lock
createdAt, updatedAt
```

**Key fields of a single occurrence record**:
```
projectId, signature, occurredAt,
taskId, taskName, taskType, runId,
diagnosisId,                     // link to bgp-diagnostics (the full report lives there; only a digest is stored here)
symptomDigest,                   // symptom digest (error code / first line / engine)
resolvedAt?,                     // when this occurrence recovered (used for MTTR)
ttl
```

### 5.1 The signature algorithm — the core of merging

Goal: the same kind of failure merges stably, different kinds are not merged by mistake. Deterministic extraction by type (`lib/incidents/signature.ts`, a pure function, unit-testable):

- **Glue / EMR (Spark)**: prefer the error code / exception class name (`REQUIRES_SINGLE_PART_NAMESPACE`, `Py4JJavaError:<ExceptionClass>`, `OutOfMemoryError`), strip the variable parts (table names / paths / timestamps / numbers) and take the normalized template; `signature = taskType + "::" + normalizedErrorKey`.
- **Redshift**: SQLSTATE + error category (`Spectrum Scan Error`, `permission denied`, `disk full`).
- **Flink**: exception class + whether it is checkpoint-related.
- **DMS**: error category (connectivity / permission / LOB / validation).
- **Fallback**: shingling of the error text + normalization (strip numbers / UUIDs / paths), then a hash prefix, so that failures "without an explicit error code" still merge stably.
> The normalization rules live in one place and come with a unit-test corpus (real error strings taken from the engineering handover notes and historical QA records: `REQUIRES_SINGLE_PART_NAMESPACE`, `Spectrum Scan Error 15007`, `resolving configuration` and so on) to prevent wrong merges and missed merges.

---

## 6. Backend implementation

### 6.1 Persistence hook (A.1, zero intrusion into the fault-diagnosis module)
- New file `lib/incidents/record.ts`: `recordIncident(diagnostic)` — takes one `bgp-diagnostics` record in state `done` and internally:
  1. takes the error text from `diagnostic` + the related run → `computeSignature()`;
  2. conditionally writes the master record: if `sk="sig#..."` does not exist, create it (occurrenceCount=1); if it exists, `occurrenceCount +=1` and update `lastSeenAt` / `affectedTasks` (DynamoDB `UpdateItem` ADD / conditional write, idempotent);
  3. writes the single occurrence record `occ#...` (with diagnosisId, symptomDigest, TTL);
  4. if the master record already has `resolution.verified`, back-fills this occurrence's `resolvedAt` and updates the MTTR statistics.
- **Trigger point**: called at the "final-state owner" where the fault-diagnosis module's `getDiagnostic` lands in `done` (isomorphic to the [GenBI asynchronous execution](./genbi-async-execution.md) rule "the owner that writes the final state records the side effects", recorded exactly once). **If attaching a hook is impractical, the fallback**: a lightweight reconcile — `/api/incidents/health` or the learner DAG scans `bgp-diagnostics` for records that are `done` but not yet persisted and records them (idempotent, deduplicated by diagnosisId). Neither path changes the fault-diagnosis module's code; the hook is preferred and the fallback is the safety net.

### 6.2 Diagnosis upgraded to AgentCore (A.2)
- Copy the structure of `infra/agent/genbi/` to add `infra/agent/devopsdiag/` (`index.js` / `agent.js` / `mcp.js` / `Dockerfile` / `package.json`), per the AgentCore standard: an independent Gateway (MCP, `AWS_IAM`) + Runtime + Memory.
- **MCP skills**:
  - `lookup_incident_history({signature|errorText})`: calls back `POST /api/incidents/lookup` → returns the "verified fix runbook" for that signature + the recurrence count + the time of the most recent fix.
  - `lookup_business_context(...)`: **reuses** the existing GenBI skill ([GenBI semantic retrieval](./genbi-semantic-retrieval.md)) to inject business definitions (such as "amount unit", "exclude test data"), so that the fix suggestion does not violate governance definitions.
  - `get_incident_evidence(taskId, runId)`: wraps the evidence gathering of the fault-diagnosis module's `buildIncidentContext` (logs / errors / definitions) as a tool the agent can call.
- **The diagnosis orchestration becomes**: the `investigate` prompt first calls `lookup_incident_history` → on a hit, the agent is asked to "give its conclusion against the historical verified fix"; on a miss, the original evidence gathering runs. **The old in-process path `lib/diagnostics/devops-agent.ts` is kept** and switched by the `DEVOPSDIAG_AGENTCORE` flag (canary by default), isomorphic to the "dual path with fallback" used when GenBI moved to the cloud in the [AgentCore GenBI module](./agentcore-genbi.md) → zero behavior regression, can be downgraded at any time.
- The `bgp-diagnostics` table is reused unchanged; only the fields `usedIncidentHistory: boolean` and `agentSpaceId` (after the upgrade) are added.

### 6.3 Health aggregation
- `lib/incidents/health.ts`: pure aggregation (number of classes / `resolved-verified` coverage / average MTTR over the last 30 days / top recurrences), **zero new tables**, in the same spirit as the governance health score of the [governance deepening module](./governance-deepening.md).

---

## 7. AWS service dependencies

- **DynamoDB** `bgp-incidents` (hardened: CMK / PITR / RETAIN).
- **Bedrock AgentCore** (after the upgrade): new Runtime `bgp_devopsdiag_agent` + Gateway `bgp-devopsdiag-gateway` (`AWS_IAM`) + Memory, as a gated stack (following the AgentCore standard's `-c enable-*`).
- **AWS DevOps Agent** (`aidevops`, us-east-1): reuses the permissions and the Agent Space `bgp-devops-agent` the fault-diagnosis module already has (after the upgrade it is called from inside the AgentCore Runtime or kept as a direct call — one of the two, following the AgentCore standard's implementation convention).
- **CloudWatch / Glue / Redshift Data API**: reuses the fault-diagnosis module's `evidence.ts` for evidence gathering; no new permission surface.
- TaskRole: only read / write on `bgp-incidents` is needed; AgentCore-related permissions live on the Runtime execution role (following the AgentCore standard).

---

## 8. Security considerations

- **Persist only metadata, never sensitive data** (inheriting the iron rule of the [governance deepening module](./governance-deepening.md)): `symptomDigest` / `rootCauseSummary` are error codes and summarized text, and **the signature algorithm first normalizes away table names / paths / hosts / accounts / UUIDs / numbers**; sampled values, connection strings and secrets must never enter `bgp-incidents`. Everything passes through `redactEvidence()` before being written (reusing / aligned with the redaction on the diagnosis side).
- **The fix runbook is maintained manually**: `verified` can only be set by editor or above, so that an unconfirmed AI suggestion is never applied as "verified". "Apply this fix" (the Part C linkage) requires a second confirmation before it runs.
- **RBAC**: read viewer, write editor, export admin; analysis accounts coming through the gateway are decided for `/api/incidents` by the allow-list convention of the alerting module.
- **Export redaction (the section 8 contract)**: `/api/incidents/export` emits JSONL, one line `{signature, symptomTemplate(normalized), taskType, engine, rootCauseCategory, resolutionKind, mttrSec}` per record, containing **no** customer identifier, real table name or raw log text — this is the safe export contract of DataOps-Bench, locked down from day one to avoid leakage when it is published externally later.
- **AgentCore**: Gateway `AWS_IAM`, SigV4 (following the AgentCore standard); Memory does not store raw sensitive evidence.

---

## 9. Acceptance criteria (headless / real calls; contract-guard once before and once after)

- [ ] **A.1**: trigger a diagnosis for one real failure (such as Glue `REQUIRES_SINGLE_PART_NAMESPACE`) → after `done`, `bgp-incidents` contains 1 master record + 1 occurrence record, and the signature is correctly normalized (no table name / path).
- [ ] **Merge hard evidence**: make the same kind of failure happen once more → the master record has `occurrenceCount=2` and a 2-entry timeline, **and no second master record is created**; a different kind of failure (such as Spectrum Scan Error) → a new master record.
- [ ] **Signature unit tests**: `signature.ts` merges / distinguishes ≥8 real historical error strings (taken from QA records) exactly as expected (wrong merges = 0, missed merges = 0).
- [ ] **Redaction hard evidence**: construct an error string containing a table name / host / account → the signature / digest written to the store **does not contain** those sensitive tokens (grep assertion).
- [ ] **A.2**: diagnose again a same-signature failure that "was fixed before and verified" → the report cites the historical fix (`usedIncidentHistory=true`); cross-check on the AWS side that the AgentCore Runtime is `READY` and the skill was invoked (CloudWatch EMF).
- [ ] **Dual-path fallback**: with `DEVOPSDIAG_AGENTCORE=off`, diagnosis takes the original in-process path and behaves **pixel-identically** to the current fault-diagnosis module (zero regression).
- [ ] **Pages**: `/incidents` list / details / health render; the fix runbook PUT honors the optimistic lock (wrong version → 409).
- [ ] **contract-guard**: the 27-page L1 sweep + the 6 core-contract L2 verify show zero regression (in particular `/monitor`, `/alerting` and the diagnosis dialog are not broken).
