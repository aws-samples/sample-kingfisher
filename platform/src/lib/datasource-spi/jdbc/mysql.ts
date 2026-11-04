// 模块 42 — MySQL provider(JDBC 范式)。
//
// 【行为保持重构】introspect/ping 的 SQL 与建连参数逐字收编自现有实现:
//   introspect ← lib/datasource/schema-reader.ts:47-71(同一 INFORMATION_SCHEMA.COLUMNS 查询)
//   ping       ← lib/datasource/heartbeat.ts:46-55(同一 SELECT 1 + connectTimeout)
// mysql2 已在 platform 依赖(package.json)。driver/JDBC_URL 收编自 datasource-service.ts:15。

import mysql from "mysql2/promise";
import { makeJdbcProvider, toDatasets, type JdbcConnInfo } from "./jdbc-base";
import type { SourceDataset, SourceColumn, PingResult, DataSourceCapabilities } from "../types";

const capabilities: DataSourceCapabilities = {
  paradigm: "jdbc",
  credentialKind: "userpass",
  isVpcBound: true,
  canIntrospect: true,
  canPing: true,
  supportsCdc: true, // MySQL binlog:DMS full-load-and-cdc / Zero-ETL / Flink CDC
  needsGlueConnection: true,
  syncChannels: ["glue", "dms", "zero-etl"], // MySQL 独有 zero-etl(→Redshift)
  analysisChannels: ["glue-catalog"],
  defaultPort: 3306,
  icon: "🐬",
  label: "MySQL",
};

// introspect:逐字复用 schema-reader.ts 的 INFORMATION_SCHEMA.COLUMNS 查询(容错返 [])。
async function introspect(conn: JdbcConnInfo): Promise<SourceDataset[]> {
  let c: mysql.Connection | null = null;
  try {
    c = await mysql.createConnection({
      host: conn.host,
      port: conn.port || 3306,
      user: conn.username,
      password: conn.password,
      database: conn.database,
      connectTimeout: 10000,
    });
    const [rows] = await c.query(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_COMMENT
       FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [conn.database]
    );
    const map: Record<string, SourceColumn[]> = {};
    for (const r of rows as any[]) {
      if (!map[r.TABLE_NAME]) map[r.TABLE_NAME] = [];
      map[r.TABLE_NAME].push({
        name: r.COLUMN_NAME,
        type: r.COLUMN_TYPE,
        nullable: r.IS_NULLABLE === "YES",
        key: r.COLUMN_KEY || undefined,
        comment: r.COLUMN_COMMENT || undefined,
      });
    }
    return toDatasets(map);
  } catch {
    return []; // unreachable / bad creds:上层仍注册 service+db(与现有一致)
  } finally {
    try { await c?.end(); } catch {}
  }
}

// ping:逐字复用 heartbeat.ts 的 SELECT 1 + connectTimeout 8000。
async function ping(conn: JdbcConnInfo): Promise<PingResult> {
  let c: mysql.Connection | null = null;
  const started = Date.now();
  try {
    c = await mysql.createConnection({
      host: conn.host,
      port: conn.port || 3306,
      user: conn.username,
      password: conn.password,
      database: conn.database,
      connectTimeout: 8000,
    });
    await c.query("SELECT 1");
    return { reachable: true, latencyMs: Date.now() - started };
  } catch (e: any) {
    return { reachable: false, latencyMs: Date.now() - started, error: e.message?.slice(0, 200) };
  } finally {
    try { await c?.end(); } catch {}
  }
}

export const mysqlProvider = makeJdbcProvider(
  {
    type: "mysql",
    driverClass: "com.mysql.cj.jdbc.Driver",
    defaultPort: 3306,
    jdbcUrl: (h, p, d) => `jdbc:mysql://${h}:${p}/${d}`,
    paramStyle: "query",
    // @kf-batch 44-jdbc-params(用户 2026-10-15 反馈 ①「同步遇到空时间戳脏数据报错」)—— 老业务库常见 `0000-00-00 00:00:00` 零值
    //   日期 / 时间戳,Connector/J 默认 zeroDateTimeBehavior=EXCEPTION ⇒ Spark JDBC 读到这一行整个作业抛 `Zero date value prohibited`
    //   (…7698 p44a 真跑坐实)。按 NULL 读入:不丢行、不改好数据;目标表列本就可空(target-ddl 不写 NOT NULL)。用户填同名参数可覆盖。
    defaultParams: { zeroDateTimeBehavior: "CONVERT_TO_NULL" },
    introspect,
    ping,
  },
  capabilities
);
