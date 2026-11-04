export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { startDiagnosis, listDiagnostics } from "@/lib/diagnostics/service";

// POST /api/diagnostics  body { taskId, runId }
// 用 AWS DevOps Agent 对一次失败运行发起故障诊断（异步，后台调查）。RBAC: 项目 viewer。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  const taskId = (body?.taskId || "").trim();
  const runId = (body?.runId || "").trim();
  if (!taskId || !runId) return apiError("缺少 taskId 或 runId");
  try {
    const rec = await startDiagnosis({ taskId, runId, projectId: ctx.projectId, createdBy: ctx.identity.username });
    recordAudit(req, "diagnostic.start", { resourceType: "diagnostic", resourceId: rec.diagnosticId, detail: { taskId, runId } }).catch(() => {});
    return apiOk({ diagnosticId: rec.diagnosticId, status: rec.status });
  } catch (e: any) {
    return apiError(`发起诊断失败: ${e.message || String(e)}`, 500);
  }
}

// GET /api/diagnostics?taskId=&runId=  列出诊断（按需过滤）。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const taskId = req.nextUrl.searchParams.get("taskId") || undefined;
  const runId = req.nextUrl.searchParams.get("runId") || undefined;
  try {
    const items = await listDiagnostics({ taskId, runId });
    return apiOk(items);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
