// @kf-batch 50-W5-seg2-WP8
// 模块 51 — POST /api/admin/model-config/probe(51 SPEC §2 / §3.4a:真 invoke 探测,6 次/分钟/管理员,写回探测缓存)。
export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { apiOk } from "@/lib/api-response";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { isModelIdFormatValid } from "@/lib/ai/model";
import { probeModel } from "@/lib/ai/probe";
import { registeredPlace } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { requirePlatformAdmin, modelConfigError } from "@/lib/settings/admin-guard";
import { consumeProbeQuota } from "@/lib/settings/probe-ratelimit";

export async function POST(req: NextRequest) {
  const guard = await requirePlatformAdmin(req);
  if (!("identity" in guard)) return guard;

  let body: { modelId?: unknown };
  try {
    body = await req.json();
  } catch {
    return modelConfigError("ValidationFailed", 400, { message: "请求体无效" });
  }
  const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
  if (!isModelIdFormatValid(modelId)) {
    return modelConfigError("ValidationFailed", 400, { message: "modelId 格式不合法" });
  }

  // @kf-batch 50-WP31-place-first-class —— B-35 同形:探测的区从描述符来(原来 probeModel 缺省 process.env.AWS_REGION)。
  //   一期探测只作用于主控区;主控区的 region 也读描述符,不存在 / 没装好 ⇒ 409(放在限频之前:落点解析不开不该吃掉一次额度)。
  let place;
  try {
    place = await registeredPlace(HOME_TARGET_ID, "探测模型");
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    throw e;
  }
  // 限频(fail-closed:计数器不可用也拒,probe 会烧真 Bedrock)。
  const decision = await consumeProbeQuota(guard.identity.sub, Math.floor(Date.now() / 1000));
  if (!decision.allowed) {
    return modelConfigError("RateLimited", 429, {
      retryAfterSec: decision.retryAfterSec ?? 60,
      limit: decision.limit,
      reason: decision.reason,
      message: decision.reason === "store-error" ? "限频计数器不可用,已拒绝探测(fail-closed)" : `探测过于频繁(每分钟最多 ${decision.limit} 次),请 ${decision.retryAfterSec}s 后再试`,
    });
  }

  const result = await probeModel(modelId, { place });
  return apiOk({ ...result, modelId, targetId: place.targetId });
}
