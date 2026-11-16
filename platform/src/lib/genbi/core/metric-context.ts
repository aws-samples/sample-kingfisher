// @genbi/core — 建模指标 → 问数语义上下文的纯转换,零 IO。
//
// 【为什么进 core】指标定义只存一处(指标表);问数要「看得见」这些定义,有两条腿:
// 平台进程(getContextForGrounding)与智能体技能 Lambda(lookup_business_context)。
// 两条腿各写一份「指标 → 提示文本」必然漂移,所以转换与组合都收敛在这里,两个运行时共用同一份。
//
// 【为什么正文不放可执行 SQL】问数既查数仓也查数据湖,两边方言不同;指标的可执行 SQL 只有一个作者
// (建模层的指标 SQL 构造器,数仓方言)。这里给模型的是**方言中立的结构化定义**:表、聚合、过滤、时间范围,
// 模型据此在当前引擎上写查询。聚合 / 表 / 过滤文本与指标 SQL 构造器的产出逐项一致(只是标识符不带引号),由单测钉住。

import type { ContextEntry } from "./types";
import { filterAndRankContext, GROUNDING_MAX_ENTRIES } from "./context-format";

/** 指标行里本文件读的字段(与指标表落库行同形;只声明用到的,其余字段原样忽略)。 */
export interface MetricRowLike {
  modelMetricId?: string;
  name?: string;
  metricType?: string;
  caliber?: string;
  description?: string;
  unit?: string;
  fqn?: string;
  agg?: string;
  measureColumn?: string;
  timeColumn?: string;
  atomicId?: string;
  timeWindow?: string;
  modifiers?: Array<{ column?: string; op?: string; value?: string | string[] }>;
  createdAt?: string;
  updatedAt?: string;
}

/** 解析后的指标查询规格:原子用自身;派生 = 引用的原子 + 自己的过滤条件与时间范围。 */
export interface ResolvedMetricSpec<M extends MetricRowLike = MetricRowLike> {
  fqn: string;
  agg: NonNullable<M["agg"]>;
  measureColumn: M["measureColumn"];
  timeColumn: M["timeColumn"];
  timeWindow: M["timeWindow"];
  modifiers: NonNullable<M["modifiers"]>;
}

export type MetricSpecResolution<M extends MetricRowLike = MetricRowLike> =
  | { ok: true; spec: ResolvedMetricSpec<M> }
  | { ok: false; reason: string };

/**
 * 「派生指标怎么落到原子指标上」的唯一作者(纯函数)。
 * 计算指标值的一侧先把引用的原子行读出来再调它;问数这一侧在同一批行里找原子再调它 ——
 * 两边用同一条规则,不会出现「算的是一个口径、告诉模型的是另一个口径」。
 */
export function resolveMetricSpec<M extends MetricRowLike>(m: M, atomic: M | null | undefined): MetricSpecResolution<M> {
  if (m.metricType === "atomic") {
    if (!m.fqn || !m.agg) return { ok: false, reason: "原子指标定义不完整" };
    return {
      ok: true,
      spec: {
        fqn: m.fqn, agg: m.agg as NonNullable<M["agg"]>, measureColumn: m.measureColumn, timeColumn: m.timeColumn,
        timeWindow: undefined as M["timeWindow"], modifiers: [] as unknown as NonNullable<M["modifiers"]>,
      },
    };
  }
  if (!m.atomicId) return { ok: false, reason: "派生指标缺少原子引用" };
  if (!atomic) return { ok: false, reason: "派生指标引用的原子指标不存在" };
  if (atomic.metricType !== "atomic" || !atomic.fqn || !atomic.agg) return { ok: false, reason: "引用的指标不是合法原子指标" };
  return {
    ok: true,
    spec: {
      fqn: atomic.fqn,
      agg: atomic.agg as NonNullable<M["agg"]>,
      measureColumn: atomic.measureColumn,
      // 派生可覆盖时间列;否则用原子的
      timeColumn: m.timeColumn || atomic.timeColumn,
      timeWindow: m.timeWindow,
      modifiers: (m.modifiers || []) as NonNullable<M["modifiers"]>,
    },
  };
}

// ── 闭合清单 → 给模型读的文本(新增一种聚合 / 运算符 / 时间周期而不在这里加一项,单测即红)──

/** 聚合 → 表达式文本。与指标 SQL 构造器的聚合表达式逐项相同(标识符不带引号;标准 SQL,数仓与数据湖都认)。 */
export const METRIC_AGG_TEXT: Record<string, (column: string) => string> = {
  count: () => "COUNT(*)",
  count_distinct: (c) => `COUNT(DISTINCT ${c})`,
  sum: (c) => `SUM(${c})`,
  avg: (c) => `AVG(${c})`,
  min: (c) => `MIN(${c})`,
  max: (c) => `MAX(${c})`,
};

/** 过滤运算符 → 文本。 */
export const METRIC_OP_TEXT: Record<string, string> = {
  "=": "=", "!=": "!=", ">": ">", ">=": ">=", "<": "<", "<=": "<=", in: "IN",
};

/** 时间周期 → 中文说明(与指标 SQL 构造器的谓词同义;「all」= 不限时间,不出说明)。 */
export const METRIC_TIME_WINDOW_TEXT: Record<string, string> = {
  all: "",
  today: "当天",
  "7d": "最近 7 天(自 7 天前零点起)",
  "30d": "最近 30 天(自 30 天前零点起)",
  "90d": "最近 90 天(自 90 天前零点起)",
  mtd: "本月初至今",
  ytd: "本年初至今",
};

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const oneLine = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
const quoted = (v: unknown) => `'${oneLine(v).replace(/'/g, "''")}'`;

/** 表全名取最后两段(schema.table)—— 与指标 SQL 构造器取表的规则相同。 */
export function metricTableOf(fqn: string): string | null {
  const parts = String(fqn || "").split(".").filter(Boolean);
  return parts.length < 2 ? null : `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
}

/** 聚合表达式文本;聚合不在清单里 / 需要度量列却没有 ⇒ null(不编一个出来)。 */
export function metricAggText(agg: string, measureColumn?: string): string | null {
  if (!own(METRIC_AGG_TEXT, agg)) return null;
  if (agg !== "count" && !measureColumn) return null;
  return METRIC_AGG_TEXT[agg](String(measureColumn || ""));
}

function modifierText(m: { column?: string; op?: string; value?: string | string[] }): string | null {
  const op = String(m.op ?? "");
  if (!m.column || !own(METRIC_OP_TEXT, op)) return null;
  if (op === "in") {
    const arr = (Array.isArray(m.value) ? m.value : [m.value]).filter((v) => v != null && String(v) !== "");
    if (!arr.length) return null;
    return `${m.column} IN (${arr.map(quoted).join(", ")})`;
  }
  const v = Array.isArray(m.value) ? m.value[0] : m.value;
  return `${m.column} ${METRIC_OP_TEXT[op]} ${quoted(v)}`;
}

/**
 * 解析后的规格 → 一行结构化定义。任何一段落不到闭合清单上 ⇒ 整条回 null
 * (宁可这条指标不进提示,也不把半截 / 走样的定义交给模型)。
 */
export function metricDefinitionText(spec: ResolvedMetricSpec, extra?: { caliber?: string; unit?: string; basedOn?: string }): string | null {
  const table = metricTableOf(spec.fqn);
  const agg = metricAggText(String(spec.agg), spec.measureColumn);
  if (!table || !agg) return null;
  const filters: string[] = [];
  for (const m of spec.modifiers || []) {
    if (!m || !m.column) continue; // 与指标 SQL 构造器一致:没有列的修饰词不参与
    const t = modifierText(m);
    if (!t) return null;
    filters.push(t);
  }
  const tw = String(spec.timeWindow ?? "");
  let timeText = "";
  if (tw && tw !== "all") {
    if (!own(METRIC_TIME_WINDOW_TEXT, tw)) return null;
    // 与指标 SQL 构造器一致:没有时间列就没有时间过滤,这里也不声称有
    if (spec.timeColumn) timeText = `${METRIC_TIME_WINDOW_TEXT[tw]},按时间列 ${spec.timeColumn}`;
  }
  const parts = [
    ...(extra?.caliber ? [oneLine(extra.caliber)] : []),
    `数仓表 ${table}`,
    `计算方式 ${agg}`,
    ...(filters.length ? [`过滤条件 ${filters.join(" AND ")}`] : []),
    ...(timeText ? [`时间范围 ${timeText}`] : []),
    ...(extra?.basedOn ? [`基于原子指标「${oneLine(extra.basedOn)}」`] : []),
    ...(extra?.unit ? [`单位 ${oneLine(extra.unit)}`] : []),
  ];
  return parts.join(";");
}

/** 指标条目在上下文里的 entryId 前缀(与用户在业务口径页建的条目区分开)。 */
export const METRIC_ENTRY_PREFIX = "metric:";
/** 指标是全平台共享的定义(指标表不分项目)⇒ 在上下文里归 global。 */
const METRIC_ENTRY_PROJECT = "global";

/**
 * 指标行 → 上下文条目(kind = metric)。派生指标在**同一批行**里找它引用的原子。
 * 不是合法指标的行(缺名字 / 类型不认识 / 定义不完整 / 派生找不到原子)一律跳过。
 */
export function metricsToContextEntries(rows: MetricRowLike[]): ContextEntry[] {
  const list = Array.isArray(rows) ? rows : [];
  const byId = new Map<string, MetricRowLike>();
  for (const r of list) if (r && r.modelMetricId) byId.set(String(r.modelMetricId), r);
  const out: ContextEntry[] = [];
  for (const m of list) {
    if (!m || !m.modelMetricId || !oneLine(m.name)) continue;
    if (m.metricType !== "atomic" && m.metricType !== "derived") continue;
    const atomic = m.metricType === "derived" && m.atomicId ? byId.get(String(m.atomicId)) : undefined;
    const r = resolveMetricSpec(m, atomic);
    if (!r.ok) continue;
    const body = metricDefinitionText(r.spec, {
      caliber: m.caliber || m.description,
      unit: m.unit,
      ...(m.metricType === "derived" && atomic?.name ? { basedOn: atomic.name } : {}),
    });
    const table = metricTableOf(r.spec.fqn);
    if (!body || !table) continue;
    out.push({
      projectId: METRIC_ENTRY_PROJECT,
      entryId: `${METRIC_ENTRY_PREFIX}${m.modelMetricId}`,
      kind: "metric",
      title: oneLine(m.name),
      body,
      scope: table,
      enabled: true,
      createdAt: String(m.createdAt || ""),
      updatedAt: String(m.updatedAt || m.createdAt || ""),
    });
  }
  return out;
}

/**
 * 一次问数 / 生成要参考的全部语义条目 = 业务口径行 ∪ 指标行,再走同一套过滤 / 相关性排序 / 截断。
 * 排序在这里定(最近更新在前,同刻按 entryId),所以两个运行时给同一批行必得同一个结果 ——
 * 页面上「本次参考了哪些」与智能体真正读到的是同一份清单。
 */
export function groundingEntries(
  contextRows: ContextEntry[],
  metricRows: MetricRowLike[],
  keywords?: string,
  limit: number = GROUNDING_MAX_ENTRIES,
): ContextEntry[] {
  const all = [...(Array.isArray(contextRows) ? contextRows : []), ...metricsToContextEntries(metricRows)];
  all.sort((a, b) => {
    const ua = String(a.updatedAt || ""), ub = String(b.updatedAt || "");
    if (ua !== ub) return ua < ub ? 1 : -1;
    const ia = String(a.entryId || ""), ib = String(b.entryId || "");
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
  return filterAndRankContext(all, keywords, limit);
}
