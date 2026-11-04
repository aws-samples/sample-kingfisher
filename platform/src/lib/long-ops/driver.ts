// 长操作统一框架 —— 驱动器(抢占后执行 + 心跳 + 天花板 + 终态)与路由侧的「混合响应」提交。
// = `lib/ai/long-call-driver.ts` 泛化:AI 专用 ⇒ 全平台唯一(55 DESIGN §2.3;合同 50 SPEC §3.18)。
//
// 两个入口:
//  · `submitLongOp`(已接入的路由用):建任务 → 抢占 → 在**本进程**起执行(fire-and-forget)→ 等到 SYNC_WAIT_MS:
//      已终态 ⇒ 像接入前那样同步回(成功 = data(+ 状态码 / meta);失败 = 原错误原样抛给路由的 catch,状态码 / 文案逐字不变);
//      未终态 ⇒ 202 `{ taskId, kind, label, status:"running", async:true, protocol:"long-op/1" }`,客户端传输层转去轮询。
//    `LONG_OPS_ASYNC=0` 时不建任务行、直接执行(与接入前逐字相同)。
//  · `driveExecution`(提交路由与 GET 轮询端点共用):AbortController + CEILING 定时器 + 心跳循环;执行体跑在
//    `runInLongOp` 上下文里(执行体内部的 awaitTerminal 因此合法);执行体不听 abort 时用 race 保证到天花板必定写 timeout。

import type { NextRequest } from "next/server";
import { ulid } from "ulid";
import { NextResponse } from "next/server";
import { apiOk } from "@/lib/api-response";
import { buildAiMeta } from "@/lib/ai/meta";
import { logger } from "@/lib/observability/logger";
import { LONG_OP_LABELS, LONG_OP_RESOURCES, type LongOpKind, type LongOpParamsByKind } from "./kinds";
import { LONG_OP_PROTOCOL, LONG_OP_TIMEOUT_MESSAGE } from "./protocol";
import type { LongOpExecContext, LongOpExecutor, LongOpExecutorRegistry, LongOpMeta } from "./executor-types";
import { runInLongOp } from "./context";
import { LONG_OP_EXECUTORS } from "./registry";
import {
  CEILING_MS, HEARTBEAT_INTERVAL_MS, SYNC_WAIT_MS, LongOpHttpError, longOpsAsyncEnabled, failureOf,
  createLongOp, claimForRun, heartbeat, markSucceeded, markFailed, markTimeoutByOwner, acquireLeases, releaseLeases,
  type LongOpRow,
} from "./store";

export { longOpErrorResponse } from "./http-error";

export type DriveOutcome =
  | { status: "succeeded"; data: unknown; meta?: LongOpMeta; resultStatus?: number; rawBody?: boolean }
  | { status: "failed"; error: unknown }
  | { status: "timeout" };

/** 缺省注册表 = ./registry.ts 装配的各域执行体(判据经参数注入替身,不 mock 兄弟模块)。 */
function defaultRegistry(): LongOpExecutorRegistry {
  return LONG_OP_EXECUTORS;
}

/** 执行一条已认领的任务到终态并落库。**绝不 reject**(fire-and-forget 调用方不需要 catch)。 */
export async function driveExecution(
  task: Pick<LongOpRow, "taskId" | "kind" | "params">,
  runToken: string,
  ctx: LongOpExecContext,
  registry?: LongOpExecutorRegistry,
  ceilingMs: number = CEILING_MS,
): Promise<DriveOutcome> {
  const reg = registry ?? defaultRegistry();
  const controller = new AbortController();
  let onAbort: (() => void) | undefined;
  const abortGate = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("LONG_OP_CEILING_ABORT"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  const ceilingTimer = setTimeout(() => controller.abort(), ceilingMs);
  const hbTimer = setInterval(() => { heartbeat(task.taskId, runToken).catch(() => {}); }, HEARTBEAT_INTERVAL_MS);
  const startedAt = Date.now();
  try {
    const executor = reg[task.kind] as LongOpExecutor<LongOpKind>;
    const run = () => executor(task.params, { ...ctx, abortSignal: controller.signal });
    const out = await Promise.race([runInLongOp({ taskId: task.taskId, opKind: task.kind }, run), abortGate]);
    await markSucceeded(task.taskId, runToken, out.data, { meta: out.meta, resultStatus: out.resultStatus, resultRaw: out.rawBody });
    logger.info("long-op.settled", { taskId: task.taskId, kind: task.kind, status: "succeeded", elapsedMs: Date.now() - startedAt, ...(out.resultStatus ? { resultStatus: out.resultStatus } : {}) });
    return { status: "succeeded", data: out.data, meta: out.meta, resultStatus: out.resultStatus, ...(out.rawBody ? { rawBody: true } : {}) };
  } catch (e: unknown) {
    // 到天花板 abort → timeout(强制结束);其余 → failed。终态条件写:若已被 reconcile 抢先判 timeout,
    // markX 因 status≠running no-op,状态不回退(幂等收口)。
    if (controller.signal.aborted) {
      await markTimeoutByOwner(task.taskId, runToken).catch(() => {});
      logger.warn("long-op.settled", { taskId: task.taskId, kind: task.kind, status: "timeout", elapsedMs: Date.now() - startedAt });
      return { status: "timeout" };
    }
    const failure = failureOf(e);
    await markFailed(task.taskId, runToken, failure).catch(() => {});
    logger.info("long-op.settled", { taskId: task.taskId, kind: task.kind, status: "failed", elapsedMs: Date.now() - startedAt, ...(failure.errorStatus ? { errorStatus: failure.errorStatus } : {}), error: failure.error.slice(0, 200) });
    return { status: "failed", error: e };
  } finally {
    clearTimeout(ceilingTimer);
    clearInterval(hbTimer);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    abortGate.catch(() => {});
  }
}

export type SubmitResult =
  | { mode: "sync"; data: unknown; meta?: LongOpMeta; resultStatus?: number; rawBody?: boolean }
  | { mode: "async"; taskId: string; kind: LongOpKind; status: "running" };

/**
 * 路由侧提交。成功 / 202 回 SubmitResult;执行体在等待预算内**失败**则把原错误原样抛出,
 * 让路由的 catch(longOpErrorResponse / placeErrorResponse / 兜底 500)逐字沿用。
 */
export async function submitLongOp<K extends LongOpKind>(
  input: { kind: K; params: LongOpParamsByKind[K]; correlationId?: string },
  ctx: LongOpExecContext,
  opts: { registry?: LongOpExecutorRegistry; waitMs?: number; ceilingMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<SubmitResult> {
  const registry = opts.registry ?? defaultRegistry();
  // 对象租约(55 DESIGN §2.8):先按 kind 声明占住要改的对象;占不到 ⇒ acquireLeases 抛 409 LONG_OP_IN_PROGRESS,路由 longOpErrorResponse 同步回,不建任务行。
  const resources = (LONG_OP_RESOURCES[input.kind] as (params: LongOpParamsByKind[K]) => string[])(input.params);
  if (!longOpsAsyncEnabled(opts.env)) {
    const executor = registry[input.kind] as LongOpExecutor<K>;
    // 纯同步退路也要有等待上下文(执行体内部的 awaitTerminal 才合法)与租约;用一个不落库的伪 taskId。
    const syncHolder = `sync-only-${ulid()}`;
    await acquireLeases(syncHolder, input.kind, resources);
    try {
      const out = await runInLongOp({ taskId: syncHolder, opKind: input.kind }, () => executor(input.params, ctx));
      return { mode: "sync", data: out.data, meta: out.meta, resultStatus: out.resultStatus, ...(out.rawBody ? { rawBody: true } : {}) };
    } finally {
      await releaseLeases(syncHolder, resources).catch(() => {});
    }
  }
  const taskId = ulid();
  await acquireLeases(taskId, input.kind, resources);
  let row: LongOpRow<K>;
  try {
    row = await createLongOp({ taskId, leases: resources, kind: input.kind, params: input.params, userId: ctx.identity.sub, correlationId: input.correlationId });
  } catch (e) {
    await releaseLeases(taskId, resources).catch(() => {});
    throw e;
  }
  const runToken = await claimForRun(row.taskId);
  // 刚建就被别的轮询抢走(理论上只有判据并发才会发生):不重复执行,让客户端去轮询。
  if (!runToken) return { mode: "async", taskId: row.taskId, kind: input.kind, status: "running" };

  const outcome = driveExecution(row, runToken, ctx, registry, opts.ceilingMs);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const waitMs = opts.waitMs ?? SYNC_WAIT_MS;
  const deadline = new Promise<"deadline">((resolve) => { deadlineTimer = setTimeout(() => resolve("deadline"), waitMs); });
  const settled = await Promise.race([outcome, deadline]);
  if (deadlineTimer) clearTimeout(deadlineTimer);
  if (settled === "deadline") {
    logger.info("long-op.accepted", { taskId: row.taskId, kind: input.kind, waitedMs: waitMs, correlationId: input.correlationId });
    return { mode: "async", taskId: row.taskId, kind: input.kind, status: "running" };
  }
  if (settled.status === "succeeded") return { mode: "sync", data: settled.data, meta: settled.meta, resultStatus: settled.resultStatus, ...(settled.rawBody ? { rawBody: true } : {}) };
  if (settled.status === "failed") throw settled.error;
  throw new LongOpHttpError(504, LONG_OP_TIMEOUT_MESSAGE, { code: "UPSTREAM_TIMEOUT" });
}

/**
 * 已接入路由共用的响应形状:同步 = `apiOk(data, resultStatus ?? 200, _meta?)`(与接入前逐字相同);异步 = 202 带协议记号。
 * 执行体标了 `rawBody` ⇒ data 就是整个响应体,原样 `NextResponse.json`(编排四条路由的摊平形状;客户端整形同样按 resultRaw 原样交回)。
 */
export function longOpResponse(req: NextRequest, result: SubmitResult) {
  if (result.mode === "async") {
    return apiOk({ taskId: result.taskId, kind: result.kind, label: LONG_OP_LABELS[result.kind], status: result.status, async: true, protocol: LONG_OP_PROTOCOL }, 202);
  }
  if (result.rawBody) return NextResponse.json(result.data, { status: result.resultStatus ?? 200 });
  const meta = result.meta?.model ? buildAiMeta(req, result.meta.model) : undefined;
  return apiOk(result.data, result.resultStatus ?? 200, meta);
}
