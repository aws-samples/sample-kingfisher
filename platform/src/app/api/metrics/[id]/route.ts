export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { getMetric, updateMetric, deleteMetric } from "@/lib/metrics/service";
import { recordAudit } from "@/lib/audit";

// 指标详情 / 改 / 删。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  const m = await getMetric(params.id);
  if (!m) return apiError("指标不存在", 404);
  return apiOk(m);
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可管理指标", 403);
  const body = await req.json().catch(() => ({}));
  try {
    const updated = await updateMetric(params.id, body);
    if (!updated) return apiError("指标不存在", 404);
    return apiOk(updated);
  } catch (e: any) {
    return apiError(e.message);
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可管理指标", 403);
  try {
    await deleteMetric(params.id);
    recordAudit(req, "metric.delete", { resourceType: "metric", resourceId: params.id }).catch(() => {});
    return apiOk({ deleted: true });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
