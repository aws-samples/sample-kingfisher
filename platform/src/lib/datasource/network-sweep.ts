// 序 61 B-133 —— 数据源外部网络对象的**定时巡检**(推进泵每 10 分钟一轮,只在持 leader 租约的副本上;与 sweepAutoSupply 同一 tick)。
//
// 【为什么使用时刻的三处接缝还不够】启动核心(`lib/sync/start-run.ts`)/ 发现作业(`glue-reach.ts`)/ 扇出(`scheduler/dependency.ts`)
//   只覆盖经本进程的路径;**定时同步**由 MWAA Serverless 的 Python 运行时直接 `glue.start_job_run`(`lib/workflow/node-exec-py.ts`),
//   不经 TS ⇒ 对象被平台外删除后第一个刻度仍会失败一次(运行行由 run-error 翻成中文、源行标 broken,下一刻度前自愈)。
//   巡检让漂移在「没人用之前」就被发现并自愈,把那一次失败也省掉;同时顺手给存量平台组补 `bgp:managed` 标签。
// 【读多少】每条 JDBC 源 3 个只读调用(安全组 / 子网 / Glue 连接),N 条源每 10 分钟 3N 次 —— N 到几百也远低于任何限流;
//   有界并发 4;一条源失败只记进 errors,不影响别的源。
// 【写什么】只有 reconcileDatasourceNetwork 自己的写(重建 / 接回 / 源行 / 审计 / 告警);本模块零直接写。
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { getProvider, isDataSourceType } from "@/lib/datasource-spi/registry";
import { reconcileDatasourceNetwork, type ReconcileDs } from "@/lib/datasource/network-reconcile";
import { sanitizeAwsErrorMessage } from "@/lib/exec-env/deploy-control";
import { logger } from "@/lib/observability/logger";

export interface NetworkSweepSummary {
  /** 看过的 JDBC 源(有 Glue 连接 + 网络配置) */
  scanned: number;
  intact: number;
  healed: Array<{ datasourceId: string; name: string; healed: string[]; healCount: number }>;
  broken: Array<{ datasourceId: string; name: string; object: string; objectId?: string; userOwned: boolean }>;
  unverifiable: number;
  errors: Array<{ datasourceId: string; error: string }>;
}

export const NETWORK_SWEEP_VIA = "sweep";
const SWEEP_CONCURRENCY = 4;
const MAX_PAGES = 200;

type DsRow = ReconcileDs & { name?: string };

/** 该源是否在巡检范围:JDBC 范式 + 有 Glue 连接 + 有网络配置(与 reconcileDatasourceNetwork 的跳过条件同一口径)。 */
export function isSweepableDatasource(row: unknown): row is DsRow {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  const nc = r.networkConfig as { subnetId?: unknown } | undefined;
  return (
    typeof r.datasourceId === "string" && !!r.datasourceId &&
    typeof r.glueConnectionName === "string" && !!r.glueConnectionName &&
    !!nc && typeof nc.subnetId === "string" && !!nc.subnetId &&
    isDataSourceType(r.type) && getProvider(r.type).capabilities.paradigm === "jdbc"
  );
}

async function scanSweepableDatasources(): Promise<DsRow[]> {
  const out: DsRow[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = (await docClient.send(
      new ScanCommand({ TableName: TABLES.DATASOURCES, ...(startKey ? { ExclusiveStartKey: startKey } : {}) })
    )) as { Items?: unknown[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of r.Items ?? []) if (isSweepableDatasource(item)) out.push(item);
    startKey = r.LastEvaluatedKey;
    if (!startKey) return out;
  }
  throw new Error(`bgp-datasources 分页超过 ${MAX_PAGES} 页 —— 数据形态异常,本轮巡检放弃`);
}

/**
 * 巡检一轮:逐条 JDBC 源 reconcile(via=sweep)。调用方(泵 sweep 路由)把结果进响应;有自愈 / 读写错误时写一条审计。
 * 🔴 读不到源表 ⇒ 抛(调用方记 errors,不当「零漂移」)。
 */
export async function sweepDatasourceNetwork(): Promise<NetworkSweepSummary> {
  const rows = await scanSweepableDatasources();
  const out: NetworkSweepSummary = { scanned: rows.length, intact: 0, healed: [], broken: [], unverifiable: 0, errors: [] };
  let cursor = 0;
  const worker = async () => {
    while (cursor < rows.length) {
      const ds = rows[cursor++];
      try {
        const r = await reconcileDatasourceNetwork(ds, { via: NETWORK_SWEEP_VIA });
        if (r.kind === "intact") out.intact++;
        else if (r.kind === "unverifiable") out.unverifiable++;
        else if (r.kind === "healed") out.healed.push({ datasourceId: ds.datasourceId, name: ds.name ?? ds.datasourceId, healed: r.healed.map((h) => `${h.object}${h.to ? ` → ${h.to}` : ""}`), healCount: r.healCount });
        else out.broken.push({ datasourceId: ds.datasourceId, name: ds.name ?? ds.datasourceId, object: r.issue.object, objectId: r.issue.objectId, userOwned: r.issue.userOwned });
      } catch (e) {
        const error = sanitizeAwsErrorMessage(String((e as Error)?.message ?? e)).slice(0, 300);
        out.errors.push({ datasourceId: ds.datasourceId, error });
        logger.warn("datasource.network.sweep.error", { datasourceId: ds.datasourceId, error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, rows.length) }, worker));
  if (out.healed.length || out.broken.length || out.errors.length) {
    logger.warn("datasource.network.sweep", { scanned: out.scanned, healed: out.healed.length, broken: out.broken.length, unverifiable: out.unverifiable, errors: out.errors.length });
  }
  return out;
}
