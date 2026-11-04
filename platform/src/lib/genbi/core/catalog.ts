// @genbi/core — 数据目录相关纯逻辑（SCHEMA_SQL 常量 + catalog 文本渲染,零依赖）。
// schema.ts 的纯部分下沉:introspectSchema(Redshift Data API) 留 platform 适配器,
// 此处只放"引擎无关"的 SQL 常量与文本拼装,供 platform / 容器 / Lambda 共用。

import type { SchemaTable, GenBiEngine } from "./types";

// Redshift 全库表结构 introspect SQL（与 Lambda infra/lambda/genbi-skills/rs.js 曾逐字重复）。
export const SCHEMA_SQL = `
  SELECT t.schemaname, t.tablename, c.column_name, c.data_type, c.ordinal_position
  FROM pg_tables t
  LEFT JOIN information_schema.columns c
    ON c.table_schema = t.schemaname AND c.table_name = t.tablename
  WHERE t.schemaname NOT IN ('information_schema','pg_catalog','pg_internal','pg_automv')
  ORDER BY t.schemaname, t.tablename, c.ordinal_position
`;

// 目录文本渲染的可选项（阶段3 归一:容器/inprocess/codegen 三处共用同一 core 函数）。
export interface CatalogTextOpts {
  engine?: GenBiEngine;   // 引擎方言(redshift 默认 / athena);影响表头文案与限定名格式。
  athenaRef?: string;     // Athena 三段式联邦目录前缀(如 "s3tablescatalog/bgp-table-bucket");
                          // 由调用方按环境传入(容器走 env、inprocess 走常量)。engine=athena 时用。
  retrievalHeader?: boolean; // true=用"本次已检索出最相关的表"表头(检索命中场景);默认全表表头。
}
// 单条表可携带的额外标注(检索/固化场景;基础 SchemaTable 无这些字段)。
export interface CatalogTableExtra {
  description?: string;                      // OpenMetadata 业务描述
  published?: { title?: string; question?: string }; // 已固化结果表标注
}

// 把表结构渲染成注入 system prompt 的紧凑目录文本。
// 【归一】默认(不传 opts)= 原 Redshift 版逐字不变(codegen 等消费方零影响);
// 传 opts 支持 Athena 三段式限定名 + 检索表头 + published/description 标注(容器/inprocess 用)。
export function buildCatalogText(
  tables: (SchemaTable & CatalogTableExtra)[],
  database: string,
  opts: CatalogTextOpts = {},
): string {
  const isAthena = opts.engine === "athena";
  if (!tables.length) {
    return isAthena
      ? `命名空间 ${database} 暂无可见的用户表（可能尚未同步数据，或当前连接无权限）。`
      : `数据库 ${database} 暂无可见的用户表（可能尚未同步数据，或当前连接无权限）。`;
  }
  const qualify = (s: string, t: string) =>
    isAthena ? `"${opts.athenaRef || ""}"."${s}"."${t}"` : `${s}.${t}`;
  const header = opts.retrievalHeader
    ? "本次问题已检索出以下最相关的表（表名后为字段；如有业务描述/固化标注请据此选择）:"
    : "可查询的表与字段（schema.table 后为列名与类型）:";
  const lines = [
    isAthena
      ? `数据湖命名空间: ${database}（Amazon Athena / S3 Tables，Trino SQL 方言）`
      : `数据库: ${database}（Amazon Redshift，PostgreSQL/Redshift SQL 方言）`,
    header,
    "",
  ];
  for (const t of tables) {
    const tag = t.published ? `  【已固化结果表，来源问题：${t.published.question || t.published.title}】` : "";
    lines.push(`### ${qualify(t.schema, t.table)}${tag}`);
    if (t.description) lines.push(`  描述：${t.description}`);
    for (const c of t.columns) lines.push(`  - ${c.name} ${c.type}`);
    lines.push("");
  }
  return lines.join("\n");
}
