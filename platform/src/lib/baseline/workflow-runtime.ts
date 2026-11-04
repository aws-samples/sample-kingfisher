// 模块 43-B — 读工作流某次 run 的节点运行态(供破线预测)。
//
// 首期数据来源:workflow 级 run 记录(bgp-task-runs)+ 各节点基线。平台当前把 workflow 整体作为
// 一条 run 记录(节点级 task-instance 在 MWAA 内,读取需 MWAA API);因此:
//  · 若调用方(predict API)显式传入 runtime(回放/注入,验收"中途变慢"场景)→ 直接用之。
//  · 否则从 workflow run 记录派生一个"整体进行中"的粗粒度态(所有节点视作 pending/running)。
// 这样预测在有精确节点态时精确、无精确态时给出基于基线的保守 ETA;两条路都不新增 MWAA 权限。

import type { NodeRuntimeState } from "./predict";

// 从注入的 runtime map(nodeId → {status, actualSec?, elapsedSec?})规整成标准结构。
export function normalizeRuntime(raw: Record<string, any> | undefined, nodeIds: string[]): Record<string, NodeRuntimeState> {
  const out: Record<string, NodeRuntimeState> = {};
  for (const id of nodeIds) {
    const r = raw?.[id];
    if (r && typeof r === "object") {
      out[id] = {
        nodeId: id,
        status: String(r.status || "pending"),
        actualSec: typeof r.actualSec === "number" ? r.actualSec : undefined,
        elapsedSec: typeof r.elapsedSec === "number" ? r.elapsedSec : undefined,
      };
    } else {
      out[id] = { nodeId: id, status: "pending" };
    }
  }
  return out;
}
