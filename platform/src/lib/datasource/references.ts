// 序 59 B-131 —— 「这条数据源还被谁引用」的唯一读点(删源路由 DELETE 用;页面经 409 原话呈现)。
//
// 🔴 读不到 ⇒ 抛,不回空清单:空清单会放行删除,少报的方向恰好是「把在用的源删掉、任务成孤儿」
//   (与 lib/exec-env/delete-impact.ts 同一纪律:翻到底、读不到不当 0)。
// 引用方只有两张表(2026-10-28 全仓核过:编排 / 离线作业 / 直查都不直接引用 datasourceId):
//   · bgp-sync-tasks.datasourceId —— 含 channel = dms 的实时同步任务(同一张表);
//   · bgp-flink-jobs.sourceDatasourceId / sinkDatasourceId —— 实时计算作业的源 / 汇。
// 两表都没有按数据源的 GSI ⇒ Scan + FilterExpression 翻到底(数据源删除是低频动作,Scan 代价可接受)。
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";

export interface DatasourceReference {
  id: string;
  name: string;
  kind: "sync-task" | "flink-job";
  status?: string;
  /** 同步任务的通道(glue / dms / zero-etl);实时计算作业没有 */
  channel?: string;
}

export interface DatasourceReferences {
  syncTasks: DatasourceReference[];
  flinkJobs: DatasourceReference[];
  total: number;
}

const MAX_PAGES = 500;

async function scanAll(table: string, input: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = (await docClient.send(
      new ScanCommand({ TableName: table, ...input, ...(startKey ? { ExclusiveStartKey: startKey } : {}) })
    )) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    out.push(...(r.Items ?? []));
    startKey = r.LastEvaluatedKey;
    if (!startKey) return out;
  }
  throw new Error(`${table} 分页超过 ${MAX_PAGES} 页 —— 数据形态异常,拒绝给出可能不完整的引用清单`);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** 这条数据源的全部引用方;读不到任何一张表 ⇒ 抛(调用方按 500 处理,不放行删除)。 */
export async function listDatasourceReferences(datasourceId: string): Promise<DatasourceReferences> {
  if (!datasourceId) throw new Error("listDatasourceReferences: datasourceId 必填");
  const [syncRows, flinkRows] = await Promise.all([
    scanAll(TABLES.SYNC_TASKS, {
      FilterExpression: "datasourceId = :id",
      ExpressionAttributeValues: { ":id": datasourceId },
    }),
    scanAll(TABLES.FLINK_JOBS, {
      FilterExpression: "sourceDatasourceId = :id OR sinkDatasourceId = :id",
      ExpressionAttributeValues: { ":id": datasourceId },
    }),
  ]);
  const syncTasks: DatasourceReference[] = syncRows.map((r) => ({
    id: str(r.taskId) ?? "",
    name: str(r.name) ?? str(r.taskId) ?? "(未命名)",
    kind: "sync-task" as const,
    ...(str(r.status) ? { status: str(r.status) } : {}),
    ...(str(r.channel) ? { channel: str(r.channel) } : {}),
  }));
  const flinkJobs: DatasourceReference[] = flinkRows.map((r) => ({
    id: str(r.jobId) ?? "",
    name: str(r.name) ?? str(r.jobId) ?? "(未命名)",
    kind: "flink-job" as const,
    ...(str(r.status) ? { status: str(r.status) } : {}),
  }));
  return { syncTasks, flinkJobs, total: syncTasks.length + flinkJobs.length };
}

/** 409 文案(页面 toast 原话):最多列 5 个名字,其余「等 N 个」。 */
export function describeDatasourceReferences(refs: DatasourceReferences): string {
  const names = [
    ...refs.syncTasks.map((r) => `同步任务「${r.name}」`),
    ...refs.flinkJobs.map((r) => `实时计算作业「${r.name}」`),
  ];
  const head = names.slice(0, 5).join("、");
  return names.length > 5 ? `${head} 等 ${names.length} 个` : head;
}
