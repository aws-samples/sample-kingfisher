// 驱动器判据(= long-call-driver.test 泛化):混合响应(快 ⇒ 同步 / 慢 ⇒ 202 带协议记号)、失败原样上抛 +
// LongOpHttpError 落库状态 / 信封、resultStatus 201 透传、执行体跑在 runInLongOp 上下文里、天花板必写 timeout、心跳、LONG_OPS_ASYNC=0 纯同步。
// 只 mock 真外部 DynamoDB;执行体注册表经参数注入(不 mock 兄弟模块)。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.hoisted(() => { process.env.LONG_OPS_HEARTBEAT_MS = "5"; });
vi.mock("@/lib/aws/dynamodb", () => import("./fixtures/mem-long-ops"));
import { rows, resetMemLongOps } from "./fixtures/mem-long-ops";
import { driveExecution, submitLongOp, longOpResponse, longOpErrorResponse } from "../driver";
import { LONG_OP_KINDS } from "../kinds";
import { LONG_OP_PROTOCOL, LONG_OP_TIMEOUT_ERROR } from "../protocol";
import { LongOpHttpError, claimForRun, createLongOp } from "../store";
import { currentWaitContext } from "../context";
import type { LongOpExecContext, LongOpExecutorRegistry, LongOpExecOutput } from "../executor-types";

const MODEL = { modelId: "us.moonshotai.kimi-k3", modelSource: "runtime" as const };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function registry(impl: (params: unknown, ctx: LongOpExecContext) => Promise<LongOpExecOutput>): LongOpExecutorRegistry {
  return Object.fromEntries(LONG_OP_KINDS.map((kind) => [kind, impl])) as unknown as LongOpExecutorRegistry;
}
function ctxOf(): LongOpExecContext {
  const req = new NextRequest("http://x/api/modeling/codetables/ct1/land", { method: "POST", headers: { authorization: "Bearer tok-1", "x-correlation-id": "corr-7" } });
  return { req, identity: { sub: "u1", username: "u1", groups: [] } as unknown as LongOpExecContext["identity"] };
}
const LAND = { kind: "modeling-land" as const, params: { codeTableId: "ct1", targets: ["tgt_usw2_a"], force: false, probeOnly: false }, correlationId: "corr-7" };
const FLINK = { kind: "flink-ai-sql" as const, params: { prompt: "p", sinkType: "s3" }, correlationId: "corr-7" };

async function waitUntil(pred: () => boolean, budgetMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > budgetMs) throw new Error("waitUntil 超时");
    await sleep(5);
  }
}

beforeEach(() => resetMemLongOps());

describe("驱动器:submitLongOp 混合响应", () => {
  it("快路径(建模):执行体在等待预算内完成 ⇒ mode=sync 带 data;行 succeeded;响应 200 与接入前同形(无 _meta)", async () => {
    const reg = registry(async () => ({ data: { codeTableId: "ct1", landedByTarget: { tgt_usw2_a: { status: "ok" } } } }));
    const ctx = ctxOf();
    const result = await submitLongOp(LAND, ctx, { registry: reg, waitMs: 500 });
    expect(result).toEqual({ mode: "sync", data: { codeTableId: "ct1", landedByTarget: { tgt_usw2_a: { status: "ok" } } }, meta: undefined, resultStatus: undefined });
    expect([...rows.values()][0]).toMatchObject({ kind: "modeling-land", userId: "u1", correlationId: "corr-7", status: "succeeded" });
    const res = longOpResponse(ctx.req, result);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { codeTableId: "ct1", landedByTarget: { tgt_usw2_a: { status: "ok" } } } });
  });

  it("快路径(AI):meta.model ⇒ 响应顶层 `_meta`(模型 + correlationId),与同类缺陷", async () => {
    const reg = registry(async () => ({ data: { sql: "INSERT INTO t SELECT 1" }, meta: { model: MODEL } }));
    const ctx = ctxOf();
    const result = await submitLongOp(FLINK, ctx, { registry: reg, waitMs: 500 });
    const res = longOpResponse(ctx.req, result);
    const body = await res.json();
    expect(body.data).toEqual({ sql: "INSERT INTO t SELECT 1" });
    expect(body._meta).toMatchObject({ modelId: MODEL.modelId, modelSource: "runtime", correlationId: "corr-7" });
    expect([...rows.values()][0].meta).toEqual({ model: MODEL });
  });

  it("resultStatus 201(目录建表)透传:同步响应 201;行落 resultStatus", async () => {
    const reg = registry(async () => ({ data: { kind: "redshift" }, resultStatus: 201 }));
    const ctx = ctxOf();
    const result = await submitLongOp({ kind: "catalog-create-table", params: { spec: { kind: "redshift", targetId: "tgt_home", schema: "public", table: "t_201" } as never, env: "dev" } }, ctx, { registry: reg, waitMs: 500 });
    expect(longOpResponse(ctx.req, result).status).toBe(201);
    expect([...rows.values()][0].resultStatus).toBe(201);
  });

  it("rawBody(编排四条):执行体标 rawBody ⇒ 同步响应就是 data 本体(不包 apiOk 信封),行落 resultRaw;不标的行上没有这一位", async () => {
    const raw = { success: true, dagId: "bgp_wf1", scheduler: "serverless", perTarget: [{ targetId: "tgt_home", ok: true }] };
    const reg = registry(async () => ({ data: raw, rawBody: true }));
    const ctx = ctxOf();
    const result = await submitLongOp({ kind: "workflow-publish", params: { workflowId: "wf1" } }, ctx, { registry: reg, waitMs: 500 });
    expect(result).toMatchObject({ mode: "sync", data: raw, rawBody: true });
    const res = longOpResponse(ctx.req, result);
    expect(res.status).toBe(200);
    expect(await res.json(), "摊平形状逐字,不许多一层 { success, data }").toEqual(raw);
    const taskRows = () => [...rows.values()].filter((r) => r.status);
    expect(taskRows().find((r) => r.kind === "workflow-publish")).toMatchObject({ status: "succeeded", resultRaw: true, result: raw });
    // 对照:不标 rawBody 的执行体 ⇒ 信封照旧、行上无 resultRaw(两条路径的区别只在这一位)
    const plain = await submitLongOp(LAND, ctx, { registry: registry(async () => ({ data: { x: 1 } })), waitMs: 500 });
    expect(plain).not.toHaveProperty("rawBody");
    expect(await longOpResponse(ctx.req, plain).json()).toEqual({ success: true, data: { x: 1 } });
    expect(taskRows().find((r) => r.kind === "modeling-land")!.resultRaw).toBeUndefined();
    // rawBody + resultStatus 一起给 ⇒ 状态码照 resultStatus
    const r502 = await submitLongOp({ kind: "workflow-unpublish", params: { workflowId: "wf1" } }, ctx, { registry: registry(async () => ({ data: { success: true, partial: true }, rawBody: true, resultStatus: 207 })), waitMs: 500 });
    expect(longOpResponse(ctx.req, r502).status).toBe(207);
  });

  it("慢路径:超过等待预算仍未终态 ⇒ 202 `{taskId,kind,label,status,async:true,protocol:\"long-op/1\"}`;执行体随后完成 ⇒ 同一行 succeeded(不重跑)", async () => {
    let calls = 0;
    const reg = registry(async () => { calls++; await sleep(60); return { data: { late: true } }; });
    const ctx = ctxOf();
    const result = await submitLongOp(LAND, ctx, { registry: reg, waitMs: 10 });
    expect(result.mode).toBe("async");
    const taskId = (result as { taskId: string }).taskId;
    expect(rows.get(taskId)!.status).toBe("running");
    const res = longOpResponse(ctx.req, result);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ success: true, data: { taskId, kind: "modeling-land", label: "码表落地到执行区", status: "running", async: true, protocol: LONG_OP_PROTOCOL } });
    await waitUntil(() => rows.get(taskId)!.status === "succeeded");
    expect(rows.get(taskId)!.result).toEqual({ late: true });
    expect(calls).toBe(1);
  });

  it("失败:执行体在预算内抛 ⇒ 把**同一个错误对象**原样抛出;LongOpHttpError 的状态 / 原信封落库(异步分支据此还原),longOpErrorResponse 原信封回", async () => {
    const body = { success: false, error: { message: "执行环境 tgt_usw2_a 现在不能承接:冷", code: "CONFLICT", detail: { reason: "target-not-ready" } } };
    const boom = new LongOpHttpError(409, "执行环境 tgt_usw2_a 现在不能承接:冷", { code: "CONFLICT", body });
    const reg = registry(async () => { throw boom; });
    await expect(submitLongOp(LAND, ctxOf(), { registry: reg, waitMs: 500 })).rejects.toBe(boom);
    expect([...rows.values()][0]).toMatchObject({ status: "failed", error: "执行环境 tgt_usw2_a 现在不能承接:冷", errorStatus: 409, errorBody: body });
    const res = longOpErrorResponse(boom)!;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(body);
    // 没带 body 的 LongOpHttpError ⇒ apiError 同形;普通 Error ⇒ null(路由走自己的兜底)
    const plain = longOpErrorResponse(new LongOpHttpError(422, "AI 生成的 SQL 未包含 INSERT INTO,请细化需求后重试"))!;
    expect(plain.status).toBe(422);
    expect(await plain.json()).toEqual({ success: false, error: { message: "AI 生成的 SQL 未包含 INSERT INTO,请细化需求后重试" } });
    expect(longOpErrorResponse(new Error("x"))).toBeNull();
  });

  it("LONG_OPS_ASYNC=0:不建任务行、直接执行、同步回;执行体仍在等待上下文里(awaitTerminal 合法)", async () => {
    let frame: unknown = null;
    const reg = registry(async () => { frame = currentWaitContext(); return { data: { direct: true } }; });
    const result = await submitLongOp(LAND, ctxOf(), { registry: reg, env: { LONG_OPS_ASYNC: "0" } });
    expect(result).toMatchObject({ mode: "sync", data: { direct: true } });
    expect(rows.size).toBe(0);
    expect(frame).toMatchObject({ kind: "op", opKind: "modeling-land" });
  });

  it("执行体拿到的 ctx:承载请求原样(Authorization 可取)+ abortSignal;且跑在 op 帧里(taskId = 任务行 id)", async () => {
    let seen: LongOpExecContext | null = null;
    let frame: unknown = null;
    const reg = registry(async (_params, ctx) => { seen = ctx; frame = currentWaitContext(); return { data: {} }; });
    const ctx = ctxOf();
    await submitLongOp(FLINK, ctx, { registry: reg, waitMs: 500 });
    expect(seen!.req).toBe(ctx.req);
    expect(seen!.req.headers.get("authorization")).toBe("Bearer tok-1");
    expect(seen!.abortSignal).toBeInstanceOf(AbortSignal);
    expect(frame).toMatchObject({ kind: "op", taskId: [...rows.keys()][0], opKind: "flink-ai-sql" });
  });
});

describe("驱动器:driveExecution 天花板与心跳", () => {
  it("到天花板执行体还没回 ⇒ abort + 行 timeout(LONG_OP_TIMEOUT);执行体之后才回也写不进(状态不回退)", async () => {
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reg = registry(async (_params, ctx) => { signal = ctx.abortSignal; await gate; return { data: { late: true } }; });
    const row = await createLongOp({ kind: "flink-ai-sql", params: { prompt: "p", sinkType: "s3" }, userId: "u1" });
    const token = (await claimForRun(row.taskId))!;
    const outcome = await driveExecution(row, token, ctxOf(), reg, 20);
    expect(outcome).toEqual({ status: "timeout" });
    expect(signal!.aborted).toBe(true);
    expect(rows.get(row.taskId)!).toMatchObject({ status: "timeout", error: LONG_OP_TIMEOUT_ERROR });
    release();
    await sleep(10);
    expect(rows.get(row.taskId)!.status).toBe("timeout");
    expect(rows.get(row.taskId)!.result).toBeUndefined();
  });

  it("执行中按 HEARTBEAT 间隔刷 heartbeatAt(5ms 夹具间隔);submitLongOp 的 sync 超天花板 ⇒ 抛 504 LongOpHttpError", async () => {
    const reg = registry(async () => { await sleep(60); return { data: {} }; });
    const row = await createLongOp({ kind: "flink-ai-sql", params: { prompt: "p", sinkType: "s3" }, userId: "u1" });
    const token = (await claimForRun(row.taskId))!;
    rows.get(row.taskId)!.heartbeatAt = new Date(Date.now() - 10_000).toISOString();
    const stale = rows.get(row.taskId)!.heartbeatAt;
    const outcome = await driveExecution(row, token, ctxOf(), reg);
    expect(outcome.status).toBe("succeeded");
    expect(rows.get(row.taskId)!.heartbeatAt > stale).toBe(true);
    const slow = registry(async () => { await sleep(100); return { data: {} }; });
    await expect(submitLongOp(FLINK, ctxOf(), { registry: slow, waitMs: 500, ceilingMs: 20 })).rejects.toMatchObject({ status: 504, code: "UPSTREAM_TIMEOUT" });
  });
});
