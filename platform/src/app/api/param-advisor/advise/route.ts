export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { apiError } from "@/lib/api-response";
import { requireIdentity } from "@/lib/auth/identity";
import type { ParamAdviceRequest, ParamChannel } from "@/lib/param-advisor";
import { AgentCoreModelMismatch } from "@/lib/ai/agentcore-contract";
// 序 46 B-107 — 通用 AI 长调用:顾问主体在 lib/ai/long-op-executors.ts(param-advise);45s 未出结果 ⇒ 202 + 轮询。
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";
import { getCorrelationId } from "@/lib/observability/logger";

// emr:模块 33-A EMR Serverless(引擎/types/catalog/heuristics 早已支持,此处补齐路由白名单遗漏)。
const CHANNELS: ParamChannel[] = ["glue-etl", "glue-sync", "flink", "dms", "emr"];

// POST /api/param-advisor/advise
// Body: ParamAdviceRequest(channel, workload?, current?, jobRef?, conversationId?, userMessage?)
// 完整顾问:确定性推荐引擎 + 大模型解释 → 推荐清单 + 一键预填。镜像 network-advisor/advise 的记忆装配。
// 响应:同步 200 推荐 + `_meta`(51 SPEC §3.3a 落点④);推理模型慢时(Kimi 下实测 42.8s 贴墙)202 `{ taskId, async:true }`,
//   客户端传输层(全局 fetch 拦截器)轮询 GET /api/long-ops/[taskId](B-107)。
export async function POST(req: NextRequest) {
  let body: ParamAdviceRequest;
  try {
    body = (await req.json()) as ParamAdviceRequest;
  } catch {
    return apiError("请求体无效", 400, { code: "VALIDATION_FAILED" });
  }

  if (!body.channel || !CHANNELS.includes(body.channel)) {
    return apiError(`缺少或未知 channel(可选 ${CHANNELS.join("/")})`, 400, { code: "VALIDATION_FAILED" });
  }

  const identity = await requireIdentity(req);
  if (identity instanceof Response) return identity;

  const conversationId = (body.conversationId || "").trim();
  const projectId = req.headers.get("x-bgp-project") || undefined;

  try {
    const result = await submitLongOp(
      { kind: "param-advise", params: { request: body, conversationId, projectId }, correlationId: getCorrelationId(req) },
      { req, identity },
    );
    return longOpResponse(req, result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // @kf-batch 50-W5-seg2-WP8:AgentCore 模型回执不匹配 ⇒ 503(fail-closed)。
    if (err instanceof AgentCoreModelMismatch) return apiError(msg, 503, { code: "UPSTREAM_ERROR" });
    { const lo = longOpErrorResponse(err); if (lo) return lo; }
    return apiError(`参数顾问处理失败: ${msg}`, 500, { code: "INTERNAL" });
  }
}
