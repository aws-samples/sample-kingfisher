// SLA 预测破线文案里的「当前卡在 <节点>」:
//   任务型 SLA 的节点就是任务自己(2026-11-11 真环境的事件行尾巴是任务自己的裸 id)⇒ 这半句不写;
//   工作流型写节点在画布上的显示名,定义里没有显示名才回落到节点 id。
// 另钉接缝:推送破线事件的调用点用的就是这个函数(写了不等于接上了);名字表的三个调用方都经唯一作者。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { stuckNodeLabel } from "@/lib/baseline/sla-predict";
import type { SlaRow } from "@/lib/baseline/types";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), "src", rel), "utf8");
const slaOf = (target: Record<string, unknown>) => ({ target } as unknown as SlaRow);
const dag = {
  nodes: [
    { id: "n1", type: "sync", data: { label: "同步订单" } },
    { id: "n2", type: "sql", data: { label: "  " } },
    { id: "n3", type: "job" },
  ],
};

describe("破线文案里的卡点节点", () => {
  it("任务型 SLA ⇒ 不写(节点就是任务自己)", () => {
    expect(stuckNodeLabel(slaOf({ scope: "task", taskId: "job-1" }), { nodes: [{ id: "job-1", data: { label: "job-1" } }] }, "job-1")).toBeUndefined();
  });
  it("工作流型 ⇒ 节点的显示名", () => {
    expect(stuckNodeLabel(slaOf({ scope: "workflow", workflowId: "wf-1" }), dag, "n1")).toBe("同步订单");
  });
  it("工作流型但节点没有显示名(空白 / 缺 data / 定义里找不到)⇒ 回落到节点 id", () => {
    const sla = slaOf({ scope: "workflow", workflowId: "wf-1" });
    expect(stuckNodeLabel(sla, dag, "n2")).toBe("n2");
    expect(stuckNodeLabel(sla, dag, "n3")).toBe("n3");
    expect(stuckNodeLabel(sla, dag, "n9")).toBe("n9");
  });
  it("没有卡点 ⇒ 不写", () => {
    expect(stuckNodeLabel(slaOf({ scope: "workflow", workflowId: "wf-1" }), dag, undefined)).toBeUndefined();
  });
});

describe("🔴 接缝:调用点", () => {
  it("推送破线事件时的卡点取自 stuckNodeLabel,不再把节点 id 原样塞进文案", () => {
    const src = read("lib/baseline/sla-predict.ts");
    expect(src).toMatch(/pushBreachAlert\(sla, prediction, \{ node: stuckNodeLabel\(sla, dag, pred\.criticalPathNode\)/);
    expect(src).not.toMatch(/node: pred\.criticalPathNode/);
  });
  it("规则评估的文案任务名经「按 id 取现名」;运行行类型里没有 taskName 可取", () => {
    const src = read("lib/alerting/evaluate.ts");
    expect(src).toContain('from "@/lib/monitor/run-object-name"');
    expect(src).toMatch(/await runObjectNamesByIds\(idsInText\)/);
    expect(src).not.toMatch(/r\.taskName/);
  });
  it("监控页与运维大屏的名字表来自同一个作者,文件里不再各自扫资源表", () => {
    for (const rel of ["app/api/monitor/runs/route.ts", "lib/alerting/ops-summary.ts"]) {
      const src = read(rel);
      expect(src, rel).toMatch(/scanRunObjectNames\(/);
      for (const table of ["TABLES.SYNC_TASKS", "TABLES.WORKFLOWS", "TABLES.ETL_JOBS", "TABLES.ENGINE_JOBS", "TABLES.ACTION_SCHEDULES"]) {
        expect(src, `${rel} 不许再直接读 ${table}`).not.toContain(table);
      }
    }
  });
});
