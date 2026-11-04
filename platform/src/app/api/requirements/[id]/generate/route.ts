export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { getRequirement, isAssignee } from "@/lib/requirements/service";
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
// 通用 AI 长调用:生成 + 落实现主体在 lib/ai/long-op-executors.ts(codegen-requirement);45s 未出结果 ⇒ 202 + 轮询。
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";
import { getCorrelationId } from "@/lib/observability/logger";

// POST /api/requirements/[id]/generate — 研发用大模型生成实现(不执行)。
// Body: { targetType: "redshift" | "glue", targetId: string }
// 仅被指派的研发可调用;需求须处于 assigned/in_development。
// 响应:同步 200 `{ requirement, generated }` + `_meta`(51 SPEC §3.3a 落点⑤);推理模型慢时 202 `{ taskId, async:true }`,
//   客户端传输层(全局 fetch 拦截器)轮询 GET /api/long-ops/[taskId]。
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const r = await getRequirement(params.id);
  if (!r) return apiError("需求不存在", 404);
  const ctx = await requireProject(req, "viewer", r.projectId);
  if (ctx instanceof NextResponse) return ctx;
  if (!isAssignee(r, ctx.identity)) return apiError("仅被指派的研发可生成实现", 403);
  if (!["assigned", "in_development"].includes(r.status))
    return apiError(`当前状态(${r.status})不可生成实现`, 409);
  const body = await req.json().catch(() => ({}));
  const targetType = body?.targetType === "glue" ? "glue" : "redshift";
  try {
    // 50-WP31-place-first-class—— 按**页面点名的区**做目录 grounding(缺 / 非法 ⇒ 400),
    //   并把「按哪个区生成」记到实现上:「创建作业」据此要求绑定区含它(否则 = 按 A 区的表生成、却建成 B 区作业)。
    const tid = requestedTargetId(body?.targetId, "需求生成实现");
    const result = await submitLongOp(
      { kind: "codegen-requirement", params: { requirementId: r.requirementId, targetType, targetId: tid }, correlationId: getCorrelationId(req) },
      { req, identity: ctx.identity },
    );
    return longOpResponse(req, result);
  } catch (e: any) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    { const lo = longOpErrorResponse(e); if (lo) return lo; }
    return apiError(`生成失败:${e.message}`, 500);
  }
}
