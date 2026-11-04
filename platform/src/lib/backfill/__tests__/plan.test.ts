import { describe, it, expect } from "vitest";
import { expandDates, analyzeDag, expandInstances, instanceSk } from "../plan";
import { aggregateProgress, derivePlanStatus } from "../service";
import type { BackfillInstanceRow } from "../types";

describe("expandDates", () => {
  it("展开日粒度含端点", () => {
    expect(expandDates({ start: "2026-07-01", end: "2026-07-03", granularity: "day" })).toEqual([
      "2026-07-01", "2026-07-02", "2026-07-03",
    ]);
  });
  it("单日", () => {
    expect(expandDates({ start: "2026-07-05", end: "2026-07-05", granularity: "day" })).toEqual(["2026-07-05"]);
  });
  it("周粒度每7天一个点", () => {
    expect(expandDates({ start: "2026-07-01", end: "2026-07-20", granularity: "week" })).toEqual([
      "2026-07-01", "2026-07-08", "2026-07-15",
    ]);
  });
  it("小时粒度单日展开24点", () => {
    const hrs = expandDates({ start: "2026-07-01", end: "2026-07-01", granularity: "hour" });
    expect(hrs.length).toBe(24);
    expect(hrs[0]).toBe("2026-07-01-00");
    expect(hrs[23]).toBe("2026-07-01-23");
  });
  it("倒序日期抛错", () => {
    expect(() => expandDates({ start: "2026-07-05", end: "2026-07-01", granularity: "day" })).toThrow();
  });
  it("非法日期抛错", () => {
    expect(() => expandDates({ start: "bad", end: "2026-07-01", granularity: "day" })).toThrow();
  });
});

describe("analyzeDag — 拓扑与上游", () => {
  // rollup → {roasrank, country}(fan-out),验收文档指定的形状。
  const dag = {
    nodes: [
      { id: "A", type: "sql", data: { label: "A_rollup" } },
      { id: "B", type: "sql", data: { label: "B_roasrank" } },
      { id: "C", type: "sql", data: { label: "C_country" } },
    ],
    edges: [
      { source: "A", target: "B" },
      { source: "A", target: "C" },
    ],
  };
  it("拓扑序:A 在 B/C 之前", () => {
    const { order } = analyzeDag(dag);
    expect(order[0]).toBe("A");
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("B"));
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("C"));
  });
  it("上游:B/C 的上游是 A,A 无上游", () => {
    const { upstream } = analyzeDag(dag);
    expect(upstream["A"]).toEqual([]);
    expect(upstream["B"]).toEqual(["A"]);
    expect(upstream["C"]).toEqual(["A"]);
  });
  it("节点元信息带 label 与 type", () => {
    const { nodeMeta } = analyzeDag(dag);
    expect(nodeMeta["A"]).toEqual({ name: "A_rollup", type: "sql" });
  });
  it("脏边(端点不在节点集)被丢弃", () => {
    const { upstream } = analyzeDag({ nodes: [{ id: "A" }], edges: [{ source: "X", target: "A" }] });
    expect(upstream["A"]).toEqual([]);
  });
  it("有环不丢节点(退化补齐)", () => {
    const { order } = analyzeDag({ nodes: [{ id: "A" }, { id: "B" }], edges: [{ source: "A", target: "B" }, { source: "B", target: "A" }] });
    expect(order.sort()).toEqual(["A", "B"]);
  });
});

describe("expandInstances", () => {
  const dateRange = { start: "2026-07-01", end: "2026-07-02", granularity: "day" as const };
  const dag = {
    nodes: [
      { id: "A", type: "sql", data: { label: "A_rollup" } },
      { id: "B", type: "sql", data: { label: "B_roasrank" } },
      { id: "C", type: "sql", data: { label: "C_country" } },
    ],
    edges: [{ source: "A", target: "B" }, { source: "A", target: "C" }],
  };

  it("task 作用域:每日一个实例,无依赖", () => {
    const specs = expandInstances({ scope: "task", targetId: "job1", targetName: "J", dateRange, cascade: false, maxInstances: 100 });
    expect(specs.length).toBe(2);
    expect(specs.every((s) => s.dependsOn.length === 0)).toBe(true);
    expect(specs[0].sk).toBe(instanceSk("2026-07-01", "job1"));
  });

  it("workflow cascade:每日×每节点一实例,B/C 依赖同日期 A", () => {
    const specs = expandInstances({ scope: "workflow", targetId: "wf1", targetName: "W", dateRange, cascade: true, dag, maxInstances: 100 });
    expect(specs.length).toBe(6); // 2 日 × 3 节点
    const b0701 = specs.find((s) => s.date === "2026-07-01" && s.nodeId === "B")!;
    expect(b0701.dependsOn).toEqual([instanceSk("2026-07-01", "A")]);
    // 跨日期不串:07-02 的 B 依赖 07-02 的 A(而非 07-01)。
    const b0702 = specs.find((s) => s.date === "2026-07-02" && s.nodeId === "B")!;
    expect(b0702.dependsOn).toEqual([instanceSk("2026-07-02", "A")]);
  });

  it("workflow 非 cascade:节点无依赖(同日全并行)", () => {
    const specs = expandInstances({ scope: "workflow", targetId: "wf1", targetName: "W", dateRange, cascade: false, dag, maxInstances: 100 });
    expect(specs.every((s) => s.dependsOn.length === 0)).toBe(true);
  });

  it("超天花板抛错(拒绝创建)", () => {
    expect(() => expandInstances({ scope: "task", targetId: "j", targetName: "J", dateRange, cascade: false, maxInstances: 1 })).toThrow(/天花板/);
  });
});

describe("aggregateProgress / derivePlanStatus", () => {
  const mk = (status: BackfillInstanceRow["status"]): BackfillInstanceRow => ({
    planId: "p", sk: "s" + Math.random(), date: "2026-07-01", nodeId: "n", nodeName: "n",
    status, dependsOn: [], attempts: 0, ttl: 0,
  });

  it("聚合各状态计数", () => {
    const p = aggregateProgress([mk("succeeded"), mk("succeeded"), mk("failed"), mk("pending")]);
    expect(p.total).toBe(4);
    expect(p.succeeded).toBe(2);
    expect(p.failed).toBe(1);
    expect(p.pending).toBe(1);
  });

  it("全成功 → succeeded", () => {
    const p = aggregateProgress([mk("succeeded"), mk("succeeded")]);
    expect(derivePlanStatus("running", p)).toBe("succeeded");
  });

  it("有失败且无活跃 → partially-failed", () => {
    const p = aggregateProgress([mk("succeeded"), mk("failed"), mk("skipped")]);
    expect(derivePlanStatus("running", p)).toBe("partially-failed");
  });

  it("仍有 running/pending → running", () => {
    const p = aggregateProgress([mk("succeeded"), mk("running"), mk("pending")]);
    expect(derivePlanStatus("running", p)).toBe("running");
  });

  it("paused/cancelled 状态不被派生覆盖", () => {
    const p = aggregateProgress([mk("succeeded"), mk("failed")]);
    expect(derivePlanStatus("paused", p)).toBe("paused");
    expect(derivePlanStatus("cancelled", p)).toBe("cancelled");
  });
});

describe("🔴🔴 补数实例的 target 维(日期 × 节点 × target)—— 纯追加,home 逐字节不变", () => {
  const dateRange = { start: "2026-07-01", end: "2026-07-02", granularity: "day" as const };

  it("🔴 home / 不传 ⇒ `sk` **逐字节等于**改动前(存量计划的 dependsOn 存的就是 sk 字符串,换名会打断依赖链)", () => {
    expect(instanceSk("2026-07-01", "A")).toBe("2026-07-01#A");
    expect(instanceSk("2026-07-01", "A", "tgt_home")).toBe("2026-07-01#A");
    expect(instanceSk("2026-07-01", "A", "tgt_usw2_a")).toBe("2026-07-01#A#tgt_usw2_a");
  });

  it("🔴 task 作用域:2 天 × 2 区 = **4 个实例**(原来只补第一个区 ⇒ 另一个区静默是空的)", () => {
    const specs = expandInstances({
      scope: "task", targetId: "job1", targetName: "J", dateRange, cascade: false, maxInstances: 100,
      execTargets: ["tgt_home", "tgt_usw2_a"],
    });
    expect(specs.length).toBe(4);
    expect(specs.map((x) => x.sk).sort()).toEqual([
      "2026-07-01#job1", "2026-07-01#job1#tgt_usw2_a",
      "2026-07-02#job1", "2026-07-02#job1#tgt_usw2_a",
    ]);
    expect(specs.every((x) => Boolean(x.targetId)), "实例没带 targetId ⇒ 执行侧只能猜落点").toBe(true);
  });

  it("单绑非 home:每天一个实例,且实例带的是那个区(不是 home)", () => {
    const specs = expandInstances({
      scope: "task", targetId: "job1", targetName: "J", dateRange, cascade: false, maxInstances: 100,
      execTargets: ["tgt_usw2_a"],
    });
    expect(specs.length).toBe(2);
    expect(specs.every((x) => x.targetId === "tgt_usw2_a")).toBe(true);
  });

  it("🔴🔴 cascade 的依赖**限定在同一个 target 内**(跨区串依赖会让慢区把快区卡住,语义也不对)", () => {
    const dag = { nodes: [{ id: "A" }, { id: "B" }], edges: [{ source: "A", target: "B" }] };
    const specs = expandInstances({
      scope: "workflow", targetId: "wf1", targetName: "W", dateRange, cascade: true, dag, maxInstances: 100,
      execTargets: ["tgt_home", "tgt_usw2_a"],
    });
    const bHomeSame = specs.find((x) => x.nodeId === "B" && x.date === "2026-07-01" && x.targetId === "tgt_home")!;
    const bUsw2 = specs.find((x) => x.nodeId === "B" && x.date === "2026-07-01" && x.targetId === "tgt_usw2_a")!;
    expect(bHomeSame.dependsOn).toEqual(["2026-07-01#A"]);
    expect(bUsw2.dependsOn, "usw2 的 B 依赖了 home 的 A ⇒ 一个区的慢会把另一个区卡住").toEqual([
      "2026-07-01#A#tgt_usw2_a",
    ]);
  });

  it("🔴 天花板对**乘完之后**的总数生效(多区把量放大 N 倍,爆炸半径必须仍被闸住)", () => {
    expect(() =>
      expandInstances({
        scope: "task", targetId: "j", targetName: "J", dateRange, cascade: false, maxInstances: 3,
        execTargets: ["tgt_home", "tgt_usw2_a"],
      })
    ).toThrow(/将生成 4 个实例/);
  });

  it("去重:同一个 target 传两遍不会生成两份实例", () => {
    const specs = expandInstances({
      scope: "task", targetId: "j", targetName: "J", dateRange, cascade: false, maxInstances: 100,
      execTargets: ["tgt_usw2_a", "tgt_usw2_a"],
    });
    expect(specs.length).toBe(2);
  });
});
