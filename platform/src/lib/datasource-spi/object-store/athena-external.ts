// S3 源的分析通道:Athena 外部表直查。
//
// 【为什么独立】现有 Athena 能力(lib/genbi/athena.ts)全指向 AWS 托管的联邦目录
// s3tablescatalog(Iceberg / S3 Tables),没有「对任意用户 S3 桶建外部表直查」的路径。
// S3 数据源(object-store 范式)要的正是后者:CREATE EXTERNAL TABLE ... LOCATION 's3://bucket/prefix'。
// 复用 lib/athena/client.ts 的执行底座(startQuery/getExecution/getResults,自管 workgroup bgp-athena),
// 只新增「建库 + 建外部表 DDL 生成 + 轮询」这层。查询数据仍走 lib/genbi/athena.ts:runSelectAthena。
//
// 【落点】外部表建在默认 catalog(AwsDataCatalog / Glue Data Catalog)下一个专用 database
// (bgp_s3_ext),与托管 s3tablescatalog 物理隔离,不污染 S3 Tables 命名空间。
// 🔴 建在**哪个区**的目录由调用方传进来的 AthenaPlace 决定(落点必填,类型上没有缺省)——
//   原来三条 DDL 都 startQuery(sql, { database }) 不带落点、getExecution(id) 不带区 ⇒ 第二区的 S3 源建出来的表一律落主控区目录
//   (主控区 Athena 跨区读桶),而执行体明明已记了这条源所在区。home 的 place 与原行为逐字节等价(同一工作组 / 同一客户端)。
//
// 【DDL 不过只读守卫】CREATE DATABASE / CREATE EXTERNAL TABLE 是平台受控生成(非用户任意输入),
// 直接 startQuery 执行;sql-guard 只拦"用户查询"路径(runSelectAthena)。

import { startQuery, getExecution, type AthenaPlace } from "@/lib/athena/client";
// 等 Athena 终态的唯一原语(本文件只能在长操作 datasource-s3-external 的执行上下文里被调)
import { awaitTerminal, LongOpWaitBudgetExceeded } from "@/lib/long-ops/await-terminal";
import type { SourceColumn } from "../types";

// 外部表统一落到这个专用 Glue database(与 s3tablescatalog 托管命名空间隔离)。
export const S3_EXTERNAL_DB = process.env.S3_EXTERNAL_DB || "bgp_s3_ext";

const POLL_ATTEMPTS = 60;
const POLL_INTERVAL_MS = 2000;

// Athena/Hive 合法标识符:字母数字下划线;非法字符→下划线,防 DDL 注入 + 建表失败。
export function sanitizeIdent(s: string): string {
  return (s || "").replace(/[^a-zA-Z0-9_]/g, "_").replace(/^(\d)/, "_$1").slice(0, 255) || "t";
}

// SourceColumn 类型 → Athena(Hive/Trino)列类型。introspect 推断的是 string/bigint/double/…(见 s3.ts guessCsvType);
// 兜底 string(Athena 里是 string 类型)。未知一律 string 安全(不丢数,查询侧再 CAST)。
function toAthenaType(t?: string): string {
  const x = (t || "").toLowerCase();
  if (x === "bigint" || x === "int" || x === "integer" || x === "number") return "bigint";
  if (x === "double" || x === "float" || x === "decimal") return "double";
  if (x === "boolean" || x === "bool") return "boolean";
  if (x === "timestamp" || x === "datetime") return "timestamp";
  if (x === "date") return "date";
  return "string";
}

export interface ExternalTableSpec {
  table: string; // 逻辑表名(会被 sanitize)
  location: string; // s3://bucket/prefix/(必须以 / 结尾,指向"目录"而非单文件)
  format: string; // csv | parquet | json | auto
  hasHeader?: boolean; // CSV 首行是否表头(skip.header.line.count=1)
  columns: SourceColumn[]; // 列(introspect 推断;为空则 DDL 无法建表——调用方要保证 CSV 有列或用户提供)
}

// 生成 CREATE EXTERNAL TABLE DDL(纯函数,可单测)。按 format 选 SerDe / STORED AS。
//  · csv     → TEXTFILE + LazySimpleSerDe,FIELDS TERMINATED BY ','(有表头则 skip.header.line.count=1)
//  · parquet → STORED AS PARQUET(列由用户/Glue 提供;Athena 会用 Parquet 内嵌 schema)
//  · json    → org.openx.data.jsonserde.JsonSerDe(Athena 内置)
export function buildExternalTableDDL(db: string, spec: ExternalTableSpec): string {
  const table = sanitizeIdent(spec.table);
  const fqTable = `${db}.${table}`;
  const cols = spec.columns.map((c) => `\`${sanitizeIdent(c.name)}\` ${toAthenaType(c.type)}`).join(",\n  ");
  const fmt = (spec.format || "auto").toLowerCase();
  // location 必须指向目录(以 / 结尾);Athena 不接受单文件 location。
  const loc = spec.location.endsWith("/") ? spec.location : spec.location + "/";

  if (fmt === "parquet") {
    // Parquet 自带 schema;仍需列定义(Athena 要求),类型统一按推断给。
    return `CREATE EXTERNAL TABLE IF NOT EXISTS ${fqTable} (\n  ${cols}\n)\nSTORED AS PARQUET\nLOCATION '${loc}'\nTBLPROPERTIES ('classification'='parquet')`;
  }
  if (fmt === "json") {
    return `CREATE EXTERNAL TABLE IF NOT EXISTS ${fqTable} (\n  ${cols}\n)\nROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'\nLOCATION '${loc}'\nTBLPROPERTIES ('classification'='json')`;
  }
  // csv / auto(默认按 CSV 文本处理):LazySimpleSerDe + 逗号分隔。
  const skipHeader = spec.hasHeader ? `,\n  'skip.header.line.count'='1'` : "";
  return `CREATE EXTERNAL TABLE IF NOT EXISTS ${fqTable} (\n  ${cols}\n)\nROW FORMAT DELIMITED FIELDS TERMINATED BY ','\nLINES TERMINATED BY '\\n'\nSTORED AS TEXTFILE\nLOCATION '${loc}'\nTBLPROPERTIES ('classification'='csv'${skipHeader})`;
}

/** 等一次 Athena 执行到终态(60 × 2s 预算与「<label> 失败 / 超时」文案逐字保留;原语 = awaitTerminal)。
 *  🔴 状态必须打到发起它的那个区(QueryExecutionId 只在它自己的 region 存在)—— 拿主控区客户端查别区的 id 只会「永远查不到」。 */
async function awaitAthena(id: string, label: string, region: string): Promise<void> {
  try {
    await awaitTerminal<void>({
      what: label,
      maxPolls: POLL_ATTEMPTS,
      initialMs: POLL_INTERVAL_MS,
      backoff: 1,
      probe: async () => {
        const ex = await getExecution(id, region);
        if (ex.state === "SUCCEEDED") return { done: true, value: undefined };
        if (ex.state === "FAILED" || ex.state === "CANCELLED") throw new Error(`${label} 失败: ${ex.error || ex.state}`);
        return { done: false, state: ex.state };
      },
    });
  } catch (e) {
    if (e instanceof LongOpWaitBudgetExceeded) throw new Error(`${label} 超时`);
    throw e;
  }
}

// 跑一条 DDL(建库/建表),在给定落点等到终态。DDL 不过只读守卫(平台受控生成)。
async function runDdl(sql: string, label: string, place: AthenaPlace): Promise<void> {
  const id = await startQuery(sql, { database: S3_EXTERNAL_DB }, place);
  await awaitAthena(id, label, place.region);
}

// 建外部表(幂等):先建专用 database,再 DROP+CREATE 表(重建以吸收 schema 变化)。
//  返回 fully-qualified 表名(db.table)与真落点,供随后 SELECT。columns 为空则拒绝(无法建表)。
//  🔴 place 必填:外部表建在这个落点的 Athena 工作组 / Glue 目录里 —— 调用方按数据源行上的章解析(datasourceOwnerTarget →
//     resolveAthenaPlace),这里不解析、不猜,也不会因为「没给」就落到主控区。
export async function ensureExternalTable(
  spec: ExternalTableSpec,
  place: AthenaPlace
): Promise<{ database: string; table: string; ddl: string; targetId: string; region: string }> {
  if (!place || !place.targetId || !place.region || !place.workgroup) {
    throw new Error("建外部表缺落点(place)—— 已拒绝执行,不会落到主控区目录;调用方须按数据源所在区解析 AthenaPlace");
  }
  if (!spec.columns || spec.columns.length === 0) {
    throw new Error("无法建外部表:未推断出任何列(CSV 需有表头,或 Parquet/JSON 需提供列定义)");
  }
  const table = sanitizeIdent(spec.table);
  // 1) 建专用 database(建外部表落点,与 s3tablescatalog 隔离)。CREATE DATABASE 不需 database context。
  const dbId = await startQuery(`CREATE DATABASE IF NOT EXISTS ${S3_EXTERNAL_DB}`, undefined, place);
  await awaitAthena(dbId, "建 database", place.region);
  // 2) 重建表(DROP 再 CREATE,吸收 schema/location 变化;外部表 DROP 只删元数据不删 S3 数据,安全)。
  await runDdl(`DROP TABLE IF EXISTS ${S3_EXTERNAL_DB}.${table}`, "DROP TABLE", place);
  const ddl = buildExternalTableDDL(S3_EXTERNAL_DB, spec);
  await runDdl(ddl, "CREATE EXTERNAL TABLE", place);
  return { database: S3_EXTERNAL_DB, table, ddl, targetId: place.targetId, region: place.region };
}
