// @kf-batch 50-WP9a-durable-jobs
// 数据面长作业的**作业模型**(WORK-PACKAGES WP-9 ④-1)—— 确定性 jobId + 行形态 + 租约 / 重试的算术。
//
// 四模式里的前两个住在这里:
//   ① **确定性 jobId** —— `sha256("bgp-dataplane-job-v1\0" + kind + "\0" + targetId + "\0" + subject + "\0" + 幂等键)`。
//      同一件事算出同一个 id,`PutItem` 带 `attribute_not_exists(jobId)` ⇒ 重复入队(双击 / 重放 / 两个副本同时补队)
//      天然只有一条,不靠「先查再写」(那在并发下必然写出两条)。
//   ② **lease + runToken + revision 的 CAS fencing** —— 算术常量在这里,条件写在 `store.ts`。
// 另两个(DTO 允许列表 / permission canary)分别在 `dto.ts` 与 `lib/exec-env/permission-canary.ts`。
//
// 🔴 本文件 import `node:crypto` ⇒ **泵(pump.ts)绝不许 import 它**(instrumentation 可达面会进 edge bundle)。
import { createHash } from "node:crypto";
import type { JobKind, JobPhase } from "@/lib/dataplane-jobs/schema";

export const JOB_ID_PREFIX = "dpj_";
const JOB_ID_RE = /^dpj_[0-9a-f]{40}$/;

/**
 * 确定性 jobId。`subject` = projectId(项目维的作业)或 fqn(9b 起一表一作业)。
 * 🔴 任何一段为空都拒:空段会让两件不同的事算出同一个 id(「项目 A 的供给」与「target 级的供给」撞键)。
 */
export function dataplaneJobId(kind: JobKind, targetId: string, subject: string, idempotencyKey: string): string {
  for (const [name, v] of [["kind", kind], ["targetId", targetId], ["subject", subject], ["idempotencyKey", idempotencyKey]] as const) {
    if (typeof v !== "string" || !v.trim()) throw new Error(`dataplaneJobId:${name} 不能为空(空段会让两件不同的事算出同一个 id)`);
    if (v.includes("\0")) throw new Error(`dataplaneJobId:${name} 含 NUL 分隔符 ⇒ 拒绝(会让分段边界失效)`);
  }
  const h = createHash("sha256")
    .update(`bgp-dataplane-job-v1\0${kind}\0${targetId}\0${subject}\0${idempotencyKey}`)
    .digest("hex");
  return `${JOB_ID_PREFIX}${h.slice(0, 40)}`;
}

export function isDataplaneJobId(v: unknown): v is string {
  return typeof v === "string" && JOB_ID_RE.test(v);
}

/** 租约。🔴 只在服务端行内,**永不进响应**(`dto.ts` 的允许列表里没有它,单测钉)。 */
export interface JobLease {
  token: string;
  /** epoch 毫秒 */
  expiresAt: number;
}

/** 进度(给人看的;不参与任何判定)。 */
export interface JobProgress {
  done: number;
  total: number;
  /** 当前步骤名(如 create-role / C-3) */
  label?: string;
}

/**
 * 作业行(DDB 原样形态)。
 *
 * 🔴 `state` 是**种类私有的内部状态**(已提交的 statementId、审计 id、步骤游标……),
 *    `evidence` 是**可以给人看的证据**。两者分开存,DTO 只放后者 —— 混在一起迟早有人把
 *    审计 id / statementId 当「进度明细」透出去。
 */
export interface DataplaneJobRow {
  jobId: string;
  kind: JobKind;
  targetId: string;
  projectId?: string;
  /** 算 jobId 用的幂等键(留在行上便于排障:「这一条是第几次尝试」) */
  idempotencyKey: string;
  phase: JobPhase;
  state: Record<string, unknown>;
  progress: JobProgress;
  evidence: Record<string, unknown>;
  lastError?: string;
  /** 连续失败次数(成功推进一步即清零) */
  attempts: number;
  /** 🔴 CAS 版本:抢占条件之一;每次写回 +1 ⇒ 僵尸写不回 */
  revision: number;
  /** 🔴 本次持有者的运行令牌:写回必须带它且等于行上的值 */
  runToken?: string;
  lease?: JobLease;
  /** 稀疏 GSI 分区键:未终态才有 */
  dueShard?: string;
  /** 下次可被推进的时间(epoch 毫秒;稀疏 GSI 排序键) */
  nextRunAt: number;
  createdAt: string;
  updatedAt: string;
  /** 入队主体(审计口径的 actor 串;systemActor 形如 system:<用途>) */
  createdBy: string;
  /** DynamoDB TTL(epoch 秒);只给可再生的证据类作业(canary)设,供给作业不设 */
  ttl?: number;
}

// ── 租约与预算的算术 ───────────────────────────────────────────────────────────
// 🔴 三个数之间有硬约束,改一个必须同时核另外两个:
//   STEP_WALL_CLOCK_MS(一步的墙钟)< JOB_LEASE_MS(租约)—— 否则一步还没走完,租约已过期,
//   另一个副本抢走后两边各写一半;中间每次写回都会**续租**(store.commitJob),所以长步骤也安全。
//   内部端点的 HTTP 超时(pump.ts)> STEP_WALL_CLOCK_MS —— 否则泵先断开、步骤还在跑(无害,但日志会误报失败)。

/** 一次「推进」的墙钟预算(内部端点一步)。 */
export const STEP_WALL_CLOCK_MS = 45_000;
/** 租约时长:必须 > 一步墙钟 + 写回耗时。 */
export const JOB_LEASE_MS = 90_000;
/** 一次推进里,内联等一条语句到终态的上限(超过就记下 statementId、下一轮读终态)。 */
export const INLINE_POLL_BUDGET_MS = 8_000;

/** 连续失败多少次判终态失败(之后只有人工重新发起才会再试)。 */
export const MAX_ATTEMPTS = 6;

/**
 * 失败后的退避(full jitter:`random * cap`)。
 * 🔴 不用 ±50% 抖动:同一批作业同时失败时那会排成一队一起重试(memory bounded-retry-needs-full-jitter)。
 * 下限 5s:Data API 的瞬时错误很少在 1s 内恢复,太短只是把重试烧掉。
 */
export function retryDelayMs(attempts: number, rand: () => number = Math.random): number {
  const cap = Math.min(10 * 60_000, 15_000 * 2 ** Math.max(0, attempts - 1));
  return Math.max(5_000, Math.floor(rand() * cap));
}

/** 等一条已提交语句的下一次查看间隔(没到终态时)。 */
export const WAIT_POLL_MS = 5_000;

export function isTerminalPhase(p: JobPhase): boolean {
  return p === "succeeded" || p === "failed";
}
