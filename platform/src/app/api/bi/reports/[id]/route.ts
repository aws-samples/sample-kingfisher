// 模块 37 — 报表 widget 单资源路由:GET / PUT(乐观锁)/ DELETE。
// 按资源自身 projectId 鉴权(guardResourceAccess),防越权改别项目的报表。
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject, guardResourceAccess } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { getReport, updateReport, deleteReport, OptimisticLockError } from "@/lib/bi/reports";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  // 读:先确认 viewer 再取(取用当前 project)。
  const pre = await requireProject(req, "viewer");
  if (pre instanceof NextResponse) return pre;
  const report = await getReport(pre.projectId, params.id);
  if (!report) return apiError("报表不存在", 404, { code: "NOT_FOUND" });
  return apiOk(report);
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const pre = await requireProject(req, "viewer");
  if (pre instanceof NextResponse) return pre;
  const report = await getReport(pre.projectId, params.id);
  if (!report) return apiError("报表不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, report, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  const expectedVersion = Number(body?.version);
  if (!Number.isFinite(expectedVersion)) return apiError("缺少 version(乐观锁)", 400, { code: "VALIDATION_FAILED" });
  try {
    const updated = await updateReport(report.projectId, params.id, body, expectedVersion);
    recordAudit(req, "bi.report.update", { resourceType: "bi-report", resourceId: params.id }).catch(() => {});
    return apiOk(updated);
  } catch (e: any) {
    if (e instanceof OptimisticLockError) return apiError(e.message, 409, { code: "CONFLICT" });
    return apiError(e?.message || "更新报表失败", 400);
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const pre = await requireProject(req, "viewer");
  if (pre instanceof NextResponse) return pre;
  const report = await getReport(pre.projectId, params.id);
  if (!report) return apiError("报表不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, report, "editor");
  if (ctx instanceof NextResponse) return ctx;
  try {
    await deleteReport(report.projectId, params.id);
    recordAudit(req, "bi.report.delete", { resourceType: "bi-report", resourceId: params.id }).catch(() => {});
    return apiOk({ deleted: true });
  } catch (e: any) {
    return apiError(e?.message || "删除报表失败", 500);
  }
}
