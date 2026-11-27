// 页面「触发一次调度」之后,要不要继续自动重取运行历史(纯函数;页面与判据共用,不依赖任何服务端模块)。
//
// 调度服务把一次触发变成运行行要几十秒到一分钟。原来页面只在第 5 秒重取一次运行历史:这次触发的运行行、它的结果与失败原因
// 都要用户自己点「刷新」才看得到,作业列表那一行的状态也不跟着变(定时那次失败了,列表里还写着上一次的「成功」)。
// 规则:以**触发之前**的运行行为起点 —— 新出现的行数达到本次成功触发的区数、且这些新行都不在途 ⇒ 看完了;否则继续看。
//   起点必须在触发之前读:触发之后再读,跑得快的那次运行可能已经在里面,就再也等不到「新行」。

/**
 * 在途状态(还会自己变)。词表的作者是 lib/monitor/run-groups.ts 的 RUN_INFLIGHT_STATUSES(服务端模块,页面不能直接引);
 * 判据钉这两处逐项相同。
 */
export const TRIGGER_FOLLOW_INFLIGHT: readonly string[] = Object.freeze(["running", "timeout-pending"]);

/** 页面每 6 秒看一次,最多看这么多次(约 5 分钟);到了还没看完就停,不无限轮询。 */
export const TRIGGER_FOLLOW_INTERVAL_MS = 6000;
export const TRIGGER_FOLLOW_MAX_TICKS = 50;

export type TriggerFollowState = "wait-new" | "wait-terminal" | "done";

export interface RunRowLite {
  runId?: string;
  status?: string;
}

/**
 * @param beforeRunIds 触发之前这条作业已有的运行行(runId)
 * @param runs         现在读到的运行行
 * @param expectedNew  这次成功触发了几个区(每个区一条新运行行)
 */
export function scheduledTriggerFollow(
  beforeRunIds: readonly string[],
  runs: readonly RunRowLite[],
  expectedNew: number
): TriggerFollowState {
  const before = new Set(beforeRunIds);
  const fresh = runs.filter((r) => typeof r.runId === "string" && r.runId !== "" && !before.has(r.runId));
  if (fresh.length < Math.max(1, expectedNew)) return "wait-new";
  return fresh.some((r) => TRIGGER_FOLLOW_INFLIGHT.includes(String(r.status ?? ""))) ? "wait-terminal" : "done";
}
