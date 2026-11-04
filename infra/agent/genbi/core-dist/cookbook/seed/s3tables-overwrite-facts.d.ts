import type { CookbookEngine, DialectRule } from "../types";
/** 整表 / 按分区**原子**覆盖 Iceberg(S3 Tables)表的唯一写法(规则 / 模板 / 提示词共用一份文本)。 */
export declare const S3TABLES_ATOMIC_OVERWRITE_HOWTO: string;
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
export declare const DROP_BEFORE_S3TABLES_WRITE_PATTERN: RegExp;
export declare const DROP_BEFORE_S3TABLES_WRITE_RULE_SUFFIX = "no-drop-before-s3tables-write";
/**
 * 生成某引擎的「S3 Tables 结果表禁止先 drop 再建 / 写」方言规则。
 *
 * - `target: "code"` ⇒ 只检测不改写(删一条语句要判断它是否被 try / 事务 / 字符串包着 —— 正则改写就是在造新 bug)。
 * - 🔴 `severity: "warn"` 不是 error:老配方(2026-07-29 ~ 2026-10-12)教出来的存量 EMR / Glue 作业带着这一行是**能跑的**,
 *   error 会让 `job-service.ts` / `engines/emr/provider.ts` 在运行前把用户正在用的作业**拦停** —— 与 warehouse-facts.ts
 *   的 no-hardcoded-warehouse 同一条理由。warn 的作用:生成前进 lookup_recipe / codegen 提示词(【建议】),
 *   生成后 / 保存前页面「检出 N 处方言问题」把它标出来。要改成运行前硬拦只需把这里改成 error(判据同步改一处)。
 */
export declare function noDropBeforeS3TablesWriteRule(engine: Extract<CookbookEngine, "emr" | "glue" | "s3tables">): DialectRule;
