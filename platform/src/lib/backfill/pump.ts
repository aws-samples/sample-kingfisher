// 补数计划的**后台推进泵**—— 挂在周期 reconciler 旁的独立 30s 计时器。
//
// 🔴 为什么要有:补数计划原来**只靠补数详情页开着时每 6s 调一次 tick** 推进(`app/backfill/page.tsx`),
//    后台没有任何驱动 ⇒ 用户关掉页面,已提交的实例会跑完,但剩下的日期**再也不会被提交**,计划停在半路。
//
// ── 只做两件事(与数据面作业泵 `dataplane-jobs/pump.ts` 同一形状)──────────────────────
//   ① 一次轻量 Scan 取未收口计划的键(每轮 ≤10);
//   ② 对每个计划回环 POST 本进程的 `/api/internal/backfill/tick`(真正的推进 = `backfill/runner.ts#tick`,
//      与页面推进**同一个函数**)。
//
// 🔴🔴 **泵侧零执行器 import**:本文件在 `instrumentation.ts` 的可达面里(reconciler-loop 起它),
//    补数执行器碰 Redshift / Glue / EMR / 运行锁 ⇒ 一 import 就 `next build` 失败(instrumentation-bundle-guard)。
// 🔴 正确性不依赖选主,也不依赖「页面没开」:`tick` 是幂等的 —— 领取实例用条件写(pending→running 只一方赢)
//    + runToken ⇒ 泵与页面同时推、两个泵同时推,都不会重复提交。选主只是省得 N 个副本一起敲。
// 🔴 开关:`BGP_RECONCILER_DISABLED=1`(整个周期循环不起,泵随之不起)/ `BGP_BACKFILL_PUMP_PAUSED=1`(只停本泵;
//    页面推进照旧可用)。
import { listOpenPlanKeys, BACKFILL_PUMP_MAX_PER_TICK } from "@/lib/backfill/due";
import { loadInternalDispatchKey, selfBaseUrl } from "@/lib/dataplane-jobs/pump";
import {
  INTERNAL_KEY_HEADER,
  INTERNAL_SOURCE_BACKFILL_PUMP,
  INTERNAL_SOURCE_HEADER,
} from "@/lib/scheduler/internal-source";

/** 泵周期:30s(页面推进是 6s;后台慢一点即可 —— 实例本身是分钟级的引擎作业)。 */
export const BACKFILL_PUMP_INTERVAL_MS = 30_000;
/** 回环 HTTP 超时:一次 tick = 逐个读 run 终态 + 至多 concurrency 次提交,给足 55s。 */
export const BACKFILL_PUMP_HTTP_TIMEOUT_MS = 55_000;
/** 内部端点路径(路由文件与泵共用这一个常量)。 */
export const BACKFILL_TICK_ENDPOINT_PATH = "/api/internal/backfill/tick";

export function backfillPumpPaused(): boolean {
  return process.env.BGP_BACKFILL_PUMP_PAUSED === "1";
}

export interface BackfillPumpTickSummary {
  ran: boolean;
  /** 不跑的原因(paused / not-leader / no-key) */
  skipped?: string;
  open: number;
  posted: number;
  failed: number;
}

export interface BackfillPumpDeps {
  isLeader: () => boolean;
  fetchImpl?: typeof fetch;
  loadKey?: () => Promise<string>;
  baseUrl?: string;
  listKeys?: typeof listOpenPlanKeys;
}

async function post(deps: BackfillPumpDeps, key: string, body: unknown): Promise<boolean> {
  const f = deps.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), BACKFILL_PUMP_HTTP_TIMEOUT_MS);
  try {
    const r = await f(`${deps.baseUrl ?? selfBaseUrl()}${BACKFILL_TICK_ENDPOINT_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [INTERNAL_SOURCE_HEADER]: INTERNAL_SOURCE_BACKFILL_PUMP,
        [INTERNAL_KEY_HEADER]: key,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    // 404 = 计划刚被删 / 不存在(下一轮就不会再列出来),不算失败
    return r.ok || r.status === 404;
  } catch (e) {
    console.error(JSON.stringify({ event: "backfill.pump.post-failed", error: String((e as Error)?.message ?? e) }));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 一轮(可无定时器直接测)。计划之间**串行**推进:每次 tick 可能提交引擎作业,不并发打爆引擎 API。 */
export async function runBackfillPumpTick(deps: BackfillPumpDeps): Promise<BackfillPumpTickSummary> {
  const base: BackfillPumpTickSummary = { ran: false, open: 0, posted: 0, failed: 0 };
  if (backfillPumpPaused()) return { ...base, skipped: "paused" };
  if (!deps.isLeader()) return { ...base, skipped: "not-leader" };
  const key = await (deps.loadKey ?? loadInternalDispatchKey)();
  if (!key) return { ...base, skipped: "no-key" };
  const keys = await (deps.listKeys ?? listOpenPlanKeys)(BACKFILL_PUMP_MAX_PER_TICK);
  let posted = 0;
  let failed = 0;
  for (const k of keys) {
    if (await post(deps, key, { projectId: k.projectId, planId: k.planId })) posted++;
    else failed++;
  }
  return { ran: true, open: keys.length, posted, failed };
}

/** 起泵(reconciler-loop 在 `startReconcilerLoop` 里调;递归 setTimeout + unref ⇒ 一轮跑完才排下一轮,不重叠)。 */
export function startBackfillPump(deps: BackfillPumpDeps): void {
  const schedule = (delay: number) => {
    const timer = setTimeout(runOnce, delay);
    if (typeof timer.unref === "function") timer.unref();
  };
  const runOnce = async () => {
    try {
      const s = await runBackfillPumpTick(deps);
      if (s.ran && (s.open > 0 || s.failed > 0)) console.log("[backfill-pump] tick:", JSON.stringify(s));
    } catch (e) {
      console.error("[backfill-pump] tick 未捕获异常:", String((e as Error)?.message ?? e));
    } finally {
      schedule(BACKFILL_PUMP_INTERVAL_MS);
    }
  };
  console.log("[backfill-pump] 已启动(interval=%dms)", BACKFILL_PUMP_INTERVAL_MS);
  schedule(BACKFILL_PUMP_INTERVAL_MS);
}
