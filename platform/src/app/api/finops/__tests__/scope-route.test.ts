// @kf-batch 50-WP4ter-coverage
// `/api/finops/tasks` 的执行范围过滤 + **按区计数的口径**(工单 SC-11)。
//
// 🔴 最容易写错的一条:计数必须在**过滤之前**算 —— 反了的话「别处还有 N 条」永远是 0,
//    界面等于告诉用户「别的区没有成本」,而那是撒谎。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

let runs: Array<Record<string, unknown>> = [];
// @kf-batch 50-WP6-cost-by-region —— 账单行(v2)按月返回;对账要用
let bill: Array<Record<string, unknown>> = [];
vi.mock("@/lib/finops/store", () => ({
  scanAllCostRuns: vi.fn(async () => runs),
  listCostDaily: vi.fn(async (month: string) => bill.filter((r) => String(r.date).slice(0, 7) === month)),
}));
vi.mock("@/lib/projects/guard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects/guard")>("@/lib/projects/guard");
  return { ...actual, requireProject: vi.fn(async () => ({ identity: {}, projectId: "proj-a", role: "viewer" })) };
});
vi.mock("@/lib/exec-env/registry", () => ({
  getTargetRaw: vi.fn(async (id: string) =>
    ["tgt_home", "tgt_usw2_a", "tgt_usw2_b"].includes(id) ? { targetId: id, ready: true, region: id === "tgt_home" ? "us-east-1" : "us-west-2" } : null
  ),
  descriptorViolation: vi.fn(() => null),
}));

import { GET } from "../tasks/route";

const now = new Date().toISOString();
const req = (qs = "") => new NextRequest(`https://x.test/api/finops/tasks${qs}`);
const body = async (qs = "") => (await (await GET(req(qs))).json()).data;

beforeEach(() => {
  process.env.AWS_REGION = "us-east-1";
  bill = [];
  runs = [
    { taskId: "a", engine: "glue", costUsd: 1, finishedAt: now, targetId: "tgt_home" },
    { taskId: "b", engine: "glue", costUsd: 2, finishedAt: now, targetId: "tgt_usw2_a" },
    { taskId: "c", engine: "glue", costUsd: 3, finishedAt: now }, // 存量无章 ⇒ 归主控区
  ];
});

describe("按区过滤", () => {
  it("缺省 = 全部", async () => {
    expect((await body()).items.map((i: any) => i.taskId).sort()).toEqual(["a", "b", "c"]);
  });
  it("主控区视角含存量无章的行", async () => {
    expect((await body("?scope=tgt_home")).items.map((i: any) => i.taskId).sort()).toEqual(["a", "c"]);
  });
  it("非主控区只留它自己的", async () => {
    expect((await body("?scope=tgt_usw2_a")).items.map((i: any) => i.taskId)).toEqual(["b"]);
  });
});

describe("护栏 1 的计数口径", () => {
  it("🔴 计数是**过滤前**的全量按区分布(否则「别处还有 N 条」恒为 0)", async () => {
    const d = await body("?scope=tgt_usw2_a");
    expect(d.countsByTarget).toEqual({ tgt_home: 2, tgt_usw2_a: 1 });
  });
  it("计数与天窗 / 引擎筛选同口径(不是全表数字)", async () => {
    const old = new Date(Date.now() - 400 * 86400_000).toISOString();
    runs = [
      { taskId: "a", engine: "glue", costUsd: 1, finishedAt: now, targetId: "tgt_home" },
      { taskId: "z", engine: "glue", costUsd: 1, finishedAt: old, targetId: "tgt_usw2_a" },
    ];
    const d = await body("?days=30&scope=tgt_home");
    expect(d.countsByTarget).toEqual({ tgt_home: 1 });
  });
});

describe("拒因", () => {
  it("非法 / 不存在一律拒,不回落", async () => {
    expect((await GET(req("?scope=@@"))).status).toBe(400);
    expect((await GET(req("?scope=tgt_nope"))).status).toBe(404);
  });
});

// @kf-batch 50-WP6-cost-by-region(WP-6 施工序 3,E-171 / E-172)
describe("O3b:排行按 (task, target) 分行 + 按 region 对账", () => {
  const today = new Date().toISOString().slice(0, 10);
  it("🔴 同一任务扇出到两个区 = 两行,各带 targetId(合成一行就看不出贵的是哪个区)", async () => {
    runs = [
      { taskId: "x", engine: "glue", costUsd: 1, finishedAt: now, targetId: "tgt_home" },
      { taskId: "x", engine: "glue", costUsd: 4, finishedAt: now, targetId: "tgt_usw2_a" },
    ];
    const d = await body();
    expect(d.items.map((i: any) => `${i.taskId}@${i.targetId}=${i.totalUsd}`).sort()).toEqual(["x@tgt_home=1", "x@tgt_usw2_a=4"]);
  });

  it("E-171:scope=usw2 的列表 == targetId=tgt_usw2_a 的成本行集合", async () => {
    const d = await body("?scope=tgt_usw2_a");
    expect(d.items.map((i: any) => i.targetId)).toEqual(["tgt_usw2_a"]);
    expect(d.items.reduce((a: number, i: any) => a + i.totalUsd, 0)).toBe(2);
  });

  it("🔴 E-172:未分摊 = 区账单 − Σ该区**全部**执行环境的归因(同区另一套环境的 run 不许算成未分摊)", async () => {
    bill = [
      { date: today, service: "AWS Glue", region: "us-west-2", amountUsd: 10, category: "engine" },
      { date: today, service: "Amazon Virtual Private Cloud", region: "us-west-2", amountUsd: 5, category: "base" },
      { date: today, service: "Tax", region: "NoRegion", amountUsd: 7, category: "other" },
      { date: today, service: "AWS Glue", region: "us-east-1", amountUsd: 3, category: "engine" },
    ];
    runs = [
      { taskId: "b", engine: "glue", costUsd: 2, finishedAt: now, targetId: "tgt_usw2_a" },
      { taskId: "d", engine: "athena", costUsd: 6, finishedAt: now, targetId: "tgt_usw2_b" },
      { taskId: "a", engine: "glue", costUsd: 1, finishedAt: now, targetId: "tgt_home" },
    ];
    // 视角只选 usw2_a,且按引擎筛 glue —— 对账仍按整个 us-west-2、全引擎
    const d = await body("?scope=tgt_usw2_a&engine=glue");
    expect(d.reconcile.byRegion).toEqual([
      { region: "us-west-2", targetIds: ["tgt_usw2_a", "tgt_usw2_b"], regionCostUsd: 15, attributedUsd: 8, unallocatedUsd: 7 },
    ]);
  });

  it("全部视角:每个有账单或有归因的区各一行;全局服务不进任何区", async () => {
    bill = [
      { date: today, service: "AWS Glue", region: "us-east-1", amountUsd: 3, category: "engine" },
      { date: today, service: "Tax", region: "NoRegion", amountUsd: 7, category: "other" },
    ];
    const d = await body();
    expect(d.reconcile.byRegion.map((r: any) => [r.region, r.regionCostUsd, r.attributedUsd, r.unallocatedUsd])).toEqual([
      ["us-east-1", 3, 4, -1], // 🔴 负数如实给出,不截断成 0
      ["us-west-2", 0, 2, -2],
    ]);
    expect(d.reconcile.billCoverageFrom).toBe(today);
  });

  it("run 的执行环境解析不出 region ⇒ 单独报 unresolved,不猜主控区", async () => {
    runs = [{ taskId: "z", engine: "glue", costUsd: 9, finishedAt: now, targetId: "tgt_gone" }];
    const d = await body();
    expect(d.reconcile.unresolvedAttributedUsd).toBe(9);
    expect(d.reconcile.byRegion.find((r: any) => r.region === "us-east-1")).toBeUndefined();
  });
});
