export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { computeHealth } from "@/lib/governance/health-service";
// 治理健康分按区。三路信号(质量 / 血缘 / 分类)
// 已改成按区分区键,表全集也从**那个区的数仓**探 ⇒ 现在能出「这个区自己的分」了。
import { governanceTargetFrom } from "@/lib/governance/scoped-fqn";
import { getActiveProjectId } from "@/lib/projects/guard";

// (E2): 治理健康分 / 工作台聚合。
//   GET [?refresh=1] → 治理健康总分 + 维度分 + 资产榜 + 待办清单（登录可读，纯聚合）

export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  try {
    return apiOk(await computeHealth(refresh, governanceTargetFrom(req.nextUrl.searchParams), getActiveProjectId(req)));
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
