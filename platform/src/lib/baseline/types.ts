// 智能基线 / SLA 预测:类型定义(单一事实源)。

export interface DurationStats {
  p50: number;
  p90: number;
  p95: number;
  ewma: number;
  stdev: number;
  samples: number;
  windowDays: number;
}

/**
 * **一个执行区的基线**。同一个任务在两个区的运行特征本来就不同(数仓规格、数据量、网络),
 * 把两个区的 run 混进一条基线,p90 是一个**两个分布的混合体** —— 用它做 SLA 预测,
 * 结果是「两个区都不准」,而界面上完全看不出为什么。用户 2026-09-10 的原话是
 * 「基线行按任务聚合、跨区混在一起」。
 */
export interface TargetBaseline {
  durationSec: DurationStats;
  startDelay: { p50Sec: number; p90Sec: number };
  punctuality: { onTimeRate: number; samples: number };
  successRate: { value: number; samples: number };
  lowConfidence: boolean;
}

export interface BaselineRow {
  pk: string; // "baseline#<projectId>"
  taskId: string;
  projectId: string;
  taskType?: string;
  taskName?: string;
  /**
   * 🔴 **全部区合计** —— 只为「还没有区维的旧路径 + 存量行回落」留着。
   * region-sensitive 的地方(SLA 预测 / 基线表 / 基线偏离 Top)一律走 `baselineFor(row, targetId)`,
   * 门禁 `baseline-target-guard` 钉住这一点。**不要**在新代码里直接读它。
   */
  durationSec: DurationStats;
  startDelay: { p50Sec: number; p90Sec: number }; // 调度触发→实际开始的排队延迟(ETA 用)
  punctuality: { onTimeRate: number; samples: number };
  successRate: { value: number; samples: number };
  /**
   * 每个执行区一份。
   * 🔴 为什么放进同一行而不是拆成「一行一区」:这张表的排序键就叫 `taskId`,要拆行只能把
   * `taskId#targetId` 塞进那个键 —— 本仓在复合键上踩过的坑(R10 审查「复合键必要不充分」)
   * 说明那会让「taskId」这个字段名开始说谎,而每一个按 taskId 取行的调用点都要跟着改。
   */
  byTarget?: Record<string, TargetBaseline>;
  /** 这个任务在哪些区跑过(= `byTarget` 的键;字段名对齐平台 B 类绑定,`filterRowsByScope` 直接可用) */
  targets?: string[];
  learnedAt: string;
  algoVersion: string;
  lowConfidence: boolean; // 样本 < MIN_SAMPLES → 冷启动,不触发时长早警
}

export type SlaTargetType = "relative" | "absolute";
export type RiskLevel = "green" | "yellow" | "red";

export interface SlaTarget {
  taskId?: string;
  workflowId?: string;
  scope: "task" | "workflow";
  type: SlaTargetType;
  offsetMinFromTrigger?: number; // relative:触发后 N 分钟为承诺完成时刻
  clockTime?: string; // absolute:"02:00"
  tz?: string;
}

export interface SlaPrediction {
  runId: string;
  etaAt: string;
  willBreach: boolean;
  riskLevel: RiskLevel;
  criticalPathNode?: string;
  slaAt: string;
  marginMin: number; // 余量(分钟);负=已预测破线
  at: string; // 预测时刻
}

export interface SlaRow {
  pk: string; // "sla#<projectId>"
  /**
   * 这条 SLA 管的对象跑在哪些区。
   * 🔴 **从绑定对象(任务 / 工作流)的 `targets[]` 派生**,不让用户在 SLA 表单里另填一次:
   * 两处各填一次必然漂,而漂了的后果是「SLA 挂在一个那个区根本不跑的任务上」——
   * 永远不破线,于是看起来一切正常。
   */
  targets?: string[];
  slaId: string; // ULID
  projectId: string;
  name: string;
  enabled: boolean;
  version: number;
  target: SlaTarget;
  warnLeadMin: number; // 提前多少分钟预测破线即告警
  channelIds: string[]; // 复用通道
  lastPrediction?: SlaPrediction;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}
