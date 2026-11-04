// 补数计划展开(纯函数,可单测,零 AWS 依赖)。
//
// 职责:把 [目标 × 日期范围 × 是否级联] 展开成实例规格集(InstanceSpec[]),供:
//  1) dry-run 预览(不落库,先给用户看"将生成 N 个实例")
//  2) 确认后 service.createPlan 落库
//
// 天花板 maxInstances 在这里校验(展开后 total 超限即抛错),防一次误操作生成海量实例打爆引擎。

import { dateRange as dailyRange, isValidDs, toDs } from "@/lib/etl/run-params";
import type {
  BackfillDateRange,
  BackfillScope,
  InstanceSpec,
} from "./types";

// ── 日期序列展开(尊重粒度) ──
// day:逐日;week:每 7 天一个点(从 start 起步,含 start,≤end);hour:start 当天 00..23 时点
// (小时任务补数通常限单日,超 1 天按天×24 展开,受 maxInstances 兜底)。
export function expandDates(range: BackfillDateRange): string[] {
  const { start, end, granularity } = range;
  if (!isValidDs(start) || !isValidDs(end)) throw new Error("日期格式应为 YYYY-MM-DD");
  if (start > end) throw new Error("起始日期不能晚于结束日期");

  if (granularity === "week") {
    const out: string[] = [];
    const s = new Date(`${start}T00:00:00Z`);
    const e = new Date(`${end}T00:00:00Z`);
    for (let d = s; d.getTime() <= e.getTime(); d.setUTCDate(d.getUTCDate() + 7)) {
      out.push(toDs(d));
      if (out.length > 60) throw new Error("补数区间过大(按周最多 60 个点)");
    }
    return out;
  }

  if (granularity === "hour") {
    const days = dailyRange(start, end, 7); // 小时粒度最多跨 7 天(7×24=168 点),再多用天粒度
    const out: string[] = [];
    for (const d of days) {
      for (let h = 0; h < 24; h++) out.push(`${d}-${String(h).padStart(2, "0")}`);
    }
    return out;
  }

  // day(默认)
  return dailyRange(start, end, 62); // 天粒度最多 62 天
}

// ── workflow DAG 拓扑:求节点顺序 + 每节点的直接上游 ──
// 输入弱类型 dagDefinition(node.id / edge.source→edge.target)。返回:
//  - order: 拓扑序节点 id(用于稳定展开)
//  - upstream: nodeId → 直接上游 nodeId[]
//  - nodeMeta: nodeId → { name, type }
export interface DagTopology {
  order: string[];
  upstream: Record<string, string[]>;
  nodeMeta: Record<string, { name: string; type?: string }>;
}

export function analyzeDag(dag: { nodes?: any[]; edges?: any[] } | undefined): DagTopology {
  const nodes = dag?.nodes || [];
  const edges = dag?.edges || [];
  const ids = nodes.map((n: any) => String(n.id));
  const idSet = new Set(ids);
  const upstream: Record<string, string[]> = {};
  const nodeMeta: Record<string, { name: string; type?: string }> = {};
  for (const n of nodes) {
    const id = String(n.id);
    upstream[id] = [];
    nodeMeta[id] = { name: n.data?.label || id, type: n.type };
  }
  for (const e of edges) {
    const src = String(e.source);
    const tgt = String(e.target);
    // 只保留两端都在节点集内的边(防脏边)。
    if (idSet.has(src) && idSet.has(tgt)) upstream[tgt].push(src);
  }
  // Kahn 拓扑排序(稳定:按原始节点顺序打破平局)。环则退化为原始顺序(best-effort,不阻断补数)。
  const indeg: Record<string, number> = {};
  for (const id of ids) indeg[id] = upstream[id].length;
  const queue = ids.filter((id) => indeg[id] === 0);
  const order: string[] = [];
  const downstream: Record<string, string[]> = {};
  for (const id of ids) downstream[id] = [];
  for (const [tgt, srcs] of Object.entries(upstream)) for (const s of srcs) downstream[s].push(tgt);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const d of downstream[id]) {
      indeg[d] -= 1;
      if (indeg[d] === 0) queue.push(d);
    }
  }
  if (order.length < ids.length) {
    // 存在环:把未排入的按原序补齐(不丢节点)。
    for (const id of ids) if (!order.includes(id)) order.push(id);
  }
  return { order, upstream, nodeMeta };
}

// 实例 sk 约定:"<date>#<nodeId>"。task 作用域 nodeId 固定为目标 id。
//
// 🔴 **多 region:加第三段 `#<targetId>`,而 home 逐字节不变**。
// 为什么必须 home 不变:存量计划的实例 sk 已经落在库里,`dependsOn` 里存的也是 sk 字符串 ——
// 换名等于把存量计划的依赖链整体打断(blocked 的实例永远等不到它的前置)。
// 与 dagId 的口径完全一致(home 逐字节等价、非 home 加 target 段),两处同一条纪律。
export function instanceSk(date: string, nodeId: string, targetId?: string): string {
  const base = `${date}#${nodeId}`;
  return !targetId || targetId === "tgt_home" ? base : `${base}#${targetId}`;
}

// ── 展开成实例规格集 ──
// task 作用域:每(日期)一个实例,nodeId=目标 id,无依赖。
// workflow 作用域:每(日期 × 节点)一个实例;cascade=true 时 dependsOn=同日期上游节点实例的 sk。
export function expandInstances(args: {
  scope: BackfillScope;
  targetId: string;
  targetName: string;
  targetTaskType?: string;
  dateRange: BackfillDateRange;
  cascade: boolean;
  dag?: { nodes?: any[]; edges?: any[] };
  maxInstances: number;
  // 执行目标集合(缺省 = 单个 home,展开结果与改动前**逐字节相同**)。
  execTargets?: string[];
}): InstanceSpec[] {
  const dates = expandDates(args.dateRange);
  const specs: InstanceSpec[] = [];
  // 🔴 维度从 (日期 × 节点) 升为 (日期 × 节点 × **target**)。**纯追加**:
  // 每个实例仍是"一次独立的异步提交",runner / 领取 / reconcile / 依赖机制**一行不改**。
  // 🔴 `dependsOn` **限定在同一个 target 内** —— eu 的节点 B 依赖的是 eu 的节点 A,
  // 而不是 home 的 A。跨区串依赖会让一个区的慢把另一个区卡住,而且语义上根本不对。
  const targets = (args.execTargets && args.execTargets.length ? args.execTargets : ["tgt_home"]).filter(
    (x, i, a) => a.indexOf(x) === i
  );

  if (args.scope === "task") {
    for (const date of dates) {
      for (const t of targets) {
        specs.push({
          sk: instanceSk(date, args.targetId, t),
          date,
          nodeId: args.targetId,
          nodeName: args.targetName,
          nodeType: args.targetTaskType,
          dependsOn: [],
          targetId: t,
        });
      }
    }
  } else {
    const topo = analyzeDag(args.dag);
    if (topo.order.length === 0) throw new Error("工作流无节点,无法补数");
    for (const date of dates) {
      for (const t of targets) {
        for (const nodeId of topo.order) {
          const meta = topo.nodeMeta[nodeId];
          // cascade:同日期**同 target** 的上游节点实例为前置;非 cascade:同日期节点全并行(无依赖)。
          const dependsOn = args.cascade
            ? topo.upstream[nodeId].map((u) => instanceSk(date, u, t))
            : [];
          specs.push({
            sk: instanceSk(date, nodeId, t),
            date,
            nodeId,
            nodeName: meta.name,
            nodeType: meta.type,
            dependsOn,
            targetId: t,
          });
        }
      }
    }
  }

  if (specs.length === 0) throw new Error("展开后无补数实例,请检查日期范围");
  if (specs.length > args.maxInstances) {
    throw new Error(`将生成 ${specs.length} 个实例,超过天花板 ${args.maxInstances};请缩小日期范围或关闭级联`);
  }
  return specs;
}
