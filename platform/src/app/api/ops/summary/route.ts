export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { buildOpsSummary } from "@/lib/alerting/ops-summary";
// @kf-batch 50-WP4ter-coverage —— 执行范围(工单 SC-19)
import { requireScope } from "@/lib/exec-env/scope";

// GET /api/ops/summary — 运维大屏聚合(viewer)。一次性返回大屏所有卡片数据。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  // @kf-batch 50-WP4ter-coverage
  const scope = await requireScope(req, ctx.projectId);
  if (scope instanceof NextResponse) return scope;
  try {
    return apiOk(await buildOpsSummary({ scope }));
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
