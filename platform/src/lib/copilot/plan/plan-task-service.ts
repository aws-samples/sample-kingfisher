// Copilot 规划大脑【异步任务】服务层(bgp-copilot-plan-tasks)。
// 照抄GenBI 异步化(lib/genbi/tasks.ts)的并发正确性三保证
//  1) claimForRun 条件写(pending→running):并发轮询里只有一个执行者能认领,杜绝重复跑 planner。
//  2) runToken(每次认领新 ULID):终态/心跳写入条件带 runToken,僵尸执行者无法覆盖当前 owner。
//  3) 终态写入条件 status=running + 300s 天花板 forceTimeout:状态永不回退,绝不永久卡 running。
//
// 为什么需要:规划大脑(Strands+Opus 发现+结构化输出)重推理耗时可能 >CloudFront 60s 同步硬墙
// ([[genbi-async-b1plus]] 同款坑)。POST 立即建 pending 返 taskId,后台执行体跑 planner(不受 60s 约束),
// 前端轮询 GET 取结果。执行体挂 AbortController 到 CEILING 主动 abort。

import { PutCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";

function intEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) ? v : fallback;
}

// 规划天花板 240s(< GenBI 300s;规划应更快);心跳 stale 30s。
export const PLAN_CEILING_MS = intEnv("COPILOT_PLAN_ASYNC_MAX_MS", 240_000);
export const PLAN_STALE_MS = intEnv("COPILOT_PLAN_ASYNC_STALE_MS", 30_000);
const TTL_SECONDS = 7 * 24 * 3600;

export type PlanTaskStatus = "pending" | "running" | "succeeded" | "failed" | "timeout";

export interface PlanTaskParams {
  prompt: string;
  projectId: string;
  env: string;
  token: string;
  createdBy: string;
  /**
   * 这次规划面向哪个执行区(顶栏视角)。
   * 🔴 必须**落库**:规划是异步任务,执行体靠库里的行重建上下文;只放在内存里的话
   * 执行体拿不到,建出来的 draft 又会全部落回主控区。
   * 🔴 **必填**(原为可选,且 `createPlanTask` 的 Item 里**从没写它**
   *   注释说「必须落库」而代码没落 ⇒ 执行体读回的行恒无落点 ⇒ us-west-2 视角的计划查的是主控区目录、
   *   计划记录也被盖成主控区(段 cov COV-B39-PLAN 真环境坐实)。落点由路由**显式决定**后传入,这里不再有缺省。
   */
  targetId: string;
}

export interface PlanTaskRow {
  taskId: string;
  status: PlanTaskStatus;
  // 执行入参(GET 轮询无 body,靠这些重建执行上下文;token 不落库,仅内存传递给执行体)。
  prompt: string;
  projectId: string;
  env: string;
  createdBy: string;
  // 规划面向的执行区。
  // 🔴 此前建的行**没有**这个字段 ⇒ 读侧一律经 `targetOfStamp`(无章 = 主控区,唯一作者),不在别处补缺省。
  targetId?: string;
  // 结果:成功后 planId(前端据此拉计划详情);degraded 标记规划降级。
  planId?: string;
  degraded?: boolean;
  // SPEC §3.3a ⑧:planner 实际用的模型落进任务项(异步无同步信封,靠它回显)。
  usedModelId?: string;
  usedModelSource?: string;
  error?: string;
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

// ── 建任务(pending)。token 不落库(敏感),仅执行体内存持有。 ──
export async function createPlanTask(params: PlanTaskParams): Promise<string> {
  const taskId = ulid();
  const now = new Date();
  await docClient.send(new PutCommand({
    TableName: TABLES.COPILOT_PLAN_TASKS,
    Item: {
      taskId,
      status: "pending",
      prompt: params.prompt,
      projectId: params.projectId,
      env: params.env,
      createdBy: params.createdBy,
      targetId: params.targetId, // 🔴 执行体靠这一行重建上下文,漏写 = 回落主控区
      createdAt: now.toISOString(),
      ttl: Math.floor(now.getTime() / 1000) + TTL_SECONDS,
    },
  }));
  return taskId;
}

export async function getPlanTask(taskId: string): Promise<PlanTaskRow | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.COPILOT_PLAN_TASKS, Key: { taskId } }));
  return (Item as PlanTaskRow) || null;
}

// ── 抢占 pending→running(条件写;返回 runToken=赢,null=已被抢/非 pending) ──
export async function claimForRun(taskId: string): Promise<string | null> {
  const runToken = ulid();
  const nowIso = new Date().toISOString();
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.COPILOT_PLAN_TASKS,
      Key: { taskId },
      UpdateExpression: "SET #s = :running, startedAt = :now, heartbeatAt = :now, runToken = :tok",
      ConditionExpression: "#s = :pending",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":running": "running", ":pending": "pending", ":now": nowIso, ":tok": runToken },
    }));
    return runToken;
  } catch (e) {
    if (isConditionalFail(e)) return null;
    throw e;
  }
}

// ── 心跳(仅当前 owner)。 ──
export async function heartbeat(taskId: string, runToken: string, progress?: string): Promise<void> {
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.COPILOT_PLAN_TASKS,
      Key: { taskId },
      UpdateExpression: progress ? "SET heartbeatAt = :now, progress = :p" : "SET heartbeatAt = :now",
      ConditionExpression: "#s = :running AND runToken = :tok",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: progress
        ? { ":now": new Date().toISOString(), ":tok": runToken, ":running": "running", ":p": progress.slice(0, 200) }
        : { ":now": new Date().toISOString(), ":tok": runToken, ":running": "running" },
    }));
  } catch (e) {
    if (isConditionalFail(e)) return; // 被取代 → 忽略
    throw e;
  }
}

// ── 写终态(仅当前 owner 的 running)。 ──
export async function finalize(
  taskId: string,
  runToken: string,
  patch: { status: "succeeded" | "failed" | "timeout"; planId?: string; degraded?: boolean; error?: string; usedModelId?: string; usedModelSource?: string }
): Promise<void> {
  const sets = ["#s = :st", "finishedAt = :fin"];
  const values: Record<string, unknown> = { ":st": patch.status, ":fin": new Date().toISOString(), ":running": "running", ":tok": runToken };
  if (patch.planId) { sets.push("planId = :pid"); values[":pid"] = patch.planId; }
  if (patch.degraded !== undefined) { sets.push("degraded = :dg"); values[":dg"] = patch.degraded; }
  // 实际用的模型(可缺省 —— 老执行体 / 降级路径无值时不写)。
  if (patch.usedModelId) { sets.push("usedModelId = :um"); values[":um"] = patch.usedModelId; }
  if (patch.usedModelSource) { sets.push("usedModelSource = :ums"); values[":ums"] = patch.usedModelSource; }
  if (patch.error) { sets.push("#e = :err"); values[":err"] = String(patch.error).slice(0, 500); }
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.COPILOT_PLAN_TASKS,
      Key: { taskId },
      UpdateExpression: "SET " + sets.join(", "),
      ConditionExpression: "#s = :running AND runToken = :tok",
      ExpressionAttributeNames: patch.error ? { "#s": "status", "#e": "error" } : { "#s": "status" },
      ExpressionAttributeValues: values,
    }));
  } catch (e) {
    if (isConditionalFail(e)) return; // 已被 forceTimeout 或他人写终态 → 忽略
    throw e;
  }
}

// ── 天花板兜底:running 超 CEILING(执行进程可能已死)→ 强制 timeout,绝不重跑。轮询读时调用。 ──
export async function forceTimeoutIfExpired(task: PlanTaskRow): Promise<PlanTaskRow> {
  if (task.status !== "running") return task;
  const startedMs = Date.parse(task.startedAt || "");
  if (!Number.isFinite(startedMs) || Date.now() - startedMs <= PLAN_CEILING_MS) return task;
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.COPILOT_PLAN_TASKS,
      Key: { taskId: task.taskId },
      UpdateExpression: "SET #s = :to, finishedAt = :now, #e = :err",
      ConditionExpression: "#s = :running",
      ExpressionAttributeNames: { "#s": "status", "#e": "error" },
      ExpressionAttributeValues: { ":to": "timeout", ":running": "running", ":now": new Date().toISOString(), ":err": "规划超时(超过天花板未完成)" },
    }));
    return { ...task, status: "timeout", error: "规划超时(超过天花板未完成)" };
  } catch (e) {
    if (isConditionalFail(e)) { return (await getPlanTask(task.taskId)) || task; } // 竞态:他人已写终态,重读
    throw e;
  }
}
