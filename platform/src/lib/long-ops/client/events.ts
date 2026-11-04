// 长操作统一框架 —— 浏览器侧事件(事件名唯一作者;零服务端 import)。
//
// 全局 fetch 拦截器(lib/auth/AuthProvider.tsx)是非 React 模块,不直接碰 antd;它只在接管 / 轮询 / 整形三个时刻发 DOM 事件,
// 壳层组件 components/long-ops/LongOpIndicator.tsx 监听并显示「正在后台执行:<label>(已 n 秒)」,终态自动消。

export const LONG_OP_EVENT = "bgp:long-op" as const;

export type LongOpEventPhase = "started" | "progress" | "settled";
export type LongOpOutcome = "succeeded" | "failed" | "timeout" | "aborted";

export interface LongOpEventDetail {
  taskId: string;
  kind: string;
  label: string;
  phase: LongOpEventPhase;
  elapsedMs: number;
  outcome?: LongOpOutcome;
}

export function emitLongOpEvent(detail: LongOpEventDetail): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  try {
    window.dispatchEvent(new CustomEvent<LongOpEventDetail>(LONG_OP_EVENT, { detail }));
  } catch {
    // 事件只是提示用途;发不出去不影响请求结果
  }
}
