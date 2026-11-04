export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { listCostDaily, scanAllCostRuns } from "@/lib/finops/store";
import type { TaskCostSummary } from "@/lib/finops/types";
// @kf-batch 50-WP4ter-coverage —— 执行范围(工单 SC-11)。成本 run 行**已经有** `targetId`
// (WP-0 T1 落的章),所以这里是纯读侧接线:A 类标量,内存过滤(这张表的唯一读法就是全表 Scan)。
// 🔴 计数**随本响应回**,不走 `/api/scope/counts`:那个端点不带天窗,数字会与列表打架(台账 N-7)。
import { requireScope, filterRowsByScalar, countRowsByScalar, scalarTargetOf } from "@/lib/exec-env/scope";
// @kf-batch 50-WP6-cost-by-region(WP-6 施工序 3,O3b)—— 排行按 (task, target) 分组 + 「已归因 / 未分摊」按 region 对账
import { regionOfTargets, regionsInViewOf } from "@/lib/finops/cost-region";
import { monthsCovering, reconcileByRegion } from "@/lib/finops/region-cost";
import { scopeTargets } from "@/lib/scope/scope";

// GET /api/finops/tasks?engine=&days= — L3 任务成本排行(纯读聚合)。RBAC: viewer。
// 响应:{ items, days, countsByTarget, reconcile }。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  // @kf-batch 50-WP4ter-coverage
  const scope = await requireScope(req, ctx.projectId);
  if (scope instanceof NextResponse) return scope;

  const sp = req.nextUrl.searchParams;
  const engine = sp.get("engine") || undefined;
  const days = parseInt(sp.get("days") || "30", 10) || 30;

  try {
    // @kf-batch 50-WP6-cost-by-region —— 天窗对齐到 **UTC 日界**:账单是按日的,run 窗口若从「此刻 − N 天」起,
    // 对账时首日的账单整天算进来而 run 只算半天 ⇒ 未分摊凭空多出半天。两边用同一个 windowFrom。
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const windowFrom = new Date(now.getTime() - days * 86400_000).toISOString().slice(0, 10);
    const cutoff = `${windowFrom}T00:00:00.000Z`;
    const windowRuns = (await scanAllCostRuns()).filter((r) => r.finishedAt >= cutoff);

    // ── O3b 对账:用**全部** run(不按视角 target、不按引擎筛 —— 理由见 reconcileByRegion 注释)──
    const targetRegion = await regionOfTargets([
      ...windowRuns.map((r) => scalarTargetOf(r as unknown as Record<string, unknown>, "cost")),
      ...scopeTargets(scope),
    ]);
    const costRows = (await Promise.all(monthsCovering(windowFrom, today).map((m) => listCostDaily(m)))).flat();
    const reconcile = reconcileByRegion({
      costRows,
      runs: windowRuns,
      targetRegion,
      regionsInView: await regionsInViewOf(scope),
      windowFrom,
      today,
    });

    let runs = windowRuns;
    if (engine) runs = runs.filter((r) => r.engine === engine);
    // @kf-batch 50-WP4ter-coverage —— 🔴 先算「按区计数」(同一天窗、同一引擎筛选下的口径),再过滤:
    // 反了的话计数就只剩当前区,护栏 1 的「别处还有 N 条」永远是 0(= 撒谎说别处没有)。
    const countsByTarget = countRowsByScalar(runs as unknown as Array<Record<string, unknown>>, "cost");
    runs = filterRowsByScalar(runs as unknown as Array<Record<string, unknown>>, scope, "cost") as unknown as typeof runs;

    // @kf-batch 50-WP6-cost-by-region —— 🔴 按 (taskId, targetId) 分组:同一任务扇出到两个区是两行。
    const byTaskTarget = new Map<string, TaskCostSummary>();
    for (const r of runs) {
      const targetId = scalarTargetOf(r as unknown as Record<string, unknown>, "cost");
      const k = `${r.taskId}\u0000${targetId}`;
      const cur =
        byTaskTarget.get(k) ??
        ({ taskId: r.taskId, targetId, engine: r.engine, runCount: 0, totalUsd: 0, avgUsd: 0, lastRunAt: "" } as TaskCostSummary);
      cur.runCount++;
      cur.totalUsd += r.costUsd;
      if (r.finishedAt > cur.lastRunAt) cur.lastRunAt = r.finishedAt;
      byTaskTarget.set(k, cur);
    }
    const items = Array.from(byTaskTarget.values())
      .map((t) => ({ ...t, avgUsd: t.totalUsd / t.runCount }))
      .sort((a, b) => b.totalUsd - a.totalUsd);

    return apiOk({ items, days, countsByTarget, reconcile });
  } catch (e: unknown) {
    return apiError((e as Error).message || String(e), 500);
  }
}
