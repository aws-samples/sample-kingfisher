// 模块 35 P1 — D4 指标体系安全 SQL 构造(纯函数,便于单测,不触达 Redshift)。
//
// 安全核心(零注入面):
//  - 聚合:agg 走白名单关键字;measureColumn/列标识符走 safeIdent;
//  - 表名:quoteTable(取最后两段 schema.table,各 safeIdent);
//  - 修饰词:column safeIdent;op 白名单;value 经 sqlString 单引号转义(in → 每项转义);
//  - 时间窗:枚举映射为固定谓词(DATEADD/DATE_TRUNC/CURRENT_DATE),timeColumn safeIdent。
// 无任何用户自由 SQL 片段。

import { safeIdent, sqlString } from "./redshift";
import type { MetricAgg, ModifierOp, TimeWindow, MetricModifier } from "./types";

const AGGS: MetricAgg[] = ["count", "count_distinct", "sum", "avg", "min", "max"];
const OPS: ModifierOp[] = ["=", "!=", ">", ">=", "<", "<=", "in"];
const TIME_WINDOWS: TimeWindow[] = ["all", "today", "7d", "30d", "90d", "mtd", "ytd"];

export function isAgg(v: unknown): v is MetricAgg {
  return typeof v === "string" && (AGGS as string[]).includes(v);
}
export function isOp(v: unknown): v is ModifierOp {
  return typeof v === "string" && (OPS as string[]).includes(v);
}
export function isTimeWindow(v: unknown): v is TimeWindow {
  return typeof v === "string" && (TIME_WINDOWS as string[]).includes(v);
}

// 取 FQN 最后两段为 schema.table,各过 safeIdent 白名单(同模块20 quoteTable)。
export function quoteTable(fqn: string): string {
  const parts = (fqn || "").split(".").filter(Boolean);
  if (parts.length < 2) throw new Error(`无法解析表名: ${JSON.stringify(fqn)}`);
  return `${safeIdent(parts[parts.length - 2])}.${safeIdent(parts[parts.length - 1])}`;
}

// 聚合表达式。count→COUNT(*);其余需度量列(safeIdent)。
export function aggExpr(agg: MetricAgg, measureColumn?: string): string {
  if (!isAgg(agg)) throw new Error(`非法聚合类型: ${JSON.stringify(agg)}`);
  if (agg === "count") return "COUNT(*)";
  if (!measureColumn) throw new Error("该聚合需要度量列");
  const col = safeIdent(measureColumn);
  if (agg === "count_distinct") return `COUNT(DISTINCT ${col})`;
  return `${agg.toUpperCase()}(${col})`;
}

// 单个修饰词 → 安全谓词。column safeIdent;op 白名单;value sqlString 转义。
export function modifierPredicate(m: MetricModifier): string {
  const col = safeIdent(m.column);
  if (!isOp(m.op)) throw new Error(`非法运算符: ${JSON.stringify(m.op)}`);
  if (m.op === "in") {
    const arr = Array.isArray(m.value) ? m.value : [m.value];
    const vals = arr.map((v) => sqlString(String(v))).join(", ");
    if (!vals) throw new Error("in 修饰词需要至少一个值");
    return `${col} IN (${vals})`;
  }
  const val = Array.isArray(m.value) ? m.value[0] : m.value;
  return `${col} ${m.op} ${sqlString(String(val ?? ""))}`;
}

// 时间窗枚举 → 安全谓词(timeColumn safeIdent)。all/无时间列 → 空(无过滤)。
export function timeWindowPredicate(tw: TimeWindow | undefined, timeColumn?: string): string {
  if (!tw || tw === "all" || !timeColumn) return "";
  if (!isTimeWindow(tw)) throw new Error(`非法时间周期: ${JSON.stringify(tw)}`);
  const col = safeIdent(timeColumn);
  switch (tw) {
    case "today":
      return `${col}::date = CURRENT_DATE`;
    case "7d":
      return `${col} >= DATEADD(day, -7, CURRENT_DATE)`;
    case "30d":
      return `${col} >= DATEADD(day, -30, CURRENT_DATE)`;
    case "90d":
      return `${col} >= DATEADD(day, -90, CURRENT_DATE)`;
    case "mtd":
      return `${col} >= DATE_TRUNC('month', CURRENT_DATE)`;
    case "ytd":
      return `${col} >= DATE_TRUNC('year', CURRENT_DATE)`;
    default:
      return "";
  }
}

export interface MetricQuerySpec {
  fqn: string;
  agg: MetricAgg;
  measureColumn?: string;
  timeColumn?: string;
  timeWindow?: TimeWindow;
  modifiers?: MetricModifier[];
}

// 构造完整的指标计算 SQL(只读 SELECT 聚合 + 可选 WHERE)。纯函数,便于单测。
export function buildMetricSql(spec: MetricQuerySpec): string {
  const tbl = quoteTable(spec.fqn);
  const expr = aggExpr(spec.agg, spec.measureColumn);
  const preds: string[] = [];
  for (const m of spec.modifiers || []) {
    if (!m || !m.column) continue;
    preds.push(modifierPredicate(m));
  }
  const tw = timeWindowPredicate(spec.timeWindow, spec.timeColumn);
  if (tw) preds.push(tw);
  const where = preds.length ? ` WHERE ${preds.join(" AND ")}` : "";
  return `SELECT ${expr} AS value FROM ${tbl}${where}`;
}
