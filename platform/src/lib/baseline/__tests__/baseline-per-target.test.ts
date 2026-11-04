// @kf-batch 50-WP4quater-reads(工单 SC-15)
/**
 * 钉住「基线按执行区分开」。
 *
 * 🔴 判别性夹具是关键:让同一个任务在两个区跑出**明显不同**的时长分布(usw2 慢一个数量级)。
 * 于是:
 *   · 合计 p90 落在两者之间 ⇒ 与**任一个区**的 p90 都不相等 ⇒ 「有没有真按区分」这件事有判别力;
 *   · 若哪天有人把 `baselineFor` 的「该区没跑过 ⇒ null」改成「回落合计」,下面那条断言会红 ——
 *     而那正是最坏的一种错:SLA 预测会拿别的区的数字给这个区算 ETA,预警看起来完全正常。
 * 若两个区的数据一样,上面每一条都恒真 = 空断言(本仓吃过这个亏:现网数据让对错两种实现结果相同)。
 */
import { describe, it, expect } from "vitest";
import { deriveBaseline } from "../learn";
import { baselineFor, baselineTargetsOf, explodeByTarget } from "../target-baseline";

const HOME = "tgt_home";
const USW2 = "tgt_usw2_a";

/** 造 n 条成功 run,时长固定 sec,时间戳递增(EWMA 需时序)。 */
function runs(targetId: string | undefined, n: number, sec: number, startDay = 1) {
  return Array.from({ length: n }, (_, i) => ({
    taskId: "t1",
    ...(targetId ? { targetId } : {}),
    status: "succeeded",
    startedAt: new Date(Date.UTC(2026, 8, startDay, i, 0, 0)).toISOString(),
    finishedAt: new Date(Date.UTC(2026, 8, startDay, i, 0, sec)).toISOString(),
    duration: sec,
  }));
}

describe("基线按执行区分开(SC-15)", () => {
  const now = Date.UTC(2026, 8, 10, 0, 0, 0);
  // 🔴 两个区**故意差一个数量级**:主控区 10s × 10 次,usw2 300s × 10 次。
  const row = deriveBaseline({
    projectId: "p1",
    taskId: "t1",
    taskName: "nightly",
    runs: [...runs(HOME, 10, 10, 1), ...runs(USW2, 10, 300, 2)],
    now,
  });

  it("两个区各自出一份基线,且数字明显不同", () => {
    expect(Object.keys(row.byTarget || {}).sort()).toEqual([HOME, USW2]);
    const h = baselineFor(row, HOME)!;
    const u = baselineFor(row, USW2)!;
    expect(h.durationSec.p90).toBe(10);
    expect(u.durationSec.p90).toBe(300);
    expect(h.legacy).toBe(false);
  });

  it("🔴 合计基线**不等于**每个区的基线 —— 这就是「跨区混在一起」的样子", () => {
    // 🔴 注意不能笼统断言「合计与两个区都不同」:混合分布的 **p90 被慢尾主导**,
    // 慢区样本占到 10% 以上时合计 p90 就等于慢区 p90(实测正是 300)。
    // 有判别力的写法 = 各挑一个「若 byTarget 只是合计的拷贝就必然为假」的量:
    const h = baselineFor(row, HOME)!;
    const u = baselineFor(row, USW2)!;
    expect(row.durationSec.p90, "合计 p90 被慢区拉高 ⇒ 与主控区自己的 p90 必须不同").not.toBe(h.durationSec.p90);
    expect(row.durationSec.p50, "合计 p50 被快区拉低 ⇒ 与 usw2 自己的 p50 必须不同").not.toBe(u.durationSec.p50);
    // 后果:用合计给主控区预测,会把 10 秒的任务当成几百秒 ⇒ 永远不破线(SLA 形同虚设);
    // 用合计给 usw2 预测,会把 300 秒的任务当成几十秒 ⇒ 一直误报。两个方向都错,且都无声。
    expect(h.durationSec.p90).toBeLessThan(u.durationSec.p90);
  });

  it("🔴 该区没跑过 ⇒ 回 null,**绝不**回落成别的区的数字", () => {
    expect(baselineFor(row, "tgt_eu_1")).toBeNull();
  });

  it("落章之前学出来的存量行(没有 byTarget)⇒ 回合计并标 legacy", () => {
    const legacyRow = { ...row, byTarget: undefined, targets: undefined };
    const b = baselineFor(legacyRow, USW2)!;
    expect(b.legacy).toBe(true);
    expect(b.durationSec.p90).toBe(row.durationSec.p90);
    // 归属回落主控区(与平台其它「无章 ⇒ 主控区」同一条规则)
    expect(baselineTargetsOf(legacyRow)).toEqual([HOME]);
  });

  it("摊平成「任务 × 区」多行(基线表 / 偏离 Top 按区呈现)", () => {
    const flat = explodeByTarget([row]);
    expect(flat.map((r) => r.rowKey).sort()).toEqual([`t1#${HOME}`, `t1#${USW2}`]);
    // p90 最大的那一行必须是 usw2 —— 跨区排序会让它被合计值稀释掉
    expect(flat.sort((a, b) => b.durationSec.p90 - a.durationSec.p90)[0].targetId).toBe(USW2);
  });

  it("无章的 run 归主控区(与 scalarTargetOf 同一条回落)", () => {
    const r2 = deriveBaseline({ projectId: "p1", taskId: "t2", runs: runs(undefined, 8, 20, 1), now });
    expect(Object.keys(r2.byTarget || {})).toEqual([HOME]);
    expect(baselineFor(r2, HOME)!.durationSec.p90).toBe(20);
  });
});
