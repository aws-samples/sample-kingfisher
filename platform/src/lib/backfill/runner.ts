// 模块 43-C — 补数幂等推进器(照抄模块38 tasks.ts 的条件写 + runToken 范式)。
//
// tick(planId) 一次推进(可被前端刷新/定时 DAG 多次触发而不重复提交):
//  1) reconcile:对 running 实例读 bgp-task-runs 终态 → 回写 succeeded/failed(+超时兜底判 failed)
//  2) unblock:blocked 实例若 dependsOn 全 succeeded → 转 pending;若任一上游 failed/skipped → 转 skipped
//  3) claim+submit:受 concurrency 硬闸,把 pending 实例条件写 running(带新 runToken)→ executeInstance
//     领取用条件写 `status=pending` —— 并发多次 tick 里只有一个能领到,杜绝重复 submit(幂等/防烧钱)
//  4) 回写计划 progress + 派生终态
//
// 幂等三保证(同 tasks.ts):① pending→running 条件写(只一个赢)② runToken(僵尸执行者无法覆盖)
// ③ running 超天花板且引擎查无 → reconcile 判 failed(绝不永久卡 running)。

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { executeInstance } from "./execute";
import { getPlan, listInstances, refreshPlanProgress } from "./service";
import type { BackfillInstanceRow, BackfillPlanRow } from "./types";
// 序 37 B-64:启动核心对「上一次 run 收尾中」的异常名(唯一作者 lib/sync/start-run.ts)
import { GLUE_CONCURRENT_RUNS_ERROR } from "@/lib/sync/start-run";

/**
 * 序 37 B-64:同一实例因 Glue「上一次 run 收尾中」(ConcurrentRunsExceededException)被**还回 pending** 的上限
 * (按 attempts 计:claim 每次 +1;泵每 30s 一拍 ⇒ 最多等约 4 分钟)。真环境 2026-10-12 第二轮撞到:并发 1 的同步任务补数,
 * 第二个日期紧接第一个日期启动 ⇒ Glue 还没把上一次 run 收尾完 ⇒ 实例被判 failed、计划「部分失败」。
 * 这不是失败,是「现在不行、下一拍再来」;超过上限仍撞才如实判 failed(有界)。
 */
export const BACKFILL_DEFER_MAX_ATTEMPTS = 8;

// 实例卡 running 超此时长且 bgp-task-runs 仍非终态 → 判失败(防僵尸)。补数 run 可能很长(EMR 大跑),取 2h。
const INSTANCE_CEILING_MS = 2 * 3600 * 1000;

function isConditionalFail(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: string }).name === "ConditionalCheckFailedException";
}

// 领取 pending→running(条件写,赢返回 runToken;null=被他人领走/非 pending)。
async function claimInstance(planId: string, sk: string): Promise<string | null> {
  const runToken = ulid();
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.BACKFILL_INSTANCES,
      Key: { planId, sk },
      UpdateExpression: "SET #s = :running, runToken = :tok, startedAt = :now, attempts = attempts + :one",
      ConditionExpression: "#s = :pending",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":running": "running", ":pending": "pending", ":tok": runToken, ":now": new Date().toISOString(), ":one": 1 },
    }));
    return runToken;
  } catch (e) {
    if (isConditionalFail(e)) return null;
    throw e;
  }
}

// 序 37 B-64:把实例还回 pending(仅当仍是当前 owner 的 running);attempts 保留(claim 已 +1),lastError 记原因让页面看得见。
async function deferInstance(planId: string, sk: string, runToken: string, why: string): Promise<void> {
  await docClient.send(new UpdateCommand({
    TableName: TABLES.BACKFILL_INSTANCES,
    Key: { planId, sk },
    UpdateExpression: "SET #s = :pending, lastError = :e REMOVE runToken, startedAt",
    ConditionExpression: "#s = :running AND runToken = :tok",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":pending": "pending", ":running": "running", ":tok": runToken, ":e": String(why).slice(0, 500) },
  }));
}

// 回写实例终态(仅当仍是当前 owner 的 running,防僵尸覆盖)。
async function finalizeInstance(planId: string, sk: string, runToken: string, status: "succeeded" | "failed", error?: string): Promise<void> {
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.BACKFILL_INSTANCES,
      Key: { planId, sk },
      UpdateExpression: error !== undefined
        ? "SET #s = :st, finishedAt = :now, lastError = :e"
        : "SET #s = :st, finishedAt = :now",
      ConditionExpression: "#s = :running AND runToken = :tok",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: error !== undefined
        ? { ":st": status, ":running": "running", ":tok": runToken, ":now": new Date().toISOString(), ":e": String(error).slice(0, 500) }
        : { ":st": status, ":running": "running", ":tok": runToken, ":now": new Date().toISOString() },
    }));
  } catch (e) {
    if (isConditionalFail(e)) return; // 已被 reconcile/取代 → 不回退
    throw e;
  }
}

// reconcile 单个 running 实例:读底层 run 终态回写(无 owner 条件,reconcile 是权威回收)。
async function reconcileRunning(inst: BackfillInstanceRow): Promise<BackfillInstanceRow> {
  if (inst.status !== "running") return inst;
  let real: "succeeded" | "failed" | null = null;
  let error: string | undefined;
  if (inst.runTaskId && inst.runId) {
    try {
      const { Item: run } = await docClient.send(new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId: inst.runTaskId, runId: inst.runId } }));
      const st = run?.status;
      if (st === "succeeded") real = "succeeded";
      else if (st === "failed" || st === "stopped") { real = "failed"; error = run?.error || "run failed"; }
    } catch { /* 查不到保留 */ }
  }
  // 超天花板兜底:running 太久且引擎仍未回写终态 → 判失败,不永久卡。
  if (!real) {
    const startedMs = Date.parse(inst.startedAt || "");
    if (Number.isFinite(startedMs) && Date.now() - startedMs > INSTANCE_CEILING_MS) { real = "failed"; error = "补数实例超时(引擎未回写终态)"; }
  }
  if (real) {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.BACKFILL_INSTANCES,
      Key: { planId: inst.planId, sk: inst.sk },
      UpdateExpression: real === "failed"
        ? "SET #s = :st, finishedAt = :now, lastError = :e"
        : "SET #s = :st, finishedAt = :now",
      ConditionExpression: "#s = :running",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: real === "failed"
        ? { ":st": real, ":running": "running", ":now": new Date().toISOString(), ":e": String(error || "").slice(0, 500) }
        : { ":st": real, ":running": "running", ":now": new Date().toISOString() },
    })).catch(() => {});
    return { ...inst, status: real, lastError: error };
  }
  return inst;
}

// 解锁 blocked:全上游 succeeded → pending;任一上游 failed/skipped → skipped(级联跳过)。
async function resolveBlocked(inst: BackfillInstanceRow, byKey: Map<string, BackfillInstanceRow>): Promise<BackfillInstanceRow> {
  if (inst.status !== "blocked") return inst;
  const deps = inst.dependsOn.map((sk) => byKey.get(sk)).filter(Boolean) as BackfillInstanceRow[];
  const anyBad = deps.some((d) => d.status === "failed" || d.status === "skipped");
  const allOk = deps.length === inst.dependsOn.length && deps.every((d) => d.status === "succeeded");
  const next = anyBad ? "skipped" : allOk ? "pending" : null;
  if (next) {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.BACKFILL_INSTANCES,
      Key: { planId: inst.planId, sk: inst.sk },
      UpdateExpression: "SET #s = :n",
      ConditionExpression: "#s = :blocked",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":n": next, ":blocked": "blocked" },
    })).catch(() => {});
    return { ...inst, status: next };
  }
  return inst;
}

export interface TickResult {
  planStatus: string;
  progress: BackfillPlanRow["progress"];
  submitted: number;
  running: number;
}

export async function tick(projectId: string, planId: string): Promise<TickResult> {
  const plan = await getPlan(projectId, planId);
  if (!plan) throw new Error("补数计划不存在");

  let instances = await listInstances(planId);

  // 1) reconcile running(串行读 run 记录,量级小)。
  instances = await Promise.all(instances.map((i) => reconcileRunning(i)));

  // 2) 解锁 blocked(可能需多轮传播;这里做一轮足够:下一轮 tick 继续传播下游)。
  const byKey = new Map(instances.map((i) => [i.sk, i]));
  instances = await Promise.all(instances.map((i) => resolveBlocked(i, byKey)));

  // 暂停/取消的计划不再领取新实例(只做 reconcile 与进度回写)。
  const canDispatch = plan.status !== "paused" && plan.status !== "cancelled";

  let submitted = 0;
  const runningNow = instances.filter((i) => i.status === "running").length;
  if (canDispatch) {
    const slots = Math.max(0, plan.concurrency - runningNow);
    // 待跑实例:pending,按 sk 稳定排序(日期→节点),取 slots 个。
    const candidates = instances.filter((i) => i.status === "pending").sort((a, b) => a.sk.localeCompare(b.sk)).slice(0, slots);
    for (const inst of candidates) {
      const runToken = await claimInstance(planId, inst.sk);
      if (!runToken) continue; // 被他人领走 → 跳过(幂等)
      try {
        const res = await executeInstance(plan, { ...inst, status: "running", runToken });
        await docClient.send(new UpdateCommand({
          TableName: TABLES.BACKFILL_INSTANCES,
          Key: { planId, sk: inst.sk },
          UpdateExpression: "SET runTaskId = :rt, runId = :rid",
          ConditionExpression: "#s = :running AND runToken = :tok",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":rt": res.runTaskId, ":rid": res.runId, ":running": "running", ":tok": runToken },
        })).catch(() => {});
        submitted += 1;
      } catch (e: any) {
        // 序 37 B-64:Glue「上一次 run 收尾中」⇒ 还回 pending,泵下一拍(30s)再领;attempts 到上限仍撞才判失败。
        if (e?.name === GLUE_CONCURRENT_RUNS_ERROR && Number(inst.attempts ?? 0) + 1 < BACKFILL_DEFER_MAX_ATTEMPTS) {
          console.warn(`[backfill] ${planId} ${inst.sk} 上一次 run 收尾中,还回 pending 等下一拍(第 ${Number(inst.attempts ?? 0) + 1}/${BACKFILL_DEFER_MAX_ATTEMPTS} 次)`);
          await deferInstance(planId, inst.sk, runToken, e?.message || "上一次运行仍在收尾").catch(() => {});
          continue;
        }
        // submit 本身失败(如脚本为空/节点不支持)→ 立即判 failed,不留卡死的 running。
        await finalizeInstance(planId, inst.sk, runToken, "failed", e?.message || "补数提交失败").catch(() => {});
      }
    }
  }

  // 4) 回写 progress + 派生终态。
  const fresh = await listInstances(planId);
  const updated = await refreshPlanProgress(plan, fresh);
  return {
    planStatus: updated.status,
    progress: updated.progress,
    submitted,
    running: fresh.filter((i) => i.status === "running").length,
  };
}
