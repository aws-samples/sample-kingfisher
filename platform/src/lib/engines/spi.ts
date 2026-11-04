// 模块 33-A — 引擎 SPI 契约（EngineProvider）。
//
// 方法语义一一对应仓内现有实现，不是凭空发明：
//  submit    ← lib/etl/job-service.ts:runGlueScriptJob:223 / runRedshiftSqlJob:282
//  poll      ← lib/etl/job-service.ts:pollGlueRun:253（进程内轮询到终态 → finishRunRecord）
//  stop      ← lib/realtime/flink-service.ts:pauseFlinkJob:543（ETL 侧原缺失，SPI 补上）
//  readLogs  ← lib/realtime/flink-service.ts:readFlinkLogs:700
//  reconcile ← lib/etl/job-service.ts:reconcileEtlJob:114（读时对账，写 bgp-task-runs）
// ensureResource/destroyResource 为本设计新增：EMR 按作业动态 Create/Delete application（不共享，
// per-作业隔离；删作业即删 application → 零垃圾）。老引擎（application 静态）无需实现这两个。

import type { EngineType, EngineJob } from "./types";

// 复刻 lib/etl/job-service.ts:41 的 RunOpts（业务日期 + 触发来源）。
export interface RunOpts {
  runDate?: string; // YYYY-MM-DD；默认今天（UTC）
  triggeredBy?: string; // "manual" | "backfill" | "rerun" | "dryrun" | "schedule"
  // @kf-batch 50-P50.3-engines
  /**
   * 这次跑在**哪个执行目标**上(缺省 `tgt_home` ⇒ 存量行为逐字节不变)。
   * 🔴 一条 run 只发生在一个 target ⇒ 「一个作业绑 N 个区」= 调用方按 target 提交 N 次
   * (与 ETL 侧运行扇出同一形状),不是让 provider 内部去循环 ——
   * 那样一个区失败就会把另一个区的结果一起丢掉。
   */
  targetId?: string;
  // @kf-batch 50-W3f-T0-T3
  /** 同一次多区扇出的关联标识(运行路由用 `runGroupIdFor(runTargets)` 产出,单区 undefined)。只透传。 */
  runGroupId?: string;
  // @kf-batch 50-W5-seg2-WP10a
  /** 运行提交的行为主体(区域审计 entry=run-submit;路由传用户 ⇒ 同意前置;缺省平台服务主体)。与 etl/job-service 的 RunOpts 同形。 */
  actor?: import("@/lib/exec-env/residency-audit").ResidencyActor;
  // 序 73 模块 57(R6)
  /** 补数实例引用(计划 id + 节点 id):有则 run 行带 `backfillPlanId` / `backfillNode`(与 etl/job-service 的 RunOpts 同形)。 */
  backfill?: import("@/lib/backfill/run-extra").BackfillRunRef;
}

// 复刻 lib/etl/job-service.ts:46 的 RunResult（引擎无关字段 + 原生 runId）。
export interface RunResult {
  runId: string; // 平台 ulid（= bgp-task-runs 的 SK）
  nativeRunId?: string; // 引擎原生 run id（EMR jobRunId）
  runDate?: string;
}

export interface LogLine {
  time?: string;
  level?: string;
  msg: string;
}

export interface EngineCapabilities {
  canStop: boolean; // EMR: true（CancelJobRun）
  logsSource: "s3" | "cloudwatch" | "managed";
  supportsDryRun: boolean; // EMR 本期: false
}

// 引擎适配器接口。registry 按 EngineType 分派；provider 内部把 EngineJob 收窄到自己的作业类型。
export interface EngineProvider {
  type: EngineType;
  capabilities: EngineCapabilities;
  // per-作业 application：幂等创建，返回 applicationId（老引擎静态资源可返回固定标识/空实现）。
  // @kf-batch 50-WP31-place-first-class —— 按作业**每一个绑定区**各建一个,返回 targetId → 资源 id(B-30:原来只回一个、且恒建在主控区)
  ensureResource(job: EngineJob): Promise<Record<string, string>>;
  // 删作业时回收 application（StopApplication + DeleteApplication）——零垃圾。
  destroyResource(job: EngineJob): Promise<void>;
  // 建 running 记录 + 启动一次 run + 起后台 poll；返回 RunResult。
  submit(job: EngineJob, opts?: RunOpts): Promise<RunResult>;
  // 轮询原生 run 到终态 → finishRunRecord 回写 bgp-task-runs + 作业表。
  // 🔴 第 4 参 `lock`(可选,2026-08-29 外部审核 P0-6):**作业级运行锁的所有权随轮询一起下沉**。
  // 原先锁由调用方 `.finally(release)` 盲放,而 poll 正常跑完轮次上限掉出循环也会触发 finally
  // ⇒ 后端还在跑就放锁,第二个 run 撞同一张目标表。实现方拿到 lock 后必须:轮询期间续租、
  // **只有确认后端终态才 release**、轮次耗尽则 `keepRunLockForReconcile`(保持持锁,靠 lease 兜底)。
  // 少实现该参的 provider 与本签名仍兼容(TS 允许少参),但那样就回到"无人持锁续租"的旧语义。
  poll(job: EngineJob, runId: string, nativeRunId: string, lock?: unknown): Promise<void>;
  // 停止运行中的 run + 收口 stopped。
  stop(job: EngineJob, runId: string, nativeRunId: string): Promise<void>;
  // 读取某次 run 的日志。
  readLogs(job: EngineJob, runId: string, nativeRunId: string): Promise<LogLine[]>;
  // 读时对账：lastRunStatus==="running" 时查真实后端态回写，杜绝列表假 running。
  reconcile(job: EngineJob): Promise<EngineJob>;
}
