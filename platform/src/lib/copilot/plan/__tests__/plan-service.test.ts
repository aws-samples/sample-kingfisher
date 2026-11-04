// 模块 44 — Copilot 计划服务纯函数单测(照补数 plan.test.ts 范式:零 AWS 依赖,锁死不变量)。
// 重点验证【新增 gated 两态】的状态派生正确 + Progress 键与 StepStatus 名一一对应的硬契约。

import { describe, it, expect } from "vitest";
import { aggregateProgress, derivePlanStatus, stepIdOf } from "../plan-service";
import type { CopilotStepRow, PlanProgress, StepStatus } from "../types";

// 造一个最小 step(只关心 status)。
function step(status: StepStatus, seq = 1): CopilotStepRow {
  return {
    planId: "p", stepId: stepIdOf(seq), seq, stepType: "redshift-sql",
    title: "t", rationale: "r", params: {}, dependsOn: [], status,
    attempts: 0, ttl: 0,
  };
}

describe("stepIdOf", () => {
  it("zero-pad 4 位保证字典序=展示序", () => {
    expect(stepIdOf(1)).toBe("0001");
    expect(stepIdOf(42)).toBe("0042");
    expect(stepIdOf(1) < stepIdOf(2)).toBe(true);
    expect(stepIdOf(9) < stepIdOf(10)).toBe(true); // 字典序不会把 9>10
  });
});

describe("aggregateProgress", () => {
  it("Progress 键与 StepStatus 名一一对应(8 状态全计数)", () => {
    const steps = [
      step("awaiting-confirmation"), step("confirmed"), step("blocked"),
      step("pending"), step("running"), step("succeeded"), step("failed"), step("skipped"),
    ];
    const p = aggregateProgress(steps);
    expect(p.total).toBe(8);
    expect(p["awaiting-confirmation"]).toBe(1);
    expect(p.confirmed).toBe(1);
    expect(p.blocked).toBe(1);
    expect(p.pending).toBe(1);
    expect(p.running).toBe(1);
    expect(p.succeeded).toBe(1);
    expect(p.failed).toBe(1);
    expect(p.skipped).toBe(1);
  });

  it("空步骤 → 全 0", () => {
    const p = aggregateProgress([]);
    expect(p.total).toBe(0);
    expect(p.succeeded).toBe(0);
  });
});

describe("derivePlanStatus(含 gated 两态)", () => {
  const mk = (partial: Partial<PlanProgress>): PlanProgress => ({
    total: 0, "awaiting-confirmation": 0, confirmed: 0, blocked: 0,
    pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0, ...partial,
  });

  it("全部 succeeded → succeeded", () => {
    expect(derivePlanStatus("running", mk({ total: 3, succeeded: 3 }))).toBe("succeeded");
  });

  it("有 failed 且无活跃 → partially-failed", () => {
    expect(derivePlanStatus("running", mk({ total: 3, succeeded: 2, failed: 1 }))).toBe("partially-failed");
  });

  it("只剩等确认(awaiting)→ awaiting(引擎不推,等用户)", () => {
    // 关键 gated 语义:计划产出后全是 awaiting-confirmation,状态应为 awaiting 而非 running。
    expect(derivePlanStatus("planned", mk({ total: 2, "awaiting-confirmation": 2 }))).toBe("awaiting");
  });

  it("只剩 blocked(无人推)→ awaiting", () => {
    expect(derivePlanStatus("planned", mk({ total: 2, "awaiting-confirmation": 1, blocked: 1 }))).toBe("awaiting");
  });

  it("有 confirmed(已确认待执行)→ running", () => {
    expect(derivePlanStatus("awaiting", mk({ total: 2, confirmed: 1, succeeded: 1 }))).toBe("running");
  });

  it("有 running → running", () => {
    expect(derivePlanStatus("awaiting", mk({ total: 2, running: 1, "awaiting-confirmation": 1 }))).toBe("running");
  });

  it("cancelled/paused 是终态锁,不被派生覆盖", () => {
    expect(derivePlanStatus("cancelled", mk({ total: 3, succeeded: 3 }))).toBe("cancelled");
    expect(derivePlanStatus("paused", mk({ total: 3, running: 1 }))).toBe("paused");
  });
});
