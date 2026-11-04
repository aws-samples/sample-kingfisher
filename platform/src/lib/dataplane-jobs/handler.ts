// 作业种类 handler 的**接口**(供给 / canary / 9b 起的盘点与搬迁都按它写)。
//
// 🔴 handler 的唯一职责是「看当前私有 state,走**一小步**,回下一个 state」:
//    · 不碰作业表(写回 / 续租 / fencing 全在 runner + store,handler 拿不到 fence);
//    · 每一步要么**提交**一个外部动作并把凭据记进 state,要么**读**一次已提交动作的终态 —— 不原地长等;
//    · 外部动作失败不抛,回 `retry`(带着清掉 pending 的新 state)⇒ runner 才能把「下次重新提交」持久化。
//      🔴 若改成抛异常:runner 只能按**旧 state** 记失败,pending 还在 ⇒ 下一轮读同一条已失败的语句,永远不重新提交。
//    · 只有**确定不可恢复**(RBAC 拒 / 对象不存在)才回 `failed`;抛出的异常一律按可重试处理。
import type { DataplaneJobRow, JobProgress } from "@/lib/dataplane-jobs/model";

export interface StepContext {
  /** 当前作业行(只读快照;已带本次抢到的 runToken / revision) */
  job: Readonly<DataplaneJobRow>;
  /** 当前时间(可注入) */
  now: () => number;
  /** 本次推进的墙钟截止(epoch 毫秒):handler 内联等待不得越过它 */
  deadline: number;
  /** 可注入的 sleep(单测用) */
  sleep: (ms: number) => Promise<void>;
}

export type StepNext =
  /** 走完一小步、还可以接着走(runner 先存档 + 续租,再调下一步) */
  | { kind: "continue" }
  /** 在等外部动作(statement 还没完):过 delayMs 再来 */
  | { kind: "wait"; delayMs: number }
  /** 外部动作失败但可重试:runner 计一次失败、按退避再来(到上限判终态失败) */
  | { kind: "retry"; reason: string }
  | { kind: "succeeded" }
  /** 确定不可恢复 */
  | { kind: "failed"; reason: string };

export interface StepResult {
  state: Record<string, unknown>;
  progress: JobProgress;
  evidence: Record<string, unknown>;
  next: StepNext;
}

export interface JobHandler {
  step(ctx: StepContext): Promise<StepResult>;
}

/**
 * 在预算内反复调 `probe` 直到它回非 running(statement 的内联等待)。
 * 退避 150ms 起 ×1.6、上限 1s;越过预算 / 墙钟就把最后一次结果原样回去(由 handler 回 `wait`)。
 */
export async function pollWithin<T extends { state: string }>(
  probe: () => Promise<T>,
  ctx: Pick<StepContext, "now" | "deadline" | "sleep">,
  budgetMs: number
): Promise<T> {
  const until = Math.min(ctx.deadline, ctx.now() + Math.max(0, budgetMs));
  let delay = 150;
  for (;;) {
    const r = await probe();
    if (r.state !== "running") return r;
    if (ctx.now() + delay > until) return r;
    await ctx.sleep(delay);
    delay = Math.min(1000, Math.round(delay * 1.6));
  }
}
