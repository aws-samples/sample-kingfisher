export const dynamic = "force-dynamic";
// GET /api/modeling/dimensions/[id]/unbind-preview?targetId= —— 解绑弹窗的影响预览(与码表同形)。
// 主体在 lib/modeling/long-ops.ts(modeling-unbind-preview);目标区数仓冷时 45s 未终态 ⇒ 202 + 客户端传输层轮询。
import { NextRequest } from "next/server";
// 落点只认点名(缺 / 非法 ⇒ 400 PLACE_UNDECIDABLE)
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { getCorrelationId } from "@/lib/observability/logger";
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401, { code: "UNAUTHENTICATED" });
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可查看", 403, { code: "RBAC_DENIED" });
  let targetId: string;
  try {
    targetId = requestedTargetId(req.nextUrl.searchParams.get("targetId"), "解绑维度表预览");
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    throw e;
  }
  try {
    const result = await submitLongOp(
      { kind: "modeling-unbind-preview", params: { entity: "dimension", id: params.id, targetId }, correlationId: getCorrelationId(req) },
      { req, identity },
    );
    return longOpResponse(req, result);
  } catch (e: unknown) {
    const lo = longOpErrorResponse(e);
    if (lo) return lo;
    return apiError((e as Error)?.message ?? String(e), 500, { code: "INTERNAL" } as never);
  }
}
