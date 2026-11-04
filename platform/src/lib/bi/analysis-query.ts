// 模块 37 v4 — 分析看板筛选器注入(纯函数,零副作用,可单测)。整合的核心抽象。
//
// 根治"筛选没生效":旧仪表盘筛选器靠 SQL 里 {{key}} 占位符注入,而可视化配置(不写 SQL)编译出的
// SQL 无占位符 → 过滤无效。这里对「可视化配置」的视觉对象,把命中作用域的筛选器 (field, value)
// **追加进 builder.filters 重新 buildSql**——不写一行 SQL 也能过滤。手写 SQL/genbi 仍走既有
// {{key}} 占位符注入(向后兼容);dataapi 有自己的参数系统,不做字段注入。
//
// executeBiQuery / buildSql / maskRows 一行不改,纯复用。

import { buildSql, type BuilderSpec, type BuilderFilter, type FilterOp } from "./query-builder";
import type { BiWidget, AnalysisFilter, WidgetSource, DashboardFilter } from "./types";

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FILTER_OPS: FilterOp[] = ["=", "!=", ">", "<", ">=", "<="];

// 作用域判定:全部视觉对象,或命中指定 widgetIds。
export function inScope(filter: AnalysisFilter, widgetId: string): boolean {
  const s = filter.scope;
  if (!s || s.mode === "all") return true;
  return Array.isArray(s.widgetIds) && s.widgetIds.includes(widgetId);
}

// 取筛选器运行期值(优先运行值,回退默认)。空串/undefined 视为"未设值",不注入。
function valueOf(filter: AnalysisFilter, values: Record<string, string> | undefined): string | undefined {
  const v = values?.[filter.key];
  const eff = v !== undefined && v !== null && v !== "" ? v : filter.default;
  return eff !== undefined && eff !== null && eff !== "" ? String(eff) : undefined;
}

// select 类型:值必须在白名单内(防注入的第一道;值位置转义是第二道)。命中才注入,否则跳过(不炸整卡)。
function passesWhitelist(filter: AnalysisFilter, value: string): boolean {
  if (filter.type === "select" && filter.options && filter.options.length) {
    return filter.options.includes(value);
  }
  return true;
}

export interface ResolvedSource {
  source: WidgetSource;
  // 手写 SQL/genbi 走占位符注入时,交给 executeBiQuery 的 filters/values(builder 路径为空)。
  passthroughFilters: DashboardFilter[];
  passthroughValues: Record<string, string>;
}

/**
 * 计算一个视觉对象"筛选生效后"的取数 source。
 * - builder(有 builder spec)→ 命中作用域的筛选器追加进 builder.filters 重编译 buildSql。
 * - 手写 sql/genbi → source 原样,命中筛选器映射成占位符 filters(executeBiQuery 内 renderWithFilters 注入 {{key}})。
 * - dataapi → 原样,不做字段注入。
 */
export function resolveWidgetSource(
  widget: BiWidget,
  filters: AnalysisFilter[] | undefined,
  values: Record<string, string> | undefined
): ResolvedSource {
  const source = widget.source;
  const applicable = (filters || []).filter((f) => inScope(f, widget.widgetId));

  // ── builder:字段注入,恒从 builder spec 重编译(根治没生效 + 单一事实源不依赖可能过期的 stored sql)──
  const builderSpec = (source as any)?.builder as BuilderSpec | undefined;
  if (source.kind === "sql" && builderSpec && typeof builderSpec === "object") {
    const injected: BuilderFilter[] = [];
    for (const f of applicable) {
      const v = valueOf(f, values);
      if (v === undefined) continue;
      if (!IDENT_RE.test(f.field)) continue; // 字段名非法则跳过(buildSql 也会再校验)
      if (!passesWhitelist(f, v)) continue;
      const op: FilterOp = FILTER_OPS.includes(f.op as FilterOp) ? (f.op as FilterOp) : "=";
      injected.push({ col: f.field, op, value: v });
    }
    // 恒以 builder spec 为单一事实源重编译(有无命中筛选器都编译)——保证 SQL 与当前 spec 一致,
    // 不信任 stored sql(可能因老数据/半保存而过期)。buildSql 抛错时回退到 stored source(防误伤能跑的卡)。
    try {
      const mergedSpec: BuilderSpec = injected.length
        ? { ...builderSpec, filters: [...(builderSpec.filters || []), ...injected] }
        : builderSpec;
      const sql = buildSql(mergedSpec);
      return {
        source: { kind: "sql", engine: builderSpec.engine, sql, builder: builderSpec },
        passthroughFilters: [],
        passthroughValues: {},
      };
    } catch {
      return { source, passthroughFilters: [], passthroughValues: {} };
    }
  }

  // ── 手写 sql / genbi:占位符注入(向后兼容;{{key}} 存在才生效)──────────────
  if (source.kind === "sql" || source.kind === "genbi") {
    const pf: DashboardFilter[] = [];
    const pv: Record<string, string> = {};
    for (const f of applicable) {
      const v = valueOf(f, values);
      if (v === undefined) continue;
      pf.push({
        key: f.key,
        label: f.label,
        type: f.type,
        ...(f.options ? { options: f.options } : {}),
        ...(f.default ? { default: f.default } : {}),
      });
      pv[f.key] = v;
    }
    return { source, passthroughFilters: pf, passthroughValues: pv };
  }

  // ── dataapi:原样透传(能力已于 2026-09-05 下线,@kf-batch 50-W5-seg2-WP1;路由里 executeBiDataApi 会抛 410 同一句)──
  return { source, passthroughFilters: [], passthroughValues: {} };
}
