export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { getSla, updateSla, deleteSla } from "@/lib/baseline/sla-service";

// GET /api/sla/[id] — 单条 SLA(viewer)。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const sla = await getSla(ctx.projectId, params.id);
  if (!sla) return apiError("SLA 不存在", 404, { code: "NOT_FOUND" });
  return apiOk(sla);
}

// PUT /api/sla/[id] — 更新 SLA(editor,乐观锁 version)。
export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  try {
    const sla = await updateSla(ctx.projectId, params.id, body);
    recordAudit(req, "sla.update", { resourceType: "sla", resourceId: params.id, detail: { name: sla.name } }).catch(() => {});
    return apiOk(sla);
  } catch (e: any) {
    if (e?.code === "CONFLICT" || e?.name === "ConditionalCheckFailedException") return apiError("版本冲突,请刷新后重试", 409, { code: "CONFLICT" });
    return apiError(e.message, 400, { code: "VALIDATION_FAILED" });
  }
}

// DELETE /api/sla/[id] — 删除 SLA(editor)。
export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  try {
    await deleteSla(ctx.projectId, params.id);
    recordAudit(req, "sla.delete", { resourceType: "sla", resourceId: params.id }).catch(() => {});
    return apiOk({ deleted: true });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
