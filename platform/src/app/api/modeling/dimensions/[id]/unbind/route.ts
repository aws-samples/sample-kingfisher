export const dynamic = "force-dynamic";
// POST /api/modeling/dimensions/[id]/unbind —— 维度 / 事实表从某个执行区**显式解绑**(50 SPEC v3.20 §3.8;仅平台管理员)。
// 语义与码表完全一致(只解绑 = 记录保留 ⇒ 残留可见;清理 = 先 DROP、观测为空、再去记录;confirm = 物理表名)。
// 主体在 lib/modeling/long-ops.ts(modeling-unbind);45s 未终态 ⇒ 202 + 客户端传输层轮询(错误口径逐字不变)。
import { NextRequest } from "next/server";
// 落点只认点名(缺 / 非法 ⇒ 400 PLACE_UNDECIDABLE)
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { getCorrelationId } from "@/lib/observability/logger";
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401, { code: "UNAUTHENTICATED" });
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可解绑维度 / 事实表", 403, { code: "RBAC_DENIED" });
  const body = await req.json().catch(() => ({}));
  let targetId: string;
  try {
    targetId = requestedTargetId(body?.targetId, "解绑维度表");
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    throw e;
  }
  const cleanup = body?.cleanup === true;
  const confirm = body?.confirm === undefined || body?.confirm === null ? undefined : String(body.confirm);
  try {
    const result = await submitLongOp(
      { kind: "modeling-unbind", params: { entity: "dimension", id: params.id, targetId, cleanup, ...(confirm !== undefined ? { confirm } : {}) }, correlationId: getCorrelationId(req) },
      { req, identity },
    );
    return longOpResponse(req, result);
  } catch (e: unknown) {
    // UnbindRejected ⇒ 404 / 400;DROP 失败 ⇒ 502「落地产物未清理、记录与绑定保留」—— 都由执行体装进 LongOpHttpError
    const lo = longOpErrorResponse(e);
    if (lo) return lo;
    return apiError((e as Error)?.message ?? String(e), 500);
  }
}
