export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { availableActions, getRequirement } from "@/lib/requirements/service";

// GET /api/requirements/[id] — 需求详情（调用者须为该需求所属项目成员）。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const r = await getRequirement(params.id);
  if (!r) return apiError("需求不存在", 404);
  const ctx = await requireProject(req, "viewer", r.projectId);
  if (ctx instanceof NextResponse) return ctx;
  return apiOk({ ...r, _actions: availableActions(r, ctx.identity) });
}
