export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { apiError } from "@/lib/api-response";
import { requireIdentity } from "@/lib/auth/identity";
import type { ConnectivityRequest } from "@/lib/network-advisor";
import { placeConnectivityRequest } from "@/lib/network-advisor";
import { placeErrorResponse } from "@/lib/place/route";
import { AgentCoreModelMismatch } from "@/lib/ai/agentcore-contract";
// 序 46 B-107 — 通用 AI 长调用:顾问主体在 lib/ai/long-op-executors.ts(net-advise);45s 未出结果 ⇒ 202 + 轮询。
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";
import { getCorrelationId } from "@/lib/observability/logger";

// POST /api/network-advisor/advise
// Body: ConnectivityRequest(computeKind, targets, constraints?, conversationId?, userMessage?, ...)
// 完整顾问:L1 探测 + L2 裁决 + L3 大模型解释 → 结构化建议 + 一键预填。镜像 genbi/ask 的记忆装配。
// 响应:同步 200 建议 + `_meta`(51 SPEC §3.3a 落点③);推理模型慢时(网络顾问工具循环没有墙钟,Kimi 下 >60s 真撞过)
//   202 `{ taskId, async:true }`,客户端传输层(全局 fetch 拦截器)轮询 GET /api/long-ops/[taskId](B-107)。
export async function POST(req: NextRequest) {
  let body: ConnectivityRequest;
  try {
    body = (await req.json()) as ConnectivityRequest;
  } catch {
    return apiError("请求体无效", 400, { code: "VALIDATION_FAILED" });
  }

  if (!body.computeKind || !Array.isArray(body.targets) || body.targets.length === 0) {
    return apiError("缺少 computeKind 或 targets", 400, { code: "VALIDATION_FAILED" });
  }

  const identity = await requireIdentity(req);
  if (identity instanceof Response) return identity;

  const conversationId = (body.conversationId || "").trim();
  const projectId = req.headers.get("x-bgp-project") || undefined;

  try {
    // @kf-batch 41-B115-netadvisor-place —— 落点在**进长操作之前**定下来(缺 targetId ⇒ 400;执行环境不可用 ⇒ 409;不默认主控区);
    //   已落点的请求连同 region 一起进执行体 / AgentCore 容器 / 技能 Lambda,它们按它建客户端。
    const placed = await placeConnectivityRequest(body, "network-advisor/advise");
    const result = await submitLongOp(
      { kind: "net-advise", params: { request: placed, conversationId, projectId }, correlationId: getCorrelationId(req) },
      { req, identity },
    );
    return longOpResponse(req, result);
  } catch (err: unknown) {
    const placeErr = placeErrorResponse(err);
    if (placeErr) return placeErr;
    const msg = err instanceof Error ? err.message : String(err);
    // @kf-batch 50-W5-seg2-WP8:AgentCore 模型回执不匹配 ⇒ 503(fail-closed)。
    if (err instanceof AgentCoreModelMismatch) return apiError(msg, 503, { code: "UPSTREAM_ERROR" });
    { const lo = longOpErrorResponse(err); if (lo) return lo; }
    return apiError(`网络顾问处理失败: ${msg}`, 500, { code: "INTERNAL" });
  }
}
