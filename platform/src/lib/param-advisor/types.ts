// 参数辅助智能顾问 — 全部公共契约(通道无关入参 → 推荐清单 + 一块通道特定 prefill)。
//
// 定位([[full-param-parity-with-managed-consoles]]):平台把托管服务(Glue/Flink-MSAF/DMS)的
// console 参数齐全暴露给用户;本顾问在其上做【AI 辅助填写】——给推荐值+理由+置信度,
// 参数一个不少、一个不藏,AI 是辅助填写而非省略填写。
//
// 架构(平台标准 docs/design/28-agentcore-standard/DESIGN.md,第二个标准实现):
//   确定性核心 = catalog(参数目录) + heuristics(启发式推荐引擎,纯函数) + history-probe(只读探测)
//   L3 = Bedrock Converse(AgentCore Runtime 或进程内回退)负责人话解释与多轮细化。
// 推荐值恒由确定性引擎给出(模型不自行编参数值)——同网络顾问"裁决恒由 L2"的反幻觉支柱。

// ───────────────────────── 入参:消费方描述"在配什么" ─────────────────────────

// ParamChannel + ParamDef 已下沉 @paramadvisor/core(./core/types)——core 须独立
// 编译成 CJS 给容器 import。此处反向 re-export,消费方(本文件 + prompt/heuristics/skills-handler)
// 路径与用法逐字不变(单一定义在 core,杜绝"两个 ParamChannel"类型漂移)。
export type { ParamChannel, ParamDef } from "./core/types";
import type { ParamChannel } from "./core/types";

// 工作负载特征——推荐引擎的输入。全部可选:缺失时引擎用保守默认并生成 questions 追问。
export interface WorkloadProfile {
  tableCount?: number; // 同步表数量(sync 表单已知 sourceTables.length)
  estimatedDataGB?: number; // 预估数据总量 GB(用户填或追问)
  sourceType?: string; // mysql / postgres / kinesis / ...
  targetType?: string; // s3-tables / redshift / both
  syncMode?: string; // full / incremental / realtime
  writeFrequency?: "low" | "medium" | "high"; // 写入频率(Iceberg 快照/合并参数用)
  hasLobColumns?: boolean; // 源表含 LOB(TEXT/BLOB)列(DMS LOB 模式用)
  kinesisShards?: number; // Kinesis 源 shard 数(Flink 并行度锚点)
  productionGrade?: boolean; // 生产级(HA/校验/重试从严)
  joinKey?: string; // 常用 join 列(Redshift DISTKEY 候选)
  timeColumn?: string; // 常用时间过滤列(Redshift SORTKEY 候选)
}

// 已有作业引用——推荐前先查运行历史,让建议有实据(如按 P90 时长定超时)。
export interface JobRef {
  kind: "glue-job" | "flink-app" | "dms-task";
  id: string; // Glue JobName / MSAF ApplicationName / DMS ReplicationTaskArn(或 identifier)
}

// 顾问入口请求——消费方(三个表单)填这个。
export interface ParamAdviceRequest {
  channel: ParamChannel;
  workload?: WorkloadProfile;
  current?: Record<string, unknown>; // 用户当前表单值(引擎据此算 diff,只报"建议改"的)
  jobRef?: JobRef; // 已有作业 → 查历史提升建议质量
  region?: string;
  conversationId?: string; // 多轮记忆键(消费方生成;省略则单轮)
  userMessage?: string; // 自由文本轮次("成本优先"/"这表有 2 亿行"…)
}

// ───────────────────────── 参数目录(catalog.ts 的条目形态) ─────────────────────────
// ParamDef 定义已下沉 ./core/types(见文件顶部 re-export)——单个参数目录定义,
// 对齐托管服务 console 创建页([[full-param-parity]]的机器可读化)。

// ───────────────────────── 历史事实(history-probe.ts 产物,只读) ─────────────────────────

export interface GlueRunStats {
  runs: number; // 统计窗口内运行次数
  successRate: number; // 0..1
  avgDurationMin: number | null;
  p90DurationMin: number | null;
  maxDurationMin: number | null;
  lastErrors: string[]; // 最近失败摘要(截断)
  currentWorkerType?: string;
  currentNumberOfWorkers?: number;
  currentGlueVersion?: string;
  currentTimeoutMin?: number;
}

export interface FlinkAppStats {
  status?: string; // RUNNING / READY / ...
  parallelism?: number;
  parallelismPerKPU?: number;
  autoScalingEnabled?: boolean;
  runtimeVersion?: string;
}

export interface DmsTaskStats {
  status?: string;
  migrationType?: string;
  tablesLoaded?: number;
  tablesErrored?: number;
  instanceClass?: string; // 现有复制实例规格(DescribeReplicationInstances)
  fullLoadProgressPercent?: number;
}

// 探测总产物。degraded/missing 支撑优雅降级(IAM 拒/资源不存在时不崩,推荐退回纯启发式)。
export interface HistoryFacts {
  kind: JobRef["kind"] | "none";
  glue?: GlueRunStats;
  flink?: FlinkAppStats;
  dms?: DmsTaskStats;
  degraded: boolean;
  missing: string[]; // 失败原因(如 "glue:GetJobRuns denied")
  capturedAt: string;
}

// ───────────────────────── 出参:推荐清单 + 通道 prefill ─────────────────────────

export interface ParamRecommendation {
  key: string; // 与 ParamDef.key 一致(消费方按 key 回填)
  label: string;
  value: unknown; // 推荐值(恒由确定性引擎给出)
  unit?: string;
  reason: string; // 为什么(引用规则/历史事实)
  confidence: number; // 0..1
  currentValue?: unknown; // 用户当前值(有 current 时)
  changed: boolean; // 推荐值 ≠ 当前值(UI 高亮"建议改")
  basedOnHistory?: boolean; // true=有运行历史实据(置信度更高)
}

// 通道特定预填——消费方按 channel 取用,一键填进自己的表单。
export type ParamPrefill =
  | { channel: "glue-etl"; glueConfig: { workerType: string; numberOfWorkers: number; glueVersion: string; timeoutMinutes: number; maxRetries?: number; executionClass?: string } }
  | {
      channel: "glue-sync";
      retryCount: number;
      timeout: number; // 秒
      glueConfig?: { workerType?: string; numberOfWorkers?: number; timeoutMinutes?: number; maxRetries?: number };
      icebergConfig?: { snapshotRetentionDays: number; maxSnapshots: number; compactionMinutes: number };
      redshiftConfig?: { distStyle: string; distKey?: string; sortKeys?: string };
    }
  | {
      channel: "flink";
      parallelism: number;
      parallelismPerKPU: number;
      autoScalingEnabled: boolean;
      checkpointIntervalMs?: number;
      minPauseBetweenCheckpointsMs?: number;
      logLevel?: string;
      metricsLevel?: string;
      snapshotsEnabled?: boolean;
    }
  | {
      channel: "dms";
      retryCount: number;
      timeout: number;
      dmsSettings?: Record<string, unknown>; // DMS 任务设置(targetTablePrepMode/lobMode/batchApply/validation/…)
      redshiftConfig?: { distStyle: string; distKey?: string; sortKeys?: string };
      // 复制实例规格属基建层(realtime-stack),平台表单无此字段——推荐仅展示,不入 prefill。
    }
  | {
      // EMR Serverless Spark 作业:spec 形态对齐 lib/engines/emr/spec.ts EmrSpec,
      // 消费方(EMR 提交表单)按此一键回填 driver/executor 规格与 executor 数。
      channel: "emr";
      spec: {
        releaseLabel: string;
        architecture: string;
        driver: { cpu: string; memory: string; disk?: string };
        executor: { cpu: string; memory: string; disk?: string };
        executorCount: number;
      };
    };

// 顾问最终产物——消费方消费这个。
export interface ParamAdvice {
  recommendations: ParamRecommendation[];
  prefill?: ParamPrefill; // 一键预填(有可回填项时)
  reasoning: string; // 人话解释(大模型生成;降级时为确定性文本)
  questions?: string[]; // 缺关键特征时要问用户的(如数据量级)
  historyFacts?: HistoryFacts | null; // 运行历史实据(有 jobRef 时)
  confidence: number; // 0..1(整体)
  usage?: { inputTokens: number; outputTokens: number };
  llmAvailable?: boolean; // false=大模型降级,结果为确定性兜底
}
