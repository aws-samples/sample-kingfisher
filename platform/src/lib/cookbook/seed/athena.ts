// Athena / Trino SQL 工程配方 + 方言规则。平台用 Athena 查 S3 Tables(托管 Iceberg)。
//
// ⚠️ 验证纪律(红线):本文件规则的 antiPattern/fix 逻辑靠单测保证;方言【事实】依据平台【已在生产
// 使用、验证过】的 GenBI 提示词(lib/genbi/prompt.ts 的 Trino 方言指导:三段式限定名、双引号别名等)。
// 每条【配方 template】入库前须在临时环境真跑 Athena 确认(verifiedAt);未真跑前不标 verifiedAt。
//
// Trino(Athena)方言与 Redshift 的关键差异(适合 guard 正则检测的):
//  · 标识符引用用【双引号】"col"(与 Redshift 同;但【严禁反引号】`col`——反引号在 Trino 是语法错)。
//  · 字符串字面量用【单引号】'str'(双引号是标识符,写反了报错)。
//  · 日期差用 date_diff('day', a, b)(不是 Redshift 的 DATEDIFF(day,a,b),也不是 MySQL 的 DATEDIFF(a,b))。
//  · 近似去重计数 approx_distinct(col)(Trino 特有,比 COUNT(DISTINCT) 快)。
//  · 表用三段式联邦限定名 "s3tablescatalog/<bucket>"."<ns>"."<table>"(GenBI 提示词已固化)。

import type { DialectRule, Recipe } from "../types";

export const ATHENA_DIALECT_RULES: DialectRule[] = [
  {
    // Trino 标识符引用用双引号;反引号是语法错(与 MySQL 相反)。这是能 fix 的真实方言违规。
    id: "athena.no-backtick-identifier",
    engine: "athena",
    title: "Trino 标识符用双引号,禁反引号",
    rule: "Athena(Trino)标识符引用用【双引号】\"col\",【严禁】MySQL 的反引号 `col`(Trino 会报语法错)。" +
      "字符串字面量用单引号 'str'。",
    antiPattern: /`[^`]+`/g,
    fix: (code: string) => code.replace(/`([^`]+)`/g, '"$1"'),
    severity: "error",
  },
  {
    // MySQL/Redshift 式 DATEDIFF 在 Trino 不存在,须用 date_diff('unit', a, b)。无 fix(参数顺序/单位需人工)→ 提示。
    id: "athena.date-diff-trino",
    engine: "athena",
    title: "日期差用 date_diff('unit', a, b)",
    rule: "Athena(Trino)日期差用 date_diff('day', from, to)(注意单位是第一个参数、带引号);" +
      "【避免】Redshift 的 DATEDIFF(day,a,b) 或 MySQL 的 DATEDIFF(a,b)。日期加减用 date_add('day', n, ts)。",
    // 检测 DATEDIFF( (无下划线、Redshift/MySQL 式)——Trino 是 date_diff(。masked 后匹配,不误伤字符串。
    antiPattern: /\bDATEDIFF\s*\(/gi,
    severity: "warn",
  },
  {
    // 🔴🔴 (2026-10-01 无头实测):us-west-2 视角问数 ⇒ 10 条 Athena 查询**全部**
    //   打在主控区工作组、目录引用写的是主控区表桶,答案是主控区的数据(页面照样说「在 us-west-2」)。
    //   根因之一就是提示词 / 示例里写死了主控区目录名,模型照抄。⇒ 生成前把「三样必须同区」教给所有 AI 路径。
    // 纯引导文案(无 antiPattern):目录名在双引号标识符里且主控区本就合法,正则判不出「是不是别的区的」。
    id: "athena.catalog-workgroup-same-region",
    engine: "athena",
    title: "多区:目录引用 / 工作组 / 客户端 region 三样必须是同一个区",
    rule: "S3 Tables 的 Athena 目录引用 \"s3tablescatalog/<表桶>\" **每个区不同**(各区有自己的表桶),必须用平台给出的**本区**目录引用" +
      "(问数提示词 / 作业落点里的 catalogRef),【严禁】照抄示例或别的区的表桶名;Athena 工作组与客户端 region 也必须是同一个区。" +
      "三样任一取错都**不报错**:要么查到别的区的数据,要么在本区跑一条打不到表的查询。",
    severity: "warn",
  },
];

export const ATHENA_RECIPES: Recipe[] = [
  {
    // ⚠️ template 待真跑 Athena 验证后补 verifiedAt(红线:不凭记忆入库)。
    id: "athena.s3tables-select",
    engine: "athena",
    capability: "athena-query",
    title: "Athena 查 S3 Tables(三段式联邦限定名 + Trino 方言)",
    whenToUse: "用 Athena 查询 S3 Tables(Iceberg)数据、做聚合分析时。",
    template: [
      "-- Athena 查 S3 Tables:三段式联邦目录限定名(含双引号),Trino 方言",
      "SELECT",
      "  region,",
      "  approx_distinct(user_id)                       AS uv,   -- Trino 近似去重,比 COUNT(DISTINCT) 快",
      "  SUM(amount)                                    AS gmv,",
      "  date_diff('day', MIN(event_time), MAX(event_time)) AS span_days  -- Trino: 单位在前、带引号",
      'FROM "s3tablescatalog/<table-bucket>"."<namespace>"."<table>"',
      "WHERE event_time >= date_add('day', -7, current_date)",
      "GROUP BY region",
      "ORDER BY gmv DESC",
      "LIMIT 100;",
    ].join("\n"),
    dialectNotes: [
      "表用三段式 \"s3tablescatalog/<bucket>\".\"<ns>\".\"<table>\"(双引号,不是反引号)。",
      "字符串单引号、标识符/别名双引号;日期差 date_diff('day',a,b) 单位在前。",
      "近似去重 approx_distinct(col);探索表先小 LIMIT 控扫描量。",
    ],
    tags: ["athena", "trino", "s3table", "iceberg", "查询", "湖查询", "聚合", "select"],
    // verifiedAt 待真跑 Athena 确认后补
  },
];
