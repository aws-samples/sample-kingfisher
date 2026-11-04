// 工作流实例「节点详情」每行(Airflow task_id)→ 它在 dagDefinition 里引用的作业 / 同步任务(服务端组装)。
//
// 节点状态 API 回的是 **task_id**(§15.2 归一后的 id,含碰撞后缀),而回链要的是原始节点的 jobRef / syncTaskId
// ⇒ 必须用生成器那一份权威映射 `buildIdMap`(task_id 的唯一作者)把两边对上;页面只拿到 `backLink`,不自己猜 id。
import { buildIdMap } from "./dag-generator-v2";
import { nodeBackLinkOf, type NodeBackLink } from "./back-links";
import type { WorkflowNodeLike } from "./job-ref";

/** task_id → 回链事实(只有作业 / 同步节点出现在结果里)。 */
export function nodeBackLinksByTaskId(definition: { nodes?: unknown[] } | null | undefined): Record<string, NodeBackLink> {
  const nodes = (Array.isArray(definition?.nodes) ? definition!.nodes : []) as Array<WorkflowNodeLike & { id: string }>;
  const idMap = buildIdMap(nodes.map((n) => ({ id: String(n?.id ?? "") })));
  const out: Record<string, NodeBackLink> = {};
  for (const n of nodes) {
    const link = nodeBackLinkOf(n);
    if (link) out[idMap[String(n?.id ?? "")]] = link;
  }
  return out;
}

/** 给节点状态行挂上 backLink(没有回链的节点挂 null,字段恒在 ⇒ 页面不用猜缺省)。 */
export function withNodeBackLinks<T extends { taskId: string }>(rows: T[], definition: { nodes?: unknown[] } | null | undefined): Array<T & { backLink: NodeBackLink | null }> {
  const links = nodeBackLinksByTaskId(definition);
  return rows.map((r) => ({ ...r, backLink: links[r.taskId] ?? null }));
}
