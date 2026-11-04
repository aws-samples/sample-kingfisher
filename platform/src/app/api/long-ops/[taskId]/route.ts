export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { requireIdentity } from "@/lib/auth/identity";
import { apiOk, apiError } from "@/lib/api-response";
import { buildAiMeta } from "@/lib/ai/meta";
import { driveExecution } from "@/lib/long-ops/driver";
import { LONG_OP_LABELS } from "@/lib/long-ops/kinds";
import { LONG_OP_TIMEOUT_ERROR, type LongOpStateBody } from "@/lib/long-ops/protocol";
import {
  getLongOp, claimForRun, reclaimStale, forceTimeoutIfExpired, reconcileDecision,
  type LongOpRow,
} from "@/lib/long-ops/store";

// 长操作统一框架 —— 轮询 + 抢占驱动执行 + 读时对账(强制结束)。= `GET /api/ai/tasks/[taskId]` 泛化
// (那条路径保留一版当别名,同一个 handler)。照 GET /api/genbi/tasks/[taskId]。
//
// GET /api/long-ops/[taskId]:全局 fetch 拦截器(lib/long-ops/client/follow.ts)收到 202 后每 ~2s 轮询。
//  · terminal → 直接返回结果 / 错误(succeeded 且有 meta.model 时顶层 `_meta` = 实际用的模型 + 提交那次请求的 correlationId)。
//  · running + 心跳新鲜 → running(执行在提交它的那个 ECS 进程里继续)。
//  · running + 心跳 stale + 未过天花板 → reclaimStale 重认领 → 本进程接管重跑(自愈孤儿任务)。
//  · running + 已过 300s 天花板 → forceTimeoutIfExpired 强制 timeout(**绝不重跑**)。
//  · pending(提交时抢占失败的罕见情形)→ claimForRun 抢占 → 赢者驱动执行。
// 请求 <1s 返回(不 await 执行)→ CloudFront 60s 墙不再触发;响应恒为 JSON → 前端永不 JSON.parse 天书。
// 失败是**任务**的终态而不是这次轮询请求的失败 ⇒ 200 + `status:"failed"`(状态码 / 原信封在 errorStatus / errorBody 里,客户端整形时还原)。

function respond(req: NextRequest, task: LongOpRow, statusOverride?: LongOpRow["status"]) {
  const status = statusOverride || task.status;
  const startedMs = Date.parse(task.startedAt || task.createdAt);
  const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0;
  const succeeded = status === "succeeded";
  const failed = status === "failed";
  const data: LongOpStateBody = {
    taskId: task.taskId,
    kind: task.kind,
    label: LONG_OP_LABELS[task.kind] ?? task.kind,
    status,
    ...(succeeded && task.result !== undefined ? { result: task.result } : {}),
    ...(succeeded && task.resultStatus !== undefined ? { resultStatus: task.resultStatus } : {}),
    ...(succeeded && task.resultRaw ? { resultRaw: true } : {}),
    ...(failed || status === "timeout" ? { error: task.error || (status === "timeout" ? LONG_OP_TIMEOUT_ERROR : "执行失败") } : {}),
    ...(failed && task.errorStatus !== undefined ? { errorStatus: task.errorStatus } : {}),
    ...(failed && task.errorBody !== undefined ? { errorBody: task.errorBody } : {}),
    elapsedMs,
    ...(task.heartbeatAt ? { heartbeatAt: task.heartbeatAt } : {}),
  };
  // 终态成功:`_meta` 与同步分支同形(51 SPEC §3.3a),correlationId 回显提交那次请求的,让结果能对回提交日志。
  return succeeded && task.meta?.model
    ? apiOk(data, 200, buildAiMeta(req, task.meta.model, { correlationId: task.correlationId }))
    : apiOk(data);
}

export async function GET(req: NextRequest, props: { params: Promise<{ taskId: string }> }) {
  const params = await props.params;
  const who = await requireIdentity(req);
  if (who instanceof Response) return who;
  try {
    const task = await getLongOp(params.taskId);
    if (!task) return apiError("任务不存在", 404, { code: "NOT_FOUND" });
    // 归属校验:任务只对创建者可见(严格相等;身份是已校验的 sub)。
    if (task.userId !== who.sub) return apiError("无权访问该任务", 403, { code: "RBAC_DENIED" });

    const action = reconcileDecision(task);
    if (action === "terminal" || action === "running") return respond(req, task);
    if (action === "timeout") {
      await forceTimeoutIfExpired(params.taskId).catch(() => {});
      return respond(req, task, "timeout");
    }
    // claim(pending)/ reclaim(stale running):抢到才驱动执行,抢不到说明别人在跑,均返回 running。
    const token = action === "claim" ? await claimForRun(params.taskId) : await reclaimStale(params.taskId);
    if (token) {
      // fire-and-forget:立即返回,执行在本 ECS 进程后台继续(driveExecution 绝不 reject)。
      void driveExecution(task, token, { req, identity: who });
    }
    return respond(req, task, "running");
  } catch (e: unknown) {
    return apiError(e instanceof Error ? e.message : String(e), 500);
  }
}
