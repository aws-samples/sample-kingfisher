# Fault Diagnosis (AWS DevOps Agent)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is summarized in the [modules overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> - Design revision: 1.22.0 | Status: implemented
> - Related designs: [ETL jobs](./etl-jobs.md) (job development), Task Monitor (no separate design document), [Athena / S3 Tables](./athena-s3tables.md)

## 1. Background and goals

The platform can already show task failures and logs (revision 1.21.0), but "why did it fail and how do I fix it" still relied on manual troubleshooting. This module integrates the **AWS DevOps Agent** (the autonomous SRE agent managed by AWS, signingName `aidevops`, GA in 2026, us-east-1 only) — for one failed run it **automatically investigates, locates the root cause, and produces a structured diagnosis report** (root cause + actionable fix + prevention advice), significantly improving observability and MTTR.

**Key point: use the real AWS service, not a home-built agent.**

## 2. Why it is feasible (proven by probes)

- The service is reachable: in the test account `aidevops.us-east-1.amazonaws.com` answers, and `ListAgentSpaces` succeeds.
- The Node SDK is available: `@aws-sdk/client-devops-agent`.
- The integration model was proven empirically: `CreateAgentSpace` (once) → `CreateChat` → `SendMessage` (send a fault prompt with ample evidence) → collect `contentBlockDelta.delta.textDelta.text` from the event stream and concatenate it into the report. One pass produces a complete, structured RCA in Chinese in about 20–40 s, and the diagnosis is accurate.

## 3. Architecture

```text
failed run (Task Monitor / job run history) ──"AI Diagnosis"──► POST /api/diagnostics (viewer)
        │                                                        │ create a running record (bgp-diagnostics) + background fire-and-forget
        │ front end polls GET /api/diagnostics/[id] every 3 s     ▼
        └────────────◄── report dialog ◄──── background: buildIncidentContext(evidence) → DevOps Agent.investigate → store done/failed
                                                                  │
                                            AWS DevOps Agent (aidevops): ensureAgentSpace(bgp-devops-agent)
                                            → CreateChat → SendMessage → collect the reply → (the Agent correlates CloudWatch etc. on its own)
```

Reason for the asynchronous design: a DevOps Agent investigation takes tens of seconds, longer than the CloudFront 60 s origin timeout → the submission returns immediately, the investigation runs in the background, and the front end polls.

## 4. Infrastructure (CDK)

- **TaskRole** gains `aidevops:*` (discover / create Agent Spaces, CreateChat / SendMessage, ListJournalRecords / Recommendations, and so on).
- **bgp-diagnostics** table (DatabaseStack): `pk="diagnostic"`, `sk=diagnosticId(ULID)`. Stores taskId / runId / taskType / resourceName / projectId / status / report / agentSpaceId / executionId / createdBy / timestamps.
- No hard-coded Agent Space id: `ensureAgentSpace` discovers / creates it by the name `bgp-devops-agent` (self-heals after a temporary account is reclaimed, and nothing account-specific enters the public repository).

## 5. Back end (`lib/diagnostics/*` + `app/api/diagnostics/*`)

- `devops-agent.ts`: `ensureAgentSpace()` (ListAgentSpaces by name / CreateAgentSpace) + `investigate(prompt)` (CreateChat → SendMessage → `collectText`, compatible with both an events array and an event stream; asks one follow-up question only when the first reply is too short, to avoid duplication).
- `evidence.ts`: `buildIncidentContext(taskId, runId)` — fetches the run record + the job / workflow / sync definition (script / SQL) + **real logs / errors** (for Glue, `GetJobRun.ErrorMessage` + the relevant trailing lines of CloudWatch `/aws-glue/jobs/error`; for Redshift, the sub-statement errors from the Data API `DescribeStatement`) + runtime facts (the S3 Tables catalog conventions, and so on), and assembles a Chinese-language prompt that is "rich in evidence and demands a direct conclusion".
- `service.ts`: `startDiagnosis` (creates the running record + background fire-and-forget investigation → stores done/failed), `getDiagnostic`, `listDiagnostics`.
- API: `POST /api/diagnostics` (viewer, start), `GET /api/diagnostics?taskId=&runId=` (list), `GET /api/diagnostics/[id]` (poll). The operations-analyst account gets 403 through the gateway allow-list (diagnosis is an operations capability).

## 6. Front end

- Reusable component `components/common/DiagnosisButton.tsx`: click → POST → a dialog shows a "DevOps Agent is investigating" spinner → polls every 3 s → renders the report (pre-wrap markdown) + a `done` tag + a "manual review recommended" notice.
- Entry points: failed rows in **Task Monitor** and failed rows in the **job development run history** gain an "AI Diagnosis" button.

## 7. Live verification

- API: POST a diagnosis for a real failed run (Glue `REQUIRES_SINGLE_PART_NAMESPACE`) → done after 42 s → a 3605-character structured RCA report (fault summary / root cause + evidence chain / fix including the catalog-registration code / prevention advice), accurate diagnosis, reusing the Agent Space `bgp-devops-agent`.
- Playwright: "AI Diagnosis" on a failed Task Monitor row → the dialog "Fault diagnosis report (AWS DevOps Agent)" → the report renders (fault summary / fix recommendations / prevention advice) + a green `done`.

## 8. Future extensions

- Trigger diagnosis automatically on failure (rather than manually only); feed the DevOps Agent's Recommendations / Mitigation specs into the requirement pipeline; connect more observation sources (X-Ray, custom MCP); a diagnosis history list page.
