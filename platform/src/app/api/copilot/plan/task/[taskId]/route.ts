export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { getActiveProjectId } from "@/lib/projects/guard";
import { getPlanTask, forceTimeoutIfExpired } from "@/lib/copilot/plan/plan-task-service";
import { runPlanTask } from "@/lib/copilot/plan/plan-task-runner";
import { getPlan, listSteps } from "@/lib/copilot/plan/plan-service";
// `_meta` 回显(异步终态:任务项 usedModelId;SPEC §3.3a ⑧)。
import { buildAiMeta } from "@/lib/ai/meta";
import type { SourceLayer } from "@/lib/ai/capabilities";

// GET /api/copilot/plan/task/[taskId] → 轮询规划任务状态;成功则内嵌 plan+steps。
// 自愈:若仍 pending(提交时 fire-and-forget 没起来,如 ECS 换实例)→ 用本请求 token 补触发执行体。
// 天花板兜底:running 超时强制 timeout(执行进程已死也不永久卡)。
export async function GET(req: NextRequest, props: { params: Promise<{ taskId: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效,请重新登录", 401);
  const projectId = getActiveProjectId(req);

  try {
    let task = await getPlanTask(params.taskId);
    if (!task) return apiError("规划任务不存在", 404, { code: "NOT_FOUND" });
    // 项目隔离:只看本项目的任务。
    if (task.projectId && task.projectId !== projectId) return apiError("无权访问该任务", 403, { code: "RBAC_DENIED" });

    // 天花板兜底(可能把 running 超时的判 timeout)。
    task = await forceTimeoutIfExpired(task);

    // 自愈:仍 pending → 用本请求 token 补触发执行体(fire-and-forget,幂等 claim 防重复)。
    if (task.status === "pending") {
      const authz = req.headers.get("authorization") || "";
      const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
      runPlanTask(task, token).catch(() => {});
    }

    // 成功:内嵌计划详情(前端一次拿到,无需再请求)。
    if (task.status === "succeeded" && task.planId) {
      const plan = await getPlan(projectId, task.planId);
      const steps = plan ? await listSteps(task.planId) : [];
      const meta = task.usedModelId
        ? buildAiMeta(req, { modelId: task.usedModelId, modelSource: (task.usedModelSource as SourceLayer | undefined) ?? "runtime" })
        : undefined;
      return apiOk({ status: task.status, taskId: task.taskId, planId: task.planId, degraded: !!task.degraded, usedModelId: task.usedModelId, usedModelSource: task.usedModelSource, plan, steps }, 200, meta);
    }

    return apiOk({
      status: task.status, taskId: task.taskId,
      error: task.error, progress: task.progress,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return apiError(`获取规划任务失败: ${msg}`, 500);
  }
}
