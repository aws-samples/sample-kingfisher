export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { getActiveProjectId } from "@/lib/projects/guard";
import { getPlan, listSteps } from "@/lib/copilot/plan/plan-service";

// GET /api/copilot/plan/[planId] → 计划详情 + 步骤矩阵(供计划表卡片/独立页渲染)。viewer 可读。
export async function GET(req: NextRequest, props: { params: Promise<{ planId: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效,请重新登录", 401);
  const projectId = getActiveProjectId(req);
  try {
    const plan = await getPlan(projectId, params.planId);
    if (!plan) return apiError("执行计划不存在", 404, { code: "NOT_FOUND" });
    const steps = await listSteps(params.planId);
    return apiOk({ plan, steps });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return apiError(`获取计划详情失败: ${msg}`, 500);
  }
}
