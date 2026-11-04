export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { computeAll } from "@/lib/metrics/service";
// 执行目标从 **body** 来,不从 `?scope=`(50 SPEC §2.6.3;写路由不读 scope)。
import { getActiveProjectId } from "@/lib/projects/guard";
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";

// 看板批量计算（每个指标当前值 + 快照）。仅平台管理员（执行 Redshift）。
export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可计算指标", 403);
  try {
    const body = await req.json().catch(() => ({}));
    // 🔴 落点必须点名(缺 / 非法 ⇒ 400,不再「没给 = 主控区」)
    const targetId = requestedTargetId(body?.targetId, "批量计算指标");
    const out = await computeAll({ targetId, projectId: getActiveProjectId(req) });
    // 🔴 可用时**原样回**那张以 metricId 为键的表 —— 页面读的是 `data[metricId]`,
    //    包一层 `{metrics:…}` 会把看板打空(功能守恒:响应形状不许顺手改)。
    //    降级时回能力态对象:可用路径上**没有** `capability` 键,页面据此判别即可。
    return apiOk(out);
  } catch (e: any) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    return apiError(e.message, 500);
  }
}
