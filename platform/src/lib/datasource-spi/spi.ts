// 数据源 SPI 契约(DataSourceProvider)。
//
// 【信条】(照抄 lib/engines/spi.ts 精神):provider 每个方法语义对应现有某段实现,不凭空发明。
// 是「把散落的 MySQL 实现收编进 mysql provider」,行为逐字不变;之后每期加一个 provider 纯增量。
//
// 方法语义映射现有实现:
//  validateConfig  ← app/api/datasources/test/route.ts:62-92(建源表单字符串校验)
//  buildConnection ← lib/aws/datasource-service.ts:14(JDBC_URL 表)+ glue-script-generator.ts:105(driver)
//  testConnection  ← lib/aws/datasource-service.ts:256(testConnection,查 Glue Connection)
//  ping            ← lib/datasource/heartbeat.ts:26(pingDataSource,SELECT 1)
//  introspect      ← lib/datasource/schema-reader.ts:30(readSourceSchema,INFORMATION_SCHEMA)
//  buildSecretPayload ← lib/aws/datasource-service.ts:28(JSON.stringify({username,password}))
//
// registry 按 DataSourceType 分派;provider 内部把「连接属性袋」(见 normalize.readConnection)
// 收窄到自己的形态。调用方永远只面对 getProvider(type),不判范式。

import type {
  DataSourceType,
  DataSourceCapabilities,
  ConnectionModel,
  SourceDataset,
  TestResult,
  PingResult,
} from "./types";

// provider 方法的入参:范式无关的「源连接信息」。由 DataSource item 经 normalize 归一得到,
// 兼容旧扁平字段(host/port/database)与新 connection 属性袋。
// (刻意不直接依赖 @/types/datasource 的完整 DataSource,保持 SPI 层可独立单测、低耦合。)
export interface SourceRef {
  type: DataSourceType;
  connection: Record<string, any>; // 归一后的连接属性袋(JDBC:{host,port,database};S3:{bucket,prefix}…)
  secretArn?: string; // 凭证引用(userpass/mtls 有;iam-role/none 无)
  username?: string; // 冗余(部分现有调用直接带,凭证读不到时兜底)
  glueConnectionName?: string; // JDBC 类源的 Glue Connection 名(testConnection 用)
}

export interface DataSourceProvider {
  type: DataSourceType;
  capabilities: DataSourceCapabilities;

  // 校验建源表单的连接配置(取代 test/route.ts 里散落的字符串校验)。返回可读错误清单。
  validateConfig(conn: Record<string, any>): { ok: boolean; errors: string[] };

  // 由源连接信息产出「连接模型」:JDBC→jdbcUrl+driver;S3→s3Uri;MSK→bootstrap。
  // 取代 3 份 JDBC_URL 副本 + Glue 脚本写死 driver。供同步脚本/查询/测试统一消费。
  buildConnection(ref: SourceRef): ConnectionModel;

  // 真连通性测试。JDBC=SELECT 1(或现有:验 Glue Connection);S3=HeadBucket;DDB=DescribeTable。
  testConnection(ref: SourceRef): Promise<TestResult>;

  // 轻量探活(心跳)。canPing=false 的 provider 返回 {reachable:null}(不改状态)。
  ping(ref: SourceRef): Promise<PingResult>;

  // 列数据集 + schema。canIntrospect=false 返回 []。
  // JDBC=INFORMATION_SCHEMA;S3=列 prefix + 采样;DDB=ListTables + scan 采样;MSK=ListTopics。
  introspect(ref: SourceRef): Promise<SourceDataset[]>;

  // 建源时把表单凭证 → secret 字符串(按 credentialKind 决定内容形态)。
  // userpass→JSON({username,password});iam-role/none→provider 不实现(返回 undefined)。
  buildSecretPayload?(input: Record<string, any>): string | undefined;

  // 【可选·写语义】新建底层资源(如建 Kinesis 流)。仅 capabilities.canProvision=true 的 provider 实现。
  //  返回新资源的连接袋(供随后落 bgp-datasources)+ 可读备注。
  //  🔴 幂等(已存在同名资源视为成功);🔴 必须由用户在页面显式确认(含成本告知)后才被调用。
  //  见 DESIGN.md §10.4。JDBC 类不实现 → UI 不显示「新建」。
  provision?(input: Record<string, any>): Promise<{ connection: Record<string, any>; note?: string }>;
}
