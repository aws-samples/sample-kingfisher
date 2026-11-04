export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { updateModelMetric, deleteModelMetric } from "@/lib/modeling/model-metrics";
import { recordAudit } from "@/lib/audit";

// 模块 35 P1 D4: 指标 改 / 删(仅平台管理员)。
export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可管理指标", 403);
  const body = await req.json().catch(() => ({}));
  try {
    const m = await updateModelMetric(params.id, body);
    if (!m) return apiError("指标不存在", 404);
    recordAudit(req, "modeling.metric.update", { resourceType: "model-metric", resourceId: params.id, detail: { name: m.name } }).catch(() => {});
    return apiOk(m);
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
    await deleteModelMetric(params.id);
    recordAudit(req, "modeling.metric.delete", { resourceType: "model-metric", resourceId: params.id }).catch(() => {});
    return apiOk({ deleted: true });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
