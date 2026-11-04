// 模块 42 — 数据源 SPI:通用类型（范式无关）。
//
// 设计红线：数据源走 SPI 插件化——新数据源 = 独立 provider 文件纯增量 + registry 注册一行;
// 老代码零改动。照抄样板:lib/engines/{types,spi,registry}.ts（引擎 SPI,已成立的样板）。
//
// 【为什么要能力标(capabilities)而非范式子接口】4 种范式(JDBC/对象存储/NoSQL/流)差异极大,
// 但调用方永远只面对一个 getProvider(type)。范式差异用「能力标 + 连接属性袋」表达,不用类型分叉——
// 与引擎 SPI 的 EngineCapabilities 完全同构(canStop 决定 UI 显不显示停止按钮 → 这里 canPing 决定
// 心跳按钮、isVpcBound 决定要不要网络配置区)。
//
// 设计文档:docs/design/42-datasource-ecosystem/DESIGN.md §4.1。

// 范式:决定 UI 分组 + 通道类别 + 连接属性袋形态。
export type SourceParadigm = "jdbc" | "object-store" | "nosql" | "stream";

// 全部支持的源类型（加源 = 这里加一个字面量 + registry 加一行 provider）。
// P42.1-P42.3 落 jdbc 四兄弟;P42.7 落 kinesis(流范式首个,收编 Flink 源);P42.4/P42.5 落 s3/dynamodb。
export type DataSourceType =
  | "mysql"
  | "postgresql"
  | "oracle"
  | "sqlserver"
  | "kinesis" // ← 流范式(P42.7)
  | "msk" // ← 流范式第二个:MSK / Kafka(P42.6)
  | "dynamodb" // ← NoSQL 范式首个(P42.5)
  | "s3"; // ← 对象存储范式首个(P42.4)

// 凭证形态:决定 Secret 内容结构 + 建源表单认证区 + provider 如何读凭证。
//  userpass   = {username,password}          —— JDBC 四兄弟
//  sasl-scram = {username,password}          —— Kafka/MSK SASL-SCRAM(独立语义:与 JDBC 区分认证区/端口/SQL 属性)
//  iam-role   = 用平台/Glue 角色,无需存密钥  —— S3 / DynamoDB / Kinesis / MSK-IAM
//  mtls       = {truststore,keystore,...}     —— Kafka mTLS(后续)
//  none       = 匿名/公开
export type CredentialKind = "userpass" | "sasl-scram" | "iam-role" | "mtls" | "none";

// 同步通道(数据驱动 recommendChannel:哪些通道能喂这个源)。
export type SyncChannel = "glue" | "dms" | "zero-etl" | "flink-cdc";

// 分析通道(哪些查询引擎能直查这个源)。
export type AnalysisChannel = "athena" | "redshift-federated" | "glue-catalog";

// 建源表单的连接字段描述——UI 用它动态渲染表单,取代写死 host/port/database。
// JDBC 出 host/port/database;S3 出 bucket/prefix;MSK 出 bootstrap/auth。
export interface ConnectionField {
  key: string; // 存进 DataSource.connection 的键
  label: string; // i18n 文案(遵「中文即 key」策略,见 lib/i18n)
  type: "text" | "number" | "select" | "secret" | "toggle";
  required: boolean;
  placeholder?: string;
  options?: { label: string; value: string }[]; // type=select 用
  defaultValue?: string | number | boolean;
}

export interface DataSourceCapabilities {
  paradigm: SourceParadigm;
  credentialKind: CredentialKind;
  isVpcBound: boolean; // JDBC/MSK=true(要子网/SG);S3/DynamoDB=false(AWS 服务)
  canIntrospect: boolean; // 能否列「数据集」+ 推断 schema
  canPing: boolean; // 能否轻量探活(SELECT 1 / HeadBucket / DescribeTable)
  supportsCdc: boolean; // 能否做增量/CDC(决定同步模式可选项)
  needsGlueConnection: boolean; // 同步是否需先建 Glue Connection(JDBC=true;S3/DDB 可不需)
  // 能否由平台侧「新建底层资源」(如建 Kinesis 流)。JDBC=false(库表是用户既有的,平台不建库);
  // Kinesis=true(可按需建流)。数据驱动 UI:true 才在第二层来源下拉显示「➕ 新建」。见 DESIGN §10.4。
  canProvision?: boolean;
  syncChannels: SyncChannel[]; // 该源能喂哪些同步通道(推荐引擎读这个)
  analysisChannels: AnalysisChannel[]; // 该源能被哪些引擎直查
  defaultPort?: number; // JDBC 默认端口(建源表单预填)
  icon?: string; // UI 图标(emoji,与现 DS_TYPE_OPTIONS 一致)
  label?: string; // UI 显示名(如 "PostgreSQL")
}

// introspect 归一产物(4 范式统一形状)。
export interface SourceColumn {
  name: string;
  type?: string;
  nullable?: boolean;
  key?: string; // 主键/索引标记(如 MySQL COLUMN_KEY)
  comment?: string;
}
export interface SourceDataset {
  name: string; // 表名 / topic / prefix / 流名
  kind: "table" | "topic" | "prefix" | "collection" | "stream";
  columns: SourceColumn[]; // 关系型=列;S3=推断字段;DDB=采样属性;MSK=消息字段
  meta?: Record<string, any>; // 范式专属(S3 format、DDB pk/sk、MSK 分区数…)
}

// 连接模型:provider.buildConnection 的产物,供同步脚本/查询/测试统一消费。
// 取代散落 3 份的 JDBC_URL 副本 + Glue 脚本写死 driver。
export interface ConnectionModel {
  paradigm: SourceParadigm;
  // JDBC 专属
  jdbcUrl?: string;
  driverClass?: string; // com.mysql.cj.jdbc.Driver / org.postgresql.Driver / ...
  // 对象存储专属(后续)
  s3Uri?: string;
  // NoSQL 专属(后续)
  tableArn?: string;
  // 流专属(后续)
  bootstrapServers?: string;
  // 通用:附加属性(引擎特定连接参数)
  props?: Record<string, string>;
}

// 连接测试/探活结果(与现 datasource-service.ts:TestResult/heartbeat:PingResult 兼容)。
export interface TestResult {
  success: boolean;
  steps: { name: string; status: "pass" | "fail" | "skip"; message: string; latencyMs?: number }[];
  totalMs: number;
}
export interface PingResult {
  reachable: boolean | null; // null = 该范式不支持探活(不改状态)
  latencyMs?: number;
  error?: string;
}
