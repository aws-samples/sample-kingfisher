// 进程内周期循环的**唯一作者**:探活节拍与三台后台泵(数据面作业 / 补数 / 告警评估)都用这一份计时器代码。
//
// 🔴 递归 setTimeout(不是 setInterval):一轮跑完才排下一轮 ⇒ 天然不重叠(一轮跑得再久也不会堆出并发)。
// 🔴 计时器 unref():不阻止进程退出。
// 🔴 `kick()`:把等着的那一轮提到现在。给「本副本刚接手主副本」用 —— 接手只要几十秒,但若每台泵还要各等完自己的周期
//    (告警评估 60 秒)才跑第一轮,用户看到的后台停顿就多出一个周期(2026-11-17 真环境:接手用了 8 秒,页面上的评估心跳却断了 87 秒)。
//    正有一轮在跑 ⇒ 不插队(那一轮已经按新身份在跑);提前的这一轮跑完,下一轮照常在一个周期之后。
//
// 本文件在 `instrumentation.ts` 的可达面里:只用计时器,不碰 node 内置、不 import 任何业务模块。

export interface PeriodicLoopHandle {
  /** 把等着的那一轮提到现在;正有一轮在跑则什么都不做。 */
  kick: () => void;
}

export interface PeriodicLoopOptions {
  /** 一轮跑完到下一轮开始的间隔 */
  intervalMs: number;
  /** 起循环到第一轮的延迟;缺省 = 一个间隔 */
  initialDelayMs?: number;
  /** 一轮的工作。自己接住并记录自己的错误;真抛出来也不会打断循环(下一轮照排)。 */
  runOnce: () => Promise<void>;
}

export function startPeriodicLoop(opts: PeriodicLoopOptions): PeriodicLoopHandle {
  // 排着的下一轮;为空 = 正有一轮在跑(到点时清空,跑完再排)
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delay: number) => {
    timer = setTimeout(run, delay);
    if (typeof timer.unref === "function") timer.unref();
  };
  const run = async () => {
    timer = null;
    try {
      await opts.runOnce();
    } catch (e) {
      console.error("[periodic-loop] 一轮抛出了未接住的异常:", String((e as Error)?.message ?? e));
    } finally {
      schedule(opts.intervalMs);
    }
  };
  schedule(opts.initialDelayMs ?? opts.intervalMs);
  return {
    kick: () => {
      if (!timer) return; // 正有一轮在跑:不插队
      clearTimeout(timer);
      schedule(0);
    },
  };
}
