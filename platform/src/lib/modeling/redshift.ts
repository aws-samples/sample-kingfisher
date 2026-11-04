// 码表落地 Redshift 的安全 SQL 工具 + 执行。
//
// 安全(防注入):schema/表/列标识符严格白名单校验后双引号包裹;枚举值(value/label)
// 单引号转义。无自由用户 SQL。执行复用指标中台同款(统一 admin 身份 / Redshift Data API / 轮询)。

import {
  ExecuteStatementCommand,
  DescribeStatementCommand,
  GetStatementResultCommand,
} from "@aws-sdk/client-redshift-data";
import type { CodeValue, ModelColumn } from "./types";
// 等待终态的唯一原语(请求路径没有等待上下文 ⇒ 抛;本函数只能在长操作 modeling-metric-compute 里被调)
import { awaitTerminal, LongOpWaitBudgetExceeded } from "@/lib/long-ops/await-terminal";
// 码表物理落点的唯一作者(SPEC §3.9d.3)
import { codeTableLandingFqn } from "./landing-fqn";

const str = (v: unknown) => (v == null ? "" : String(v)).trim();

// 原来这里有一个模块级 home 客户端(理由值「建模 DDL 缺写入通道」)
// + `execStatements` / `landCodeTable` / `applyModelTableDDL` / `execScalar` 四个执行函数。勘定实测:四个函数
// **零生产调用方**(落地早已改走 `landing.ts` 的逐 target 通道,指标计算走 `execScalarAt`),那个 home-only
// 理由也随后交付失效 ⇒ 整块删除,理由值退役(`HomeOnlyReason` 只减不增)。
// 本文件只剩**纯 SQL 生成** + 一个按区只读查询。

// 标识符白名单(与 lib/metrics/service.ts 同款):字母/下划线起头,后续字母数字下划线。
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function safeIdent(name: string): string {
  if (!name || !IDENT_RE.test(name)) throw new Error(`非法标识符: ${JSON.stringify(name)}`);
  return `"${name}"`;
}
// 单引号字符串字面量转义(标准 SQL:单引号翻倍)。仅用于码表枚举值,无自由 SQL。
export function sqlString(v: string): string {
  return `'${String(v ?? "").replace(/'/g, "''")}'`;
}

// 码表落地表名:**派生自** `codeTableLandingFqn`(唯一作者;过渡期 = dim_code_<code>)。
// code 已经业务层白名单校验,这里再过一遍 safeIdent。
export function codeTableName(code: string): string {
  return codeTableLandingFqn({ code }).table;
}

// 🔴 码表落地拆成**两层**(50 SPEC §3.9a §4.6 / §3.9d):① 结构(建表)② 数据(清空 + 灌数)。
//    home 仍是两层顺序拼起来(`buildLandStatements`,逐字节不变);非 home 第一层走 admin 模板
//    `land-code-table`(它 brand 的正是 `buildCodeTableCreateStatement` 的产物 ⇒ 列定义**只有这一个作者**),
//    第二层由窄权 shared_writer 执行。

/** 码表建表语句(结构层)。home 落地与 admin 模板 `land-code-table` 共用 —— 列定义不许各写一遍。 */
export function buildCodeTableCreateStatement(code: string, schema = "public"): string {
  const qualified = `${safeIdent(schema)}.${safeIdent(codeTableName(code))}`; // code 经白名单校验,故表名安全
  return `CREATE TABLE IF NOT EXISTS ${qualified} ("value" VARCHAR(64) NOT NULL, "label" VARCHAR(256), "seq" INTEGER)`;
}

/** 码表数据层语句(幂等清空 + 插入枚举值)。非 home 只有这一层用窄权身份执行。 */
export function buildCodeTableWriteStatements(code: string, values: CodeValue[], schema = "public"): string[] {
  const qualified = `${safeIdent(schema)}.${safeIdent(codeTableName(code))}`;
  const statements: string[] = [`DELETE FROM ${qualified}`]; // 幂等重灌
  if (values.length > 0) {
    const rows = values
      .map((v, i) => `(${sqlString(v.value)}, ${sqlString(v.label)}, ${Number.isFinite(v.seq as number) ? Number(v.seq) : i})`)
      .join(", ");
    statements.push(`INSERT INTO ${qualified} ("value","label","seq") VALUES ${rows}`);
  }
  return statements;
}

// 纯函数:生成码表落地的 SQL 语句序列(建表 + 幂等清空 + 插入枚举值)。
// 标识符经 safeIdent 白名单+双引号;枚举值经 sqlString 单引号转义;seq 强制数值。无自由 SQL。
// 抽成纯函数便于单测(不触达 Redshift)。🔴 = 结构层 ++ 数据层(两层各一个作者,这里只拼)。
export function buildLandStatements(code: string, values: CodeValue[], schema = "public"): string[] {
  return [buildCodeTableCreateStatement(code, schema), ...buildCodeTableWriteStatements(code, values, schema)];
}

// ─── D3 维度/事实建模 DDL 生成(P1)──────────────────────────────────────────────
//
// 安全核心:数据类型经"严格锚定正则 + 白名单"规范化 —— 基础类型必须命中 DDL_TYPES,
// 括号内参数(长度/精度/标度)强转数值并夹取合法范围。任何自由串(如 "VARCHAR(1);DROP TABLE x")
// 因末尾无法满足 `$` 锚定而被拒。标识符走 safeIdent;注释走 sqlString。整段 DDL 无任何用户自由 SQL。

type TypeParam = "none" | "length" | "decimal";
// Redshift 支持的列类型白名单。key = 用户可填的基础类型(大写);sql = 实际下发的规范类型。
const DDL_TYPES: Record<string, { sql: string; param: TypeParam; defLen?: number; maxLen?: number }> = {
  VARCHAR: { sql: "VARCHAR", param: "length", defLen: 256, maxLen: 65535 },
  TEXT: { sql: "VARCHAR", param: "length", defLen: 65535, maxLen: 65535 }, // Redshift 无 TEXT,映射 VARCHAR
  CHAR: { sql: "CHAR", param: "length", defLen: 1, maxLen: 4096 },
  INTEGER: { sql: "INTEGER", param: "none" },
  INT: { sql: "INTEGER", param: "none" },
  BIGINT: { sql: "BIGINT", param: "none" },
  SMALLINT: { sql: "SMALLINT", param: "none" },
  DECIMAL: { sql: "DECIMAL", param: "decimal" },
  NUMERIC: { sql: "DECIMAL", param: "decimal" },
  REAL: { sql: "REAL", param: "none" },
  FLOAT: { sql: "REAL", param: "none" },
  "DOUBLE PRECISION": { sql: "DOUBLE PRECISION", param: "none" },
  DOUBLE: { sql: "DOUBLE PRECISION", param: "none" },
  BOOLEAN: { sql: "BOOLEAN", param: "none" },
  BOOL: { sql: "BOOLEAN", param: "none" },
  DATE: { sql: "DATE", param: "none" },
  TIMESTAMP: { sql: "TIMESTAMP", param: "none" },
  TIMESTAMPTZ: { sql: "TIMESTAMPTZ", param: "none" },
  SUPER: { sql: "SUPER", param: "none" },
};

// 暴露可选类型清单给前端下拉(去重后的基础类型 key)。
export const DDL_TYPE_OPTIONS = Object.keys(DDL_TYPES);

const clampInt = (v: number, lo: number, hi: number) => Math.min(Math.max(lo, Math.floor(v)), hi);

// 把(可能带括号的)类型串规范化为安全的 Redshift 列类型。显式字段(length/precision/scale)优先于
// 内联括号参数(便于直接吃数据标准里 "DECIMAL(18,2)" 这类完整类型串)。命不中白名单一律抛错。
export function normalizeColumnType(dataType: string, opts: { length?: number; precision?: number; scale?: number } = {}): string {
  const raw = str(dataType).toUpperCase().replace(/\s+/g, " ");
  // 严格锚定:基础类型(字母+空格) + 可选 (n) 或 (p,s)。多余字符 → match 失败 → 抛错(防注入)。
  const m = raw.match(/^([A-Z ]+?)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?$/);
  if (!m) throw new Error(`非法数据类型: ${JSON.stringify(dataType)}`);
  const base = m[1].trim();
  const def = DDL_TYPES[base];
  if (!def) throw new Error(`不支持的数据类型: ${JSON.stringify(dataType)}(仅允许白名单类型)`);
  const inline1 = m[2] != null ? Number(m[2]) : undefined;
  const inline2 = m[3] != null ? Number(m[3]) : undefined;

  if (def.param === "length") {
    let len = Number.isFinite(opts.length as number) ? Number(opts.length) : inline1 ?? def.defLen!;
    if (!Number.isFinite(len) || len <= 0) len = def.defLen!;
    return `${def.sql}(${clampInt(len, 1, def.maxLen!)})`;
  }
  if (def.param === "decimal") {
    let p = Number.isFinite(opts.precision as number) ? Number(opts.precision) : inline1 ?? 18;
    let s = Number.isFinite(opts.scale as number) ? Number(opts.scale) : inline2 ?? 2;
    if (!Number.isFinite(p) || p <= 0) p = 18;
    if (!Number.isFinite(s) || s < 0) s = 0;
    p = clampInt(p, 1, 38); // Redshift DECIMAL 精度上限 38
    s = clampInt(s, 0, p);
    return `${def.sql}(${p},${s})`;
  }
  return def.sql;
}

export interface ModelTableDDLSpec {
  schema: string;
  physicalTable: string;
  columns: ModelColumn[];
}

// 纯函数:生成维度/事实表的 DDL 语句序列(建 schema + 建表 + 列注释)。
// 标识符 safeIdent;类型 normalizeColumnType 白名单;注释 sqlString 转义。无自由 SQL。抽纯函数便于单测。
export function buildCreateTableStatements(spec: ModelTableDDLSpec): string[] {
  const qSchema = safeIdent(spec.schema);
  const qTable = safeIdent(spec.physicalTable);
  const qualified = `${qSchema}.${qTable}`;
  const cols = (spec.columns || []).filter((c) => c && str(c.name));
  if (!cols.length) throw new Error("至少需要一个列");

  const colDefs = cols.map((c) => {
    const qc = safeIdent(c.name);
    const type = normalizeColumnType(c.dataType, { length: c.length, precision: c.precision, scale: c.scale });
    const notNull = c.nullable === false || c.isPrimaryKey ? " NOT NULL" : "";
    return `  ${qc} ${type}${notNull}`;
  });

  // 主键(Redshift 声明性约束,不强制唯一,但作为建模元数据 + 查询优化提示)。
  const pks = cols.filter((c) => c.isPrimaryKey).map((c) => safeIdent(c.name));
  const pkClause = pks.length ? `,\n  PRIMARY KEY (${pks.join(", ")})` : "";

  const statements: string[] = [
    `CREATE SCHEMA IF NOT EXISTS ${qSchema}`,
    `CREATE TABLE IF NOT EXISTS ${qualified} (\n${colDefs.join(",\n")}${pkClause}\n)`,
  ];
  for (const c of cols) {
    const cm = str(c.comment);
    if (cm) statements.push(`COMMENT ON COLUMN ${qualified}.${safeIdent(c.name)} IS ${sqlString(cm)}`);
  }
  return statements;
}

// ─── D4 指标计算:只读执行取首行首列标量值 ───────────────────────────────────────
// 用于指标计算(SELECT <agg> AS value FROM ...)。统一 admin 身份,轮询到 FINISHED 取结果。
// SQL 由 buildMetricSql 安全构造(无自由用户 SQL),这里仅负责执行。
/**
 * **按区跑一条只读标量查询**(指标计算专用)。
 *
 * 🔴 读与写分两条路:建模**落地(DDL/DML)**非 home 走 §3.9a 闭合执行器 + 窄权 shared_writer
 * (`landing.ts`);指标计算是 `SELECT <agg>` 的**只读**标量查询,走的是与问数 / 数仓直查同一条
 * 已交付的读路径(`resolveRedshiftBinding`,带项目凭证)。
 *
 * 用户 2026-09-10:「指标」不能算平台级不分区 —— 它有**计算值**,而那个值就是从某个区的数仓算出来的。
 */
// projectId 必填:非主控区凭证按项目取(§3.9b),原来不传 ⇒ 非主控区恒 500
//   「必须带 projectId」(段 wp31 坐实:建模指标在非主控区从来没算成过)
export async function execScalarAt(sql: string, targetId: string, projectId: string): Promise<number> {
  const { resolveRedshiftBinding } = await import("@/lib/exec-env/data-plane-target");
  const { redshiftDataClientFor } = await import("@/lib/exec-env/target-clients");
  const b = await resolveRedshiftBinding({ targetId, projectId });
  const client = redshiftDataClientFor(b.region);
  const { Id } = await client.send(
    new ExecuteStatementCommand({
      Sql: sql,
      WorkgroupName: b.workgroup,
      Database: b.database,
      ...(b.secretArn ? { SecretArn: b.secretArn } : {}),
    })
  );
  // 原 50 × 700ms 的本地 sleep 循环改经 awaitTerminal(预算与文案逐字保留;无等待上下文 ⇒ 抛 LongOpContextMissing)
  try {
    await awaitTerminal<void>({
      what: `Redshift 查询(${b.region} / ${b.workgroup})`,
      maxPolls: 50,
      initialMs: 700,
      backoff: 1,
      probe: async () => {
        const desc = await client.send(new DescribeStatementCommand({ Id }));
        if (desc.Status === "FINISHED") return { done: true, value: undefined };
        if (desc.Status === "FAILED" || desc.Status === "ABORTED") throw new Error(desc.Error || `查询${desc.Status}`);
        return { done: false, state: String(desc.Status ?? "") };
      },
    });
  } catch (e) {
    if (e instanceof LongOpWaitBudgetExceeded) throw new Error(`Redshift 查询超时(${b.region} / ${b.workgroup})`);
    throw e;
  }
  const res = await client.send(new GetStatementResultCommand({ Id }));
  const cell = res.Records?.[0]?.[0];
  if (!cell || cell.isNull) return 0;
  if (cell.longValue !== undefined) return Number(cell.longValue);
  if (cell.doubleValue !== undefined) return Number(cell.doubleValue);
  if (cell.stringValue !== undefined) return Number(cell.stringValue) || 0;
  return 0;
}
