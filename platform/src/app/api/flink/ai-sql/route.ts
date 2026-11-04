export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
// 通用 AI 长调用:生成主体在 lib/ai/long-op-executors.ts(flink-ai-sql);45s 未出结果 ⇒ 202 + 轮询。
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";
import { getCorrelationId } from "@/lib/observability/logger";

// POST /api/flink/ai-sql — 自然语言 → Flink SQL(Bedrock Converse,复用 GenBI 模型)。
// 响应:同步 200 `{ sql, model, usage, dialect }` + `_meta`(51 SPEC §3.3a 落点⑥:现有 `model:` 保留 + `_meta`,两值相等 M14);
//   未含 INSERT INTO ⇒ 422;推理模型慢时 202 `{ taskId, async:true }`,客户端传输层(全局 fetch 拦截器)轮询。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  const prompt = String(body.prompt || "").trim();
  const sinkType = String(body.sinkType || "s3");
  if (!prompt) return apiError("请输入要生成 Flink SQL 的自然语言需求", 400);
  if (prompt.length > 2000) return apiError("需求描述过长(≤2000 字)", 400);
  try {
    const result = await submitLongOp(
      { kind: "flink-ai-sql", params: { prompt, sinkType }, correlationId: getCorrelationId(req) },
      { req, identity: ctx.identity },
    );
    return longOpResponse(req, result);
  } catch (e: any) {
    { const lo = longOpErrorResponse(e); if (lo) return lo; }
    return apiError("AI 生成失败: " + String(e?.message || e), 500);
  }
}
