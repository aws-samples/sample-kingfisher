// 模块 22 — 需求流水线服务 (v1.14.0)
//
// 需求（Requirement）：把 GenBI 洞察沉淀为可治理、可指派、可交付的研发需求。
// 单逻辑分区(pk="requirement") + ULID 排序键，列表 Query 后按角色在内存过滤（量级与 approvals 相当）。
// 评论与状态流转内嵌 activity[] 时间线（远低于 DynamoDB 400KB 上限）。
//
// 权限模型（与设计文档 22 一致）：
//   - 经理(isManager = bgp-manager || 平台管理员)：受理/指派/驳回/验收/打回。
//   - 研发(assignee == 调用者)：开始/生成实现/建作业/提交交付。
//   - 提出人(requester == 调用者)：提交/取消/reopen/评论。
//   - 任意可见者：评论。
// 状态机与守卫集中在 ACTIONS，API 层只调用 applyTransition，避免守卫散落。

import { PutCommand, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import type { Identity } from "@/lib/auth/identity";

export const REQUIREMENTS_PK = "requirement";

export type RequirementStatus =
  | "draft"
  | "submitted"
  | "assigned"
  | "in_development"
  | "in_review"
  | "delivered"
  | "rejected"
  | "cancelled";

export type Priority = "P0" | "P1" | "P2" | "P3";
export const PRIORITIES: Priority[] = ["P0", "P1", "P2", "P3"];

export const TERMINAL: RequirementStatus[] = ["delivered", "cancelled"];

export interface ActivityEntry {
  ts: string;
  actor: string;
  action: string; // submit/assign/start/comment/...
  fromStatus?: RequirementStatus;
  toStatus?: RequirementStatus;
  note?: string;
}

export interface RequirementSource {
  kind: "genbi";
  question: string;
  sql: string | null;
  columns: string[];
  sampleRows: (string | null)[][];
  chartType?: string;
}

export interface Implementation {
  targetType: "redshift" | "glue";
  generatedCode?: string;
  explanation?: string;
  etlJobId?: string;
  targetTable?: string; // 结果表名（从生成 SQL 解析），供 GenBI 固化复用
  generatedAt?: string;
  generatedBy?: string;
  /**
   * @kf-batch 50-WP31-place-first-class(B-36)—— 这份代码是按**哪个执行环境的目录**生成的(codegen 的 `groundedOn.targetId`)。
   * 「创建作业」据此判:绑定区里必须含它 —— 否则就是「按 us-west-2 的表生成、却建成主控区作业」。存量行没有它 = 按主控区生成的(历史事实)。
   */
  groundedTargetId?: string;
}

export interface Requirement {
  requirementId: string;
  projectId: string;
  title: string;
  description: string;
  priority: Priority;
  status: RequirementStatus;
  businessValue?: string;
  acceptanceCriteria?: string;
  source?: RequirementSource;
  requesterName: string;
  requesterSub?: string;
  assigneeName?: string;
  assigneeSub?: string;
  implementation?: Implementation;
  dueDate?: string;
  activity: ActivityEntry[];
  createdAt: string;
  updatedAt: string;
  assignedAt?: string;
  deliveredAt?: string;
}

// ─── 角色判定 ────────────────────────────────────────────────────────────────
export function isManager(identity: Identity): boolean {
  return identity.isManager;
}
export function isAssignee(r: Requirement, identity: Identity): boolean {
  // 优先按 Cognito sub 匹配；当 assigneeSub 缺失（例如成员行未解析到 sub）时回退按用户名匹配，
  // 与 isRequester 一致，避免"被指派研发却无法承接"的授权盲区。assigneeName 来自项目成员名单（可信）。
  return (
    (!!r.assigneeSub && r.assigneeSub === identity.sub) ||
    (!!r.assigneeName && r.assigneeName === identity.username)
  );
}
export function isRequester(r: Requirement, identity: Identity): boolean {
  return (!!r.requesterSub && r.requesterSub === identity.sub) || r.requesterName === identity.username;
}

// ─── 状态机 ──────────────────────────────────────────────────────────────────
export type ActionName =
  | "submit"
  | "assign"
  | "reject"
  | "reopen"
  | "start"
  | "submit_delivery"
  | "request_changes"
  | "approve"
  | "cancel";

interface ActionDef {
  from: RequirementStatus[];
  to: RequirementStatus;
  can: (r: Requirement, id: Identity) => boolean;
  label: string;
}

export const ACTIONS: Record<ActionName, ActionDef> = {
  submit: { from: ["draft"], to: "submitted", can: (r, id) => isRequester(r, id) || isManager(id), label: "提交" },
  assign: { from: ["submitted", "assigned", "rejected"], to: "assigned", can: (_r, id) => isManager(id), label: "指派" },
  reject: { from: ["submitted", "assigned", "in_review"], to: "rejected", can: (_r, id) => isManager(id), label: "驳回" },
  reopen: { from: ["rejected", "cancelled"], to: "submitted", can: (r, id) => isManager(id) || isRequester(r, id), label: "重新打开" },
  start: { from: ["assigned"], to: "in_development", can: (r, id) => isAssignee(r, id), label: "开始研发" },
  submit_delivery: { from: ["in_development"], to: "in_review", can: (r, id) => isAssignee(r, id), label: "提交交付" },
  request_changes: { from: ["in_review"], to: "in_development", can: (_r, id) => isManager(id), label: "打回修改" },
  approve: { from: ["in_review"], to: "delivered", can: (_r, id) => isManager(id), label: "验收通过" },
  cancel: { from: ["draft", "submitted", "assigned", "in_development", "in_review", "rejected"], to: "cancelled", can: (r, id) => isManager(id) || isRequester(r, id), label: "取消" },
};

// 返回当前身份在该需求上可执行的动作列表（供前端按角色渲染操作区）。
export function availableActions(r: Requirement, id: Identity): ActionName[] {
  return (Object.keys(ACTIONS) as ActionName[]).filter((a) => {
    const def = ACTIONS[a];
    return def.from.includes(r.status) && def.can(r, id);
  });
}

// ─── 持久化 ──────────────────────────────────────────────────────────────────
function pushActivity(r: Requirement, entry: ActivityEntry) {
  r.activity = [...(r.activity || []), entry];
}

export async function createRequirement(input: {
  projectId: string;
  title: string;
  description: string;
  priority?: Priority;
  businessValue?: string;
  acceptanceCriteria?: string;
  source?: RequirementSource;
  identity: Identity;
}): Promise<Requirement> {
  const now = new Date().toISOString();
  const r: Requirement & { pk: string } = {
    pk: REQUIREMENTS_PK,
    requirementId: ulid(),
    projectId: input.projectId,
    title: input.title.trim(),
    description: (input.description || "").trim(),
    priority: PRIORITIES.includes(input.priority as Priority) ? (input.priority as Priority) : "P2",
    status: "submitted", // 从 GenBI/工作台提交即进入待受理
    ...(input.businessValue ? { businessValue: input.businessValue } : {}),
    ...(input.acceptanceCriteria ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
    ...(input.source ? { source: input.source } : {}),
    requesterName: input.identity.username,
    requesterSub: input.identity.sub,
    activity: [{ ts: now, actor: input.identity.username, action: "submit", toStatus: "submitted", note: "提交需求" }],
    createdAt: now,
    updatedAt: now,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.REQUIREMENTS, Item: r }));
  return r;
}

export async function getRequirement(requirementId: string): Promise<Requirement | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.REQUIREMENTS, Key: { pk: REQUIREMENTS_PK, requirementId } })
  );
  return (Item as Requirement) || null;
}

export async function listByProject(projectId: string): Promise<Requirement[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.REQUIREMENTS,
      KeyConditionExpression: "pk = :p",
      ExpressionAttributeValues: { ":p": REQUIREMENTS_PK },
    })
  );
  return (Items as Requirement[])
    .filter((r) => r.projectId === projectId)
    .sort((a, b) => (a.requirementId < b.requirementId ? 1 : -1));
}

// 角色感知列表盒子。
export type Box = "mine" | "assigned" | "inbox" | "all";
export function filterBox(reqs: Requirement[], box: Box, id: Identity): Requirement[] {
  switch (box) {
    case "mine":
      return reqs.filter((r) => isRequester(r, id));
    case "assigned":
      return reqs.filter((r) => isAssignee(r, id));
    case "inbox": // 经理受理箱：待受理 + 待验收
      return isManager(id) ? reqs.filter((r) => r.status === "submitted" || r.status === "in_review") : [];
    case "all":
      return isManager(id) ? reqs : [];
    default:
      return [];
  }
}

async function persist(r: Requirement): Promise<Requirement> {
  r.updatedAt = new Date().toISOString();
  await docClient.send(new PutCommand({ TableName: TABLES.REQUIREMENTS, Item: { pk: REQUIREMENTS_PK, ...r } }));
  return r;
}

export interface TransitionResult {
  ok: boolean;
  error?: string;
  status?: number;
  requirement?: Requirement;
}

// 统一状态机转移（带守卫）。
export async function applyTransition(
  r: Requirement,
  action: ActionName,
  identity: Identity,
  note?: string
): Promise<TransitionResult> {
  const def = ACTIONS[action];
  if (!def) return { ok: false, error: "未知动作", status: 400 };
  if (!def.from.includes(r.status)) return { ok: false, error: `当前状态(${r.status})不允许「${def.label}」`, status: 409 };
  if (!def.can(r, identity)) return { ok: false, error: `无权执行「${def.label}」`, status: 403 };
  const from = r.status;
  r.status = def.to;
  if (def.to === "delivered") r.deliveredAt = new Date().toISOString();
  pushActivity(r, {
    ts: new Date().toISOString(),
    actor: identity.username,
    action,
    fromStatus: from,
    toStatus: def.to,
    ...(note ? { note } : {}),
  });
  await persist(r);
  return { ok: true, requirement: r };
}

// 指派（经理）。
export async function assignRequirement(
  r: Requirement,
  identity: Identity,
  input: { assigneeName: string; assigneeSub?: string; priority?: Priority; dueDate?: string }
): Promise<TransitionResult> {
  if (!isManager(identity)) return { ok: false, error: "仅经理可指派", status: 403 };
  if (!["submitted", "assigned", "rejected"].includes(r.status))
    return { ok: false, error: `当前状态(${r.status})不可指派`, status: 409 };
  if (!input.assigneeName) return { ok: false, error: "缺少指派对象", status: 400 };
  const now = new Date().toISOString();
  r.assigneeName = input.assigneeName;
  r.assigneeSub = input.assigneeSub;
  if (input.priority && PRIORITIES.includes(input.priority)) r.priority = input.priority;
  if (input.dueDate) r.dueDate = input.dueDate;
  r.status = "assigned";
  r.assignedAt = now;
  pushActivity(r, {
    ts: now,
    actor: identity.username,
    action: "assign",
    toStatus: "assigned",
    note: `指派给 ${input.assigneeName}${input.priority ? `（${input.priority}）` : ""}`,
  });
  await persist(r);
  return { ok: true, requirement: r };
}

export async function addComment(r: Requirement, identity: Identity, text: string): Promise<Requirement> {
  pushActivity(r, { ts: new Date().toISOString(), actor: identity.username, action: "comment", note: text });
  return persist(r);
}

// 研发：保存大模型生成的实现（不执行）。
export async function saveGeneratedImplementation(
  r: Requirement,
  identity: Identity,
  impl: { targetType: "redshift" | "glue"; generatedCode: string; explanation?: string; groundedTargetId: string }
): Promise<Requirement> {
  const now = new Date().toISOString();
  r.implementation = {
    ...(r.implementation || {}),
    targetType: impl.targetType,
    generatedCode: impl.generatedCode,
    ...(impl.explanation ? { explanation: impl.explanation } : {}),
    groundedTargetId: impl.groundedTargetId,
    generatedAt: now,
    generatedBy: identity.username,
  };
  pushActivity(r, { ts: now, actor: identity.username, action: "generate", note: `大模型生成实现（${impl.targetType}）` });
  return persist(r);
}

// 研发：关联已创建的 ETL 作业。
export async function linkEtlJob(
  r: Requirement,
  identity: Identity,
  etlJobId: string,
  jobName: string,
  targetTable?: string
): Promise<Requirement> {
  r.implementation = {
    ...(r.implementation || { targetType: "redshift" }),
    etlJobId,
    ...(targetTable ? { targetTable } : {}),
  };
  pushActivity(r, {
    ts: new Date().toISOString(),
    actor: identity.username,
    action: "create-job",
    note: `创建 ETL 作业：${jobName}${targetTable ? `（结果表 ${targetTable}）` : ""}`,
  });
  return persist(r);
}

// 已固化数据集：研发已为需求建了作业并产出结果表的需求。供 GenBI 优先复用（固化口径加速查询）。
export interface PublishedDataset {
  requirementId: string;
  title: string;
  question?: string;
  targetTable: string;
  projectId: string;
}

export async function listPublishedDatasets(projectId?: string): Promise<PublishedDataset[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.REQUIREMENTS,
      KeyConditionExpression: "pk = :p",
      ExpressionAttributeValues: { ":p": REQUIREMENTS_PK },
    })
  );
  return (Items as Requirement[])
    .filter(
      (r) =>
        r.implementation?.targetTable &&
        r.status !== "cancelled" &&
        r.status !== "rejected" &&
        (!projectId || r.projectId === projectId)
    )
    .map((r) => ({
      requirementId: r.requirementId,
      title: r.title,
      question: r.source?.question,
      targetTable: r.implementation!.targetTable!,
      projectId: r.projectId,
    }));
}
