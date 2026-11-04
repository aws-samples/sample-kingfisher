// @kf-batch 50-P50.3b-2a-reconciler
// Next.js instrumentation:进程启动一次性钩子(需 next.config.js 开 experimental.instrumentationHook,Next 14.x)。
// register() 每个 server 实例(ECS task)启动时调一次 —— 正是"进程内 lease 单例"reconciler 的挂载点。
//
// 🔴 只在 nodejs runtime 起后台 reconciler:edge runtime 无 AWS SDK、无长驻进程语义;register 在两种 runtime 都会跑,
//    故必须 gate。desiredCount 2~6 副本各自 register ⇒ 各自 startReconcilerLoop ⇒ 由 leader-lease 选出唯一真跑者。
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // 动态 import:避免把 reconciler 及其 AWS SDK 依赖拉进 edge/中间件 bundle。
  const { startReconcilerLoop } = await import("@/lib/exec-env/reconciler-loop");
  startReconcilerLoop();
  // @kf-batch 50-WP31-place-first-class —— 落点观测器(WP-31 L9 观测模式):量真实越区调用,只记录不拦截。
  // 装失败不许挡启动(观测器坏了不能把平台带坏)。
  try {
    const { installPlaceObserver } = await import("@/lib/place/observer");
    await installPlaceObserver();
  } catch (e) {
    console.error(JSON.stringify({ event: "place.observe.install-failed", error: String((e as Error)?.message ?? e) }));
  }
}
