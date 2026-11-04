export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { detectTaskAnomalies, detectServiceAnomalies } from "@/lib/finops/anomaly";
// @kf-batch 50-WP4ter-coverage —— 执行范围(工单 SC-11)
import { requireScope } from "@/lib/exec-env/scope";
// @kf-batch 50-WP6-cost-by-region
import { regionsInViewOf } from "@/lib/finops/cost-region";

// GET /api/finops/anomalies — 当前异常列表(纯读检测,不推送不沉淀;闭环走 POST /detect)。
// 检测本身是内存聚合(读 2 张 finops 自有表),量级小,可同步返回。RBAC: viewer。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  // @kf-batch 50-WP4ter-coverage
  const scope = await requireScope(req, ctx.projectId);
  if (scope instanceof NextResponse) return scope;

  try {
    // 任务级异常按区检测(过滤发生在算基线之前,见 anomaly.ts 的理由)。
    const taskItems = await detectTaskAnomalies({ scope });
    // @kf-batch 50-WP6-cost-by-region —— 服务级异常来自账单,账单已按区采(v2)⇒ 也按区检测,
    // 不再打 `unscoped`(SC-11b 关闭)。无区域归属的全局服务只在全部视角下出现。
    const serviceItems = await detectServiceAnomalies({ regions: await regionsInViewOf(scope) });
    const items = [...taskItems, ...serviceItems];
    return apiOk({ items });
  } catch (e: unknown) {
    return apiError((e as Error).message || String(e), 500);
  }
}
