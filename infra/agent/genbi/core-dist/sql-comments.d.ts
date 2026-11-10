/** SQL 注释剥除 —— 问数只读闸(./sql-guard)与 SQL 血缘解析(lib/lineage/sql-lineage)共用的唯一作者。
 *  块注释用下标扫描而不是 `/\/\*[\s\S]*?\*\//`:后者在「`/*` 没闭合又反复出现 `/*`」的用户文本上会多项式回溯(2026-11-09 代码扫描抓到)。
 *  语义与原正则一致:闭合的块注释换成一个空格;没闭合的 `/*…` 原样保留(交给 SQL 引擎自己报错);行注释 `--…` 到行尾(`\n` 或 `\r`)。 */
export declare function stripSqlComments(sql: string): string;
