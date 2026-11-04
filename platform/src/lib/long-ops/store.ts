// 模块 55 长操作统一框架 —— 任务表服务层(bgp-long-ops)。= 序 46 B-107 `lib/ai/long-call.ts` 泛化(AI 专用 ⇒ 全平台唯一)。
//
// 【为什么有它】B-74 同步列 / B-95 删项目 / B-107 七条 AI / B-111 建模落地 —— 同一病四次发作:请求处理器同步等外部系统到终态,
//   外部耗时不可控(数仓冷启动 / 模型推理 / 大表),边缘 60s 硬墙(CloudFront origin readTimeout 60s · ALB idle 60s)⇒ 504 HTML。
//   用户 2026-10-21 拍板「不是修修补补,要高度抽象地解决,一劳永逸」⇒ 全平台只剩一个「提交长操作」原语(./driver.ts)
//   和一张任务表(本文件),页面调用点零改动(客户端传输层 ./client/follow.ts)。
//
// 状态机:pending → running →(succeeded | failed | timeout)。终态不可逆。并发三保证(照 GenBI / B-107 原文):
//  1) 抢占 / 重认领用 DynamoDB **条件写**:并发轮询里只有一个执行者能把 pending→running(或重认领 stale 的 running)。
//  2) **runToken**(每次认领生成新 ULID):终态 / 心跳写入条件带 runToken=:tok —— 被取代的僵尸执行者无法覆盖当前 owner。
//  3) 终态写入一律条件 `status=running`:状态永不回退,第一个写终态者赢。
// 强制结束两层:执行进程活着 ⇒ 驱动器到 CEILING 主动 abort 写 timeout;执行进程已死 ⇒ 轮询读时按 startedAt 判天花板
//  forceTimeoutIfExpired,**绝不重跑**。
//
// 与 B-107 的三点不同:① `model` 泛化为 `meta`(AI 类有 model,建模 / 目录类无);② 新增 `resultStatus`(目录建表 201)与
//  `errorStatus` / `errorBody`(执行体抛 LongOpHttpError 时落库 ⇒ 异步分支失败的状态码 / 信封与同步分支逐字一致 ——
//  B-107 的异步失败一律丢状态码,是本次顺手修的缺口);③ 环境变量改 `LONG_OPS_*`(AI_* 五个删除,B-107 未发版无兼容义务)。

import { PutCommand, GetCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { LONG_OP_LABELS, type LongOpKind, type LongOpParamsByKind } from "./kinds";
import type { LongOpMeta } from "./executor-types";
import { LONG_OP_TIMEOUT_ERROR, type LongOpStatus } from "./protocol";

function intEnv(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// 300s 天花板(与 GenBI 同一用户拍板「5 分钟查不出强制掐掉」);心跳 stale 30s;心跳间隔 8s;进程内同步等待 45s
// (< CloudFront origin 60s;与序 38 schema-sync 的 respondWithinMs 同值)。`LONG_OPS_SYNC_WAIT_MS` 是容器 env(CDK context
// `-c long-ops-sync-wait-ms`),测试账号给 500 把每条已接入路由逼进 202 路径页面驱动验收;生产不给 = 45000。
export const CEILING_MS = intEnv("LONG_OPS_MAX_MS", 300_000);
export const STALE_MS = intEnv("LONG_OPS_STALE_MS", 30_000);
export const HEARTBEAT_INTERVAL_MS = intEnv("LONG_OPS_HEARTBEAT_MS", 8_000);
export const SYNC_WAIT_MS = intEnv("LONG_OPS_SYNC_WAIT_MS", 45_000);
const TTL_SECONDS = 7 * 24 * 3600;

export { LONG_OP_TIMEOUT_ERROR };

/**
 * 开关:`LONG_OPS_ASYNC` 为 "0" / "false" / "off" 时退回纯同步(不建任务行、不 202,行为与接入前逐字相同);缺省**开**。
 * 为什么缺省开:客户现网只能用 Kimi K3、目标区数仓会冷,升级后不改环境变量也必须不撞墙。
 */
export function longOpsAsyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.LONG_OPS_ASYNC || "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

/**
 * 执行体里「该用某个 HTTP 状态如实回」的错误。同步分支:路由 `longOpErrorResponse(e)` 原状态码 / 原信封回;
 * 异步分支:落库 `errorStatus` / `errorBody`,客户端整形时逐字还原。
 * `body` = 路由既有「错误 ⇒ Response」映射器(targetNotReadyResponse / residencyErrorResponse / catalogDdlErrorResponse …)
 * 的完整 JSON 信封 —— 有它就不必把每种错误再翻译一遍,`fromResponse` 直接吸收。
 */
export class LongOpHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly detail?: unknown;
  readonly body?: unknown;
  constructor(status: number, message: string, opts: { code?: string; detail?: unknown; body?: unknown; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "LongOpHttpError";
    this.status = status;
    this.code = opts.code;
    this.detail = opts.detail;
    this.body = opts.body;
  }
  /** 把路由层既有映射器产出的 Response 转成可落库的错误(状态 + 原信封;信封读不出就只留状态与文案)。 */
  static async fromResponse(res: Response, cause?: unknown): Promise<LongOpHttpError> {
    let body: unknown;
    try {
      body = await res.clone().json();
    } catch {
      body = undefined;
    }
    const env = body as { error?: { message?: string; code?: string; detail?: unknown } } | undefined;
    const message = env?.error?.message || (cause instanceof Error ? cause.message : res.statusText) || `HTTP ${res.status}`;
    return new LongOpHttpError(res.status, message, { code: env?.error?.code, detail: env?.error?.detail, body, cause });
  }
}

export interface LongOpRow<K extends LongOpKind = LongOpKind> {
  taskId: string;
  kind: K;
  params: LongOpParamsByKind[K];
  /** 建任务的身份 sub;轮询只对本人可见(与 GenBI 同:taskId 只在本人前端内存)。 */
  userId: string;
  /** 建任务那次请求的 correlationId;终态 `_meta.correlationId` 回显它,让轮询拿到的结果能对回提交那条日志。 */
  correlationId?: string;
  status: LongOpStatus;
  /** 执行体的响应 data(与同步分支 `apiOk(data)` 的 data 逐字相同)。 */
  result?: unknown;
  resultStatus?: number;
  /** `result` 是整个响应体(执行体 rawBody;客户端整形时不再包信封)。 */
  resultRaw?: boolean;
  meta?: LongOpMeta;
  error?: string;
  errorStatus?: number;
  errorBody?: unknown;
  runToken?: string;
  /** 本任务占住的对象资源键(55 DESIGN §2.8;终态写入时据此释放租约)。 */
  leases?: string[];
  createdAt: string;
  startedAt?: string;
  heartbeatAt?: string;
  finishedAt?: string;
  ttl: number;
}

function isConditionalFail(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: string }).name === "ConditionalCheckFailedException";
}

// ── 建任务(pending) ──
export async function createLongOp<K extends LongOpKind>(input: {
  kind: K;
  params: LongOpParamsByKind[K];
  userId: string;
  correlationId?: string;
  /** 驱动器先以这个 id 占了租约再建行(租约 holder 必须等于 taskId);不给就现生成。 */
  taskId?: string;
  leases?: readonly string[];
}): Promise<LongOpRow<K>> {
  const taskId = input.taskId ?? ulid();
  const now = new Date();
  const row: LongOpRow<K> = {
    taskId,
    kind: input.kind,
    params: input.params,
    userId: input.userId,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.leases && input.leases.length ? { leases: [...input.leases] } : {}),
    status: "pending",
    createdAt: now.toISOString(),
    ttl: Math.floor(now.getTime() / 1000) + TTL_SECONDS,
  };
  // docClient removeUndefinedValues:true —— params 里可选字段为 undefined 时自动省略。
  await docClient.send(new PutCommand({ TableName: TABLES.LONG_OPS, Item: row }));
  return row;
}

// ── 读任务 ──
export async function getLongOp(taskId: string): Promise<LongOpRow | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.LONG_OPS, Key: { taskId } }));
  return (Item as LongOpRow) || null;
}

// ── 抢占 pending→running(幂等,返回 runToken=赢;null=已被他人抢 / 非 pending) ──
export async function claimForRun(taskId: string): Promise<string | null> {
  const runToken = ulid();
  const nowIso = new Date().toISOString();
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.LONG_OPS,
      Key: { taskId },
      UpdateExpression: "SET #s = :running, startedAt = :now, heartbeatAt = :now, runToken = :tok",
      ConditionExpression: "attribute_exists(taskId) AND #s = :pending",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":running": "running", ":pending": "pending", ":now": nowIso, ":tok": runToken },
    }));
    return runToken;
  } catch (e) {
    if (isConditionalFail(e)) return null;
    throw e;
  }
}

// ── 重认领 stale 的 running(心跳 stale 且未过天花板;返回新 runToken=赢;null=没抢到 / 条件不符) ──
export async function reclaimStale(taskId: string): Promise<string | null> {
  const runToken = ulid();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const staleCutoff = new Date(now - STALE_MS).toISOString();
  const ceilingCutoff = new Date(now - CEILING_MS).toISOString();
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.LONG_OPS,
      Key: { taskId },
      UpdateExpression: "SET heartbeatAt = :now, runToken = :tok",
      ConditionExpression: "#s = :running AND heartbeatAt <= :stale AND startedAt > :ceiling",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":running": "running", ":now": nowIso, ":tok": runToken, ":stale": staleCutoff, ":ceiling": ceilingCutoff },
    }));
    return runToken;
  } catch (e) {
    if (isConditionalFail(e)) return null;
    throw e;
  }
}

// ── 心跳(仅当前 owner;超期 / 被取代 / 终态则 no-op) ──
export async function heartbeat(taskId: string, runToken: string): Promise<void> {
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLES.LONG_OPS,
      Key: { taskId },
      UpdateExpression: "SET heartbeatAt = :now",
      ConditionExpression: "#s = :running AND runToken = :tok",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":now": new Date().toISOString(), ":running": "running", ":tok": runToken },
    }));
  } catch { /* best-effort:被取代 / 终态 → 心跳不再有意义 */ }
}

export interface LongOpFailure {
  error: string;
  errorStatus?: number;
  errorBody?: unknown;
}

// ── 终态:owner 写成功 / 失败 / 超时(条件:仍 running 且是当前 owner) ──
async function finalizeByOwner(
  taskId: string,
  runToken: string,
  patch: { status: LongOpStatus; result?: unknown; resultStatus?: number; resultRaw?: boolean; meta?: LongOpMeta } & Partial<LongOpFailure>,
): Promise<boolean> {
  const sets = ["#s = :st", "finishedAt = :fin"];
  const names: Record<string, string> = { "#s": "status" };
  const values: Record<string, unknown> = { ":st": patch.status, ":fin": new Date().toISOString(), ":running": "running", ":tok": runToken };
  if (patch.result !== undefined) { sets.push("#r = :r"); names["#r"] = "result"; values[":r"] = patch.result; }
  if (patch.resultStatus !== undefined) { sets.push("resultStatus = :rs"); values[":rs"] = patch.resultStatus; }
  if (patch.resultRaw) { sets.push("resultRaw = :raw"); values[":raw"] = true; }
  if (patch.meta !== undefined) { sets.push("meta = :m"); values[":m"] = patch.meta; }
  if (patch.error !== undefined) { sets.push("#e = :e"); names["#e"] = "error"; values[":e"] = patch.error.slice(0, 1000); }
  if (patch.errorStatus !== undefined) { sets.push("errorStatus = :es"); values[":es"] = patch.errorStatus; }
  if (patch.errorBody !== undefined) { sets.push("errorBody = :eb"); values[":eb"] = patch.errorBody; }
  try {
    const out = await docClient.send(new UpdateCommand({
      TableName: TABLES.LONG_OPS,
      Key: { taskId },
      UpdateExpression: "SET " + sets.join(", "),
      ConditionExpression: "#s = :running AND runToken = :tok",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    }));
    await releaseLeasesOfRow(taskId, out.Attributes as Partial<LongOpRow> | undefined);
    return true;
  } catch (e) {
    if (isConditionalFail(e)) return false; // 已被 reconcile 判 timeout / 被取代 → 放弃写(状态不回退)
    throw e;
  }
}

export const markSucceeded = (taskId: string, runToken: string, result: unknown, extra: { meta?: LongOpMeta; resultStatus?: number; resultRaw?: boolean } = {}) =>
  finalizeByOwner(taskId, runToken, {
    status: "succeeded", result,
    ...(extra.meta ? { meta: extra.meta } : {}),
    ...(extra.resultStatus !== undefined && extra.resultStatus !== 200 ? { resultStatus: extra.resultStatus } : {}),
    ...(extra.resultRaw ? { resultRaw: true } : {}),
  });
export const markFailed = (taskId: string, runToken: string, failure: LongOpFailure) =>
  finalizeByOwner(taskId, runToken, { status: "failed", ...failure });
export const markTimeoutByOwner = (taskId: string, runToken: string) =>
  finalizeByOwner(taskId, runToken, { status: "timeout", error: LONG_OP_TIMEOUT_ERROR });

/** 把执行体抛出的错误归一成可落库的失败(LongOpHttpError 带状态 / 信封;其它只留文案)。 */
export function failureOf(e: unknown): LongOpFailure {
  if (e instanceof LongOpHttpError) {
    return { error: e.message, errorStatus: e.status, ...(e.body !== undefined ? { errorBody: e.body } : {}) };
  }
  return { error: e instanceof Error ? e.message : String(e) };
}

// ── 强制超时(reconcile 读时:孤儿任务超天花板,无 owner)。绝不重跑。 ──
export async function forceTimeoutIfExpired(taskId: string): Promise<boolean> {
  const ceilingCutoff = new Date(Date.now() - CEILING_MS).toISOString();
  try {
    const out = await docClient.send(new UpdateCommand({
      TableName: TABLES.LONG_OPS,
      Key: { taskId },
      UpdateExpression: "SET #s = :timeout, finishedAt = :fin, #e = :e",
      ConditionExpression: "#s = :running AND (attribute_not_exists(startedAt) OR startedAt <= :ceiling)",
      ExpressionAttributeNames: { "#s": "status", "#e": "error" },
      ExpressionAttributeValues: { ":timeout": "timeout", ":running": "running", ":fin": new Date().toISOString(), ":e": LONG_OP_TIMEOUT_ERROR, ":ceiling": ceilingCutoff },
      ReturnValues: "ALL_NEW",
    }));
    await releaseLeasesOfRow(taskId, out.Attributes as Partial<LongOpRow> | undefined);
    return true;
  } catch (e) {
    if (isConditionalFail(e)) return false;
    throw e;
  }
}

// ── 对象租约(55 DESIGN §2.8)—— 同一张表,pk = `lease#<resourceKey>`;holder = 占住它的 taskId ──
// 为什么要它:长操作改的是对象的外部产物(多步、非事务),对象定义却仍可被别的请求改 / 删 ——
//   …7237 页面驱动 run1(2026-10-22):码表落地进行中被删 ⇒ 建表 DDL 已过台账守卫、后续步骤再核台账被拒 ⇒ 目标区留物理表孤儿。
// 三条规则:① submitLongOp 执行前按 kinds.ts 的 LONG_OP_RESOURCES 占住全部资源键(条件 Put),占不到 ⇒ 409 LONG_OP_IN_PROGRESS
//   同步回(不建任务行);② 对象的改 / 删路由先 assertResourcesFree(经 lib/long-ops/guard.ts),被占 ⇒ 同一个 409;
//   ③ 终态写入(owner 终态 / reconcile 强制超时)顺手释放;读到的租约若 holder 已终态 / 超天花板 ⇒ 视为已释放并自愈(不靠时钟)。
export const LEASE_PK_PREFIX = "lease#";
export const LONG_OP_IN_PROGRESS_CODE = "LONG_OP_IN_PROGRESS";
/** holder 行还没建出来(驱动器先占租约再建行)的宽限:超过它仍无 holder 行 ⇒ 视为建行失败遗留的死租约。 */
export const LEASE_HOLDER_GRACE_MS = 60_000;

export interface LongOpLeaseRow {
  /** = LEASE_PK_PREFIX + resource(与任务行共用 pk 属性名) */
  taskId: string;
  resource: string;
  holder: string;
  kind: LongOpKind;
  acquiredAt: string;
  ttl: number;
}

function leasePk(resource: string): string {
  return LEASE_PK_PREFIX + resource;
}

/** 占住的对象正忙:409(文案给用户看;detail 给页面 / 判据对回那条任务)。 */
export function inProgressError(lease: LongOpLeaseRow, holderRow: Pick<LongOpRow, "startedAt"> | null | undefined): LongOpHttpError {
  const since = Date.parse(holderRow?.startedAt || lease.acquiredAt);
  const elapsedS = Number.isFinite(since) ? Math.max(0, Math.round((Date.now() - since) / 1000)) : 0;
  const label = LONG_OP_LABELS[lease.kind];
  return new LongOpHttpError(409, `「${label}」正在进行中(已 ${elapsedS} 秒),请等它结束后再操作`, {
    code: LONG_OP_IN_PROGRESS_CODE,
    detail: { taskId: lease.holder, kind: lease.kind, label, resource: lease.resource, acquiredAt: lease.acquiredAt },
  });
}

async function readLease(resource: string): Promise<LongOpLeaseRow | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.LONG_OPS, Key: { taskId: leasePk(resource) } }));
  return (Item as LongOpLeaseRow) || null;
}

/** 条件 Put:没人占(prevHolder 不给)或仍是那个死租约(prevHolder 给)才写得进。 */
async function putLease(row: LongOpLeaseRow, prevHolder?: string): Promise<boolean> {
  try {
    await docClient.send(new PutCommand({
      TableName: TABLES.LONG_OPS,
      Item: row,
      ...(prevHolder === undefined
        ? { ConditionExpression: "attribute_not_exists(taskId)" }
        : { ConditionExpression: "holder = :prev", ExpressionAttributeValues: { ":prev": prevHolder } }),
    }));
    return true;
  } catch (e) {
    if (isConditionalFail(e)) return false;
    throw e;
  }
}

/**
 * 读到的租约现在是「还占着」还是「死的」。死 = holder 行已终态;或 holder 行 running 但已超天花板(顺手强制超时,永不重跑);
 * 或 holder 行不存在且过了建行宽限。心跳 stale 但未超天花板**仍算占着**(执行者可能只是抖动;最坏 5 分钟后天花板放开)。
 */
async function leaseState(lease: LongOpLeaseRow): Promise<{ state: "held"; holderRow: LongOpRow | null } | { state: "dead" }> {
  const holderRow = await getLongOp(lease.holder);
  if (!holderRow) {
    const age = Date.now() - Date.parse(lease.acquiredAt);
    return age > LEASE_HOLDER_GRACE_MS ? { state: "dead" } : { state: "held", holderRow: null };
  }
  const decision = reconcileDecision(holderRow);
  if (decision === "terminal") return { state: "dead" };
  if (decision === "timeout") {
    await forceTimeoutIfExpired(lease.holder).catch(() => {});
    return { state: "dead" };
  }
  return { state: "held", holderRow };
}

/** 释放 holder 名下的这些租约(条件 holder=:h,别人的租约碰不着;幂等)。 */
export async function releaseLeases(holder: string, resources: readonly string[]): Promise<void> {
  for (const resource of Array.from(new Set(resources))) {
    try {
      await docClient.send(new DeleteCommand({
        TableName: TABLES.LONG_OPS,
        Key: { taskId: leasePk(resource) },
        ConditionExpression: "holder = :h",
        ExpressionAttributeValues: { ":h": holder },
      }));
    } catch (e) {
      if (!isConditionalFail(e)) throw e;
    }
  }
}

async function releaseLeasesOfRow(taskId: string, row: Partial<LongOpRow> | undefined): Promise<void> {
  if (row?.leases?.length) await releaseLeases(taskId, row.leases).catch(() => {});
}

/**
 * 占住全部资源键(按字典序,免得两个任务交叉等待);任何一个占不到 ⇒ 回滚已占的、抛 409 LONG_OP_IN_PROGRESS。
 * 死租约(见 leaseState)当场自愈覆盖。空数组 = 无需租约,直接返回。
 */
export async function acquireLeases(holder: string, kind: LongOpKind, resources: readonly string[]): Promise<void> {
  const keys = Array.from(new Set(resources)).sort();
  const got: string[] = [];
  const now = Date.now();
  const makeRow = (resource: string): LongOpLeaseRow => ({
    taskId: leasePk(resource), resource, holder, kind, acquiredAt: new Date(now).toISOString(),
    ttl: Math.floor(now / 1000) + Math.ceil(CEILING_MS / 1000) + 3600,
  });
  try {
    for (const resource of keys) {
      if (await putLease(makeRow(resource))) { got.push(resource); continue; }
      const existing = await readLease(resource);
      if (!existing) {
        if (await putLease(makeRow(resource))) { got.push(resource); continue; }
      } else {
        const state = await leaseState(existing);
        if (state.state === "held") throw inProgressError(existing, state.holderRow);
        if (await putLease(makeRow(resource), existing.holder)) { got.push(resource); continue; }
      }
      // 两次都没写进:刹那间被别人占了 ⇒ 按现持有者报忙(不再循环抢)
      const current = await readLease(resource);
      throw current ? inProgressError(current, (await getLongOp(current.holder))) : new LongOpHttpError(409, `对象 ${resource} 正被别的操作占用,请稍后重试`, { code: LONG_OP_IN_PROGRESS_CODE });
    }
  } catch (e) {
    await releaseLeases(holder, got).catch(() => {});
    throw e;
  }
}

/** 改 / 删对象的路由在动手前调:任一资源仍被长操作占着 ⇒ 抛 409 LONG_OP_IN_PROGRESS;死租约顺手清掉。 */
export async function assertResourcesFree(resources: readonly string[]): Promise<void> {
  for (const resource of Array.from(new Set(resources))) {
    const existing = await readLease(resource);
    if (!existing) continue;
    const state = await leaseState(existing);
    if (state.state === "held") throw inProgressError(existing, state.holderRow);
    await releaseLeases(existing.holder, [resource]).catch(() => {});
  }
}

// ── 读时对账决策(纯函数,不写库;GET 端点据此动作) ──
export type ReconcileAction = "terminal" | "timeout" | "claim" | "reclaim" | "running";

export function reconcileDecision(task: Pick<LongOpRow, "status" | "startedAt" | "createdAt" | "heartbeatAt">, now = Date.now()): ReconcileAction {
  if (task.status === "succeeded" || task.status === "failed" || task.status === "timeout") return "terminal";
  if (task.status === "pending") return "claim";
  // running:天花板优先(超 CEILING 必 timeout,永不重跑)→ 心跳 stale 则重认领 → 否则正常执行中。
  const startedMs = Date.parse(task.startedAt || task.createdAt);
  const elapsed = Number.isFinite(startedMs) ? now - startedMs : 0;
  if (elapsed >= CEILING_MS) return "timeout";
  const hbMs = Date.parse(task.heartbeatAt || task.startedAt || task.createdAt);
  const hbAge = Number.isFinite(hbMs) ? now - hbMs : Infinity;
  if (hbAge > STALE_MS) return "reclaim";
  return "running";
}
