// 模块 43-C — 补数计划/实例的存储服务层(bgp-backfill-plans / bgp-backfill-instances)。
// 计划 CRUD + 实例批量落库 + 进度聚合 + 控制动作(暂停/恢复/取消/续跑)。乐观锁 version 防并发覆盖。

import { PutCommand, GetCommand, QueryCommand, UpdateCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { expandInstances } from "./plan";
import type {
  BackfillInstanceRow,
  BackfillPlanRow,
  BackfillProgress,
  CreatePlanInput,
  InstanceSpec,
  PlanStatus,
} from "./types";

const TTL_SECONDS = 90 * 24 * 3600; // 实例 90 天自动过期
const planPk = (projectId: string) => `backfill#${projectId}`;

function emptyProgress(total: number): BackfillProgress {
  return { total, pending: total, blocked: 0, running: 0, succeeded: 0, failed: 0, skipped: 0 };
}

// ── dry-run:展开预览(不落库) ──
// 需要 DAG 时由调用方(API 层)先取 workflow 传入 dag。
export function previewInstances(input: CreatePlanInput, dag?: { nodes?: any[]; edges?: any[] }): InstanceSpec[] {
  return expandInstances({
    scope: input.target.scope,
    targetId: input.target.id,
    targetName: input.target.name,
    targetTaskType: input.target.taskType,
    dateRange: input.dateRange,
    cascade: input.cascade,
    dag,
    maxInstances: input.maxInstances,
    // @kf-batch 50-P50.3-mrquery —— 执行目标集合(API 层从资源行解析,不接受客户端指定)。
    execTargets: input.execTargets,
  });
}

// ── 创建计划 + 落实例(确认后) ──
export async function createPlan(input: CreatePlanInput, dag?: { nodes?: any[]; edges?: any[] }): Promise<BackfillPlanRow> {
  const specs = previewInstances(input, dag);
  const planId = ulid();
  const now = new Date().toISOString();
  const plan: BackfillPlanRow = {
    pk: planPk(input.projectId),
    planId,
    projectId: input.projectId,
    name: input.name,
    createdBy: input.createdBy,
    version: 1,
    target: input.target,
    dateRange: input.dateRange,
    cascade: input.cascade,
    concurrency: input.concurrency,
    maxInstances: input.maxInstances,
    ...(input.execTargets && input.execTargets.length ? { execTargets: input.execTargets } : {}),
    status: "planned",
    progress: emptyProgress(specs.length),
    createdAt: now,
    updatedAt: now,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.BACKFILL_PLANS, Item: plan }));

  // 实例落库:有依赖的初始 blocked、无依赖的 pending。BatchWrite 分批(25/批)。
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const items: BackfillInstanceRow[] = specs.map((s) => ({
    planId,
    sk: s.sk,
    date: s.date,
    nodeId: s.nodeId,
    nodeName: s.nodeName,
    nodeType: s.nodeType,
    // @kf-batch 50-P50.3-mrquery —— 实例带上它自己的执行目标(执行侧据它解析落点与凭证)。
    ...(s.targetId ? { targetId: s.targetId } : {}),
    status: s.dependsOn.length > 0 ? "blocked" : "pending",
    dependsOn: s.dependsOn,
    attempts: 0,
    ttl,
  }));
  // 修正初始进度中的 blocked/pending 计数。
  plan.progress.blocked = items.filter((i) => i.status === "blocked").length;
  plan.progress.pending = items.filter((i) => i.status === "pending").length;

  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    await docClient.send(new BatchWriteCommand({
      RequestItems: { [TABLES.BACKFILL_INSTANCES]: chunk.map((Item) => ({ PutRequest: { Item } })) },
    }));
  }
  // 回写修正后的进度。
  await docClient.send(new UpdateCommand({
    TableName: TABLES.BACKFILL_PLANS,
    Key: { pk: plan.pk, planId },
    UpdateExpression: "SET progress = :p",
    ExpressionAttributeValues: { ":p": plan.progress },
  }));
  return plan;
}

export async function getPlan(projectId: string, planId: string): Promise<BackfillPlanRow | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.BACKFILL_PLANS, Key: { pk: planPk(projectId), planId } }));
  return (Item as BackfillPlanRow) || null;
}

export async function listPlans(projectId: string): Promise<BackfillPlanRow[]> {
  const { Items = [] } = await docClient.send(new QueryCommand({
    TableName: TABLES.BACKFILL_PLANS,
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": planPk(projectId) },
    ScanIndexForward: false, // planId=ULID → 最新在前
  }));
  return Items as BackfillPlanRow[];
}

// @kf-batch 50-project-delete-orphans
// @kf-batch 50-B51-backfill-pump —— 「计划是否未收口」的定义挪到零依赖的 types.ts(后台推进泵在 instrumentation 可达面上,
//   不能 import 本文件:本文件 import ulid / plan 展开)。这里原样再导出,存量调用方不变。
import { BACKFILL_PLAN_STATUS_OPEN, isBackfillPlanOpen } from "./types";
export { BACKFILL_PLAN_STATUS_OPEN, isBackfillPlanOpen };

/**
 * @kf-batch 50-project-delete-orphans
 * 该项目**拥有**的、**未收口**的补数计划(删项目前置校验用)。
 * 与 `listPlans` 的区别:🔴 翻页到底(`listPlans` 单次 Query,只数第一页 ⇒ fail-open)、翻不完就**抛**、
 * 只收 `projectId` 恰为本项目的行(pk 已是 `backfill#<projectId>`,这是防脏数据的第二道)。
 */
export async function listOpenPlansOwnedByProject(projectId: string, maxPages = 50): Promise<BackfillPlanRow[]> {
  const out: BackfillPlanRow[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < maxPages; page++) {
    const r = await docClient.send(new QueryCommand({
      TableName: TABLES.BACKFILL_PLANS,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": planPk(projectId) },
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }));
    for (const it of (r.Items ?? []) as BackfillPlanRow[]) {
      if (it.projectId === projectId && isBackfillPlanOpen(it.status)) out.push(it);
    }
    startKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!startKey) return out;
  }
  throw new Error(`backfill.listOpenPlansOwnedByProject(${projectId}):翻页超过 ${maxPages} 页仍未到尾 ⇒ 数不清,拒绝回一个可能偏小的数`);
}

export async function listInstances(planId: string): Promise<BackfillInstanceRow[]> {
  const { Items = [] } = await docClient.send(new QueryCommand({
    TableName: TABLES.BACKFILL_INSTANCES,
    KeyConditionExpression: "planId = :p",
    ExpressionAttributeValues: { ":p": planId },
  }));
  return Items as BackfillInstanceRow[];
}

// ── 从实例集重算进度 + 派生计划终态 ──(纯函数,可单测)
export function aggregateProgress(instances: BackfillInstanceRow[]): BackfillProgress {
  const p = emptyProgress(instances.length);
  p.pending = 0;
  for (const i of instances) {
    if (i.status in p) (p as any)[i.status] += 1;
  }
  return p;
}

// 计划状态派生:全终态 → succeeded / partially-failed;否则保持 running/paused/planned/cancelled 由控制动作管。
export function derivePlanStatus(current: PlanStatus, progress: BackfillProgress): PlanStatus {
  if (current === "cancelled" || current === "paused") return current;
  const { total, succeeded, failed, skipped, running, pending, blocked } = progress;
  const active = running + pending + blocked;
  if (total > 0 && active === 0) {
    return failed > 0 ? "partially-failed" : "succeeded";
  }
  if (running > 0 || succeeded > 0 || failed > 0) return "running";
  return current === "planned" ? "planned" : "running";
}

// 回写进度 + 派生状态(runner/reconcile 后调用)。
export async function refreshPlanProgress(plan: BackfillPlanRow, instances: BackfillInstanceRow[]): Promise<BackfillPlanRow> {
  const progress = aggregateProgress(instances);
  const status = derivePlanStatus(plan.status, progress);
  await docClient.send(new UpdateCommand({
    TableName: TABLES.BACKFILL_PLANS,
    Key: { pk: plan.pk, planId: plan.planId },
    UpdateExpression: "SET progress = :p, #s = :st, updatedAt = :t",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":p": progress, ":st": status, ":t": new Date().toISOString() },
  }));
  return { ...plan, progress, status };
}

// ── 设置计划状态(暂停/恢复/取消) ──(乐观锁)
export async function setPlanStatus(plan: BackfillPlanRow, status: PlanStatus): Promise<void> {
  await docClient.send(new UpdateCommand({
    TableName: TABLES.BACKFILL_PLANS,
    Key: { pk: plan.pk, planId: plan.planId },
    UpdateExpression: "SET #s = :st, version = version + :one, updatedAt = :t",
    ConditionExpression: "version = :v",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":st": status, ":v": plan.version, ":one": 1, ":t": new Date().toISOString() },
  }));
}

// ── 续跑:failed 实例重置 pending(attempts 保留,不清零);其因上游失败而 skipped 的下游闭包
// 重置回 blocked(重新参与,待重跑的上游成功后由 runner 解锁)。已 succeeded 实例不动(attempts 不变)。
export async function retryFailedInstances(planId: string): Promise<number> {
  const instances = await listInstances(planId);
  const failed = instances.filter((i) => i.status === "failed");
  if (failed.length === 0) return 0;

  // 求"被重跑项"的 skipped 下游闭包:沿 dependsOn 反向传播。
  const retriedKeys = new Set(failed.map((i) => i.sk));
  let changed = true;
  while (changed) {
    changed = false;
    for (const inst of instances) {
      if (inst.status === "skipped" && !retriedKeys.has(inst.sk) && inst.dependsOn.some((d) => retriedKeys.has(d))) {
        retriedKeys.add(inst.sk);
        changed = true;
      }
    }
  }

  for (const inst of failed) {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.BACKFILL_INSTANCES,
      Key: { planId, sk: inst.sk },
      UpdateExpression: "SET #s = :pending REMOVE runId, runTaskId, runToken, lastError, startedAt, finishedAt",
      ConditionExpression: "#s = :failed",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":pending": "pending", ":failed": "failed" },
    })).catch(() => {});
  }
  // skipped 下游 → blocked(有依赖)或 pending(无依赖,理论上不会出现在下游闭包)。
  for (const inst of instances) {
    if (inst.status === "skipped" && retriedKeys.has(inst.sk)) {
      const next = inst.dependsOn.length > 0 ? "blocked" : "pending";
      await docClient.send(new UpdateCommand({
        TableName: TABLES.BACKFILL_INSTANCES,
        Key: { planId, sk: inst.sk },
        UpdateExpression: "SET #s = :n REMOVE runId, runTaskId, runToken, lastError, startedAt, finishedAt",
        ConditionExpression: "#s = :skipped",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":n": next, ":skipped": "skipped" },
      })).catch(() => {});
    }
  }
  return failed.length;
}
