// GenBI 异步化:任务表服务层(bgp-genbi-tasks)。
//
// 状态机:pending → running →(succeeded | failed | timeout)。终态不可逆。
// B1+ 三大并发正确性保证:
//  1) 抢占/重认领用 DynamoDB **条件写** —— 并发轮询里只有一个执行者能把 pending→running(或重认领
//     stale 的 running),输者拿 ConditionalCheckFailedException → 不执行。杜绝重复跑。
//  2) **runToken**(每次认领生成新 ULID):终态/心跳写入条件带 runToken=:tok —— 被取代的僵尸执行者
//     (心跳 stale 被重认领,但其实没死只是慢)无法覆盖当前 owner 的结果/心跳。
//  3) 终态写入一律条件 `status=running` —— 状态永不回退,第一个写终态者赢(succeeded 后 reconcile 的
//     force-timeout 会因 status≠running 而 no-op,反之亦然)。
//
// 强制结束(用户红线:5min 查不出强制掐掉)两层:
//  · 执行进程活着:执行体挂 AbortController,到 CEILING 主动 abort → 停止算力 → owner 写 timeout。
//  · 执行进程已死(扛定时器的 ECS task 被回收):轮询读时 forceTimeoutIfExpired 独立按 startedAt 判
//    CEILING 天花板 → 强制 timeout,**绝不重跑**。天花板在任何情况下都成立。

import { PutCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import type { GenBiResult } from "@/types/genbi";

function intEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) ? v : fallback;
}

// 300s 天花板(用户拍板);心跳 stale 阈值 30s;执行体心跳间隔 ~8s(远低于 stale,健康作业不会被误判)。
export const CEILING_MS = intEnv("GENBI_ASYNC_MAX_MS", 300_000);
export const STALE_MS = intEnv("GENBI_ASYNC_STALE_MS", 30_000);
export const HEARTBEAT_INTERVAL_MS = intEnv("GENBI_ASYNC_HEARTBEAT_MS", 8_000);
const TTL_SECONDS = 7 * 24 * 3600; // 任务 7 天自动过期

export type GenBiTaskStatus = "pending" | "running" | "succeeded" | "failed" | "timeout";

// 建任务时须持久化的执行入参(GET 轮询端点无 body,靠这些重建执行上下文)。
export interface GenBiTaskParams {
  question: string;
  engine: "redshift" | "athena";
  workgroup: string;
  database: string;
  /**
   * 这次问数在**哪个执行环境的数仓**上取数(缺省 = 主控区)。
   * 🔴 必须落库:异步任务由**另一次请求**接管执行,不落就等于「认领的那一刻忘了在哪个区问的」。
   */
  targetId?: string;
  projectId?: string;
  conversationId?: string;
  userId: string;
}

export interface GenBiTaskRow extends GenBiTaskParams {
  taskId: string;
  status: GenBiTaskStatus;
  result?: GenBiResult;
  error?: string;
  backend?: "agentcore" | "inprocess";
  runToken?: string;
  progress?: string;
  createdAt: string;
  startedAt?: string;
  heartbeatAt?: string;
  finishedAt?: string;
  ttl: number;
}

function isConditionalFail(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: string }).name === "ConditionalCheckFailedException";
}

// ── 建任务(pending) ──
export async function createTask(params: GenBiTaskParams): Promise<string> {
  const taskId = ulid();
  const now = new Date();
  // docClient removeUndefinedValues:true —— projectId/conversationId 为 undefined 时自动省略。
  await docClient.send(new PutCommand({
    TableName: TABLES.GENBI_TASKS,
    Item: {
      taskId,
      question: params.question,
      engine: params.engine,
      workgroup: params.workgroup,
      database: params.database,
      targetId: params.targetId,
      projectId: params.projectId,
      conversationId: params.conversationId,
      userId: params.userId,
      status: "pending",
      createdAt: now.toISOString(),
      ttl: Math.floor(now.getTime() / 1000) + TTL_SECONDS,
    },
  }));
  return taskId;
}

// ── 读任务 ──
export async function getTask(taskId: string): Promise<GenBiTaskRow | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.GENBI_TASKS, Key: { taskId } }));
  return (Item as GenBiTaskRow) || null;
}

// ── 抢占 pending→running(幂等,返回 runToken=赢;null=已被他人抢/非 pending) ──
export async function claimForRun(taskId: string): Promise<string | null> {
  const runToken = ulid();
  const nowIso = new Date().toISOString();
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.GENBI_TASKS,
      Key: { taskId },
      UpdateExpression: "SET #s = :running, startedAt = :now, heartbeatAt = :now, runToken = :tok",
      ConditionExpression: "attribute_exists(taskId) AND #s = :pending",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":running": "running", ":pending": "pending", ":now": nowIso, ":tok": runToken },
    }));
    return runToken;
  } catch (e) {
    if (isConditionalFail(e)) return null;
    throw e;
  }
}

// ── 重认领 stale 的 running(心跳 stale 且未过天花板;返回新 runToken=赢;null=没抢到/条件不符) ──
// 条件三合一:仍是 running、心跳早于 stale 阈值、startedAt 晚于天花板(即未超 CEILING)。
export async function reclaimStale(taskId: string): Promise<string | null> {
  const runToken = ulid();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const staleCutoff = new Date(now - STALE_MS).toISOString();
  const ceilingCutoff = new Date(now - CEILING_MS).toISOString();
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.GENBI_TASKS,
      Key: { taskId },
      UpdateExpression: "SET heartbeatAt = :now, runToken = :tok",
      ConditionExpression: "#s = :running AND heartbeatAt <= :stale AND startedAt > :ceiling",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":running": "running", ":now": nowIso, ":tok": runToken, ":stale": staleCutoff, ":ceiling": ceilingCutoff },
    }));
    return runToken;
  } catch (e) {
    if (isConditionalFail(e)) return null;
    throw e;
  }
}

// ── 心跳(仅当前 owner;超期/被取代/终态则 no-op) ──
export async function heartbeat(taskId: string, runToken: string, progress?: string): Promise<void> {
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.GENBI_TASKS,
      Key: { taskId },
      UpdateExpression: progress ? "SET heartbeatAt = :now, progress = :p" : "SET heartbeatAt = :now",
      ConditionExpression: "#s = :running AND runToken = :tok",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: progress
        ? { ":now": new Date().toISOString(), ":running": "running", ":tok": runToken, ":p": progress }
        : { ":now": new Date().toISOString(), ":running": "running", ":tok": runToken },
    }));
  } catch { /* best-effort:被取代/终态 → 心跳不再有意义 */ }
}

// ── 终态:owner 写成功/失败/超时(条件:仍 running 且是当前 owner) ──
async function finalizeByOwner(
  taskId: string,
  runToken: string,
  patch: { status: GenBiTaskStatus; result?: GenBiResult; error?: string; backend?: string }
): Promise<boolean> {
  const sets = ["#s = :st", "finishedAt = :fin"];
  const names: Record<string, string> = { "#s": "status" };
  const values: Record<string, unknown> = { ":st": patch.status, ":fin": new Date().toISOString(), ":running": "running", ":tok": runToken };
  if (patch.result !== undefined) { sets.push("#r = :r"); names["#r"] = "result"; values[":r"] = patch.result; }
  if (patch.error !== undefined) { sets.push("#e = :e"); names["#e"] = "error"; values[":e"] = patch.error.slice(0, 1000); }
  if (patch.backend !== undefined) { sets.push("backend = :b"); values[":b"] = patch.backend; }
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.GENBI_TASKS,
      Key: { taskId },
      UpdateExpression: "SET " + sets.join(", "),
      ConditionExpression: "#s = :running AND runToken = :tok",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
    return true;
  } catch (e) {
    if (isConditionalFail(e)) return false; // 已被 reconcile 判 timeout / 被取代 → 放弃写(状态不回退)
    throw e;
  }
}

export const markSucceeded = (taskId: string, runToken: string, result: GenBiResult, backend: string) =>
  finalizeByOwner(taskId, runToken, { status: "succeeded", result, backend });
export const markFailed = (taskId: string, runToken: string, error: string) =>
  finalizeByOwner(taskId, runToken, { status: "failed", error });
export const markTimeoutByOwner = (taskId: string, runToken: string) =>
  finalizeByOwner(taskId, runToken, { status: "timeout", error: "GENBI_TIMEOUT" });

// ── 强制超时(reconcile 读时:孤儿任务超天花板,无 owner) ──
// 条件:仍 running 且 startedAt 早于天花板(或 startedAt 缺失=异常也强制收口)。绝不重跑。
export async function forceTimeoutIfExpired(taskId: string): Promise<boolean> {
  const ceilingCutoff = new Date(Date.now() - CEILING_MS).toISOString();
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.GENBI_TASKS,
      Key: { taskId },
      UpdateExpression: "SET #s = :timeout, finishedAt = :fin, #e = :e",
      ConditionExpression: "#s = :running AND (attribute_not_exists(startedAt) OR startedAt <= :ceiling)",
      ExpressionAttributeNames: { "#s": "status", "#e": "error" },
      ExpressionAttributeValues: { ":timeout": "timeout", ":running": "running", ":fin": new Date().toISOString(), ":e": "GENBI_TIMEOUT", ":ceiling": ceilingCutoff },
    }));
    return true;
  } catch (e) {
    if (isConditionalFail(e)) return false;
    throw e;
  }
}

// ── 读时对账决策(纯函数,不写库;GET 端点据此动作) ──
export type ReconcileAction = "terminal" | "timeout" | "claim" | "reclaim" | "running";

export function reconcileDecision(task: GenBiTaskRow, now = Date.now()): ReconcileAction {
  if (task.status === "succeeded" || task.status === "failed" || task.status === "timeout") return "terminal";
  if (task.status === "pending") return "claim";
  // running:天花板优先(超 CEILING 必 timeout,永不重跑)→ 心跳 stale 则重认领 → 否则正常执行中。
  const startedMs = Date.parse(task.startedAt || task.createdAt);
  const elapsed = Number.isFinite(startedMs) ? now - startedMs : 0;
  if (elapsed >= CEILING_MS) return "timeout";
  const hbMs = Date.parse(task.heartbeatAt || task.startedAt || task.createdAt);
  const hbAge = Number.isFinite(hbMs) ? now - hbMs : Infinity;
  if (hbAge > STALE_MS) return "reclaim";
  return "running";
}
