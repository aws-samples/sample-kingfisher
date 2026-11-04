// 指标中台 / Metrics Store 服务 (v1.11.0)
//
// 指标定义 CRUD + 安全聚合 SQL 生成 + 对 Redshift 计算（统一 admin 身份，复用 v1.6.1）
// 当前值 / 维度分布 / 时间趋势 + 值快照历史。
//
// 安全（防注入）：标识符（schema/表/列）严格白名单校验后双引号包裹；聚合仅用固定关键字；
// 无自由用户 SQL；只读执行。

// 裸客户端 + 自带轮询已收编进 `lib/redshift/direct-query.ts`
import {
  directQueryRaw,
  resolveDirectQueryPlaceSafe,
  type DirectQueryPlace,
  type DirectQueryScope,
  type DirectQueryUnavailable,
} from "@/lib/redshift/direct-query";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
import { PutCommand, QueryCommand, GetCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
// 数仓落点唯一出口(收编兜底字面量)。
import { homeWorkgroup } from "@/lib/redshift/warehouse-location";

const METRIC_PK = "metric";

export type Agg = "count" | "count_distinct" | "sum" | "avg" | "min" | "max";
export type MetricFormat = "number" | "currency" | "percent";
export const AGGS: Agg[] = ["count", "count_distinct", "sum", "avg", "min", "max"];
export const FORMATS: MetricFormat[] = ["number", "currency", "percent"];

export interface Metric {
  metricId: string;
  name: string;
  description?: string;
  fqn: string;
  agg: Agg;
  measureColumn?: string;
  dimensionColumn?: string;
  timeColumn?: string;
  unit?: string;
  format: MetricFormat;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * 🔴 **最近一次计算的值,不分区** —— 只为兼容旧读法留着。
   * region-sensitive 的呈现一律读 `valueByTarget`(与建模指标 `metricValueFor` 同一形状)。
   */
  lastValue?: number;
  lastComputedAt?: string;
  /**
   * **每个执行区一份计算结果**。
   * 计算路径本来就已经按区解析落点(`computeMetric(metricId, scope)`),只有**值的存储**没有区维 ⇒
   * 在 usw2 算一次就把主控区的值覆盖掉,而两个数字看起来都很正常。
   */
  valueByTarget?: Record<string, { value: number; computedAt: string }>;
  lastTargetId?: string;
}

// ─── 安全工具 ────────────────────────────────────────────────────────────────
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function safeIdent(name: string): string {
  if (!name || !IDENT_RE.test(name)) throw new Error(`非法标识符: ${JSON.stringify(name)}`);
  return `"${name}"`;
}
function quoteTable(fqn: string): string {
  const parts = (fqn || "").split(".").filter(Boolean);
  if (parts.length < 2) throw new Error(`无法解析表名: ${fqn}`);
  return `${safeIdent(parts[parts.length - 2])}.${safeIdent(parts[parts.length - 1])}`;
}
function isAgg(v: unknown): v is Agg {
  return typeof v === "string" && (AGGS as string[]).includes(v);
}
function aggExpr(agg: Agg, measureColumn?: string): string {
  if (agg === "count") return "COUNT(*)";
  if (!measureColumn) throw new Error("该聚合需要度量列");
  const col = safeIdent(measureColumn);
  if (agg === "count_distinct") return `COUNT(DISTINCT ${col})`;
  return `${agg.toUpperCase()}(${col})`;
}

// ─── 指标 CRUD ───────────────────────────────────────────────────────────────
export async function listMetrics(): Promise<Metric[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.METRICS,
      KeyConditionExpression: "pk = :p",
      ExpressionAttributeValues: { ":p": METRIC_PK },
    })
  );
  return Items as Metric[];
}

export async function getMetric(metricId: string): Promise<Metric | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.METRICS, Key: { pk: METRIC_PK, metricId } })
  );
  return (Item as Metric) || null;
}

function validateMetricInput(input: any): {
  name: string; fqn: string; agg: Agg; measureColumn?: string; dimensionColumn?: string; timeColumn?: string;
} {
  if (!input?.name || !String(input.name).trim()) throw new Error("缺少指标名称");
  if (!input?.fqn) throw new Error("缺少数据表");
  if (!isAgg(input.agg)) throw new Error("非法聚合类型");
  // build once to surface identifier errors early
  quoteTable(input.fqn);
  const agg = input.agg as Agg;
  const measureColumn = input.measureColumn ? String(input.measureColumn) : undefined;
  if (agg !== "count" && !measureColumn) throw new Error("该聚合需要度量列");
  if (measureColumn) safeIdent(measureColumn);
  if (input.dimensionColumn) safeIdent(String(input.dimensionColumn));
  if (input.timeColumn) safeIdent(String(input.timeColumn));
  aggExpr(agg, measureColumn); // validate combo
  return {
    name: String(input.name).trim(),
    fqn: String(input.fqn),
    agg,
    measureColumn,
    dimensionColumn: input.dimensionColumn ? String(input.dimensionColumn) : undefined,
    timeColumn: input.timeColumn ? String(input.timeColumn) : undefined,
  };
}

export async function createMetric(input: any, actor?: string): Promise<Metric> {
  const v = validateMetricInput(input);
  const now = new Date().toISOString();
  const metric: Metric & { pk: string } = {
    pk: METRIC_PK,
    metricId: ulid(),
    name: v.name,
    ...(input.description ? { description: String(input.description) } : {}),
    fqn: v.fqn,
    agg: v.agg,
    ...(v.measureColumn ? { measureColumn: v.measureColumn } : {}),
    ...(v.dimensionColumn ? { dimensionColumn: v.dimensionColumn } : {}),
    ...(v.timeColumn ? { timeColumn: v.timeColumn } : {}),
    ...(input.unit ? { unit: String(input.unit) } : {}),
    format: (FORMATS as string[]).includes(input.format) ? input.format : "number",
    ...(actor ? { createdBy: actor } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.METRICS, Item: metric }));
  return metric;
}

export async function updateMetric(metricId: string, patch: any): Promise<Metric | null> {
  const current = await getMetric(metricId);
  if (!current) return null;
  // Re-validate the merged definition.
  const merged = { ...current, ...patch };
  const v = validateMetricInput(merged);
  const now = new Date().toISOString();
  const updated: Metric & { pk: string } = {
    pk: METRIC_PK,
    metricId,
    name: v.name,
    description: patch.description !== undefined ? String(patch.description || "") : current.description,
    fqn: v.fqn,
    agg: v.agg,
    measureColumn: v.measureColumn,
    dimensionColumn: v.dimensionColumn,
    timeColumn: v.timeColumn,
    unit: patch.unit !== undefined ? String(patch.unit || "") : current.unit,
    format: (FORMATS as string[]).includes(patch.format) ? patch.format : current.format,
    createdBy: current.createdBy,
    createdAt: current.createdAt,
    updatedAt: now,
  };
  await docClient.send(new PutCommand({ TableName: TABLES.METRICS, Item: updated }));
  return updated;
}

export async function deleteMetric(metricId: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLES.METRICS, Key: { pk: METRIC_PK, metricId } }));
}

// ─── Redshift 执行 ───────────────────────────────────────────────────────────
function cellValue(c: any): string | number | null {
  if (!c || c.isNull) return null;
  if (c.longValue !== undefined) return Number(c.longValue);
  if (c.doubleValue !== undefined) return Number(c.doubleValue);
  if (c.booleanValue !== undefined) return c.booleanValue ? 1 : 0;
  if (c.stringValue !== undefined) return c.stringValue;
  return null;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 🔴 只留**行形状**:指标这边 `cellValue` 把非数字字符串**原样返回**(质量那边判成 null)——
//    两种归一口径不同,所以归一必须留在各自领域(见 direct-query.ts 规矩 ①)。
// 🔴 落点由调用方解析一次后传进来(一次计算要跑 3 条 SQL,解析三次等于三次强一致读)。
async function execSql(
  sql: string,
  place: DirectQueryPlace
): Promise<Array<Record<string, string | number | null>>> {
  const r = await directQueryRaw(place, sql);
  return r.records.map((rec) => {
    const row: Record<string, string | number | null> = {};
    r.columns.forEach((n, idx) => { row[n] = cellValue(rec[idx]); });
    return row;
  });
}

const num = (v: string | number | null): number => (v == null ? 0 : typeof v === "number" ? v : Number(v) || 0);

// ─── 快照 ────────────────────────────────────────────────────────────────────
// Write a value snapshot AND update the metric definition's lastValue/lastComputedAt
// (so the dashboard/list can show the current value without re-running the query).
async function recordValue(metricId: string, value: number, targetId: string): Promise<string> {
  const ts = new Date().toISOString();
  // 🔴 值按区存。
  // 快照表的键是 (metricId, ts) ⇒ 两个区在同一毫秒算完的概率可忽略,所以**不改键**,
  // 只在行上加 `targetId` 属性 + 读侧过滤(改键要动 CDK 与全部存量)。
  const tid = targetId;
  await Promise.all([
    docClient.send(new PutCommand({ TableName: TABLES.METRIC_VALUES, Item: { metricId, ts, value, targetId: tid } })),
    docClient.send(
      new UpdateCommand({
        TableName: TABLES.METRICS,
        Key: { pk: METRIC_PK, metricId },
        UpdateExpression: "SET lastValue = :v, lastComputedAt = :t, lastTargetId = :tid, valueByTarget = if_not_exists(valueByTarget, :empty)",
        ExpressionAttributeValues: { ":v": value, ":t": ts, ":tid": tid, ":empty": {} },
      })
    ).catch(() => {}),
  ]);
  // map 单键更新(不整体覆盖 ⇒ 这次计算不会抹掉别区的值)
  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.METRICS,
      Key: { pk: METRIC_PK, metricId },
      UpdateExpression: "SET valueByTarget.#t = :entry",
      ExpressionAttributeNames: { "#t": tid },
      ExpressionAttributeValues: { ":entry": { value, computedAt: ts } },
    })
  ).catch(() => {});
  return ts;
}

export async function getSnapshots(metricId: string, n: number, targetId: string): Promise<Array<{ ts: string; value: number }>> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.METRIC_VALUES,
      KeyConditionExpression: "metricId = :m",
      ExpressionAttributeValues: { ":m": metricId },
      ScanIndexForward: false,
      Limit: n,
    })
  );
  // 🔴 按区过滤:不过滤的话趋势线会把两个区的值交替画成一条锯齿,看起来像「指标在剧烈波动」。
  // 无章的存量快照归主控区(落章之前只有一个区)。
  const want = targetId;
  return (Items as any[])
    .filter((i) => (typeof i.targetId === "string" && i.targetId ? i.targetId : HOME_TARGET_ID) === want)
    .map((i) => ({ ts: i.ts, value: num(i.value) }))
    .reverse();
}

// ─── 计算 ────────────────────────────────────────────────────────────────────
export interface ComputeResult {
  metricId: string;
  value: number;
  computedAt: string;
  /** 这个值是在哪个区算出来的(恒有,来自解析出的落点) */
  targetId: string;
  dimension?: Array<{ k: string; value: number }>;
  series?: Array<{ d: string; value: number }>;
  snapshots: Array<{ ts: string; value: number }>;
}

// `scope.targetId` 必填(不再「缺省 = 主控区」);
// 「该区没装数仓」回能力态,由路由透传、页面整块降级(不是"指标算不出来")。
export async function computeMetric(
  metricId: string,
  scope: DirectQueryScope
): Promise<ComputeResult | DirectQueryUnavailable> {
  const m = await getMetric(metricId);
  if (!m) throw new Error("指标不存在");
  const tbl = quoteTable(m.fqn);
  const expr = aggExpr(m.agg, m.measureColumn);

  const pre = await resolveDirectQueryPlaceSafe(scope);
  if (pre.capability === "unavailable") return pre;
  const place = pre.place;

  const rows = await execSql(`SELECT ${expr} AS value FROM ${tbl}`, place);
  const value = num(rows[0]?.value);

  let dimension: Array<{ k: string; value: number }> | undefined;
  if (m.dimensionColumn) {
    const dRows = await execSql(
      `SELECT ${safeIdent(m.dimensionColumn)} AS k, ${expr} AS value FROM ${tbl} GROUP BY 1 ORDER BY value DESC LIMIT 50`,
      place
    );
    dimension = dRows.map((r) => ({ k: r.k == null ? "(空)" : String(r.k), value: num(r.value) }));
  }

  let series: Array<{ d: string; value: number }> | undefined;
  if (m.timeColumn) {
    const sRows = await execSql(
      `SELECT ${safeIdent(m.timeColumn)}::date AS d, ${expr} AS value FROM ${tbl} GROUP BY 1 ORDER BY 1 DESC LIMIT 60`,
      place
    );
    series = sRows.map((r) => ({ d: String(r.d), value: num(r.value) })).reverse();
  }

  // 🔴 值与快照都盖**真跑的那个区**
  // (`place.targetId` 由 `resolveDirectQueryPlaceSafe` 解出来,不是调用方声称的)。
  const ts = await recordValue(metricId, value, place.targetId);
  const snapshots = await getSnapshots(metricId, 30, place.targetId);
  return { metricId, value, computedAt: ts, dimension, series, snapshots, targetId: place.targetId };
}

// Dashboard batch: current value + snapshot per metric (no dimension/time breakdown).
// 同 computeMetric:落点解析一次,降级整体回。
export async function computeAll(
  scope: DirectQueryScope
): Promise<Record<string, { value?: number; computedAt?: string; snapshots?: Array<{ ts: string; value: number }>; error?: string }> | DirectQueryUnavailable> {
  const metrics = await listMetrics();
  const pre = await resolveDirectQueryPlaceSafe(scope);
  if (pre.capability === "unavailable") return pre;
  const place = pre.place;
  const out: Record<string, any> = {};
  await Promise.all(
    metrics.map(async (m) => {
      try {
        const rows = await execSql(`SELECT ${aggExpr(m.agg, m.measureColumn)} AS value FROM ${quoteTable(m.fqn)}`, place);
        const value = num(rows[0]?.value);
        const ts = await recordValue(m.metricId, value, place.targetId);
        out[m.metricId] = { value, computedAt: ts, targetId: place.targetId, snapshots: await getSnapshots(m.metricId, 30, place.targetId) };
      } catch (e: any) {
        out[m.metricId] = { error: e.message };
      }
    })
  );
  return out;
}
