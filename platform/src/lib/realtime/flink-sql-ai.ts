// AI 辅助生成 Flink SQL。
//
// 复用 GenBI 的 Bedrock Converse 通道(区域来自配置 GENBI.region;模型 改为调用时经
// 解析链求值,能力 key flink-sql,不再读模块加载期 GENBI.modelId),
// 把用户自然语言意图 → 平台可直接运行的多语句 Flink SQL。
//
// 为保证"生成即可跑",系统提示把【源表 DDL + 各 sink 的 DDL 样板 + 占位符约定】固化下来,模型只在
// 其上改写聚合/窗口/过滤逻辑;占位符(${SOURCE_STREAM_ARN}/${REGION}/${OUTPUT_PATH}/${MYSQL_*}/
// ${TABLE_BUCKET_ARN}/${S3TABLE_DB})在作业启动时由后端按账号派生注入(见 flink-service)。
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { GENBI } from "@/lib/genbi/config";
import { retrieve, guard, sliceToPromptText } from "@/lib/cookbook";
// 调用时求值 + 退避/降级;返回值 `model` 字段(隐藏读取方:101)一并改为实际用的模型。
import { invokeConverse } from "@/lib/ai/invoke";
import type { SourceLayer } from "@/lib/ai/capabilities";

const bedrock = sdkClient("model", BedrockRuntimeClient, { region: GENBI.region });

const SINK_GUIDE: Record<string, string> = {
  s3: `目标 = S3 数据湖(filesystem 连接器,JSON):
CREATE TABLE <sink> ( ... ) WITH (
  'connector'='filesystem', 'path'='\${OUTPUT_PATH}', 'format'='json',
  'sink.rolling-policy.rollover-interval'='30 s', 'sink.rolling-policy.check-interval'='10 s'
);`,
  mysql: `目标 = MySQL(jdbc 连接器,批量 upsert,需主键 NOT ENFORCED):
CREATE TABLE <sink> ( ..., PRIMARY KEY (...) NOT ENFORCED ) WITH (
  'connector'='jdbc', 'url'='\${MYSQL_URL}', 'table-name'='<目标表名>',
  'username'='\${MYSQL_USER}', 'password'='\${MYSQL_PASSWORD}',
  'sink.buffer-flush.max-rows'='200', 'sink.buffer-flush.interval'='3s'
);`,
  s3table: `目标 = S3 Tables(托管 Iceberg)。必须先建 catalog 再建库表(平台 runner 会拦截 CREATE CATALOG 并在用户代码注册):
CREATE CATALOG s3t WITH (
  'type'='iceberg', 'catalog-impl'='software.amazon.s3tables.iceberg.S3TablesCatalog', 'warehouse'='\${TABLE_BUCKET_ARN}'
);
CREATE DATABASE IF NOT EXISTS s3t.\`\${S3TABLE_DB}\`;
CREATE TABLE IF NOT EXISTS s3t.\`\${S3TABLE_DB}\`.\`<表名>\` ( ... );
-- INSERT INTO s3t.\`\${S3TABLE_DB}\`.\`<表名>\` SELECT ...`,
};

function systemPrompt(sinkType: string): string {
  const sink = SINK_GUIDE[sinkType] || SINK_GUIDE.s3;
  return `你是 Apache Flink SQL 专家,为"Kingfisher 大数据治理平台"的实时计算模块生成可直接运行的 Flink SQL(Flink 1.20,Amazon Managed Service for Apache Flink)。

【固定的源表】事件来自 Kinesis 流,字段只有 region(STRING,区域)、amount(DOUBLE,金额)、ts(TIMESTAMP(3),事件时间)。源表 DDL 必须原样使用(含占位符与 watermark):
CREATE TABLE orders_src (
  region STRING,
  amount DOUBLE,
  ts TIMESTAMP(3),
  WATERMARK FOR ts AS ts - INTERVAL '5' SECOND
) WITH (
  'connector'='kinesis', 'stream.arn'='\${SOURCE_STREAM_ARN}', 'aws.region'='\${REGION}',
  'source.init.position'='TRIM_HORIZON', 'format'='json'
);

【本次目标 sink】${sink}

【硬性规则】
1. 只输出 Flink SQL,多条语句用英文分号 ; 分隔;不要任何解释、不要 markdown 代码围栏。
2. 必须且只能包含一条 INSERT INTO(写入 sink);源/中间用 CREATE TABLE/VIEW。
3. 事件时间窗口聚合用 TUMBLE/HOP/CUMULATE TVF,且【必须】GROUP BY window_start, window_end 再带其它维度,否则 append-only sink 会拒绝。
4. 占位符(\${SOURCE_STREAM_ARN}/\${REGION}/\${OUTPUT_PATH}/\${MYSQL_URL}/\${MYSQL_USER}/\${MYSQL_PASSWORD}/\${TABLE_BUCKET_ARN}/\${S3TABLE_DB})必须原样保留,不要替换成真实值。
5. sink 表的列要与 SELECT 的列在数量/顺序/类型上一致;时间列用 TIMESTAMP(3),计数用 BIGINT,金额用 DOUBLE。
6. 不能使用平台未提供的字段(只有 region/amount/ts)。`;
}

function stripFences(text: string): string {
  let t = (text || "").trim();
  // 去掉 ```sql ... ``` 围栏(模型偶尔忽略指令时的兜底)。
  t = t.replace(/^```[a-zA-Z]*\s*/m, "").replace(/```\s*$/m, "").trim();
  return t;
}

export interface AiSqlResult {
  sql: string;
  /** 实际调用的模型(与 `_meta.modelId` 必须相等 —— ACCEPTANCE M14 回归断言) */
  model: string;
  // 来源层(供路由组 `_meta.modelSource`)
  modelSource: SourceLayer;
  usage: { inputTokens: number; outputTokens: number };
  // cookbook 方言校验报告(生成后已纠正/待提示的违规),供前端回显。
  dialect?: { fixed: { ruleId: string; title: string }[]; violations: { ruleId: string; title: string; rule: string; severity: string }[] };
}

export async function generateFlinkSql(prompt: string, sinkType = "s3"): Promise<AiSqlResult> {
  // (生成前引导):注入 cookbook 的 Flink 方言硬规则 + 验证过的窗口/CDC 范式,让模型照正确方言写。
  // seed 零 IO;admin 配方首次一次 DynamoDB(之后缓存);guard 纯 CPU——都不加剧 60s 墙。
  let systemText = systemPrompt(sinkType);
  try {
    const slice = await retrieve("flink", { keywords: prompt, topK: 3 });
    const cookbookText = sliceToPromptText(slice);
    if (cookbookText) systemText += `\n\n${cookbookText}`;
  } catch { /* cookbook 不可用静默降级,不阻断生成 */ }

  // modelId 每次调用求值(flink-sql),经 invokeConverse 退避/降级。
  const inv = await invokeConverse("flink-sql", undefined, bedrock, (modelId) =>
    new ConverseCommand({
      modelId,
      system: [{ text: systemText }],
      messages: [{ role: "user", content: [{ text: `需求:${prompt}\n\n请生成对应的 Flink SQL。` }] }],
      inferenceConfig: { maxTokens: 1600, temperature: 0 },
    })
  );
  const resp = inv.response;
  const text = (resp.output?.message?.content || []).map((b) => ("text" in b ? b.text : "")).join("").trim();
  const rawSql = stripFences(text);
  // (生成后校验,安全网):用同源方言规则校验/纠正模型偶发违规(Flink 是 SQL 引擎,可正则 fix)。
  const g = guard("flink", rawSql);
  return {
    sql: g.code,
    // 隐藏读取方(DESIGN §1.2 #8b / SPEC §3.3)一并改为**实际调用**的模型,流到 ai-sql/route.ts 审计 + 信封。
    model: inv.usedModelId,
    modelSource: inv.usedSource,
    usage: { inputTokens: resp.usage?.inputTokens || 0, outputTokens: resp.usage?.outputTokens || 0 },
    dialect: { fixed: g.fixed, violations: g.violations },
  };
}
