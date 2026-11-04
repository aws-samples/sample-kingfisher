// FinOps 数据类型(全模块单一事实源)。

// ── L1 服务日成本 ──────────────────────────────────────────────

export interface CostDailyRow {
  pk: string; // "costv2#<yyyy-MM>"(旧分区 "cost#<yyyy-MM>" 已不在读路径上)
  sk: string; // "<yyyy-MM-dd>#<service>#<region>"
  date: string; // yyyy-MM-dd
  service: string; // CE SERVICE 维度原文
  category: "base" | "engine" | "other";
  amountUsd: number;
  collectedAt: string;
  /**
   * CE 的 **REGION** 维度原文(如 `us-east-1`;全局服务如 Tax / Support / Route 53 回 `global` / `NoRegion`)。
   *
   * 🔴 **必填**(原为可选):v2 分区里每一行都按区采,
   * 「没有 region 的行」只存在于旧分区,而旧分区已不在任何读路径上。留成可选 = 给「静默合法默认值」
   * 留了个口子(读侧各写一遍 `r.region || ""` 去猜它是什么)。全局服务用 CE 自己的字面量,不留空。
   */
  region: string;
}

/** CE 回给全局服务(不属于任何区)的 REGION 字面量 —— 判「无区域归属」的唯一处。 */
export const NO_REGION_LITERALS: ReadonlySet<string> = new Set(["NoRegion", "global"]);

export function isRegionlessCost(region: string): boolean {
  return NO_REGION_LITERALS.has(region.trim());
}

/**
 * 大盘第一层的 **region 卡片**(O3a,INTERACTION §3.2)。
 * 🔴 按 **AWS region** 分组,**不是** target 归因:CE 的维度里没有「执行环境」,同区两套环境的钱分不开。
 */
export interface RegionCostCard {
  region: string;
  /** 本月 1 日 .. 今天 */
  monthToDateUsd: number;
  /** 上月 1 日 .. 上月同日(按天数对齐,月短则截到月末) */
  prevPeriodUsd: number;
  /** (本月累计 − 上月同期) / 上月同期 × 100;上月同期为 0 ⇒ null(不编造「+∞」) */
  momPct: number | null;
}

export interface OverviewSummary {
  monthToDateUsd: number;
  yesterdayUsd: number;
  prevDayUsd: number; // 前天(算环比)
  byCategory: { base: number; engine: number; other: number }; // 本月累计
  topServices: { service: string; category: string; amountUsd: number }[]; // 本月 Top
  dailyTrend: { date: string; base: number; engine: number; other: number; total: number }[];
  watermark: string | null; // CE 采集水位(null=从未采集)
  stale: boolean;
  /**
   * 区卡片(按本月累计降序)。只含**有区归属**的钱;
   * 单区 / 分组视角下只含视角内的区。
   */
  byRegion: RegionCostCard[];
  /** 本月无区域归属(全局服务)的钱。🔴 不算进任何区卡片,单独一张卡如实报出。 */
  regionlessMonthToDateUsd: number;
}

// ── L3 run 级归因 ──────────────────────────────────────────────

export type CostEngine = "glue" | "emr-serverless" | "athena";

// 引擎计量原始值(折算入参;各引擎只填自己的字段)。
export interface EngineUsage {
  dpuSeconds?: number; // glue
  vcpuHours?: number; // emr(billedResourceUtilization)
  memoryGbHours?: number;
  storageGbHours?: number;
  dataScannedBytes?: number; // athena
}

export interface CostRunRow {
  pk: string; // "taskcost#<taskId>"
  sk: string; // runId
  taskId: string;
  runId: string;
  taskType: string; // task-runs 原 taskType(sync/etl-glue/emr-serverless/…)
  engine: CostEngine;
  usage: EngineUsage;
  costUsd: number;
  priceVersion: string;
  startedAt: string;
  finishedAt: string;
  runStatus: string; // succeeded/failed —— 失败的 run 也烧钱,照记
  triggeredBy?: string; // backfill 的 run 不进异常基线(43-B 硬约束同款)
  // (50 ROADMAP §2octies.17 T1 / SPEC §1.3a S6)
  // 🔴 成本行**继承 run 行的归属章**:成本按 target 归因(O3b)的前提。写侧(sweep)必填;
  //    存量无章行由 `stamp-backfill.ts` 从 run 行回填 —— 绝不由读侧猜 home。
  projectId: string;
  targetId: string;
  ttl: number;
}

export interface TaskCostSummary {
  taskId: string;
  /**
   * 这一行是**哪个执行环境**的运行汇总(O3b)。
   * 🔴 排行按 (taskId, targetId) 分组:同一个任务扇出到两个区,是两行而不是一行 ——
   *    合成一行就看不出「贵的是哪个区」,也和「执行范围」那一列对不上。
   * 取值走 `scalarTargetOf(row, "cost")`(与范围过滤同一条规则;存量无章行归主控区)。
   */
  targetId: string;
  taskName?: string;
  engine: CostEngine;
  runCount: number;
  totalUsd: number;
  avgUsd: number;
  lastRunAt: string;
}

/**
 * 任务成本 Tab 的 KPI「已归因 / 未分摊」按 **region** 对账(O3b)。
 * 未分摊 = region 账单 − Σ该 region 的已归因 run 成本。
 * 🔴 对账粒度只能是 region(CE 只给到 region):同区若有多套执行环境,它们的 run **都**算进这个区的已归因,
 *    哪怕当前视角只选了其中一套 —— 否则另一套的花费会被算成「未分摊」。
 * 🔴 不截断成 0:已归因 > 账单(账单 T+1 迟到时会发生)就如实给负数,界面说明原因。
 */
export interface RegionReconcile {
  region: string;
  /** 参与已归因的执行环境(该区内有 run 的,含视角外的同区环境) */
  targetIds: string[];
  regionCostUsd: number;
  attributedUsd: number;
  unallocatedUsd: number;
}

export interface CostReconcile {
  /** 对账窗口起点(yyyy-MM-dd,含)= 天窗起点;终点 = 今天 */
  windowFrom: string;
  /** 窗口内 v2 账单最早一天;null = 窗口内没有任何账单行(还没采 / 还没回填) */
  billCoverageFrom: string | null;
  byRegion: RegionReconcile[];
  /** run 的执行环境解析不出 region(环境已删 / 注册表读不到)的成本 —— 不猜区,单独报 */
  unresolvedAttributedUsd: number;
}

// ── 异常检测 ──────────────────────────────────────────────────

/**
 * 🔴 异常必须带**它属于哪里**,做成判别联合(A4:非法状态写不出来):
 *   · 任务级 ⇒ `targetId` 必填:基线按 (task, target) 各算各的,两区同任务不互相污染;
 *   · 服务级 ⇒ `region` 必填:账单按 (service, region) 各算各的,同理。
 * 原来是一个可选 `engine` 加一个 `key`,两区同任务的 run 被并进同一条基线 ——
 * 一个区的高成本被另一个区的低成本稀释(漏报),或者一个区的正常值被当成另一个区的突增(误报)。
 */
interface CostAnomalyBase {
  key: string; // taskId 或 service 名
  engine?: string; // task 级:归因引擎族(glue/emr/athena),沉淀知识库用
  displayName: string;
  date: string;
  actualUsd: number;
  baselineUsd: number; // 中位数基线
  deviationX: number; // 偏离倍数
  samples: number;
  incidentRecorded: boolean; // 是否已沉淀 bgp-incidents
  notified: boolean;
}

export type CostAnomaly =
  | (CostAnomalyBase & { scope: "task"; targetId: string })
  | (CostAnomalyBase & { scope: "service"; region: string });

// ── 预算护栏 ──────────────────────────────────────────────────

/**
 * 预算作用域。
 * 新增 `region` 变体:用户 2026-09-10 点名
 * 「『成本大盘』与『预算护栏』仍是全平台合计」。有了它才能**给某个区单独设预算**
 * (「us-west-2 每月不超过 $200」),而不是只能给整个账号设一个总额。
 * 🔴 做成判别联合的新变体而不是给现有变体加个可选 region 字段:后者会让
 * 「account + region」这种自相矛盾的组合写得出来。
 */
export type BudgetScope =
  | { kind: "account" }
  | { kind: "service"; service: string }
  | { kind: "project"; projectId: string }
  | { kind: "region"; region: string };

export interface Budget {
  pk: string; // "budget#<projectId|global>"
  sk: string; // budgetId (ULID)
  budgetId: string;
  name: string;
  scope: BudgetScope;
  monthlyLimitUsd: number;
  channelIds: string[]; // 复用通道
  enabled: boolean;
  // 最近评估快照(detect 时刷新)
  lastEval?: { month: string; spentUsd: number; pct: number; at: string };
  // 已推送的阈值档(dedup:每月每档一次), 形如 "2026-07#80"
  notifiedMarks?: string[];
  version: number; // 乐观锁
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

// ── 优化建议 ──────────────────────────────────────────────────

export interface Advice {
  ruleId: string;
  severity: "info" | "warn" | "high";
  title: string;
  detail: string;
  estMonthlySavingUsd?: number;
  resource?: string;
  /**
   * 这条建议是**哪个区**的资源。
   * 🔴 不带区的成本建议在多区下没法执行:用户看到「删掉这个空转实例」却不知道去哪个区删。
   */
  region?: string;
}
