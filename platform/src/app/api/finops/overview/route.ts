export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { listCostDaily } from "@/lib/finops/store";
import { getCeWatermark, collectDailyCosts } from "@/lib/finops/collector";
import { sweepTaskCosts } from "@/lib/finops/sweep";
import { STALE_AFTER_MS } from "@/lib/finops/constants";
import type { OverviewSummary, CostDailyRow } from "@/lib/finops/types";
// 区卡片(O3a)与「无区域归属」判定的唯一作者
import { isRegionlessCost } from "@/lib/finops/types";
import { regionCards } from "@/lib/finops/region-cost";
// 🔴 大盘按执行范围。用户 2026-09-10:
// 「『成本大盘』与『预算护栏』仍是全平台合计 —— 账单来自 Cost Explorer 的服务维度采集,
//  按区拆分需要多采一个 REGION 分组并重采存量」。采集侧已加 REGION 分组,这里按区筛。
//
// 🔴 三条不许含糊的处置:
//  ① **全局服务**(CE 回 `NoRegion` / `global`:Tax / Support / Route 53 …)不算进任何区 ——
//     它们真的不属于某个区。单独报,不硬塞。
//  ② 单区视角的「合计」= 那个区的钱,**不含**上面那类;界面上必须把这件事说出来,
//     否则用户会拿它去核对账单总额然后发现对不上。
// 读侧只读 v2 分区(`listCostDaily` 的 pk 前缀),旧分区里
// 「落 REGION 分组之前的账号级合计」**结构上读不到** ⇒ 那套「存量行 / 立即重采」分支已无对象,删掉
// (留着就是一段永远不触发、却在界面上许诺「重采」的死代码)。
import { requireScope } from "@/lib/exec-env/scope";
import { regionsInViewOf } from "@/lib/finops/cost-region";

function monthOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

// GET /api/finops/overview — L1 大盘聚合。【纯读】(43-A 二期教训:读路径绝不做重活);
// 水位落后 > STALE_AFTER_MS 时 fire-and-forget 触发后台采集(本次响应仍立即返回旧数据)。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  // 非法参数 400、看不见的 target 404(原来非法参数静默当成「不筛」)
  const scope = await requireScope(req, ctx.projectId);
  if (scope instanceof NextResponse) return scope;

  try {
    const now = new Date();
    const watermark = await getCeWatermark();
    const stale = !watermark || now.getTime() - new Date(watermark).getTime() > STALE_AFTER_MS;
    if (stale) {
      // detached(照 GenBI 异步化模式:ECS 长驻进程,fire-and-forget 等价 after())
      collectDailyCosts().then(() => sweepTaskCosts()).catch(() => {});
    }

    const thisMonth = monthOf(now);
    const prevMonth = monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)));
    const allRows = [...(await listCostDaily(prevMonth)), ...(await listCostDaily(thisMonth))];

    // ── 按执行范围切分 ────────────────────────────────────────────────────────
    // 🔴 全部视角 = null(不筛);见 `regionsInViewOf` 注释里那个「全部视角恒为 0」的缺陷
    const regionsInScope = await regionsInViewOf(scope);
    const isUnattributed = (r: CostDailyRow) => isRegionlessCost(r.region);
    const rows: CostDailyRow[] = regionsInScope
      ? allRows.filter((r) => !isUnattributed(r) && regionsInScope.has(r.region.trim()))
      : allRows;
    // 无区域归属的钱(全局服务)—— 只在按区视角下需要如实报出
    const unattributed = regionsInScope ? allRows.filter(isUnattributed) : [];

    const yesterday = new Date(now.getTime() - 86400_000).toISOString().slice(0, 10);
    const prevDay = new Date(now.getTime() - 2 * 86400_000).toISOString().slice(0, 10);

    const mtd = rows.filter((r) => r.date.slice(0, 7) === thisMonth);
    const byCategory = { base: 0, engine: 0, other: 0 };
    const byService = new Map<string, { category: string; amountUsd: number }>();
    for (const r of mtd) {
      byCategory[r.category] += r.amountUsd;
      const cur = byService.get(r.service) ?? { category: r.category, amountUsd: 0 };
      cur.amountUsd += r.amountUsd;
      byService.set(r.service, cur);
    }

    // 近 14 天日趋势(叠合分类)。
    const trendDays: string[] = [];
    for (let i = 13; i >= 0; i--) trendDays.push(new Date(now.getTime() - i * 86400_000).toISOString().slice(0, 10));
    const dailyTrend = trendDays.map((date) => {
      const day = rows.filter((r) => r.date === date);
      const base = day.filter((r) => r.category === "base").reduce((a, b) => a + b.amountUsd, 0);
      const engine = day.filter((r) => r.category === "engine").reduce((a, b) => a + b.amountUsd, 0);
      const other = day.filter((r) => r.category === "other").reduce((a, b) => a + b.amountUsd, 0);
      return { date, base, engine, other, total: base + engine + other };
    });

    const summary: OverviewSummary = {
      monthToDateUsd: mtd.reduce((a, b) => a + b.amountUsd, 0),
      yesterdayUsd: rows.filter((r) => r.date === yesterday).reduce((a, b) => a + b.amountUsd, 0),
      prevDayUsd: rows.filter((r) => r.date === prevDay).reduce((a, b) => a + b.amountUsd, 0),
      byCategory,
      topServices: Array.from(byService.entries())
        .map(([service, v]) => ({ service, category: v.category, amountUsd: v.amountUsd }))
        .sort((a, b) => b.amountUsd - a.amountUsd)
        .slice(0, 10),
      dailyTrend,
      watermark,
      stale,
      // 第一层 region 卡片(按 AWS region 分组,非 target 归因)
      ...(() => {
        const { cards, regionlessMonthToDateUsd } = regionCards(allRows, now.toISOString().slice(0, 10), regionsInScope);
        return { byRegion: cards, regionlessMonthToDateUsd };
      })(),
    };
    return apiOk({
      ...summary,
      // 🔴 按区视角必须把「这些钱没算进来」说出来:不说的话用户会拿这个合计去对账单总额。
      ...(regionsInScope
        ? {
            scopedRegions: Array.from(regionsInScope).sort(),
            unattributedUsd: unattributed
              .filter((r) => r.date.slice(0, 7) === thisMonth)
              .reduce((a, b) => a + b.amountUsd, 0),
            unattributedNote: `这部分是全局服务(Tax / Support / Route 53 等),本来就不属于任何区`,
          }
        : {}),
    });
  } catch (e: unknown) {
    return apiError((e as Error).message || String(e), 500);
  }
}
