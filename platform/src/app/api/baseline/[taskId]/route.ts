export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { getBaseline } from "@/lib/baseline/learn";

// GET /api/baseline/[taskId] — 某任务学到的基线(viewer)。
export async function GET(req: NextRequest, props: { params: Promise<{ taskId: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  try {
    const baseline = await getBaseline(ctx.projectId, params.taskId);
    if (!baseline) return apiError("该任务尚无基线,请先触发学习", 404, { code: "NOT_FOUND" });
    return apiOk(baseline);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
