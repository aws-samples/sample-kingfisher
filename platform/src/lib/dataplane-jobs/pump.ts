// @kf-batch 50-WP9a-durable-jobs
// 数据面长作业的**推进泵**(WORK-PACKAGES WP-9 ④-2)—— 挂在周期 reconciler 旁的独立 15s 计时器。
//
// ── 它只做两件事,而且刻意只做这两件 ────────────────────────────────────────────
//   ① 一次轻量 Query(稀疏 GSI byDue)取到期作业 id(每轮 ≤5);
//   ② 对每条回环 POST 本进程的 `/api/internal/dataplane-jobs/step`(真正的抢占 / 执行 / 写回在那里)。
//   每隔几轮再 POST 一次 `/sweep`(绑定即自动供给的补队)。
//
// 🔴🔴 **泵侧零执行器 import**(这一条是可执行门禁,不是风格):本文件在 `instrumentation.ts` 的可达面里,
//    那个图会被编进 edge bundle;执行器 / 模型(sha256)/ 内部守卫都 import node 内置 ⇒ 一碰就 `next build` 失败
//    (`instrumentation-bundle-guard.test.ts`)。回环 HTTP 正好把「挑作业」与「跑作业」切成两个编译世界。
// 🔴 正确性不依赖选主:只在本副本持有未过期 leader 租约时取作业(省得 N 个副本一起敲),
//    但就算两个泵同时敲同一条,内部端点的 `claimJob` 条件写也只让一个抢到。
// 🔴 两个开关:`BGP_RECONCILER_DISABLED=1`(整个周期循环都不起,泵随之不起)/ `BGP_DATAPLANE_JOBS_PAUSED=1`(只停泵)。
import { queryDueJobIds, PUMP_MAX_PER_TICK } from "@/lib/dataplane-jobs/due";
import { STEP_ENDPOINT_PATH, SWEEP_ENDPOINT_PATH, dataplaneJobsPaused } from "@/lib/dataplane-jobs/schema";
import {
  INTERNAL_KEY_HEADER,
  INTERNAL_SOURCE_DATAPLANE_JOB_PUMP,
  INTERNAL_SOURCE_HEADER,
} from "@/lib/scheduler/internal-source";

/** 泵周期(WP-9 ④-2:15s)。 */
export const PUMP_INTERVAL_MS = 15_000;
/** 每多少轮补一次队(15s × 40 = 10 分钟)。 */
export const SWEEP_EVERY_TICKS = 40;
/** 回环 HTTP 超时:必须 > 一步墙钟(45s,model.STEP_WALL_CLOCK_MS)。 */
export const PUMP_HTTP_TIMEOUT_MS = 55_000;

export interface PumpTickSummary {
  ran: boolean;
  /** 不跑的原因(paused / not-leader / no-key) */
  skipped?: string;
  due: number;
  posted: number;
  failed: number;
  swept: boolean;
}

export interface PumpDeps {
  isLeader: () => boolean;
  now?: () => number;
  fetchImpl?: typeof fetch;
  loadKey?: () => Promise<string>;
  baseUrl?: string;
}

/**
 * 本进程的回环地址。
 * 🔴 不硬写 127.0.0.1:Next standalone 的 `server.js` 按 `HOSTNAME` 环境变量绑定监听地址,
 *    而 Fargate 会把它设成任务自己的主机名(解析到 ENI 地址)⇒ 此时 127.0.0.1 上**没人在听**。
 *    用与 server.js 同一条规则(HOSTNAME,缺省回环)才连得上自己。可用 `BGP_SELF_BASE_URL` 显式覆盖。
 */
export function selfBaseUrl(): string {
  if (process.env.BGP_SELF_BASE_URL) return process.env.BGP_SELF_BASE_URL.replace(/\/+$/, "");
  const host = process.env.HOSTNAME && process.env.HOSTNAME !== "0.0.0.0" ? process.env.HOSTNAME : "127.0.0.1";
  return `http://${host}:${process.env.PORT || "3000"}`;
}

const KEY_CACHE_MS = 5 * 60_000;
let keyCache: { value: string; at: number } | null = null;

/** 测试用。 */
export function __resetPumpKeyCache(): void {
  keyCache = null;
}

/**
 * 内部端点的共享密钥(与分发 Lambda 同一份;平台进程按 ARN 读,缓存 5 分钟)。读不到 ⇒ 空串(本轮不跑)。
 * @kf-batch 50-B51-backfill-pump —— 导出给补数推进泵复用(同一把钥匙、同一份缓存,不另写第二个读法)。
 */
export async function loadInternalDispatchKey(): Promise<string> {
  const arn = process.env.ACTION_DISPATCH_SECRET_ARN || "";
  if (!arn) return "";
  if (keyCache && Date.now() - keyCache.at < KEY_CACHE_MS) return keyCache.value;
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const { sdkClient } = await import("@/lib/aws/clients");
  const { ctrlRegionOf } = await import("@/lib/workflow/dag-place");
  // @kf-batch 50-WP31-place-first-class 序 31 第三刀 ①:这把钥匙是平台**控制面**的(与分发 Lambda 共享,只在主控区),
  //   原来经数据面工厂 regionalClient("secrets") 建客户端 ⇒ observe 凭证模式下每 5 分钟先用数据面角色被拒一次再回任务角色
  //   (第四十轮 creds 缺口榜首 38 条),enforce 凭证模式下直接读不到 ⇒ 泵停。控制面一律 sdkClient("control-plane")(B-47 同一条口径)。
  const sm = sdkClient("control-plane", SecretsManagerClient, { region: ctrlRegionOf() });
  const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const value = String(r.SecretString || "");
  if (value) keyCache = { value, at: Date.now() };
  return value;
}

async function post(deps: PumpDeps, key: string, path: string, body: unknown): Promise<boolean> {
  const f = deps.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PUMP_HTTP_TIMEOUT_MS);
  try {
    const r = await f(`${deps.baseUrl ?? selfBaseUrl()}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [INTERNAL_SOURCE_HEADER]: INTERNAL_SOURCE_DATAPLANE_JOB_PUMP,
        [INTERNAL_KEY_HEADER]: key,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    // 409 = 别人正在推 / 已终态(互斥在起作用),不算失败
    return r.ok || r.status === 409;
  } catch (e) {
    console.error(JSON.stringify({ event: "dataplane-job.pump.post-failed", path, error: String((e as Error)?.message ?? e) }));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 一轮(可无定时器直接测)。 */
export async function runPumpTick(tick: number, deps: PumpDeps): Promise<PumpTickSummary> {
  const base: PumpTickSummary = { ran: false, due: 0, posted: 0, failed: 0, swept: false };
  if (dataplaneJobsPaused()) return { ...base, skipped: "paused" };
  if (!deps.isLeader()) return { ...base, skipped: "not-leader" };
  const key = await (deps.loadKey ?? loadInternalDispatchKey)();
  if (!key) return { ...base, skipped: "no-key" };
  const now = (deps.now ?? Date.now)();
  const ids = await queryDueJobIds(now, PUMP_MAX_PER_TICK);
  // 并行推进不同的作业(每条各自抢租约;同一条不会出现在一轮里两次)
  const results = await Promise.all(ids.map((jobId) => post(deps, key, STEP_ENDPOINT_PATH, { jobId })));
  let swept = false;
  if (tick % SWEEP_EVERY_TICKS === 0) {
    swept = await post(deps, key, SWEEP_ENDPOINT_PATH, {});
  }
  return {
    ran: true,
    due: ids.length,
    posted: results.filter(Boolean).length,
    failed: results.filter((x) => !x).length,
    swept,
  };
}

/**
 * 起泵(由 reconciler-loop 在 `startReconcilerLoop` 里调;递归 setTimeout + unref,一轮跑完才排下一轮 ⇒ 不重叠)。
 */
export function startDataplaneJobPump(deps: PumpDeps): void {
  let tick = 0;
  const schedule = (delay: number) => {
    const timer = setTimeout(runOnce, delay);
    if (typeof timer.unref === "function") timer.unref();
  };
  const runOnce = async () => {
    try {
      tick += 1;
      const s = await runPumpTick(tick, deps);
      if (s.ran && (s.due > 0 || s.failed > 0)) console.log("[dataplane-job-pump] tick:", JSON.stringify(s));
    } catch (e) {
      console.error("[dataplane-job-pump] tick 未捕获异常:", String((e as Error)?.message ?? e));
    } finally {
      schedule(PUMP_INTERVAL_MS);
    }
  };
  console.log("[dataplane-job-pump] 已启动(interval=%dms)", PUMP_INTERVAL_MS);
  schedule(PUMP_INTERVAL_MS);
}
