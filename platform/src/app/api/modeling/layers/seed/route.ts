export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { seedLayers } from "@/lib/modeling/service";
import { recordAudit } from "@/lib/audit";

// 模块 35: 一键预置标准分层 ODS/DWD/DWS/ADS(幂等;仅平台管理员)。
export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可预置分层", 403);
  try {
    const created = await seedLayers(identity.username);
    recordAudit(req, "modeling.layer.seed", { resourceType: "data-layer", detail: { created: created.length } }).catch(() => {});
    return apiOk({ created, count: created.length });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
