export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
// 通用 AI 长调用:生成主体在 lib/ai/long-op-executors.ts(codegen-etl);45s 未出结果 ⇒ 202 + 轮询。
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";
import { getCorrelationId } from "@/lib/observability/logger";

// POST /api/etl-jobs/generate —— 作业开发 AI 辅助:自然语言意图 → 生产级 ETL 实现代码。
// Body: { prompt: string, targetType: "redshift" | "glue", currentCode?: string, targetId: string }
// 仅返回代码与说明,不创建/不执行任何资源;研发审阅后自行应用到编辑器并保存。RBAC: 项目 editor。
// 响应:同步 200 `{ targetType, code, explanation, usage, groundedOn, dialect }` + `_meta`;推理模型慢时
//   (Kimi 下 maxTokens 6000 的生成 >60s 真撞过)202 `{ taskId, async:true }`,客户端传输层(全局 fetch 拦截器)轮询。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;

  const body = await req.json().catch(() => ({}));
  const prompt = (body?.prompt || "").trim();
  const targetType = body?.targetType === "glue" ? "glue" : "redshift";
  const currentCode = typeof body?.currentCode === "string" ? body.currentCode : undefined;
  if (!prompt) return apiError("请描述这个作业要做什么");

  try {
    // 按作业绑定的区做目录 grounding(页面传作业的章;:缺 / 非法 ⇒ 400)
    const targetId = requestedTargetId(body?.targetId, "作业 AI 生成");
    const result = await submitLongOp(
      { kind: "codegen-etl", params: { prompt, targetType, currentCode, targetId, projectId: ctx.projectId }, correlationId: getCorrelationId(req) },
      { req, identity: ctx.identity },
    );
    return longOpResponse(req, result);
  } catch (e: any) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    { const lo = longOpErrorResponse(e); if (lo) return lo; }
    return apiError(`生成失败:${e.message || String(e)}`, 500);
  }
}
