export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
// 执行目标从 **body** 来,不从 `?scope=`(50 SPEC §2.6.3;写路由不读 scope)。
import { getActiveProjectId } from "@/lib/projects/guard";
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { getCorrelationId } from "@/lib/observability/logger";
// 计算主体(computeMetric 数仓直查 → 审计)在 lib/metrics/long-ops.ts(metric-compute);
//   指标 SQL 真环境十几秒、叠上数仓冷启动就撞 60s 墙 ⇒ 超 45 秒由统一框架转 202,页面右下「正在后台执行:计算指标」。
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";

// 计算单个指标(当前值 + 维度分布 + 时间趋势 + 写快照)。仅平台管理员(执行 Redshift)。
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可计算指标", 403);
  try {
    const body = await req.json().catch(() => ({}));
    // 🔴 落点必须点名(缺 / 非法 ⇒ 400):原来「没给 = 主控区」⇒ 页面在「全部」视角发 `{}` 就静默在主控区算
    const targetId = requestedTargetId(body?.targetId, "计算指标");
    const result = await submitLongOp(
      { kind: "metric-compute", params: { metricId: params.id, targetId, projectId: getActiveProjectId(req) }, correlationId: getCorrelationId(req) },
      { req, identity },
    );
    return longOpResponse(req, result);
  } catch (e: any) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    const lo = longOpErrorResponse(e);
    if (lo) return lo;
    return apiError(e.message);
  }
}
