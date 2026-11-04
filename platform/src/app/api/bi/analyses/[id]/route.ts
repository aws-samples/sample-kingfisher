// 模块 37 v4 — 分析看板单资源路由:GET / PUT(乐观锁)/ DELETE。
// 按资源自身 projectId 鉴权(guardResourceAccess),防越权改别项目的分析看板。照抄 reports 单资源路由。
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject, guardResourceAccess } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { getAnalysis, updateAnalysis, deleteAnalysis, OptimisticLockError } from "@/lib/bi/analysis";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const pre = await requireProject(req, "viewer");
  if (pre instanceof NextResponse) return pre;
  const analysis = await getAnalysis(pre.projectId, params.id);
  if (!analysis) return apiError("分析看板不存在", 404, { code: "NOT_FOUND" });
  return apiOk(analysis);
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const pre = await requireProject(req, "viewer");
  if (pre instanceof NextResponse) return pre;
  const analysis = await getAnalysis(pre.projectId, params.id);
  if (!analysis) return apiError("分析看板不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, analysis, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  const expectedVersion = Number(body?.version);
  if (!Number.isFinite(expectedVersion)) return apiError("缺少 version(乐观锁)", 400, { code: "VALIDATION_FAILED" });
  try {
    const updated = await updateAnalysis(analysis.projectId, params.id, body, expectedVersion);
    recordAudit(req, "bi.analysis.update", { resourceType: "bi-analysis", resourceId: params.id }).catch(() => {});
    return apiOk(updated);
  } catch (e: any) {
    if (e instanceof OptimisticLockError) return apiError(e.message, 409, { code: "CONFLICT" });
    return apiError(e?.message || "更新分析看板失败", 400);
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const pre = await requireProject(req, "viewer");
  if (pre instanceof NextResponse) return pre;
  const analysis = await getAnalysis(pre.projectId, params.id);
  if (!analysis) return apiError("分析看板不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, analysis, "editor");
  if (ctx instanceof NextResponse) return ctx;
  try {
    await deleteAnalysis(analysis.projectId, params.id);
    recordAudit(req, "bi.analysis.delete", { resourceType: "bi-analysis", resourceId: params.id }).catch(() => {});
    return apiOk({ deleted: true });
  } catch (e: any) {
    return apiError(e?.message || "删除分析看板失败", 500);
  }
}
