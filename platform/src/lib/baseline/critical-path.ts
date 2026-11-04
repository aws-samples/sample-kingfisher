// 模块 43-B — 关键路径分析(纯函数,可单测,零 AWS 依赖)。
//
// 输入 workflow DAG(nodes/edges)+ 各节点基线时长(nodeId → sec)→ 拓扑排序 → 求最长路径
// (关键路径)与理论总时长。缺基线的节点用 fallback(0 或调用方给的默认)。

export interface CriticalPathResult {
  order: string[]; // 拓扑序
  criticalPath: string[]; // 关键路径节点序(最长耗时链)
  totalSec: number; // 关键路径总时长
  nodeDurations: Record<string, number>; // 参与计算的每节点时长
  earliestFinish: Record<string, number>; // 每节点最早完成(从起点累计)
}

export function analyzeCriticalPath(
  dag: { nodes?: any[]; edges?: any[] } | undefined,
  durationOf: (nodeId: string) => number,
): CriticalPathResult {
  const nodes = dag?.nodes || [];
  const edges = dag?.edges || [];
  const ids = nodes.map((n: any) => String(n.id));
  const idSet = new Set(ids);
  const upstream: Record<string, string[]> = {};
  const downstream: Record<string, string[]> = {};
  for (const id of ids) { upstream[id] = []; downstream[id] = []; }
  for (const e of edges) {
    const s = String(e.source), t = String(e.target);
    if (idSet.has(s) && idSet.has(t)) { upstream[t].push(s); downstream[s].push(t); }
  }

  // Kahn 拓扑序。
  const indeg: Record<string, number> = {};
  for (const id of ids) indeg[id] = upstream[id].length;
  const queue = ids.filter((id) => indeg[id] === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const d of downstream[id]) { indeg[d] -= 1; if (indeg[d] === 0) queue.push(d); }
  }
  for (const id of ids) if (!order.includes(id)) order.push(id); // 有环兜底

  const nodeDurations: Record<string, number> = {};
  for (const id of ids) nodeDurations[id] = Math.max(0, durationOf(id) || 0);

  // 最早完成时间 EF[n] = max(上游 EF) + dur[n];关键路径 = 反向追溯 EF 最大的叶子。
  const ef: Record<string, number> = {};
  const pred: Record<string, string | null> = {};
  for (const id of order) {
    let maxUp = 0; let from: string | null = null;
    for (const u of upstream[id]) {
      if (ef[u] > maxUp) { maxUp = ef[u]; from = u; }
    }
    ef[id] = maxUp + nodeDurations[id];
    pred[id] = from;
  }

  let endNode: string | null = null; let totalSec = 0;
  for (const id of ids) if (ef[id] >= totalSec) { totalSec = ef[id]; endNode = id; }

  const criticalPath: string[] = [];
  let cur = endNode;
  while (cur) { criticalPath.unshift(cur); cur = pred[cur]; }

  return { order, criticalPath, totalSec, nodeDurations, earliestFinish: ef };
}
