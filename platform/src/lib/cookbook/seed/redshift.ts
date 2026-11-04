// 模块 44 — Redshift 工程配方 + 方言规则(平台验证过的范式)。
// 方言规则(DialectRule)是【配方库 与 dialect-guard 的共享事实源】——AI 生成前照它写,guard 落库前照它纠。
// 每条规则/配方都基于真实 Redshift 行为(已用 redshift-data API 实测,非凭记忆)。

import type { DialectRule, Recipe } from "../types";
import { noGrantToPublicRule } from "./shared-rules";

// ── Redshift 方言硬规则(命中 antiPattern = 违规;error 级由 guard 纠正/拦截)──
export const REDSHIFT_DIALECT_RULES: DialectRule[] = [
  // 🔴 L1(52 P52.1):禁止授权给 PUBLIC。规则文本与正则的唯一作者在 seed/shared-rules.ts
  // (三引擎共用一份,避免抄三份漂移)。放数组首位:它是安全类硬规则,不参与配方检索排序。
  noGrantToPublicRule("redshift"),
  {
    id: "redshift.no-ctas-if-not-exists",
    engine: "redshift",
    title: "CTAS 不支持 IF NOT EXISTS",
    rule: "Redshift 的 CREATE TABLE AS(CTAS)【不支持】IF NOT EXISTS,写了会报 syntax error at 'AS'。" +
      "要幂等建结果表,用两句:`DROP TABLE IF EXISTS <t>; CREATE TABLE <t> AS SELECT ...`。",
    // 仅匹配 CTAS 形态(IF NOT EXISTS <name> AS,后面接 SELECT/WITH),不误伤带列定义的普通 DDL。
    antiPattern: /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([^\s(]+)\s+AS\b/gi,
    fix: (script: string) =>
      script.replace(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([^\s(]+)\s+AS\b/gi,
        (_m, table) => `DROP TABLE IF EXISTS ${table};\nCREATE TABLE ${table} AS`),
    severity: "error",
  },
  {
    id: "redshift.no-create-or-replace-table",
    engine: "redshift",
    title: "无 CREATE OR REPLACE TABLE",
    rule: "Redshift 【没有】CREATE OR REPLACE TABLE 语法(那是别的库的)。用 `DROP TABLE IF EXISTS <t>; CREATE TABLE <t> AS ...`。",
    antiPattern: /CREATE\s+OR\s+REPLACE\s+TABLE\s+([^\s(]+)\s+AS\b/gi,
    fix: (script: string) =>
      script.replace(/CREATE\s+OR\s+REPLACE\s+TABLE\s+([^\s(]+)\s+AS\b/gi,
        (_m, table) => `DROP TABLE IF EXISTS ${table};\nCREATE TABLE ${table} AS`),
    severity: "error",
  },
  {
    id: "redshift.no-mysql-backtick",
    engine: "redshift",
    title: "标识符用双引号不是反引号",
    rule: "Redshift 标识符引用用【双引号】\"col\",不是 MySQL 的反引号 `col`。一般小写标识符可不引用。",
    antiPattern: /`[^`]+`/g,
    fix: (script: string) => script.replace(/`([^`]+)`/g, '"$1"'),
    severity: "error",
  },
  {
    id: "redshift.date-funcs",
    engine: "redshift",
    title: "日期函数用 DATEADD/DATEDIFF/DATE_TRUNC",
    rule: "Redshift 日期运算用 DATEADD(day,-7,d)/DATEDIFF(day,a,b)/DATE_TRUNC('month',d);" +
      "【避免】MySQL 的 DATE_SUB/DATE_ADD/NOW()(用 GETDATE() 或 CURRENT_DATE)。",
    severity: "warn",
  },
  {
    // error 且【无 fix】=不可机械纠正,只能阻断(不能替用户猜 WHERE 条件)。这是危险全表操作,本就该拦。
    id: "redshift.no-unfiltered-delete-truncate",
    engine: "redshift",
    title: "禁止无条件 DELETE / TRUNCATE 目标表(防误删全表)",
    rule: "DELETE 不带 WHERE 或 TRUNCATE 会清空整表数据,极危险。若确需全量重建,用 DROP TABLE IF EXISTS + CREATE TABLE AS;" +
      "增量更新必须带 WHERE 限定范围。平台拦截无条件 DELETE/TRUNCATE,请补条件或改用重建范式。",
    // 匹配 DELETE FROM <表>(其后无 WHERE 直接分号/结尾)或 TRUNCATE。无 fix → 阻断(不能替用户造 WHERE)。
    antiPattern: /\b(TRUNCATE\s+(TABLE\s+)?[^\s;]+|DELETE\s+FROM\s+[^\s;]+\s*;)/gi,
    severity: "error",
  },
  {
    // 【纯说明规则,无 antiPattern】—— OID 错是运行期并发/缓存一致性问题,没有固定"错误写法"可正则匹配,
    // 故不做 guard 检测,只在 codegen 前注入提示词,让 AI 从源头用事务包裹的幂等重建范式,避开并发窗口。
    // 真实来源:2026-07-25 R3 验证,ROI 结果表 DROP+CTAS 与同步作业 overwrite(DELETE+重建同名下游表)
    //   并发,当前会话缓存的 relation OID 已被另一会话删除 → DROP TABLE IF EXISTS 报
    //   "could not open relation with OID <n>",后续 CTAS 被 ABORTED("prior query failed")。
    id: "redshift.ctas-oid-concurrency",
    engine: "redshift",
    title: "结果表重建避免并发 OID 失效(DROP+CTAS 包进事务/避开同步窗口)",
    rule: "报错 `could not open relation with OID <n>` = 目标表正被【另一会话/同步作业并发重建或删除】" +
      "(如离线 ETL 的 DROP+CTAS 撞上同步作业对同名下游表的 overwrite),当前会话缓存的表 OID 已失效。" +
      "应对:①把 `DROP TABLE IF EXISTS <t>; CREATE TABLE <t> AS ...` 包进 `BEGIN; ... COMMIT;` 事务" +
      "(DROP 与 CREATE 原子提交,别的会话看到的要么是旧表要么是新表,不会撞到中间态);" +
      "②依赖上游同步的结果表,务必在【同步作业成功落地后】再触发计算,不要与同步并发跑;" +
      "③偶发并发失败可安全重试(该错误是瞬时并发态,重跑即好——本平台离线任务已支持 rerun)。",
    // 无 antiPattern / 无 fix:并发时序问题非语法错,靠"生成前照范式写"根治,不靠"落库前正则纠"。
    severity: "warn",
  },
  {
    // 【纯说明规则,无 antiPattern】—— 真实来源:2026-07-30 无头验证坐实。数据同步向导让用户填
    //   SORTKEY/DISTKEY,预览 DDL(generateDDL)拼了,但 Glue 执行脚本建表曾是裸 `CREATE TABLE (...)`
    //   → 用户配的排序键/分布键【预览可见、实际建表丢失】(预览承诺≠执行)。且旧逻辑对 distStyle=key
    //   但没填 distKey 会误输出 `DISTSTYLE KEY`(Redshift 无此语法 → 建表报错)。已在 glue-script-generator
    //   的 buildRedshiftTableClause 根治,此处沉淀为"AI 生成 Redshift 建表 DDL"的方言。
    id: "redshift.create-table-distkey-sortkey",
    engine: "redshift",
    title: "建表要真正带上 DISTKEY/SORTKEY(且 DISTSTYLE KEY 必须配 DISTKEY 列)",
    rule: "生成 Redshift `CREATE TABLE` 时,若配了分布/排序键,DDL 必须真正拼上,别只在预览里拼、执行时丢" +
      "(预览承诺≠执行=典型死字段)。规则:①DISTSTYLE=key 时【必须】同时给 `DISTKEY(列)`——" +
      "Redshift 没有裸 `DISTSTYLE KEY` 语法,单写它会建表语法错;没有明确 distKey 就别用 key 分布(退回 AUTO)。" +
      "②DISTSTYLE=auto 时【不要】拼 DISTKEY/DISTSTYLE(交给 Redshift 自动按表大小选 ALL/EVEN/KEY)。" +
      "③SORTKEY 支持多列 `SORTKEY(col1, col2)`;若排序键配置是逗号分隔字符串,先 split 去空再拼,别对字符串直接" +
      "按数组 join(会逐字符裂开)。④DISTKEY/DISTSTYLE 放列定义后、SORTKEY 之前。",
    // 无 antiPattern / 无 fix:是"该拼没拼"的遗漏 + 语义组合约束,非固定错误正则,靠生成前照规则写根治。
    severity: "warn",
  },
];

// ── Redshift 配方(验证过的范式;AI 命中 capability 时照此写)──
export const REDSHIFT_RECIPES: Recipe[] = [
  {
    id: "redshift.ctas-aggregate",
    engine: "redshift",
    capability: "ctas-aggregate",
    title: "聚合/JOIN 结果落成结果表(CTAS 幂等重建)",
    whenToUse: "把多表 JOIN + 聚合的结果(如 ROI、转化率、留存、GMV 汇总)落成一张可复用的结果表时。",
    template: [
      "-- 幂等重建结果表(Redshift CTAS 不支持 IF NOT EXISTS,必须 DROP + CREATE AS)。",
      "-- DROP + CREATE 包进事务:原子提交,避免与同步作业并发重建同名表时撞 OID 失效",
      "-- (报 could not open relation with OID)。",
      "BEGIN;",
      "DROP TABLE IF EXISTS public.<result_table>;",
      "CREATE TABLE public.<result_table> AS",
      "SELECT",
      "  a.<dim_col>,",
      "  SUM(b.<measure_col>)                          AS total_measure,",
      "  CASE WHEN a.<cost_col> > 0",
      "       THEN (COALESCE(SUM(b.<measure_col>),0) - a.<cost_col>) / a.<cost_col>",
      "       ELSE NULL END                            AS ratio,",
      "  CURRENT_TIMESTAMP                             AS calculated_at",
      "FROM public.<fact_a> a",
      "LEFT JOIN public.<fact_b> b ON a.<key> = b.<key>",
      "GROUP BY a.<dim_col>, a.<cost_col>;",
      "COMMIT;",
    ].join("\n"),
    dialectNotes: [
      "CTAS 严禁 IF NOT EXISTS → 用 DROP TABLE IF EXISTS + CREATE TABLE AS。",
      "DROP+CTAS 包进 BEGIN/COMMIT 事务:原子提交,防与上游同步作业并发重建同名表撞 OID 失效" +
        "(could not open relation with OID);且结果表要在同步落地后再算,别与同步并发跑(见 ctas-oid-concurrency 规则)。",
      "除零防护用 CASE WHEN cost>0;NULL 用 COALESCE 兜底。",
      "所有表名/列名必须来自 discover_catalog 真实返回,不要猜。",
    ],
    tags: ["aggregate", "roi", "roas", "conversion", "retention", "gmv", "join", "ctas"],
  },
  {
    id: "redshift.upsert-merge",
    engine: "redshift",
    capability: "upsert",
    title: "增量 UPSERT(staging + DELETE + INSERT 事务)",
    whenToUse: "往已有结果表增量合并数据(有则更新、无则插入)时。Redshift 无原生 MERGE 的通用做法。",
    template: [
      "BEGIN;",
      "-- 1) 删除将被新数据覆盖的旧行(按主键)",
      "DELETE FROM public.<target> USING public.<staging> s WHERE public.<target>.<pk> = s.<pk>;",
      "-- 2) 插入新数据",
      "INSERT INTO public.<target> SELECT * FROM public.<staging>;",
      "COMMIT;",
    ].join("\n"),
    dialectNotes: [
      "包在 BEGIN/COMMIT 事务里保证原子性。",
      "Redshift 新版支持 MERGE INTO,但 staging+DELETE+INSERT 兼容性最稳。",
    ],
    tags: ["upsert", "merge", "incremental", "增量"],
  },
  {
    id: "redshift.window-analytics",
    engine: "redshift",
    capability: "window",
    title: "窗口函数(排名/占比/环比)",
    whenToUse: "算排名、组内占比、环比同比、累计等分析型指标时。",
    template: [
      "SELECT",
      "  <dim>,",
      "  <measure>,",
      "  RANK()  OVER (ORDER BY <measure> DESC)                    AS rnk,",
      "  <measure> * 1.0 / SUM(<measure>) OVER ()                  AS pct_of_total,",
      "  LAG(<measure>) OVER (PARTITION BY <grp> ORDER BY <time>)  AS prev_period",
      "FROM public.<table>;",
    ].join("\n"),
    dialectNotes: ["整数相除要 *1.0 转浮点(否则整除截断)。"],
    tags: ["window", "rank", "占比", "环比", "同比", "累计", "analytics"],
  },
  // ── 以下 4 条为模块45 P45.2 高频配方,均在临时环境用真实表(players/payments/ad_events/game_sessions)
  //    通过 redshift-data API【真跑 FINISHED 验证过】才入库(verifiedAt),非凭大模型记忆。──
  {
    id: "redshift.scd2-history",
    engine: "redshift",
    capability: "scd2",
    title: "拉链表 / 缓变维 SCD2(历史版本追踪)",
    whenToUse: "维度属性会变(如用户等级/渠道/状态),要保留每个版本的生效区间与当前标记时。数仓最高频建模范式之一。",
    template: [
      "-- SCD2 拉链表:每个实体每次属性变化产生一条,带 effective_date/end_date/is_current",
      "-- (Redshift 无 CTAS IF NOT EXISTS,幂等用 DROP+CREATE AS;用 LEAD 取下一次变化时点)",
      "-- DROP+CTAS 包进 BEGIN/COMMIT 事务:原子提交,防并发/重跑撞 OID 失效(见 ctas-oid-concurrency)。",
      "BEGIN;",
      "DROP TABLE IF EXISTS public.<dim_table>_scd2;",
      "CREATE TABLE public.<dim_table>_scd2 AS",
      "WITH ranked AS (",
      "  SELECT <pk>, <attr_cols>, <change_time>,",
      "         LEAD(<change_time>) OVER (PARTITION BY <pk> ORDER BY <change_time>) AS next_change",
      "  FROM public.<source_table>",
      ")",
      "SELECT <pk>, <attr_cols>,",
      "       <change_time>::date                                        AS effective_date,",
      "       COALESCE((next_change - INTERVAL '1 day')::date, DATE '9999-12-31') AS end_date,",
      "       CASE WHEN next_change IS NULL THEN 1 ELSE 0 END             AS is_current",
      "FROM ranked;",
      "COMMIT;",
    ].join("\n"),
    dialectNotes: [
      "幂等用 DROP TABLE IF EXISTS + CREATE TABLE AS(CTAS 不支持 IF NOT EXISTS)。",
      "DROP+CTAS 必须包进 BEGIN/COMMIT 事务:原子提交,防并发/重跑撞 OID 失效(见 ctas-oid-concurrency)。",
      "开区间用 LEAD 取下一次变化;当前版本 end_date 兜底 DATE '9999-12-31'、is_current=1。",
      "日期运算用 INTERVAL '1 day' 与 ::date 转型(非 MySQL DATE_SUB)。",
    ],
    tags: ["scd2", "拉链表", "缓变维", "dimension", "history", "版本", "is_current"],
    verifiedAt: "2026-07-18",
    engineVersion: "redshift-serverless",
  },
  {
    id: "redshift.time-rollup",
    engine: "redshift",
    capability: "time-rollup",
    title: "时间维度汇总(按日/月 + DATE_TRUNC 分桶)",
    whenToUse: "把明细按日/周/月滚动汇总成事实表(如日 GMV、月活、ARPPU)时。报表/大盘最常用。",
    template: [
      "-- DROP+CTAS 包进事务:原子提交,防并发/重跑撞 OID 失效(见 ctas-oid-concurrency)。",
      "BEGIN;",
      "DROP TABLE IF EXISTS public.<fact_daily>;",
      "CREATE TABLE public.<fact_daily> AS",
      "SELECT DATE_TRUNC('day', <time_col>)::date   AS stat_date,",
      "       DATE_TRUNC('month', <time_col>)::date AS stat_month,",
      "       COUNT(DISTINCT <entity>)              AS uv,",
      "       COUNT(*)                              AS cnt,",
      "       SUM(<measure>)                        AS total_measure,",
      "       SUM(<measure>) * 1.0 / NULLIF(COUNT(DISTINCT <entity>), 0) AS avg_per_entity",
      "FROM public.<source_table>",
      "GROUP BY 1, 2;",
      "COMMIT;",
    ].join("\n"),
    dialectNotes: [
      "DROP+CTAS 必须包进 BEGIN/COMMIT 事务:原子提交,防并发/重跑撞 OID 失效(见 ctas-oid-concurrency)。",
      "DATE_TRUNC('day'|'week'|'month', ts)::date 分桶(非 MySQL DATE_FORMAT)。",
      "求均值防除零/整除:* 1.0 转浮点 + NULLIF(分母,0)。",
    ],
    tags: ["time", "rollup", "汇总", "date_trunc", "按日", "按月", "gmv", "活跃", "分区"],
    verifiedAt: "2026-07-18",
    engineVersion: "redshift-serverless",
  },
  {
    id: "redshift.dedup-latest",
    engine: "redshift",
    capability: "dedup",
    title: "去重取最新(ROW_NUMBER 分组取一)",
    whenToUse: "同一主键有多条记录,要每个主键只保留最新/最优一条(如设备最近一次事件、订单最新状态)时。",
    template: [
      "-- DROP+CTAS 包进事务:原子提交,防并发/重跑撞 OID 失效(见 ctas-oid-concurrency)。",
      "BEGIN;",
      "DROP TABLE IF EXISTS public.<target>;",
      "CREATE TABLE public.<target> AS",
      "SELECT <keep_cols>",
      "FROM (",
      "  SELECT <keep_cols>,",
      "         ROW_NUMBER() OVER (PARTITION BY <pk> ORDER BY <time_col> DESC) AS rn",
      "  FROM public.<source_table>",
      ") t",
      "WHERE rn = 1;",
      "COMMIT;",
    ].join("\n"),
    dialectNotes: [
      "DROP+CTAS 必须包进 BEGIN/COMMIT 事务:原子提交,防并发/重跑撞 OID 失效(见 ctas-oid-concurrency)。",
      "ROW_NUMBER() OVER (PARTITION BY 主键 ORDER BY 时间 DESC) 取 rn=1 = 每键最新。",
      "去重计数用 COUNT(DISTINCT col);超大基数可用 APPROXIMATE COUNT(DISTINCT col) 提速。",
    ],
    tags: ["dedup", "去重", "row_number", "最新", "distinct", "清洗"],
    verifiedAt: "2026-07-18",
    engineVersion: "redshift-serverless",
  },
  {
    id: "redshift.retention-funnel",
    engine: "redshift",
    capability: "retention",
    title: "留存 / 漏斗 / 同环比(自连接 + DATEDIFF)",
    whenToUse: "算次日/7日留存、转化漏斗、同比环比等运营分析指标时。",
    template: [
      "-- 次日留存示例:安装当天 vs 次日是否有活跃行为",
      "-- DROP+CTAS 包进事务:原子提交,防并发/重跑撞 OID 失效(见 ctas-oid-concurrency)。",
      "BEGIN;",
      "DROP TABLE IF EXISTS public.<fact_retention>;",
      "CREATE TABLE public.<fact_retention> AS",
      "WITH base AS (",
      "  SELECT <entity>, <install_time>::date AS install_date FROM public.<entity_table>",
      "),",
      "d1 AS (",
      "  SELECT DISTINCT b.<entity>",
      "  FROM base b",
      "  JOIN public.<activity_table> a ON a.<entity> = b.<entity>",
      "   AND DATEDIFF(day, b.install_date, a.<activity_time>::date) = 1",
      ")",
      "SELECT b.install_date,",
      "       COUNT(DISTINCT b.<entity>)                                   AS cohort,",
      "       COUNT(DISTINCT d1.<entity>)                                  AS retained,",
      "       COUNT(DISTINCT d1.<entity>) * 1.0 / NULLIF(COUNT(DISTINCT b.<entity>),0) AS retention_rate",
      "FROM base b LEFT JOIN d1 ON d1.<entity> = b.<entity>",
      "GROUP BY b.install_date ORDER BY b.install_date;",
      "COMMIT;",
    ].join("\n"),
    dialectNotes: [
      "DROP+CTAS 必须包进 BEGIN/COMMIT 事务:原子提交,防并发/重跑撞 OID 失效(见 ctas-oid-concurrency)。",
      "日期间隔用 DATEDIFF(day, a, b)(非 MySQL DATEDIFF(a,b) 两参);留存窗口改 =1/=6/=29。",
      "同比环比用 LAG(measure) OVER (ORDER BY period);比率一律 *1.0 + NULLIF 防除零。",
    ],
    tags: ["retention", "留存", "funnel", "漏斗", "同比", "环比", "datediff", "cohort", "转化"],
    verifiedAt: "2026-07-18",
    engineVersion: "redshift-serverless",
  },
];
