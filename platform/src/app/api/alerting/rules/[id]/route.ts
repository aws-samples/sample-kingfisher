export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject, guardResourceAccess } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { getRule, updateRule, deleteRule, OptimisticLockError } from "@/lib/alerting/rules";

// GET /api/alerting/rules/[id] — 取单条规则(viewer,按规则所属项目鉴权)。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const rule = await getRule(params.id);
  if (!rule) return apiError("规则不存在", 404);
  const ctx = await guardResourceAccess(req, rule, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  return apiOk(rule);
}

// PUT /api/alerting/rules/[id] — 更新规则(editor,乐观锁 version)。body 须带 version。
export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const rule = await getRule(params.id);
  if (!rule) return apiError("规则不存在", 404);
  const ctx = await guardResourceAccess(req, rule, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  const expectedVersion = Number(body?.version);
  if (!Number.isFinite(expectedVersion)) return apiError("缺少 version(乐观锁)");
  try {
    const updated = await updateRule(params.id, body, expectedVersion);
    recordAudit(req, "alerting.rule.update", { resourceType: "alert-rule", resourceId: params.id, detail: { name: updated.name } }).catch(() => {});
    return apiOk(updated);
  } catch (e: any) {
    if (e instanceof OptimisticLockError) return apiError(e.message, 409, { code: "CONFLICT" });
    return apiError(e.message, 400);
  }
}

// DELETE /api/alerting/rules/[id] — 删除规则(editor)。
export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const rule = await getRule(params.id);
  if (!rule) return apiError("规则不存在", 404);
  const ctx = await guardResourceAccess(req, rule, "editor");
  if (ctx instanceof NextResponse) return ctx;
  try {
    await deleteRule(params.id);
    recordAudit(req, "alerting.rule.delete", { resourceType: "alert-rule", resourceId: params.id, detail: { name: rule.name } }).catch(() => {});
    return apiOk({ deleted: true });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
