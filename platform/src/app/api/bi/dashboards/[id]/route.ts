// 仪表盘单资源路由:GET / PUT(乐观锁)/ DELETE。
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject, guardResourceAccess } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { getDashboard, updateDashboard, deleteDashboard, OptimisticLockError } from "@/lib/bi/dashboards";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const pre = await requireProject(req, "viewer");
  if (pre instanceof NextResponse) return pre;
  const dashboard = await getDashboard(pre.projectId, params.id);
  if (!dashboard) return apiError("仪表盘不存在", 404, { code: "NOT_FOUND" });
  return apiOk(dashboard);
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const pre = await requireProject(req, "viewer");
  if (pre instanceof NextResponse) return pre;
  const dashboard = await getDashboard(pre.projectId, params.id);
  if (!dashboard) return apiError("仪表盘不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, dashboard, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  const expectedVersion = Number(body?.version);
  if (!Number.isFinite(expectedVersion)) return apiError("缺少 version(乐观锁)", 400, { code: "VALIDATION_FAILED" });
  try {
    const updated = await updateDashboard(dashboard.projectId, params.id, body, expectedVersion);
    recordAudit(req, "bi.dashboard.update", { resourceType: "bi-dashboard", resourceId: params.id }).catch(() => {});
    return apiOk(updated);
  } catch (e: any) {
    if (e instanceof OptimisticLockError) return apiError(e.message, 409, { code: "CONFLICT" });
    return apiError(e?.message || "更新仪表盘失败", 400);
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const pre = await requireProject(req, "viewer");
  if (pre instanceof NextResponse) return pre;
  const dashboard = await getDashboard(pre.projectId, params.id);
  if (!dashboard) return apiError("仪表盘不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, dashboard, "editor");
  if (ctx instanceof NextResponse) return ctx;
  try {
    await deleteDashboard(dashboard.projectId, params.id);
    recordAudit(req, "bi.dashboard.delete", { resourceType: "bi-dashboard", resourceId: params.id }).catch(() => {});
    return apiOk({ deleted: true });
  } catch (e: any) {
    return apiError(e?.message || "删除仪表盘失败", 500);
  }
}
