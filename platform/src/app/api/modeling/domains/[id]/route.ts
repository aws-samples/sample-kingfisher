export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { getDomain, updateDomain, deleteDomain } from "@/lib/modeling/service";
import { recordAudit } from "@/lib/audit";

// 数据域/主题域 详情 / 改 / 删。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  const d = await getDomain(params.id);
  if (!d) return apiError("数据域不存在", 404);
  return apiOk(d);
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可管理数据域", 403);
  const body = await req.json().catch(() => ({}));
  try {
    const updated = await updateDomain(params.id, body);
    if (!updated) return apiError("数据域不存在", 404);
    recordAudit(req, "modeling.domain.update", { resourceType: "data-domain", resourceId: params.id }).catch(() => {});
    return apiOk(updated);
  } catch (e: any) {
    return apiError(e.message);
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可管理数据域", 403);
  try {
    await deleteDomain(params.id);
    recordAudit(req, "modeling.domain.delete", { resourceType: "data-domain", resourceId: params.id }).catch(() => {});
    return apiOk({ deleted: true });
  } catch (e: any) {
    return apiError(e.message);
  }
}
