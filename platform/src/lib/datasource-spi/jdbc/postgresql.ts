// PostgreSQL provider(JDBC 范式,底座试金石)。
//
// 【驱动】pg@8(纯 JS,实证 alpine 可用)。按需 dynamic import——若 pg 未装则 introspect/ping
// 优雅降级(返回 [] / reachable:false),不让顶层 import 崩(与"驱动可得性分期"一致)。
// 【方言差异】PG 有 schema 概念(默认 public);driver=org.postgresql.Driver;URL=jdbc:postgresql://。

import { makeJdbcProvider, toDatasets, type JdbcConnInfo } from "./jdbc-base";
import type { SourceDataset, SourceColumn, PingResult, DataSourceCapabilities } from "../types";

const capabilities: DataSourceCapabilities = {
  paradigm: "jdbc",
  credentialKind: "userpass",
  isVpcBound: true,
  canIntrospect: true,
  canPing: true,
  supportsCdc: true, // PG 逻辑复制:DMS full-load-and-cdc 支持(zero-etl 不支持 PG)
  needsGlueConnection: true,
  syncChannels: ["glue", "dms"], // 无 zero-etl(那是 MySQL→Redshift 专属)
  analysisChannels: ["glue-catalog"],
  defaultPort: 5432,
  icon: "🐘",
  label: "PostgreSQL",
};

// 按需加载 pg(纯 JS)。未装时抛错被 introspect/ping 的 try 捕获。
async function pgClient(conn: JdbcConnInfo) {
  const { Client } = await import("pg");
  const client = new Client({
    host: conn.host,
    port: conn.port || 5432,
    user: conn.username,
    password: conn.password,
    database: conn.database,
    connectionTimeoutMillis: 10000,
    // PG SSL:RDS 默认要 SSL,但证书链复杂;先 rejectUnauthorized:false(仅探查/心跳,不传输业务数据)。
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

// introspect:PG information_schema.columns(排除系统 schema,取 table_schema.table_name)。
async function introspect(conn: JdbcConnInfo): Promise<SourceDataset[]> {
  let client: any = null;
  try {
    client = await pgClient(conn);
    const { rows } = await client.query(
      `SELECT table_schema, table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog','information_schema')
       ORDER BY table_schema, table_name, ordinal_position`
    );
    const map: Record<string, SourceColumn[]> = {};
    for (const r of rows as any[]) {
      // public schema 的表用裸表名;其他 schema 前缀 schema. 以区分。
      const tname = r.table_schema === "public" ? r.table_name : `${r.table_schema}.${r.table_name}`;
      if (!map[tname]) map[tname] = [];
      map[tname].push({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === "YES",
      });
    }
    return toDatasets(map);
  } catch {
    return [];
  } finally {
    try { await client?.end(); } catch {}
  }
}

async function ping(conn: JdbcConnInfo): Promise<PingResult> {
  let client: any = null;
  const started = Date.now();
  try {
    client = await pgClient(conn);
    await client.query("SELECT 1");
    return { reachable: true, latencyMs: Date.now() - started };
  } catch (e: any) {
    return { reachable: false, latencyMs: Date.now() - started, error: (e.message || "").slice(0, 200) };
  } finally {
    try { await client?.end(); } catch {}
  }
}

export const postgresProvider = makeJdbcProvider(
  {
    type: "postgresql",
    driverClass: "org.postgresql.Driver",
    defaultPort: 5432,
    jdbcUrl: (h, p, d) => `jdbc:postgresql://${h}:${p}/${d}`,
    paramStyle: "query",
    introspect,
    ping,
  },
  capabilities
);
