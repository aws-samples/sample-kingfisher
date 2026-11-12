// 推进一条作业的**唯一逻辑**(④-2:内部端点一步 = 抢 lease → 执行 / 轮询一步 → 写回,墙钟 45s)。
//
// 两个入口共用这一份:
//   · 内部端点 `/api/internal/dataplane-jobs/step`(泵回环调用,`respectSchedule=true`);
//   · 页面「立即推进」(admin 鉴权,`respectSchedule=false` —— 跳过的只是退避等待,**租约与 CAS 一条不少**)。
// 🔴 正确性不依赖选主:两个副本同时推进同一条,`claimJob` 的条件写只让一个 revision++;
//    慢的那个(或租约过期后醒来的僵尸)在 `commitJob` 撞 `StaleJobFence`,本轮结果作废、立刻停手。
import { claimJob, commitJob, StaleJobFence, type JobFence } from "@/lib/dataplane-jobs/store";
import {
  MAX_ATTEMPTS,
  STEP_WALL_CLOCK_MS,
  retryDelayMs,
  type DataplaneJobRow,
} from "@/lib/dataplane-jobs/model";
import { toPublicJob, type PublicJob } from "@/lib/dataplane-jobs/dto";
import { dataplaneJobsPaused, type JobKind } from "@/lib/dataplane-jobs/schema";
import type { JobHandler, StepResult } from "@/lib/dataplane-jobs/handler";
import { redactSql } from "@/lib/exec-env/admin-ddl-executor";
import { supplyJobHandler } from "@/lib/exec-env/project-cred-supply";
import { canaryJobHandler } from "@/lib/exec-env/permission-canary";
import { reclaimJobHandler } from "@/lib/exec-env/project-cred-reclaim";
import { sgCleanupJobHandler } from "@/lib/datasource/sg-cleanup-job";
import { dmsInstanceReclaimJobHandler } from "@/lib/realtime/dms-instance-reclaim-job";

/** 种类 → handler(穷尽表:新增种类不登记 handler 编译不过)。 */
const HANDLERS: Record<JobKind, JobHandler> = {
  supply: supplyJobHandler,
  canary: canaryJobHandler,
  reclaim: reclaimJobHandler,
  "sg-cleanup": sgCleanupJobHandler,
  "dms-instance-reclaim": dmsInstanceReclaimJobHandler,
};

export type StepOutcome =
  | { kind: "advanced"; job: PublicJob }
  | { kind: "terminal"; job: PublicJob }
  | { kind: "not-due"; job: PublicJob }
  | { kind: "busy" }
  | { kind: "missing" }
  | { kind: "paused" }
  /** 本轮结果被 fencing 作废(租约被接手)—— 不是错误,是互斥在起作用 */
  | { kind: "stale" };

export interface RunStepDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  wallClockMs?: number;
  handlers?: Partial<Record<JobKind, JobHandler>>;
}

/** 错误进作业行之前必须过的那道:脱敏 + 截断(lastError 会出现在页面上)。 */
export function jobErrorText(e: unknown): string {
  return redactSql(String((e as Error)?.message ?? e)).slice(0, 500);
}

export async function runJobStep(
  jobId: string,
  opts: { respectSchedule: boolean },
  deps: RunStepDeps = {}
): Promise<StepOutcome> {
  if (dataplaneJobsPaused()) return { kind: "paused" };
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (deps.wallClockMs ?? STEP_WALL_CLOCK_MS);

  const claim = await claimJob(jobId, now(), { respectSchedule: opts.respectSchedule });
  if (claim.kind === "missing") return { kind: "missing" };
  if (claim.kind === "busy") return { kind: "busy" };
  if (claim.kind === "terminal") return { kind: "terminal", job: toPublicJob(claim.job) };
  if (claim.kind === "not-due") return { kind: "not-due", job: toPublicJob(claim.job) };

  let job: DataplaneJobRow = claim.job;
  let fence: JobFence = claim.fence;
  const handler = (deps.handlers ?? {})[job.kind] ?? HANDLERS[job.kind];
  if (!handler) {
    // 不认识的种类 = 代码与数据不一致;判终态失败并说清原因,而不是让它永远停在 running
    await commitJob(
      fence,
      { phase: "failed", state: job.state, progress: job.progress, evidence: job.evidence, lastError: `未登记 handler 的作业种类:${job.kind}`, attempts: job.attempts, nextRunAt: 0 },
      { release: true, now: now() }
    );
    return { kind: "advanced", job: toPublicJob({ ...job, phase: "failed" }) };
  }

  try {
    // 🔴 抢到之后**至少走一步**再看墙钟:若先判墙钟,抢占本身慢一点(或墙钟很短)就会「抢到 → 立刻交还」原地空转,
    //    作业永远不前进(装配层判据「每轮只够走一小步」第一次跑就逮到的)。
    for (let first = true; ; first = false) {
      if (!first && now() >= deadline) {
        // 墙钟到了:交还租约,马上可被再推进(不是失败)
        fence = await commitJob(
          fence,
          { phase: "waiting", state: job.state, progress: job.progress, evidence: job.evidence, lastError: job.lastError ?? null, attempts: job.attempts, nextRunAt: now() },
          { release: true, now: now() }
        );
        job = { ...job, phase: "waiting" };
        break;
      }
      let r: StepResult;
      try {
        r = await handler.step({ job, now, deadline, sleep });
      } catch (e) {
        // 抛出的异常一律按可重试(state 不变 —— handler 自己没来得及给新 state)
        r = { state: job.state, progress: job.progress, evidence: job.evidence, next: { kind: "retry", reason: jobErrorText(e) } };
      }
      // 🔴 失败计数只在**真推进**(进度前移)时清零:「提交」本身也回 continue,
      //    若 continue 就清零,则「提交 → 读到失败 → 重新提交」会让 attempts 永远到不了上限(无界重试)。
      const progressed = Number(r.progress?.done ?? 0) > Number(job.progress?.done ?? 0);
      job = { ...job, state: r.state, progress: r.progress, evidence: r.evidence, ...(progressed ? { attempts: 0 } : {}) };
      const n = r.next;
      if (n.kind === "continue") {
        fence = await commitJob(
          fence,
          {
            phase: "running",
            state: job.state,
            progress: job.progress,
            evidence: job.evidence,
            lastError: progressed ? null : job.lastError ?? null,
            attempts: job.attempts,
            nextRunAt: now(),
          },
          { release: false, now: now() }
        );
        if (progressed) job = { ...job, lastError: undefined };
        continue;
      }
      if (n.kind === "wait") {
        fence = await commitJob(
          fence,
          { phase: "waiting", state: job.state, progress: job.progress, evidence: job.evidence, lastError: job.lastError ?? null, attempts: job.attempts, nextRunAt: now() + n.delayMs },
          { release: true, now: now() }
        );
        job = { ...job, phase: "waiting" };
        break;
      }
      if (n.kind === "retry") {
        const attempts = job.attempts + 1;
        const giveUp = attempts >= MAX_ATTEMPTS;
        const reason = n.reason.slice(0, 500);
        fence = await commitJob(
          fence,
          {
            phase: giveUp ? "failed" : "waiting",
            state: job.state,
            progress: job.progress,
            evidence: job.evidence,
            lastError: giveUp ? `连续失败 ${attempts} 次,已停止重试:${reason}` : reason,
            attempts,
            nextRunAt: now() + retryDelayMs(attempts, deps.rand),
          },
          { release: true, now: now() }
        );
        job = { ...job, phase: giveUp ? "failed" : "waiting", attempts, lastError: reason };
        break;
      }
      // succeeded / failed
      const phase = n.kind;
      const lastError = n.kind === "failed" ? n.reason.slice(0, 500) : null;
      fence = await commitJob(
        fence,
        { phase, state: job.state, progress: job.progress, evidence: job.evidence, lastError, attempts: job.attempts, nextRunAt: 0 },
        { release: true, now: now() }
      );
      job = { ...job, phase, ...(lastError ? { lastError } : { lastError: undefined }) };
      break;
    }
  } catch (e) {
    if (e instanceof StaleJobFence) return { kind: "stale" };
    throw e;
  }
  return { kind: "advanced", job: toPublicJob(job) };
}
