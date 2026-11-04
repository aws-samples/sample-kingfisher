// 模块 42 — Oracle provider(JDBC 范式,P42.3)。
//
// 【驱动】oracledb@6(P42.0 实证:6.x thin 模式默认,免 Oracle Instant Client native lib,alpine 可用)。
// 按需 dynamic import——oracledb 未装进 platform 依赖前,introspect/ping 优雅降级(返回 [] / reachable:false)。
// P42.3 验证阶段再决定是否加依赖真跑;未装时该源仍可建、可走 Glue 同步(driver 走 Glue 内置 jar)。
// 【方言差异】统一用 Service Name 语义(P42.3 根治):Node 侧 oracledb EZConnect connectString=
//   "host:port/service",Glue/JDBC thin URL=jdbc:oracle:thin:@//host:port/service —— 两侧把
//   `database` 字段一致地当 service name(此前 JDBC URL 误用 SID 冒号格式 @host:port:SID,与
//   connectString 的斜杠 service 语义打架,非 RDS 默认库/RAC/PDB 会连错)。RDS Oracle 的 service
//   name 默认 = 建实例时的 DB name。系统表=ALL_TAB_COLUMNS;driver=oracle.jdbc.driver.OracleDriver。

import { makeJdbcProvider, toDatasets, type JdbcConnInfo } from "./jdbc-base";
import type { SourceDataset, SourceColumn, PingResult, DataSourceCapabilities } from "../types";

const capabilities: DataSourceCapabilities = {
  paradigm: "jdbc",
  credentialKind: "userpass",
  isVpcBound: true,
  canIntrospect: true,
  canPing: true,
  supportsCdc: true, // Oracle:DMS full-load-and-cdc(需 LogMiner/binary reader)
  needsGlueConnection: true,
  syncChannels: ["glue", "dms"],
  analysisChannels: ["glue-catalog"],
  defaultPort: 1521,
  icon: "🔶",
  label: "Oracle",
};

// 按需加载 oracledb(thin 模式)。未装 → 抛错被 try 捕获 → 降级。
async function oracleConn(conn: JdbcConnInfo) {
  const oracledb: any = await import("oracledb");
  const db = oracledb.default || oracledb;
  // thin 模式(默认,免 Instant Client)。connectString: host:port/service(database 当 service name)。
  return db.getConnection({
    user: conn.username,
    password: conn.password,
    connectString: `${conn.host}:${conn.port || 1521}/${conn.database}`,
  });
}

// introspect:Oracle ALL_TAB_COLUMNS(限当前 schema=登录用户,大写)。
async function introspect(conn: JdbcConnInfo): Promise<SourceDataset[]> {
  let c: any = null;
  try {
    c = await oracleConn(conn);
    const result = await c.execute(
      `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, NULLABLE
       FROM ALL_TAB_COLUMNS
       WHERE OWNER = UPPER(:owner)
       ORDER BY TABLE_NAME, COLUMN_ID`,
      { owner: conn.username }
    );
    const map: Record<string, SourceColumn[]> = {};
    for (const row of result.rows || []) {
      const [tname, cname, dtype, nullable] = row as any[];
      if (!map[tname]) map[tname] = [];
      map[tname].push({ name: cname, type: dtype, nullable: nullable === "Y" });
    }
    return toDatasets(map);
  } catch {
    return [];
  } finally {
    try { await c?.close(); } catch {}
  }
}

async function ping(conn: JdbcConnInfo): Promise<PingResult> {
  let c: any = null;
  const started = Date.now();
  try {
    c = await oracleConn(conn);
    await c.execute("SELECT 1 FROM DUAL"); // Oracle 无裸 SELECT 1,需 FROM DUAL
    return { reachable: true, latencyMs: Date.now() - started };
  } catch (e: any) {
    return { reachable: false, latencyMs: Date.now() - started, error: (e.message || "").slice(0, 200) };
  } finally {
    try { await c?.close(); } catch {}
  }
}

export const oracleProvider = makeJdbcProvider(
  {
    type: "oracle",
    // Glue 5.0 内置 Oracle 驱动的官方 ClassName(AWS 文档 aws-glue-programming-etl-connect)。
    driverClass: "oracle.jdbc.driver.OracleDriver",
    defaultPort: 1521,
    // Service Name 语义(EZConnect):@//host:port/service。与 Node 侧 connectString "h:p/service"
    // 一致(统一把 database 当 service name);根治此前 SID 冒号格式 @h:p:d 与 connectString 打架。
    jdbcUrl: (h, p, d) => `jdbc:oracle:thin:@//${h}:${p}/${d}`,
    paramStyle: "query",
    introspect,
    ping,
  },
  capabilities
);
