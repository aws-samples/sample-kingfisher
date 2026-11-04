// FinOps 模块内常量(单一事实源)。
// 隔离红线:表名只在本模块登记,不动共享的 lib/aws/dynamodb.ts TABLES。

export const FINOPS_TABLES = {
  COST_DAILY: "bgp-cost-daily",
  COST_RUNS: "bgp-cost-runs",
  BUDGETS: "bgp-budgets",
} as const;

// L1 大盘服务分类:底座(平台常驻)/引擎(工作负载)/其他。
// key = Cost Explorer SERVICE 维度返回的服务名(实测值,勿凭记忆改)。
export const SERVICE_CATEGORY: Record<string, "base" | "engine"> = {
  // 平台底座(常驻,与任务量无关)
  "Amazon Managed Workflows for Apache Airflow": "base",
  "Amazon OpenSearch Service": "base",
  "Amazon Elastic Container Service": "base",
  "Amazon Relational Database Service": "base",
  "Amazon Elastic Load Balancing": "base",
  "Amazon Virtual Private Cloud": "base",
  "AWS CloudTrail": "base",
  "AWS WAF": "base",
  "Amazon GuardDuty": "base",
  "AWS Key Management Service": "base",
  "AWS Secrets Manager": "base",
  "Amazon CloudFront": "base",
  "AmazonCloudWatch": "base",
  "EC2 - Other": "base", // NAT 网关/EBS 等 VPC 附属
  // 计算/查询引擎(随工作负载伸缩,可归因到任务)
  "AWS Glue": "engine",
  "Amazon EMR": "engine",
  "EMR Serverless": "engine",
  "Amazon Athena": "engine",
  "Amazon Redshift": "engine",
  "AWS Database Migration Service": "engine",
  "Amazon Kinesis": "engine",
  "Amazon Managed Service for Apache Flink": "engine",
  "Amazon Kinesis Analytics": "engine",
  "Amazon Simple Storage Service": "engine",
  "AWSDevOpsAgent": "engine",
  "Amazon Bedrock": "engine",
};

export function categorizeService(service: string): "base" | "engine" | "other" {
  return SERVICE_CATEGORY[service] ?? "other";
}

// L1 服务日成本行的 pk **版本前缀** —— 读写两侧的唯一作者(store.ts 的 `costDailyPk` 只认它)。
// 🔴 为什么要换 pk 而不是在原 `cost#<month>` 里加行:原分区里同时躺着两种形状的行 ——
//    ① 落 REGION 分组之前的**账号级服务合计**(sk 两段)② 此后的按区明细(sk 三段);
//    两者对同一笔钱各记一遍,任何「把这个 pk 求和」的读法都会**算两遍**。做法是采完再删旧行,
//    而合同(§④)定的是「**读侧只读 v2、旧行不删**」:换前缀后旧分区
//    根本不在任何读路径上,与其靠「删得干不干净」保证不混计,不如让混计**结构上读不到**。
// 回滚 = 把这里改回 `cost#`(旧分区未被删除,数据仍在)。
export const COST_DAILY_PK_PREFIX = "costv2#";
/** 已停用的旧前缀 —— 只给判据用(负向:读侧绝不许再碰它)。 */
export const COST_DAILY_LEGACY_PK_PREFIX = "cost#";

/**
 * v2 首次采集 / 手动回填的窗口:**近 30 天,且至少回到上月 1 日**。
 * 🔴 只回 30 天不够:区卡片的「环比」= 本月累计 vs **上月同期**(上月 1 日 .. 同日),
 *    月中上线时上月同期最早可到 ~41 天前;回不到那里 ⇒ 上线第一个月每张卡都是「较上月 +∞」。
 */
export const BACKFILL_MIN_DAYS = 30;

// 采集水位 meta item 的键(存于 bgp-cost-daily 表内,与日成本行共表不共分区)。
export const WATERMARK_PK = "costmeta";
export const WATERMARK_SK = {
  // 🔴 v2 用**新水位键**:沿用旧键的话,升级后旧水位仍是新鲜的
  // ⇒ 大盘不会触发采集,而 v2 分区是空的 ⇒ 用户看到「暂无成本数据」直到 6 小时后。
  // 新键缺失 = v2 从未采过 ⇒ 大盘读路径触发后台采集,采集器自动走回填窗口(collector.ts)。
  // 旧键 `watermark#ce-daily` 留在表里不删(回滚读侧时它仍可用)。
  CE_DAILY: "watermark#ce-daily-v2", // L1 CE 采集(值=最后采集完成的 ISO 时刻)
  RUN_SWEEP: "watermark#run-sweep", // L3 归因扫描(值=已扫过的 finishedAt 上界)
} as const;

// 数据新鲜度:页面加载发现水位落后超过该时长 → 后台 detached 触发采集。
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

// L3 归因扫描单次上界(防长尾扫描拖垮请求;水位机制保证多次触发最终追平)。
export const SWEEP_PAGE_LIMIT = 200;

// run 级成本记录 TTL(与表定义一致,180 天)。
export const COST_RUN_TTL_DAYS = 180;

// 异常检测参数(照 43-B:MAD k=3,冷启动最小样本 7)。
export const ANOMALY_MAD_K = 3;
export const ANOMALY_MIN_SAMPLES = 7;
