// 序 38 B-70 —— 经 Glue 连接探测 / 发现表的纯函数判据(脚本内容 / 各源 SQL / 库名校验 / 作业名)。
import { describe, it, expect } from "vitest";
import {
  discoverySqlFor, buildDiscoveryScript, assertDiscoveryDatabase, discoveryJobName, glueReachNote, GLUE_DISCOVERY_JOB,
  jdbcTimeoutOptionsFor, GLUE_DISCOVERY_CONNECT_TIMEOUT_S, GLUE_DISCOVERY_SOCKET_TIMEOUT_S,
} from "@/lib/datasource/glue-reach";
import { GLUE_VERSION_DEFAULT } from "@/lib/sync/glue-version";

describe("B-70 发现脚本的 JDBC 超时(同一个作业也是「检测」的载体:源 host 不通要在十几秒内失败,不能等内核 TCP 重试)", () => {
  it("四种源各用自己 driver 的属性名与单位(MySQL / Oracle 毫秒,PG / SQL Server 秒);未知类型拒(不许静默无超时)", () => {
    const c = GLUE_DISCOVERY_CONNECT_TIMEOUT_S, s = GLUE_DISCOVERY_SOCKET_TIMEOUT_S;
    expect(jdbcTimeoutOptionsFor("mysql")).toEqual([["connectTimeout", String(c * 1000)], ["socketTimeout", String(s * 1000)]]);
    expect(jdbcTimeoutOptionsFor("postgresql")).toEqual([["connectTimeout", String(c)], ["socketTimeout", String(s)]]);
    expect(jdbcTimeoutOptionsFor("sqlserver")).toEqual([["loginTimeout", String(c)], ["socketTimeout", String(s * 1000)]]);
    expect(jdbcTimeoutOptionsFor("oracle")).toEqual([["oracle.net.CONNECT_TIMEOUT", String(c * 1000)], ["oracle.jdbc.ReadTimeout", String(s * 1000)]]);
    expect(() => jdbcTimeoutOptionsFor("dynamodb")).toThrow(/不支持/);
    expect(c).toBeLessThanOrEqual(30);
  });
  it("脚本把超时属性作为 Spark JDBC option 传给 driver(在 user / password 之后、dbtable 之前)", () => {
    const script = buildDiscoveryScript({ dbType: "mysql", jdbcUrl: "jdbc:mysql://h:3306/d", driverClass: "com.mysql.cj.jdbc.Driver", secretArn: "arn:x", region: "us-east-1" });
    const i = (s: string) => script.indexOf(s);
    expect(script).toContain(`.option("connectTimeout", "${GLUE_DISCOVERY_CONNECT_TIMEOUT_S * 1000}")`);
    expect(script).toContain(`.option("socketTimeout", "${GLUE_DISCOVERY_SOCKET_TIMEOUT_S * 1000}")`);
    expect(i('.option("password"')).toBeLessThan(i('.option("connectTimeout"'));
    expect(i('.option("connectTimeout"')).toBeLessThan(i('.option("dbtable"'));
    expect(buildDiscoveryScript({ dbType: "oracle", jdbcUrl: "u", driverClass: "d", secretArn: "s", region: "r" })).toContain('.option("oracle.net.CONNECT_TIMEOUT"');
  });
});

describe("B-70 发现 SQL(与 datasource-spi/jdbc/<type>.ts 的 introspect 同一口径)", () => {
  it("四种 JDBC 源各读自己的系统表,统一列别名;未知类型拒", () => {
    expect(discoverySqlFor("mysql")).toContain("INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = '__DB__'");
    expect(discoverySqlFor("postgresql")).toContain("information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema')");
    expect(discoverySqlFor("sqlserver")).toContain("INFORMATION_SCHEMA.COLUMNS WHERE TABLE_CATALOG = '__DB__'");
    expect(discoverySqlFor("oracle")).toContain("ALL_TAB_COLUMNS WHERE OWNER = USER");
    for (const t of ["mysql", "postgresql", "sqlserver", "oracle"]) {
      for (const col of ["tbl_schema", "tbl_name", "col_name", "col_type", "col_nullable", "col_key", "col_comment", "col_pos"]) {
        expect(discoverySqlFor(t), `${t} 缺 ${col}`).toContain(` AS ${col}`);
      }
    }
    expect(() => discoverySqlFor("dynamodb")).toThrow(/不支持/);
  });
});

describe("B-70 发现脚本", () => {
  const script = buildDiscoveryScript({
    dbType: "mysql", jdbcUrl: "jdbc:mysql://db.example.internal:3306/gamedb", driverClass: "com.mysql.cj.jdbc.Driver",
    secretArn: "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:bgp-ds-x-AbCdEf", region: "ap-southeast-1",
  });
  it("与同步作业同一份连接三样:JDBC URL / driver / secret ARN;读 information_schema;结果 put 到 --result_uri", () => {
    expect(script).toContain('"jdbc:mysql://db.example.internal:3306/gamedb"');
    expect(script).toContain('"com.mysql.cj.jdbc.Driver"');
    expect(script).toContain("arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:bgp-ds-x-AbCdEf");
    expect(script).toContain('region_name="ap-southeast-1"');
    expect(script).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(script).toContain('getResolvedOptions(sys.argv, ["JOB_NAME", "result_uri", "database"])');
    expect(script).toContain("put_object(Bucket=bucket, Key=key");
    expect(script).toContain('"via": "glue-discovery"');
  });
  it("库名只允许标识符字符(脚本里再校一次,拒掉拼 SQL 的空子)", () => {
    expect(script).toContain('isalnum() or ch in "_$.-"');
    expect(assertDiscoveryDatabase("gamedb")).toBe("gamedb");
    expect(assertDiscoveryDatabase(" ods_db ")).toBe("ods_db");
    expect(() => assertDiscoveryDatabase("x'; DROP TABLE t; --")).toThrow(/不合法/);
    expect(() => assertDiscoveryDatabase("")).toThrow(/不合法/);
    expect(() => assertDiscoveryDatabase(undefined)).toThrow(/不合法/);
  });
  it("PG / SQL Server 的缺省 schema 不带前缀;MySQL 没有缺省 schema 概念", () => {
    expect(buildDiscoveryScript({ dbType: "postgresql", jdbcUrl: "u", driverClass: "d", secretArn: "s", region: "r" })).toContain('DEFAULT_SCHEMA = "public"');
    expect(buildDiscoveryScript({ dbType: "sqlserver", jdbcUrl: "u", driverClass: "d", secretArn: "s", region: "r" })).toContain('DEFAULT_SCHEMA = "dbo"');
    expect(script).toContain('DEFAULT_SCHEMA = ""');
  });
});

describe("B-70 常量 / 说明", () => {
  it("发现作业名 = bgp-ds-discover-<源 id 尾 12 位>(落在 TaskRole 的 job/bgp-* 授权面内);Glue 版本 = 平台缺省(序 53)", () => {
    expect(discoveryJobName("01M4S8RA2ZS26FJCB8S5CFB184")).toBe("bgp-ds-discover-JCB8S5CFB184");
    expect(discoveryJobName("01M4S8RA2ZS26FJCB8S5CFB184")).toMatch(/^bgp-/);
    expect(GLUE_DISCOVERY_JOB.glueVersion).toBe(GLUE_VERSION_DEFAULT);
  });
  it("说明文案:带控制面错误时先说「控制面直连不到…正常」,再说改走 Glue 连接", () => {
    const n = glueReachNote("probe", "connect ETIMEDOUT 192.168.23.10:3306");
    expect(n).toContain("控制面直连不到该源");
    expect(n).toContain("ETIMEDOUT");
    expect(n).toContain("Glue 连接探测");
    expect(n).toContain("Glue 作业");   // 载体说清:是作业,不是 TestConnection(传统 JDBC 连接不支持它)
    expect(n).not.toMatch(/TestConnection/);
    expect(glueReachNote("discovery")).not.toContain("控制面直连不到");
    expect(glueReachNote("discovery")).toContain("发现表");
  });
});
