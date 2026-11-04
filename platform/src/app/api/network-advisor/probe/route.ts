export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { probe, placeConnectivityRequest } from "@/lib/network-advisor";
import type { ConnectivityRequest } from "@/lib/network-advisor";
import { placeErrorResponse } from "@/lib/place/route";

// POST /api/network-advisor/probe
// Body: ConnectivityRequest(至少 targets + targetId)。仅 L1 确定性探测,返回 EnvironmentFacts。
// 便宜、无大模型——供 UI 快速预览当前环境/目标解析结果。
// @kf-batch 41-B115-netadvisor-place —— 落点:请求体 targetId 点名(缺 ⇒ 400 PLACE_UNDECIDABLE;执行环境不存在 / 不可用 ⇒ 409
//   PLACE_UNAVAILABLE),region 由描述符解析后写进请求 —— **不默认主控区**(原来永远探主控区的 VPC)。
export async function POST(req: NextRequest) {
  let body: ConnectivityRequest;
  try {
    body = (await req.json()) as ConnectivityRequest;
  } catch {
    return apiError("请求体无效", 400, { code: "VALIDATION_FAILED" });
  }

  if (!body.computeKind) body.computeKind = "generic";
  if (!Array.isArray(body.targets)) body.targets = [];

  try {
    const placed = await placeConnectivityRequest(body, "network-advisor/probe");
    const facts = await probe(placed);
    return apiOk(facts);
  } catch (err: unknown) {
    const placeErr = placeErrorResponse(err);
    if (placeErr) return placeErr;
    const msg = err instanceof Error ? err.message : String(err);
    return apiError(`环境探测失败: ${msg}`, 500, { code: "INTERNAL" });
  }
}
