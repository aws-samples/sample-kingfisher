// @kf-batch 50-W3f-T0-T3
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { resolveIdentity } from "@/lib/auth/identity";
import { backfillDataSourcePlacement } from "@/lib/datasource/placement";

// POST /api/admin/datasources/placement-backfill —— 存量数据源补 `ownerTargetId`(门票 T3 的迁移入口)。
// 幂等:只补空缺、不碰已有值、不动 updatedAt;可反复执行。
// 🔴 纵深防御:网关 middleware 已对 /api/admin/** 强制 bgp-admin,路由内仍再守一次(先例 admin/users)。
export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效,请重新登录", 401, { code: "UNAUTHENTICATED" });
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员(bgp-admin)可执行数据迁移", 403, { code: "RBAC_DENIED" });
  try {
    const result = await backfillDataSourcePlacement();
    recordAudit(req, "datasource.placement-backfill", {
      resourceType: "datasource",
      resourceId: "*",
      detail: { ...result },
    }).catch(() => {});
    return apiOk(result);
  } catch (e: unknown) {
    return apiError((e as Error).message || String(e), 500);
  }
}
