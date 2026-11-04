export const dynamic = "force-dynamic";

import { requireIdentity } from "@/lib/auth/identity";
import { NextRequest } from "next/server";
import { targetOfStamp } from "@/lib/exec-env/target-id";
import { apiOk, apiError } from "@/lib/api-response";
import { executeGenBiAsk, persistGenBiSideEffects } from "@/lib/genbi/execute";
import {
  getTask, claimForRun, reclaimStale, heartbeat, markSucceeded, markFailed, markTimeoutByOwner,
  forceTimeoutIfExpired, reconcileDecision, CEILING_MS, HEARTBEAT_INTERVAL_MS,
  type GenBiTaskRow,
} from "@/lib/genbi/tasks";
import type { Identity } from "@/lib/auth/identity";
// @kf-batch 50-W5-seg2-WP8 — 模块 51:把认领请求的 correlationId 透进执行体(终态 result._meta.correlationId)。
import { getCorrelationId } from "@/lib/observability/logger";

// 模块 38 — GenBI 异步化:轮询 + 抢占驱动执行 + 心跳 + 读时对账(强制结束)。
//
// GET /api/genbi/tasks/[taskId]:前端每 ~2s 轮询。本端点是**执行的唯一驱动入口**:
//  · pending  → claimForRun 抢占(幂等,只一个赢)→ 赢者 fire-and-forget 后台跑 executeGenBiAsk。
//  · running + 心跳 stale + 未过天花板 → reclaimStale 重认领 → 重跑(自愈孤儿任务)。
//  · running + 已过 300s 天花板 → forceTimeoutIfExpired 强制 timeout(**绝不重跑**,用户红线)。
//  · terminal → 直接返回结果/错误。
// 请求 <1s 返回(不 await 执行)→ CloudFront 60s 墙不再触发;响应恒为 JSON → 前端永不 JSON.parse 天书。

// 后台执行体(fire-and-forget):挂 AbortController + 300s 天花板定时器 + 心跳循环。
// 到天花板主动 abort → executeGenBiAsk 内部长调用停止消耗算力 → 写 timeout。
async function driveExecution(task: GenBiTaskRow, runToken: string, identity: Identity | null, correlationId?: string): Promise<void> {
  const controller = new AbortController();
  const ceilingTimer = setTimeout(() => controller.abort(), CEILING_MS);
  const hbTimer = setInterval(() => { heartbeat(task.taskId, runToken).catch(() => {}); }, HEARTBEAT_INTERVAL_MS);
  try {
    const { result, usedBackend, targetId: ranInTarget } = await executeGenBiAsk({
      question: task.question,
      engine: task.engine,
      workgroup: task.workgroup,
      database: task.database,
      // @kf-batch 50-WP2-directquery —— 落点跟着任务行走(异步任务由**另一次请求**接管,
      // 不从这次请求的上下文猜:猜出来的区就是「换个人接手就换了个区」)。
      targetId: targetOfStamp(task.targetId), // @kf-batch 50-WP31-place-first-class —— 任务行的章(无章 = 存量 = 主控区)
      projectId: task.projectId,
      conversationId: task.conversationId,
      userId: task.userId,
      identity,
      correlationId,
    }, { abortSignal: controller.signal });
    // 只有真正落终态的 owner 才记副作用(历史/记忆)——重认领重跑的旧 owner markSucceeded 返回
    // false(runToken 不符/已终态),不重复记。保证同一问答只记一次。
    const won = await markSucceeded(task.taskId, runToken, result, usedBackend);
    if (won) {
      persistGenBiSideEffects({
        userId: task.userId, question: task.question, answer: result.answer, sql: result.sql,
        engine: task.engine, backend: usedBackend, projectId: task.projectId,
        conversationId: task.conversationId, result,
        // @kf-batch 50-WP4ter-coverage —— 异步路径同样盖章(落点跟任务行走)
        targetId: ranInTarget,
      });
    }
  } catch (e: unknown) {
    // 到天花板 abort → timeout(强制结束);其余 → failed。终态条件写:若已被 reconcile 抢先判
    // timeout,markX 因 status≠running no-op,状态不回退(幂等收口)。
    if (controller.signal.aborted) {
      await markTimeoutByOwner(task.taskId, runToken).catch(() => {});
    } else {
      await markFailed(task.taskId, runToken, e instanceof Error ? e.message : String(e)).catch(() => {});
    }
  } finally {
    clearTimeout(ceilingTimer);
    clearInterval(hbTimer);
  }
}

function respond(task: GenBiTaskRow, statusOverride?: GenBiTaskRow["status"]) {
  const status = statusOverride || task.status;
  const startedMs = Date.parse(task.startedAt || task.createdAt);
  const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0;
  return apiOk({
    taskId: task.taskId,
    status,
    ...(status === "succeeded" && task.result ? { result: task.result } : {}),
    ...(status === "failed" || status === "timeout" ? { error: task.error || (status === "timeout" ? "GENBI_TIMEOUT" : "执行失败") } : {}),
    elapsedMs,
    ...(task.heartbeatAt ? { heartbeatAt: task.heartbeatAt } : {}),
  });
}

export async function GET(req: NextRequest, props: { params: Promise<{ taskId: string }> }) {
  const params = await props.params;
  const who = await requireIdentity(req);
  if (who instanceof Response) return who;
  try {
    const task = await getTask(params.taskId);
    if (!task) return apiError("任务不存在", 404, { code: "NOT_FOUND" });
    // 归属校验:任务只对创建者可见(GenBI 是个人问答,taskId 仅在本人前端内存)。
    // 🔴 生产上线批次 A:严格相等(原来 `task.userId &&` ⇒ 缺 userId 的任务谁都能读);身份是已校验的 sub。
    if (task.userId !== who.sub) return apiError("无权访问该任务", 403, { code: "RBAC_DENIED" });

    const action = reconcileDecision(task);

    if (action === "terminal" || action === "running") {
      return respond(task);
    }

    if (action === "timeout") {
      // 孤儿超天花板:强制收口 timeout,绝不重跑。
      await forceTimeoutIfExpired(params.taskId).catch(() => {});
      return respond(task, "timeout");
    }

    // claim(pending) / reclaim(stale running):抢到才驱动执行,抢不到说明别人在跑,均返回 running。
    const token = action === "claim" ? await claimForRun(params.taskId) : await reclaimStale(params.taskId);
    if (token) {
      const identity = who;
      // fire-and-forget:立即返回,执行在 ECS 进程后台继续(driveExecution 内部全 try/catch)。
      driveExecution(task, token, identity, getCorrelationId(req)).catch(() => {});
    }
    return respond(task, "running");
  } catch (e: unknown) {
    return apiError(e instanceof Error ? e.message : String(e), 500);
  }
}
