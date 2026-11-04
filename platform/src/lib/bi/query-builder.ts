// 模块 37 v2 — 查询构建器(纯函数,可单测,零副作用)。
// 把"选表 + 勾字段(维度/度量/筛选/排序)"编译成安全只读 SQL,产出喂给 v1 的 sql source。
// 用户不写 SQL。下游 executeBiQuery / maskRows / 只读守卫 / 行封顶 全部原样复用,零改动。
//
// 安全:标识符(表/列)必须来自 introspect 的真实 schema 白名单(由 route 校验后传入);此处再做
// 一层格式校验 + 正确引用。筛选值走值位置字面量转义(单引号包裹),绝不拼进标识符。

import type { BiEngine } from "./types";

export type AggFn = "count" | "count_distinct" | "sum" | "avg" | "min" | "max";
export const AGG_FNS: AggFn[] = ["count", "count_distinct", "sum", "avg", "min", "max"];

export type FilterOp = "=" | "!=" | ">" | "<" | ">=" | "<=";
export const FILTER_OPS: FilterOp[] = ["=", "!=", ">", "<", ">=", "<="];

export interface BuilderMeasure {
  col: string; // count 可为 "*"
  agg: AggFn;
  alias?: string;
}
export interface BuilderFilter {
  col: string;
  op: FilterOp;
  value: string; // 值位置字面量;若含 {{key}} 占位则透传给筛选器注入层(不在此转义)
}
export interface BuilderOrderBy {
  ref: string; // 维度列名 或 度量 alias
  desc: boolean;
}
export interface BuilderSpec {
  engine: BiEngine;
  schema: string; // Redshift schema / Athena namespace
  table: string; // 表名(不含 schema)
  dimensions: string[]; // GROUP BY 维度列
  measures: BuilderMeasure[]; // 聚合度量
  filters?: BuilderFilter[];
  orderBy?: BuilderOrderBy;
  limit?: number;
}

// 合法 SQL 标识符(表/列/schema):字母开头,字母数字下划线,长度 ≤64。防注入的第一道(第二道是 route 的 schema 白名单)。
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function assertIdent(name: string, what: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`非法${what}标识符:${name}`);
  return name;
}

// 表引用(引擎相关):Redshift = "schema"."table";Athena S3Tables = 联邦目录三段式。
function tableRef(engine: BiEngine, schema: string, table: string): string {
  assertIdent(schema, "schema");
  assertIdent(table, "表");
  if (engine === "athena") {
    const catalog = process.env.S3TABLES_CATALOG || "s3tablescatalog";
    const bucket = process.env.S3TABLES_BUCKET || "bgp-table-bucket";
    return `"${catalog}/${bucket}"."${schema}"."${table}"`;
  }
  return `"${schema}"."${table}"`;
}

// 列引用(带双引号防关键字冲突)。
function colRef(col: string): string {
  return `"${assertIdent(col, "列")}"`;
}

// 度量表达式:count(*) / count(distinct x) / sum(x) ...
function measureExpr(m: BuilderMeasure): string {
  if (m.agg === "count" && (m.col === "*" || !m.col)) return "count(*)";
  const c = colRef(m.col);
  if (m.agg === "count_distinct") return `count(distinct ${c})`;
  return `${m.agg}(${c})`;
}

// 度量别名(默认 <agg>_<col>);校验合法标识符。
// 导出:FieldConfigurator 需按同一口径算别名,以便 viz.yFields 与 SQL 生成的列名一致。
export function measureAlias(m: BuilderMeasure, idx: number): string {
  const raw = m.alias || (m.agg === "count" && (m.col === "*" || !m.col) ? "count" : `${m.agg}_${m.col}`);
  const safe = raw.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 63) || `m${idx}`;
  return /^[A-Za-z_]/.test(safe) ? safe : `m_${safe}`;
}

// 值位置字面量:数字直出;否则单引号转义。含 {{key}} 占位的透传(交给筛选器注入层 renderWithFilters 处理)。
function literal(value: string): string {
  const v = String(value);
  if (/\{\{\s*[a-z0-9_]+\s*\}\}/i.test(v)) return v; // 占位符透传
  if (v !== "" && Number.isFinite(Number(v))) return String(Number(v));
  return `'${v.replace(/'/g, "''")}'`;
}

// 编译成安全只读 SQL。
export function buildSql(spec: BuilderSpec): string {
  const from = tableRef(spec.engine, spec.schema, spec.table);

  const dims = (spec.dimensions || []).map(colRef);
  const measures = (spec.measures || []).map((m, i) => `${measureExpr(m)} AS "${measureAlias(m, i)}"`);
  const selectParts = [...dims, ...measures];
  if (selectParts.length === 0) selectParts.push("*"); // 无维度无度量:退化为明细(仍只读)

  let sql = `SELECT ${selectParts.join(", ")}\nFROM ${from}`;

  // WHERE
  const wheres = (spec.filters || [])
    .filter((f) => f && f.col && f.value !== undefined && f.value !== "")
    .map((f) => {
      const op = FILTER_OPS.includes(f.op) ? f.op : "=";
      return `${colRef(f.col)} ${op} ${literal(f.value)}`;
    });
  if (wheres.length) sql += `\nWHERE ${wheres.join(" AND ")}`;

  // GROUP BY(有维度且有聚合度量时)
  const hasAgg = (spec.measures || []).length > 0;
  if (dims.length && hasAgg) sql += `\nGROUP BY ${dims.join(", ")}`;

  // ORDER BY(引用维度列或度量别名;两者都在 select 里,安全)
  if (spec.orderBy && spec.orderBy.ref) {
    const ref = spec.orderBy.ref.replace(/[^A-Za-z0-9_]/g, "");
    if (ref) sql += `\nORDER BY "${ref}" ${spec.orderBy.desc ? "DESC" : "ASC"}`;
  }

  // LIMIT(1..10000,防手滑拉爆;下游 runSelect 还有 maxRows 硬顶)
  if (spec.limit !== undefined) {
    const n = Math.max(1, Math.min(10000, Math.floor(Number(spec.limit) || 0)));
    if (n > 0) sql += `\nLIMIT ${n}`;
  }

  return sql;
}
