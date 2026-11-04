// 业务口径/术语/规则「一键预置」的 global 单一事实源(所有项目/用户开箱即用)。
//
// Why: 「业务口径与规则」页(app/knowledge)此前无任何数据,空库对新用户毫无引导价值,且
// GenBI Agent 的 lookup_business_context 技能 / 代码生成 grounding 查不到任何口径。
//
// 设计(面向全球用户,高度抽象):这里的条目是**任何数据团队都通用**的行业标准口径/术语/规则
// (GMV、活跃用户、留存、金额单位、测试数据排除、时区、软删除…),而非某个业务域(游戏/电商)
// 专属。故全部落 global 作用域——所有项目开箱即用;各项目再按需在页面追加自己的专属口径。
// 与 global-skills-seed.ts 完全对称:本文件是单一事实源,POST /api/genbi/context/seed 幂等
// upsert(按 kind+title 去重)。账号轮换/环境重建后 seed 一次即恢复。
//
// 保持中立:不假设具体表名/列名(那是各项目的事),口径用通用表述并给出「如何落到 SQL」的提示,
// 让 Agent 生成 SQL 时遵循正确口径而非猜测。

import type { ContextKind } from "./context";

export interface GlobalContextSeed {
  kind: ContextKind;
  title: string;
  body: string;
  scope?: string;
  tags?: string[];
}

export const GLOBAL_CONTEXT_SEEDS: GlobalContextSeed[] = [
  // ── 口径 / 指标定义 (caliber) ──────────────────────────────────────────────
  {
    kind: "caliber",
    title: "GMV（成交总额）",
    body: "GMV = 已成功支付订单的金额合计，口径上通常按下单时间归属。计算时只统计支付成功的订单（如 status='paid'/'completed'），排除已取消、退款、未支付的订单；除非特别说明，含税、含运费。若需「净 GMV」则再减去退款金额。",
    scope: "订单 / 交易",
    tags: ["GMV", "口径", "金额", "交易"],
  },
  {
    kind: "caliber",
    title: "活跃用户（DAU / MAU）",
    body: "DAU=某自然日内有过核心行为（如登录/下单/使用）的去重用户数；MAU=某自然月内的去重活跃用户数。按去重用户计（同一用户当日多次行为只算 1）。核心行为的定义随业务而定，需与业务方对齐；分析时排除内部测试账号与机器人流量。",
    scope: "用户 / 活跃",
    tags: ["DAU", "MAU", "活跃用户", "去重"],
  },
  {
    kind: "caliber",
    title: "留存率（次日 / 7 日 / 30 日）",
    body: "N 日留存率 = 首次行为（注册/激活）后第 N 日仍有活跃行为的用户数 ÷ 当期首次行为用户数。次日留存的 N=1。分母是「同一批新用户」（同一注册日的 cohort），分子是这批人第 N 日的回访去重数。留存必须按 cohort（首次行为日）分组，不能跨 cohort 混算。",
    scope: "用户 / 留存",
    tags: ["留存", "cohort", "次日留存"],
  },
  {
    kind: "caliber",
    title: "客单价（AOV）",
    body: "AOV（平均订单价值）= 成交金额合计 ÷ 成交订单数。分子分母口径必须一致：都只取支付成功的订单。不要用「金额合计 ÷ 用户数」（那是 ARPU，不是客单价）。",
    scope: "订单 / 交易",
    tags: ["AOV", "客单价", "口径"],
  },
  {
    kind: "caliber",
    title: "转化率（Conversion Rate）",
    body: "转化率 = 完成目标行为的数量 ÷ 进入漏斗的数量，需明确分子分母所处漏斗层级（如 下单转化率=下单数÷访问数，支付转化率=支付数÷下单数）。同一分析里的分子分母口径与时间窗口必须一致，避免跨期错配。",
    scope: "漏斗 / 转化",
    tags: ["转化率", "漏斗", "口径"],
  },
  {
    kind: "caliber",
    title: "环比 / 同比",
    body: "环比 = （本期 − 上期）÷ 上期，相邻两期比较（如本月 vs 上月）。同比 = （本期 − 去年同期）÷ 去年同期，用于消除季节性。计算时注意期长一致（整月对整月），并处理上期为 0 或空的情况避免除零。",
    scope: "趋势分析",
    tags: ["环比", "同比", "增长率"],
  },

  // ── 术语 / 别名 (term) ────────────────────────────────────────────────────
  {
    kind: "term",
    title: "金额单位（分 vs 元）",
    body: "很多交易系统的金额列以「分」为整数存储以避免浮点误差。若某金额列单位是分，展示与聚合结果需除以 100 换算成元。落 SQL 时对该列做 SUM 后再 /100.0，或在展示层换算——务必与该表的实际单位对齐后再算，不要想当然按元处理。",
    scope: "金额字段",
    tags: ["金额", "单位", "分", "元"],
  },
  {
    kind: "term",
    title: "时区（UTC vs 本地时间）",
    body: "数据仓库时间戳常以 UTC 存储，而业务看板通常要求本地时区（如北京时间 UTC+8）。按「自然日/自然月」聚合前先把时间戳转换到目标时区再 DATE_TRUNC，否则跨零点的记录会归错日期导致日报对不上。",
    scope: "时间字段",
    tags: ["时区", "UTC", "日期"],
  },
  {
    kind: "term",
    title: "维度 vs 度量",
    body: "维度（dimension）是用来分组/切分的定性属性（地区、渠道、状态、日期）；度量（measure/metric）是可聚合的数值（金额、数量、时长）。「按 X 看 Y」中 X 通常是维度、Y 是度量。生成 SQL 时维度放 GROUP BY，度量放聚合函数。",
    scope: "通用建模",
    tags: ["维度", "度量", "建模"],
  },

  // ── 规则 / 注意事项 (rule) ─────────────────────────────────────────────────
  {
    kind: "rule",
    title: "排除测试数据",
    body: "分析生产指标时必须排除测试/演示数据。常见标记：邮箱/名称含 test、demo、qa，或有专门的测试标记列/前缀（如 QAREG 开头）。若表中存在 is_test/environment 之类的列，应加过滤条件排除非生产数据，避免测试单污染 GMV、用户数等口径。",
    scope: "数据质量",
    tags: ["测试数据", "排除", "数据质量"],
  },
  {
    kind: "rule",
    title: "软删除（逻辑删除）",
    body: "很多表用软删除：记录不物理删除，而是置 is_deleted=true 或写 deleted_at 时间戳。查询有效数据时必须过滤掉已软删除的行（is_deleted=false 或 deleted_at IS NULL），否则会把已删除数据计入统计。",
    scope: "数据质量",
    tags: ["软删除", "逻辑删除", "过滤"],
  },
  {
    kind: "rule",
    title: "去重与唯一性",
    body: "涉及「用户数」「订单数」等计数指标时注意去重：明细表 JOIN 后可能出现行放大，直接 COUNT(*) 会重复计数。应对主键用 COUNT(DISTINCT id)，或先在子查询里聚合到正确粒度再计数。",
    scope: "数据质量",
    tags: ["去重", "唯一性", "COUNT DISTINCT"],
  },
  {
    kind: "rule",
    title: "NULL 值处理",
    body: "聚合与过滤要考虑 NULL：SUM/AVG 会忽略 NULL，但 COUNT(col) 也不计 NULL（COUNT(*) 才计）。等值/不等值过滤（=、<>）不会匹配 NULL，需要用 IS NULL / IS NOT NULL。做占比分母时排除 NULL 以免口径偏差。",
    scope: "数据质量",
    tags: ["NULL", "空值", "聚合"],
  },
];
