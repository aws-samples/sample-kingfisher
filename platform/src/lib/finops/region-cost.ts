// 成本按区的两件纯计算(零 IO,单测钉;读取由路由做):
//   ① `regionCards` —— 大盘第一层的 region 卡片(O3a):本月累计 + 上月同期 + 环比;
//   ② `reconcileByRegion` —— 任务成本 Tab 的「已归因 / 未分摊」按 region 对账(O3b)。
//
// 🔴 两件事都**只认 AWS region**,不认 target:CE 的维度里没有「执行环境」,同区两套环境的钱分不开。
//    界面必须把「按 AWS region 分组,非 target 归因」写出来(INTERACTION §3.2)。
// 🔴 无区域归属(全局服务:`NoRegion` / `global`)**不进任何区**,单独报 —— 判定只走 `isRegionlessCost`。

import { scalarTargetOf } from "@/lib/exec-env/scope";
import { isRegionlessCost } from "./types";
import type { CostDailyRow, CostReconcile, CostRunRow, RegionCostCard, RegionReconcile } from "./types";

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** [from, to] 覆盖到的所有 yyyy-MM(含两端)。读 v2 分区时据此决定 Query 哪几个 pk。 */
export function monthsCovering(fromDate: string, toDate: string): string[] {
  const out: string[] = [];
  let y = Number(fromDate.slice(0, 4));
  let m = Number(fromDate.slice(5, 7));
  const endKey = toDate.slice(0, 7);
  for (let guard = 0; guard < 240; guard++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(key);
    if (key >= endKey) break;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** 上月同期的终点日(yyyy-MM-dd):上月的「今天几号」,月短则截到上月末。 */
export function prevPeriodEnd(today: string): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const d = Number(today.slice(8, 10));
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate(); // pm 是 1 基,Date.UTC(py, pm, 0) = 上月末
  return `${py}-${String(pm).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

/**
 * region 卡片。`rows` = 本月 + 上月的 v2 账单行;`regionsInView` = null 表示全部视角。
 * 返回按本月累计降序的卡片 + 本月无区域归属的金额(全局视角才有意义;单区视角恒为 0,
 * 因为那笔钱不属于任何区 —— 由 overview 的 `unattributedUsd` 另行说明)。
 */
export function regionCards(
  rows: readonly CostDailyRow[],
  today: string,
  regionsInView: ReadonlySet<string> | null
): { cards: RegionCostCard[]; regionlessMonthToDateUsd: number } {
  const thisMonth = today.slice(0, 7);
  const prevEnd = prevPeriodEnd(today);
  const prevMonth = prevEnd.slice(0, 7);
  const acc = new Map<string, { mtd: number; prev: number }>();
  let regionless = 0;
  for (const r of rows) {
    const inThis = r.date.slice(0, 7) === thisMonth && r.date <= today;
    const inPrev = r.date.slice(0, 7) === prevMonth && r.date <= prevEnd;
    if (!inThis && !inPrev) continue;
    if (isRegionlessCost(r.region)) {
      if (inThis && !regionsInView) regionless += r.amountUsd;
      continue;
    }
    if (regionsInView && !regionsInView.has(r.region)) continue;
    const cur = acc.get(r.region) ?? { mtd: 0, prev: 0 };
    if (inThis) cur.mtd += r.amountUsd;
    else cur.prev += r.amountUsd;
    acc.set(r.region, cur);
  }
  const cards: RegionCostCard[] = Array.from(acc.entries())
    .map(([region, v]) => ({
      region,
      monthToDateUsd: round6(v.mtd),
      prevPeriodUsd: round6(v.prev),
      // 🔴 上月同期为 0 ⇒ null,不编造「+∞」或「+100%」(没有可比的基数就是没有环比)
      momPct: v.prev > 0 ? ((v.mtd - v.prev) / v.prev) * 100 : null,
    }))
    .sort((a, b) => b.monthToDateUsd - a.monthToDateUsd || a.region.localeCompare(b.region));
  return { cards, regionlessMonthToDateUsd: round6(regionless) };
}

/**
 * 「已归因 / 未分摊」按 region 对账。
 *
 * @param costRows      窗口所在月份的 v2 账单行(本函数自己按 [windowFrom, today] 截)
 * @param runs          窗口内的**全部** run 成本行 —— 🔴 不许先按视角 target 过滤:
 *                      同区的另一套执行环境的 run 也是这个区账单的一部分,漏掉它们 = 把它们算成「未分摊」。
 *                      也不许按引擎筛:账单是全引擎的,只减一个引擎的归因会把其余引擎都算成未分摊。
 * @param targetRegion  targetId → region(`regionOfTargets` 给出;解析不到的 target 不在里面)
 * @param regionsInView null = 全部视角(账单里出现过的区 ∪ run 落到的区);否则只给这些区
 */
export function reconcileByRegion(input: {
  costRows: readonly CostDailyRow[];
  runs: readonly CostRunRow[];
  targetRegion: ReadonlyMap<string, string>;
  regionsInView: ReadonlySet<string> | null;
  windowFrom: string;
  today: string;
}): CostReconcile {
  const { costRows, runs, targetRegion, regionsInView, windowFrom, today } = input;
  const bill = new Map<string, number>();
  let coverage: string | null = null;
  for (const r of costRows) {
    if (r.date < windowFrom || r.date > today) continue;
    if (coverage === null || r.date < coverage) coverage = r.date;
    if (isRegionlessCost(r.region)) continue;
    bill.set(r.region, (bill.get(r.region) ?? 0) + r.amountUsd);
  }
  const attributed = new Map<string, { usd: number; targets: Set<string> }>();
  let unresolved = 0;
  for (const run of runs) {
    const tid = scalarTargetOf(run as unknown as Record<string, unknown>, "cost");
    const region = targetRegion.get(tid);
    if (!region) {
      unresolved += run.costUsd;
      continue;
    }
    const cur = attributed.get(region) ?? { usd: 0, targets: new Set<string>() };
    cur.usd += run.costUsd;
    cur.targets.add(tid);
    attributed.set(region, cur);
  }
  const regions = regionsInView
    ? Array.from(regionsInView)
    : Array.from(new Set([...Array.from(bill.keys()), ...Array.from(attributed.keys())]));
  const byRegion: RegionReconcile[] = regions.sort().map((region) => {
    const regionCostUsd = round6(bill.get(region) ?? 0);
    const a = attributed.get(region);
    const attributedUsd = round6(a?.usd ?? 0);
    return {
      region,
      targetIds: a ? Array.from(a.targets).sort() : [],
      regionCostUsd,
      attributedUsd,
      // 🔴 不截断成 0:负数 = 归因比账单多(账单 T+1 迟到 / 价目表偏高),如实给出
      unallocatedUsd: round6(regionCostUsd - attributedUsd),
    };
  });
  return { windowFrom, billCoverageFrom: coverage, byRegion, unresolvedAttributedUsd: round6(unresolved) };
}
