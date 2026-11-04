// 同步任务「**有没有活可干**」的单一作者。
//
// 🔴🔴 【真环境实测(2026-09-17)】建任务时把表清单写在了 `tables` 字段(而契约是 `sourceTables`),
//   `POST /api/sync` 是 `{...body}` **原样落库**、零校验 ⇒ 任务的 `sourceTables` 是 `undefined`
//   ⇒ Glue 同步作业**一张表都没处理**(日志里 `SYNC RESULTS: {}`)⇒ 作业自身 SUCCEEDED
//   ⇒ 平台把任务标成 **succeeded**,而数仓里连表都没建。
//   这是最坏的一类缺陷:**空转成功** —— 看板全绿、审计全绿、而什么都没发生。
//   (同族:记忆 `silent-default-is-a-defect-class` 与 `add_set_eq` 那条「两边都空 = 空断言」。)
// 规矩:① 建 / 改任务时表清单为空 ⇒ **400**(不许落一个注定空转的任务);
//       ② 启动时再判一次(存量任务可能是空的)⇒ **400**,拒因说清「哪个字段空了、该怎么填」;
//       ③ 生成的 Glue 脚本里再兜一层(见 glue-script-generator):零表就 raise,绝不静默成功。
import { getProvider, isDataSourceType } from "@/lib/datasource-spi/registry";
import { readConnection } from "@/lib/datasource-spi/normalize";

export interface SyncWorkShape {
  sourceDatabase?: unknown;
  sourceTables?: unknown;
}

/** 任务所引用的数据源行(只读类型与连接信息;与 normalize.readConnection 的入参同形,旧扁平字段也认)。 */
export interface SyncWorkSource {
  type?: unknown;
  connection?: Record<string, any>;
  host?: string;
  port?: number;
  database?: string;
  jdbcParams?: string;
}

/** 表清单归一成 `string[]`(去空白、去空串);非数组一律回空数组。 */
export function normalizeSourceTables(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0);
}

/**
 * 回 null = 有活可干;回字符串 = 人话拒因(调用方转 400)。
 *
 * 🔴 (2026-10-25 页面驱动段 scq A1-2 真撞):「从哪读」原来只认 JDBC 的源库名(sourceDatabase)——
 *   S3 对象存储源在向导里列得出数据集、勾得了,到「完成」却 400「缺少源库名」。S3 / DynamoDB 源**没有库名概念**,
 *   它们的定位在数据源连接袋里(S3 = bucket/prefix,DynamoDB = tableName),同步脚本生成器也正是从连接袋读的。
 * 修法:按数据源**范式**判 —— jdbc 范式要源库名;其它范式交给该 provider 自己的 validateConfig
 *   (与建源表单同一份校验,单一作者),不再要一个不存在的「库名」。数据源未知(调用方没传 / 类型不认识)
 *   ⇒ 按 jdbc 判(保守 = 原行为)。
 */
export function syncWorkRejection(task: SyncWorkShape, source?: SyncWorkSource): string | null {
  const tables = normalizeSourceTables(task.sourceTables);
  if (tables.length === 0) {
    return (
      "同步任务没有可同步的表:`sourceTables` 为空。" +
      "请在「选择表」里至少勾一张表(字段名是 `sourceTables: [\"表名\"]`,不是 `tables`);" +
      "🔴 空表清单的任务跑起来会**什么都不做却报成功**,所以这里直接拒。"
    );
  }
  const provider = source && isDataSourceType(source.type) ? getProvider(source.type) : undefined;
  if (!provider || provider.capabilities.paradigm === "jdbc") {
    const db = typeof task.sourceDatabase === "string" ? task.sourceDatabase.trim() : "";
    if (!db) {
      return "同步任务缺少源库名:`sourceDatabase` 为空(它决定从哪个库读表,缺了同步作业无从下手)。";
    }
    return null;
  }
  const verdict = provider.validateConfig(readConnection({ ...source, type: provider.type }));
  if (!verdict.ok) {
    return (
      `同步任务的数据源(${provider.capabilities.label || provider.type})连接信息不完整:${verdict.errors.join(";")}` +
      "(它决定从哪读数据,缺了同步作业无从下手)。"
    );
  }
  return null;
}
