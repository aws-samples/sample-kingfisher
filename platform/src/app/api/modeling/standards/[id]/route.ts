export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { getStandard, updateStandard, deleteStandard } from "@/lib/modeling/service";
import { recordAudit } from "@/lib/audit";

// 模块 35: 数据标准 详情 / 改 / 删。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  const s = await getStandard(params.id);
  if (!s) return apiError("数据标准不存在", 404);
  return apiOk(s);
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可管理数据标准", 403);
  const body = await req.json().catch(() => ({}));
  try {
    const updated = await updateStandard(params.id, body);
    if (!updated) return apiError("数据标准不存在", 404);
    recordAudit(req, "modeling.standard.update", { resourceType: "data-standard", resourceId: params.id }).catch(() => {});
    return apiOk(updated);
  } catch (e: any) {
    return apiError(e.message);
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可管理数据标准", 403);
  try {
    await deleteStandard(params.id);
    recordAudit(req, "modeling.standard.delete", { resourceType: "data-standard", resourceId: params.id }).catch(() => {});
    return apiOk({ deleted: true });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
