export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recommendOnly } from "@/lib/param-advisor";
import type { ParamAdviceRequest, ParamChannel } from "@/lib/param-advisor";

// emr:模块 33-A EMR Serverless(引擎/types/catalog/heuristics 早已支持,此处补齐路由白名单遗漏)。
const CHANNELS: ParamChannel[] = ["glue-etl", "glue-sync", "flink", "dms", "emr"];

// POST /api/param-advisor/recommend
// Body: ParamAdviceRequest(channel 必需)。仅确定性推荐引擎(探测历史 + 启发式),零大模型秒回。
// 供 UI 分阶段 loading:推荐表格先出,大模型解释由 /advise 补(标准 §7③ 廉价快路径)。
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

  try {
    const rec = await recommendOnly(body);
    return apiOk(rec);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return apiError(`参数推荐失败: ${msg}`, 500, { code: "INTERNAL" });
  }
}
