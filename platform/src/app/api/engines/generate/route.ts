export const dynamic = "force-dynamic";

// POST /api/engines/generate —— 多引擎 AI 辅助:自然语言意图 → PySpark 实现代码。
// Body: { prompt: string, currentCode?: string, targetId: string }
// EMR Serverless Spark 与 Glue PySpark 同类,复用 codegen 的 "glue"(PySpark)目标。
// 仅返回代码,不创建/不执行任何资源。RBAC: 项目 editor。
// 响应:同步 200 `{ code, explanation, usage, groundedOn }` + `_meta`;推理模型慢时 202 `{ taskId, async:true }`,
//   客户端传输层(全局 fetch 拦截器)轮询 GET /api/long-ops/[taskId]。

import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
// 通用 AI 长调用:生成主体在 lib/ai/long-op-executors.ts(codegen-emr)。
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";
import { getCorrelationId } from "@/lib/observability/logger";

export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;

  const body = await req.json().catch(() => ({}));
  const prompt = (body?.prompt || "").trim();
  const currentCode = typeof body?.currentCode === "string" ? body.currentCode : undefined;
  if (!prompt) return apiError("请描述这个作业要做什么", 400, { code: "VALIDATION_FAILED" });

  try {
    // 按作业绑定的区做目录 grounding(缺 / 非法 ⇒ 400)
    const targetId = requestedTargetId(body?.targetId, "EMR 作业 AI 生成");
    const result = await submitLongOp(
      { kind: "codegen-emr", params: { prompt, currentCode, targetId, projectId: ctx.projectId }, correlationId: getCorrelationId(req) },
      { req, identity: ctx.identity },
    );
    return longOpResponse(req, result);
  } catch (e: any) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    { const lo = longOpErrorResponse(e); if (lo) return lo; }
    return apiError(`生成失败:${e.message || String(e)}`, 500, { code: "UPSTREAM_ERROR" });
  }
}
