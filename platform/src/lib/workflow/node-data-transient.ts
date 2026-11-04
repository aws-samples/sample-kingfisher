// 序 73 模块 57 —— dagDefinition 节点 data 里**只许活在编辑期**的字段(闭合清单)与落库前的剥离(唯一作者)。
//
// 【缺陷原形】面板按候选清单算出 `jobMissing`(引用的作业不在本工作流执行区的候选里)写进 node.data 给画布显示警示,
//   保存时整个 node.data 原样 PUT ⇒ 一个**派生的、随候选变化的**判断被钉进了持久化定义:作业重新绑回该区后,
//   存量定义里仍写着 jobMissing=true(画布一打开就报「作业不存在」),而发布期判定(loadJobNodeRow)根本不读它。
//   权威只有 jobRef;派生值在哪儿算就在哪儿用,**不落库**。PUT 路由落库前经这里剥掉。
export const TRANSIENT_NODE_DATA_KEYS = ["jobMissing"] as const;

/** 剥掉节点 data 里的编辑期字段;其余节点 / 边 / 字段逐字节不动(没有要剥的 ⇒ 返回同一个对象)。 */
export function stripTransientNodeData<T extends { nodes?: unknown[]; edges?: unknown[] } | null | undefined>(definition: T): T {
  if (!definition || !Array.isArray(definition.nodes)) return definition;
  let touched = false;
  const nodes = definition.nodes.map((n) => {
    const data = (n as { data?: Record<string, unknown> | null })?.data;
    if (!data || typeof data !== "object") return n;
    if (!TRANSIENT_NODE_DATA_KEYS.some((k) => k in data)) return n;
    touched = true;
    const rest = { ...data };
    for (const k of TRANSIENT_NODE_DATA_KEYS) delete rest[k];
    return { ...(n as object), data: rest };
  });
  return touched ? ({ ...definition, nodes } as T) : definition;
}
