export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { getLayer, updateLayer, deleteLayer } from "@/lib/modeling/service";
import { recordAudit } from "@/lib/audit";

// 模块 35: 数据分层详情 / 改 / 删。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  const l = await getLayer(params.id);
  if (!l) return apiError("分层不存在", 404);
  return apiOk(l);
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可管理数据分层", 403);
  const body = await req.json().catch(() => ({}));
  try {
    const updated = await updateLayer(params.id, body);
    if (!updated) return apiError("分层不存在", 404);
    recordAudit(req, "modeling.layer.update", { resourceType: "data-layer", resourceId: params.id }).catch(() => {});
    return apiOk(updated);
  } catch (e: any) {
    return apiError(e.message);
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可管理数据分层", 403);
  try {
    await deleteLayer(params.id);
    recordAudit(req, "modeling.layer.delete", { resourceType: "data-layer", resourceId: params.id }).catch(() => {});
    return apiOk({ deleted: true });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
