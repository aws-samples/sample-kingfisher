export const dynamic = "force-dynamic";
// @kf-batch 52-P52.1-guards
// 模块 35 P1 D4: 计算指标(只读 Redshift 聚合)。
//
// 🔴 **改动前**:只有 `resolveIdentity`(那是**认证**,不是**授权**),原注释还写着"登录可读"
//    ⇒ **登录即用**、指标定义里的 fqn 任意 ⇒ 可借道 `SELECT SUM(salary) FROM proj_B`
//    (52 DESIGN §279 的 R13-C 已坐实这一条;台账 §11.2 第 10 项)。
//
// 🔴 **为什么是 `isPlatformAdmin` 而不是"或项目成员"**:模型指标这个资源**没有 projectId**
//    (建模/指标体系是全局的)⇒ "项目成员校验"对它**恒真**、≈ 放行。SPEC §2 明确写了
//    「**不是**'或项目成员校验'」。要么平台 admin,要么等 §7bis 数据面隔离把 fqn 按项目裁剪。
//
// 🔴 **同族三个端点,只有这一个漏了**:`api/metrics/[id]/compute:12` 与 `api/metrics/compute-all:11`
//    早就是 `if (!identity.isPlatformAdmin) return 403` + audit。本笔照它们**逐字抄**,
//    不发明第二种写法(同族不一致本身就是下一个洞的入口)。
// 模块 55 / 序 50 第二批:计算主体(computeModelMetric → execScalarAt 经 awaitTerminal 等 Redshift Data 终态 → 审计)在
//   lib/modeling/long-ops.ts(modeling-metric-compute);超 45 秒由统一框架转 202,页面右下「正在后台执行:计算模型指标」。
import { NextRequest } from "next/server";
import { apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
// @kf-batch 50-WP31-place-first-class —— 落点只认点名(缺 / 非法 ⇒ 400;原来非法值静默改成主控区)
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { getActiveProjectId } from "@/lib/projects/guard";
import { getCorrelationId } from "@/lib/observability/logger";
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可计算指标", 403);
  try {
    // @kf-batch 50-WP4quater-reads(工单 SC-37)—— 🔴 在哪个区算,由请求显式给。
    // @kf-batch 50-WP31-place-first-class —— 不再「缺省 / 非法 = 主控区」:前端恒带落点,缺 ⇒ 400。
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    let tid: string;
    try {
      tid = requestedTargetId(body?.targetId, "计算指标");
    } catch (e) {
      const r = placeErrorResponse(e);
      if (r) return r;
      throw e;
    }
    // 凭证按请求的活跃项目取(与 /api/metrics/[id]/compute 同一口径:getActiveProjectId)
    const result = await submitLongOp(
      { kind: "modeling-metric-compute", params: { modelMetricId: params.id, targetId: tid, projectId: getActiveProjectId(req) }, correlationId: getCorrelationId(req) },
      { req, identity },
    );
    return longOpResponse(req, result);
  } catch (e: any) {
    const lo = longOpErrorResponse(e);
    if (lo) return lo;
    return apiError(e.message, 500);
  }
}
