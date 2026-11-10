# Ask-Your-Data → Requests → Development Delivery Pipeline (Insight-to-Delivery)

> 📌 **Scope note (reconciled 2026-10-13)**: this document was written during the single-region stage and records the design as it stood at that time (including the audit-calibration annotations of 2026-08); **the current implementation is defined by the code**. For the multi-region behavior — place, execution scope, per-region scheduling and so on — see the multi-region execution [specification](./multi-region-execution-spec.md) and [design](./multi-region-execution-design.md); the current status of each module is summarized in the [modules overview](../modules.md). A path mentioned in this document that no longer exists means that the idea was not implemented as described here or has since been superseded.

> - Design revision: 1.14.0 | Status: implemented
> - Related designs: [GenBI (Ask-Your-Data)](./genbi.md), [ETL jobs](./etl-jobs.md) (job development), [multi-tenancy / RBAC / approvals](./multitenancy-rbac.md), and audit logging (the authentication-and-audit design, not published separately)

## 1. Background and goals

GenBI (Ask-Your-Data) lets business users obtain analysis results in natural language. When a result is satisfying, it actually represents a **reusable business need** — but until now it was a one-off question and answer that could not be captured, could not flow through a process, and could not materialize into a runnable data product.

This module upgrades the "one-off question and answer" into a **governable, assignable, deliverable** development pipeline:

```text
insight (GenBI) → raise as request → manager intake / assignment → development (LLM-assisted implementation + ETL job creation) → review → delivery to production
```

### Key product decisions (resource gatekeeping)

- **The requesting side (GenBI users) can only "raise a request"**; the Ask-Your-Data page has **no entry point whatsoever** for generating ETL / creating jobs. Rationale: business users do not master the technical details, and a directly generated task may be defective; more importantly, **periodic ETL tasks consume compute resources continuously**, so their generation and creation must be **gated in the development department and reviewed**, otherwise resources are uncontrolled and waste and unpredictability follow easily.
- **LLM-generated implementation + ETL job creation happen only in the "Requests" workbench and only by the assigned developer**; generated code is **not executed automatically** by default and must be reviewed by the developer; once the job is created it enters the development department's existing run / scheduling / versioning / lineage controls.

## 2. Role model

A minimal extension on top of the existing RBAC (see the [multi-tenancy / RBAC design](./multitenancy-rbac.md)); three kinds of roles are kept strictly apart, all of them effective within a **workspace (projectId)**:

| Role | Cognito group | Capabilities |
|------|-----------|------|
| Platform administrator | `bgp-admin` | Super user: all capabilities of manager + developer, across projects |
| Data product / development manager | `bgp-manager` (new) | Intake, set priority, assign a developer, reject, accept / send back |
| Developer | `bgp-developer` | Takes on requests **assigned to them**: start, invoke the LLM to generate an implementation, create an ETL job, submit delivery |
| Requester | any logged-in user | Raise requests from GenBI, comment, cancel their own requests |

`isManager(identity) = groups ∋ bgp-manager || isPlatformAdmin`. Developer actions are authorized by **assignee == caller** (assignment is authorization), manager actions by `isManager`; the two are decoupled — a manager cannot overstep into developer actions (unless assigned), and a developer cannot assign.

Visibility (within a project; the caller must be a member of that project or a platform administrator):
- `mine`: raised by me (requesterSub == me)
- `assigned`: assigned to me (assigneeSub == me)
- `inbox` / `all`: visible only to `isManager` (intake inbox / everything)

## 3. State machine

```text
 draft ──submit──▶ submitted ──assign──▶ assigned ──start──▶ in_development
                      │  ▲                                        │
                  reject │ reopen                          submit_delivery
                      ▼  │                                        ▼
                   rejected                                   in_review
                                                          ┌──────┴───────┐
                                                     approve          request_changes
                                                          ▼               ▼
                                                      delivered      in_development
  (any non-terminal state) ──cancel──▶ cancelled
```

States: `draft | submitted | assigned | in_development | in_review | delivered | rejected | cancelled`
(a submission from GenBI enters `submitted` directly; `draft` is reserved for manual drafts.)

| Action | Allowed role | from → to | Notes |
|------|---------|-----------|------|
| `submit` | requester | draft → submitted | |
| `assign` | manager | submitted / assigned / rejected → assigned | sets assignee + priority + dueDate |
| `reject` | manager | submitted / assigned → rejected | with a reason |
| `reopen` | manager / requester | rejected / cancelled → submitted | |
| `start` | assignee | assigned → in_development | |
| `submit_delivery` | assignee | in_development → in_review | with implementation notes / job link |
| `request_changes` | manager | in_review → in_development | with review comments |
| `approve` | manager | in_review → delivered | terminal state |
| `cancel` | requester / manager | non-terminal → cancelled | |
| `comment` | anyone with visibility | no state change | |

Every transition and every comment appends an `activity` record (actor / action / fromStatus / toStatus / note / ts), forming the request's activity timeline (traceable for audit).

## 4. Data model

**One new table** `bgp-requirements` (pk = the constant `"requirement"`, sk = `requirementId` (ULID)), following the approvals pattern of "a single logical partition + ULID sort key + Query/Scan filtering", with zero additional GSIs (the request volume is comparable to approvals). Comments and state transitions are **embedded in `activity[]`**; a single item stays far below the DynamoDB 400 KB limit.

```ts
interface Requirement {
  requirementId: string;
  projectId: string;           // 租户隔离
  title: string;
  description: string;
  priority: "P0" | "P1" | "P2" | "P3";
  status: RequirementStatus;
  businessValue?: string;      // 业务价值
  acceptanceCriteria?: string; // 验收标准
  // 来源（GenBI 洞察快照）
  source?: {
    kind: "genbi";
    question: string;
    sql: string | null;
    columns: string[];
    sampleRows: (string | null)[][]; // 截断样例
    chartType?: string;
  };
  // 人员
  requesterName: string; requesterSub?: string;
  assigneeName?: string; assigneeSub?: string;
  // 研发实现产物（仅研发侧写入）
  implementation?: {
    targetType: "redshift" | "glue";
    generatedCode?: string;    // 大模型生成、未必执行
    explanation?: string;
    etlJobId?: string;         // 一键建作业后关联
    generatedAt?: string; generatedBy?: string;
  };
  dueDate?: string;
  activity: ActivityEntry[];   // 时间线（流转 + 评论）
  createdAt: string; updatedAt: string;
  assignedAt?: string; deliveredAt?: string;
}
```

## 5. LLM-generated implementation (AI assistance on the developer side)

`lib/requirements/codegen.ts`, reusing Bedrock Converse (the same client / Opus model / region as GenBI):

- Input: request title + description + acceptance criteria + source SQL + target type (redshift / glue) + the Redshift schema catalog (reusing GenBI's `introspectSchema`).
- System-prompt constraints: **read-only sources**, **idempotent** (`CREATE TABLE IF NOT EXISTS` + re-entrant INSERT/MERGE/TRUNCATE-reload), **parameterized** (business date `${ds}`, aligned with the [ETL run parameters design](./etl-run-parameters.md)), **standard naming**, **well commented**, production-readable.
- Output: implementation code + a short explanation. **Never executed automatically.**
- Landing: after the developer's review, call `/create-job` → reuse the existing ETL job creation logic to write to `bgp-etl-jobs` (with a `lineageId`); the request and the job are linked in both directions (`implementation.etlJobId`). From then on, run / scheduling / test run / backfill / versioning / lineage all go through the development department's existing controls.

## 6. API

| Method and route | Role | Description |
|-----------|------|------|
| `POST /api/requirements` | project member | Create a request (GenBI source or manual) → submitted |
| `GET /api/requirements?box=` | member | Role-aware list (mine/assigned/inbox/all) |
| `GET /api/requirements/[id]` | anyone with visibility | Details |
| `POST /api/requirements/[id]/transition` | guarded | Unified state machine `{action, note?}` |
| `POST /api/requirements/[id]/assign` | manager | `{assigneeName, assigneeSub?, priority?, dueDate?}` |
| `POST /api/requirements/[id]/comment` | anyone with visibility | `{text}` |
| `POST /api/requirements/[id]/generate` | assignee | `{targetType}` → LLM-generated implementation |
| `POST /api/requirements/[id]/create-job` | assignee | Create an ETL job from the generated code and link etlJobId |
| `GET /api/requirements/assignees` | manager | The list of assignable members of the current project |

All of them use `resolveIdentity` + project-membership check + role guards; write actions call `recordAudit`.

## 7. Front end

- **GenBI page**: the result area gains a "Raise as request" button → a modal (title / priority / business value / acceptance criteria; pre-filled with question + sql + sample rows). **No generation / job-creation entry point of any kind.**
- **Requests workbench `/requirements`**: role-aware tabs (Submitted by me / Pending intake / Assign to me / All) + a request table (priority / status tags) + a details drawer: source insight, description / acceptance criteria, activity timeline, comments, and **an action area shown by role** (manager: assign / reject / accept / send back; developer: start / generate implementation / create job / submit delivery; requester: cancel).
- **Sidebar**: a "Requests" entry (below Ask-Your-Data).

## 8. Security and resource governance summary

- **Separation of duties** between the requesting side and the development department: capturing insights (requesters) ↔ technical implementation and resource creation (development department), enforced by the state machine and role guards.
- Generated code is **not executed automatically**; ETL jobs **can only be created by developers**, and once created they enter the existing scheduling / resource controls, so requesters cannot spin up periodic tasks directly and lose control of resources.
- Audited end to end; tenant (projectId) isolation; privilege overreach (a developer assigning, a requester generating) is rejected with 403 at the API layer.
