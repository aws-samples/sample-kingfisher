// 模块 26 — GenBI 公共 BI 技能「一键预置」定义(global 作用域,所有用户/项目可用)。
//
// 一组高频 BI 分析模式(排名/占比/时间趋势/环比/带过滤聚合),每个模式按引擎出两份:
//   数据仓库(Redshift, ecommerce.orders) + 数据湖(Athena/S3 Tables, 三段式联邦目录)。
// GenBI 的 run_registered_skill 按 skill.engine 走对应引擎，故用户在前端选「数据仓库/数据湖」
// 数据源时，模型命中对应引擎的版本（_lake 后缀=数据湖版）。
//
// 表引用/SQL 方言差异（均已在 temp-account 实测跑通）：
//   Redshift: ecommerce.orders + DATE_TRUNC/DATEADD/CURRENT_DATE (env WH_ORDERS_TABLE 可覆盖)
//   Athena  : "s3tablescatalog/bgp-table-bucket"."ecommerce"."orders" + date_trunc/date_add/current_date（Trino）
// 参数类型：identifier=列名/聚合函数（标识符校验），number=数字，string=过滤值（自动单引号转义）。
//
// 持久化：本文件是 global 技能的单一事实源；POST /api/genbi/skills/seed 幂等预置（按 name 去重）。
// 账号轮换/环境重建后 seed 一次即恢复。表引用桶名/命名空间随环境不同可经 env 覆盖（见下）。

import type { SkillParam } from "./skills";

// 数据湖表引用（与 infra/agent/genbi/agent.js 的 S3T_REF/S3T_NS 对齐；env 可覆盖）。
const S3T_BUCKET = process.env.S3TABLES_BUCKET || "bgp-table-bucket";
const S3T_CATALOG = process.env.S3TABLES_CATALOG || "s3tablescatalog";
const S3T_NS = process.env.S3TABLES_NAMESPACE || "ecommerce";
const LAKE_ORDERS = `"${S3T_CATALOG}/${S3T_BUCKET}"."${S3T_NS}"."orders"`;
// 数据仓库 orders 表的 schema 限定名。**默认 ecommerce.orders**——DMS/Zero-ETL 全量把源库
// ecommerce 落到 Redshift 同名 schema(非 public);写死 public.orders 会让技能 run 时报
// relation "public.orders" does not exist(已实测)。env WH_ORDERS_TABLE 可按环境覆盖。
const WH_ORDERS = process.env.WH_ORDERS_TABLE || "ecommerce.orders";

export interface GlobalSkillSeed {
  name: string;
  description: string;
  kind: "sql";
  engine: "redshift" | "athena";
  sqlTemplate: string;
  params: SkillParam[];
}

const P = {
  dim: { name: "dim", type: "identifier" as const, description: "分组维度列名，如 region/channel/status/currency", required: true },
  agg: { name: "agg", type: "identifier" as const, description: "聚合函数：sum/avg/count/max/min", required: true },
  aggSumCount: { name: "agg", type: "identifier" as const, description: "聚合函数：sum 或 count", required: true },
  metric: { name: "metric", type: "identifier" as const, description: "被聚合的数值列，如 order_amount（count 时可传 order_id）", required: true },
  topn: { name: "topn", type: "number" as const, description: "取前几名，如 5、10", required: true },
  bucket: { name: "bucket", type: "identifier" as const, description: "时间粒度：day/week/month", required: true },
  days: { name: "days", type: "number" as const, description: "回看/每期天数，如 30、90", required: true },
  filterCol: { name: "filter_col", type: "identifier" as const, description: "过滤列名，如 status/region/channel", required: true },
  filterVal: { name: "filter_val", type: "string" as const, description: "过滤值（等值匹配），如 completed、华北", required: true },
};

// 每个 BI 模式的引擎无关部分（描述前缀 + 两引擎的 SQL 生成器）。
function pair(
  base: string,
  desc: string,
  params: SkillParam[],
  rsSql: (t: string) => string,
  athSql: (t: string) => string
): GlobalSkillSeed[] {
  return [
    { name: base, description: `【数据仓库/Redshift】${desc} 仅当用户选择数据仓库(Redshift)数据源时使用。`, kind: "sql", engine: "redshift", sqlTemplate: rsSql(WH_ORDERS), params },
    { name: `${base}_lake`, description: `【数据湖/Athena·S3 Tables】${desc} 仅当用户选择数据湖(Athena/S3 Tables)数据源时使用。`, kind: "sql", engine: "athena", sqlTemplate: athSql(LAKE_ORDERS), params },
  ];
}

export const GLOBAL_BI_SKILLS: GlobalSkillSeed[] = [
  ...pair(
    "top_dimension_by_metric",
    "按某维度列对某度量列排名取 Top-N（排行榜/谁最多/前几名）。适用于'各地区订单额最高的前5个''哪个地区卖得最好''哪些渠道下单最多''销量冠军''谁贡献最大''排名前十的商品''最高/最低的是哪些'等一切排名/排行/最高最低/冠军/Top-N 类问题。",
    [P.dim, P.agg, P.metric, P.topn],
    (t) => `SELECT {{dim}} AS dimension, {{agg}}({{metric}}) AS metric_value FROM ${t} GROUP BY {{dim}} ORDER BY metric_value DESC LIMIT {{topn}}`,
    (t) => `SELECT {{dim}} AS dimension, {{agg}}({{metric}}) AS metric_value FROM ${t} GROUP BY {{dim}} ORDER BY metric_value DESC LIMIT {{topn}}`
  ),
  ...pair(
    "metric_share_by_dimension",
    "计算某度量在各维度值上的占比构成（量 + 占总量百分比），按占比降序。适用于'各地区订单额占比''不同状态订单的构成比例''各渠道贡献了多少百分比''哪部分占大头''比重/占比/构成/分布'等一切占比/构成/百分比类问题。",
    [P.dim, P.aggSumCount, P.metric],
    (t) => `SELECT {{dim}} AS dimension, {{agg}}({{metric}}) AS metric_value, ROUND(100.0 * {{agg}}({{metric}}) / NULLIF(SUM({{agg}}({{metric}})) OVER (), 0), 2) AS pct_of_total FROM ${t} GROUP BY {{dim}} ORDER BY metric_value DESC`,
    (t) => `SELECT {{dim}} AS dimension, {{agg}}({{metric}}) AS metric_value, ROUND(100.0 * {{agg}}({{metric}}) / NULLIF(SUM({{agg}}({{metric}})) OVER (), 0), 2) AS pct_of_total FROM ${t} GROUP BY {{dim}} ORDER BY metric_value DESC`
  ),
  ...pair(
    "time_bucket_trend",
    "按时间分桶（day/week/month）统计度量的变化趋势。适用于'最近订单额按天走势''每月下单量趋势''这段时间的变化曲线''按周/按月/按天看''走势/趋势/变化情况'等一切时间趋势/走势类问题。基于 created_at。",
    [P.bucket, P.agg, P.metric, P.days],
    (t) => `SELECT DATE_TRUNC('{{bucket}}', created_at) AS time_bucket, {{agg}}({{metric}}) AS metric_value FROM ${t} WHERE created_at >= DATEADD(day, -{{days}}, CURRENT_DATE) GROUP BY 1 ORDER BY 1`,
    (t) => `SELECT date_trunc('{{bucket}}', created_at) AS time_bucket, {{agg}}({{metric}}) AS metric_value FROM ${t} WHERE created_at >= date_add('day', -{{days}}, current_date) GROUP BY 1 ORDER BY 1`
  ),
  ...pair(
    "period_over_period",
    "对比两个相邻时间段的度量（环比：本期 vs 上期），给出本期值/上期值/增长率。适用于'本月订单额比上月增长多少''最近30天和之前30天对比''涨了还是跌了''增长率多少''环比/同比/比上期'等一切两期对比/增长率类问题。基于 created_at。",
    [P.agg, P.metric, P.days],
    (t) => `WITH cur AS (SELECT {{agg}}({{metric}}) v FROM ${t} WHERE created_at >= DATEADD(day, -{{days}}, CURRENT_DATE)), prev AS (SELECT {{agg}}({{metric}}) v FROM ${t} WHERE created_at >= DATEADD(day, -2*{{days}}, CURRENT_DATE) AND created_at < DATEADD(day, -{{days}}, CURRENT_DATE)) SELECT cur.v AS current_period, prev.v AS previous_period, ROUND(100.0 * (cur.v - prev.v) / NULLIF(prev.v, 0), 2) AS growth_pct FROM cur, prev`,
    (t) => `WITH cur AS (SELECT {{agg}}({{metric}}) v FROM ${t} WHERE created_at >= date_add('day', -{{days}}, current_date)), prev AS (SELECT {{agg}}({{metric}}) v FROM ${t} WHERE created_at >= date_add('day', -2*{{days}}, current_date) AND created_at < date_add('day', -{{days}}, current_date)) SELECT cur.v AS current_period, prev.v AS previous_period, ROUND(100.0 * (cur.v - prev.v) / NULLIF(prev.v, 0), 2) AS growth_pct FROM cur, prev`
  ),
  ...pair(
    "filtered_aggregate",
    "对满足某等值过滤条件的记录做聚合统计。适用于'已完成状态的订单总额''华北地区有多少笔订单''某渠道的销售额''筛选出XX再算总数/总额/平均'等一切先按条件筛选再统计（多少笔/总额/均值）类问题。",
    [P.filterCol, P.filterVal, P.agg, P.metric],
    (t) => `SELECT {{agg}}({{metric}}) AS metric_value, COUNT(*) AS row_count FROM ${t} WHERE {{filter_col}} = {{filter_val}}`,
    (t) => `SELECT {{agg}}({{metric}}) AS metric_value, COUNT(*) AS row_count FROM ${t} WHERE {{filter_col}} = {{filter_val}}`
  ),
];
