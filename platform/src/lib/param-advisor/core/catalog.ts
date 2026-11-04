// @paramadvisor/core — 参数目录纯逻辑(5 通道 ParamDef 数组 + 目录文本渲染,零依赖)。
//
// 【core 契约】(照 @genbi/core)零 @/ alias:内部只引 "./types"。原 param-advisor/catalog.ts
// 从 @/lib/etl/worker-types + @/lib/engines/emr/spec import 的常量,在此【内联】——
// 理由:那俩被平台 6-8 处引用,搬进 core 牵连过广;而它们是 AWS 服务客观事实常量(worker 档位/
// EMR 规格),非平台业务逻辑,加新档位频率极低。内联换取"业务参数目录 CATALOG 不再手抄"(消灭
// 容器 CATALOG_TEXT 6401 字手抄的静默漂移——那才是高危副本源)。
//
// 【防漂移】内联值与平台真源的一致性由单测机器守卫(见 __tests__/core-catalog-drift.test.ts):
// 单测同时 import 本文件与 @/lib/etl/worker-types、@/lib/engines/emr/spec,toEqual 比对;
// 真源一旦变动、这里没跟,单测立即红。把"手动同步"升级成"CI 机器断言"。
//
// 原 catalog.ts 反向 re-export 本文件(catalogFor/renderCatalogForPrompt/ParamDef 数组),
// 进程内 3 消费方(prompt/heuristics/skills-handler)API 不变。

import type { ParamChannel, ParamDef } from "./types";

// ── 内联:Glue Worker 规格(源 @/lib/etl/worker-types,AWS 事实常量) ──
// GLUE_WORKER_TYPES 的 value 列表(对齐 Glue console Worker type 全量选项)。
// 【导出仅供漂移守卫单测】(__tests__/core-catalog-drift):与平台真源 toEqual 比对,真源变动这里没跟即红灯。
export const CORE_GLUE_WORKER_VALUES = ["G.1X", "G.2X", "G.4X", "G.8X", "G.12X", "G.16X", "R.1X", "R.2X", "R.4X", "R.8X"];
// Worker 数量上限(AWS 账号级 DPU 配额默认 1000)。
export const CORE_GLUE_MAX_WORKERS = 1000;

// ── 内联:Glue 版本清单与缺省(源 @/lib/sync/glue-version;:缺省取最高、清单允许降版,用户 2026-10-26 拍板) ──
// 【导出仅供漂移守卫单测】真源加了新版本这里没跟即红灯。
export const CORE_GLUE_VERSIONS = ["4.0", "5.0", "5.1", "6.0"];
export const CORE_GLUE_VERSION_DEFAULT = "6.0";

// ── 内联:EMR Serverless 规格(源 @/lib/engines/emr/spec,AWS 事实常量) ──
// 版本列表 = EMR Serverless 控制台顺序,label 用 API 真实值(踩坑:控制台 emr-spark 8.0 → API emr-spark-8.0.0)。
export const CORE_EMR_RELEASE_LABELS = [
  "emr-spark-8.0.0", "emr-7.14.0",
  "emr-7.13.0", "emr-7.12.0", "emr-7.11.0", "emr-7.10.0", "emr-7.9.0",
  "emr-7.8.0", "emr-7.7.0", "emr-7.6.0", "emr-7.5.0", "emr-7.4.0",
  "emr-7.3.0", "emr-7.2.0", "emr-6.15.0",
];
export const CORE_EMR_ARCHITECTURES = ["ARM64", "X86_64"];
export const CORE_EMR_CPU_OPTIONS = ["1 vCPU", "2 vCPU", "4 vCPU", "8 vCPU", "16 vCPU"];
export const CORE_EMR_MEMORY_OPTIONS = ["2 GB", "4 GB", "8 GB", "16 GB", "30 GB", "32 GB", "60 GB", "64 GB", "120 GB"];
export const CORE_EMR_MAX_EXECUTORS = 100;
// EMR_SPEC_DEFAULT 的 core 内联(只取 catalog 用到的字段:releaseLabel/architecture/driver/executor/executorCount)。
export const CORE_EMR_SPEC_DEFAULT = {
  releaseLabel: "emr-spark-8.0.0", // = EMR_DEFAULT_RELEASE
  architecture: "ARM64",
  driver: { cpu: "4 vCPU", memory: "16 GB", disk: "20 GB" },
  executor: { cpu: "4 vCPU", memory: "16 GB", disk: "20 GB" },
  executorCount: 2,
};

// 内部别名(下方 5 个 ParamDef 数组用原短名引用,主体逻辑逐字不变)。
const GLUE_WORKER_VALUES = CORE_GLUE_WORKER_VALUES;
const GLUE_MAX_WORKERS = CORE_GLUE_MAX_WORKERS;
const EMR_RELEASE_LABELS = CORE_EMR_RELEASE_LABELS;
const EMR_ARCHITECTURES = CORE_EMR_ARCHITECTURES;
const EMR_CPU_OPTIONS = CORE_EMR_CPU_OPTIONS;
const EMR_MEMORY_OPTIONS = CORE_EMR_MEMORY_OPTIONS;
const EMR_MAX_EXECUTORS = CORE_EMR_MAX_EXECUTORS;
const EMR_SPEC_DEFAULT = CORE_EMR_SPEC_DEFAULT;

// ── Glue ETL 脚本作业(etl-jobs 页 glueCfg;后端 lib/etl/job-service.ts ensureGlueJob)──
const GLUE_ETL: ParamDef[] = [
  {
    key: "glueConfig.workerType", label: "Worker 类型", consoleRef: "Glue Job > Worker type",
    type: "enum", options: GLUE_WORKER_VALUES, platformDefault: "G.1X",
  },
  {
    key: "glueConfig.numberOfWorkers", label: "Worker 数量", consoleRef: "Glue Job > Requested number of workers",
    type: "number", min: 2, max: GLUE_MAX_WORKERS, platformDefault: 2,
  },
  {
    key: "glueConfig.glueVersion", label: "Glue 版本", consoleRef: "Glue Job > Glue version",
    type: "enum", options: CORE_GLUE_VERSIONS, platformDefault: CORE_GLUE_VERSION_DEFAULT, // 缺省最高、可降版(内联,见文件头)
  },
  {
    key: "glueConfig.timeoutMinutes", label: "作业超时", consoleRef: "Glue Job > Job timeout",
    type: "number", min: 5, max: 2880, unit: "分钟", platformDefault: 60,
  },
  {
    key: "glueConfig.maxRetries", label: "失败重试次数", consoleRef: "Glue Job > Number of retries",
    type: "number", min: 0, max: 10, platformDefault: 0,
  },
  {
    key: "glueConfig.executionClass", label: "执行类", consoleRef: "Glue Job > Execution class",
    type: "enum", options: ["STANDARD", "FLEX"], platformDefault: "STANDARD", // FLEX 弹性容量更省但启动不保时;G.4X 不支持
  },
  {
    key: "glueConfig.jobBookmark", label: "Job bookmark", consoleRef: "Glue Job > Job bookmark(--job-bookmark-option)",
    type: "enum", options: ["job-bookmark-disable", "job-bookmark-enable", "job-bookmark-pause"], platformDefault: "job-bookmark-disable",
  },
  {
    key: "glueConfig.maxConcurrentRuns", label: "最大并发运行数", consoleRef: "Glue Job > Max concurrency",
    type: "number", min: 1, max: 100, platformDefault: 3,
  },
];

// ── 数据同步 Glue 通道(sync 表单;含 Iceberg 目标 + Redshift 目标)──
const GLUE_SYNC: ParamDef[] = [
  { key: "retryCount", label: "调度级重试", consoleRef: "MWAA 调度重试(平台侧)", type: "number", min: 0, max: 5, platformDefault: 2 },
  { key: "timeout", label: "调度级超时", consoleRef: "MWAA 调度超时(平台侧)", type: "number", min: 60, max: 86400, unit: "秒", platformDefault: 3600 },
  {
    key: "glueConfig.workerType", label: "Worker 类型", consoleRef: "Glue Job > Worker type",
    type: "enum", options: GLUE_WORKER_VALUES, platformDefault: "G.1X",
  },
  {
    key: "glueConfig.numberOfWorkers", label: "Worker 数量", consoleRef: "Glue Job > Requested number of workers",
    type: "number", min: 2, max: GLUE_MAX_WORKERS, platformDefault: 2,
  },
  {
    key: "glueConfig.timeoutMinutes", label: "Glue 作业超时", consoleRef: "Glue Job > Job timeout",
    type: "number", min: 5, max: 2880, unit: "分钟", platformDefault: 60,
  },
  {
    key: "glueConfig.maxRetries", label: "Glue 作业重试", consoleRef: "Glue Job > Number of retries",
    type: "number", min: 0, max: 10, platformDefault: 0,
  },
  {
    key: "s3Config.icebergConfig.snapshotRetentionDays", label: "快照保留天数",
    consoleRef: "Iceberg table property: history.expire.max-snapshot-age-ms", type: "number", min: 1, max: 90, unit: "天", platformDefault: 7,
  },
  {
    key: "s3Config.icebergConfig.maxSnapshots", label: "最大快照数",
    consoleRef: "Iceberg table property: history.expire.min-snapshots-to-keep", type: "number", min: 10, max: 1000, platformDefault: 100,
  },
  {
    key: "s3Config.icebergConfig.compactionMinutes", label: "自动合并间隔",
    consoleRef: "S3 Tables maintenance: compaction", type: "number", min: 15, max: 1440, unit: "分钟", platformDefault: 60,
  },
  {
    key: "redshiftConfig.distStyle", label: "分布策略", consoleRef: "Redshift CREATE TABLE DISTSTYLE",
    type: "enum", options: ["auto", "key", "even"], platformDefault: "auto",
  },
  { key: "redshiftConfig.distKey", label: "DISTKEY", consoleRef: "Redshift CREATE TABLE DISTKEY", type: "string", platformDefault: "" },
  { key: "redshiftConfig.sortKeys", label: "SORTKEY", consoleRef: "Redshift CREATE TABLE SORTKEY", type: "string", platformDefault: "" },
];

// ── 实时计算 Flink/MSAF(realtime-compute 页;后端 flink-service.ts ensureApplication)──
const FLINK: ParamDef[] = [
  {
    key: "parallelism", label: "作业并行度", consoleRef: "MSAF > Scaling > Parallelism",
    type: "number", min: 1, max: 64, platformDefault: 1,
  },
  {
    key: "parallelismPerKPU", label: "每 KPU 并行度", consoleRef: "MSAF > Scaling > Parallelism per KPU",
    type: "number", min: 1, max: 8, platformDefault: 1,
  },
  {
    key: "autoScalingEnabled", label: "自动扩缩", consoleRef: "MSAF > Scaling > Automatic scaling",
    type: "boolean", platformDefault: false,
  },
  {
    key: "checkpointIntervalMs", label: "Checkpoint 间隔", consoleRef: "MSAF > Fault tolerance > Checkpoint interval",
    type: "number", min: 1000, max: 3600000, unit: "毫秒", platformDefault: 30000,
  },
  {
    key: "minPauseBetweenCheckpointsMs", label: "Checkpoint 最小暂停", consoleRef: "MSAF > Fault tolerance > Min pause between checkpoints",
    type: "number", min: 0, max: 3600000, unit: "毫秒", platformDefault: 5000,
  },
  {
    key: "logLevel", label: "日志级别", consoleRef: "MSAF > Monitoring > Log level",
    type: "enum", options: ["DEBUG", "INFO", "WARN", "ERROR"], platformDefault: "INFO",
  },
  {
    key: "metricsLevel", label: "指标级别", consoleRef: "MSAF > Monitoring > Metrics level",
    type: "enum", options: ["APPLICATION", "TASK", "OPERATOR", "PARALLELISM"], platformDefault: "APPLICATION",
  },
  {
    key: "snapshotsEnabled", label: "快照(savepoint)", consoleRef: "MSAF > Snapshots",
    type: "boolean", platformDefault: false,
  },
];

// ── 实时同步 DMS 通道(sync 表单 realtime 模式;复制实例属基建层,推荐仅展示)──
const DMS: ParamDef[] = [
  { key: "retryCount", label: "失败重试", consoleRef: "DMS task settings: ErrorBehavior", type: "number", min: 0, max: 5, platformDefault: 2 },
  { key: "timeout", label: "超时", consoleRef: "DMS task: full-load timeout(平台侧监控)", type: "number", min: 60, max: 86400, unit: "秒", platformDefault: 3600 },
  {
    key: "redshiftConfig.distStyle", label: "分布策略", consoleRef: "Redshift CREATE TABLE DISTSTYLE",
    type: "enum", options: ["auto", "key", "even"], platformDefault: "auto",
  },
  { key: "redshiftConfig.distKey", label: "DISTKEY", consoleRef: "Redshift CREATE TABLE DISTKEY", type: "string", platformDefault: "" },
  { key: "redshiftConfig.sortKeys", label: "SORTKEY", consoleRef: "Redshift CREATE TABLE SORTKEY", type: "string", platformDefault: "" },
  {
    key: "dmsSettings.targetTablePrepMode", label: "目标表准备模式", consoleRef: "DMS task settings > Target table preparation mode",
    type: "enum", options: ["DO_NOTHING", "DROP_AND_CREATE", "TRUNCATE_BEFORE_LOAD"], platformDefault: "DO_NOTHING",
  },
  {
    key: "dmsSettings.lobMode", label: "LOB 列模式", consoleRef: "DMS task settings > Include LOB columns",
    type: "enum", options: ["limited", "full", "none"], platformDefault: "limited",
  },
  {
    // Redshift 目标引擎上限 63KB(AWS 校验;平台 DMS 通道目标恒为 Redshift)。
    key: "dmsSettings.lobMaxSizeKB", label: "LOB 截断上限", consoleRef: "DMS task settings > Maximum LOB size",
    type: "number", min: 1, max: 63, unit: "KB", platformDefault: 32,
  },
  {
    key: "dmsSettings.batchApplyEnabled", label: "CDC 批量应用", consoleRef: "DMS task settings > BatchApplyEnabled",
    type: "boolean", platformDefault: false,
  },
  {
    key: "dmsSettings.validationEnabled", label: "数据校验", consoleRef: "DMS task settings > Validation > EnableValidation",
    type: "boolean", platformDefault: false,
  },
  {
    key: "dmsSettings.fullLoadMaxSubTasks", label: "全量并行子任务", consoleRef: "DMS task settings > MaxFullLoadSubTasks",
    type: "number", min: 1, max: 49, platformDefault: 8,
  },
  {
    key: "dmsSettings.commitRate", label: "每批提交行数", consoleRef: "DMS task settings > CommitRate",
    type: "number", min: 1, max: 50000, platformDefault: 10000,
  },
  {
    // 平台表单无此字段(实例由 realtime-stack 建),目录保留供推荐展示("建议升配"类):
    key: "_infra.replicationInstanceClass", label: "复制实例规格(基建层)", consoleRef: "DMS > Replication instance > Instance class",
    type: "enum", options: ["dms.t3.small", "dms.t3.medium", "dms.t3.large", "dms.c5.large", "dms.c5.xlarge"], platformDefault: "dms.t3.small",
  },
];

// ── 离线多引擎 EMR Serverless(提交 Spark 作业。规格常量内联自 lib/engines/emr/spec.ts)──
// key 用点路径对齐 ParamPrefill<emr>.spec 形态;platformDefault 全部取自 EMR_SPEC_DEFAULT(内联真源)。
const EMR: ParamDef[] = [
  {
    key: "spec.releaseLabel", label: "EMR 版本", consoleRef: "EMR Serverless > Application > Release version",
    type: "enum", options: [...EMR_RELEASE_LABELS], platformDefault: EMR_SPEC_DEFAULT.releaseLabel,
  },
  {
    key: "spec.architecture", label: "CPU 架构", consoleRef: "EMR Serverless > Application > Architecture",
    type: "enum", options: [...EMR_ARCHITECTURES], platformDefault: EMR_SPEC_DEFAULT.architecture, // ARM64 更省成本作默认
  },
  {
    key: "spec.driver.cpu", label: "Driver CPU", consoleRef: "EMR Serverless > Spark properties > spark.driver.cores",
    type: "enum", options: [...EMR_CPU_OPTIONS], platformDefault: EMR_SPEC_DEFAULT.driver.cpu,
  },
  {
    key: "spec.driver.memory", label: "Driver 内存", consoleRef: "EMR Serverless > Spark properties > spark.driver.memory",
    type: "enum", options: [...EMR_MEMORY_OPTIONS], platformDefault: EMR_SPEC_DEFAULT.driver.memory,
  },
  {
    key: "spec.executor.cpu", label: "Executor CPU", consoleRef: "EMR Serverless > Spark properties > spark.executor.cores",
    type: "enum", options: [...EMR_CPU_OPTIONS], platformDefault: EMR_SPEC_DEFAULT.executor.cpu,
  },
  {
    key: "spec.executor.memory", label: "Executor 内存", consoleRef: "EMR Serverless > Spark properties > spark.executor.memory",
    type: "enum", options: [...EMR_MEMORY_OPTIONS], platformDefault: EMR_SPEC_DEFAULT.executor.memory,
  },
  {
    // EMR Serverless 磁盘范围 20-200GB。无专用常量,用自由字符串(值自带 "GB");默认取 EMR_SPEC_DEFAULT.executor.disk。
    key: "spec.executor.disk", label: "Executor 磁盘", consoleRef: "EMR Serverless > Spark properties > spark.emr-serverless.executor.disk",
    type: "string", platformDefault: EMR_SPEC_DEFAULT.executor.disk ?? "20 GB",
  },
  {
    key: "spec.executorCount", label: "Executor 数量", consoleRef: "EMR Serverless > Spark properties > spark.executor.instances",
    type: "number", min: 1, max: EMR_MAX_EXECUTORS, platformDefault: EMR_SPEC_DEFAULT.executorCount,
  },
];

const CATALOGS: Record<ParamChannel, ParamDef[]> = {
  "glue-etl": GLUE_ETL,
  "glue-sync": GLUE_SYNC,
  flink: FLINK,
  dms: DMS,
  emr: EMR,
};

export function catalogFor(channel: ParamChannel): ParamDef[] {
  return CATALOGS[channel] || [];
}

// 把目录渲染成 prompt 文本(单一事实源:模型看到的参数 === 引擎推荐的参数)。
export function renderCatalogForPrompt(channel: ParamChannel): string {
  const defs = catalogFor(channel);
  return defs
    .map((d) => {
      const range = d.type === "enum" ? `可选 ${d.options?.join("/")}` : d.type === "number" ? `范围 ${d.min}~${d.max}${d.unit || ""}` : d.type;
      return `- ${d.key}(${d.label},${range},平台默认 ${JSON.stringify(d.platformDefault)},对应 ${d.consoleRef})`;
    })
    .join("\n");
}
