// 数据源 SPI 底座单测。
//
// 锁三件事(「行为保持重构」的铁证):
//  ① registry 契约:四兄弟全在 + 类型守卫 + 目录派生。
//  ② normalize 归一:旧扁平 host/port/database ↔ 新 connection 袋,兼容双向。
//  ③ buildConnection 逐字一致:JDBC_URL/driver 与被收编的旧实现(datasource-service.ts:14 /
//     glue-script-generator.ts:4-9,105)完全一致 —— 防收编时改坏 MySQL 现有行为。
// + capabilities 正确(paradigm/credentialKind/syncChannels 数据驱动 recommendChannel 的依据)。

import { describe, it, expect } from "vitest";
import { getProvider, isDataSourceType, listSourceTypes, sourceTypeCatalog } from "../registry";
import { readConnection, toSourceRef } from "../normalize";
import type { DataSourceType } from "../types";
import { mapColumnType, recommendChannel } from "@/lib/sync/sync-service";
import { buildExternalTableDDL, sanitizeIdent } from "../object-store/athena-external";

describe("registry 契约", () => {
  it("JDBC 四兄弟 + kinesis + msk(流) + dynamodb(NoSQL) + s3(对象存储)全部注册", () => {
    expect(listSourceTypes().sort()).toEqual(["dynamodb", "kinesis", "msk", "mysql", "oracle", "postgresql", "s3", "sqlserver"]);
  });
  it("类型守卫正确区分已知/未知", () => {
    expect(isDataSourceType("mysql")).toBe(true);
    expect(isDataSourceType("postgresql")).toBe(true);
    expect(isDataSourceType("kinesis")).toBe(true); // 已注册
    expect(isDataSourceType("msk")).toBe(true); // 已注册(流范式第二个)
    expect(isDataSourceType("dynamodb")).toBe(true); // 已注册(NoSQL 首个)
    expect(isDataSourceType("s3")).toBe(true); // 已注册(对象存储首个)
    expect(isDataSourceType("kafka")).toBe(false); // 注册名是 msk,非 kafka
    expect(isDataSourceType("mongodb")).toBe(false); // 未接
    expect(isDataSourceType(123)).toBe(false);
    expect(isDataSourceType(undefined)).toBe(false);
  });
  it("getProvider 返回对应 type 的 provider", () => {
    for (const t of listSourceTypes()) {
      expect(getProvider(t).type).toBe(t);
    }
  });
  it("sourceTypeCatalog 由 capabilities 派生(取代 DS_TYPE_OPTIONS 硬编码)", () => {
    const cat = sourceTypeCatalog();
    expect(cat).toHaveLength(8); // 四兄弟 + kinesis/msk + dynamodb/s3
    const mysql = cat.find((c) => c.type === "mysql")!;
    expect(mysql.label).toBe("MySQL");
    expect(mysql.icon).toBe("🐬");
    expect(mysql.defaultPort).toBe(3306);
    expect(mysql.paradigm).toBe("jdbc");
  });
});

describe("kinesis provider(流范式首个)", () => {
  it("capabilities:stream 范式 + iam-role + 非VpcBound + 可 provision + flink-cdc 通道", () => {
    const cap = getProvider("kinesis").capabilities;
    expect(cap.paradigm).toBe("stream");
    expect(cap.credentialKind).toBe("iam-role");
    expect(cap.isVpcBound).toBe(false); // Kinesis 是 AWS 托管服务
    expect(cap.needsGlueConnection).toBe(false);
    expect(cap.canProvision).toBe(true); // 可按需新建流
    expect(cap.syncChannels).toEqual(["flink-cdc"]);
    expect(cap.analysisChannels).toEqual([]);
  });
  it("validateConfig:流名必填 + 合法字符校验", () => {
    const p = getProvider("kinesis");
    expect(p.validateConfig({ streamName: "orders-stream" }).ok).toBe(true);
    expect(p.validateConfig({ streamName: "" }).ok).toBe(false);
    expect(p.validateConfig({ streamName: "bad name!" }).ok).toBe(false); // 空格/感叹号非法
    expect(p.validateConfig({ streamName: "a".repeat(129) }).ok).toBe(false); // 超 128
  });
  it("buildConnection:产出 stream 范式 + streamArn(账号从 env 派生,不硬编码)", () => {
    const prev = process.env.AWS_ACCOUNT_ID;
    process.env.AWS_ACCOUNT_ID = "123456789012";
    const cm = getProvider("kinesis").buildConnection({ type: "kinesis", connection: { streamName: "s1", region: "us-east-1" } });
    expect(cm.paradigm).toBe("stream");
    expect(cm.props?.streamArn).toBe("arn:aws:kinesis:us-east-1:123456789012:stream/s1");
    expect(cm.props?.streamName).toBe("s1");
    if (prev === undefined) delete process.env.AWS_ACCOUNT_ID; else process.env.AWS_ACCOUNT_ID = prev;
  });
  it("iam-role 凭证:不实现 buildSecretPayload(无密钥可存)", () => {
    expect(getProvider("kinesis").buildSecretPayload).toBeUndefined();
  });
  it("provision 存在且 canProvision=true(新建流能力)", () => {
    expect(typeof getProvider("kinesis").provision).toBe("function");
    expect(getProvider("kinesis").capabilities.canProvision).toBe(true);
  });
  it("provision 非法流名先抛错(不触达 AWS——参数校验前置)", async () => {
    // 非法名在建流前就应拒绝(避免无谓 AWS 调用 + 明确报错)。
    await expect(getProvider("kinesis").provision!({ streamName: "bad name!" })).rejects.toThrow(/非法/);
    await expect(getProvider("kinesis").provision!({ streamName: "" })).rejects.toThrow(/非法/);
  });
  it("stream 范式不需 Glue Connection、不 VpcBound(与 JDBC 分流的依据)", () => {
    const cap = getProvider("kinesis").capabilities;
    expect(cap.needsGlueConnection).toBe(false);
    expect(cap.isVpcBound).toBe(false);
  });
});

describe("msk provider(流范式第二个:MSK / Kafka)", () => {
  it("capabilities:stream 范式 + VpcBound + 不可 provision + sasl-scram(超集标) + flink-cdc 通道", () => {
    const cap = getProvider("msk").capabilities;
    expect(cap.paradigm).toBe("stream");
    expect(cap.credentialKind).toBe("sasl-scram"); // 静态取最宽超集(iam+scram 双认证,见 §11.2)
    expect(cap.isVpcBound).toBe(true); // 🔴 与 Kinesis 相反:broker 在私有 VPC
    expect(cap.canProvision).toBe(false); // 🔴 不代劳建集群(重运维决策)
    expect(cap.needsGlueConnection).toBe(false);
    expect(cap.syncChannels).toEqual(["flink-cdc"]);
  });
  it("validateConfig:托管必有 clusterArn;自建必有 bootstrapServers;自建拒 iam", () => {
    const p = getProvider("msk");
    // 托管 + iam:合法
    expect(p.validateConfig({ mskFlavor: "msk", auth: "iam", clusterArn: "arn:aws:kafka:us-east-1:1:cluster/c/x" }).ok).toBe(true);
    // 托管缺集群:非法
    expect(p.validateConfig({ mskFlavor: "msk", auth: "iam" }).ok).toBe(false);
    // 自建 + scram + 合法 bootstrap + 账密:合法
    expect(p.validateConfig({ mskFlavor: "self", auth: "scram", bootstrapServers: "b-1.x:9096,b-2.x:9096", username: "u", password: "p" }).ok).toBe(true);
    // 自建 bootstrap 格式非法
    expect(p.validateConfig({ mskFlavor: "self", auth: "scram", bootstrapServers: "not a host", username: "u", password: "p" }).ok).toBe(false);
    // 🔴 自建 + iam:非法(IAM 仅 MSK 托管)
    expect(p.validateConfig({ mskFlavor: "self", auth: "iam", bootstrapServers: "b-1.x:9098" }).ok).toBe(false);
    // scram 缺账密:非法
    expect(p.validateConfig({ mskFlavor: "self", auth: "scram", bootstrapServers: "b-1.x:9096" }).ok).toBe(false);
  });
  it("buildSecretPayload:scram 产出 {username,password};iam 返回 undefined(无密钥)", () => {
    const p = getProvider("msk");
    expect(p.buildSecretPayload!({ auth: "scram", username: "u", password: "p" })).toBe(JSON.stringify({ username: "u", password: "p" }));
    expect(p.buildSecretPayload!({ auth: "iam", username: "u", password: "p" })).toBeUndefined();
    expect(p.buildSecretPayload!({ auth: "scram" })).toBeUndefined(); // 缺账密
  });
  it("无 provision(canProvision=false → 不代劳建集群)", () => {
    expect(getProvider("msk").provision).toBeUndefined();
    expect(getProvider("msk").capabilities.canProvision).toBe(false);
  });
  it("buildConnection:托管带 clusterArn;自建带 bootstrapServers;都带 auth/port", () => {
    const p = getProvider("msk");
    const mng = p.buildConnection({ type: "msk", connection: { mskFlavor: "msk", auth: "iam", clusterArn: "arn:x", region: "us-east-1" } });
    expect(mng.paradigm).toBe("stream");
    expect(mng.props?.clusterArn).toBe("arn:x");
    expect(mng.props?.port).toBe("9098"); // iam 端口
    const self = p.buildConnection({ type: "msk", connection: { mskFlavor: "self", auth: "scram", bootstrapServers: "b:9096", region: "us-east-1" } });
    expect(self.bootstrapServers).toBe("b:9096");
    expect(self.props?.port).toBe("9096"); // scram 端口
  });
});

// recommendChannel 改为读 capabilities.syncChannels(非 JDBC 范式);JDBC 四兄弟逐字零回归。
describe("recommendChannel 数据驱动(读 capabilities,非硬编码)", () => {
  it("DynamoDB → 只推荐 Glue(nosql 范式,DMS/Zero-ETL 不支持)", () => {
    const r = recommendChannel("dynamodb", "redshift", "full");
    expect(r.recommended).toBe("glue");
    expect(r.options.find((o) => o.channel === "glue")!.supported).toBe(true);
    expect(r.options.find((o) => o.channel === "dms")!.supported).toBe(false);
    expect(r.options.find((o) => o.channel === "zero-etl")!.supported).toBe(false);
  });
  it("S3 → 只推荐 Glue(object-store 范式)", () => {
    const r = recommendChannel("s3", "both", "full");
    expect(r.recommended).toBe("glue");
    expect(r.options.find((o) => o.channel === "glue")!.supported).toBe(true);
    expect(r.options.find((o) => o.channel === "dms")!.supported).toBe(false);
  });
  it("🔴 JDBC 零回归:MySQL→Redshift 增量仍推 Zero-ETL", () => {
    const r = recommendChannel("mysql", "redshift", "incremental");
    expect(r.recommended).toBe("zero-etl");
    expect(r.options.find((o) => o.channel === "zero-etl")!.supported).toBe(true);
  });
  it("🔴 JDBC 零回归:PostgreSQL→Redshift 增量推 DMS(无 Zero-ETL)", () => {
    const r = recommendChannel("postgresql", "redshift", "incremental");
    expect(r.recommended).toBe("dms");
    expect(r.options.find((o) => o.channel === "zero-etl")!.supported).toBe(false);
  });
  it("🔴 JDBC 零回归:realtime 模式仍锁定 DMS", () => {
    const r = recommendChannel("mysql", "redshift", "realtime");
    expect(r.recommended).toBe("dms");
  });
  it("🔴 JDBC 零回归:全量默认推 Glue", () => {
    const r = recommendChannel("sqlserver", "s3", "full");
    expect(r.recommended).toBe("glue");
  });
});

// S3 外部表 DDL 生成(Athena 直查)。纯函数,锁定 CSV/Parquet/JSON 三 format + 标识符消毒。
describe("S3 外部表 DDL 生成(分析通道)", () => {
  const cols = [{ name: "region", type: "string" }, { name: "amount", type: "bigint" }, { name: "rate", type: "double" }];
  it("CSV(有表头):TEXTFILE + 逗号分隔 + skip.header", () => {
    const ddl = buildExternalTableDDL("bgp_s3_ext", { table: "orders", location: "s3://lake/raw/orders/", format: "csv", hasHeader: true, columns: cols });
    expect(ddl).toContain("CREATE EXTERNAL TABLE IF NOT EXISTS bgp_s3_ext.orders");
    expect(ddl).toContain("FIELDS TERMINATED BY ','");
    expect(ddl).toContain("STORED AS TEXTFILE");
    expect(ddl).toContain("'skip.header.line.count'='1'");
    expect(ddl).toContain("LOCATION 's3://lake/raw/orders/'");
    expect(ddl).toContain("`amount` bigint");
    expect(ddl).toContain("`rate` double");
  });
  it("CSV(无表头):不含 skip.header", () => {
    const ddl = buildExternalTableDDL("bgp_s3_ext", { table: "t", location: "s3://l/p/", format: "csv", hasHeader: false, columns: cols });
    expect(ddl).not.toContain("skip.header.line.count");
  });
  it("Parquet:STORED AS PARQUET", () => {
    const ddl = buildExternalTableDDL("bgp_s3_ext", { table: "events", location: "s3://l/events/", format: "parquet", columns: cols });
    expect(ddl).toContain("STORED AS PARQUET");
    expect(ddl).not.toContain("FIELDS TERMINATED BY");
  });
  it("JSON:JsonSerDe", () => {
    const ddl = buildExternalTableDDL("bgp_s3_ext", { table: "logs", location: "s3://l/logs/", format: "json", columns: cols });
    expect(ddl).toContain("org.openx.data.jsonserde.JsonSerDe");
  });
  it("location 无尾部 / 自动补", () => {
    const ddl = buildExternalTableDDL("bgp_s3_ext", { table: "t", location: "s3://l/p", format: "csv", columns: cols });
    expect(ddl).toContain("LOCATION 's3://l/p/'");
  });
  it("sanitizeIdent:非法字符→下划线,数字开头前缀 _", () => {
    expect(sanitizeIdent("my-table.v2")).toBe("my_table_v2");
    expect(sanitizeIdent("2020data")).toBe("_2020data");
    expect(sanitizeIdent("")).toBe("t"); // 空兜底
  });
  it("列名也消毒(防 DDL 注入/非法名)", () => {
    const ddl = buildExternalTableDDL("bgp_s3_ext", { table: "t", location: "s3://l/p/", format: "csv", columns: [{ name: "bad col;drop", type: "string" }] });
    expect(ddl).toContain("`bad_col_drop` string");
    expect(ddl).not.toContain(";"); // 分号(SQL 注入分隔符)被消毒掉,DDL 里不应出现
    expect(ddl).not.toContain("bad col"); // 空格原样也不应出现
  });
});

describe("dynamodb provider(NoSQL 范式首个)", () => {
  it("capabilities:nosql 范式 + iam-role + 非VpcBound + 不可 provision + glue 同步通道", () => {
    const cap = getProvider("dynamodb").capabilities;
    expect(cap.paradigm).toBe("nosql");
    expect(cap.credentialKind).toBe("iam-role"); // 无密钥
    expect(cap.isVpcBound).toBe(false); // DynamoDB 是 AWS 托管服务
    expect(cap.needsGlueConnection).toBe(false); // 走非 JDBC 路径
    expect(cap.canProvision).toBe(false); // 平台不代劳建表
    expect(cap.supportsCdc).toBe(false); // 一期批读
    expect(cap.syncChannels).toEqual(["glue"]); // Glue DDB 连接器批读入湖仓
    expect(cap.analysisChannels).toEqual([]); // 一期不直查
  });
  it("validateConfig:表名必填 + 合法字符(3~255)", () => {
    const p = getProvider("dynamodb");
    expect(p.validateConfig({ tableName: "GameScores" }).ok).toBe(true);
    expect(p.validateConfig({ tableName: "my.table-1_v2" }).ok).toBe(true);
    expect(p.validateConfig({ tableName: "" }).ok).toBe(false);
    expect(p.validateConfig({ tableName: "ab" }).ok).toBe(false); // 太短(<3)
    expect(p.validateConfig({ tableName: "bad name!" }).ok).toBe(false); // 空格/感叹号非法
    expect(p.validateConfig({ tableName: "a".repeat(256) }).ok).toBe(false); // 超 255
  });
  it("buildConnection:产出 nosql 范式 + tableArn(账号从 env 派生,不硬编码)", () => {
    const prev = process.env.AWS_ACCOUNT_ID;
    process.env.AWS_ACCOUNT_ID = "123456789012";
    const cm = getProvider("dynamodb").buildConnection({ type: "dynamodb", connection: { tableName: "Orders", region: "us-east-1" } });
    expect(cm.paradigm).toBe("nosql");
    expect(cm.tableArn).toBe("arn:aws:dynamodb:us-east-1:123456789012:table/Orders");
    expect(cm.props?.tableName).toBe("Orders");
    if (prev === undefined) delete process.env.AWS_ACCOUNT_ID; else process.env.AWS_ACCOUNT_ID = prev;
  });
  it("iam-role 凭证:不实现 buildSecretPayload(无密钥可存)", () => {
    expect(getProvider("dynamodb").buildSecretPayload).toBeUndefined();
  });
  it("无 provision(canProvision=false → 不代劳建表)", () => {
    expect(getProvider("dynamodb").provision).toBeUndefined();
    expect(getProvider("dynamodb").capabilities.canProvision).toBe(false);
  });
});

describe("s3 provider(对象存储范式首个)", () => {
  it("capabilities:object-store 范式 + iam-role + 非VpcBound + glue 同步 + athena 直查通道", () => {
    const cap = getProvider("s3").capabilities;
    expect(cap.paradigm).toBe("object-store");
    expect(cap.credentialKind).toBe("iam-role"); // 无密钥
    expect(cap.isVpcBound).toBe(false);
    expect(cap.needsGlueConnection).toBe(false); // 走非 JDBC 路径
    expect(cap.canProvision).toBe(false); // 平台不代劳建桶
    expect(cap.supportsCdc).toBe(false);
    expect(cap.syncChannels).toEqual(["glue"]);
    expect(cap.analysisChannels).toEqual(["athena"]); // 🔴 差异化:外部表直查
  });
  it("validateConfig:桶名必填 + 合法(3~63) + format 白名单", () => {
    const p = getProvider("s3");
    expect(p.validateConfig({ bucket: "my-data-lake" }).ok).toBe(true);
    expect(p.validateConfig({ bucket: "my-data-lake", prefix: "events/", format: "parquet" }).ok).toBe(true);
    expect(p.validateConfig({ bucket: "" }).ok).toBe(false);
    expect(p.validateConfig({ bucket: "AB" }).ok).toBe(false); // 大写非法 + 太短
    expect(p.validateConfig({ bucket: "my-data-lake", format: "xml" }).ok).toBe(false); // 格式不在白名单
  });
  it("buildConnection:产出 object-store 范式 + s3Uri(prefix 规范化尾部 /)", () => {
    const p = getProvider("s3");
    const cm = p.buildConnection({ type: "s3", connection: { bucket: "lake", prefix: "raw/events", region: "us-east-1", format: "csv" } });
    expect(cm.paradigm).toBe("object-store");
    expect(cm.s3Uri).toBe("s3://lake/raw/events/"); // prefix 补尾部 /
    expect(cm.props?.bucket).toBe("lake");
    expect(cm.props?.format).toBe("csv");
  });
  it("buildConnection:空 prefix = 桶根(s3://bucket/)", () => {
    const cm = getProvider("s3").buildConnection({ type: "s3", connection: { bucket: "lake" } });
    expect(cm.s3Uri).toBe("s3://lake/");
  });
  it("iam-role 凭证:不实现 buildSecretPayload(无密钥可存)", () => {
    expect(getProvider("s3").buildSecretPayload).toBeUndefined();
  });
  it("无 provision(canProvision=false → 不代劳建桶)", () => {
    expect(getProvider("s3").provision).toBeUndefined();
  });
});

// 🔴 建源 API(route.ts:68-69)按 needsGlueConnection 分流:true→JDBC 原路径(零回归)、false→非JDBC新路径。
// 这条锁定分流依据,防未来改 capabilities 时悄悄把 JDBC 源踢进非 JDBC 路径(或反之)。
describe("建源 API 范式分流契约(needsGlueConnection 驱动)", () => {
  it("JDBC 四兄弟 needsGlueConnection=true → 走 JDBC 原路径(host/port/db 必填,零回归)", () => {
    for (const t of ["mysql", "postgresql", "oracle", "sqlserver"] as DataSourceType[]) {
      expect(getProvider(t).capabilities.needsGlueConnection).toBe(true);
    }
  });
  it("kinesis needsGlueConnection=false → 走非 JDBC 路径(连接袋 + provider.validateConfig)", () => {
    expect(getProvider("kinesis").capabilities.needsGlueConnection).toBe(false);
  });
});

describe("normalize 归一(向后兼容零迁移)", () => {
  it("旧扁平 item 归一成 connection 袋", () => {
    const old = { type: "mysql", host: "db.example.com", port: 3306, database: "app", username: "u" };
    expect(readConnection(old)).toEqual({ host: "db.example.com", port: 3306, database: "app" });
  });
  it("新格式 item(有 connection)直接用,不被扁平字段污染", () => {
    const neu = { type: "postgresql", connection: { host: "pg.example.com", port: 5432, database: "shop" }, host: "STALE", port: 1 };
    expect(readConnection(neu)).toEqual({ host: "pg.example.com", port: 5432, database: "shop" });
  });
  it("扁平缺字段时只回填有值的键(不塞 undefined)", () => {
    const partial = { type: "mysql", host: "h" };
    expect(readConnection(partial)).toEqual({ host: "h" });
  });
  it("toSourceRef 带出 secretArn/glueConnectionName/username", () => {
    const ref = toSourceRef({ type: "mysql", host: "h", port: 3306, database: "d", username: "u", secretArn: "arn:x", glueConnectionName: "conn-1" });
    expect(ref.type).toBe("mysql");
    expect(ref.secretArn).toBe("arn:x");
    expect(ref.glueConnectionName).toBe("conn-1");
    expect(ref.username).toBe("u");
    expect(ref.connection.host).toBe("h");
  });
});

describe("buildConnection 逐字一致(收编铁证:与旧 JDBC_URL/driver 一致;起 MySQL 多一个方言默认参数,见 jdbc-params.test.ts)", () => {
  const cases: Array<{ type: DataSourceType; host: string; port: number; db: string; url: string; driver: string }> = [
    // MySQL 默认带 zeroDateTimeBehavior=CONVERT_TO_NULL(零值时间戳不再让整个同步作业失败)
    { type: "mysql", host: "h", port: 3306, db: "d", url: "jdbc:mysql://h:3306/d?zeroDateTimeBehavior=CONVERT_TO_NULL", driver: "com.mysql.cj.jdbc.Driver" },
    { type: "postgresql", host: "h", port: 5432, db: "d", url: "jdbc:postgresql://h:5432/d", driver: "org.postgresql.Driver" },
    // 根治:Oracle 统一用 Service Name(EZConnect)格式 @//h:p/d,与 Node 侧 oracledb
    // connectString "h:p/service" 语义一致(此前 SID 冒号格式 @h:p:d 与 connectString 打架)。
    { type: "oracle", host: "h", port: 1521, db: "d", url: "jdbc:oracle:thin:@//h:1521/d", driver: "oracle.jdbc.driver.OracleDriver" },
    { type: "sqlserver", host: "h", port: 1433, db: "d", url: "jdbc:sqlserver://h:1433;databaseName=d", driver: "com.microsoft.sqlserver.jdbc.SQLServerDriver" },
  ];
  for (const c of cases) {
    it(`${c.type}: JDBC URL + driver 与旧实现一致`, () => {
      const cm = getProvider(c.type).buildConnection({ type: c.type, connection: { host: c.host, port: c.port, database: c.db } });
      expect(cm.paradigm).toBe("jdbc");
      expect(cm.jdbcUrl).toBe(c.url);
      expect(cm.driverClass).toBe(c.driver);
    });
  }
  it("MySQL 与被收编的 datasource-service.ts:15 JDBC_URL 模板逐字相同(主体部分;尾随方言默认参数)", () => {
    // 旧: mysql: (h,p,d) => `jdbc:mysql://${h}:${p}/${d}`
    const cm = getProvider("mysql").buildConnection({ type: "mysql", connection: { host: "db-1", port: 3306, database: "ecommerce" } });
    expect(cm.jdbcUrl).toBe("jdbc:mysql://db-1:3306/ecommerce?zeroDateTimeBehavior=CONVERT_TO_NULL");
    expect(cm.jdbcUrl?.split("?")[0]).toBe("jdbc:mysql://db-1:3306/ecommerce");
  });
  it("端口缺失时用 provider 的 defaultPort", () => {
    const cm = getProvider("postgresql").buildConnection({ type: "postgresql", connection: { host: "h", database: "d" } });
    expect(cm.jdbcUrl).toBe("jdbc:postgresql://h:5432/d");
  });
});

describe("capabilities 正确(数据驱动 recommendChannel)", () => {
  it("MySQL 独有 zero-etl 通道", () => {
    expect(getProvider("mysql").capabilities.syncChannels).toContain("zero-etl");
  });
  it("PG/Oracle/SQLServer 无 zero-etl(那是 MySQL→Redshift 专属)", () => {
    for (const t of ["postgresql", "oracle", "sqlserver"] as DataSourceType[]) {
      expect(getProvider(t).capabilities.syncChannels).not.toContain("zero-etl");
      expect(getProvider(t).capabilities.syncChannels).toContain("glue");
      expect(getProvider(t).capabilities.syncChannels).toContain("dms");
    }
  });
  it("JDBC 四兄弟都是 jdbc 范式 + userpass 凭证 + VpcBound + 需 Glue Connection", () => {
    // 只遍历 JDBC 类型(kinesis 是 stream 范式,单列在 kinesis provider describe 里断言)。
    for (const t of ["mysql", "postgresql", "oracle", "sqlserver"] as DataSourceType[]) {
      const cap = getProvider(t).capabilities;
      expect(cap.paradigm).toBe("jdbc");
      expect(cap.credentialKind).toBe("userpass");
      expect(cap.isVpcBound).toBe(true);
      expect(cap.needsGlueConnection).toBe(true);
    }
  });
});

describe("validateConfig(收编 test/route.ts 字符串校验)", () => {
  it("合法配置通过", () => {
    const r = getProvider("mysql").validateConfig({ host: "db.example.com", port: 3306, database: "app" });
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });
  it("缺 host/非法端口/缺库 各报错", () => {
    const r = getProvider("mysql").validateConfig({ host: "", port: 99999, database: "" });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
  it("host 格式无效被拒", () => {
    const r = getProvider("postgresql").validateConfig({ host: "notahost", port: 5432, database: "d" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("主机"))).toBe(true);
  });
});

describe("buildSecretPayload(收编 datasource-service.ts:28 凭证形态)", () => {
  it("JDBC 凭证恒为 {username,password}", () => {
    const payload = getProvider("mysql").buildSecretPayload!({ username: "u", password: "p" });
    expect(payload).toBe(JSON.stringify({ username: "u", password: "p" }));
  });
  it("无 username 返回 undefined(不误建空 secret)", () => {
    expect(getProvider("mysql").buildSecretPayload!({})).toBeUndefined();
  });
});

// Oracle/SQLServer → Redshift 类型映射(取代此前 postgresql?PG:MYSQL 二选一,让 Oracle/
// SQLServer 特有类型不再全 fallback 到 VARCHAR(256))。向导「字段映射预览 / 生成建表 DDL」用它。
describe("类型映射 mapColumnType(补 Oracle/SQLServer 专属表)", () => {
  it("Oracle 特有类型正确映射(不再 fallback VARCHAR(256))", () => {
    expect(mapColumnType("oracle", "VARCHAR2").targetType).toBe("VARCHAR");
    expect(mapColumnType("oracle", "NUMBER").targetType).toBe("DECIMAL"); // 无精度 → 光秃 DECIMAL(同 MySQL/PG decimal 语义)
    expect(mapColumnType("oracle", "CLOB").targetType).toBe("VARCHAR(65535)");
    expect(mapColumnType("oracle", "BINARY_DOUBLE").targetType).toBe("DOUBLE PRECISION");
    // 带精度 NUMBER(10,2) 保留 size(走 DECIMAL + size 逻辑,与 MySQL/PG decimal 一致)。
    expect(mapColumnType("oracle", "NUMBER(10,2)").targetType).toBe("DECIMAL(10,2)");
  });
  it("SQLServer 特有类型正确映射", () => {
    expect(mapColumnType("sqlserver", "nvarchar").targetType).toBe("VARCHAR");
    expect(mapColumnType("sqlserver", "bit").targetType).toBe("BOOLEAN");
    expect(mapColumnType("sqlserver", "datetime2").targetType).toBe("TIMESTAMP");
    expect(mapColumnType("sqlserver", "uniqueidentifier").targetType).toBe("VARCHAR(36)");
    expect(mapColumnType("sqlserver", "money").targetType).toBe("DECIMAL(19,4)");
    // nvarchar(100) 保留 size。
    expect(mapColumnType("sqlserver", "nvarchar(100)").targetType).toBe("VARCHAR(100)");
  });
  it("MySQL/PG 现有映射不受影响(回归保护)", () => {
    expect(mapColumnType("mysql", "int").targetType).toBe("INTEGER");
    expect(mapColumnType("mysql", "tinyint(1)").targetType).toBe("BOOLEAN");
    expect(mapColumnType("postgresql", "jsonb").targetType).toBe("SUPER");
    expect(mapColumnType("postgresql", "character varying").targetType).toBe("VARCHAR");
  });
  it("未知源库/未知类型仍安全兜底 VARCHAR(256)", () => {
    expect(mapColumnType("oracle", "SDO_GEOMETRY").targetType).toBe("VARCHAR(256)");
    expect(mapColumnType("unknown-db", "int").targetType).toBe("INTEGER"); // 未知库回退 MySQL 表
  });
});
