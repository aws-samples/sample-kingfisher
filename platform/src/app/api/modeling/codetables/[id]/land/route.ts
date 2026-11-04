export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requestedSubset } from "@/lib/place/resolve";
import { apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { getCorrelationId } from "@/lib/observability/logger";
// (根治):落地主体在 lib/modeling/long-ops.ts(modeling-land)。进程内等 45s 未终态 ⇒ 202(协议 long-op/1),
//   客户端传输层(全局 fetch 拦截器)轮询 GET /api/long-ops/[taskId] 到终态再交回同形 200 —— 目标区数仓冷启动不再撞 60s 墙。
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";

// 码表落地 Redshift(建物理码表 dim_code_<code> 并幂等灌入枚举值;仅平台管理员)。
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可落地码表", 403);
  // 逐 target 落地(轴A)。`targets` 缺省 = 定义自身绑定(再缺省 = home)⇒ **存量调用方行为不变**。
  // `probeOnly` = 只重新观测不动库(界面〔检测〕);`force` = 以平台定义**强制重建**(先 DROP,有损)。
  const body = await req.json().catch(() => ({}));
  const targets = requestedSubset(body); // 不给 = 定义自己的全部绑定(唯一解析作者)
  const force = body?.force === true;
  const probeOnly = body?.probeOnly === true;
  // 🔴 强制重建是**有损**的(DROP 该 target 上的现有表)⇒ 必须带逐字确认串,
  //    不许只凭一个布尔开关就把别人的表删了(机制A;与删环境/删项目同一条纪律)。
  if (force && String(body?.confirm || "") !== "FORCE-REBUILD") {
    return apiError(
      "强制重建会 DROP 该执行目标上的现有表(有损,先备份)⇒ 需带 confirm=\"FORCE-REBUILD\" 才执行",
      409,
      { code: "DECISION_REQUIRED" }
    );
  }
  try {
    // 区域审计 / 落地 / 观测 / 审计记录都在执行体里(residency 同意前置 409 / 审计写不成 503 / 目标不能承接 409 由执行体装进 LongOpHttpError)
    const result = await submitLongOp(
      { kind: "modeling-land", params: { codeTableId: params.id, ...(targets ? { targets } : {}), force, probeOnly }, correlationId: getCorrelationId(req) },
      { req, identity },
    );
    return longOpResponse(req, result);
  } catch (e: any) {
    const lo = longOpErrorResponse(e);
    if (lo) return lo;
    return apiError(e.message, 500);
  }
}
