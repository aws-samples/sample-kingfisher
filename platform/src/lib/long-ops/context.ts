// 模块 55 长操作统一框架 —— 等待上下文(AsyncLocalStorage)。
//
// 两种帧,同一个存储:
//  · `op` 帧:由驱动器 `driveExecution` 在跑某个长操作的执行体时建立(`runInLongOp`);
//  · `background` 帧:由请求外的循环**入口**建立(`runAsBackgroundWaiter`):数据面作业泵的 step、reconciler / 镜像 tick、
//    同步 / 离线 / 补数的 fire-and-forget 轮询 …… owner 必须在闭合清单 `BACKGROUND_WAITERS` 里。
// 等待终态的唯一原语 `awaitTerminal`(./await-terminal.ts)取不到任何帧就抛 `LongOpContextMissing` ——
// 「路由里直接 await 一个会轮询外部终态的函数」在运行第一步就红,不靠 code review 记得(55 DESIGN D6 / D7)。
//
// 🔴 进程级单例(照 lib/place/context.ts 的教训):Next 把 instrumentation 与各路由编进不同 webpack layer,同一源文件在产物里
//    是多个模块实例;挂在 globalThis 的注册 symbol 上才全进程一份。只用 `run`,不用 `enterWith`(D11:async 函数第一个 await 之后就丢)。

import { AsyncLocalStorage } from "node:async_hooks";

/** 请求外的后台等待者(闭合清单;新加一种先登记再接线)。判据 `await-terminal-ratchet.test` 钉 `runAsBackgroundWaiter(` 的调用点文件清单。 */
export const BACKGROUND_WAITERS = [
  "dataplane-jobs-step",
  "reconciler-target",
  "metadata-mirror",
  "sync-run-tracker",
  "etl-run-tracker",
  "backfill-tick",
  "realtime-start",
  "seed-run",
  "engines-run",
  // 第二批:Flink 应用「删除已受理」后的后台销毁(入口 lib/realtime/flink-service.ts ensureFlinkDeletion;读时对账也会起它)
  "flink-deletion",
] as const;
export type BackgroundWaiter = (typeof BACKGROUND_WAITERS)[number];

export type WaitFrame =
  | { readonly kind: "op"; readonly taskId: string; readonly opKind: string }
  | { readonly kind: "background"; readonly owner: BackgroundWaiter };

const G = globalThis as unknown as Record<symbol, unknown>;
const ALS_KEY = Symbol.for("bgp.long-ops.als");
const als = (G[ALS_KEY] ??= new AsyncLocalStorage<WaitFrame>()) as AsyncLocalStorage<WaitFrame>;

/** 在某个长操作的执行上下文里跑 fn(驱动器专用;执行体内部的 awaitTerminal 因此有上下文)。 */
export function runInLongOp<T>(frame: { taskId: string; opKind: string }, fn: () => T): T {
  return als.run({ kind: "op", taskId: frame.taskId, opKind: frame.opKind }, fn);
}

/** 请求外的循环入口用它把整段工作包进后台等待者上下文(owner 不在闭合清单 ⇒ 抛,不许静默放行)。 */
export function runAsBackgroundWaiter<T>(owner: BackgroundWaiter, fn: () => T): T {
  if (!(BACKGROUND_WAITERS as readonly string[]).includes(owner)) {
    throw new Error(`后台等待者「${owner}」未登记在 BACKGROUND_WAITERS(lib/long-ops/context.ts)—— 先登记再接线`);
  }
  return als.run({ kind: "background", owner }, fn);
}

/** 当前等待上下文;没有就是 undefined(🔴 调用方不许把 undefined 当「可以等」)。 */
export function currentWaitContext(): WaitFrame | undefined {
  return als.getStore();
}

export class LongOpContextMissing extends Error {
  readonly what: string;
  constructor(what: string) {
    super(
      `「${what}」要同步等待外部系统到终态,但当前既不在长操作执行上下文(submitLongOp)里,也不在登记过的后台等待者里 —— ` +
        "请求路径不许同步等终态(模块 55):路由请改经 submitLongOp,请求外的循环请在入口包 runAsBackgroundWaiter",
    );
    this.name = "LongOpContextMissing";
    this.what = what;
  }
}
