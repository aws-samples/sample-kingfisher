// 模块 37 — BI 报表 / 仪表盘搭建器(F3)。类型单一事实源。
//
// 一个「报表 widget」= 取数 spec(WidgetSource)+ 可视化 spec(WidgetViz)。
// 一个「仪表盘」= 栅格布局(引用 widget)+ 仪表盘级筛选器。
// 均为项目级共享资产:pk=projectId 键式隔离,内嵌 version 乐观锁(照抄告警规则)。

import type { ChartType } from "@/types/genbi";

// 图表类型:在 GenBI 的 ChartType(table/metric/bar/line)之上扩展 pie/barh/gauge。
// 复用现有自绘 SVG 组件渲染(Donut=pie / TrendArea=line / BarList=barh / Gauge=gauge / 新增 BarChart=bar / MetricCard=metric)。
export type BiChartType = ChartType | "pie" | "barh" | "gauge";
export const BI_CHART_TYPES: BiChartType[] = ["table", "metric", "bar", "barh", "line", "pie", "gauge"];

export type BiEngine = "redshift" | "athena";
export const BI_ENGINES: BiEngine[] = ["redshift", "athena"];

// 取数来源(三源归一)。sql / genbi 本质相同(engine + 只读 SQL),genbi 仅标记"由 AI 生成"便于展示/再编辑。
// v2:sql source 可选带 `builder` spec(字段配置器所建),用于"再编辑时还原字段面板";执行仍只认 sql,
// builder 仅是 UI 元数据。老 v1 报表无此字段,向后兼容(读取时为 undefined 即纯 SQL 模式)。
/**
 * @kf-batch 50-WP4ter-coverage(工单 SC-7)
 * `targetId` = 这个视觉对象**在哪个区取数**。合同早已定为 **widget 级**(50 SPEC §8.3):
 * 一张仪表盘可以并排放「主控区的销量」与「us-west-2 的销量」,所以它不能是页面级的唯一值;
 * 页面上的执行范围只作**新建时的默认值**。
 * 🔴 缺省(存量 widget 没有这个字段)= 主控区:BI 取数在此之前只有一条路(GENBI.workgroup),
 * 那是历史事实,不是猜测。
 */
export type WidgetSource =
  | { kind: "sql"; engine: BiEngine; sql: string; builder?: unknown; targetId?: string }
  // @kf-batch 50-W5-seg2-WP1 — dataapi 已下线(2026-09-05,50 SPEC §3.9c):分支**保留**让存量行反序列化不炸;取数一律 410,编辑器不再提供。
  | { kind: "dataapi"; apiId: string; params?: Record<string, string> }
  | { kind: "genbi"; engine: BiEngine; sql: string; question?: string; targetId?: string };

export const WIDGET_SOURCE_KINDS = ["sql", "dataapi", "genbi"] as const;
export type WidgetSourceKind = (typeof WIDGET_SOURCE_KINDS)[number];

export interface WidgetViz {
  chart: BiChartType;
  xField?: string; // 维度列(bar/barh/line/pie 用)
  yField?: string; // 度量列(单系列;兼容 v1/v2)
  // v3 图表增强(全部可选 = 向后兼容:老报表无这些字段 → toSeries 走 single 模式 = 原行为)。
  yFields?: string[]; // 多度量 → 多系列(每个度量一条系列)
  seriesField?: string; // 分组 / 颜色维度 → pivot 长转宽成多系列
  stack?: boolean; // 堆叠(true)vs 分组并列(false / 默认);仅 bar 生效
  orient?: "v" | "h"; // v=纵向(默认)/ h=横向(barh);仅 bar 生效
  auto?: boolean; // true=用 suggestChart 自动选图(忽略 chart 显式值)
}

// 报表 widget 定义(表 bgp-bi-reports)。
export interface BiReport {
  projectId: string; // pk
  reportId: string; // sk(ULID)
  name: string;
  description?: string;
  source: WidgetSource;
  viz: WidgetViz;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  version: number; // 乐观锁
}

// 仪表盘筛选器:值以 {{key}} 注入 widget SQL(仅对声明了该占位的 widget 生效)。
// select 走白名单(命中即代入,同 lib/sql/param-render 的 enum 白名单);date 作 SQL 字符串字面量安全转义。
export interface DashboardFilter {
  key: string; // 注入占位名 [a-z][a-z0-9_]*
  label: string;
  type: "date" | "select";
  options?: string[]; // select 白名单
  default?: string;
}

// 仪表盘布局项:引用报表(i=reportId)+ 栅格位置。结构兼容 react-grid-layout,便于二期升级拖拽。
export interface DashboardLayoutItem {
  i: string; // reportId
  x: number;
  y: number;
  w: number; // 占列宽(antd 24 栅格制:6/8/12/24)
  h: number; // 高度档位(1/2…,前端映射到像素)
}

// 仪表盘定义(表 bgp-bi-dashboards)。
export interface BiDashboard {
  projectId: string; // pk
  dashboardId: string; // sk(ULID)
  name: string;
  description?: string;
  layout: DashboardLayoutItem[];
  filters?: DashboardFilter[];
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  version: number; // 乐观锁
}

// 取数统一结果(executeBiQuery 返回)。与 SqlRunResult 信封对齐但含 columnTypes。
export interface BiQueryResult {
  columns: string[];
  columnTypes?: string[];
  rows: unknown[][];
  rowCount: number;
  elapsedMs: number;
  maskedColumns: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// v4 分析看板(QuickSight 式:一个画布 N 个视觉对象 + 绑字段·作用域筛选器)。
// 纯新增:旧 BiReport/BiDashboard 及其表/lib/API 完全保留不动。新表 bgp-bi-analyses。
// 复用 WidgetSource / WidgetViz / BuilderSpec —— 视觉对象 = 一份取数 + 可视化(与报表同构)。
// ═══════════════════════════════════════════════════════════════════════════

// 视觉对象(embed 在分析看板内,不再是对报表的弱引用)。
export interface BiWidget {
  widgetId: string; // 画布内唯一(ULID)
  name: string;
  source: WidgetSource; // 复用:sql / dataapi / genbi(可视化配置编译成 sql,并存 builder spec)
  viz: WidgetViz; // 复用:v3 多系列 / 分组 / 堆叠 / 横向
}

// 筛选器作用域:全部视觉对象 | 指定若干(单个即一元数组)。
export type FilterScope = { mode: "all" } | { mode: "widgets"; widgetIds: string[] };

// 分析看板筛选器:绑定一个字段 + 作用域(整合的核心抽象)。
// 取数时把 (field, value) 追加进命中作用域的视觉对象的 builder.filters 重新编译 → 不写 SQL 也能过滤。
export interface AnalysisFilter {
  key: string; // 唯一标识 [a-z][a-z0-9_]*
  label: string;
  field: string; // 绑定字段名(如 "region")
  type: "select" | "date";
  op?: "=" | "!=" | ">" | "<" | ">=" | "<="; // 默认 "="
  options?: string[]; // select 白名单
  default?: string;
  scope: FilterScope; // 作用域(默认 {mode:"all"})
}

// 布局项:i=widgetId(与仪表盘的 DashboardLayoutItem 同结构,复用 DashboardGrid)。
export interface AnalysisLayoutItem {
  i: string; // widgetId
  x: number;
  y: number;
  w: number;
  h: number;
}

// 分析看板(表 bgp-bi-analyses,pk=projectId, sk=analysisId)。
export interface BiAnalysis {
  projectId: string; // pk
  analysisId: string; // sk(ULID)
  name: string;
  description?: string;
  widgets: BiWidget[]; // 内嵌 N 个视觉对象
  filters: AnalysisFilter[]; // 画布级绑字段·作用域筛选器
  layout: AnalysisLayoutItem[]; // {i:widgetId,x,y,w,h}
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  version: number; // 乐观锁(照抄 dashboards)
}
