// 区卡片 / 对账 / 采集窗口 / 视角换算的纯函数判据。
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/exec-env/registry", () => ({
  getTargetRaw: vi.fn(async (id: string) => (id === "tgt_usw2_a" ? { targetId: id, region: "us-west-2" } : null)),
}));

import { monthsCovering, prevPeriodEnd, regionCards, reconcileByRegion } from "../region-cost";
import { collectWindowStart } from "../collector";
import { regionsInViewOf, regionOfTargets } from "../cost-region";
import type { CostDailyRow, CostRunRow } from "../types";

const row = (date: string, region: string, amountUsd: number, service = "AWS Glue"): CostDailyRow => ({
  pk: "", sk: "", date, service, region, amountUsd, category: "engine", collectedAt: "",
});
const run = (targetId: string | undefined, costUsd: number) =>
  ({ taskId: "t", runId: String(Math.random()), costUsd, ...(targetId ? { targetId } : {}) }) as unknown as CostRunRow;

describe("日期工具", () => {
  it("prevPeriodEnd:上月同日;月短截到月末;跨年", () => {
    expect(prevPeriodEnd("2026-10-11")).toBe("2026-09-11");
    expect(prevPeriodEnd("2026-03-31")).toBe("2026-02-28");
    expect(prevPeriodEnd("2028-03-30")).toBe("2028-02-29");
    expect(prevPeriodEnd("2026-01-15")).toBe("2025-12-15");
  });
  it("monthsCovering:含两端、跨年", () => {
    expect(monthsCovering("2025-11-20", "2026-02-01")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(monthsCovering("2026-10-01", "2026-10-11")).toEqual(["2026-10"]);
  });
  it("collectWindowStart:常规 3 天;回填 = min(30 天前, 上月 1 日)", () => {
    const now = new Date("2026-10-11T08:00:00Z");
    expect(collectWindowStart(now, false).toISOString().slice(0, 10)).toBe("2026-10-08");
    expect(collectWindowStart(now, true).toISOString().slice(0, 10)).toBe("2026-09-01");
    const early = new Date("2026-10-02T08:00:00Z");
    expect(collectWindowStart(early, true).toISOString().slice(0, 10)).toBe("2026-09-01");
    const late = new Date("2026-10-31T08:00:00Z");
    expect(collectWindowStart(late, true).toISOString().slice(0, 10)).toBe("2026-09-01");
  });
});

describe("regionCards", () => {
  const rows = [
    row("2026-10-01", "us-east-1", 2),
    row("2026-10-11", "us-east-1", 1),
    row("2026-10-12", "us-east-1", 100), // 晚于今天(CE 预估)⇒ 不计
    row("2026-09-05", "us-east-1", 2),
    row("2026-09-20", "us-east-1", 50), // 上月同期之外 ⇒ 不计入环比基数
    row("2026-10-03", "us-west-2", 4),
    row("2026-10-03", "NoRegion", 7, "Tax"),
    row("2026-10-03", "global", 1, "AWS Support"),
  ];
  it("本月累计 / 上月同期 / 环比;上月同期为 0 ⇒ momPct=null(不编造 +∞)", () => {
    const { cards, regionlessMonthToDateUsd } = regionCards(rows, "2026-10-11", null);
    expect(cards).toEqual([
      { region: "us-west-2", monthToDateUsd: 4, prevPeriodUsd: 0, momPct: null },
      { region: "us-east-1", monthToDateUsd: 3, prevPeriodUsd: 2, momPct: 50 },
    ]);
    expect(regionlessMonthToDateUsd).toBe(8);
  });
  it("单区视角只给视角内的区;无区域归属不计(它不属于任何区)", () => {
    const { cards, regionlessMonthToDateUsd } = regionCards(rows, "2026-10-11", new Set(["us-east-1"]));
    expect(cards.map((c) => c.region)).toEqual(["us-east-1"]);
    expect(regionlessMonthToDateUsd).toBe(0);
  });
});

describe("reconcileByRegion", () => {
  const tr = new Map([["tgt_home", "us-east-1"], ["tgt_usw2_a", "us-west-2"], ["tgt_usw2_b", "us-west-2"]]);
  it("🔴 存量无章 run 归主控区(与范围过滤同一条规则);解析不出的单独报", () => {
    const r = reconcileByRegion({
      costRows: [row("2026-10-05", "us-east-1", 10), row("2026-09-01", "us-east-1", 99)],
      runs: [run(undefined, 3), run("tgt_gone", 4)],
      targetRegion: tr, regionsInView: null, windowFrom: "2026-09-11", today: "2026-10-11",
    });
    expect(r.byRegion).toEqual([{ region: "us-east-1", targetIds: ["tgt_home"], regionCostUsd: 10, attributedUsd: 3, unallocatedUsd: 7 }]);
    expect(r.unresolvedAttributedUsd).toBe(4);
    expect(r.billCoverageFrom).toBe("2026-10-05");
  });
  it("视角内没有账单的区也给一行(0 账单),不隐身", () => {
    const r = reconcileByRegion({
      costRows: [], runs: [], targetRegion: tr, regionsInView: new Set(["us-west-2"]), windowFrom: "2026-09-11", today: "2026-10-11",
    });
    expect(r.byRegion).toEqual([{ region: "us-west-2", targetIds: [], regionCostUsd: 0, attributedUsd: 0, unallocatedUsd: 0 }]);
    expect(r.billCoverageFrom).toBeNull();
  });
});

describe("视角 → 区集合", () => {
  it("🔴 全部视角 ⇒ null(不筛)—— 原写法得到空集合,全部视角的大盘恒为 0", async () => {
    expect(await regionsInViewOf({ kind: "global" })).toBeNull();
  });
  it("单区 / 分组视角 ⇒ 对应 region 集合;解析不到的 target 不回落主控区", async () => {
    process.env.AWS_REGION = "us-east-1";
    expect(Array.from((await regionsInViewOf({ kind: "target", targetId: "tgt_usw2_a" }))!)).toEqual(["us-west-2"]);
    expect(Array.from((await regionsInViewOf({ kind: "compare", targetIds: ["tgt_home", "tgt_usw2_a"] }))!).sort()).toEqual(["us-east-1", "us-west-2"]);
    const m = await regionOfTargets(["tgt_gone", "tgt_usw2_a"]);
    expect(m.has("tgt_gone")).toBe(false);
  });
});
