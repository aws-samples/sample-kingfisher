export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { listSlas } from "@/lib/baseline/sla-service";
import { listBaselines } from "@/lib/baseline/learn";
// @kf-batch 50-WP4quater-reads(工单 SC-15)—— 大屏这两张卡按执行范围。
// 🔴 「基线偏离 Top」原来是**跨区排序**:同一个任务在 usw2 慢、在主控区快,合计 p90 落在中间,
// 于是真正的慢链路两边都上不了榜(或上错榜)。摊平到「任务 × 区」再排,才是那个区自己的 Top。
import { readScope, filterRowsByScope } from "@/lib/exec-env/scope";
import { explodeByTarget, baselineTargetsOf } from "@/lib/baseline/target-baseline";

// GET /api/sla/risk-board — 大屏"SLA 风险看板"聚合(viewer)。
// 返回:①各 SLA 行(承诺时刻/当前 ETA/风险/卡点)②基线偏离 Top(相对自身 p90 偏离最大)。
// 大屏独立 fetch 本端点加卡,不改模块34的 /api/ops/summary。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  try {
    const [allSlas, allBaselines] = await Promise.all([listSlas(ctx.projectId), listBaselines(ctx.projectId)]);
    // 🔴 `readScope` 回 null(未传 `?scope=` / 全局)⇒ 两个过滤都是恒等 ⇒ 响应与改动前逐字节相同(回滚点)。
    const scope = readScope(req);
    const slas = scope
      ? (filterRowsByScope(allSlas as unknown as Array<Record<string, unknown>>, scope) as unknown as typeof allSlas)
      : allSlas;
    // 基线行的区集合在 `targets[]`(存量行回落主控区,由 `baselineTargetsOf` 单一作者给出)
    const baselines = scope
      ? allBaselines.filter((b) => {
          const one = { targets: baselineTargetsOf(b) } as Record<string, unknown>;
          return filterRowsByScope([one], scope).length > 0;
        })
      : allBaselines;

    const slaRows = slas.map((s) => ({
      slaId: s.slaId,
      name: s.name,
      enabled: s.enabled,
      scope: s.target.scope,
      target: s.target.type === "relative" ? `触发后 ${s.target.offsetMinFromTrigger} 分钟` : (s.target.clockTime || ""),
      lastPrediction: s.lastPrediction || null,
      riskLevel: s.lastPrediction?.riskLevel || "green",
      etaAt: s.lastPrediction?.etaAt || null,
      criticalPathNode: s.lastPrediction?.criticalPathNode || null,
    }));

    // 风险计数(大屏 Donut)。
    const riskDist = { green: 0, yellow: 0, red: 0 } as Record<string, number>;
    for (const r of slaRows) if (r.enabled) riskDist[r.riskLevel] = (riskDist[r.riskLevel] || 0) + 1;

    // 基线偏离 Top:这里只暴露基线快照(p50/p90/ewma/lowConfidence),前端可展示;
    // 实时"今日偏离"需结合当日 run,留大屏侧或后续。此处给出 p90 最大的 Top8(慢链路可视化)。
    // @kf-batch 50-WP4quater-reads —— 摊平成「任务 × 区」再排序;`legacy` 如实标出「落章前学的,没有区维」。
    const baselineTop = explodeByTarget(baselines)
      .filter((b) => !b.lowConfidence && b.durationSec.p90 > 0)
      .sort((a, b) => b.durationSec.p90 - a.durationSec.p90)
      .slice(0, 8)
      .map((b) => ({
        taskId: b.taskId, taskName: b.taskName || b.taskId, targetId: b.targetId, legacy: b.legacy,
        p50: b.durationSec.p50, p90: b.durationSec.p90, ewma: b.durationSec.ewma, samples: b.durationSec.samples,
      }));

    return apiOk({
      generatedAt: new Date().toISOString(),
      slas: slaRows,
      riskDist: Object.entries(riskDist).map(([label, value]) => ({ label, value })),
      baselineTop,
      totalSlas: slas.length,
      atRisk: slaRows.filter((r) => r.enabled && (r.riskLevel === "red" || r.riskLevel === "yellow")).length,
    });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
