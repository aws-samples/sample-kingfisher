export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { noteCentralComponent } from "@/lib/place/central";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { getGenBiObservability } from "@/lib/observability/genbi";
// @kf-batch 50-WP4ter-coverage —— 执行范围(工单 SC-6)。本路由走 `resolveIdentity`(看板是平台级、
// 无 requireProject)⇒ 范围校验的项目上下文取**活跃项目头**,🔴 不许塞 null
// (塞 null 会让设了项目白名单的 target 在这一页恒 403,而它在别的页好得很 —— 阶段 1 的教训)。
import { requireScope } from "@/lib/exec-env/scope";
import { getActiveProjectId } from "@/lib/projects/guard";

// GET /api/observability/genbi — AgentCore/GenBI 可观测看板数据（需登录）。
export async function GET(req: NextRequest) {
  // @kf-batch 50-WP31-place-first-class —— 问数可观测指标 = 唯一 AgentCore(主控区)的指标:显式声明中心件(第一个 await 之前)
  noteCentralComponent("agentcore", "genbi-observability");
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  const scope = await requireScope(req, getActiveProjectId(req));
  if (scope instanceof Response) return scope as never;
  try {
    return apiOk(await getGenBiObservability({ scope }));
  } catch (e: any) {
    return apiError(e?.message || "获取可观测数据失败", 500);
  }
}
