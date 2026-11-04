// 治理目录「同步列信息」(sync-redshift-schema)的运行记录(唯一作者)。
//
// 【缺陷原形(2026-10-13 temp-account,s38 复跑 71d)】POST /api/governance/sync-redshift-schema 是同步长调用:
//   Redshift 列回填 + 每个 S3 Tables 表桶(平台表桶 + 已登记外部桶)逐命名空间 Athena 列回填串行跑,
//   ALB 空闲超时 60s ⇒ 这一次超了回 **504**,而工作在后台做完了(治理目录里已有那张表)⇒ 用户按一次看到「同步失败」。
// 【修法】这里自带一套「最多等 45s,没做完 202 带 runId,页面轮询 GET」的治理专用协议。
// 专用协议退役:等待 / 转后台 / 并发互斥全部交给长操作统一框架(kind `governance-schema-sync`,
//   租约 `governance:schema-sync`)—— 本文件只剩**运行记录**这一件事:
//   · 运行记录仍落 bgp-settings(pk system / sk governance#schema-sync):**跨 ECS task 可见**,GET 读「最近一次同步」不变;
//   · `runSchemaSyncRecorded`:落 running → 跑 work → 落终态,把终态记录原样回给执行体;
//   · running 超过 SCHEMA_SYNC_STALE_MS 还没结束 ⇒ 读侧判 failed(执行它的实例可能已重启),如实说、不猜。
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { SETTINGS_PK } from "@/lib/settings/model-store";

export const SCHEMA_SYNC_SK = "governance#schema-sync";
/** running 超过这么久没结束 ⇒ 视为失败(执行它的实例可能已重启)。 */
export const SCHEMA_SYNC_STALE_MS = 15 * 60_000;

export interface SchemaSyncResult {
  tables: number;
  columns: number;
  redshift: { tables: number; columns: number };
  s3tables: { tables: number; columns: number };
}

export interface SchemaSyncRun {
  runId: string;
  state: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  startedBy: string;
  result?: SchemaSyncResult;
  error?: string;
  /** failed 且是「跑太久没结束」判出来的,不是工作本身报错 */
  stale?: boolean;
}

/** 成功文案(路由 200 / GET succeeded 同一句;Next 路由文件只能导出 handler,所以放这里)。 */
export function schemaSyncMessage(r: SchemaSyncResult): string {
  return `已回填 ${r.tables} 张表、${r.columns} 个字段到数据目录（Redshift ${r.redshift.tables} 表 / S3 Tables ${r.s3tables.tables} 表）；列级血缘正在后台重推（幂等，稍后自动补齐）`;
}

function newRunId(now: Date): string {
  return `sr_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function readRaw(): Promise<SchemaSyncRun | null> {
  const r = await docClient.send(new GetCommand({ TableName: TABLES.SETTINGS, Key: { pk: SETTINGS_PK, sk: SCHEMA_SYNC_SK } }));
  const it = r.Item as (SchemaSyncRun & { pk: string; sk: string }) | undefined;
  if (!it) return null;
  const { pk: _pk, sk: _sk, ...run } = it;
  return run as SchemaSyncRun;
}

async function writeRun(run: SchemaSyncRun, condition?: { expr: string; names?: Record<string, string>; values?: Record<string, unknown> }): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: TABLES.SETTINGS,
    Item: { pk: SETTINGS_PK, sk: SCHEMA_SYNC_SK, ...run },
    ...(condition ? {
      ConditionExpression: condition.expr,
      ...(condition.names ? { ExpressionAttributeNames: condition.names } : {}),
      ...(condition.values ? { ExpressionAttributeValues: condition.values } : {}),
    } : {}),
  }));
}

export function isStaleRun(run: SchemaSyncRun, now: Date): boolean {
  return run.state === "running" && now.getTime() - new Date(run.startedAt).getTime() > SCHEMA_SYNC_STALE_MS;
}

function staleFailure(run: SchemaSyncRun, now: Date): SchemaSyncRun {
  return {
    ...run, state: "failed", finishedAt: now.toISOString(), stale: true,
    error: `同步从 ${run.startedAt} 起超过 ${Math.round(SCHEMA_SYNC_STALE_MS / 60_000)} 分钟没有结束(执行它的实例可能已重启),请重新同步`,
  };
}

/** 读最近一次运行;running 过期 ⇒ 落成 failed(stale)再返回。没有记录 ⇒ null。 */
export async function readSchemaSyncRun(now: Date = new Date()): Promise<SchemaSyncRun | null> {
  const run = await readRaw();
  if (!run) return null;
  if (!isStaleRun(run, now)) return run;
  const failed = staleFailure(run, now);
  try { await writeRun(failed); } catch { /* 读侧最佳努力:落不下去也如实返回 failed */ }
  return failed;
}

export interface RunRecordedOptions {
  work: () => Promise<SchemaSyncResult>;
  startedBy: string;
  now?: () => Date;
}

/**
 * 记一次同步:落 running → 跑 work → 落终态(succeeded 带结果 / failed 带原话),把终态记录原样回给调用方(长操作执行体)。
 * 🔴 不再有「等多久再回」的分叉,也不再并入别人的运行 —— 同一时刻只会有一次(租约 `governance:schema-sync` 在 submitLongOp 里占住);
 *    这里的条件写只防「上一版实例还在跑」这一种残留:running 未过期 ⇒ 抛,让路由如实回 500「同步失败: 已有一次同步正在进行」。
 */
export async function runSchemaSyncRecorded(opts: RunRecordedOptions): Promise<SchemaSyncRun> {
  const now = opts.now ?? (() => new Date());
  const t0 = now();
  const run: SchemaSyncRun = { runId: newRunId(t0), state: "running", startedAt: t0.toISOString(), startedBy: opts.startedBy };
  try {
    await writeRun(run, {
      expr: "attribute_not_exists(sk) OR #st <> :running OR startedAt < :staleBefore",
      names: { "#st": "state" },
      values: { ":running": "running", ":staleBefore": new Date(t0.getTime() - SCHEMA_SYNC_STALE_MS).toISOString() },
    });
  } catch (e: unknown) {
    const err = (e ?? {}) as { name?: string };
    if (err.name !== "ConditionalCheckFailedException") throw e;
    throw new Error("已有一次同步正在进行(由别的实例执行),请等它结束后再同步");
  }
  let fin: SchemaSyncRun;
  try {
    const result = await opts.work();
    fin = { ...run, state: "succeeded", finishedAt: now().toISOString(), result };
  } catch (e: unknown) {
    fin = { ...run, state: "failed", finishedAt: now().toISOString(), error: String((e as Error)?.message || e).slice(0, 500) };
  }
  try { await writeRun(fin); } catch (e) { console.error(`[schema-sync] 运行记录 ${run.runId} 落终态失败:${String((e as Error)?.message || e)}`); }
  return fin;
}
