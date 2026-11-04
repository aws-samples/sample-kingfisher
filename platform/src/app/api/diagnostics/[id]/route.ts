export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { getDiagnostic } from "@/lib/diagnostics/service";

// GET /api/diagnostics/[id] — 取诊断状态与报告（前端轮询）。RBAC: viewer。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const d = await getDiagnostic(params.id);
  if (!d) return apiError("诊断不存在", 404);
  return apiOk(d);
}
