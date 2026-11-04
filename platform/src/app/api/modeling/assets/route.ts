export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { getAssetBinding, setAssetBinding } from "@/lib/modeling/service";
import { recordAudit } from "@/lib/audit";

// 建模资产归属(表/指标 → 分层/域)。GET ?fqn= 查归属(登录可读);PUT 设置(平台管理员)。
export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  const fqn = req.nextUrl.searchParams.get("fqn");
  if (!fqn) return apiError("缺少 fqn", 400);
  try {
    return apiOk(await getAssetBinding(fqn));
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

export async function PUT(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可设置资产归属", 403);
  const body = await req.json().catch(() => ({}));
  try {
    const binding = await setAssetBinding(body, identity.username);
    recordAudit(req, "modeling.asset.bind", { resourceType: "model-asset", resourceId: binding.fqn, detail: { layerId: binding.layerId, domainId: binding.domainId } }).catch(() => {});
    return apiOk(binding);
  } catch (e: any) {
    return apiError(e.message);
  }
}
