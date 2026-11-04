// 模块 44 — Copilot 规划-执行引擎:类型定义(单一事实源 / 代码级顶层设计)。
//
// 语义:用户一句话诉求(「帮我把广告 ROI 算出来」)→ 规划大脑(Strands 只读 agent)发现现状 →
// 产出一个「执行计划(plan)」,由 N 个「异构步骤(step)」组成(建同步 / 跑 EMR / 查仓 ...),
// 步骤间可有依赖(dependsOn)。这是补数(backfill)plan/instance 模型的【泛化】:
//   补数:一个计划 = [目标 × 日期范围] 机械展开成同构实例(每个都是"某日期重算")。
//   Copilot:一个计划 = 规划大脑产出的异构步骤序列(每步类型不同、入参不同)。
// 复用补数的 tick/claim/reconcile 幂等推进内核(见 runner),泛化点集中在"步骤类型"这一维。
//
// 安全铁律(见 docs/design/44-unified-copilot/PLAN-EXECUTE-DESIGN.md §1、§7):
//  - 规划大脑永远【无执行工具】,只产计划 / 建 draft(能力面根除,与手写实现同等安全)。
//  - 每步执行前必须【人工确认】——状态机新增 awaiting-confirmation / confirmed 两态(补数没有)。
//  - 本期 L2:autoExecute=false,引擎不代执行,只给"去哪页点"的 execHint;L3 留接口默认关。
//  - 执行落 run 一律 triggeredBy="copilot"(在线隔离,同补数;消费端排除见 baseline/finops)。

// ── 步骤类型:每种对应一个 StepHandler(见 step-handlers/registry),映射到已验证存在的真实 API ──
//  sync-glue    : 建 Glue 批同步任务 draft → (L3)start → glue-status 回收
//  sync-dms     : 建 DMS 实时同步任务 draft → (L3)start-realtime → realtime-status 回收
//  redshift-sql : 建 Redshift SQL 离线作业 draft → (L3)run → runs 回收
//  glue         : 建 Glue PySpark 离线作业 draft → (L3)run → runs 回收
//  emr          : 建 EMR Serverless 作业 draft(需 network) → (L3)run → runs 回收
//  query-only   : 直接查(只读 SELECT,无需建资源);本期仅作"计划终点"占位,执行永远由人在查询页做
export type StepType =
  | "sync-glue"
  | "sync-dms"
  | "redshift-sql"
  | "glue"
  | "emr"
  | "query-only";

export const STEP_TYPES: readonly StepType[] = [
  "sync-glue",
  "sync-dms",
  "redshift-sql",
  "glue",
  "emr",
  "query-only",
] as const;

export function isStepType(v: unknown): v is StepType {
  return typeof v === "string" && (STEP_TYPES as readonly string[]).includes(v);
}

// ── 状态机(补数状态机 + 新增 gated 确认态)──
// 补数只有:pending | blocked | running | succeeded | failed | skipped。
// Copilot 在其前面【新增两态】,把"AI 永不擅自执行"落到状态机层:
//   awaiting-confirmation : 依赖满足、等用户点"确认这步"(补数的 pending 之前多出的一环)
//   confirmed             : 用户已确认。L2 下停在此(引擎不推进,展示 execHint);L3 下引擎才 claim。
// 关键门控:tick 的 claim 只允许 status=confirmed 的步骤 confirmed→pending→running;
// awaiting-confirmation 即使依赖满足也【绝不自动推进】。
export type StepStatus =
  | "awaiting-confirmation" // 【新增】等人工确认
  | "confirmed" // 【新增】已确认(L2 停此;L3 引擎推进)
  | "blocked" // 上游未全部成功,阻塞
  | "pending" // 已确认且依赖满足,待 claim(L3)
  | "running" // 执行中(L3)
  | "succeeded"
  | "failed"
  | "skipped"; // 上游失败 → 级联跳过

export type PlanStatus =
  | "planned" // 刚产出计划
  | "awaiting" // 有步骤等确认
  | "running" // 有步骤执行中(L3)
  | "paused"
  | "cancelled"
  | "succeeded"
  | "partially-failed";

// 进度聚合:键必须 = 各 StepStatus 名 + total(aggregateProgress 靠 `status in p` 计数,
// 这个命名一致性是硬契约,泛化时绝不能破)。补数是 6 状态,Copilot 是 8 状态。
export interface PlanProgress {
  total: number;
  "awaiting-confirmation": number;
  confirmed: number;
  blocked: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

// ── 计划主档(泛化补数 BackfillPlanRow)──
export interface CopilotPlanRow {
  pk: string; // "copilot#<projectId>"
  planId: string; // ULID
  projectId: string;
  createdBy: string;
  version: number; // 乐观锁(复用 setPlanStatus 模式)
  prompt: string; // 用户原始诉求「帮我算广告 ROI」
  summary: string; // 规划大脑对计划的一句话说明
  // 规划大脑的"发现"结论(现状摘要:数据在哪/有无现成指标/同步了没),给用户看的透明化依据。
  findings?: string;
  // L2=false(只指引,引擎不代执行);L3=true(引擎代执行)。默认 false,翻开关是显式配置+用户批准。
  autoExecute: boolean;
  /**
   * @kf-batch 50-WP4quater-reads(工单 SC-17)—— 这个计划**面向哪个执行区**。
   * 🔴 计划最终会建出真作业(同步 / 离线 / Flink),那些作业要在某个区跑 ⇒
   * 「这个区有哪些计划要落地」是运维要看的东西,而计划行上原来一个区维都没有。
   * 缺省 = 主控区(与改动前逐字节等价);字段名对齐平台 B 类绑定 ⇒ `filterRowsByScope` 直接可用。
   */
  targets?: string[];
  status: PlanStatus;
  progress: PlanProgress;
  createdAt: string;
  updatedAt: string;
}

// ── 步骤(泛化补数 BackfillInstanceRow —— 核心泛化点:date/nodeId → 异构 stepType+params)──
export interface CopilotStepRow {
  planId: string; // PK
  stepId: string; // SK(计划内唯一:zero-pad 序号,如 "0001",保证 sk 稳定排序 = 展示顺序)
  seq: number; // 步骤序号(展示用)
  // —— 异构步骤描述 ——
  stepType: StepType;
  title: string; // 给用户看「创建 MySQL→Redshift 同步任务」
  rationale: string; // 为什么需要这步(规划大脑给的理由)
  params: Record<string, unknown>; // 每步异构入参(建 draft 用;字段见各 StepHandler)
  // —— 执行指引(L2)/ 执行定位(L3)——
  execHint?: { page: string; action: string }; // L2:「去 /sync 页点启动」
  draftResourceId?: string; // create-tools 建出的 draft 资源 id(建后回填)
  draftResourceKind?: string; // draft 资源种类(sync-task / etl-job / engine-job),深链用
  // —— 复用补数的通用推进字段(零改动语义)——
  dependsOn: string[]; // 前置步骤 stepId(依赖链,复用 resolveBlocked)
  status: StepStatus;
  runTaskId?: string; // 长任务定位(reconcile 读 bgp-task-runs 终态)
  runId?: string;
  runToken?: string; // 每次 claim 生成新 ULID,防僵尸执行者覆盖
  attempts: number;
  lastError?: string;
  startedAt?: string;
  finishedAt?: string;
  ttl: number; // epoch 秒,90 天自动过期
}

// ── 规划大脑产出的步骤规格(未落库;planner 的 structuredOutput → 落库成 CopilotStepRow)──
// 注意:规划大脑只产"想做什么"(stepType/title/rationale/params/dependsOn),
// 不产 status/runToken/attempts 等运行时字段(落库时由引擎补)。dependsOn 用【seq 引用】
// (规划时还没 stepId),落库时翻译成 stepId。
export interface StepSpec {
  seq: number;
  stepType: StepType;
  title: string;
  rationale: string;
  params: Record<string, unknown>;
  dependsOnSeq: number[]; // 引用其它步骤的 seq(落库时翻译成 stepId)
}

// 规划大脑产出的完整执行计划(structuredOutput 的 TS 形态;Zod schema 见 plan-schema.ts)。
export interface PlanSpec {
  summary: string; // 计划一句话说明
  findings: string; // 发现阶段的现状结论
  steps: StepSpec[]; // 异构步骤(可为空 = 无需执行,直接答)
}

// 计划创建入参(API 层构造,交给 planner)。
export interface CreatePlanInput {
  projectId: string;
  createdBy: string;
  prompt: string;
}

// ── 状态机常量(供 runner / service / UI 共用,避免魔法字符串)──
// 终态:不再推进的步骤状态。
export const TERMINAL_STEP_STATUSES: readonly StepStatus[] = [
  "succeeded",
  "failed",
  "skipped",
] as const;

// 活跃态:计入"计划仍在进行"的步骤状态(derivePlanStatus 用)。
export const ACTIVE_STEP_STATUSES: readonly StepStatus[] = [
  "awaiting-confirmation",
  "confirmed",
  "blocked",
  "pending",
  "running",
] as const;

// 每类步骤的执行超时天花板(ms):引擎未回写终态则判超时 failed,绝不永久卡 running。
// 复用补数 INSTANCE_CEILING_MS 思想,但按步骤类型分级(EMR 冷启动久,给足;查询快)。
export const STEP_CEILING_MS: Record<StepType, number> = {
  "sync-glue": 2 * 3600 * 1000, // Glue 批同步,2h
  "sync-dms": 2 * 3600 * 1000, // DMS 全量+CDC 起步,2h
  "redshift-sql": 1 * 3600 * 1000, // Redshift SQL,1h
  glue: 2 * 3600 * 1000, // Glue PySpark,2h
  emr: 3 * 3600 * 1000, // EMR Serverless(含冷启动),3h
  "query-only": 10 * 60 * 1000, // 只读查询,10min
};

// 在线隔离标记:Copilot 执行落 run 打此标记(与补数 "backfill" 并列)。
// 【硬约束·消费端排除已落地(模块47 P4.0,2026-07-24)】此值已同步排除于:
//   · baseline/learn.ts(基线学习,SLA/时长预测)—— r.triggeredBy !== COPILOT_TRIGGERED_BY
//   · finops/anomaly.ts(成本异常检测)—— r.triggeredBy === COPILOT_TRIGGERED_BY continue
// 二者均 import 本常量(单一定义,零裸写字符串)。若未来新增其它消费端(如新监控口径),须同步排除。
// 【赋值点】Copilot 执行落 run 时写入 —— 现属 L3 执行档(autoExecute=true)的 handler.execute,
//   L2 下 execute 段是死代码(executor.ts:16),故本常量当前只被消费端排除引用、暂无生产赋值(诚实标注:
//   排除已就位,等 L3 真代执行落 run 即生效,不留隐雷)。
export const COPILOT_TRIGGERED_BY = "copilot" as const;
