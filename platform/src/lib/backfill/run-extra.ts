// 补数实例写进 run 行的两个标记字段(`backfillPlanId` / `backfillNode`)的**唯一作者**。
// 原来只有工作流 SQL 节点(execute.ts)与同步任务补数(sync-task.ts)各写一遍;离线作业节点补数要让 ETL / EMR 两个运行核心
// 也带上同形的字段(补数页据它们把实例对回计划与节点),再各写一遍就是第四处。纯函数、零依赖。
export interface BackfillRunRef {
  planId: string;
  nodeId?: string;
}

/** 有补数引用才加键(手动 / 定时运行的 run 行与改动前同形:一个键都不多)。 */
export function backfillRunExtra(b?: BackfillRunRef | null): Record<string, unknown> {
  if (!b || !b.planId) return {};
  return { backfillPlanId: b.planId, ...(b.nodeId ? { backfillNode: b.nodeId } : {}) };
}
