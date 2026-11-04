// JDBC 范式共享基座(JDBC 四兄弟 mysql/postgresql/oracle/sqlserver 共用)。
//
// 【收编而非重写】把散落的现有 MySQL 实现(schema-reader/heartbeat/datasource-service 的 JDBC_URL)
// 收敛到这里,行为逐字保持;各 provider 只声明「方言差异」(JDBC_URL 模板 / driver / 默认端口 /
// introspect 查询与驱动),base 处理共性(建连/超时/凭证读取/结果归一)。
//
// 【驱动可得性】node:20-alpine(musl) 下真实验证:mysql2✅ / pg✅(纯JS) /
// tedious✅(纯JS,SQLServer) / oracledb 6.x✅(thin 模式默认,免 Instant Client native lib)。
// 故四兄弟的 Node 侧 introspect/ping 均可跑;驱动按需 dynamic import(避免未装驱动时顶层 import 崩)。

import { getSecret } from "../secrets"; // 独立底层(断循环依赖:不经 datasource-service)
// 附加 JDBC 参数(用户填的)+ 方言默认参数(如 MySQL 零值日期按 NULL 读入)的唯一作者
import { buildJdbcUrlWithParams, parseJdbcParams, type JdbcParamStyle } from "./jdbc-params";
import type { SourceRef, DataSourceProvider } from "../spi";
import type {
  ConnectionModel,
  SourceDataset,
  SourceColumn,
  TestResult,
  PingResult,
  DataSourceCapabilities,
} from "../types";

// 各 JDBC 方言的差异描述(provider 传入,base 消费)。
export interface JdbcDialect {
  type: DataSourceProvider["type"];
  driverClass: string; // Glue/JDBC driver 全类名
  defaultPort: number;
  // JDBC URL 模板(host/port/database → url,**不含参数**)。各库格式不同(Oracle thin 用 :,SQLServer 用 ;databaseName=)。
  jdbcUrl: (host: string, port: number, database: string) => string;
  // 参数拼接风格:query = `?k=v&k=v`(mysql / postgresql / oracle),semicolon = `;k=v;k=v`(sqlserver)。
  paramStyle: JdbcParamStyle;
  // 方言默认连接参数(用户填了同名键以用户为准)。MySQL:zeroDateTimeBehavior=CONVERT_TO_NULL(零值日期 / 时间戳按 NULL 读入,
  // 不让整个同步作业因一行 `0000-00-00 00:00:00` 失败;Glue 4 / 5 内置 Connector/J 8.0.x 认这个写法)。
  defaultParams?: Readonly<Record<string, string>>;
  // Node 侧「列出表+列」的实现(用各自驱动直连查系统表)。返回归一后的数据集。
  // 未装驱动/连不上时应捕获并返回 [](与现有 readSourceSchema 的容错语义一致)。
  introspect: (conn: JdbcConnInfo) => Promise<SourceDataset[]>;
  // Node 侧「SELECT 1」探活(各驱动建连方式不同)。返回 reachable/延迟。
  ping: (conn: JdbcConnInfo) => Promise<PingResult>;
}

// JDBC 连接信息(base 从 SourceRef 解析出来,喂给方言的 introspect/ping)。
export interface JdbcConnInfo {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

// 从 SourceRef 解析 JDBC 连接信息 + 读凭证(复用现有 Secrets Manager 封装)。
// 凭证读取失败 → password 空(与现有 schema-reader/heartbeat 的容错一致:让上层判不可达)。
async function resolveJdbcConn(ref: SourceRef, defaultPort: number): Promise<JdbcConnInfo | null> {
  const c = ref.connection || {};
  const host = c.host;
  if (!host) return null;
  const port = Number(c.port) || defaultPort;
  const database = c.database || "";
  let username = ref.username || c.username || "admin";
  let password = "";
  if (ref.secretArn) {
    try {
      const s = await getSecret(ref.secretArn);
      username = s.username;
      password = s.password;
    } catch {
      return null; // 凭证读不到:上层按不可达处理(与现有实现一致)
    }
  }
  return { host, port, database, username, password };
}

// 完整 JDBC URL(模板 + 方言默认参数 + 用户附加参数)的唯一出口;
//   用户参数不合法会抛(路由层建 / 改源时必须先 parseJdbcParams 拦成 400,这里抛只兜「落库数据被绕过校验」的情形,不静默丢参数)。
export function jdbcUrlOf(dialect: JdbcDialect, host: string, port: number, database: string, jdbcParams?: unknown): string {
  return buildJdbcUrlWithParams(dialect.jdbcUrl(host, port, database), dialect.paramStyle, dialect.defaultParams, jdbcParams);
}

// 工厂:给定方言 + 能力标,产出一个完整的 JDBC provider。
// 四兄弟各自 `export const xxxProvider = makeJdbcProvider(dialect, capabilities)`。
export function makeJdbcProvider(
  dialect: JdbcDialect,
  capabilities: DataSourceCapabilities
): DataSourceProvider {
  return {
    type: dialect.type,
    capabilities,

    // 建源表单校验(收编 test/route.ts:62-92 的字符串校验:必填 + 端口范围 + host 形态)。
    validateConfig(conn: Record<string, any>) {
      const errors: string[] = [];
      const host = (conn.host || "").toString().trim();
      const port = Number(conn.port);
      const database = (conn.database || "").toString().trim();
      if (!host) errors.push("缺少主机地址(host)");
      else if (!(host.includes(".") || /^[\d.]+$/.test(host))) errors.push("主机地址格式无效");
      if (!port || port <= 0 || port >= 65536) errors.push(`端口无效: ${conn.port ?? "(空)"}`);
      if (!database) errors.push("缺少数据库名(database)");
      // 附加参数形态也在这里校验(建源 / 测连同一份错误文案)
      const jp = parseJdbcParams(conn.jdbcParams);
      if (!jp.ok) errors.push(jp.error);
      return { ok: errors.length === 0, errors };
    },

    // JDBC URL + driver(取代 3 份 JDBC_URL 副本 + glue-script 写死 mysql driver)。
    // URL = 模板 + 方言默认参数 + 用户附加参数(connection.jdbcParams;normalize 从扁平字段归一进袋)。
    buildConnection(ref: SourceRef): ConnectionModel {
      const c = ref.connection || {};
      const port = Number(c.port) || dialect.defaultPort;
      return {
        paradigm: "jdbc",
        jdbcUrl: c.host ? jdbcUrlOf(dialect, c.host, port, c.database || "", c.jdbcParams) : "",
        driverClass: dialect.driverClass,
      };
    },

    async testConnection(ref: SourceRef): Promise<TestResult> {
      // JDBC 类:真连库 SELECT 1(优于现有「查 Glue Connection 元数据」的假测试)。
      const start = Date.now();
      const steps: TestResult["steps"] = [];
      const conn = await resolveJdbcConn(ref, dialect.defaultPort);
      if (!conn) {
        steps.push({ name: "resolve", status: "fail", message: "连接信息或凭证不完整" });
        return { success: false, steps, totalMs: Date.now() - start };
      }
      steps.push({ name: "config_check", status: "pass", message: `JDBC: ${jdbcUrlOf(dialect, conn.host, conn.port, conn.database, ref.connection?.jdbcParams).slice(0, 60)}` });
      const ping = await dialect.ping(conn);
      if (ping.reachable === true) {
        steps.push({ name: "connectivity", status: "pass", message: `连接成功 (${ping.latencyMs}ms)`, latencyMs: ping.latencyMs });
      } else if (ping.reachable === false) {
        steps.push({ name: "connectivity", status: "fail", message: ping.error || "连接失败" });
      } else {
        steps.push({ name: "connectivity", status: "skip", message: "该类型暂不支持在线探测" });
      }
      return { success: steps.every((s) => s.status !== "fail"), steps, totalMs: Date.now() - start };
    },

    async ping(ref: SourceRef): Promise<PingResult> {
      if (!capabilities.canPing) return { reachable: null };
      const conn = await resolveJdbcConn(ref, dialect.defaultPort);
      if (!conn) return { reachable: false, error: "连接信息或凭证不完整" };
      return dialect.ping(conn);
    },

    async introspect(ref: SourceRef): Promise<SourceDataset[]> {
      if (!capabilities.canIntrospect) return [];
      const conn = await resolveJdbcConn(ref, dialect.defaultPort);
      if (!conn) return [];
      return dialect.introspect(conn);
    },

    // JDBC 凭证恒为 {username,password}(收编 datasource-service.ts:28)。
    buildSecretPayload(input: Record<string, any>): string | undefined {
      if (!input || input.username === undefined) return undefined;
      return JSON.stringify({ username: input.username, password: input.password ?? "" });
    },
  };
}

// 供各方言的 introspect 复用:把「表名→列[]」的 map 归一成 SourceDataset[]。
export function toDatasets(map: Record<string, SourceColumn[]>): SourceDataset[] {
  return Object.entries(map).map(([name, columns]) => ({ name, kind: "table" as const, columns }));
}
