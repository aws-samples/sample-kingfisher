export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requestedSubset } from "@/lib/place/resolve";
import { apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { getCorrelationId } from "@/lib/observability/logger";
// 模块 55 / 序 50(B-111 根治):应用主体在 lib/modeling/long-ops.ts(modeling-apply);45s 未终态 ⇒ 202 + 客户端传输层轮询。
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";

// 模块 35 P1 D3: 应用 DDL 到 Redshift(建维度/事实表;仅平台管理员)。
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可应用 DDL", 403);
  try {
    // @kf-batch 50-P50.3-modeling —— 同码表:逐 target + 只观测 + 强制重建(带逐字确认串)。
    const body = await req.json().catch(() => ({}));
    const targets = requestedSubset(body); // @kf-batch 50-WP31-place-first-class —— 不给 = 定义自己的全部绑定(唯一解析作者)
    const force = body?.force === true;
    if (force && String(body?.confirm || "") !== "FORCE-REBUILD") {
      return apiError(
        "强制重建会 DROP 该执行目标上的现有表(有损,先备份)⇒ 需带 confirm=\"FORCE-REBUILD\" 才执行",
        409,
        { code: "DECISION_REQUIRED" }
      );
    }
    const result = await submitLongOp(
      { kind: "modeling-apply", params: { modelTableId: params.id, ...(targets ? { targets } : {}), force, probeOnly: body?.probeOnly === true }, correlationId: getCorrelationId(req) },
      { req, identity },
    );
    return longOpResponse(req, result);
  } catch (e: any) {
    // residency 409 / 503 与「该执行目标现在不能承接」409 的映射在执行体里装进了 LongOpHttpError(原信封逐字回)
    const lo = longOpErrorResponse(e);
    if (lo) return lo;
    return apiError(e.message, 500);
  }
}
