// Copilot 执行计划/步骤的存储服务层(bgp-copilot-plans / bgp-copilot-steps)。
// 计划 CRUD + 步骤批量落库 + 进度聚合 + 控制动作(确认步骤/暂停/恢复/取消/重试)。
// 泛化补数 service.ts:补数按"日期×节点"机械展开,Copilot 直接落 planner 产出的异构步骤(PlanSpec)。
// 乐观锁 version 防并发覆盖(与补数同款);refreshPlanProgress 高频回写不带锁(避免与控制动作互斥)。

import { PutCommand, GetCommand, QueryCommand, UpdateCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import type {
  CopilotPlanRow,
  CopilotStepRow,
  PlanProgress,
  PlanSpec,
  PlanStatus,
  StepStatus,
} from "./types";

const TTL_SECONDS = 90 * 24 * 3600; // 步骤 90 天自动过期(计划主档不设 TTL,长期留存)
const planPk = (projectId: string) => `copilot#${projectId}`;

// zero-pad 序号做 stepId,保证 SK 字典序 = 步骤展示顺序(Query 天然有序,无需内存排序)。
export function stepIdOf(seq: number): string {
  return String(seq).padStart(4, "0");
}

// 进度初始化:8 个状态计数键必须与 StepStatus 名一一对应(aggregateProgress 靠 `status in p`)。
function emptyProgress(total: number): PlanProgress {
  return {
    total,
    "awaiting-confirmation": 0,
    confirmed: 0,
    blocked: 0,
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };
}

// ── 创建计划 + 落步骤 ──
// planner 产出的 PlanSpec(含 StepSpec[],dependsOn 用 seq 引用)→ 落库成 CopilotPlanRow + N 个 CopilotStepRow。
// 关键:规划时还没 stepId,dependsOnSeq(seq 引用)在此翻译成 dependsOn(stepId 引用)。
// 初始状态门控:有依赖的步骤落 blocked;无依赖的步骤落 awaiting-confirmation(等人工确认,不是 pending)。
//   —— 这就是"AI 永不擅自执行"在落库层的第一道体现:再无依赖的步骤也要先等确认。
export async function createPlan(input: {
  projectId: string;
  createdBy: string;
  prompt: string;
  spec: PlanSpec;
  /** 计划面向的执行区。🔴 必填(原「缺省主控区」= 静默默认值) */
  targetId: string;
}): Promise<CopilotPlanRow> {
  const { projectId, createdBy, prompt, spec } = input;
  const planId = ulid();
  const now = new Date().toISOString();

  const plan: CopilotPlanRow = {
    pk: planPk(projectId),
    planId,
    projectId,
    createdBy,
    version: 1,
    prompt,
    summary: spec.summary || "",
    findings: spec.findings || "",
    autoExecute: false, // L2:引擎不代执行。翻 L3 是显式配置 + 用户批准的动作,绝非代码默认。
    // 计划的执行区(建出来的作业都落这个区)
    targets: [input.targetId],
    status: spec.steps.length === 0 ? "succeeded" : "planned", // 0 步 = 无需执行(直接答),即完成
    progress: emptyProgress(spec.steps.length),
    createdAt: now,
    updatedAt: now,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.COPILOT_PLANS, Item: plan }));

  if (spec.steps.length === 0) return plan; // 无步骤:计划即答复,不落步骤。

  // seq → stepId 映射(翻译 dependsOnSeq)。
  const seqToStepId = new Map<number, string>();
  for (const s of spec.steps) seqToStepId.set(s.seq, stepIdOf(s.seq));

  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const items: CopilotStepRow[] = spec.steps.map((s) => {
    const dependsOn = (s.dependsOnSeq || [])
      .map((dseq) => seqToStepId.get(dseq))
      .filter((x): x is string => !!x);
    return {
      planId,
      stepId: stepIdOf(s.seq),
      seq: s.seq,
      stepType: s.stepType,
      title: s.title,
      rationale: s.rationale,
      params: s.params || {},
      dependsOn,
      // 有依赖 → blocked(等上游);无依赖 → awaiting-confirmation(等人工确认)。
      status: dependsOn.length > 0 ? "blocked" : "awaiting-confirmation",
      attempts: 0,
      ttl,
    };
  });

  // 修正初始进度计数。
  plan.progress.blocked = items.filter((i) => i.status === "blocked").length;
  plan.progress["awaiting-confirmation"] = items.filter((i) => i.status === "awaiting-confirmation").length;

  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    await docClient.send(new BatchWriteCommand({
      RequestItems: { [TABLES.COPILOT_STEPS]: chunk.map((Item) => ({ PutRequest: { Item } })) },
    }));
  }
  await docClient.send(new UpdateCommand({
    TableName: TABLES.COPILOT_PLANS,
    Key: { pk: plan.pk, planId },
    UpdateExpression: "SET progress = :p",
    ExpressionAttributeValues: { ":p": plan.progress },
  }));
  return plan;
}

export async function getPlan(projectId: string, planId: string): Promise<CopilotPlanRow | null> {
  const { Item } = await docClient.send(new GetCommand({
    TableName: TABLES.COPILOT_PLANS,
    Key: { pk: planPk(projectId), planId },
  }));
  return (Item as CopilotPlanRow) || null;
}

export async function listPlans(projectId: string): Promise<CopilotPlanRow[]> {
  const { Items = [] } = await docClient.send(new QueryCommand({
    TableName: TABLES.COPILOT_PLANS,
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": planPk(projectId) },
    ScanIndexForward: false, // planId=ULID → 最新在前
  }));
  return Items as CopilotPlanRow[];
}

/**
 * 计划「还没收口」吗(删项目前置校验的口径)—— **穷尽表**:`PlanStatus` 加一个值不在这里登记 ⇒ `tsc` 不过。
 *
 * 🔴 为什么只数**未收口**的,不数全部:
 *   · 未收口(planned / awaiting / running / paused)= 还会被确认、被 L3 tick 推进、**还会建出作业**的东西 ——
 *     项目删了它还在 ⇒ 谁也看不见、却仍可能被推进(真环境清理 128 个夹具项目时抓到的孤儿之一)。
 *   · 已收口(succeeded / partially-failed / cancelled)= **历史记录**,与运行记录 / 审计同一口径(本清单不数历史);
 *     它建出来的作业各自在 sync / etl / engine… 那几类里被数到。
 *   · 计划**没有删除入口**(只有 pause / resume / cancel),若连已收口的也算 ⇒ 任何跑过一次 Copilot 的项目
 *     **永远删不掉**,而拒因让人去处置一件做不到的事。处置路径 = 「取消」(control 路由),取消即收口。
 */
export const PLAN_STATUS_OPEN: Readonly<Record<PlanStatus, boolean>> = Object.freeze({
  planned: true,
  awaiting: true,
  running: true,
  paused: true,
  cancelled: false,
  succeeded: false,
  "partially-failed": false,
});

/** 不认识的状态(脏数据 / 新版本写的值)一律当**未收口** —— 看不清 ⇒ 不放行删除。 */
export function isPlanOpen(status: unknown): boolean {
  return Object.prototype.hasOwnProperty.call(PLAN_STATUS_OPEN, String(status))
    ? PLAN_STATUS_OPEN[String(status) as PlanStatus]
    : true;
}

/**
 * 该项目**拥有**的、**未收口**的计划(删项目前置校验用)。
 *
 * 与 `listPlans` 的区别,每一条都是删除守卫需要而列表页不需要的:
 *   · 🔴 **翻页到底**:`listPlans` 单次 Query(1MB 一页)—— 计数只看第一页 ⇒ 偏小 ⇒ fail-open 放行删除;
 *   · 翻页超过上限仍没到尾 ⇒ **抛**(调用方变 `count:null` ⇒ 阻断),不回一个可能偏小的数;
 *   · 只回 `projectId` 恰为本项目的行(pk 已经是 `copilot#<projectId>`,这条是防脏数据的第二道)。
 */
export async function listOpenPlansOwnedByProject(projectId: string, maxPages = 50): Promise<CopilotPlanRow[]> {
  const out: CopilotPlanRow[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < maxPages; page++) {
    const r = await docClient.send(new QueryCommand({
      TableName: TABLES.COPILOT_PLANS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": planPk(projectId) },
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }));
    for (const it of (r.Items ?? []) as CopilotPlanRow[]) {
      if (it.projectId === projectId && isPlanOpen(it.status)) out.push(it);
    }
    startKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!startKey) return out;
  }
  throw new Error(`listOpenPlansOwnedByProject(${projectId}):翻页超过 ${maxPages} 页仍未到尾 ⇒ 数不清,拒绝回一个可能偏小的数`);
}

export async function listSteps(planId: string): Promise<CopilotStepRow[]> {
  const { Items = [] } = await docClient.send(new QueryCommand({
    TableName: TABLES.COPILOT_STEPS,
    KeyConditionExpression: "planId = :p",
    ExpressionAttributeValues: { ":p": planId },
  }));
  // SK = zero-pad seq,Query 已按字典序 = 展示顺序;稳妥起见再按 seq 排一次。
  return (Items as CopilotStepRow[]).sort((a, b) => a.seq - b.seq);
}

export async function getStep(planId: string, stepId: string): Promise<CopilotStepRow | null> {
  const { Item } = await docClient.send(new GetCommand({
    TableName: TABLES.COPILOT_STEPS,
    Key: { planId, stepId },
  }));
  return (Item as CopilotStepRow) || null;
}

// ── 从步骤集重算进度 + 派生计划终态 ──(纯函数,可单测)
export function aggregateProgress(steps: CopilotStepRow[]): PlanProgress {
  const p = emptyProgress(steps.length);
  for (const s of steps) {
    if (s.status in p) (p as any)[s.status] += 1;
  }
  return p;
}

// 计划状态派生(泛化补数 derivePlanStatus,加入 gated 两态):
//  - cancelled/paused 是终态锁,不被派生覆盖。
//  - 全部步骤达终态(succeeded/failed/skipped)→ 有 failed 则 partially-failed,否则 succeeded。
//  - 还有 running/pending/confirmed 在动 → running。
//  - 只剩 awaiting-confirmation/blocked(没人推)→ awaiting(等用户确认)。
//  - 兜底保持 planned/running。
export function derivePlanStatus(current: PlanStatus, progress: PlanProgress): PlanStatus {
  if (current === "cancelled" || current === "paused") return current;
  const total = progress.total;
  const awaiting = progress["awaiting-confirmation"];
  const { confirmed, blocked, pending, running, succeeded, failed } = progress;
  const active = awaiting + confirmed + blocked + pending + running;
  if (total > 0 && active === 0) {
    return failed > 0 ? "partially-failed" : "succeeded";
  }
  // 有确定要动的(引擎推进中)→ running。
  if (running > 0 || pending > 0 || confirmed > 0 || succeeded > 0 || failed > 0) return "running";
  // 只剩等确认/被阻塞(引擎不推)→ awaiting。
  if (awaiting > 0 || blocked > 0) return "awaiting";
  return current === "planned" ? "planned" : "running";
}

// 回写进度 + 派生状态(runner/confirm 后调用)。不带乐观锁(高频,避免与控制动作互斥)。
export async function refreshPlanProgress(plan: CopilotPlanRow, steps: CopilotStepRow[]): Promise<CopilotPlanRow> {
  const progress = aggregateProgress(steps);
  const status = derivePlanStatus(plan.status, progress);
  await docClient.send(new UpdateCommand({
    TableName: TABLES.COPILOT_PLANS,
    Key: { pk: plan.pk, planId: plan.planId },
    UpdateExpression: "SET progress = :p, #s = :st, updatedAt = :t",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":p": progress, ":st": status, ":t": new Date().toISOString() },
  }));
  return { ...plan, progress, status };
}

// ── 设置计划状态(暂停/恢复/取消) ──(乐观锁 version)
export async function setPlanStatus(plan: CopilotPlanRow, status: PlanStatus): Promise<void> {
  await docClient.send(new UpdateCommand({
    TableName: TABLES.COPILOT_PLANS,
    Key: { pk: plan.pk, planId: plan.planId },
    UpdateExpression: "SET #s = :st, version = version + :one, updatedAt = :t",
    ConditionExpression: "version = :v",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":st": status, ":v": plan.version, ":one": 1, ":t": new Date().toISOString() },
  }));
}

// 切换 autoExecute(L2↔L3)。乐观锁。L3 开启是显式配置 + 用户批准的动作(见 API 层守卫)。
export async function setPlanAutoExecute(plan: CopilotPlanRow, autoExecute: boolean): Promise<void> {
  await docClient.send(new UpdateCommand({
    TableName: TABLES.COPILOT_PLANS,
    Key: { pk: plan.pk, planId: plan.planId },
    UpdateExpression: "SET autoExecute = :a, version = version + :one, updatedAt = :t",
    ConditionExpression: "version = :v",
    ExpressionAttributeValues: { ":a": autoExecute, ":v": plan.version, ":one": 1, ":t": new Date().toISOString() },
  }));
}

// ── gated 确认:awaiting-confirmation → confirmed ──(条件写,补数没有的核心动作)
// 只有处于 awaiting-confirmation 的步骤能被确认(条件写防重复/防越态)。
// 可选回填 draft 资源信息(L2 下 confirm 即建 draft,见 confirm 路由 + StepHandler.createDraft)。
export async function confirmStep(
  planId: string,
  stepId: string,
  patch?: { draftResourceId?: string; draftResourceKind?: string; execHint?: { page: string; action: string } }
): Promise<boolean> {
  const sets = ["#s = :confirmed"];
  const values: Record<string, unknown> = { ":confirmed": "confirmed", ":awaiting": "awaiting-confirmation" };
  if (patch?.draftResourceId) { sets.push("draftResourceId = :drid"); values[":drid"] = patch.draftResourceId; }
  if (patch?.draftResourceKind) { sets.push("draftResourceKind = :drk"); values[":drk"] = patch.draftResourceKind; }
  if (patch?.execHint) { sets.push("execHint = :eh"); values[":eh"] = patch.execHint; }
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.COPILOT_STEPS,
      Key: { planId, stepId },
      UpdateExpression: "SET " + sets.join(", "),
      ConditionExpression: "#s = :awaiting",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: values,
    }));
    return true;
  } catch (e: any) {
    if (e?.name === "ConditionalCheckFailedException") return false; // 非 awaiting 态,已确认或越态
    throw e;
  }
}

// 更新步骤的执行指引(execHint)——L2 下确认步骤后回填"去哪页点"。
export async function setStepExecHint(planId: string, stepId: string, execHint: { page: string; action: string }): Promise<void> {
  await docClient.send(new UpdateCommand({
    TableName: TABLES.COPILOT_STEPS,
    Key: { planId, stepId },
    UpdateExpression: "SET execHint = :eh",
    ExpressionAttributeValues: { ":eh": execHint },
  }));
}
