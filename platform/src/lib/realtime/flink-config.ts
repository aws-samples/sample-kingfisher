// 模块 32 — 实时计算 Flink 统一配置(单一事实来源)。
//
// 生产原则:版本/资源标识全部走配置(CDK 注入的环境变量),**不在代码里写死**。
// 升级 Flink 只需:① 改 CDK 的 FLINK_RUNTIME_ENVIRONMENT(如 FLINK-1_21)并重部署平台;
// ② 用对应版本重建 runner JAR(pom 版本属性集中在 flink-sql-runner/pom.xml,一处改)。
// 展示版本号由 runtimeEnvironment 派生,绝不另设写死的标签。
//
// 多"连接器包":不同 sink 的连接器对依赖体积/可用性不同,但【运行时版本统一为 1.20】——
// 平台用多个代码 JAR(连接器包)承载,不为某个 sink 另设 Flink 版本。默认 runner 打 Kinesis/JDBC/S3,
// S3 Tables(托管 Iceberg)sink 用额外打入 Iceberg 的独立连接器包 JAR(仍 Flink 1.20)。
// 后端按 sinkType 经 runnerFor() 选择「运行时版本 + 代码 JAR」,二者皆来自配置(env),不硬编码。
import { homeRegion } from "@/lib/place/home-region";
export const FLINK = {
  region: homeRegion(),
  account: process.env.AWS_ACCOUNT_ID || "",
  // MSAF 运行时 —— 默认 runner 的版本事实来源(由 platform-stack 注入)。
  runtimeEnvironment: process.env.FLINK_RUNTIME_ENVIRONMENT || "FLINK-1_20",
  roleArn: process.env.FLINK_RUNTIME_ROLE_ARN || "",
  sourceStream: process.env.FLINK_SOURCE_STREAM || "bgp-flink-source",
  codeBucket: process.env.FLINK_CODE_BUCKET || "",
  codeKey: process.env.FLINK_CODE_KEY || "flink/flink-sql-runner.jar",
  outputBucket: process.env.FLINK_OUTPUT_BUCKET || "",
  // 私有子网(MySQL 等私有 VPC sink 的 MSAF VPC 接入)。
  subnetIds: (process.env.FLINK_SUBNET_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),

  // S3 Tables(托管 Iceberg)连接器包的代码 JAR(与基础 runner【同为 Flink 1.20】,只是额外打入 Iceberg)。
  // 运行时版本统一走 runtimeEnvironment(上方),不为某个 sink 另设版本 —— 版本只有一个升级开关。
  s3tableCodeKey: process.env.FLINK_S3T_CODE_KEY || "flink/flink-sql-runner-s3t.jar",
  // Bug#5:Kafka/MSK 源 → S3 Tables 组合包(= s3t 包 + kafka connector + msk-iam-auth + relocation)。
  // s3t 包未打 kafka connector,而 iceberg 重栈短路(assembleModularUberJar)不走运行期合并 → kafka×iceberg
  // 组合原本崩 "no factory for kafka"。装配路由对"kafka源+iceberg sink"选本包,现有 s3t 包不动零回归。
  s3tKafkaCodeKey: process.env.FLINK_S3T_KAFKA_CODE_KEY || "flink/flink-sql-runner-s3t-kafka.jar",
  s3tablesBucket: process.env.FLINK_S3TABLES_BUCKET || "bgp-table-bucket",
  // S3 Tables 命名空间(库)。Flink 流作业的结果表落于此 namespace,避免污染其它命名空间。
  s3tableDb: process.env.FLINK_S3TABLE_DB || "realtime",

  // 自定义连接器(用户上传的 sink JAR)在代码桶下的前缀;启动时合并出的 per-job uber-jar 前缀。
  connectorsPrefix: process.env.FLINK_CONNECTORS_PREFIX || "flink/connectors/",
  jobsPrefix: process.env.FLINK_JOBS_PREFIX || "flink/jobs/",

  // 模块 32-CR 连接器运行时(模块化按需拼装)。CR.2 构建产物上传到 modulesPrefix;
  //  薄基础 runner(modularBaseKey)+ 各连接器模块(<modulesPrefix><id>.jar)运行期按 resolveModules 拼装,
  //  内容哈希缓存到 uberCachePrefix。🔴 与现有 codeKey/s3tableCodeKey(胖包 fallback)并存,CR.4 才切默认。
  modulesPrefix: process.env.FLINK_MODULES_PREFIX || "flink/modules/",
  modularBaseKey: process.env.FLINK_MODULAR_BASE_KEY || "flink/modules/flink-module-base.jar",
  uberCachePrefix: process.env.FLINK_UBER_CACHE_PREFIX || "flink/uber-cache/",
} as const;

export type FlinkRunner = { runtimeEnvironment: string; codeKey: string };

/** 按 sink 类型选择 runner。运行时版本【始终】统一为配置中的 FLINK_RUNTIME_ENVIRONMENT(如 FLINK-1_20),
 *  只有"连接器包"(代码 JAR)不同:s3table → Iceberg 包;其余 → 基础 runner。自定义 sink(上传 JAR)
 *  在启动时合并出 per-job 代码 JAR,不走此函数(见 flink-service 的自定义装配)。 */
export function runnerFor(sinkType?: string): FlinkRunner {
  const codeKey = sinkType === "s3table" ? FLINK.s3tableCodeKey : FLINK.codeKey;
  return { runtimeEnvironment: FLINK.runtimeEnvironment, codeKey };
}

/** S3 Tables 表桶 ARN:arn:aws:s3tables:<region>:<account>:bucket/<bucket>。
 *  🔴🔴 B-26(2026-10-01):原来是零参函数、恒拼**主控区**那只表桶 ⇒ 建在 us-west-2 的 Flink 作业,Iceberg sink 的
 *    `warehouse` 被填成主控区表桶(落点作者 `resolveFlinkPlace` 早就给了该区的 `s3tablesBucket`,只是这里没接)。
 *    ⇒ 改成只接受**已解析的落点**,不给就编译不过。 */
export function tableBucketArn(place: { region: string; account: string; s3tablesBucket: string }): string {
  return `arn:aws:s3tables:${place.region}:${place.account}:bucket/${place.s3tablesBucket}`;
}

/** 由运行时环境派生展示版本号:FLINK-1_20 → "1.20"(升级不改此逻辑)。 */
export function flinkVersionLabel(env?: string): string {
  return (env || FLINK.runtimeEnvironment || "").replace(/^FLINK-/, "").replace(/_/g, ".") || "unknown";
}

/** 引擎展示名(前端动态获取,避免内联写死)。 */
export function flinkEngineLabel(): string {
  return `Amazon Managed Service for Apache Flink ${flinkVersionLabel()}`;
}
