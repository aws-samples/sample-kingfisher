// @kf-batch 50-SEQ47c-catalog-ddl —— 页面上「列类型」下拉的候选(客户端可 import:零 AWS SDK 依赖)。
// 🔴 与服务端白名单 `lib/modeling/redshift.ts` 的 `DDL_TYPES` 必须一致(单测钉);那边 import 了 redshift-data SDK,
//    客户端组件不能直接拿它的键,所以这里给一份**只含字面量**的清单。
export const DDL_TYPE_CHOICES = ["VARCHAR", "CHAR", "INTEGER", "BIGINT", "SMALLINT", "DECIMAL", "DOUBLE PRECISION", "REAL", "BOOLEAN", "DATE", "TIMESTAMP", "TIMESTAMPTZ", "SUPER"] as const;
export type DdlTypeChoice = (typeof DDL_TYPE_CHOICES)[number];

/** S3 Tables(Iceberg)建表时没有对应物的类型(服务端 `icebergTypeOf` 会拒;界面提前不给选)。 */
export const ICEBERG_UNSUPPORTED_TYPES: readonly DdlTypeChoice[] = ["SUPER"];

export function needsLength(t: string): boolean {
  return t === "VARCHAR" || t === "CHAR";
}
export function needsPrecision(t: string): boolean {
  return t === "DECIMAL";
}
