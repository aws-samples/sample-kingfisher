// 模块 32 — 实时计算 Flink 编排服务(Amazon Managed Service for Apache Flink / MSAF)。
//
// 每个 Flink SQL 流作业 = 一个 MSAF 应用(从 S3 上的通用 flink-sql-runner.jar 运行,用户 SQL 经
// 运行时属性 bgp.sql 注入)。生命周期:ensure(Create)→ Start → Describe(status)→ Stop+Delete(止血)。
//
// 红线:不硬编码账号/区域/ARN —— 全部由运行时 env(platform-stack 确定性派生)+ jobId 组装;
// 存库的 SQL 用占位符(${SOURCE_STREAM_ARN}/${OUTPUT_PATH}/${REGION}),启动时才解析为具体值。
// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import {
  CreateApplicationCommand,
  UpdateApplicationCommand,
  StartApplicationCommand,
  StopApplicationCommand,
  DeleteApplicationCommand,
  DescribeApplicationCommand,
  CreateApplicationPresignedUrlCommand,
  ListApplicationSnapshotsCommand,
  RuntimeEnvironment,
} from "@aws-sdk/client-kinesis-analytics-v2";
import { ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  CreateLogGroupCommand, CreateLogStreamCommand,
  FilterLogEventsCommand, DeleteLogGroupCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { DeleteCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { DescribeDBInstancesCommand } from "@aws-sdk/client-rds";
import { KafkaClient, GetBootstrapBrokersCommand } from "@aws-sdk/client-kafka";
import { FLINK, runnerFor, tableBucketArn, type FlinkRunner } from "./flink-config";
// @kf-batch 50-WP4quater-reads(工单 SC-5)—— 落点与按区客户端的唯一出口
import { resolveFlinkPlace, flinkClients, ensureRunnerJar, type FlinkPlace } from "./flink-place";
// @kf-batch 50-WP31-place-first-class —— 多区扇出的唯一写法(L10)
import { forEachTargetPlace } from "@/lib/place/fanout";
import { rdsClientFor } from "@/lib/exec-env/target-clients";
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
// 序 72 B-139(模块 56):执行角色解析 / 预检的唯一作者
import { resolveExecutionRoleArn } from "@/lib/execution-role/resolve";
import { preflightExecutionRole, assertPreflightPassed } from "@/lib/execution-role/preflight";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";
// 🔴 凭证读取走 ARN 派生 region 的唯一出口(工单 SC-31):secret ARN 自带 region
import { getSecretJson } from "@/lib/datasource-spi/secrets";
// @kf-batch 44-jdbc-params —— sink 的 MySQL JDBC URL 走数据源 SPI 同一个作者(不经 lib/aws/datasource-service,避免把 Glue / EC2 SDK 拉进实时模块图)
import { getProvider } from "@/lib/datasource-spi/registry";
import { toSourceRef } from "@/lib/datasource-spi/normalize";
import { runSelectAthena } from "@/lib/genbi/athena";
import { qualifiedName, resolveS3TablesPlace } from "@/lib/athena/s3tables";
import { getConnector, assembleUberJar, assembleModularUberJar } from "./flink-connectors";
import { guard } from "@/lib/cookbook";
import { recordComputeLineage } from "@/lib/governance/lineage-service";
import { pushComputeLineageToOM } from "@/lib/openmetadata/om-push";
// 模块 55 第二批:等 MSAF 过渡态的唯一原语 + 后台销毁的等待者上下文(flink-start / stop / delete 三条路由已是长操作)
import { awaitTerminal, LongOpWaitBudgetExceeded } from "@/lib/long-ops/await-terminal";
import { runAsBackgroundWaiter } from "@/lib/long-ops/context";

// @kf-batch 50-WP4quater-reads(工单 SC-5)
// 🔴🔴 这里原来是 **6 个模块级主控区客户端 + 7 个部署时快照常量**。用户 2026-09-10 的原话是
// 「一定要加这个维度,不然白干了,所有任务都在自己的区域跑,不然没有意义。」
// 那种写法的三种失败形态(都不是「报个错」那么轻):
//   ① 用主控区 kda 去 Describe 别区的应用 ⇒ ResourceNotFound ⇒ 状态对账把作业标成「已删除」
//      (而它在那个区好好跑着);
//   ② 用主控区角色去 CreateApplication ⇒ AccessDenied,界面上只有「启动失败」;
//   ③ 最坏:**应用跑在那个区、产物写回主控区** ⇒ 数据驻留承诺当场破,而一切看起来正常。
// ⇒ 一切区域性的东西都从 `FlinkPlace` 来(@kf-batch 50-WP31-place-first-class:主控区也读描述符,不再走 FLINK 常量)。
const ACCOUNT = FLINK.account; // 单账号 × 多 region(生产形态):账号不随区变
const SOURCE_STREAM = FLINK.sourceStream;
const USER_ID = "default-user";

/** 落点 + 该落点的一组客户端。所有 AWS 触点都从这里取,不再有模块级客户端。 */
type FlinkCtx = FlinkPlace & Awaited<ReturnType<typeof flinkClients>>;

async function ctxFor(targetId: string): Promise<FlinkCtx> {
  const place = await resolveFlinkPlace(targetId);
  return { ...place, ...(await flinkClients(place)) };
}

/**
 * 作业行 → 它的执行落点 targetId(**唯一入口**)。
 * 🔴 无章的存量作业回落主控区:落章之前流作业只能在主控区跑,这是历史事实
 * (与平台其它「无章 ⇒ 主控区」同一条回落规则,由 `bindingTargets` 单一作者提供)。
 */
export function flinkJobTarget(job: unknown): string {
  return bindingTargets((job ?? {}) as { targets?: unknown; targetId?: unknown })[0] || HOME_TARGET_ID;
}

// MSAF 应用日志组(每应用一个),供详情页「运行日志」读取。
export function logGroupName(jobId: string): string {
  return `/aws/kinesis-analytics/${appName(jobId)}`;
}
async function ensureLogGroup(ctx: FlinkCtx, jobId: string): Promise<string> {
  const lg = logGroupName(jobId);
  // 🔴 日志组必须建在**应用所在区**:建在主控区的话,应用启动时拿不到那个 ARN(跨区日志组不可用),
  //    而 MSAF 的报错只说「CloudWatchLoggingOptions 无效」。
  try { await ctx.cwl.send(new CreateLogGroupCommand({ logGroupName: lg })); } catch { /* exists */ }
  try { await ctx.cwl.send(new CreateLogStreamCommand({ logGroupName: lg, logStreamName: "flink" })); } catch { /* exists */ }
  return `arn:aws:logs:${ctx.region}:${ctx.account}:log-group:${lg}:log-stream:flink`;
}

// @kf-batch 50-WP31-place-first-class —— 序 3 收尾:落点**必填**(原来不给 ⇒ 读 FLINK 常量 = 主控区那套)。
export function flinkReady(place: FlinkPlace): { ok: boolean; reason?: string } {
  if (!place.roleArn || !place.codeBucket || !place.account) {
    return { ok: false, reason: "实时计算基建未就绪:请先部署 BgpFlinkStack(-c enable-flink=1)并上传 runner JAR" };
  }
  return { ok: true };
}

// @kf-batch 50-WP31-place-first-class —— 区必填(原来缺省 = FLINK.region,即主控区)
export function sourceStreamArn(region: string): string {
  return `arn:aws:kinesis:${region}:${ACCOUNT}:stream/${SOURCE_STREAM}`;
}
/** 产物路径。🔴 桶必须是**作业所在区**那个:写回主控区就是数据出境。
 *  @kf-batch 50-WP31-place-first-class —— 桶必填(原来缺省 = FLINK.outputBucket,即主控区的桶)。 */
export function outputPath(jobId: string, outputBucket: string): string {
  return `s3://${outputBucket}/flink-out/${jobId}/`;
}
export function appName(jobId: string): string {
  // MSAF 应用名:字母数字/_/-/.,≤128。用 jobId 末段(ULID 唯一)派生。
  return `bgp-flink-${jobId.slice(-16).toLowerCase()}`;
}

/** 平台默认 Flink SQL 模板(Kinesis 源 → 1 分钟滚动窗口聚合 → S3 sink)。用占位符,不含账号。 */
export function defaultFlinkSql(): string {
  return `CREATE TABLE orders_src (
  region STRING,
  amount DOUBLE,
  ts TIMESTAMP(3),
  WATERMARK FOR ts AS ts - INTERVAL '5' SECOND
) WITH (
  'connector' = 'kinesis',
  'stream.arn' = '\${SOURCE_STREAM_ARN}',
  'aws.region' = '\${REGION}',
  'source.init.position' = 'TRIM_HORIZON',
  'format' = 'json'
);

CREATE TABLE region_agg_sink (
  window_start TIMESTAMP(3),
  region STRING,
  total_amount DOUBLE,
  order_cnt BIGINT
) WITH (
  'connector' = 'filesystem',
  'path' = '\${OUTPUT_PATH}',
  'format' = 'json',
  'sink.rolling-policy.rollover-interval' = '30 s',
  'sink.rolling-policy.check-interval' = '10 s'
);

INSERT INTO region_agg_sink
SELECT window_start, region, SUM(amount) AS total_amount, COUNT(*) AS order_cnt
FROM TABLE(TUMBLE(TABLE orders_src, DESCRIPTOR(ts), INTERVAL '1' MINUTE))
GROUP BY window_start, window_end, region;`;
}

/** MySQL sink 默认模板(JDBC 批量 upsert)。连接串/账号/密码用占位符,启动时从目标数据源安全注入(不入库)。 */
export function mysqlSinkSql(): string {
  return `CREATE TABLE orders_src (
  region STRING,
  amount DOUBLE,
  ts TIMESTAMP(3),
  WATERMARK FOR ts AS ts - INTERVAL '5' SECOND
) WITH (
  'connector' = 'kinesis',
  'stream.arn' = '\${SOURCE_STREAM_ARN}',
  'aws.region' = '\${REGION}',
  'source.init.position' = 'TRIM_HORIZON',
  'format' = 'json'
);

CREATE TABLE region_agg_mysql (
  window_start TIMESTAMP(3),
  region STRING,
  total_amount DOUBLE,
  order_cnt BIGINT,
  PRIMARY KEY (window_start, region) NOT ENFORCED
) WITH (
  'connector' = 'jdbc',
  'url' = '\${MYSQL_URL}',
  'table-name' = 'flink_region_agg',
  'username' = '\${MYSQL_USER}',
  'password' = '\${MYSQL_PASSWORD}',
  'sink.buffer-flush.max-rows' = '200',
  'sink.buffer-flush.interval' = '3s'
);

INSERT INTO region_agg_mysql
SELECT window_start, region, SUM(amount) AS total_amount, COUNT(*) AS order_cnt
FROM TABLE(TUMBLE(TABLE orders_src, DESCRIPTOR(ts), INTERVAL '1' MINUTE))
GROUP BY window_start, window_end, region;`;
}

/** S3 Tables(AWS 托管 Iceberg)sink 默认模板。经原生 S3 Tables Iceberg catalog 落库;
 *  ${TABLE_BUCKET_ARN}/${S3TABLE_DB} 启动时按账号/区域派生注入(不入库、不硬编码)。需 Flink 1.19 runner。 */
export function s3TableSinkSql(): string {
  return `CREATE TABLE orders_src (
  region STRING,
  amount DOUBLE,
  ts TIMESTAMP(3),
  WATERMARK FOR ts AS ts - INTERVAL '5' SECOND
) WITH (
  'connector' = 'kinesis',
  'stream.arn' = '\${SOURCE_STREAM_ARN}',
  'aws.region' = '\${REGION}',
  'source.init.position' = 'TRIM_HORIZON',
  'format' = 'json'
);

CREATE CATALOG s3t WITH (
  'type' = 'iceberg',
  'catalog-impl' = 'software.amazon.s3tables.iceberg.S3TablesCatalog',
  'warehouse' = '\${TABLE_BUCKET_ARN}'
);

CREATE DATABASE IF NOT EXISTS s3t.\`\${S3TABLE_DB}\`;

CREATE TABLE IF NOT EXISTS s3t.\`\${S3TABLE_DB}\`.\`flink_region_agg\` (
  window_start TIMESTAMP(3),
  region STRING,
  total_amount DOUBLE,
  order_cnt BIGINT
);

INSERT INTO s3t.\`\${S3TABLE_DB}\`.\`flink_region_agg\`
SELECT window_start, region, SUM(amount) AS total_amount, COUNT(*) AS order_cnt
FROM TABLE(TUMBLE(TABLE orders_src, DESCRIPTOR(ts), INTERVAL '1' MINUTE))
GROUP BY window_start, window_end, region;`;
}

/** 自定义 sink 默认模板(以 OpenSearch 为例,connector=opensearch-2)。平台只提供源(Kinesis)与窗口聚合样板;
 *  【sink 的连接定义完全由用户自管】—— 连接参数(hosts/index 等)由用户按所用连接器填写。可选:用通用占位符
 *  \${SINK_HOST/SINK_USER/SINK_PASSWORD},选「凭证数据源」后启动时从其 Secrets 注入,免把密钥写进 SQL(不入库)。
 *  连接器 JAR 由用户上传,启动时与基础 runner 合并为 per-job uber-jar。 */
export function customSinkSql(): string {
  return `-- 源:平台 Kinesis 流(占位符启动注入)。以下为样板,sink 部分请按你的连接器自行定义。
CREATE TABLE orders_src (
  region STRING,
  amount DOUBLE,
  ts TIMESTAMP(3),
  WATERMARK FOR ts AS ts - INTERVAL '5' SECOND
) WITH (
  'connector' = 'kinesis',
  'stream.arn' = '\${SOURCE_STREAM_ARN}',
  'aws.region' = '\${REGION}',
  'source.init.position' = 'TRIM_HORIZON',
  'format' = 'json'
);

-- sink:示例为 OpenSearch(connector=opensearch-2,需在「连接器管理」上传对应 JAR)。connector / 连接参数
-- 均由你自管;若 sink 需账号密码,用 \${SINK_USER}/\${SINK_PASSWORD} 占位符并选「凭证数据源」(密钥不入库)。
CREATE TABLE region_agg_sink (
  window_start STRING,
  region STRING,
  total_amount DOUBLE,
  order_cnt BIGINT,
  PRIMARY KEY (window_start, region) NOT ENFORCED
) WITH (
  'connector' = 'opensearch-2',
  'hosts' = 'https://your-endpoint:443',
  'index' = 'flink_region_agg'
);

INSERT INTO region_agg_sink
SELECT DATE_FORMAT(window_start, 'yyyy-MM-dd HH:mm:ss') AS window_start, region, SUM(amount) AS total_amount, COUNT(*) AS order_cnt
FROM TABLE(TUMBLE(TABLE orders_src, DESCRIPTOR(ts), INTERVAL '1' MINUTE))
GROUP BY window_start, window_end, region;`;
}

/** 模块42 P42.6b — MSK/Kafka 源默认模板(Kafka 源 → 1 分钟滚动窗口聚合 → S3 sink)。
 *  §11.4 定稿:连接+认证全部占位注入,用户只写业务 schema/format/startup。
 *   · ${KAFKA_TOPIC}     —— 页面主 topic(混合模式:注入默认,SQL 可改);由 resolveMskSource 注入。
 *   · ${KAFKA_AUTH_PROPS} —— 裸占位符(不在引号内),展开为 bootstrap+认证块(IAM/SCRAM),密钥不入库。
 *     §11.4 已实测 guard("flink") 对裸占位符不阻断、guardCode 后原样保留。 */
export function mskSourceSql(): string {
  return `CREATE TABLE orders_src (
  region STRING,
  amount DOUBLE,
  ts TIMESTAMP(3),
  WATERMARK FOR ts AS ts - INTERVAL '5' SECOND
) WITH (
  'connector' = 'kafka',
  'topic' = '\${KAFKA_TOPIC}',
  'scan.startup.mode' = 'earliest-offset',
  'format' = 'json'
  \${KAFKA_AUTH_PROPS}
);

CREATE TABLE region_agg_sink (
  window_start TIMESTAMP(3),
  region STRING,
  total_amount DOUBLE,
  order_cnt BIGINT
) WITH (
  'connector' = 'filesystem',
  'path' = '\${OUTPUT_PATH}',
  'format' = 'json',
  'sink.rolling-policy.rollover-interval' = '30 s',
  'sink.rolling-policy.check-interval' = '10 s'
);

INSERT INTO region_agg_sink
SELECT window_start, region, SUM(amount) AS total_amount, COUNT(*) AS order_cnt
FROM TABLE(TUMBLE(TABLE orders_src, DESCRIPTOR(ts), INTERVAL '1' MINUTE))
GROUP BY window_start, window_end, region;`;
}

/** 把占位符解析为具体运行时值(账号/区域/输出路径不入库,启动时才注入)。
 *  注:${SOURCE_STREAM_ARN}/${SOURCE_STREAM} 不在此解析——它们由 resolveKinesisSource 按【所选 Kinesis
 *  数据源】注入(P42.7c 多源);无所选源时回退全局默认流(向后兼容旧作业)。见 resolveKinesisSource。 */
export function resolveSql(sql: string, jobId: string, place: FlinkPlace): string {
  // 🔴 `${REGION}` 与 `${OUTPUT_PATH}` 都是**落点事实**:解析成主控区的值再拿去别的区跑,
  //    作业会去主控区读写(连接器里的 aws.region 就是这么来的)。
  //    @kf-batch 50-WP31-place-first-class —— 落点必填(原来缺省 = 主控区常量)。
  return (sql || "")
    .replace(/\$\{OUTPUT_PATH\}/g, outputPath(jobId, place.outputBucket))
    .replace(/\$\{REGION\}/g, place.region);
}

/** 【单一事实源】按所选数据源解析 Kinesis 流名(P42.7c 两层模型第二层)。
 *  · 选了 kinesis 数据源 → 用其 connection.streamName(回退 connection.name);
 *  · 未选(或数据源非 kinesis) → 回退全局默认流 SOURCE_STREAM(向后兼容旧 Kinesis 作业)。
 *  🔴 启动侧(resolveKinesisSource)与造数侧(/produce 端点)都必须过它 —— 否则 produce 会像
 *     Bug#4 那样硬编码默认流、无视作业所选源(默认流成本改造后已删 → 必 500)。SSOT 不能只修一半。 */
export async function resolveKinesisStreamName(sourceDatasourceId?: string): Promise<string> {
  if (!sourceDatasourceId) return SOURCE_STREAM;
  const { Item: ds } = await docClient.send(new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: sourceDatasourceId } }));
  const sn = ds?.connection?.streamName || ds?.connection?.name;
  return ds && ds.type === "kinesis" && sn ? String(sn) : SOURCE_STREAM;
}

/** Kinesis 源:把 ${SOURCE_STREAM_ARN}/${SOURCE_STREAM} 解析为【所选 Kinesis 数据源】的流(P42.7c 多源)。
 *  流名解析收敛到 resolveKinesisStreamName(SSOT,与 /produce 端点共用)。
 *  与 resolveMysqlCdcSource 同构:源具体连接由 sourceDatasourceId 决定,不写死、不入库。 */
// @kf-batch 50-WP31-place-first-class —— 区与账号都取落点(原来区缺省 = 主控区、账号取 env 常量)
async function resolveKinesisSource(sql: string, sourceDatasourceId: string | undefined, place: Pick<FlinkPlace, "region" | "account">): Promise<string> {
  if (!/\$\{SOURCE_STREAM(_ARN)?\}/.test(sql)) return sql; // 无占位符(如 CDC 作业):不碰
  const streamName = await resolveKinesisStreamName(sourceDatasourceId);
  const arn = `arn:aws:kinesis:${place.region}:${place.account}:stream/${streamName}`;
  return sql
    .replace(/\$\{SOURCE_STREAM_ARN\}/g, arn)
    .replace(/\$\{SOURCE_STREAM\}/g, streamName);
}

/** 作业是否为 Kafka/MSK 源(SQL 用了 kafka connector)——决定是否需 VPC 接入(broker 在私有 VPC)+ 强制模块化装配。
 *  与 isMysqlCdcSource 同构:纯词法判定,基于【已注入的 finalSql】。 */
function isKafkaSource(sql: string): boolean {
  return /'connector'\s*=\s*'kafka'/i.test(sql);
}

/** MSK 认证 → Flink Kafka SQL 属性端口(§11.3)。数据驱动,与 provider(msk.ts)AUTH_PORT 同源语义。 */
const MSK_AUTH_PORT: Record<string, number> = { iam: 9098, scram: 9096 };

/** 纯函数(可单测,无 IO):按认证方式把 bootstrap + 认证拼成 ${KAFKA_AUTH_PROPS} 展开块(§11.3)。
 *  返回的片段以 `,` 开头,接在 SQL 的 'format'='json' 行之后(裸占位符,§11.4 已验 guard 放行)。
 *   · iam  : SASL_SSL + AWS_MSK_IAM + IAMLoginModule/IAMClientCallbackHandler(无密钥)。
 *   · scram: SASL_SSL + SCRAM-SHA-512 + ScramLoginModule(账密内联,由调用方从 Secrets Manager 取,不入库)。
 *  🔴 密钥红线:本函数不读 secret,scram 的 user/password 由调用方注入 —— 保证密钥只在启动内存态,不进受跟踪代码。
 *  🔴 传输加密不变量(安全审查 2026-07-27):security.protocol 恒为 `SASL_SSL`(TLS in-transit 加密)——
 *     【绝不产出 PLAINTEXT/SASL_PLAINTEXT】。iam/scram 两认证均走加密通道;plaintext(9092)/tls-mTLS(9094)
 *     不在本函数支持范围(mTLS 若将来做:keystore/truststore 密码必须走 Secrets Manager 不入库,且 MSAF
 *     托管无本地文件系统,.jks 证书分发需专门设计——不学 Apache 示例把密码明文写进 properties)。
 *     此不变量由 flink-service.test.ts「传输加密不变量」用例锁死。 */
export function buildKafkaAuthProps(auth: string, bootstrap: string, user?: string, password?: string): string {
  // security.protocol 硬编码 SASL_SSL:传输层加密不可绕过(见上「传输加密不变量」)。
  const head = `,\n  'properties.bootstrap.servers' = '${bootstrap}',\n  'properties.security.protocol' = 'SASL_SSL',\n`;
  if (auth === "scram") {
    return head +
      `  'properties.sasl.mechanism' = 'SCRAM-SHA-512',\n` +
      `  'properties.sasl.jaas.config' = 'org.apache.kafka.common.security.scram.ScramLoginModule required username="${user || ""}" password="${password || ""}";'`;
  }
  // 默认 iam(§11.3):无密钥。
  return head +
    `  'properties.sasl.mechanism' = 'AWS_MSK_IAM',\n` +
    `  'properties.sasl.jaas.config' = 'software.amazon.msk.auth.iam.IAMLoginModule required;',\n` +
    `  'properties.sasl.client.callback.handler.class' = 'software.amazon.msk.auth.iam.IAMClientCallbackHandler'`;
}

/** 模块42 P42.6b — MSK/Kafka 源:把 ${KAFKA_TOPIC} + ${KAFKA_AUTH_PROPS} 解析为【所选 MSK 数据源】的
 *  连接+认证(§11.4 定稿)。与 resolveKinesisSource/resolveMysqlCdcSource 同构:源连接由 sourceDatasourceId 决定,
 *  绝不入库/不进受跟踪代码(密钥红线,同 resolveMysqlSink)。
 *
 *  · ${KAFKA_TOPIC}      ← 数据源连接袋的 topic(connection.topic/defaultTopic);用户也可在 SQL 直接写死(混合模式)。
 *  · ${KAFKA_AUTH_PROPS} ← 裸占位符,展开为 bootstrap.servers + 认证块(§11.3):
 *      - iam  : SASL_SSL + AWS_MSK_IAM + IAMLoginModule/IAMClientCallbackHandler(无密钥)。
 *      - scram: SASL_SSL + SCRAM-SHA-512 + ScramLoginModule(账密从 Secrets Manager 注入,不入库)。
 *  · 托管 flavor 无 bootstrap → GetBootstrapBrokers 动态取(按 auth 取 SaslIam/SaslScram 串)。 */
async function resolveMskSource(sql: string, sourceDatasourceId: string | undefined, placeRegion: string): Promise<string> {
  if (!/\$\{KAFKA_(TOPIC|AUTH_PROPS)\}/.test(sql)) return sql; // 无 MSK 占位符:不碰(其它源作业零影响)
  if (!sourceDatasourceId) throw new Error("MSK/Kafka 源作业未选择源数据源(${KAFKA_*} 占位符无法注入)");
  const { Item: ds } = await docClient.send(new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: sourceDatasourceId } }));
  if (!ds) throw new Error("MSK 源数据源不存在: " + sourceDatasourceId);
  if (ds.type !== "msk") throw new Error("所选源数据源不是 MSK/Kafka 类型: " + sourceDatasourceId);
  const c = ds.connection || {};
  const flavor: string = c.mskFlavor === "self" ? "self" : "msk";
  const auth: string = c.auth === "scram" ? "scram" : "iam";
  const region: string = (c.region || placeRegion).toString();

  // bootstrap.servers:自建=连接袋手填;托管=优先连接袋缓存,否则 GetBootstrapBrokers 动态取(按 auth)。
  let bootstrap: string = (c.bootstrapServers || "").toString().trim();
  if (!bootstrap && flavor === "msk" && c.clusterArn) {
    const kafka = sdkClient("data-plane", KafkaClient, { region });
    try {
      const bb: any = await kafka.send(new GetBootstrapBrokersCommand({ ClusterArn: String(c.clusterArn) }));
      bootstrap = (auth === "scram" ? bb?.BootstrapBrokerStringSaslScram : bb?.BootstrapBrokerStringSaslIam) || "";
    } finally { kafka.destroy(); }
  }
  if (!bootstrap) throw new Error("无法确定 MSK bootstrap.servers(托管集群需 GetBootstrapBrokers 权限或连接袋缺 bootstrapServers)");

  // 认证块(§11.3):裸占位符 ${KAFKA_AUTH_PROPS} 展开为多行 'properties.*' 片段(前置逗号,接在 format 行后)。
  //  纯函数 buildKafkaAuthProps 拼接;scram 的账密在此从 Secrets Manager 取(不入库)后传入。
  let user: string | undefined; let password: string | undefined;
  if (auth === "scram") {
    if (ds.secretArn) {
      try {
        const sec = await getSecretJson(ds.secretArn);
        user = sec.username || sec.user || ""; password = sec.password || "";
      } catch (e: any) { throw new Error("读取 MSK SCRAM 密钥失败: " + String(e?.message || e)); }
    }
    if (!user || !password) throw new Error("MSK SCRAM 认证缺账密(检查数据源 secret)");
  }
  const authProps = buildKafkaAuthProps(auth, bootstrap, user, password);

  // topic:数据源连接袋优先(混合模式默认);未配则要求用户已在 SQL 写死实际 topic(占位符仍在=报错,不静默)。
  const topic: string = (c.topic || c.defaultTopic || "").toString().trim();
  let out = sql.replace(/\$\{KAFKA_AUTH_PROPS\}/g, authProps);
  if (/\$\{KAFKA_TOPIC\}/.test(out)) {
    if (!topic) throw new Error("MSK 源未指定 topic(数据源连接袋 connection.topic 为空,且 SQL 未替换 ${KAFKA_TOPIC});请在数据源配置 topic 或在 SQL 中直接填写 topic 名");
    out = out.replace(/\$\{KAFKA_TOPIC\}/g, topic);
  }
  void MSK_AUTH_PORT; // 端口语义已由 bootstrap 串隐含(broker 串带端口);保留常量供文档/校验参考
  return out;
}

/** MySQL sink:从目标数据源(+ Secrets Manager)解析 url/user/password,启动时注入;绝不入库/不进受跟踪代码。 */
async function resolveMysqlSink(sql: string, sinkDatasourceId?: string): Promise<string> {
  if (!sinkDatasourceId || !/\$\{MYSQL_/.test(sql)) return sql;
  const { Item: ds } = await docClient.send(new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: sinkDatasourceId } }));
  if (!ds) throw new Error("sink 目标数据源不存在: " + sinkDatasourceId);
  let user = ""; let password = "";
  if (ds.secretArn) {
    try {
      const sec = await getSecretJson(ds.secretArn);
      user = sec.username || sec.user || ""; password = sec.password || "";
    } catch (e: any) { throw new Error("读取 sink 数据源密钥失败: " + String(e?.message || e)); }
  }
  // @kf-batch 44-jdbc-params —— JDBC URL 不再手写第二份:与数据源 Glue 连接 / 同步脚本同一个作者(含用户附加参数与 MySQL 默认参数);
  //   同时兼容扁平行与 connection 袋(toSourceRef 归一)。sink 恒为 MySQL(模板 ${MYSQL_URL})。
  const url = getProvider("mysql").buildConnection(toSourceRef({ ...(ds as Record<string, any>), type: "mysql" })).jdbcUrl || "";
  return sql
    .replace(/\$\{MYSQL_URL\}/g, url)
    .replace(/\$\{MYSQL_USER\}/g, user)
    .replace(/\$\{MYSQL_PASSWORD\}/g, password);
}

/** 由 jobId 稳定派生一段【全局唯一】的 mysql-cdc server-id 范围(每作业固定、互不冲突)。
 *  MySQL 要求每个 binlog 副本 server-id 唯一;固定写死(如 5400-5404)会导致同一作业重启/多作业
 *  相互"server_uuid/server_id 冲突",binlog 流被 MySQL 以 Error 1236 杀掉 → 作业重启循环。
 *  范围长度须 ≥ 源并行度;这里给 5 个(够单/小并行度;增量快照模式按 split 用其中的 id)。 */
function deriveServerIdRange(jobId: string): string {
  let h = 0;
  for (let i = 0; i < jobId.length; i++) h = (h * 31 + jobId.charCodeAt(i)) >>> 0;
  // Flink CDC 用 Integer.parseInt 解析 server-id(有符号 32 位,上限 2147483647),超界会 NumberFormatException。
  // 故必须落在 signed-int 范围内:取 [100000, 2_147_483_000] 区间,留 +4 不越 Integer.MAX_VALUE;避开 MySQL 小保留 id。
  const base = 100000 + (h % 2_147_000_000);
  return `${base}-${base + 4}`;
}

/** MySQL CDC 源(模块32 多 source):mysql-cdc 源表的 hostname/port/username/password/database 占位符
 *  ${SRC_*},启动时从所选「源数据源」(+ Secrets Manager)注入,绝不入库/不进受跟踪代码(红线)。
 *  并把 server-id 改写为【按 jobId 派生的全局唯一值】,避免 Error 1236 server-id 冲突导致重启循环。 */
async function resolveMysqlCdcSource(sql: string, sourceDatasourceId: string | undefined, jobId: string): Promise<string> {
  if (!/\$\{SRC_/.test(sql) && !/'connector'\s*=\s*'mysql-cdc'/.test(sql)) return sql;
  // server-id 唯一化:把模板里写死的 'server-id' = '...' 换成按 jobId 派生的唯一范围(幂等:同作业每次相同)。
  let out = sql.replace(/('server-id'\s*=\s*')[^']*(')/g, `$1${deriveServerIdRange(jobId)}$2`);
  if (!/\$\{SRC_/.test(out)) return out;
  if (!sourceDatasourceId) throw new Error("MySQL CDC 源作业未选择源数据源(${SRC_*} 占位符无法注入)");
  const { Item: ds } = await docClient.send(new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: sourceDatasourceId } }));
  if (!ds) throw new Error("CDC 源数据源不存在: " + sourceDatasourceId);
  let user = ""; let password = "";
  if (ds.secretArn) {
    try {
      const sec = await getSecretJson(ds.secretArn);
      user = sec.username || sec.user || ""; password = sec.password || "";
    } catch (e: any) { throw new Error("读取 CDC 源密钥失败: " + String(e?.message || e)); }
  }
  // 端口以数据源为权威(MySQL binlog/CDC 与普通连接共用同一端口,无独立 CDC 端口);缺失回落 3306。
  const port = ds.port || 3306;
  return out
    .replace(/\$\{SRC_HOSTNAME\}/g, ds.host || "")
    .replace(/\$\{SRC_PORT\}/g, String(port))
    .replace(/\$\{SRC_USERNAME\}/g, user)
    .replace(/\$\{SRC_PASSWORD\}/g, password)
    .replace(/\$\{SRC_DATABASE\}/g, ds.database || "");
}

/** 作业是否为 MySQL CDC 源(SQL 用了 mysql-cdc connector)——决定是否需 VPC 接入读私有 RDS binlog。 */
function isMysqlCdcSource(sql: string): boolean {
  return /'connector'\s*=\s*'mysql-cdc'/.test(sql);
}

/** S3 Tables sink:把仓库 ARN / 命名空间占位符解析为具体值(账号/区域派生,不入库)。 */
// 🔴 B-26:落点必填(原来恒用主控区表桶,见 `tableBucketArn` 注释)。
export function resolveS3TableSink(sql: string, place: FlinkPlace): string {
  if (!/\$\{TABLE_BUCKET_ARN\}|\$\{S3TABLE_DB\}/.test(sql)) return sql;
  return sql
    .replace(/\$\{TABLE_BUCKET_ARN\}/g, tableBucketArn(place))
    .replace(/\$\{S3TABLE_DB\}/g, FLINK.s3tableDb);
}


/** 自定义 sink:连接定义全部由用户在 Flink SQL 里自管。仅当用户用占位符 ${SINK_HOST/USER/PASSWORD}
 *  且选了「凭证数据源」时,启动时从该数据源(+ Secrets Manager)注入 —— 让密钥不必写进 SQL/不入库(红线)。
 *  不绑定任何特定系统(OpenSearch 只是示例);也兼容历史的 ${OPENSEARCH_*} 占位符。 */
async function resolveCustomSink(sql: string, sinkDatasourceId?: string): Promise<string> {
  if (!sinkDatasourceId || !/\$\{(SINK|OPENSEARCH)_/.test(sql)) return sql;
  const { Item: ds } = await docClient.send(new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: sinkDatasourceId } }));
  if (!ds) throw new Error("自定义 sink 凭证数据源不存在: " + sinkDatasourceId);
  let user = ""; let password = "";
  if (ds.secretArn) {
    try {
      const sec = await getSecretJson(ds.secretArn);
      user = sec.username || sec.user || ""; password = sec.password || "";
    } catch (e: any) { throw new Error("读取自定义 sink 密钥失败: " + String(e?.message || e)); }
  }
  return sql
    .replace(/\$\{SINK_HOST\}/g, ds.host || "")
    .replace(/\$\{SINK_USER\}/g, user)
    .replace(/\$\{SINK_PASSWORD\}/g, password)
    // 兼容历史占位符
    .replace(/\$\{OPENSEARCH_HOSTS\}/g, ds.host || "")
    .replace(/\$\{OPENSEARCH_USER\}/g, user)
    .replace(/\$\{OPENSEARCH_PASSWORD\}/g, password);
}

/** MySQL sink:把 MSAF 应用挂进目标 RDS 所在 VPC —— 用 RDS 自身 SG(自引用可达)+ 私有子网(经 NAT 出网到 Kinesis/S3/CW)。 */
async function resolveSinkVpc(ctx: FlinkCtx, sinkDatasourceId?: string): Promise<{ SubnetIds: string[]; SecurityGroupIds: string[] } | undefined> {
  if (!sinkDatasourceId || ctx.subnetIds.length === 0) return undefined;
  const { Item: ds } = await docClient.send(new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: sinkDatasourceId } }));
  if (!ds || !ds.host) return undefined;
  try {
    // 🔴 RDS 实例要在**作业所在区**查:用主控区客户端查别区的实例,列表里根本没有那台 ⇒
    //    sgIds 为空 ⇒ 静默不接 VPC ⇒ 作业连不上私有 sink,而报错是「连接超时」。
    const rdsc = await rdsClientFor(ctx.region);
    const r = await rdsc.send(new DescribeDBInstancesCommand({}));
    const inst = (r.DBInstances || []).find((i: any) => i.Endpoint?.Address === ds.host);
    const sgIds = (inst?.VpcSecurityGroups || []).map((s: any) => s.VpcSecurityGroupId).filter(Boolean);
    if (sgIds.length === 0) return undefined;
    return { SubnetIds: ctx.subnetIds, SecurityGroupIds: sgIds };
  } catch { return undefined; }
}

/** 自定义 sink 的 VPC 接入:用户显式提供私有子网 + SG(自管网络可达性),平台原样透传给 MSAF。
 *  未提供则不接 VPC(公网/AWS 托管网络可达的 sink)。子网缺省回退到平台私有子网,省去用户找子网。 */
function resolveCustomVpc(ctx: FlinkCtx, v?: CustomVpc): { SubnetIds: string[]; SecurityGroupIds: string[] } | undefined {
  const sgs = (v?.securityGroupIds || []).map((s) => s.trim()).filter(Boolean);
  if (sgs.length === 0) return undefined; // 无 SG 即视为不接 VPC(MSAF VPC 接入必须有 SG)
  const subnets = (v?.subnetIds || []).map((s) => s.trim()).filter(Boolean);
  // 🔴 回退到**该落点**的私有子网,不是主控区的:把别区的子网 id 写进 VpcConfigurations,提交才炸。
  const SubnetIds = subnets.length ? subnets : ctx.subnetIds;
  if (SubnetIds.length === 0) {
    throw new Error(
      `VPC 接入需至少一个私有子网:未提供,且 ${ctx.targetId}(${ctx.region})` +
        ` 的描述符资源袋里没有 emrSubnetIds`
    );
  }
  return { SubnetIds, SecurityGroupIds: sgs };
}

async function describe(ctx: FlinkCtx, name: string) {
  try {
    const r = await ctx.kda.send(new DescribeApplicationCommand({ ApplicationName: name }));
    return r.ApplicationDetail || null;
  } catch (e: any) {
    if (e?.name === "ResourceNotFoundException") return null;
    throw e;
  }
}

/** 作业资源配置(用户可配,配置驱动)。parallelism=总并行度;parallelismPerKPU=每 KPU 并行度
 *  (MSAF 据此换算 KPU 数:KPU≈ceil(parallelism/parallelismPerKPU),另含 1 个协调 KPU);autoScaling 自动扩缩。
 *  其余字段对齐 MSAF console 配置页(参数齐全暴露):checkpoint 开关/间隔/最小暂停、日志级别、
 *  指标级别、快照开关、自定义运行时属性组(PropertyGroups;"bgp" 组为平台保留注入 SQL)。 */
export interface FlinkResources {
  parallelism?: number;
  parallelismPerKPU?: number;
  autoScalingEnabled?: boolean;
  checkpointingEnabled?: boolean; // 默认 true
  checkpointIntervalMs?: number; // 默认 30000
  minPauseBetweenCheckpointsMs?: number; // 默认 5000
  logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR"; // 默认 INFO
  metricsLevel?: "APPLICATION" | "TASK" | "OPERATOR" | "PARALLELISM"; // 默认 APPLICATION
  snapshotsEnabled?: boolean; // 默认 true(有状态作业:stop 自动打 savepoint,start 从快照恢复→checkpointId 连续,根治 S3Tables 首帧 412;高级用户可显式关)
  runtimeProperties?: Array<{ groupId: string; properties: Record<string, string> }>;
}
const RES_DEFAULTS = { parallelism: 1, parallelismPerKPU: 1, autoScalingEnabled: false };
const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"];
const METRICS_LEVELS = ["APPLICATION", "TASK", "OPERATOR", "PARALLELISM"];
/** 规整资源配置(防越界):parallelism 1..64、parallelismPerKPU 1..8;checkpoint 间隔 1s..1h、暂停 0..间隔。 */
function normalizeResources(r?: FlinkResources) {
  const clamp = (v: any, lo: number, hi: number, dft: number) => {
    const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dft;
  };
  const interval = clamp(r?.checkpointIntervalMs, 1000, 3600000, 30000);
  return {
    parallelism: clamp(r?.parallelism, 1, 64, RES_DEFAULTS.parallelism),
    parallelismPerKPU: clamp(r?.parallelismPerKPU, 1, 8, RES_DEFAULTS.parallelismPerKPU),
    autoScalingEnabled: r?.autoScalingEnabled === true,
    checkpointingEnabled: r?.checkpointingEnabled !== false,
    checkpointIntervalMs: interval,
    minPauseBetweenCheckpointsMs: Math.min(clamp(r?.minPauseBetweenCheckpointsMs, 0, 3600000, 5000), interval),
    logLevel: LOG_LEVELS.includes(String(r?.logLevel)) ? (r!.logLevel as string) : "INFO",
    metricsLevel: METRICS_LEVELS.includes(String(r?.metricsLevel)) ? (r!.metricsLevel as string) : "APPLICATION",
    // 默认开(!== false):有状态流作业停止自动打快照、启动从快照恢复,checkpointId 单调连续,
    // 根治「SKIP_RESTORE 重启 checkpointId 归 1 撞残留 manifest → S3Tables write-once 412」;
    // 显式传 false(高级用户主动关)才禁用。通用语义,非某 sink 特化。
    snapshotsEnabled: r?.snapshotsEnabled !== false,
    runtimeProperties: (r?.runtimeProperties || []).filter((g) => g && g.groupId && g.groupId !== "bgp" && /^[A-Za-z0-9_.-]{1,50}$/.test(g.groupId)),
  };
}

// ── MSAF PropertyMap 硬约束(AWS API 明文,见 PropertyGroup 文档)────────────────
//   · 单个 value ≤ 2048 字节;单个 key ≤ 2048 字节;每组 ≤ 50 个 key-value 对;PropertyGroupId 匹配 [a-zA-Z0-9_.-]{1,50}。
//   注入凭证后的 Flink SQL 轻易超过 2048(实测 CDC 模板 2007→注入后 2052)→ UpdateApplication 抛
//   ValidationException(且被旧 catch{} 静默吞 → 拿空/旧 SQL 启动,产静默错误结果)。
//   根治:① 先规范化(去缩进/空行/注释,不碰字面量)大幅缩短;② 仍超则【按字节安全分片】,
//   跨多个 bgp 前缀组滚动存放 —— 【绝不因 SQL 过长而失败】(用户红线:不能有 2048 上限)。
const PV_MAX = 2048;               // MSAF 单 value 字节上限
const SHARD_BYTES = 1800;          // 每片目标字节(留足余量,含 key 名开销与 UTF-8 边界回退)
const KEYS_PER_GROUP = 48;         // 每组键数(≤50,留 2 个余量给未来元信息)

/** 规范化 Flink SQL:逐行去首尾空白、删空行与整行注释(-- / #),但【不触碰字符串/反引号字面量内部】。
 *  仅按行处理且只 lstrip/rstrip 行首尾空白 —— SQL 语义不依赖行缩进,字面量内部不含前导缩进,故安全。
 *  纯函数、幂等。目的:从源头缩短注入体积(CDC 模板累进缩进使体积翻倍)。 */
export function normalizeFlinkSql(sql: string): string {
  const out: string[] = [];
  for (const line of String(sql || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;                       // 空行
    if (t.startsWith("--") || t.startsWith("#")) continue; // 整行注释(行内 -- 不动,避免误伤字面量)
    out.push(t);
  }
  return out.join("\n");
}

/** 把字符串按 UTF-8 字节安全切成每片 ≤ maxBytes 的数组(绝不切在多字节字符中间)。 */
function chunkByBytes(s: string, maxBytes: number): string[] {
  const enc = new TextEncoder();
  const chunks: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of s) { // for..of 按 Unicode 码点迭代,不会拆开代理对
    const b = enc.encode(ch).length;
    if (curBytes + b > maxBytes && cur) { chunks.push(cur); cur = ""; curBytes = 0; }
    cur += ch;
    curBytes += b;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** 把注入后的 SQL 编码进【平台保留组】:短则单值 { sql }(向后兼容);长则分片
 *  { "sql.0", "sql.1", ... } 并在片数超过单组容量时滚动到 bgp1/bgp2/... 组。
 *  runner 侧按 bgp* 组 + key 序号无损拼回(见 FlinkSqlRunner.assembleSql)。
 *  【无人为长度上限】—— 组数按需增长(50 组 × 48 片 × 1800B ≈ 4MB,远超任何现实 SQL)。 */
export function buildSqlGroups(finalSql: string): Array<{ PropertyGroupId: string; PropertyMap: Record<string, string> }> {
  // 短 SQL(规范化后单值即 <2048)→ 老格式,零行为变化,兼容旧 runner。
  if (new TextEncoder().encode(finalSql).length < PV_MAX) {
    return [{ PropertyGroupId: "bgp", PropertyMap: { sql: finalSql } }];
  }
  const shards = chunkByBytes(finalSql, SHARD_BYTES);
  const groups: Array<{ PropertyGroupId: string; PropertyMap: Record<string, string> }> = [];
  for (let i = 0; i < shards.length; i++) {
    const groupIdx = Math.floor(i / KEYS_PER_GROUP);
    const gid = groupIdx === 0 ? "bgp" : `bgp${groupIdx}`;
    if (!groups.length || groups[groups.length - 1].PropertyGroupId !== gid) {
      groups.push({ PropertyGroupId: gid, PropertyMap: {} });
    }
    groups[groups.length - 1].PropertyMap[`sql.${i}`] = shards[i];
  }
  return groups;
}

/** 从 MSAF 已存的 PropertyGroupDescriptions 还原平台注入的 SQL(与 runner 侧拼接逻辑对齐):
 *  收集所有 bgp* 组里的 sql / sql.N 值,按 N 升序拼回(sql 视作 sql.-1 排最前,兼容老单值)。
 *  仅平台自检用(判断"MSAF 现有 SQL 是否 = 目标 SQL",避免拿旧定义静默启动)。 */
export function reassembleSqlFromGroups(pgs?: Array<{ PropertyGroupId?: string; PropertyMap?: Record<string, string> }>): string | undefined {
  const parts: Array<{ n: number; v: string }> = [];
  let sawAny = false;
  for (const g of pgs || []) {
    const gid = String(g.PropertyGroupId || "");
    if (gid !== "bgp" && !/^bgp\d+$/.test(gid)) continue;
    for (const [k, v] of Object.entries(g.PropertyMap || {})) {
      if (k === "sql") { parts.push({ n: -1, v }); sawAny = true; }
      else { const m = /^sql\.(\d+)$/.exec(k); if (m) { parts.push({ n: Number(m[1]), v }); sawAny = true; } }
    }
  }
  if (!sawAny) return undefined;
  parts.sort((a, b) => a.n - b.n);
  return parts.map((p) => p.v).join("");
}

/** 组装 PropertyGroups:平台保留组 bgp*(注入 SQL,规范化+按需分片)+ 用户自定义组。 */
function buildPropertyGroups(finalSql: string, res: ReturnType<typeof normalizeResources>) {
  return [
    ...buildSqlGroups(normalizeFlinkSql(finalSql)),
    ...res.runtimeProperties.map((g) => ({
      PropertyGroupId: g.groupId,
      PropertyMap: Object.fromEntries(Object.entries(g.properties || {}).filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), String(v ?? "")])),
    })).filter((g) => Object.keys(g.PropertyMap).length > 0),
  ];
}
/** 由资源配置估算 KPU 数(展示用,与 MSAF 计费口径一致:运行 KPU + 1 协调 KPU)。 */
export function estimateKpu(r?: FlinkResources): number {
  const n = normalizeResources(r);
  return Math.ceil(n.parallelism / n.parallelismPerKPU) + 1;
}

/** 快照可恢复性探测结果(**四态,不可用 boolean 表达**):
 *   "available" —— 确认存在 READY 快照且在有效期内,可恢复;
 *   "none"      —— 确认查过、确实没有(首启/空表,冷启动是正确选择);
 *   "stale"     —— 有 READY 快照,但**已超出源端 binlog 保留窗口** → 恢复必崩且不自愈,须主动冷启动;
 *   "unknown"   —— 探测本身失败(无权限/限流/网络),**不等于没有**。
 *
 * 🔴 为什么必须多态而非 boolean:失败模式有四种语义,布尔只能表达两种。两次真机事故都源于此:
 *   ① 把 "unknown" 压成 false → S3Tables 首帧 412(`catch {}` 吞掉 ListApplicationSnapshots 的
 *      AccessDenied → 误判无快照 → 恒 SKIP_RESTORE → checkpointId 归 1 → manifest 撞名 → 412);
 *   ② 把 "stale" 当 "available" → CDC 从过期位点恢复 → binlog no longer available → 崩溃循环。
 * 见 DESIGN-flink-s3tables-412-rootfix.md §3.1 L2 / §4.1 / §9。 */
export type SnapshotProbe = "available" | "none" | "stale" | "unknown";

/** 探测结果 + 判定依据(stale 时带上"快照时刻 / 源端最老 binlog 时刻",供页面展示技术详情)。
 *  用返回值携带上下文,**不用模块级可变量** —— 后者在并发启动多个作业时会互相串。 */
interface ProbeResult {
  probe: SnapshotProbe;
  snapshotAt?: string;
  oldestBinlogAt?: string;
}

/** 判定快照位点是否已不可达(纯函数,可测)。
 *
 * 🔴 为什么**不能用"快照年龄 < binlog 保留窗口"来推断**(2026-07-25 实测踩过):
 *   那次快照只有 2.5h(远小于 72h 窗口)却仍崩 —— 因为它记的位点 `000082` 是在
 *   `binlog retention hours=None`(RDS 默认:备份完即清)时期产生的,那批 binlog 早被删净;
 *   把保留窗口设成 72h **只对此后新产生的 binlog 生效,救不回已删的**。
 *   实测现存 binlog 仅 000108~000112,快照要的 000082 差了 26 个文件。
 *   ⇒ 教训:**别用间接指标(年龄)猜外部状态,直接问源端事实(现存最老 binlog 的时间)**。
 *
 * 判据:快照创建时刻 **早于** 源端现存最老 binlog 的修改时刻 → 其位点必已被清 → 不可恢复。
 * @param snapshotAt      最新 READY 快照的创建时刻
 * @param oldestBinlogAt  源端现存最老 binlog 文件的时间(查不到则传 undefined)
 */
export function isSnapshotUnrecoverable(snapshotAt?: Date, oldestBinlogAt?: Date): boolean {
  if (!snapshotAt || !oldestBinlogAt) return false; // 任一未知 → 不主动否定恢复(交由 unknown 语义)
  return snapshotAt.getTime() < oldestBinlogAt.getTime();
}

/** 🔴 需要【用户显式决策】才能继续的启动前置条件(不是普通错误)。
 *
 * 为什么单列一个错误类型:有些启动障碍平台**无权自动消解**——消解方式会改变数据语义。
 * 典型:CDC 快照位点已被源端清理,唯一出路是"丢弃进度、从头全量重读",而这会重算历史、
 * 可能向下游重复写入。能否接受取决于业务(sink 是否幂等、报表能否容忍回溯),
 * **平台代劳就是替用户承担业务风险**。故中止启动并把决策交还用户(用户确认后带 confirm 重试)。
 *
 * 对齐 [[network-advisor-readonly-only]](顾问只给建议+教步骤,不擅自改)与用户红线:
 * 「重大决策必须人为确认」。
 */
/** 启动可选项。用对象承载新语义,既有 9 个位置参数的调用点零改动(向后兼容)。 */
export interface StartOptions {
  /** 用户已在页面上**显式确认**"丢弃已保存进度、从头完整重读"。
   *  🔴 缺省 false —— 平台绝不代替用户做这个决策(会重算历史/可能重复写入)。 */
  discardStateConfirmed?: boolean;
  /**
   * @kf-batch 50-WP4quater-reads(工单 SC-5)
   * 这次启动的**执行落点**。🔴 由路由从**作业行上的章**取(`flinkJobTarget(job)`),
   * 不接受前端裸传 —— 让前端决定「在哪个区起这个作业」等于让它绕过绑定,
   * 而绑定是数据驻留承诺的那一环。@kf-batch 50-WP31-place-first-class:**必填**(原来缺省 = 主控区)。
   */
  targetId: string;
}

export class FlinkDecisionRequired extends Error {
  /** 故障/前置条件稳定码(与 failure-advisor 的 code 同一命名空间,供前端取诊断文案)。 */
  readonly code: string;
  /** 用户确认后需回传的令牌(前端把它放进 confirm 字段重试启动)。 */
  readonly confirmToken: string;
  /** 结构化上下文(展示"技术详情":快照时刻/源端最老 binlog 时刻等)。 */
  readonly context: Record<string, string | undefined>;
  constructor(code: string, message: string, confirmToken: string, context: Record<string, string | undefined> = {}) {
    super(message);
    this.name = "FlinkDecisionRequired";
    this.code = code;
    this.confirmToken = confirmToken;
    this.context = context;
  }
}

/** 启动恢复类型决策(纯函数,零 AWS 依赖,可测):
 *   snapshotsOn=false            → 恒 SKIP(高级用户显式关快照,尊重其选择)。
 *   probe="none"                 → SKIP(确认无快照:首启/空表,无残留可撞)。
 *   probe="stale"                → SKIP(**仅在用户已确认"丢弃进度"后**才走到这里;见 FlinkDecisionRequired)。
 *   probe="available"/"unknown"  → RESTORE_FROM_LATEST。
 *
 * unknown 也选 RESTORE 的依据:RESTORE_FROM_LATEST_SNAPSHOT 在无快照时**不报错、自动全新启动**
 * (已真机坐实),故它是严格更安全的默认——有快照则续编 checkpointId(不撞名 → 无 412),
 * 无快照则自然退化成冷启动。反之把 unknown 当 none 会主动放弃恢复 → 必然重现 412。
 * 见 DESIGN-flink-s3tables-412-rootfix.md §3.1 L2 / §9。 */
export function pickRestoreType(snapshotsOn: boolean, probe: SnapshotProbe):
  "RESTORE_FROM_LATEST_SNAPSHOT" | "SKIP_RESTORE_FROM_SNAPSHOT" {
  if (!snapshotsOn) return "SKIP_RESTORE_FROM_SNAPSHOT";
  if (probe === "none" || probe === "stale") return "SKIP_RESTORE_FROM_SNAPSHOT";
  return "RESTORE_FROM_LATEST_SNAPSHOT";
}

/** 叠加【用户显式决策】的最终恢复类型(纯函数,可测)。
 *  pickRestoreType 只据"探测到的客观事实"决策;本函数在其上叠加用户在页面上的显式确认:
 *
 *  🔴 discardStateConfirmed=true(用户已在启动决策框 / 详情页崩溃诊断里确认"丢弃进度、从头重读")
 *     → **无条件 SKIP_RESTORE**,凌驾于探测结果。
 *     为什么必须凌驾:CDC 位点过期在真机几乎总表现为【运行中崩溃循环】,而非启动预检可拦截的 stale
 *     —— stale 判据依赖源端"现存最老 binlog 首事件时间戳",部分 RDS/MySQL 版本 `SHOW BINLOG EVENTS`
 *     不返回 Timestamp(§9 实测 + oldestBinlogTime 注释),此时 probe 退化为 available/unknown。
 *     若不凌驾,用户点了详情页"放弃旧位点重启"、仍会走 RESTORE → 又从过期快照恢复 → 继续崩,
 *     自愈环断裂、按钮形同虚设。既然用户已拍板丢弃(知情:会重算历史/可能重复写入),平台必须执行冷启动。
 *  discardStateConfirmed=false/缺省 → 完全交由 pickRestoreType 据探测事实决策(既有行为逐字节不变)。 */
export function resolveRestoreType(snapshotsOn: boolean, probe: SnapshotProbe, discardStateConfirmed?: boolean):
  "RESTORE_FROM_LATEST_SNAPSHOT" | "SKIP_RESTORE_FROM_SNAPSHOT" {
  if (discardStateConfirmed) return "SKIP_RESTORE_FROM_SNAPSHOT";
  return pickRestoreType(snapshotsOn, probe);
}

/** 查源 MySQL 现存**最老** binlog 的时间(排障级只读查询;查不到返回 undefined)。
 *  复用模块 42 已在依赖里的 mysql2(与 datasource-spi/jdbc/mysql.ts 同一客户端),不新增依赖。
 *  `SHOW BINARY LOGS` 只返文件名/大小,故用 INFORMATION_SCHEMA 拿不到时间 —— 改用两段式:
 *  文件名序号单调递增,取最老文件名,再用 `SHOW BINLOG EVENTS` 读其首事件时间戳。 */
async function oldestBinlogTime(sourceDatasourceId?: string): Promise<Date | undefined> {
  if (!sourceDatasourceId) return undefined;
  let c: any = null;
  try {
    const { Item: ds } = await docClient.send(new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: sourceDatasourceId } }));
    if (!ds?.host || !ds.secretArn) return undefined;
    const sec = await getSecretJson(ds.secretArn);
    const mysql = (await import("mysql2/promise")).default;
    c = await mysql.createConnection({
      host: ds.host, port: ds.port || 3306,
      user: sec.username || sec.user, password: sec.password,
      connectTimeout: 8000,
    });
    const [logs] = await c.query("SHOW BINARY LOGS");
    const names = (logs as any[]).map((r) => r.Log_name).filter(Boolean).sort();
    if (names.length === 0) return undefined;
    // 最老 binlog 的首个事件时间 = 该文件起始时刻;快照早于它 ⇒ 其位点必已被清。
    // 🔴 `SHOW BINLOG EVENTS IN ?` **不支持参数绑定**(MySQL 语法在此处只接字面量)——实测
    //    用占位符会抛错、此前被 `.catch(()=>[[]])` 静默吞掉,导致恒返 undefined、判据永不生效
    //    (我自己又犯了一次"静默吞错"。故此处不 catch,异常一律冒泡到外层告警)。
    //    文件名来自 MySQL 自身返回(非用户输入),用单引号转义后内联。
    const oldest = String(names[0]).replace(/'/g, "''");
    const [evs] = await c.query(`SHOW BINLOG EVENTS IN '${oldest}' LIMIT 1`);
    const ts = (evs as any[])?.[0]?.Timestamp;
    if (ts) return new Date(typeof ts === "number" ? ts * 1000 : ts);
    // 拿不到首事件时间戳(部分版本 SHOW BINLOG EVENTS 不返 Timestamp)→ 退化为"未知",
    // 不猜(交由 unknown 语义走 RESTORE),但留痕以便发现该环境需换判据。
    console.warn("[flink] 源端最老 binlog 首事件无时间戳,位点可达性判据退化为未知", { oldest: names[0] });
    return undefined;
  } catch (e: any) {
    console.warn("[flink] 查源端最老 binlog 失败(不阻断启动,按未知处理)", { err: String(e?.message || e).slice(0, 160) });
    return undefined;
  } finally {
    try { await c?.end(); } catch { /* ignore */ }
  }
}

/** 探测应用快照的可恢复性(唯一出口)。
 *  🔴 失败**绝不静默**:留痕后返回 "unknown"(而非伪装成 "none")——412 正因这里曾是 `catch {}`。
 *  🔴 不可恢复**主动识别**:CDC 快照早于源端现存最老 binlog → "stale",主动冷启动,
 *     而不是崩一次才知道(实测那次崩溃循环 fullRestarts 一路涨到 16 且不自愈)。 */
async function probeSnapshots(ctx: FlinkCtx, name: string, cdcSource: boolean, sourceDatasourceId?: string): Promise<ProbeResult> {
  let ready: Array<{ SnapshotCreationTimestamp?: Date }> = [];
  try {
    // Limit 放宽到 50:只取 1 条可能恰好命中非 READY(CREATING/DELETING)快照而误判为无。
    const ls = await ctx.kda.send(new ListApplicationSnapshotsCommand({ ApplicationName: name, Limit: 50 }));
    ready = (ls.SnapshotSummaries || []).filter((s) => s.SnapshotStatus === "READY");
  } catch (e: any) {
    console.error("[flink] 快照探测失败,按 unknown 处理(不退化为 none;缺 kinesisanalytics:ListApplicationSnapshots 会致首帧 412)",
      { app: name, err: String(e?.name || e), msg: String(e?.message || "").slice(0, 200) });
    return { probe: "unknown" };
  }
  if (ready.length === 0) return { probe: "none" };
  // 仅 CDC 源作业受 binlog 可达性约束(Kinesis/其他源无此语义,快照多老都能恢复)。
  if (!cdcSource) return { probe: "available" };
  const newest = ready
    .map((s) => s.SnapshotCreationTimestamp)
    .filter((d): d is Date => !!d)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const oldestBinlog = await oldestBinlogTime(sourceDatasourceId);
  if (isSnapshotUnrecoverable(newest, oldestBinlog)) {
    console.warn("[flink] 最新快照早于源端现存最老 binlog → 位点已被清,判定 stale(中止启动,交用户决策)",
      { app: name, snapshotAt: newest?.toISOString(), oldestBinlogAt: oldestBinlog?.toISOString() });
    return { probe: "stale", snapshotAt: newest?.toISOString(), oldestBinlogAt: oldestBinlog?.toISOString() };
  }
  return { probe: "available" };
}

/** 幂等确保 MSAF 应用存在(从 S3 JAR + 注入 SQL 创建)。
 *  已存在且处于非运行态(READY 等)→ 用最新 SQL/代码/VPC/资源【更新】应用,确保编辑后重启生效
 *  (此前 stop 会删应用,restart 必重建;现 stop 保留应用,故须显式 Update,否则跑旧 SQL)。
 *  已存在且运行中 → 原样返回(运行中不改;PUT 编辑路由已要求先停止)。 */
async function ensureApplication(ctx: FlinkCtx, jobId: string, finalSql: string, runner: FlinkRunner, vpcConfig?: { SubnetIds: string[]; SecurityGroupIds: string[] }, resources?: FlinkResources, executionRoleArn?: string): Promise<string> {
  const name = appName(jobId);
  let existing = await describe(ctx, name);
  if (existing) {
    let st = String(existing.ApplicationStatus || "READY");
    // 🔴 必须【先等过渡态收敛,再判断是否运行中】—— 顺序反了会导致"编辑 SQL 后重启不生效"。
    //    实测事故(2026-07-26,排查耗时极长):`RUNNING_LIKE` 含 "STARTING",而点启动后应用会短暂
    //    停留在 STARTING;若此时再次触发启动,第一行判断即命中 → `return st` 提前返回 →
    //    **UpdateApplication 一次都没发出**(ApplicationVersionId 恒为 1 是唯一可见线索)→
    //    平台拿【旧 SQL】启动,页面却显示启动成功。用户改了 SQL 却跑旧逻辑,产出静默错误结果。
    //    另:MSAF 在过渡态也确实拒绝 Update(ResourceInUseException: cannot be updated in 'STARTING' state),
    //    所以既要等,也不能把"正在启动"误判成"已在运行"。
    const TRANSIENT = ["STARTING", "STOPPING", "UPDATING", "AUTOSCALING", "FORCE_STOPPING", "ROLLING_BACK", "MAINTENANCE"];
    if (TRANSIENT.includes(st)) {
      // 原 36 × 5s 的本地循环改经 awaitTerminal(预算逐字保留;到顶就带着最后看到的状态往下走,与原循环同)
      try {
        existing = await awaitTerminal<Awaited<ReturnType<typeof describe>>>({
          what: `MSAF 应用 ${name} 离开过渡态`,
          maxPolls: 36,
          initialMs: 5000,
          backoff: 1,
          probe: async () => {
            const cur = await describe(ctx, name);
            if (!cur) return { done: true, value: cur };
            const s = String(cur.ApplicationStatus || "READY");
            return TRANSIENT.includes(s) ? { done: false, state: s } : { done: true, value: cur };
          },
        });
      } catch (e) {
        if (!(e instanceof LongOpWaitBudgetExceeded)) throw e;
        existing = await describe(ctx, name);
      }
      if (!existing) return "READY";
      st = String(existing.ApplicationStatus || "READY");
    }
    if (st === "RUNNING") return st; // 真正在跑:不改(PUT 编辑路由已要求先停止)
    // 非运行态:把最新定义更新进应用(SQL/代码/VPC/资源)。
    const res = normalizeResources(resources);
    try {
      await ctx.kda.send(new UpdateApplicationCommand({
        ApplicationName: name,
        CurrentApplicationVersionId: existing.ApplicationVersionId!,
        ApplicationConfigurationUpdate: {
          ...(vpcConfig ? { VpcConfigurationUpdates: [{ VpcConfigurationId: existing.ApplicationConfigurationDescription?.VpcConfigurationDescriptions?.[0]?.VpcConfigurationId, SubnetIdUpdates: vpcConfig.SubnetIds, SecurityGroupIdUpdates: vpcConfig.SecurityGroupIds }] } : {}),
          ApplicationCodeConfigurationUpdate: {
            CodeContentUpdate: { S3ContentLocationUpdate: { BucketARNUpdate: `arn:aws:s3:::${ctx.codeBucket}`, FileKeyUpdate: runner.codeKey } },
            CodeContentTypeUpdate: "ZIPFILE",
          },
          EnvironmentPropertyUpdates: { PropertyGroups: buildPropertyGroups(finalSql, res) },
          FlinkApplicationConfigurationUpdate: {
            ParallelismConfigurationUpdate: { ConfigurationTypeUpdate: "CUSTOM", ParallelismUpdate: res.parallelism, ParallelismPerKPUUpdate: res.parallelismPerKPU, AutoScalingEnabledUpdate: res.autoScalingEnabled },
            CheckpointConfigurationUpdate: { ConfigurationTypeUpdate: "CUSTOM", CheckpointingEnabledUpdate: res.checkpointingEnabled, CheckpointIntervalUpdate: res.checkpointIntervalMs, MinPauseBetweenCheckpointsUpdate: res.minPauseBetweenCheckpointsMs },
            MonitoringConfigurationUpdate: { ConfigurationTypeUpdate: "CUSTOM", LogLevelUpdate: res.logLevel as any, MetricsLevelUpdate: res.metricsLevel as any },
          },
          ApplicationSnapshotConfigurationUpdate: { SnapshotsEnabledUpdate: res.snapshotsEnabled },
        },
      }));
    } catch (e: any) {
      // 🔴 绝不静默:更新失败意味着【将用旧定义启动】(旧 SQL/旧代码/旧网络),这是用户看不见的错配。
      //    412 根因正是同一个反模式(catch{} 把"我没查到"伪装成"确实没有")。此处至少留痕告警,
      //    并对"SQL 确实变了"这种语义性错配直接拒绝启动 —— 跑旧 SQL 比启动失败更糟(静默错误结果)。
      const err = String(e?.name || e);
      console.error("[flink] 应用定义更新失败", { app: name, status: st, err, message: String(e?.message || "").slice(0, 500) });
      const cur = await describe(ctx, name);
      // 还原 MSAF 现存 SQL(跨 bgp* 分片组拼回),与本次【规范化后】的目标 SQL 比较 —— 口径必须一致,
      // 否则分片/规范化会让比较恒不等而误报。不一致 = MSAF 仍是旧/空定义 → 拒绝拿旧定义启动。
      const curSql = reassembleSqlFromGroups(
        cur?.ApplicationConfigurationDescription?.EnvironmentPropertyDescriptions?.PropertyGroupDescriptions);
      const wantSql = normalizeFlinkSql(finalSql);
      if (curSql !== wantSql) {
        throw new Error(
          `作业定义更新失败(${err}:${String(e?.message || "").slice(0, 160)}),平台已中止启动 —— ` +
          `若继续启动会运行【旧版 SQL】产出错误结果。请等作业完全停止(状态为「已停止」)后重试启动。`,
        );
      }
    }
    const after = await describe(ctx, name);
    return String(after?.ApplicationStatus || "READY");
  }

  const res = normalizeResources(resources);
  const logStreamArn = await ensureLogGroup(ctx, jobId);
  // 执行角色:作业自定义 executionRoleArn 优先,留空回退该落点的平台 Flink 运行角色。
  // 序 72 B-139:单一作者 resolveExecutionRoleArn;自定义角色在 CreateApplication **之前**按本落点预检(信任
  //   kinesisanalytics.amazonaws.com + 引擎基线),缺 ⇒ 抛 ExecRolePreflightError,不建应用。
  const resolvedRole = resolveExecutionRoleArn({
    custom: executionRoleArn,
    fallback: ctx.roleArn,
    missingMessage: `目标 ${ctx.targetId} 没有 Flink 运行角色(描述符缺 flink 服务角色)`,
  });
  if (resolvedRole.isCustom) {
    const pf = await preflightExecutionRole({ engine: "flink", roleArn: resolvedRole.roleArn, targetId: ctx.targetId });
    assertPreflightPassed(pf, { engine: "flink", roleArn: resolvedRole.roleArn, targetId: ctx.targetId, what: `flink-job ${jobId}` });
  }
  const svcRole = resolvedRole.roleArn;
  await ctx.kda.send(new CreateApplicationCommand({
    ApplicationName: name,
    RuntimeEnvironment: runner.runtimeEnvironment as RuntimeEnvironment,
    ServiceExecutionRole: svcRole,
    ApplicationConfiguration: {
      ...(vpcConfig ? { VpcConfigurations: [vpcConfig] } : {}),
      ApplicationCodeConfiguration: {
        CodeContent: { S3ContentLocation: { BucketARN: `arn:aws:s3:::${ctx.codeBucket}`, FileKey: runner.codeKey } },
        CodeContentType: "ZIPFILE", // JAR 上传统一用 ZIPFILE
      },
      EnvironmentProperties: {
        PropertyGroups: buildPropertyGroups(finalSql, res),
      },
      FlinkApplicationConfiguration: {
        // 全部由用户配置驱动(并行度/checkpoint/监控),不写死;normalizeResources 兜默认值。
        ParallelismConfiguration: { ConfigurationType: "CUSTOM", Parallelism: res.parallelism, ParallelismPerKPU: res.parallelismPerKPU, AutoScalingEnabled: res.autoScalingEnabled },
        CheckpointConfiguration: { ConfigurationType: "CUSTOM", CheckpointingEnabled: res.checkpointingEnabled, CheckpointInterval: res.checkpointIntervalMs, MinPauseBetweenCheckpoints: res.minPauseBetweenCheckpointsMs },
        MonitoringConfiguration: { ConfigurationType: "CUSTOM", LogLevel: res.logLevel as any, MetricsLevel: res.metricsLevel as any },
      },
      ApplicationSnapshotConfiguration: { SnapshotsEnabled: res.snapshotsEnabled },
    },
    CloudWatchLoggingOptions: [{ LogStreamARN: logStreamArn }],
  }));
  return "READY";
}

/** 用户为自定义 sink 自管的 VPC 接入(私有子网 + SG;网络可达性由用户自理,平台只透传给 MSAF)。 */
export interface CustomVpc { subnetIds?: string[]; securityGroupIds?: string[]; }

// ─────────────────────────────────────────────────────────────────────────────
// 计算血缘(2026-07-08)— Flink 流作业 source→sink 表级血缘。
//
// Flink SQL 以 `CREATE TABLE <t> (...) WITH ('connector'='...')` 定义逻辑 source/sink 表,再
// `INSERT INTO <sink> SELECT ... FROM <source>` 建立数据流。此前 Flink 完全零血缘 → 实时产出表
// 在治理血缘图上是孤儿。这里从【已解析注入的 finalSql】提取 sink←source 边,映射为平台 FQN:
//   · s3table sink (INSERT INTO s3t.`db`.`tbl`)         → s3.<db>.<tbl>      (与 S3 同步侧一致)
//   · 逻辑表(orders_src/region_agg_sink 等)           → flink.<jobId 短>.<表>(至少产出有上游节点)
// best-effort、纯函数、不抛。物理端点(Kinesis 流 / CDC 源 RDS)富化留待日后。
// ─────────────────────────────────────────────────────────────────────────────
export function parseFlinkSqlLineage(finalSql: string, jobId: string): { inputs: string[]; outputs: string[] } {
  const inputs = new Set<string>();
  const outputs = new Set<string>();
  try {
    const sql = (finalSql || "").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n\r]*/g, " ");
    const short = jobId.slice(-8).toLowerCase();
    // 逻辑表名 → FQN:catalog 化的 s3t.`db`.`tbl` 归 s3;其余逻辑表归 flink.<jobId>.
    const toFqn = (raw: string): string | null => {
      const clean = raw.replace(/`/g, "").trim().toLowerCase();
      if (!clean) return null;
      const parts = clean.split(".").filter(Boolean);
      // s3t/iceberg catalog 的 sink:cat.db.tbl → s3.<db>.<tbl>
      if (parts.length >= 3 && /^(s3t|s3tablescatalog|iceberg)$/.test(parts[0])) {
        return `s3.${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
      }
      // 逻辑单段表名 → flink.<jobId 短>.<表>(命名空间隔离,避免不同作业同名表混淆)
      const tbl = parts[parts.length - 1];
      return `flink.${short}.${tbl}`;
    };
    // INSERT INTO <sink> [SELECT ... FROM <src> [JOIN <src2> ...]]
    const insRe = /insert\s+into\s+([`\w.]+)([\s\S]*?)(?=insert\s+into|$)/gi;
    let m: RegExpExecArray | null;
    while ((m = insRe.exec(sql))) {
      const sinkFqn = toFqn(m[1]);
      if (sinkFqn) outputs.add(sinkFqn);
      const tail = m[2] || "";
      const fromRe = /\b(?:from|join)\s+([`\w.]+)/gi;
      let fm: RegExpExecArray | null;
      while ((fm = fromRe.exec(tail))) {
        const srcFqn = toFqn(fm[1]);
        if (srcFqn && srcFqn !== sinkFqn) inputs.add(srcFqn);
      }
    }
    // 输出表不应同时作为输入(自引用)
    Array.from(outputs).forEach((o) => inputs.delete(o));
  } catch { /* best-effort */ }
  return { inputs: Array.from(inputs), outputs: Array.from(outputs) };
}

/** 启动作业:按 sinkType 选 runner(运行时版本+代码 JAR)→ ensure 应用(注入解析后的 SQL)→ StartApplication(不从快照恢复)。 */
export async function startFlinkJob(jobId: string, sql: string, sinkType: string | undefined, sinkDatasourceId: string | undefined, connectorIds: string[] | undefined, customVpc: CustomVpc | undefined, resources: FlinkResources | undefined, sourceDatasourceId: string | undefined, executionRoleArn: string | undefined, opts: StartOptions): Promise<{ appName: string }> {
  const name = appName(jobId);
  // 模块45(运行时安全网):启动前过 Flink 方言校验(对存库占位符原文,与 ai-sql 生成后 guard 同源规则)。
  //  · 可纠正的方言违规自动纠正后再跑;error 级无法自动修(如缺/多 INSERT INTO、窗口缺 GROUP BY window_start,window_end)
  //    → 拒绝启动并明确报错(经 start 路由 catch 写 status=error),不硬提交注定启动失败的作业。guard 纯 CPU 幂等。
  const gd = guard("flink", sql);
  if (gd.blocked) {
    const detail = gd.violations.filter((v) => v.severity === "error").map((v) => v.title).join("；");
    throw new Error(`Flink SQL 方言校验未通过,已拦截启动(避免提交注定失败的作业):${detail}。请修正后重试。`);
  }
  // @kf-batch 50-WP4quater-reads(工单 SC-5)—— 🔴 落点在这里定下,之后每一步都用它:
  //   区域 / 角色 / 代码桶 / 产物桶 / 私有子网 全部来自 ctx,不再有主控区默认值。
  //   `opts.targetId` 由路由从**作业行上的章**取(`flinkJobTarget`),不接受前端裸传。
  const ctx = await ctxFor(opts.targetId);
  const rdy = flinkReady(ctx);
  if (!rdy.ok) throw new Error(`${rdy.reason}(执行落点 ${ctx.targetId} / ${ctx.region})`);
  const runner = runnerFor(sinkType);
  let codeKey = runner.codeKey;
  let finalSql = resolveSql(gd.code, jobId, ctx);
  finalSql = await resolveMysqlSink(finalSql, sinkDatasourceId);
  // 模块32 多 source:MySQL CDC 源凭证(${SRC_*})从所选源数据源注入(不入库)+ server-id 唯一化(端口以数据源为准)。
  finalSql = await resolveMysqlCdcSource(finalSql, sourceDatasourceId, jobId);
  // 模块42 P42.7c 多源:Kinesis 源 ${SOURCE_STREAM_ARN} 按所选 kinesis 数据源的流注入(未选回退全局默认流)。
  finalSql = await resolveKinesisSource(finalSql, sourceDatasourceId, ctx);
  // 模块42 P42.6b:MSK/Kafka 源 ${KAFKA_TOPIC}/${KAFKA_AUTH_PROPS} 按所选 MSK 数据源的连接+认证注入(密钥不入库)。
  finalSql = await resolveMskSource(finalSql, sourceDatasourceId, ctx.region);
  finalSql = resolveS3TableSink(finalSql, ctx);
  const cdcSource = isMysqlCdcSource(finalSql);
  const kafkaSource = isKafkaSource(finalSql); // MSK/Kafka 源:强制模块化装配(胖包未打 kafka)+ 接私有 VPC
  // 🔴 启动前置决策预检(必须在 ensureApplication 之前 —— 它会 Update 应用配置;
  //    若用户在弹窗里点了取消,不能留下已被改动的应用)。
  //    仅当"确实要靠快照恢复"时才检:关快照/无快照的作业本就冷启动,无决策可言。
  const snapshotsOnPre = normalizeResources(resources).snapshotsEnabled;
  let preProbe: ProbeResult | undefined;
  if (snapshotsOnPre) {
    preProbe = await probeSnapshots(ctx, name, cdcSource, sourceDatasourceId);
    if (preProbe.probe === "stale" && !opts?.discardStateConfirmed) {
      // 🔴 平台在此【停下】:不自动降级冷启动、不改任何配置、不启动应用。
      //    消解方式(丢弃进度从头重读)会重算历史、可能重复写入 —— 属业务决策,必须用户自己点。
      throw new FlinkDecisionRequired(
        "CDC_BINLOG_POSITION_EXPIRED",
        "无法从上次的进度继续:源库的变更日志(binlog)已轮转,上次停止时记录的读取位置已不存在。" +
          "继续运行需要【丢弃已保存的进度、从头完整读取一遍源表】——这会重算历史数据," +
          "若下游不是幂等写入可能产生重复。请确认后再启动。",
        "discard-state",
        { snapshotAt: preProbe.snapshotAt, oldestBinlogAt: preProbe.oldestBinlogAt },
      );
    }
  }
  // 自定义 sink:先解析连接定义(占位符凭证注入)+ 收集用户连接器 keys(下面按拼装模式装配)。
  let customConnectorKeys: string[] = [];
  if (sinkType === "custom") {
    finalSql = await resolveCustomSink(finalSql, sinkDatasourceId);
    for (const id of connectorIds || []) {
      const c = await getConnector(id);
      if (c?.s3Key) customConnectorKeys.push(c.s3Key);
    }
    if (customConnectorKeys.length === 0) throw new Error("自定义 sink 作业未选择已上传的连接器(请先在「连接器管理」上传 JAR)");
  }
  // 🔴 模块 32-CR CR.4:代码 JAR 装配 —— 绞杀者式双路径,由 env 开关控制,默认走【胖包】(零行为变化)。
  //  · 开关关(默认 FLINK_MODULAR_ASSEMBLY!=="1"):现有胖包路径逐字不变 ——
  //      runnerFor(sinkType) 选基础/s3t 包;custom 走 assembleUberJar 合并用户连接器。所有现有作业零影响。
  //  · 开关开:走模块化按需拼装(assembleModularUberJar,CR.3)——按 finalSql 解析所需连接器模块拼 uber-jar
  //      (含 custom 的用户连接器),内容哈希缓存。仅显式开启才走,供 CR.4 parity 真跑验证。
  //  🔴 P42.6b:MSK/Kafka 源【强制走模块化】(不论全局开关)——因两个胖包(base/s3t)均【未打 kafka connector】
  //     (§11.8 核实),kafka 作业只能靠模块库的 kafka(+msk-iam-auth)模块按需拼装。这是"仅对 kafka 作业"的
  //     定向启用:非 kafka 作业仍严格遵循全局开关(默认胖包,零回归)。全局切默认仍是 CR.5。
  //  runtimeEnvironment 两路径一致(始终 FLINK.runtimeEnvironment),故 ensureApplication 用 runner.runtimeEnvironment 不变。
  if (kafkaSource || process.env.FLINK_MODULAR_ASSEMBLY === "1") {
    // §2.0 分治:含 iceberg 的组合 asm.prebuilt=true(返回预构建 s3t 包,不运行期合并);轻量走按需合并。
    //   Kafka→S3 裸文件 = 轻量[kafka,msk-iam-auth,files,json]运行期合并;Kafka→S3Tables = 预构建 s3t 组合包(路径2)。
    // @kf-batch 50-WP4quater-reads(工单 SC-5)—— 合并结果必须落**这个作业所在区**的代码桶
    const asm = await assembleModularUberJar(finalSql, customConnectorKeys, { region: ctx.region, codeBucket: ctx.codeBucket });
    codeKey = asm.key;
    console.log("[flink] 模块化拼装", { app: name, kafkaSource, modules: asm.modules, cached: asm.cached, prebuilt: !!asm.prebuilt, codeKey });
  } else if (sinkType === "custom") {
    // 胖包路径(默认):custom 走原 assembleUberJar 合并(逐字保持)。
    codeKey = await assembleUberJar(jobId, customConnectorKeys, { region: ctx.region, codeBucket: ctx.codeBucket });
  }
  // VPC 接入:
  //  · MySQL CDC 源(读私有 RDS binlog):必须接 VPC,用【用户自选】的子网 + SG(下拉框,网络可达性用户自理)。
  //    优先于 sink 判断——因为源在 VPC 内、sink 是 S3Table(托管网络),网络瓶颈在源端。
  //  · 🔴 MSK/Kafka 源(P42.6b):broker 在私有 VPC(9098/9096),同 CDC 必须接 VPC(用户自选子网+SG,§11.5
  //    网络在作业级)。与 CDC 同优先级(源在 VPC 内,不论 sink 是 S3 裸文件还是 S3Tables)。
  //  · custom sink:用户自管 VPC(显式选私有子网 + SG)。
  //  · mysql sink:后端按目标 RDS 自动解析。
  //  · s3table sink(非 CDC/非 kafka 源,如 Kinesis):不接 VPC(经 AWS 托管网络访问 S3 Tables)。
  const vpcConfig =
    cdcSource ? resolveCustomVpc(ctx, customVpc)
    : kafkaSource ? resolveCustomVpc(ctx, customVpc)
    : sinkType === "custom" ? resolveCustomVpc(ctx, customVpc)
    : sinkType === "s3table" ? undefined
    : await resolveSinkVpc(ctx, sinkDatasourceId);
  if (cdcSource && !vpcConfig) throw new Error("MySQL CDC 源作业必须选择 VPC 子网 + 安全组(用于连私有 RDS 读 binlog)");
  if (kafkaSource && !vpcConfig) throw new Error("MSK/Kafka 源作业必须选择 VPC 子网 + 安全组(用于连私有 VPC 内的 broker，端口 9098/9096)");
  // 🔴 runner JAR 必须先在**这个区的**代码桶里(不在就从主控区跨区复制一份):
  //    缺 JAR 时 MSAF 只报「取不到 fileKey」,那条报错指不到「JAR 没送到这个区」这件事上。
  await ensureRunnerJar(ctx, codeKey);
  const status = await ensureApplication(ctx, jobId, finalSql, { runtimeEnvironment: runner.runtimeEnvironment, codeKey }, vpcConfig, resources, executionRoleArn);
  // 仅在就绪态启动;已 RUNNING/STARTING 则跳过。
  if (status === "READY") {
    // 启动恢复策略(根治 S3Tables 首帧 412):按【快照可恢复性四态】决策。
    //  · available/unknown → RESTORE_FROM_LATEST_SNAPSHOT:有快照则续编 checkpointId(绝不归 1),
    //    delta manifest 文件名单调变化,永不撞上一轮残留 → 无 412;无快照时 AWS 自动全新启动(已坐实)。
    //  · none(确认无快照) → SKIP:首启/空表,无残留可撞。
    //  · stale → 走到这里意味着**用户已显式确认丢弃进度**(否则上面预检已中止启动)→ SKIP 冷启动。
    //  · 关快照(高级用户显式)→ 恒 SKIP,尊重用户选择。
    // 🔴 两次真机事故的守卫:①探测异常曾被 `catch {}` 吞成"无快照" → 恒 SKIP → 412(§4.1);
    //                        ②过期快照曾被当成可用 → CDC 崩溃循环(§9,现由预检+用户确认拦住)。
    // 复用预检结果,不重复探测(省一次 List + 一次源库连接;且保证预检与启动决策口径一致)。
    const snapshotsOn = snapshotsOnPre;
    const probe: SnapshotProbe = snapshotsOn ? (preProbe?.probe ?? "unknown") : "none";
    // 🔴 用户显式确认"丢弃进度"→ resolveRestoreType 无条件 SKIP,凌驾探测结果。
    //    这是运行中崩溃循环(位点过期最常见暴露路径,预检判不出 stale)能真正自愈的闭环:
    //    详情页诊断给出"放弃旧位点重启"→ 带 discardStateConfirmed 重启 → 此处才真冷启动,而非又 RESTORE 回过期快照。
    const restoreType = resolveRestoreType(snapshotsOn, probe, opts?.discardStateConfirmed);
    console.log("[flink] 启动恢复决策", {
      app: name, snapshotsOn, probe, restoreType, cdcSource: !!cdcSource,
      discardStateConfirmed: !!opts?.discardStateConfirmed,
    });
    await ctx.kda.send(new StartApplicationCommand({
      ApplicationName: name,
      RunConfiguration: { ApplicationRestoreConfiguration: { ApplicationRestoreType: restoreType } },
    }));
  }

  // 计算血缘(best-effort,不阻断启动):从注入后的 finalSql 提取 source→sink 表级边写平台血缘表,
  // 让 Flink 实时产出表(如 s3.realtime.flink_*)在治理血缘图有上游来源(此前 Flink 零血缘)。
  try {
    const { inputs, outputs } = parseFlinkSqlLineage(finalSql, jobId);
    if (inputs.length && outputs.length) {
      // 双写:①平台 bgp-lineage(回退源) ②OpenMetadata(治理页血缘图主源)——此前 Flink 只写①
      // 导致产出表在治理页无上游(治理页读 OM)。与 EMR/SQL 类任务的双写策略对齐。
      await recordComputeLineage({ inputs, outputs, taskId: jobId, engine: "flink" });
      // 物理端点:Kinesis 源作业(非 CDC,SQL connector=kinesis)把平台默认 Kinesis 流挂成
      // 产出表上游的物理流节点;MySQL CDC 源作业的物理 RDS 由 computeFqnToOm 的源端点自然挂上。
      const physicalStreams = !cdcSource && /connector'?\s*=\s*'kinesis'/i.test(finalSql) ? [SOURCE_STREAM] : [];
      pushComputeLineageToOM({ inputs, outputs, taskId: jobId, engine: "Flink", physicalStreams }).catch(() => {});
    }
  } catch { /* best-effort */ }

  return { appName: name };
}

const RUNNING_LIKE = ["RUNNING", "STARTING", "UPDATING", "AUTOSCALING"];

/** 停止(暂停)作业:只 StopApplication 停 KPU 计费,【保留 MSAF 应用与日志组】。幂等。
 *  与"删除"区分(用户拍板):UI 停止 = 仅停,后台 Flink 应用仍在(可再启动/可诊断/可看日志);
 *  UI 删除才真正销毁应用。保留应用+日志也让 AI 诊断在停止后仍有证据可查。
 *  返回离开运行态前抓到的最近错误(供持久化到 lastError)。 */
export async function pauseFlinkJob(jobId: string, targetId: string): Promise<{ lastError?: string }> {
  const ctx = await ctxFor(targetId);
  const name = appName(jobId);
  const d = await describe(ctx, name);
  if (!d) return {};
  const st = String(d.ApplicationStatus || "");
  if (RUNNING_LIKE.includes(st)) {
    // 启用快照的作业优雅停止(自动打快照,下次 start 可恢复状态);未启用或优雅停失败则强停。
    const snapshotsOn = d.ApplicationConfigurationDescription?.ApplicationSnapshotConfigurationDescription?.SnapshotsEnabled === true;
    try {
      await ctx.kda.send(new StopApplicationCommand({ ApplicationName: name, Force: !snapshotsOn }));
    } catch {
      try { await ctx.kda.send(new StopApplicationCommand({ ApplicationName: name, Force: true })); } catch { /* best-effort */ }
    }
    // 原 30 × 4s 的本地循环改经 awaitTerminal(预算逐字保留;到顶照原样继续往下抓根因)
    try {
      await awaitTerminal<void>({
        what: `MSAF 应用 ${name} 停止`,
        maxPolls: 30,
        initialMs: 4000,
        backoff: 1,
        probe: async () => {
          const cur = await describe(ctx, name);
          if (!cur || !RUNNING_LIKE.includes(String(cur.ApplicationStatus || ""))) return { done: true, value: undefined };
          return { done: false, state: String(cur.ApplicationStatus) };
        },
      });
    } catch (e) {
      if (!(e instanceof LongOpWaitBudgetExceeded)) throw e;
    }
  }
  // 抓最近的错误根因(若有),供持久化——这样停止后即使日志在,诊断也能直接拿到。
  let lastError: string | undefined;
  // @kf-batch 50-WP31-place-first-class —— 🔴 WP-31 观测器在第九轮硬门里抓到:这里原来**没传落点** ⇒ 非主控区作业停止时
  //   去**主控区**的日志组抓根因(FilterLogEvents @ us-east-1,恒空)。闭合门 realtime-region-place 只列举了 4 个函数名、
  //   没列它 ⇒ 漏。根治 = 本文件的落点参数全部改**必填**(漏传编译不过),不再往名单里加第 5 个名字。
  try { lastError = await captureRootError(jobId, targetId); } catch { /* best-effort */ }
  return { lastError };
}

/** 删除作业的 MSAF 应用(真正销毁 + 删日志组)。供 UI「删除」用。幂等(不存在视为已删)。 */
/**
 * @kf-batch 50-B28-flink-delete-settling
 * MSAF 应用的**过渡态**:在这些状态下 `DeleteApplication` 必抛 `ResourceInUseException`。
 * 🔴🔴 B-28(2026-10-01 新账号硬门 `scq` A3-撤 真撞):原来只等 `RUNNING_LIKE`(不含 STOPPING)⇒ 用户点「停止」后紧接着点「删除」,
 *   应用正在 STOPPING ⇒ 跳过等待直接删 ⇒ ResourceInUse ⇒ 页面 502「请重试」,作业留着。
 */
export const FLINK_SETTLING_STATUSES = ["STOPPING", "FORCE_STOPPING", "STARTING", "UPDATING", "AUTOSCALING", "ROLLING_BACK", "MAINTENANCE", "DELETING"] as const;

/** 应用还在过渡态、本次请求等不到它稳下来 ⇒ 不删记录,让用户稍后再点(路由回 409,不是 502)。 */
export class FlinkAppSettling extends Error {
  constructor(public readonly status: string) {
    super(`该区的 Flink 应用正处于「${status}」(停止 / 状态切换中),现在删不了;等它停稳(通常 1 分钟内)再点删除即可`);
    this.name = "FlinkAppSettling";
  }
}

/** 请求内最多等这么久(CloudFront 回源 60s 墙;留余量)。 */
const DELETE_SETTLE_BUDGET_MS = 40_000;

export async function deleteFlinkApp(jobId: string, targetId: string, opts: { pollMs?: number; budgetMs?: number } = {}): Promise<void> {
  const ctx = await ctxFor(targetId);
  const name = appName(jobId);
  const pollMs = opts.pollMs ?? 4000;
  const budgetMs = opts.budgetMs ?? DELETE_SETTLE_BUDGET_MS;
  const d = await describe(ctx, name);
  if (d) {
    if (RUNNING_LIKE.includes(String(d.ApplicationStatus || ""))) {
      try { await ctx.kda.send(new StopApplicationCommand({ ApplicationName: name, Force: true })); } catch { /* best-effort */ }
    }
    // 等到「不在运行 ∧ 不在过渡态」(或应用已消失);等不到就**明确**说还在过渡态,不去撞 ResourceInUse
    let cur = await describe(ctx, name);
    const busy = (x: typeof cur) => !!x && (RUNNING_LIKE.includes(String(x.ApplicationStatus || "")) ||
      (FLINK_SETTLING_STATUSES as readonly string[]).includes(String(x.ApplicationStatus || "")));
    if (busy(cur)) {
      // 原「while busy && 没到 deadline」改经 awaitTerminal:预算 budgetMs / pollMs 轮(模块 55 第二批);预算 ≤ 0 ⇒ 一轮都不等
      if (budgetMs <= 0) throw new FlinkAppSettling(String(cur!.ApplicationStatus || ""));
      try {
        cur = await awaitTerminal<typeof cur>({
          what: `MSAF 应用 ${name} 停稳`,
          maxPolls: Math.max(1, Math.ceil(budgetMs / pollMs)),
          initialMs: pollMs,
          backoff: 1,
          probe: async () => {
            const now = await describe(ctx, name);
            return busy(now) ? { done: false, state: String(now!.ApplicationStatus || "") } : { done: true, value: now };
          },
        });
      } catch (e) {
        if (!(e instanceof LongOpWaitBudgetExceeded)) throw e;
        throw new FlinkAppSettling(e.lastState || "UNKNOWN");
      }
    }
    if (cur) {
      await ctx.kda.send(new DeleteApplicationCommand({ ApplicationName: name, CreateTimestamp: cur.CreateTimestamp! }));
    }
  }
  try { await ctx.cwl.send(new DeleteLogGroupCommand({ logGroupName: logGroupName(jobId) })); } catch { /* best-effort */ }
}

// @kf-batch 50-B28b-flink-delete-async
// 🔴🔴 B-28 第二次(2026-10-01 第九轮硬门 `scq` A3-撤 再红,用户:「别总是在同一个地方踩坑」):
//   第一次修法把「停止中删除」从 502 改成 409「稍后再点」—— 用户点一次删除**仍然删不掉**,
//   只是错误码好看了。真环境实测 MSAF 从 STOPPING 到 READY 用了 44s,而一次请求最多等 40s(回源墙 60s)
//   ⇒ 「在请求里等」这条路结构上就不可靠。⇒ 改成**异步受理**:等不到就把行标成 `deleting`、回 202,
//   由本进程后台继续等到停稳再销毁并删行;进程重启了,任何一次列表 / 详情读取会把它接着做完(reconcile)。
//   判据钉的是**用户结果**:点一次删除 ⇒ 作业最终从列表消失,不是「回了个什么码」。

/** 后台删除最多等多久(MSAF 停止通常 < 2 分钟;留足余量,超了就把行标成 error 并说清楚,不无限挂着)。 */
export const DELETE_BACKGROUND_BUDGET_MS = 15 * 60_000;

const deletionsInFlight: Set<string> = ((globalThis as unknown as Record<symbol, unknown>)[
  Symbol.for("bgp.flink.deletionsInFlight")
] ??= new Set<string>()) as Set<string>;

async function setJobStatus(jobId: string, status: FlinkDbStatus, extra: Record<string, unknown> = {}): Promise<void> {
  const names: Record<string, string> = { "#s": "status" };
  const values: Record<string, unknown> = { ":s": status, ":now": new Date().toISOString() };
  let expr = "SET #s = :s, updatedAt = :now";
  for (const [k, v] of Object.entries(extra)) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    expr += `, #${k} = :${k}`;
  }
  await docClient.send(new UpdateCommand({
    TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId },
    UpdateExpression: expr, ExpressionAttributeNames: names, ExpressionAttributeValues: values,
  }));
}

/**
 * 把一次「已受理的删除」做完:等应用停稳 → 销毁 → 删行。🔴 删行带条件 `status = deleting`
 * (用户在这期间不可能改它,但别的路径若改了状态,宁可留着让人看见也不误删)。
 * 超时 / 真失败 ⇒ 行改成 `error` + lastError 说清原因(作业**没删**,可再点删除),绝不静默。
 */
export async function finishFlinkDeletion(
  jobId: string,
  targetId: string,
  opts: { pollMs?: number; budgetMs?: number; attemptBudgetMs?: number } = {}
): Promise<"deleted" | "failed"> {
  const deadline = Date.now() + (opts.budgetMs ?? DELETE_BACKGROUND_BUDGET_MS);
  for (;;) {
    try {
      await deleteFlinkApp(jobId, targetId, { pollMs: opts.pollMs, budgetMs: Math.min(opts.attemptBudgetMs ?? 60_000, Math.max(0, deadline - Date.now())) });
      break;
    } catch (e) {
      if (e instanceof FlinkAppSettling && Date.now() < deadline) continue;
      const why = e instanceof FlinkAppSettling
        ? `删除未完成:该区的 Flink 应用 ${Math.round((opts.budgetMs ?? DELETE_BACKGROUND_BUDGET_MS) / 60_000)} 分钟内一直停在「${e.status}」—— 作业未删除,请稍后再点删除`
        : `删除未完成:销毁该区的 Flink 应用失败(${String((e as Error)?.message ?? e).slice(0, 240)})—— 作业未删除(先删记录会留下继续计费的孤儿),请重试`;
      await setJobStatus(jobId, "error", { lastError: why }).catch(() => {});
      return "failed";
    }
  }
  await docClient.send(new DeleteCommand({
    TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId },
    ConditionExpression: "#s = :d", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":d": "deleting" },
  })).catch(() => {});
  return "deleted";
}

/** 后台接着做(同一进程内同一作业只跑一份)。返回是否新起了一份。 */
const deletionJobs = new Map<string, Promise<unknown>>();

export function ensureFlinkDeletion(
  jobId: string,
  targetId: string,
  opts: { pollMs?: number; budgetMs?: number; attemptBudgetMs?: number } = {}
): boolean {
  if (deletionsInFlight.has(jobId)) return false;
  deletionsInFlight.add(jobId);
  // 模块 55 第二批:后台销毁是「请求外的循环入口」(读时对账也会起它)⇒ 包进登记过的后台等待者上下文,里面的 awaitTerminal 才合法
  const p = runAsBackgroundWaiter("flink-deletion", () => finishFlinkDeletion(jobId, targetId, opts))
    .catch(() => "failed")
    .finally(() => {
      deletionsInFlight.delete(jobId);
      deletionJobs.delete(jobId);
    });
  deletionJobs.set(jobId, p);
  return true;
}

/** 单测用:等本进程里所有后台删除做完。 */
export async function __flinkDeletionsSettled(): Promise<void> {
  while (deletionJobs.size) await Promise.all(Array.from(deletionJobs.values()));
}

/**
 * 删除的唯一入口(路由调它)。停得下来 ⇒ 当场删完(`deleted`);还在停 ⇒ 标 `deleting` 并后台做完(`accepted`)。
 * 其它失败原样抛(路由回 502,**不动记录** —— T-14 不变量)。
 */
export async function requestFlinkDeletion(
  jobId: string,
  targetId: string,
  opts: { pollMs?: number; budgetMs?: number; background?: { pollMs?: number; budgetMs?: number; attemptBudgetMs?: number } } = {}
): Promise<"deleted" | "accepted"> {
  try {
    await deleteFlinkApp(jobId, targetId, { pollMs: opts.pollMs, budgetMs: opts.budgetMs });
  } catch (e) {
    if (!(e instanceof FlinkAppSettling)) throw e;
    await setJobStatus(jobId, "deleting", { deleteRequestedAt: new Date().toISOString() });
    ensureFlinkDeletion(jobId, targetId, opts.background);
    return "accepted";
  }
  await docClient.send(new DeleteCommand({ TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId } }));
  return "deleted";
}

/** 从 CloudWatch 抽取作业的"真实根因错误"一行(提交失败/重启循环的 throwable 摘要)。
 *  供停止时持久化到 lastError、以及诊断兜底。无错误返回 undefined。 */
export async function captureRootError(jobId: string, targetId: string): Promise<string | undefined> {
  // @kf-batch 50-WP27-9cap-matrix —— 🔴 同族第六处:这里也把落点算出来就扔了
  //   (`ctxFor(targetId)` 之后调 `readFlinkLogs(jobId, 200)` 不带 target)⇒ 非 home 的流作业
  //   停止时抓「真实根因」抓的是**主控区**的日志组(空的)⇒ `lastError` 恒空、页面上「为什么失败」
  //   永远说不出来。落点参数在签名里、调用点没接上 —— 由闭合门
  //   `lib/realtime/__tests__/realtime-region-place.test.ts` 扫全仓调用点钉住。
  try {
    const logs = await readFlinkLogs(jobId, 200, targetId);
    // 关注 SQL 解析失败 / 提交失败 / 根因 throwable。
    const hit = logs.find((l) =>
      /Could not execute application|Encountered \"|ProgramInvocationException|SqlParseException|ValidationException|Caused by|NoClassDefFoundError|ClassNotFoundException|Access ?Denied|Communications link failure|Could not (start|execute)/i.test(l.msg)
    );
    if (!hit) return undefined;
    return hit.msg.replace(/\s+/g, " ").slice(0, 600);
  } catch {
    return undefined;
  }
}

/** 签发 Flink 控制台(Apache Flink Dashboard)临时访问 URL。仅 RUNNING 态可签发;有效期 MSAF 固定。
 *  让用户从平台一键跳转到原生 Flink Web UI 看作业拓扑/反压/checkpoint/exception 等详情。 */
export async function flinkDashboardUrl(jobId: string, targetId: string): Promise<string | null> {
  const ctx = await ctxFor(targetId);
  const d = await describe(ctx, appName(jobId));
  if (!d || d.ApplicationStatus !== "RUNNING") return null; // 非运行态无 dashboard
  try {
    const r = await ctx.kda.send(new CreateApplicationPresignedUrlCommand({
      ApplicationName: appName(jobId),
      UrlType: "FLINK_DASHBOARD_URL",
      SessionExpirationDurationInSeconds: 1800, // 30 分钟
    }));
    return r.AuthorizedUrl || null;
  } catch { return null; }
}

/** 查询应用状态(供详情页轮询)。 */
export async function describeFlinkJob(jobId: string, targetId: string): Promise<{ status: string; versionId?: number } | null> {
  const ctx = await ctxFor(targetId);
  const d = await describe(ctx, appName(jobId));
  if (!d) return null;
  return { status: d.ApplicationStatus || "UNKNOWN", versionId: Number(d.ApplicationVersionId || 0) };
}

// 平台作业状态全集(单一事实来源)。draft=从未启动;running/starting=运行态;stopped=已停;
// error=启动失败;deleted=曾启动但 MSAF 应用在 AWS 侧已不存在(被外部删除/账号回收)——与用户主动 stopped 区分。
// @kf-batch 50-B28b-flink-delete-async —— + stopping(引擎还在停;原来直接写 stopped ⇒ 平台先于引擎说「已停止」,
//   下游据此去删就撞上过渡态)+ deleting(删除已受理、后台做完)。两者都**不**短路对账:要一直问到引擎稳下来。
export type FlinkDbStatus = "draft" | "starting" | "running" | "stopping" | "stopped" | "error" | "deleting" | "deleted";
const FLINK_TERMINAL: FlinkDbStatus[] = ["draft", "stopped", "error", "deleted"];
/**
 * @kf-batch 50-WP27-9cap-matrix
 * 读时对账**可以短路**的状态 —— 刻意**不含 `deleted`**。
 *
 * 🔴 区别在于「谁把它放成这个状态」:
 *   · `draft` / `stopped` / `error` = 有人(用户或启动流程)**有意**把它放在这里 ⇒ 不必每次去问 AWS;
 *   · `deleted` = 平台自己**推导**的结论(Describe 回不来 ⇒ 认为 AWS 侧没有了)。推导会错
 *     (2026-09-19 实证:对账打错了区,把一个在 us-west-2 好好跑着的作业判成「AWS已删除」),
 *     而一旦短路,这个错结论**永远不会被复核** ⇒ 页面永久说谎、用户永远看不到那个区的实时计算。
 *   ⇒ 推导出来的结论必须能被重新勘定(记忆 `stale-blockers-must-be-reprobed`)。
 */
const RECONCILE_SHORT_CIRCUIT: FlinkDbStatus[] = ["draft", "stopped", "error"];

/** 把 MSAF 应用真实状态映射为平台 DB 状态。null = AWS 侧应用不存在。 */
export function mapAppStatusToDb(appStatus: string | null, hadAppName: boolean, prev: string): FlinkDbStatus {
  if (appStatus === "RUNNING" || appStatus === "AUTOSCALING") return "running";
  if (appStatus === "STARTING" || appStatus === "UPDATING") return "starting";
  if (appStatus === "STOPPING" || appStatus === "FORCE_STOPPING") return "stopping";
  if (appStatus === "READY") return "stopped";
  // 应用在 AWS 侧不存在(describe 返回 null):曾启动过(有 appName)且此前非终态 → 判定为「已删除」;
  // 否则保留原状态(如从未部署的 draft,或用户刚 stop 删应用后本就该是 stopped/error)。
  if (appStatus === null || appStatus === "NOT_DEPLOYED") {
    if (hadAppName && (prev === "running" || prev === "starting")) return "deleted";
    return (prev as FlinkDbStatus) || "draft";
  }
  return (prev as FlinkDbStatus) || "draft";
}

/** 读时对账:对非终态作业查 MSAF 真实态,纠正并(机会性)回写 DB,返回真实的 DB 状态 + 原始 appStatus。
 *  终态(draft/stopped/error/deleted)直接返回原状态,不查后端(省调用、且避免把正常停的误判)。 */
export async function reconcileFlinkStatus(job: any): Promise<{ dbStatus: FlinkDbStatus; appStatus: string }> {
  // @kf-batch 50-WP4quater-reads(工单 SC-5)—— 🔴 对账必须打**作业自己那个区**:
  // 用主控区客户端去 Describe 别区的应用,回 ResourceNotFound ⇒ 这里会把作业写成「已删除」,
  // 而它在那个区好好跑着(这与离线侧「Glue 对账用 home 客户端把成功写成 failed」是同一个坑)。
  // @kf-batch 50-WP27-9cap-matrix —— 🔴🔴 **这里原来把落点算出来就扔了**:
  //   `const ctx = await ctxFor(flinkJobTarget(job))` 之后紧接着调的是 `describeFlinkJob(job.jobId)`
  //   ——**没把 target 传下去**,于是非 home 的作业永远拿主控区客户端去 Describe 别区的应用,
  //   ResourceNotFound 被 `.catch(() => null)` 吞掉 ⇒ 映射成 `deleted`(「AWS 侧已不存在」),
  //   而它在那个区好好跑着。上面那段注释写得很清楚要打作业自己那个区,但**调用点没接上**
  //   (记忆 `unwired-code-is-unverified`:「写了」≠「接上了」)。
  //   真环境实证(2026-09-19):usw2 的示范流作业 MSAF 侧 RUNNING,而页面显示「AWS已删除」。
  const target = flinkJobTarget(job);
  const prev = String(job.status || "draft");
  // 🔴 `deleted` **不是**能短路的终态:它是平台**推导**出来的结论(「AWS 侧不存在」),不是用户的动作。
  //   一旦推错(比如上面那个 bug),短路会让它**永远**不再复核 ⇒ 页面永久说谎。
  //   draft / stopped / error 才是「有人有意把它放在这个状态」,短路是对的。
  //   (记忆 `stale-blockers-must-be-reprobed`:推导出来的「做不到/不存在」必须能被重新勘定。)
  // @kf-batch 50-B28b-flink-delete-async —— 删除已受理:任何一次读取都把它接着做完(进程重启后的兜底;同进程去重)
  if (prev === "deleting") {
    ensureFlinkDeletion(String(job.jobId), target);
    return { dbStatus: "deleting", appStatus: "DELETING" };
  }
  if (!job.appName || RECONCILE_SHORT_CIRCUIT.includes(prev as FlinkDbStatus)) {
    return { dbStatus: (prev as FlinkDbStatus) || "draft", appStatus: job.appName ? "UNKNOWN" : "NOT_DEPLOYED" };
  }
  // @kf-batch 50-WP31-place-first-class —— 🔴🔴 **看不了 ≠ 不存在**:原来 `.catch(() => null)` 把**任何**失败(落点解析不开 /
  //   AccessDenied / 限流 / 网络)都当成「Describe 回 null」⇒ 运行中的作业被推导成 `deleted` **并写回 DDB**。
  //   序 3 收尾让主控区也读描述符之后,主控区描述符一时解析不开就会把主控区所有运行中的作业写成「AWS已删除」。
  //   「应用不存在」只有一个来源:`describe()` 把 ResourceNotFoundException 映成 null(上面那个函数)。其余失败 ⇒ 保留原状态、不写库。
  let d: { status: string; versionId?: number } | null;
  try {
    d = await describeFlinkJob(job.jobId, target);
  } catch {
    return { dbStatus: (prev as FlinkDbStatus) || "draft", appStatus: "UNKNOWN" };
  }
  const appStatus = d?.status || "NOT_DEPLOYED";
  const mapped = mapAppStatusToDb(d ? d.status : null, !!job.appName, prev);
  if (mapped !== prev) {
    docClient.send(new UpdateCommand({
      TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId: job.jobId },
      UpdateExpression: "SET #s = :s, updatedAt = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": mapped, ":now": new Date().toISOString() },
    })).catch(() => {});
  }
  return { dbStatus: mapped, appStatus };
}

/**
 * @kf-batch 50-WP31-place-first-class —— 序 3 收尾:列表的读时对账 = **一次请求碰多个区** ⇒ 唯一写法 `forEachTargetPlace`(L10)。
 * 按作业的章分组,每个区一个分支、各自一个嵌套落点上下文(拦截模式下该区的 Describe 按它自己的区核验);
 * 原来是 `rows.map(reconcileFlinkStatus)` 平铺,一个请求里混着两个区的调用、没有任何上下文。
 * 某个区的落点解析不开 ⇒ 那个区的行照样交给 `reconcileFlinkStatus`(它对「看不了」保留原状态,不推导成已删除)。
 * 单行对账失败不阻塞列表(保留原状态),与原实现相同。
 */
export async function reconcileFlinkJobs(rows: Array<Record<string, any>>): Promise<void> {
  const byTarget = new Map<string, Array<Record<string, any>>>();
  for (const it of rows) {
    const t = flinkJobTarget(it);
    const list = byTarget.get(t);
    if (list) list.push(it);
    else byTarget.set(t, [it]);
  }
  await forEachTargetPlace(
    Array.from(byTarget.keys()),
    async (targetId) => {
      await Promise.all(
        (byTarget.get(targetId) ?? []).map(async (it) => {
          try {
            const { dbStatus } = await reconcileFlinkStatus(it);
            it.status = dbStatus;
          } catch {
            /* 保留原状态 */
          }
        })
      );
    },
    { via: "reconcileFlinkJobs" }
  );
}

/** 读取 S3 上的流计算输出(JSON 行),供详情页"结果预览"无头核验。 */
export async function readFlinkResults(jobId: string, limit: number, targetId: string): Promise<any[]> {
  const ctx = await ctxFor(targetId);
  if (!ctx.outputBucket) return [];
  const prefix = `flink-out/${jobId}/`;
  const listed = await ctx.s3.send(new ListObjectsV2Command({ Bucket: ctx.outputBucket, Prefix: prefix, MaxKeys: 200 }));
  const rows: any[] = [];
  // 过滤掉在写中的临时文件(.inprogress / 隐藏),只读已提交的 part 文件。
  const objs = (listed.Contents || [])
    .filter((o) => o.Key && (o.Size || 0) > 0 && !o.Key.includes(".inprogress") && !o.Key.split("/").pop()!.startsWith("."))
    .sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0));
  for (const o of objs) {
    if (rows.length >= limit) break;
    try {
      const r = await ctx.s3.send(new GetObjectCommand({ Bucket: ctx.outputBucket, Key: o.Key! }));
      const text = await r.Body!.transformToString();
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try { rows.push(JSON.parse(t)); } catch { /* skip non-json line */ }
        if (rows.length >= limit) break;
      }
    } catch { /* skip unreadable object */ }
  }
  return rows;
}

/** 读取 MSAF 应用 CloudWatch 日志,供详情页「运行日志」无头核验。
 *  关键:保留并优先展示错误/异常日志,且【完整带出异常根因链】(throwableInformation 的 Caused by),
 *  不再因 msg 过长被丢弃/截断到看不出根因(这是此前"日志看不出根本原因"的根源)。
 *  窗口放宽到 60 分钟;错误行长度上限放宽到 4000 字符;非错误噪声仍压缩,避免淹没。 */
export async function readFlinkLogs(jobId: string, limit: number, targetId: string): Promise<{ time: string; level: string; msg: string }[]> {
  const ctx = await ctxFor(targetId);
  try {
    // 日志窗口下限 = max(最近60分钟, 本次运行起始时间)。同一 MSAF 应用反复重启/改版时,
    // 旧的失败运行日志与新运行都堆在同一日志组;若只按固定 60 分钟拉,会把【上一次运行的崩溃日志】
    // 混进当前运行,让已恢复健康的作业看起来还在失败(用户实测踩坑)。故以 lastStartedAt 为下限隔离历史运行。
    let startTime = Date.now() - 60 * 60000; // 最近 60 分钟(长跑作业的上限窗口)
    try {
      const { Item: job } = await docClient.send(new GetCommand({ TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId } }));
      const startedAt = job?.lastStartedAt ? Date.parse(String(job.lastStartedAt)) : NaN;
      // 只在本次运行起始晚于 60 分钟前时上抬下限(避免刚启动的作业把窗口收得过窄反而漏掉启动日志)。
      if (!Number.isNaN(startedAt) && startedAt > startTime) startTime = startedAt;
    } catch { /* 读不到作业记录则退回固定 60 分钟窗口 */ }
    const r = await ctx.cwl.send(new FilterLogEventsCommand({
      logGroupName: logGroupName(jobId),
      startTime,
      limit: 3000,
    }));
    const isErr = (lvl: string, m: string) => lvl === "ERROR" || lvl === "WARN" || /exception|caused by|error|failed|fail to|restart|timeout|refused|denied|partial recovery|switched from .* to FAILED/i.test(m);
    const out: { time: string; level: string; msg: string }[] = [];
    for (const e of r.events || []) {
      let level = "INFO"; let msg = e.message || ""; let cause = "";
      try {
        const j = JSON.parse(e.message || "{}");
        if (j.messageType) level = j.messageType;
        if (j.message) msg = j.message;
        // 异常根因:MSAF 把堆栈放在 throwableInformation,这里把 Caused by 链抽出来附在消息后(最关键的诊断信息)。
        if (j.throwableInformation) {
          const causes = String(j.throwableInformation).match(/Caused by: [^\n]+/g);
          if (causes && causes.length) cause = " || 根因链: " + causes.slice(0, 4).join("  <-  ");
          else cause = " || " + String(j.throwableInformation).split("\n")[0];
        }
      } catch { /* plain text line */ }
      msg = (msg + cause).replace(/\s+/g, " ").trim();
      if (!msg) continue;
      // 滤掉启动配置噪声(海量 "Loading configuration property" + 巨型 preconfig dump)。
      if (msg.startsWith("Loading configuration property")) continue;
      if (msg.startsWith("Loading dynamic configuration property")) continue;
      if (msg.includes("EnvironmentInformation")) continue;
      const err = isErr(level, msg);
      // 错误/异常行:保留到 4000 字符(含根因链);普通 INFO:超 1200 视为 dump 丢弃,>400 截断。
      if (err) { if (msg.length > 4000) msg = msg.slice(0, 4000) + "…"; }
      else { if (msg.length > 1200) continue; if (msg.length > 400) msg = msg.slice(0, 400) + "…"; }
      out.push({ time: new Date(e.timestamp || 0).toISOString().slice(11, 19), level, msg });
    }
    // 优先保留错误行:若总量超 limit,先保所有错误行 + 最近的 INFO,避免错误被 INFO 噪声挤掉。
    if (out.length > limit) {
      const errs = out.filter((l) => isErr(l.level, l.msg));
      const infos = out.filter((l) => !isErr(l.level, l.msg)).slice(-(Math.max(0, limit - errs.length)));
      return [...errs, ...infos].sort((a, b) => a.time.localeCompare(b.time)).slice(-limit);
    }
    return out;
  } catch { return []; }
}

/** MSAF 作业健康指标(CloudWatch AWS/KinesisAnalytics):用于诊断时客观判断「作业是否真失败」——
 *  fullRestarts 持续 0 + checkpoint 在成功 = 作业健康(此时日志里的 Pekko/Netty SSL WARN 多为内部
 *  RPC 良性抖动,非 sink 故障);fullRestarts 增长 / 失败 checkpoint = 真在重启循环。 */
export async function flinkHealthMetrics(jobId: string, targetId: string): Promise<{ fullRestarts: number | null; failedCheckpoints: number | null; completedCheckpoints: number | null }> {
  const ctx = await ctxFor(targetId);
  const name = appName(jobId);
  const now = Date.now();
  const get = async (metric: string, stat: "Maximum" | "Sum"): Promise<number | null> => {
    try {
      const r = await ctx.cw.send(new GetMetricStatisticsCommand({
        Namespace: "AWS/KinesisAnalytics",
        MetricName: metric,
        Dimensions: [{ Name: "Application", Value: name }],
        StartTime: new Date(now - 30 * 60000),
        EndTime: new Date(now),
        Period: 300,
        Statistics: [stat],
      }));
      const pts = (r.Datapoints || []).sort((a, b) => (a.Timestamp?.getTime() || 0) - (b.Timestamp?.getTime() || 0));
      if (!pts.length) return null;
      const last = pts[pts.length - 1] as any;
      return Number(last[stat] ?? null);
    } catch { return null; }
  };
  const [fullRestarts, failedCheckpoints, completedCheckpoints] = await Promise.all([
    get("fullRestarts", "Maximum"),
    get("numberOfFailedCheckpoints", "Maximum"),
    get("numberOfCompletedCheckpoints", "Maximum"),
  ]);
  return { fullRestarts, failedCheckpoints, completedCheckpoints };
}

/** sink 结果统一返回结构:真实表名 + 真实列(可带引擎类型)+ 行(前端按列动态渲染,模式无关)。 */
export interface S3TableResults { table: string; columns: string[]; columnTypes?: string[]; rows: Record<string, any>[] }

/** 是否为数值型引擎列类型(Athena/Trino: bigint/int/double/decimal/real/float/tinyint/smallint;
 *  MySQL driver 常量类型名同理)。用【类型】而非【值形状】判断,避免把电话号/邮编/前导零 ID 误当数字。 */
function isNumericColumnType(t?: string): boolean {
  if (!t) return false;
  return /^(tinyint|smallint|int|integer|bigint|double|float|real|decimal|numeric|dec)\b/i.test(t.trim());
}

/** 按引擎列类型把字符串单元格转成 number(仅数值列);非数值列(时间戳/字符串/ID)原样保留字符串。 */
function coerceCell(raw: any, colType?: string): any {
  if (raw == null || raw === "") return raw;
  if (isNumericColumnType(colType)) {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n; // 解析失败(极端精度等)则退回原串,绝不丢数据
  }
  return raw;
}

/** MySQL sink:查询目标表(表名从 SQL 的 'table-name' 解析)的落地结果(平台详情页展示,无头核验)。 */
export async function readMysqlResults(sinkDatasourceId?: string, sql?: string, limit = 200): Promise<S3TableResults> {
  if (!sinkDatasourceId) return { table: "", columns: [], rows: [] };
  // 目标表名从作业 SQL 的 JDBC 'table-name' 解析(不写死);严格校验防注入。
  const m = (sql || "").match(/'table-name'\s*=\s*'([^']+)'/i);
  const table = m ? m[1] : "";
  if (!table || !/^[A-Za-z0-9_]+$/.test(table)) return { table, columns: [], rows: [] };
  const { Item: ds } = await docClient.send(new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: sinkDatasourceId } }));
  if (!ds) return { table, columns: [], rows: [] };
  let user = ""; let password = "";
  if (ds.secretArn) {
    const sec = await getSecretJson(ds.secretArn);
    user = sec.username || sec.user || ""; password = sec.password || "";
  }
  const mysql = await import("mysql2/promise");
  const conn = await mysql.createConnection({ host: ds.host, port: ds.port || 3306, user, password, database: ds.database, connectTimeout: 8000 });
  try {
    // 【模式无关】SELECT * 取真实结构(不写死列名),兼容窗口聚合/CDC/自定义任意 sink 表。
    const [rows, fields] = await conn.query("SELECT * FROM `" + table + "` LIMIT ?", [limit]);
    const norm = (rows as any[]).map((r) => {
      const o: Record<string, any> = {};
      for (const k of Object.keys(r)) o[k] = r[k] instanceof Date ? r[k].toISOString().slice(0, 19).replace("T", " ") : r[k];
      return o;
    });
    // 列序优先取 driver 返回的 fields(保持建表列序);无则退回首行键。
    const columns = (fields as any[] | undefined)?.map((f) => f.name) || Object.keys(norm[0] || {});
    return { table, columns, rows: norm };
  } finally { await conn.end().catch(() => {}); }
}

/** 读 S3 Tables sink 的落地结果(供详情页"查询结果")。
 *  经 Athena 联邦目录(s3tablescatalog)查询;目标库表从作业 SQL 的 INSERT 解析(占位符先解析为实际 namespace),严格校验防注入。
 *  【模式无关】:不写死列名,SELECT * 取该 sink 表的真实结构 —— 兼容窗口聚合(window_start/region/…)、
 *  CDC 聚合(region/order_cnt/total_amount)、以及用户自定义任意结构。返回真实表名 + 列 + 行,前端动态渲染。
 *  (历史 bug:曾写死 SELECT window_start,... 对无 window_start 的 CDC 表报 COLUMN_NOT_FOUND → 0 行。) */
// 🔴 B-26:`targetId` 必填(取自作业行上的章 `flinkJobTarget`);原来三处都是主控区:表桶 / 目录引用 / Athena 落点。
export async function readS3TableResults(sql: string | undefined, limit: number, targetId: string): Promise<S3TableResults> {
  const place = await resolveFlinkPlace(targetId);
  const resolved = resolveS3TableSink(sql || "", place);
  // INSERT INTO <catalog>.`<db>`.`<table>` —— 取 db 与 table。
  const m = resolved.match(/insert\s+into\s+`?[A-Za-z0-9_]+`?\.`?([A-Za-z0-9_]+)`?\.`?([A-Za-z0-9_]+)`?/i);
  const db = m ? m[1] : "";
  const table = m ? m[2] : "";
  if (!db || !table || !/^[A-Za-z0-9_]+$/.test(db) || !/^[A-Za-z0-9_]+$/.test(table)) return { table, columns: [], rows: [] };
  const { catalogRef } = await resolveS3TablesPlace(targetId);
  const q = `SELECT * FROM ${qualifiedName(catalogRef, db, table)} LIMIT ${Math.max(1, Math.min(limit, 500))}`;
  const res = await runSelectAthena(q, { targetId });
  if (!res.success) return { table, columns: [], rows: [] };
  const types = res.columnTypes || [];
  const rows = res.rows.map((r) => {
    const o: Record<string, any> = {};
    // 按引擎列类型转换(而非猜值):数值列→number,其余原样。保留列序。
    res.columns.forEach((c, i) => { o[c] = coerceCell(r[i], types[i]); });
    return o;
  });
  return { table, columns: res.columns, columnTypes: types, rows };
}
