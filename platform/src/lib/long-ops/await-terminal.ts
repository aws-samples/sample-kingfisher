// 模块 55 长操作统一框架 —— 等待外部系统到终态的**唯一**轮询原语(55 DESIGN §2.3 / 闸门 ②)。
//
// 为什么只能有一个作者:B-74 / B-95 / B-107 / B-111 四次发作的共同根因是「请求处理器同步等外部终态」散在 30 个文件里
// 各写各的 sleep 循环(2026-10-21 盘点,55 DESIGN §10)。把循环收到这里之后,「等」这件事就有了一个必经点可以设闸:
// 没有等待上下文(不在长操作执行体里、也不是登记过的后台循环)⇒ 第一步就抛,路由里再也写不出一条会撞 60s 墙的同步等待。
//
// 退避参数与存量原语一致(150ms 起 × 1.6 顶 1s;迁移时逐处保留原来的次数预算),行为上只多了一道上下文检查。

import { currentWaitContext, LongOpContextMissing } from "./context";

export type ProbeOutcome<T> = { done: true; value: T } | { done: false; state?: string };

export interface AwaitTerminalOptions<T> {
  /** 在等什么(进错误文案:「观测语句超时(轮询 60 次 / 57.3s,最后状态 STARTED)」) */
  what: string;
  /** 查一次状态:到终态回 `{done:true,value}`;还没到回 `{done:false,state}`;失败直接抛(原样上抛) */
  probe: () => Promise<ProbeOutcome<T>>;
  /** 最多查几次(与存量原语的 for 循环次数一致) */
  maxPolls: number;
  /** 首次等待(缺省 150ms) */
  initialMs?: number;
  /** 退避上限(缺省 1000ms) */
  maxMs?: number;
  /** 退避倍数(缺省 1.6;给 1 = 固定间隔) */
  backoff?: number;
  /** 到长操作天花板时驱动器 abort ⇒ 下一轮前抛出,不再打外部系统 */
  abortSignal?: AbortSignal;
  /** 注入 sleep(判据用) */
  sleep?: (ms: number) => Promise<void>;
}

export class LongOpWaitBudgetExceeded extends Error {
  readonly what: string;
  readonly polls: number;
  readonly elapsedMs: number;
  readonly lastState?: string;
  constructor(what: string, polls: number, elapsedMs: number, lastState?: string) {
    super(`${what}超时(轮询 ${polls} 次 / ${(elapsedMs / 1000).toFixed(1)}s${lastState ? `,最后状态 ${lastState}` : ""})`);
    this.name = "LongOpWaitBudgetExceeded";
    this.what = what;
    this.polls = polls;
    this.elapsedMs = elapsedMs;
    this.lastState = lastState;
  }
}

export class LongOpAborted extends Error {
  constructor(what: string) {
    super(`${what}已被终止(长操作到达天花板)`);
    this.name = "LongOpAborted";
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function awaitTerminal<T>(opts: AwaitTerminalOptions<T>): Promise<T> {
  // 🔴 闸门:没有等待上下文 = 请求路径在同步等终态 ⇒ 当场抛(非法状态写不出来)。
  if (!currentWaitContext()) throw new LongOpContextMissing(opts.what);
  const sleep = opts.sleep ?? defaultSleep;
  const cap = opts.maxMs ?? 1000;
  const backoff = opts.backoff ?? 1.6;
  let wait = opts.initialMs ?? 150;
  const started = Date.now();
  let lastState: string | undefined;
  for (let i = 0; i < opts.maxPolls; i++) {
    if (opts.abortSignal?.aborted) throw new LongOpAborted(opts.what);
    await sleep(wait);
    wait = Math.min(cap, Math.round(wait * backoff));
    const out = await opts.probe();
    if (out.done) return out.value;
    lastState = out.state;
  }
  throw new LongOpWaitBudgetExceeded(opts.what, opts.maxPolls, Date.now() - started, lastState);
}
