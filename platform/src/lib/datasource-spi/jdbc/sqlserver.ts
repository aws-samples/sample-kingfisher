// 模块 42 — SQL Server provider(JDBC 范式,P42.3)。
//
// 【驱动】tedious@18(纯 JS,微软官方,mssql 底层;P42.0 实证 alpine 可用)。
// 按需 dynamic import——未装进 platform 依赖前,introspect/ping 优雅降级(返回 [] / reachable:false)。
// 【方言差异】URL=jdbc:sqlserver://host:port;databaseName=db;系统表=sys.columns/sys.tables;
//   driver=com.microsoft.sqlserver.jdbc.SQLServerDriver。

import { makeJdbcProvider, toDatasets, type JdbcConnInfo } from "./jdbc-base";
import type { SourceDataset, SourceColumn, PingResult, DataSourceCapabilities } from "../types";

const capabilities: DataSourceCapabilities = {
  paradigm: "jdbc",
  credentialKind: "userpass",
  isVpcBound: true,
  canIntrospect: true,
  canPing: true,
  supportsCdc: true, // SQL Server:DMS full-load-and-cdc(需 MS-CDC)
  needsGlueConnection: true,
  syncChannels: ["glue", "dms"],
  analysisChannels: ["glue-catalog"],
  defaultPort: 1433,
  icon: "🔷",
  label: "SQL Server",
};

// tedious 是回调/事件式,包一层 Promise。未装 → import 抛错被捕获 → 降级。
async function withTedious<T>(conn: JdbcConnInfo, run: (connection: any) => Promise<T>): Promise<T> {
  const tedious: any = await import("tedious");
  const Connection = tedious.Connection || tedious.default?.Connection;
  return new Promise<T>((resolve, reject) => {
    const connection = new Connection({
      server: conn.host,
      authentication: { type: "default", options: { userName: conn.username, password: conn.password } },
      options: {
        port: conn.port || 1433,
        database: conn.database,
        encrypt: true,
        trustServerCertificate: true, // 仅探查/心跳,不传输业务数据
        connectTimeout: 10000,
      },
    });
    connection.on("connect", (err: any) => {
      if (err) { reject(err); return; }
      run(connection).then((r) => { connection.close(); resolve(r); }).catch((e) => { connection.close(); reject(e); });
    });
    connection.on("error", reject);
    connection.connect();
  });
}

// 用 tedious 执行一条查询,收集行(每行归一成对象)。
function queryRows(tedious: any, connection: any, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const rows: any[] = [];
    const Request = tedious.Request || tedious.default?.Request;
    const req = new Request(sql, (err: any) => { if (err) reject(err); else resolve(rows); });
    req.on("row", (cols: any[]) => {
      const o: Record<string, any> = {};
      for (const c of cols) o[c.metadata.colName] = c.value;
      rows.push(o);
    });
    connection.execSql(req);
  });
}

async function introspect(conn: JdbcConnInfo): Promise<SourceDataset[]> {
  try {
    const tedious: any = await import("tedious");
    return await withTedious(conn, async (connection) => {
      const rows = await queryRows(
        tedious,
        connection,
        `SELECT t.name AS table_name, c.name AS column_name, ty.name AS data_type, c.is_nullable
         FROM sys.tables t
         JOIN sys.columns c ON c.object_id = t.object_id
         JOIN sys.types ty ON ty.user_type_id = c.user_type_id
         ORDER BY t.name, c.column_id`
      );
      const map: Record<string, SourceColumn[]> = {};
      for (const r of rows) {
        if (!map[r.table_name]) map[r.table_name] = [];
        map[r.table_name].push({ name: r.column_name, type: r.data_type, nullable: !!r.is_nullable });
      }
      return toDatasets(map);
    });
  } catch {
    return [];
  }
}

async function ping(conn: JdbcConnInfo): Promise<PingResult> {
  const started = Date.now();
  try {
    const tedious: any = await import("tedious");
    await withTedious(conn, async (connection) => queryRows(tedious, connection, "SELECT 1"));
    return { reachable: true, latencyMs: Date.now() - started };
  } catch (e: any) {
    return { reachable: false, latencyMs: Date.now() - started, error: (e.message || "").slice(0, 200) };
  }
}

export const sqlserverProvider = makeJdbcProvider(
  {
    type: "sqlserver",
    driverClass: "com.microsoft.sqlserver.jdbc.SQLServerDriver",
    defaultPort: 1433,
    jdbcUrl: (h, p, d) => `jdbc:sqlserver://${h}:${p};databaseName=${d}`,
    paramStyle: "semicolon",
    introspect,
    ping,
  },
  capabilities
);
