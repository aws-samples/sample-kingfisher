// 改动前录下的「存量任务形态」矩阵(A3 先钉现状)。
// 每个形态 = 一个存量同步任务可能长成的样子(不带任何新字段)。
// 判据 `golden-script.test.ts` 用它断:改动后生成的脚本与改动前**逐字节相同**;
// 只有「覆盖」写入的形态允许变化(根治本来就要改它),那几个单独列名、单独断新行为。
import type { DataSource } from "@/types/datasource";
import type { GlueScriptBindings } from "@/lib/sync/glue-script-generator";

export const GOLDEN_BINDINGS: GlueScriptBindings = {
  landing: {
    targetId: "tgt_home",
    region: "us-east-1",
    datalakeBucket: "bgp-datalake-123456789012",
    tableBucket: "bgp-table-bucket",
  },
  rsb: {
    region: "us-east-1",
    workgroup: "bgp-workgroup",
    database: "dev",
    secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:redshift!bgp-namespace-admin-AbCdEf",
  },
  // 数据湖表桶路由:存量任务写平台表桶 ⇒ 目录别名 = 平台路由的固定别名(脚本与改动前逐字节相同;golden 文件因此一字不改)
  lakeCatalogAlias: "s3tablescatalog",
};

const mysqlDs = {
  datasourceId: "ds_mysql", name: "src", type: "mysql",
  connection: { host: "db.example.internal", port: 3306, database: "gamedb" },
  host: "db.example.internal", port: 3306,
  secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:src-AbC",
  database: "gamedb",
} as unknown as DataSource;
const ddbDs = {
  datasourceId: "ds_ddb", name: "ddb", type: "dynamodb",
  connection: { tableName: "bgp-orders", region: "us-east-1" },
} as unknown as DataSource;
const s3Ds = {
  datasourceId: "ds_s3", name: "s3src", type: "s3",
  connection: { bucket: "my-src-bucket", prefix: "events/", format: "csv", hasHeader: true },
} as unknown as DataSource;

const base = {
  taskId: "t_golden_000000001", sourceDatabase: "gamedb", sourceTables: ["players", "orders"],
  s3Config: { namespace: "gamedb" }, redshiftConfig: { schema: "public" },
  syncMode: "full",
};

export interface GoldenShape {
  name: string;
  /** 「覆盖」写入 ⇒ 要改它,不进逐字节断言 */
  overwrite: boolean;
  task: Record<string, unknown>;
  ds: DataSource;
}

export const GOLDEN_SHAPES: GoldenShape[] = [
  { name: "jdbc-both-overwrite", overwrite: true, ds: mysqlDs, task: { ...base, targetType: "both", writeMode: "overwrite" } },
  { name: "jdbc-s3-overwrite-partitioned", overwrite: true, ds: mysqlDs, task: { ...base, targetType: "s3-tables", writeMode: "overwrite", s3Config: { namespace: "gamedb", partitionFields: [{ field: "created_at", type: "date" }, { field: "region", type: "identity" }] } } },
  { name: "jdbc-redshift-overwrite-keys-confirmed", overwrite: true, ds: mysqlDs, task: { ...base, targetType: "redshift", writeMode: "overwrite", redshiftConfig: { schema: "ods", sortKeys: "created_at,id", distKey: "id", distStyle: "key" }, overwriteConfirmedTables: ["ods.players"] } },
  { name: "ddb-s3-overwrite", overwrite: true, ds: ddbDs, task: { ...base, sourceTables: ["bgp-orders"], targetType: "s3-tables", writeMode: "overwrite" } },
  { name: "jdbc-redshift-append", overwrite: false, ds: mysqlDs, task: { ...base, targetType: "redshift", writeMode: "append" } },
  { name: "jdbc-s3-append", overwrite: false, ds: mysqlDs, task: { ...base, targetType: "s3-tables", writeMode: "append" } },
  { name: "jdbc-both-merge", overwrite: false, ds: mysqlDs, task: { ...base, targetType: "both", writeMode: "merge", mergeKeys: ["id"] } },
  { name: "jdbc-both-incremental", overwrite: false, ds: mysqlDs, task: { ...base, targetType: "both", writeMode: "append", syncMode: "incremental", incrementalColumn: "updated_at", incrementalValue: "2026-01-01 00:00:00" } },
  { name: "jdbc-redshift-incremental-numeric", overwrite: false, ds: mysqlDs, task: { ...base, targetType: "redshift", writeMode: "append", syncMode: "incremental", incrementalColumn: "id", incrementalValue: 1000 } },
  { name: "jdbc-redshift-incremental-empty-watermark", overwrite: false, ds: mysqlDs, task: { ...base, targetType: "redshift", writeMode: "overwrite", syncMode: "incremental", incrementalColumn: "id" } },
  { name: "jdbc-both-append-renamed-targets", overwrite: false, ds: mysqlDs, task: { ...base, targetType: "both", writeMode: "append", targetTablePrefix: "ods_", targetTableNames: { orders: "ods_order_fact" } } },
  { name: "jdbc-redshift-append-empty-where", overwrite: false, ds: mysqlDs, task: { ...base, targetType: "redshift", writeMode: "append", whereClause: "" } },
  { name: "jdbc-redshift-append-blank-where", overwrite: false, ds: mysqlDs, task: { ...base, targetType: "redshift", writeMode: "append", whereClause: "   " } },
  { name: "ddb-redshift-append", overwrite: false, ds: ddbDs, task: { ...base, sourceTables: ["bgp-orders"], targetType: "redshift", writeMode: "append" } },
  { name: "s3src-both-append", overwrite: false, ds: s3Ds, task: { ...base, sourceTables: ["events"], targetType: "both", writeMode: "append" } },
];
