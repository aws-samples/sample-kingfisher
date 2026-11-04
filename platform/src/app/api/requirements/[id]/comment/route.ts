export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { addComment, availableActions, getRequirement } from "@/lib/requirements/service";

// POST /api/requirements/[id]/comment — 任意可见者评论（不改状态）。
// Body: { text }
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const r = await getRequirement(params.id);
  if (!r) return apiError("需求不存在", 404);
  const ctx = await requireProject(req, "viewer", r.projectId);
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  const text = String(body?.text || "").trim();
  if (!text) return apiError("评论内容不能为空");
  const updated = await addComment(r, ctx.identity, text);
  return apiOk({ ...updated, _actions: availableActions(updated, ctx.identity) });
}
