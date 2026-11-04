/**
 * 「**这个任务在这个区**的基线」的唯一读法。
 *
 * 🔴 为什么必须是一个函数而不是各处 `row.byTarget?.[tid] ?? row`:那样每个调用点都要自己决定
 * 「存量行(没有 byTarget)怎么办」,而这正是最容易各自漂的一步 —— 一处回落到合计、一处回落到 0,
 * 于是同一个任务在 SLA 预测里用合计 p90、在基线表里显示 0,两个数字对不上而没人知道哪个是对的。
 *
 * 回落规则(与平台其它「无章 ⇒ 归主控区」同一条):
 *   ① 行上有该区的分区基线 ⇒ 用它;
 *   ② 行上有 `byTarget` 但**没有该区** ⇒ 这个任务在那个区**没跑过** ⇒ 回 null(不是 0,也不是合计)。
 *      🔴 回合计会造出一个「那个区的 p90」,而它其实是别的区的数字 —— 那是最坏的一种错:
 *      SLA 预测会拿它算 ETA,算出来的破线预警指向一个根本没在那儿跑过的任务。
 *   ③ 行上**完全没有** `byTarget`(落章之前学出来的存量行)⇒ 回合计,并标 `legacy: true`
 *      让调用方能在界面上如实说明「这条基线是落章前学的,没有区维」。
 */
import type { BaselineRow, TargetBaseline } from "./types";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";

export interface ResolvedBaseline extends TargetBaseline {
  targetId: string;
  /** true = 这份数字来自「全部区合计」的存量行,不是该区自己的基线 */
  legacy: boolean;
}

export function baselineFor(row: BaselineRow | null | undefined, targetId?: string): ResolvedBaseline | null {
  if (!row) return null;
  const tid = targetId || HOME_TARGET_ID;
  const map = row.byTarget;
  if (map && Object.keys(map).length > 0) {
    const hit = map[tid];
    if (!hit) return null; // ② 该区没跑过 —— 刻意不回落合计
    return { ...hit, targetId: tid, legacy: false };
  }
  // ③ 存量行:只有合计
  return {
    durationSec: row.durationSec,
    startDelay: row.startDelay,
    punctuality: row.punctuality,
    successRate: row.successRate,
    lowConfidence: row.lowConfidence,
    targetId: tid,
    legacy: true,
  };
}

/** 这条基线行覆盖了哪些区(存量行 ⇒ 主控区)。字段名对齐平台 B 类绑定,供 `filterRowsByScope` 用。 */
export function baselineTargetsOf(row: BaselineRow): string[] {
  const t = Array.isArray(row.targets) ? row.targets.filter((x) => typeof x === "string" && x) : [];
  return t.length > 0 ? t : [HOME_TARGET_ID];
}

/** 把一行「一个任务」的基线摊平成「一个任务 × 一个区」多行(基线表 / 偏离 Top 按区呈现用)。 */
export function explodeByTarget(rows: BaselineRow[]): Array<BaselineRow & ResolvedBaseline & { rowKey: string }> {
  const out: Array<BaselineRow & ResolvedBaseline & { rowKey: string }> = [];
  for (const r of rows) {
    for (const tid of baselineTargetsOf(r)) {
      const b = baselineFor(r, tid);
      if (!b) continue;
      out.push({ ...r, ...b, rowKey: `${r.taskId}#${tid}` });
    }
  }
  return out;
}
