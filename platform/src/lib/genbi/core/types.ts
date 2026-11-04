// @genbi/core — 引擎无关的核心类型单一来源。
//
// 【core 契约】core 内部所有文件引用类型都走 "./types"（相对路径,不用 @/ alias,
// 保证阶段2/3 编译成独立 CJS 给容器/Lambda 时无 alias 解析问题）。
//
// 两类类型:
//  1) core 私有类型(SchemaTable/CatalogEntry/ContextEntry 等)——定义在此,core 独有。
//  2) 跨 core 边界的全局契约类型(ChartSpec/GenBiStep 等)——【阶段2 已物理下沉至此】,
//     作为契约单一来源;@/types/genbi 反向 re-export 保持消费方路径不变。
//     下沉理由:core 须能独立编译成 CJS 给 Lambda/容器,不能靠 @/ alias。

// ── 1) core 私有类型 ──

// Redshift/Athena introspect 产出的表结构（schema.ts 的纯类型下沉）。
export interface SchemaColumn {
  name: string;
  type: string;
}
export interface SchemaTable {
  schema: string;
  table: string;
  columns: SchemaColumn[];
}

// 语义检索（retrieval）用的类型。
export interface PublishedHint {
  targetTable: string;
  question?: string;
  title: string;
}
export interface CatalogEntry {
  schema: string;
  table: string;
  columns: { name: string; type: string }[];
  description?: string; // OpenMetadata 业务描述（best-effort）
  published?: { title: string; question?: string }; // 已固化结果表
}
export interface TableMatch {
  schema: string;
  table: string;
  reason: string;
  preferred: boolean;
}
export interface RetrievalResult {
  selected: CatalogEntry[];
  matches: TableMatch[];
  note?: string;
  usedFallback: boolean;
}

// 业务口径（context）的类型（context.ts 的纯类型下沉,与 DynamoDB 存储契约完全一致）。
export type ContextKind = "caliber" | "term" | "rule"; // 口径/指标定义 | 术语别名 | 规则注意事项
export interface ContextEntry {
  projectId: string;
  entryId: string;
  kind: ContextKind;
  title: string;       // 术语/口径/规则名
  body: string;        // 定义/说明/规则内容
  scope?: string;      // 适用范围(可选:如 表名/引擎/模块)
  tags?: string[];
  enabled: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

// 引擎枚举。
export type GenBiEngine = "redshift" | "athena";

// ── 2) 跨 core 边界的全局契约类型（物理定义，契约单一来源）──
// 阶段2 从 @/types/genbi 下沉至此；@/types/genbi 反向 re-export，消费方路径不变。

// 图表类型枚举。
export type ChartType = "table" | "metric" | "bar" | "line";

// 最终结果集的建议可视化。
export interface ChartSpec {
  type: ChartType;
  xField?: string; // category / dimension column
  yField?: string; // measure column
  reason?: string;
}

// Agent 一次会话中的一步工具/技能调用 —— 展示给用户的执行链路
// (每一步:调了什么工具、给了什么入参、拿到什么结果)。
export interface GenBiStep {
  sql: string;              // SQL 入参(非 SQL 工具为空串,兼容旧数据)
  ok: boolean;
  rowCount?: number;
  error?: string;
  tool?: string;            // 工具/技能名(run_sql / run_registered_skill / lookup_business_context …)
  phase?: "prepare" | "reason"; // prepare=回答前的准备调用(探查schema/查口径), reason=模型推理中的调用
  inputSummary?: string;    // 非 SQL 入参的摘要(JSON 截断)
  outputSummary?: string;   // 结果摘要:行数/条数/关键字段(JSON 截断)
  durationMs?: number;
}

// 语义检索阶段命中的表(可解释性)。
// 注:core 内部 retrieval 用 TableMatch(结构相同,服务不同边界),阶段2 不强行合并。
export interface MatchedTable {
  schema: string;
  table: string;
  reason: string;
  preferred: boolean; // 已固化结果表
}

// 语义层可观测契约:本次问数参考到的业务口径条目(标题/类型/范围,不含正文)。
// 让"口径生效"可见 —— 与 UsedContextItem(context-format) 结构一致。
export interface UsedContextEntry {
  title: string;
  kindLabel: string;
  scope?: string;
}
