// 生产级补数据:类型定义(单一事实源)。
//
// 语义:一个「补数计划(plan)」把 [目标 × 日期范围] 展开成一组「补数实例(instance)」,
// 每个实例 = 一个(日期,节点)的独立重算。实例的 run 一律以 triggeredBy="backfill" 写
// bgp-task-runs —— 这是「在线隔离」的根:监控成功率/SLA 基线学习都排除 backfill,补数大批量
// 重算绝不污染在线统计(用户反复强调的硬约束)。

// 补数目标:task(单作业,按日期批量)或 workflow(整 DAG,按节点级联)。
//  - task 作用域:kind ∈ etl-job | engine-job | sync-task(各自有 submit 路径,支持 runDate/triggeredBy)。
//    每(日期)一个实例,实例间无依赖(不同业务日期可并行,受并发闸约束)。
//  - workflow 作用域:kind = workflow。每(日期 × DAG 节点)一个实例;cascade=true 时按 DAG 边
//    求同日期上游依赖(dependsOn),同日期内拓扑串行、跨日期可并;cascade=false 时同日期节点全并行。
//    (task 作用域不支持 cascade —— 平台无跨作业依赖登记表,依赖仅存在于 workflow DAG。)
// 仅取类型(编译期擦除;本文件在后台推进泵的 instrumentation 可达面上,不能带运行时依赖)
import type { WorkflowNodeType } from "@/types/workflow";

// 计划行「覆盖哪些执行目标」的字段名。历史上叫 `execTargets`(不是通用的 `targets`)——
// 🔴 不改名:它已经写进存量行,改名就要迁移,而迁移期内两个名字都得读 = 又一处漂移源。
// 改为把这个名字**导出成常量**,让「按区过滤」(`filterRowsByScope`)与「按区计数」
// (`/api/scope/counts`)引同一个,不各自硬编码字符串。
export const BACKFILL_PLAN_BINDING_ATTR = "execTargets";

export type BackfillScope = "task" | "workflow";
// + `sync-task`(glue 通道的同步任务,task 作用域;每个业务日期一个实例,
//   执行走与手动运行同一个启动核心 `lib/sync/start-run.ts`,StartJobRun 带 `--ds=<实例日期>`)。
export const BACKFILL_TARGET_KINDS = ["etl-job", "engine-job", "workflow", "sync-task"] as const;
export type BackfillTargetKind = (typeof BACKFILL_TARGET_KINDS)[number];

/**
 * 各目标类型**强制**的并发上限(null = 由用户在 1..10 里选)—— 穷尽表:加 kind 不登记 ⇒ `tsc` 不过。
 * 🔴 sync-task = 1:同一个同步任务的每个业务日期跑的是**同一个 Glue 作业**(`bgp-sync-<taskId 后 12 位>`),
 *    作业定义不设 MaxConcurrentRuns(= 1)⇒ 并发提交第二个日期必然 ConcurrentRunsExceededException;
 *    更要紧的是每次启动都会**重写同一份脚本、UpdateJob 同一个定义**,并发就是两个日期互相覆盖对方的脚本与参数。
 */
export const BACKFILL_FORCED_CONCURRENCY: Readonly<Record<BackfillTargetKind, number | null>> = Object.freeze({
  "etl-job": null,
  "engine-job": null,
  workflow: null,
  "sync-task": 1,
});

/** 工作流里「按业务日期跑一次同步任务」的节点类型(与 node-registry 的 sync 节点同一个字面量;类型由 WorkflowNodeType 钉住)。 */
const WORKFLOW_SYNC_NODE_TYPE: WorkflowNodeType = "sync";

/**
 * 某个补数目标**实际**强制的并发上限(null = 由用户在 1..10 里选)—— 这是「强制并发」的唯一判定出口,
 * 建计划路由只调它,不自己再比 kind。
 * 🔴 含同步节点的工作流 = 1,理由与 `BACKFILL_FORCED_CONCURRENCY["sync-task"]` **同一条**(这里直接引用那一格,不写第二个数):
 *    工作流补数同日期内靠拓扑串行(cascade),但**跨日期**的两个实例会并发跑**同一个** Glue 作业 ⇒ ConcurrentRunsExceeded /
 *    互相覆盖脚本与参数;不级联时同日期的两个同步节点也可能指向同一个任务。
 */
export function forcedBackfillConcurrency(target: {
  kind: BackfillTargetKind;
  dag?: { nodes?: Array<{ type?: unknown }> } | null;
}): number | null {
  const byKind = BACKFILL_FORCED_CONCURRENCY[target.kind];
  if (byKind !== null) return byKind;
  if (target.kind === "workflow" && (target.dag?.nodes ?? []).some((n) => n?.type === WORKFLOW_SYNC_NODE_TYPE)) {
    return BACKFILL_FORCED_CONCURRENCY["sync-task"];
  }
  return null;
}

export interface BackfillTarget {
  id: string;
  scope: BackfillScope;
  kind: BackfillTargetKind;
  name: string;
  // task 作用域下底层 run 的 taskType(仅展示用);workflow 作用域按节点动态取。
  taskType?: string;
}

export type BackfillGranularity = "day" | "week" | "hour";

export interface BackfillDateRange {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
  granularity: BackfillGranularity;
}

export type PlanStatus =
  | "planned"
  | "running"
  | "paused"
  | "cancelled"
  | "succeeded"
  | "partially-failed";

export interface BackfillProgress {
  total: number;
  pending: number;
  blocked: number;
  running: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export interface BackfillPlanRow {
  pk: string; // "backfill#<projectId>"
  planId: string; // ULID
  projectId: string;
  name: string;
  createdBy: string;
  version: number; // 乐观锁
  target: BackfillTarget;
  dateRange: BackfillDateRange;
  cascade: boolean;
  concurrency: number; // 并发上限(硬闸)
  maxInstances: number; // 天花板(防跑飞)
  // 该计划覆盖的执行目标(展示用;实例上带各自的 targetId)。
  execTargets?: string[];
  status: PlanStatus;
  progress: BackfillProgress;
  createdAt: string;
  updatedAt: string;
}

export type InstanceStatus =
  | "pending"
  | "blocked"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export interface BackfillInstanceRow {
  planId: string; // PK
  sk: string; // "<date>#<nodeId>"
  date: string; // YYYY-MM-DD(hour 粒度时含 -HH)
  nodeId: string;
  nodeName: string;
  nodeType?: string; // workflow 节点类型 sql|python|sync;task 作用域为底层 taskType
  // 该实例在哪个执行目标上重算(见 InstanceSpec.targetId)。
  targetId?: string;
  status: InstanceStatus;
  dependsOn: string[]; // 同计划内前置实例 sk(依赖链)
  // 底层 run 定位:reconcile 时按 (runTaskId, runId) 读 bgp-task-runs 终态回收。
  runTaskId?: string;
  runId?: string;
  runToken?: string; // 每次领取生成新 ULID,防僵尸执行者覆盖
  attempts: number;
  lastError?: string;
  startedAt?: string;
  finishedAt?: string;
  ttl: number; // epoch 秒,90 天自动过期
}

// 计划创建入参(API 层校验后构造)。
export interface CreatePlanInput {
  projectId: string;
  name: string;
  createdBy: string;
  target: BackfillTarget;
  dateRange: BackfillDateRange;
  cascade: boolean;
  concurrency: number;
  maxInstances: number;
  /**
   * 🔴 目标资源**绑定的执行目标集合**(由 API 层用 `bindingTargets()` 从资源行解析,
   * **不接受客户端指定** —— 那等于让人挑"补到哪个区")。缺省/空 ⇒ `["tgt_home"]`。
   */
  execTargets?: string[];
}

// dry-run 预览:展开出的实例规格(未落库)。
export interface InstanceSpec {
  sk: string;
  date: string;
  nodeId: string;
  nodeName: string;
  nodeType?: string;
  dependsOn: string[];
  /**
   * 🔴 **执行目标**(多 region)。实例的维度从 (日期 × 节点) 变成 (日期 × 节点 × **target**) ——
   * 这是**纯追加**:每个实例仍然是"一次独立的异步提交",runner / reconcile / 依赖机制**一行不改**。
   * home(或单绑)时 `sk` **逐字节不变**,存量计划零迁移。
   */
  targetId?: string;
}

/**
 * 补数计划「还没收口」吗(删项目前置校验的口径)—— **穷尽表**:`PlanStatus` 加值不登记 ⇒ `tsc` 不过。
 *
 * 🔴 与 Copilot 计划(`copilot/plan/plan-service.ts` 的 `PLAN_STATUS_OPEN`)同一条理由:
 *   · 未收口(planned / running / paused)= 还会被 tick 推进、还会**在执行区真跑**补数实例 ⇒ 项目删了就是还在跑的孤儿;
 *   · 已收口(succeeded / partially-failed / cancelled)= 历史记录(本清单不数历史);
 *   · 补数计划**没有删除入口**(只有 pause / resume / cancel / retry-failed),连已收口的也算 ⇒ 补过一次数的项目永远删不掉。
 *     处置路径 = 补数页「取消」。
 */
export const BACKFILL_PLAN_STATUS_OPEN: Readonly<Record<PlanStatus, boolean>> = Object.freeze({
  planned: true,
  running: true,
  paused: true,
  cancelled: false,
  succeeded: false,
  "partially-failed": false,
});

/** 不认识的状态一律当**未收口**(看不清 ⇒ 不放行删除)。 */
export function isBackfillPlanOpen(status: unknown): boolean {
  return Object.prototype.hasOwnProperty.call(BACKFILL_PLAN_STATUS_OPEN, String(status))
    ? BACKFILL_PLAN_STATUS_OPEN[String(status) as PlanStatus]
    : true;
}
