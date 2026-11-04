// 模块 24 — Athena 执行封装。
// StartQueryExecution → 轮询 GetQueryExecution → GetQueryResults，匹配平台既有 /api/redshift/* 风格。
// 统一走自管 workgroup `bgp-athena`（结果落平台数据湖桶，强制 WG 配置 + SSE_S3）。

// @kf-batch 50-WP31-place-first-class —— 观测模式的落点决策记账(只记录;必须在第一个 await 之前调,见 place/context.ts)
// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { homeRegion } from "@/lib/place/home-region";
import { notePlaceDecision } from "@/lib/place/context";
// @kf-batch 43-page-sweep(B-91)—— 打到联邦目录的查询先确保目录在(区级资源,按落点区取 Glue 客户端)
import { glueClientFor } from "@/lib/exec-env/target-clients";
import { ensureS3TablesFederatedCatalog, touchesS3TablesCatalog } from "@/lib/aws/s3tables-catalog";
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StopQueryExecutionCommand,
} from "@aws-sdk/client-athena";

const region = homeRegion();
const client = sdkClient("data-plane", AthenaClient, { region });

export const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP || "bgp-athena";
// 仅当 workgroup 未强制结果位置时才需要；bgp-athena 已 EnforceWorkGroupConfiguration=true。
export const ATHENA_OUTPUT_LOCATION = process.env.ATHENA_OUTPUT_LOCATION || "";

// @kf-batch 50-WP4ter-coverage —— 工单 SC-4:数据湖查询按区。
// ── 为什么不是「换个 region 建客户端」就完了 ────────────────────────────────────
// 与数仓直查(`lib/redshift/direct-query.ts`)一模一样的道理:一个 Athena 查询要**四样**东西
// 同时对上 —— region、workgroup、结果落点、以及查的那个 S3 Tables 目录。只换 region 而 workgroup
// 还是主控区那个 ⇒ **不报错**,只是在别的区跑了一条打不到数据的查询(或干脆找不到 workgroup)。
// ⇒ 落点整体解析,要么四样都是那个 target 的,要么当场拒。
// 🔴 home 逐字节等价:home 仍走上面那对 env 值(现网行为不变),非 home 才从描述符资源袋取。
const clients = new Map<string, AthenaClient>();
function clientForRegion(r: string): AthenaClient {
  if (r === region) return client; // home 用同一个实例(逐字节等价)
  let c = clients.get(r);
  if (!c) {
    c = sdkClient("data-plane", AthenaClient, { region: r });
    clients.set(r, c);
  }
  return c;
}

/** 一条 Athena 查询的落点(四样焊在一起)。 */
export interface AthenaPlace {
  targetId: string;
  region: string;
  workgroup: string;
  /** 结果位置;workgroup 已强制时为空串 */
  outputLocation: string;
  home: boolean;
}

/**
 * 解析某个执行范围的 Athena 落点。
 *
 * 🔴 非 home 的 workgroup / 结果桶取自该 target 描述符的**资源袋实名**
 * (`athenaWorkgroup` / `datalakeBucket`,由部署期写入),不由本函数拼名字 ——
 * 拼名字就是命名 SSOT 之外的第二处派生(50 SPEC §6.5)。
 */
// @kf-batch 50-WP31-place-first-class —— 落点必填(原来缺省 = 主控区);空串 / 非法 ⇒ 抛,不变成主控区
export async function resolveAthenaPlace(targetId: string): Promise<AthenaPlace> {
  notePlaceDecision({ targetId, via: "resolveAthenaPlace" });
  const { HOME_TARGET_ID, isHome, assertTargetId } = await import("@/lib/exec-env/target-id");
  const id = assertTargetId(targetId);
  if (isHome(id)) {
    return { targetId: HOME_TARGET_ID, region, workgroup: ATHENA_WORKGROUP, outputLocation: ATHENA_OUTPUT_LOCATION, home: true };
  }
  const { requireReadyTarget } = await import("@/lib/exec-env/registry");
  const t = await requireReadyTarget(id);
  const bag = (t.resources ?? {}) as Record<string, unknown>;
  const wg = typeof bag.athenaWorkgroup === "string" ? bag.athenaWorkgroup : "";
  const lake = typeof bag.datalakeBucket === "string" ? bag.datalakeBucket : "";
  if (!wg) {
    throw new Error(
      `执行环境 ${id} 的资源清单里没有 Athena 工作组(athenaWorkgroup)—— 已拒绝执行,` +
        `不会拿主控区的工作组替它跑(那样查出来的是主控区的数据)`
    );
  }
  return {
    targetId: id,
    region: t.region,
    workgroup: wg,
    // 该区自己的数据湖桶;为空则交给 workgroup 的强制配置
    outputLocation: lake ? `s3://${lake}/athena-results/` : "",
    home: false,
  };
}

export interface AthenaExecutionStatus {
  state: string; // QUEUED | RUNNING | SUCCEEDED | FAILED | CANCELLED
  error?: string;
  dataScannedBytes?: number;
  executionTimeMs?: number;
  outputLocation?: string;
}

export interface AthenaResults {
  columns: string[];
  // 列的引擎类型(与 columns 同序),来自 Athena ResultSetMetadata。供上层按类型(而非猜值)格式化,
  // 避免把电话号/邮编/前导零 ID 误当数字。可选:老消费者忽略即可。
  columnTypes?: string[];
  rows: (string | null)[][];
  nextToken?: string;
}

// 启动查询，返回 QueryExecutionId。query 应已通过只读守卫清洗。
// context 可选：设置联邦目录 + 数据库（如查 information_schema 时定位 S3 Tables 命名空间）。
export async function startQuery(
  query: string,
  context?: { catalog?: string; database?: string },
  // @kf-batch 50-WP4ter-coverage —— 落点(缺省 = 主控区,现网行为逐字节不变)
  place?: AthenaPlace
): Promise<string> {
  const ctx = context && (context.catalog || context.database)
    ? {
        QueryExecutionContext: {
          ...(context.catalog ? { Catalog: context.catalog } : {}),
          ...(context.database ? { Database: context.database } : {}),
        },
      }
    : {};
  const wg = place ? place.workgroup : ATHENA_WORKGROUP;
  const outLoc = place ? place.outputLocation : ATHENA_OUTPUT_LOCATION;
  // @kf-batch 43-page-sweep(B-91)—— 联邦目录 s3tablescatalog 不是 CDK 资源,原来只有「同步任务写 S3 Tables」的启动路径懒创建
  //   ⇒ 全新账号没跑过那样一次同步,直查 / 问数一律 CATALOG_NOT_FOUND(…7698 页面驱动 p43c 坐实)。打到联邦目录的查询
  //   先确保目录在(GetCatalog 一次,幂等;建不成如实上抛成本次查询的错);别的 Athena 查询(S3 外表库等)不碰 Glue。
  if (touchesS3TablesCatalog(query, context)) {
    const r = place ? place.region : region;
    await ensureS3TablesFederatedCatalog(await glueClientFor(r), { region: r, accountId: process.env.AWS_ACCOUNT_ID || "" });
  }
  const out = await clientForRegion(place ? place.region : region).send(
    new StartQueryExecutionCommand({
      QueryString: query,
      WorkGroup: wg,
      ...ctx,
      // WG 已强制结果位置；本地/无 WG 强制时回退到显式 OutputLocation（如配置）。
      ...(outLoc ? { ResultConfiguration: { OutputLocation: outLoc } } : {}),
    })
  );
  if (!out.QueryExecutionId) throw new Error("Athena 未返回 QueryExecutionId");
  return out.QueryExecutionId;
}

// @kf-batch 50-WP4ter-coverage —— 🔴 取状态 / 取结果 / 取消**必须打到发起它的那个区**:
// QueryExecutionId 只在它自己的 region 里存在,拿主控区的客户端去查会得到「不存在」——
// 症状是「查询提交成功、状态永远查不到」,而不是一句明确的报错。⇒ 三个函数都收 region。
export async function getExecution(id: string, atRegion?: string): Promise<AthenaExecutionStatus> {
  const out = await clientForRegion(atRegion || region).send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
  const ex = out.QueryExecution;
  return {
    state: ex?.Status?.State || "UNKNOWN",
    error: ex?.Status?.StateChangeReason,
    dataScannedBytes: ex?.Statistics?.DataScannedInBytes,
    executionTimeMs: ex?.Statistics?.TotalExecutionTimeInMillis,
    outputLocation: ex?.ResultConfiguration?.OutputLocation,
  };
}

// 取结果。Athena 首页第一行为列名表头；首页去表头，后续分页直接是数据行。
export async function getResults(id: string, maxRows = 1000, nextToken?: string, atRegion?: string): Promise<AthenaResults> {
  const out = await clientForRegion(atRegion || region).send(
    new GetQueryResultsCommand({
      QueryExecutionId: id,
      MaxResults: Math.min(maxRows, 1000),
      ...(nextToken ? { NextToken: nextToken } : {}),
    })
  );
  const meta = out.ResultSet?.ResultSetMetadata?.ColumnInfo || [];
  const columns = meta.map((c) => c.Name || "");
  const columnTypes = meta.map((c) => c.Type || ""); // Athena/Trino 引擎类型:bigint/double/varchar/timestamp…
  const rawRows = out.ResultSet?.Rows || [];
  // 仅首页（无 nextToken 入参时）含表头行，去掉。
  const dataRows = !nextToken && rawRows.length > 0 ? rawRows.slice(1) : rawRows;
  const rows = dataRows.map((r) => (r.Data || []).map((cell) => (cell?.VarCharValue ?? null)));
  return { columns, columnTypes, rows, nextToken: out.NextToken };
}

export async function stopQuery(id: string, atRegion?: string): Promise<void> {
  await clientForRegion(atRegion || region).send(new StopQueryExecutionCommand({ QueryExecutionId: id }));
}
