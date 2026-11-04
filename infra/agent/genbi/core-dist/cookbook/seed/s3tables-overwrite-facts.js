"use strict";
// seed — 「S3 Tables(Iceberg)结果表怎么**原子地**整表 / 按分区覆盖」的**唯一作者**(规则文本 + 反例判据)。
//
// 🔴 把平台自己的同步脚本生成器(lib/sync/glue-script-generator.ts)从「先 DELETE 再 INSERT
//   两次提交」改成「INSERT OVERWRITE 一次提交 + 读到 0 行拒绝清空 + 写后对数」。配方库却还在教另一半 AI 生成路径
//   (规划大脑 / Copilot / 作业开发 AI 生成)**先 drop 表再 createOrReplace**:
//     spark.sql(f'DROP TABLE IF EXISTS {TARGET}')            ← 多余且有害
//     df.writeTo(TARGET).using('iceberg').createOrReplace()  ← 本身就是原子的 REPLACE TABLE … AS SELECT
//   drop 之后到新表提交之间是一段「没有这张表」的窗口;drop 成功而写入失败(源读不到 / 类型不合 / 容量)⇒ 表**没了**,
//   下游第二天的作业全红,而重跑一次才可能回来。这正是「非原子覆盖」—— 与修掉的是同一类缺陷,只是长在配方里。
// ⇒ 规则文本与 antiPattern 在这里写**一次**,emr / glue / s3tables 三个引擎各实例化一份(与 shared-rules.ts、
//   warehouse-facts.ts 同形:加引擎 = 那个引擎的 seed 文件多一行,不改本文件)。
Object.defineProperty(exports, "__esModule", { value: true });
exports.DROP_BEFORE_S3TABLES_WRITE_RULE_SUFFIX = exports.DROP_BEFORE_S3TABLES_WRITE_PATTERN = exports.S3TABLES_ATOMIC_OVERWRITE_HOWTO = void 0;
exports.noDropBeforeS3TablesWriteRule = noDropBeforeS3TablesWriteRule;
/** 整表 / 按分区**原子**覆盖 Iceberg(S3 Tables)表的唯一写法(规则 / 模板 / 提示词共用一份文本)。 */
exports.S3TABLES_ATOMIC_OVERWRITE_HOWTO = "① 表不存在 ⇒ `CREATE TABLE <t> USING iceberg … AS SELECT`(一次提交);" +
    "② 整表覆盖 ⇒ `spark.conf.set('spark.sql.sources.partitionOverwriteMode','static')` 后 `INSERT OVERWRITE <t> SELECT <按目标列名排好的列> FROM src`," +
    "或 `df.writeTo(<t>).overwrite(F.lit(True))`;" +
    "③ 只替换本批涉及的分区 ⇒ `partitionOverwriteMode=dynamic` + `INSERT OVERWRITE`,或 `df.writeTo(<t>).overwritePartitions()`;" +
    "④ 读到 0 行**默认不覆盖**(直接失败说明原因,显式允许才清空);⑤ 写完 `COUNT(*)` 与本次读到的行数对账,不一致即失败;" +
    "⑥ 写进已有表按**列名**对齐(`cols = spark.table(<t>).columns` 再 `SELECT {', '.join(cols)}`),不要按位置 `SELECT *`。" +
    "`createOrReplace()` / `CREATE OR REPLACE TABLE … AS SELECT` 本身就是原子的 REPLACE,**不要先 drop 表**。";
/**
 * 命中 = 对**同一张**表「先 drop、再(重)建 / 写入」—— 三种形态(大小写不敏感、跨行;两条语句之间最多 1200 字符):
 *  ① f-string 变量名:`DROP TABLE [IF EXISTS] {T}` … `writeTo(T)` / `CREATE OR REPLACE TABLE {T}` / `CREATE TABLE {T} … USING iceberg`;
 *  ② 字面表名(任意 catalog):`DROP TABLE [IF EXISTS] c.ns.t` … `writeTo('c.ns.t')` / `CREATE OR REPLACE TABLE c.ns.t`
 *     (这两种写法只有 Spark / Iceberg 才有,drop 对它们纯属多余);
 *  ③ 字面 `s3tablescatalog.ns.t`:`DROP TABLE [IF EXISTS] s3tablescatalog.ns.t` … `CREATE TABLE s3tablescatalog.ns.t` / `INSERT INTO|OVERWRITE s3tablescatalog.ns.t`。
 * 🔴 刻意**不**命中 Redshift 的 `DROP TABLE IF EXISTS public.t; CREATE TABLE public.t AS SELECT`(Glue / EMR 脚本经 redshift-data 发给数仓的
 *    SQL;Redshift 没有 CREATE OR REPLACE TABLE,DROP+CTAS 包进 BEGIN/COMMIT 就是它的正解,见 redshift.ctas-aggregate)——
 *    形态 ① 要求 writeTo / CREATE OR REPLACE / USING iceberg 之一,形态 ③ 要求 s3tablescatalog 前缀,所以数仓 SQL 不会被误咬。
 * 🔴 target=code ⇒ guard 在**原文**上扫(含注释)。配方模板里讲「别先 drop」要用中文「drop 表」,别把 `DROP TABLE <名>` 写进注释。
 */
exports.DROP_BEFORE_S3TABLES_WRITE_PATTERN = new RegExp([
    // ① 变量名
    String.raw `(?:\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?\{(\w+)\}[\s\S]{0,1200}?` +
        String.raw `(?:writeTo\(\s*\1\s*\)|\bCREATE\s+OR\s+REPLACE\s+TABLE\s+\{\1\}|\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\{\1\}[^;]{0,600}?\bUSING\s+iceberg\b))`,
    // ② 字面名 + Spark/Iceberg 独有的原子写法
    String.raw `(?:\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][\w$]*(?:\.[\w$]+){1,2})[\s\S]{0,1200}?` +
        String.raw `(?:writeTo\(\s*f?['"]\2['"]|\bCREATE\s+OR\s+REPLACE\s+TABLE\s+\2\b))`,
    // ③ 字面 s3tablescatalog 三段名 + 普通建表 / 写入
    String.raw `(?:\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(s3tablescatalog\.[\w$]+\.[\w$]+)[\s\S]{0,1200}?` +
        String.raw `\b(?:CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?|INSERT\s+(?:INTO|OVERWRITE)\s+(?:TABLE\s+)?)\3\b)`,
].join("|"), "i");
exports.DROP_BEFORE_S3TABLES_WRITE_RULE_SUFFIX = "no-drop-before-s3tables-write";
/**
 * 生成某引擎的「S3 Tables 结果表禁止先 drop 再建 / 写」方言规则。
 *
 * - `target: "code"` ⇒ 只检测不改写(删一条语句要判断它是否被 try / 事务 / 字符串包着 —— 正则改写就是在造新 bug)。
 * - 🔴 `severity: "warn"` 不是 error:老配方(2026-07-29 ~ 2026-10-12)教出来的存量 EMR / Glue 作业带着这一行是**能跑的**,
 *   error 会让 `job-service.ts` / `engines/emr/provider.ts` 在运行前把用户正在用的作业**拦停** —— 与 warehouse-facts.ts
 *   的 no-hardcoded-warehouse 同一条理由。warn 的作用:生成前进 lookup_recipe / codegen 提示词(【建议】),
 *   生成后 / 保存前页面「检出 N 处方言问题」把它标出来。要改成运行前硬拦只需把这里改成 error(判据同步改一处)。
 */
function noDropBeforeS3TablesWriteRule(engine) {
    return {
        id: `${engine}.${exports.DROP_BEFORE_S3TABLES_WRITE_RULE_SUFFIX}`,
        engine,
        title: "S3 Tables(Iceberg)结果表不要先 drop 再建 / 写:createOrReplace / INSERT OVERWRITE 本身原子",
        rule: "对 S3 Tables(Iceberg)目标表,`DROP TABLE IF EXISTS <t>` 之后再 `createOrReplace()` / `CREATE TABLE … AS SELECT` / `INSERT INTO`" +
            " 是**非原子覆盖**:drop 到新表提交之间没有这张表,drop 成功而写入失败就把表弄丢(下游全红)。正解:" +
            exports.S3TABLES_ATOMIC_OVERWRITE_HOWTO,
        antiPattern: exports.DROP_BEFORE_S3TABLES_WRITE_PATTERN,
        severity: "warn",
        target: "code",
    };
}
