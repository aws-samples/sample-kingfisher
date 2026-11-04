import { describe, it, expect } from "vitest";
import { percentile, median, removeOutliersMAD, ewma, stdev } from "../stats";
import { deriveBaseline, computeDurationStats, MIN_SAMPLES } from "../learn";
import { analyzeCriticalPath } from "../critical-path";
import { predictEta, computeSlaDeadline, confirmBreachMultiWindow } from "../predict";
import type { SlaTarget } from "../types";

describe("stats", () => {
  it("percentile 线性插值", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
    expect(percentile([10], 90)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });
  it("median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("MAD 剔除极端离群点", () => {
    const xs = [10, 11, 9, 10, 12, 10, 11, 9, 10000]; // 10000=离群
    const cleaned = removeOutliersMAD(xs);
    expect(cleaned).not.toContain(10000);
    expect(cleaned.length).toBe(8);
  });
  it("MAD 样本过少不剔", () => {
    expect(removeOutliersMAD([1, 999]).length).toBe(2);
  });
  it("ewma 近期权重高", () => {
    // 稳定序列 EWMA 收敛到值本身;上升序列 EWMA < 最后值。
    expect(ewma([10, 10, 10])).toBeCloseTo(10, 5);
    expect(ewma([10, 20, 30])).toBeLessThan(30);
    expect(ewma([10, 20, 30])).toBeGreaterThan(10);
  });
});

describe("deriveBaseline — 排除 backfill(用户硬约束)", () => {
  const now = Date.parse("2026-07-12T00:00:00Z");
  const mkRun = (duration: number, triggeredBy = "manual", daysAgo = 1, status = "succeeded") => ({
    taskId: "wf1", taskType: "workflow", status,
    startedAt: new Date(now - daysAgo * 86400_000).toISOString(),
    duration, triggeredBy,
  });

  it("🔴 backfill 超长 run 不拉高 p90(核心验收断言)", () => {
    // 8 条正常 ~20s 的在线 run + 1 条 6000s 的 backfill 大跑。
    const normal = Array.from({ length: 8 }, (_, i) => mkRun(20 + i, "manual", i + 1));
    const withBackfill = [...normal, mkRun(6000, "backfill", 1)];
    const bl = deriveBaseline({ projectId: "p", taskId: "wf1", runs: withBackfill, now });
    // p90 应贴近正常值(~27),绝不被 6000 拉高。
    expect(bl.durationSec.p90).toBeLessThan(60);
    expect(bl.durationSec.samples).toBe(8); // backfill 被排除,只剩 8 个在线样本
  });

  it("样本 ≥7 → 非 lowConfidence", () => {
    const runs = Array.from({ length: 7 }, (_, i) => mkRun(20, "manual", i + 1));
    expect(deriveBaseline({ projectId: "p", taskId: "wf1", runs, now }).lowConfidence).toBe(false);
  });

  it("样本 <7 → lowConfidence(冷启动不误报)", () => {
    const runs = Array.from({ length: 3 }, (_, i) => mkRun(20, "manual", i + 1));
    expect(deriveBaseline({ projectId: "p", taskId: "wf1", runs, now }).lowConfidence).toBe(true);
  });

  it("成功率排除 backfill,只算在线终态", () => {
    const runs = [mkRun(20, "manual", 1, "succeeded"), mkRun(20, "manual", 2, "failed"), mkRun(20, "backfill", 1, "failed")];
    const bl = deriveBaseline({ projectId: "p", taskId: "wf1", runs, now });
    expect(bl.successRate.samples).toBe(2); // backfill 不计入
    expect(bl.successRate.value).toBe(50);
  });

  it("窗口外的 run 被排除", () => {
    const runs = [mkRun(20, "manual", 1), mkRun(20, "manual", 100)]; // 100天前超30天窗口
    expect(deriveBaseline({ projectId: "p", taskId: "wf1", runs, now }).durationSec.samples).toBe(1);
  });

  // 模块47 P4.0:copilot 触发的 run 与 backfill 同为"非常规触发",须一并排除(在线隔离)。
  it("🔴 copilot 超长 run 不拉高 p90(P4.0 隔离标)", () => {
    const normal = Array.from({ length: 8 }, (_, i) => mkRun(20 + i, "manual", i + 1));
    const withCopilot = [...normal, mkRun(6000, "copilot", 1)];
    const bl = deriveBaseline({ projectId: "p", taskId: "wf1", runs: withCopilot, now });
    expect(bl.durationSec.p90).toBeLessThan(60);
    expect(bl.durationSec.samples).toBe(8); // copilot 被排除,只剩 8 个在线样本
  });

  it("成功率排除 copilot,只算在线终态(P4.0)", () => {
    const runs = [mkRun(20, "manual", 1, "succeeded"), mkRun(20, "manual", 2, "failed"), mkRun(20, "copilot", 1, "failed")];
    const bl = deriveBaseline({ projectId: "p", taskId: "wf1", runs, now });
    expect(bl.successRate.samples).toBe(2); // copilot 不计入
    expect(bl.successRate.value).toBe(50);
  });
});

describe("critical-path", () => {
  // rollup(A,100s) → {roasrank(B,50s), country(C,30s)};关键路径 A→B(150s)。
  const dag = {
    nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
    edges: [{ source: "A", target: "B" }, { source: "A", target: "C" }],
  };
  const dur: Record<string, number> = { A: 100, B: 50, C: 30 };

  it("关键路径 = 最长链 A→B,总时长 150", () => {
    const cp = analyzeCriticalPath(dag, (id) => dur[id]);
    expect(cp.totalSec).toBe(150);
    expect(cp.criticalPath).toEqual(["A", "B"]);
  });

  it("拓扑序 A 在 B/C 前", () => {
    const cp = analyzeCriticalPath(dag, (id) => dur[id]);
    expect(cp.order[0]).toBe("A");
  });

  it("改 C 为最慢则关键路径转 A→C", () => {
    const cp = analyzeCriticalPath(dag, (id) => ({ A: 100, B: 50, C: 200 }[id] || 0));
    expect(cp.criticalPath).toEqual(["A", "C"]);
    expect(cp.totalSec).toBe(300);
  });
});

describe("predictEta — 破线预测", () => {
  const dag = { nodes: [{ id: "A" }, { id: "B" }], edges: [{ source: "A", target: "B" }] };
  const baseP90: Record<string, number> = { A: 60, B: 60 }; // 各 60s,关键路径 120s
  const now = Date.parse("2026-07-12T02:00:00Z");
  const target: SlaTarget = { scope: "workflow", type: "relative", offsetMinFromTrigger: 90 };

  it("中途变慢 → 预测破线 red + 卡点正确", () => {
    // 触发在 90 分钟前(=now-90min),SLA=触发+90min=now(此刻就是死线)。
    const triggerAtMs = now - 90 * 60_000;
    // A 已完成(实际 60s),B 进行中且已跑很久(elapsed 3000s,远超基线 60s)→ 剩余仍需时间 → ETA 晚于 now。
    const res = predictEta({
      dag, baselineDurationOf: (id) => baseP90[id], startedAtMs: triggerAtMs, triggerAtMs,
      runtime: { A: { nodeId: "A", status: "succeeded", actualSec: 60 }, B: { nodeId: "B", status: "running", elapsedSec: 3000 } },
      slaTarget: target, warnLeadMin: 30, now,
    });
    // B 基线 60 - 已耗 3000 → 剩余 0,但 SLA 就是 now,marginMin≈0;用更严格 SLA 触发破线:
    expect(res.criticalPathNode).toBe("B"); // 卡点是进行中的 B
  });

  it("SLA 早于 ETA → willBreach=true red", () => {
    // SLA=触发后 1 分钟(极紧),但还有 B 未开始(基线 60s)→ 必破线。
    const triggerAtMs = now;
    const res = predictEta({
      dag, baselineDurationOf: (id) => baseP90[id], startedAtMs: now, triggerAtMs,
      runtime: { A: { nodeId: "A", status: "succeeded", actualSec: 60 }, B: { nodeId: "B", status: "pending" } },
      slaTarget: { scope: "workflow", type: "relative", offsetMinFromTrigger: 0 }, warnLeadMin: 30, now,
    });
    expect(res.willBreach).toBe(true);
    expect(res.riskLevel).toBe("red");
    expect(res.criticalPathNode).toBe("B");
  });

  it("余量充足 → green 不破线", () => {
    const res = predictEta({
      dag, baselineDurationOf: (id) => baseP90[id], startedAtMs: now, triggerAtMs: now,
      runtime: { A: { nodeId: "A", status: "succeeded", actualSec: 60 }, B: { nodeId: "B", status: "pending" } },
      slaTarget: { scope: "workflow", type: "relative", offsetMinFromTrigger: 120 }, warnLeadMin: 30, now, // 死线 2h 后,剩 60s
    });
    expect(res.willBreach).toBe(false);
    expect(res.riskLevel).toBe("green");
  });

  it("接近死线(余量<warnLead)→ yellow", () => {
    const res = predictEta({
      dag, baselineDurationOf: (id) => baseP90[id], startedAtMs: now, triggerAtMs: now,
      runtime: { A: { nodeId: "A", status: "succeeded", actualSec: 60 }, B: { nodeId: "B", status: "pending" } },
      // 剩余 B=60s;死线=触发后 15 分钟 → 余量 ~14min < warnLead 30 → yellow。
      slaTarget: { scope: "workflow", type: "relative", offsetMinFromTrigger: 15 }, warnLeadMin: 30, now,
    });
    expect(res.riskLevel).toBe("yellow");
    expect(res.willBreach).toBe(false);
  });
});

describe("computeSlaDeadline", () => {
  const now = Date.parse("2026-07-12T02:00:00Z");
  it("relative = 触发 + offset", () => {
    const trig = Date.parse("2026-07-12T00:00:00Z");
    expect(computeSlaDeadline({ scope: "workflow", type: "relative", offsetMinFromTrigger: 90 }, trig, now)).toBe(trig + 90 * 60_000);
  });
  it("absolute 取触发日的 clockTime;若早于触发则次日", () => {
    const trig = Date.parse("2026-07-12T23:00:00Z"); // 触发在 23:00
    const dl = computeSlaDeadline({ scope: "workflow", type: "absolute", clockTime: "02:00" }, trig, now);
    expect(new Date(dl).toISOString()).toBe("2026-07-13T02:00:00.000Z"); // 次日 02:00
  });
});

describe("confirmBreachMultiWindow — 多窗口降误报", () => {
  it("单点抖动(历史多为不破线)不确认", () => {
    // 当前破线,但历史 6 次里只有这 1 次 → 短窗不满(前一次非破线)、长窗占比低 → 不确认。
    expect(confirmBreachMultiWindow(true, [false, false, false, false, false])).toBe(false);
  });
  it("持续变慢(短窗连续破线)确认", () => {
    expect(confirmBreachMultiWindow(true, [false, true])).toBe(true); // 最近2次[true(hist),true(cur)]全破线
  });
  it("长窗占比高确认", () => {
    expect(confirmBreachMultiWindow(true, [true, false, true, true])).toBe(true); // 含当前5次里4破线=80%≥60%
  });
  it("当前不破线 → 恒不确认", () => {
    expect(confirmBreachMultiWindow(false, [true, true, true])).toBe(false);
  });
});
