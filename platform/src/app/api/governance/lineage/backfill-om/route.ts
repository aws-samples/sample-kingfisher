export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { backfillComputeLineageToOM } from "@/lib/governance/lineage-service";
import { recordAudit } from "@/lib/audit";

// POST /api/governance/lineage/backfill-om —— 把平台 bgp-lineage 里已有的计算血缘(EMR/Flink/SQL
// 计算产出)回填进 OpenMetadata。用于修复「治理页(主读 OM)看不到历史计算表上游」:双写补齐前
// 产生的计算边只写了平台表没进 OM。幂等,可重复跑;仅平台管理员。
export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可回填血缘", 403);
  try {
    const r = await backfillComputeLineageToOM();
    recordAudit(req, "governance.lineage.backfill-om", { resourceType: "lineage", detail: r }).catch(() => {});
    return apiOk(r);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
