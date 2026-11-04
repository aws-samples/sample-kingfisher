export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { tick } from "@/lib/backfill/runner";

// POST /api/backfill/[planId]/tick — 幂等推进器(前端刷新/手动/定时触发均可,重复调用不重复提交)。
// editor(写操作)。返回本次推进结果 + 最新进度。
export async function POST(req: NextRequest, props: { params: Promise<{ planId: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  try {
    const result = await tick(ctx.projectId, params.planId);
    return apiOk(result);
  } catch (e: any) {
    return apiError(e?.message || "推进失败", 500);
  }
}
