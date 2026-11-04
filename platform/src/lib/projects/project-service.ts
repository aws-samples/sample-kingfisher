// 模块 13 — 项目空间服务 (v1.4.0)
//
// DynamoDB-backed projects, memberships, approvals + role resolution. See
// docs/design/13-multitenancy-rbac/DESIGN.md for the model.

import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES, PROJECT_MEMBERS_BY_USER_INDEX } from "@/lib/aws/dynamodb";
import { ulid } from "ulid";
import type { Identity } from "@/lib/auth/identity";
import {
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
  DEFAULT_PROJECT_DESCRIPTION,
  PROJECTS_PK,
  APPROVALS_PK,
  ProjectRole,
} from "./constants";

export interface Project {
  projectId: string;
  name: string;
  description?: string;
  ownerSub?: string;
  ownerName?: string;
  system?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Member {
  projectId: string;
  username: string;
  sub?: string;
  email?: string;
  role: ProjectRole;
  addedAt: string;
  addedBy?: string;
}

export interface Approval {
  approvalId: string;
  projectId: string;
  type: string; // "membership" (others reserved for later pillars)
  /**
   * @kf-batch 50-WP4quater-reads(工单 SC-33)—— 这条审批**作用在哪些执行区**。
   *
   * 三类审批的区语义**本来就不同**,所以这个字段是可选的,不是「忘了填」:
   *   · `deploy`(晋升作业到受保护环境):被晋升的那个作业**有 `targets[]`** ⇒ 建审批时就能派生;
   *   · `membership`(入组):控制面动作,与区无关 ⇒ **不填**;
   *   · `data-access`(数据访问):对象是 `fqn`,而治理 fqn 至今没有区维(工单 SC-8)⇒ 暂不填。
   *
   * 🔴 读侧规则:**没填的一律不藏**(与治理约定「未声明 = 全平台通用」同一条道理)。
   * 审批收件箱是「我必须处理的事」——按一个它自己都不知道的维度把待办藏起来,
   * 是护栏 1「永远不让用户丢东西」的正面反例。
   */
  targetIds?: string[];
  status: "pending" | "approved" | "rejected";
  payload: Record<string, unknown>;
  requestedBy: string;
  requestedBySub?: string;
  requestedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
}

// ---- Projects --------------------------------------------------------------

export async function getProject(projectId: string): Promise<Project | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.PROJECTS, Key: { pk: PROJECTS_PK, projectId } })
  );
  return (Item as Project) || null;
}

export async function listAllProjects(): Promise<Project[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.PROJECTS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": PROJECTS_PK },
    })
  );
  return Items as Project[];
}

// Lazily create the default workspace so legacy resources (no projectId) have a home and
// the project switcher always has at least one entry. Idempotent.
export async function ensureDefaultProject(): Promise<Project> {
  const existing = await getProject(DEFAULT_PROJECT_ID);
  if (existing) return existing;
  const now = new Date().toISOString();
  const project: Project & { pk: string } = {
    pk: PROJECTS_PK,
    projectId: DEFAULT_PROJECT_ID,
    name: DEFAULT_PROJECT_NAME,
    description: DEFAULT_PROJECT_DESCRIPTION,
    system: true,
    createdAt: now,
    updatedAt: now,
  };
  await docClient.send(
    new PutCommand({
      TableName: TABLES.PROJECTS,
      Item: project,
      ConditionExpression: "attribute_not_exists(projectId)",
    })
  ).catch(() => {});
  return project;
}

export async function createProject(
  input: { name: string; description?: string },
  identity: Identity
): Promise<Project> {
  const now = new Date().toISOString();
  const projectId = `proj-${ulid()}`;
  const project: Project & { pk: string } = {
    pk: PROJECTS_PK,
    projectId,
    name: input.name,
    description: input.description || "",
    ownerSub: identity.sub,
    ownerName: identity.username,
    system: false,
    createdAt: now,
    updatedAt: now,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.PROJECTS, Item: project }));
  // Creator becomes owner.
  await putMember(
    projectId,
    { username: identity.username, sub: identity.sub, email: identity.email, role: "owner" },
    identity.username
  );
  return project;
}

export async function updateProject(
  projectId: string,
  fields: { name?: string; description?: string }
): Promise<Project | null> {
  const sets: string[] = ["updatedAt = :now"];
  const values: Record<string, unknown> = { ":now": new Date().toISOString() };
  const names: Record<string, string> = {};
  if (fields.name !== undefined) {
    sets.push("#n = :n");
    names["#n"] = "name";
    values[":n"] = fields.name;
  }
  if (fields.description !== undefined) {
    sets.push("description = :d");
    values[":d"] = fields.description;
  }
  const { Attributes } = await docClient.send(
    new UpdateCommand({
      TableName: TABLES.PROJECTS,
      Key: { pk: PROJECTS_PK, projectId },
      UpdateExpression: "SET " + sets.join(", "),
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    })
  );
  return (Attributes as Project) || null;
}

export async function deleteProject(projectId: string): Promise<void> {
  // Remove the project row and all of its membership rows.
  await docClient.send(
    new DeleteCommand({ TableName: TABLES.PROJECTS, Key: { pk: PROJECTS_PK, projectId } })
  );
  const members = await listMembers(projectId);
  await Promise.all(
    members.map((m) =>
      docClient.send(
        new DeleteCommand({
          TableName: TABLES.PROJECT_MEMBERS,
          Key: { projectId, username: m.username },
        })
      )
    )
  );
}

// ---- Members ---------------------------------------------------------------

export async function listMembers(projectId: string): Promise<Member[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.PROJECT_MEMBERS,
      KeyConditionExpression: "projectId = :pid",
      ExpressionAttributeValues: { ":pid": projectId },
    })
  );
  return Items as Member[];
}

export async function getMember(projectId: string, username: string): Promise<Member | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.PROJECT_MEMBERS, Key: { projectId, username } })
  );
  return (Item as Member) || null;
}

export async function putMember(
  projectId: string,
  m: { username: string; sub?: string; email?: string; role: ProjectRole },
  addedBy: string
): Promise<Member> {
  const member: Member = {
    projectId,
    username: m.username,
    ...(m.sub ? { sub: m.sub } : {}),
    ...(m.email ? { email: m.email } : {}),
    role: m.role,
    addedAt: new Date().toISOString(),
    addedBy,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.PROJECT_MEMBERS, Item: member }));
  return member;
}

export async function removeMember(projectId: string, username: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({ TableName: TABLES.PROJECT_MEMBERS, Key: { projectId, username } })
  );
}

export async function listProjectsForUser(username: string): Promise<Member[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.PROJECT_MEMBERS,
      IndexName: PROJECT_MEMBERS_BY_USER_INDEX,
      KeyConditionExpression: "username = :u",
      ExpressionAttributeValues: { ":u": username },
    })
  );
  return Items as Member[];
}

// Resolve the caller's effective role in a project. Strict membership model:
//   1. platform admin (bgp-admin)  → owner (super-user, for platform operations)
//   2. explicit membership row     → that role
//   3. otherwise                   → null (no access — including the default workspace)
//
// NOTE: there is intentionally NO implicit role for the default workspace. Every user
// (other than a platform admin) must be an explicit member to see/act on a project's
// resources. The default workspace simply holds legacy resources; access to it is granted
// by adding members, exactly like any other project.
export async function resolveRole(
  identity: Identity,
  projectId: string
): Promise<ProjectRole | null> {
  if (identity.isPlatformAdmin) return "owner";
  const member = await getMember(projectId, identity.username);
  if (member) return member.role;
  return null;
}

// Projects visible to the caller (for the switcher and /projects page).
// Platform admins see all projects; everyone else sees ONLY the projects they are a member
// of (no implicit default-workspace access).
export async function listVisibleProjects(
  identity: Identity
): Promise<Array<Project & { role: ProjectRole }>> {
  await ensureDefaultProject();
  if (identity.isPlatformAdmin) {
    const all = await listAllProjects();
    return all.map((p) => ({ ...p, role: "owner" as ProjectRole }));
  }
  const memberships = await listProjectsForUser(identity.username);
  const out: Array<Project & { role: ProjectRole }> = [];
  for (const m of memberships) {
    const p = await getProject(m.projectId);
    if (p) out.push({ ...p, role: m.role });
  }
  return out;
}

// All projects, annotated for the caller, so a non-member can DISCOVER projects and request
// access (the approval flow). Returns { ...project, myRole, pending } where myRole is null
// when the caller is neither a member nor a platform admin, and pending is true when the
// caller already has an open membership request for that project.
export async function listDiscoverableProjects(
  identity: Identity
): Promise<Array<Project & { myRole: ProjectRole | null; pending: boolean }>> {
  await ensureDefaultProject();
  const all = await listAllProjects();
  const myPending = await listApprovals({ requestedBy: identity.username, status: "pending" });
  const pendingSet = new Set(myPending.map((a) => a.projectId));
  const out: Array<Project & { myRole: ProjectRole | null; pending: boolean }> = [];
  for (const p of all) {
    const role = await resolveRole(identity, p.projectId);
    out.push({ ...p, myRole: role, pending: pendingSet.has(p.projectId) });
  }
  return out;
}

// ---- Approvals -------------------------------------------------------------

export async function createApproval(input: {
  projectId: string;
  type: string;
  payload: Record<string, unknown>;
  requestedBy: string;
  requestedBySub?: string;
  /** @kf-batch 50-WP4quater-reads(工单 SC-33)—— 作用区(只有能派生的类型才传;见 `Approval.targetIds`) */
  targetIds?: string[];
}): Promise<Approval> {
  const approvalId = ulid();
  const approval: Approval & { pk: string } = {
    pk: APPROVALS_PK,
    approvalId,
    projectId: input.projectId,
    type: input.type,
    status: "pending",
    payload: input.payload,
    requestedBy: input.requestedBy,
    ...(input.requestedBySub ? { requestedBySub: input.requestedBySub } : {}),
    // 🔴 空数组不写字段:写空数组会落到读侧「声明了但一个区都不匹配」⇒ 这条待办在所有视角里消失
    ...(input.targetIds && input.targetIds.length > 0 ? { targetIds: input.targetIds } : {}),
    requestedAt: new Date().toISOString(),
  };
  await docClient.send(new PutCommand({ TableName: TABLES.APPROVALS, Item: approval }));
  return approval;
}

export async function getApproval(approvalId: string): Promise<Approval | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.APPROVALS, Key: { pk: APPROVALS_PK, approvalId } })
  );
  return (Item as Approval) || null;
}

// List approvals (low volume → Scan). Optionally filter by project / status / requester.
export async function listApprovals(filter: {
  projectId?: string;
  status?: string;
  requestedBy?: string;
}): Promise<Approval[]> {
  const parts: string[] = ["pk = :pk"];
  const values: Record<string, unknown> = { ":pk": APPROVALS_PK };
  if (filter.projectId) {
    parts.push("projectId = :pid");
    values[":pid"] = filter.projectId;
  }
  if (filter.status) {
    parts.push("#s = :st");
    values[":st"] = filter.status;
  }
  if (filter.requestedBy) {
    parts.push("requestedBy = :rb");
    values[":rb"] = filter.requestedBy;
  }
  const { Items = [] } = await docClient.send(
    new ScanCommand({
      TableName: TABLES.APPROVALS,
      FilterExpression: parts.join(" AND "),
      ...(filter.status ? { ExpressionAttributeNames: { "#s": "status" } } : {}),
      ExpressionAttributeValues: values,
    })
  );
  return (Items as Approval[]).sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
}

export async function decideApproval(
  approvalId: string,
  decision: "approved" | "rejected",
  decidedBy: string,
  reason?: string
): Promise<Approval | null> {
  const { Attributes } = await docClient.send(
    new UpdateCommand({
      TableName: TABLES.APPROVALS,
      Key: { pk: APPROVALS_PK, approvalId },
      UpdateExpression: "SET #s = :s, decidedBy = :db, decidedAt = :da, reason = :r",
      ConditionExpression: "#s = :pending",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": decision,
        ":db": decidedBy,
        ":da": new Date().toISOString(),
        ":r": reason || "",
        ":pending": "pending",
      },
      ReturnValues: "ALL_NEW",
    })
  );
  return (Attributes as Approval) || null;
}
