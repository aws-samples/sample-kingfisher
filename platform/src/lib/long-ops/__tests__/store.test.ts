// 模块 55 — 任务表服务层判据(= 序 46 B-107 long-call.test 泛化):状态机三保证、读时对账五决策、新增 resultStatus / errorStatus / errorBody 落库、
// LongOpHttpError.fromResponse 吸收路由映射器的信封。只 mock 真外部 DynamoDB(内存夹具按真表达式求值)。
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.hoisted(() => { process.env.LONG_OPS_STALE_MS = "50"; process.env.LONG_OPS_MAX_MS = "200"; });
vi.mock("@/lib/aws/dynamodb", () => import("./fixtures/mem-long-ops"));
import { rows, sendLog, resetMemLongOps } from "./fixtures/mem-long-ops";
import {
  CEILING_MS, STALE_MS, LONG_OP_TIMEOUT_ERROR, LongOpHttpError, failureOf, longOpsAsyncEnabled,
  createLongOp, getLongOp, claimForRun, reclaimStale, heartbeat, markSucceeded, markFailed, markTimeoutByOwner, forceTimeoutIfExpired, reconcileDecision,
} from "../store";

const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
beforeEach(() => resetMemLongOps());

describe("模块 55 store:建 / 读 / 抢占 / 重认领", () => {
  it("createLongOp 落 pending 行(kind / params / userId / correlationId / ttl 7 天)到 bgp-long-ops", async () => {
    const row = await createLongOp({ kind: "modeling-land", params: { codeTableId: "ct1", targets: ["tgt_usw2_a"], force: false, probeOnly: false }, userId: "u1", correlationId: "c1" });
    expect(sendLog[0].input.TableName).toBe("bgp-long-ops");
    expect(rows.get(row.taskId)).toMatchObject({ kind: "modeling-land", status: "pending", userId: "u1", correlationId: "c1", params: { codeTableId: "ct1", targets: ["tgt_usw2_a"] } });
    expect(rows.get(row.taskId)!.ttl - Math.floor(Date.now() / 1000)).toBeGreaterThan(7 * 24 * 3600 - 5);
    expect(await getLongOp(row.taskId)).toMatchObject({ taskId: row.taskId });
    expect(await getLongOp("nope")).toBeNull();
  });

  it("claimForRun:并发两次只有一个赢(条件写 pending→running),赢者拿 runToken,输者 null", async () => {
    const row = await createLongOp({ kind: "flink-ai-sql", params: { prompt: "p", sinkType: "s3" }, userId: "u1" });
    const [a, b] = await Promise.all([claimForRun(row.taskId), claimForRun(row.taskId)]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect(rows.get(row.taskId)).toMatchObject({ status: "running", runToken: a || b });
  });

  it("reclaimStale:心跳新鲜不许重认领;心跳 stale 且未过天花板 ⇒ 新 runToken;旧 token 的心跳 / 终态写不进", async () => {
    const row = await createLongOp({ kind: "flink-ai-sql", params: { prompt: "p", sinkType: "s3" }, userId: "u1" });
    const first = (await claimForRun(row.taskId))!;
    expect(await reclaimStale(row.taskId)).toBeNull();
    rows.get(row.taskId)!.heartbeatAt = isoAgo(STALE_MS + 10);
    const second = await reclaimStale(row.taskId);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    const before = rows.get(row.taskId)!.heartbeatAt;
    await heartbeat(row.taskId, first);
    expect(rows.get(row.taskId)!.heartbeatAt).toBe(before);
    expect(await markSucceeded(row.taskId, first, { x: 1 })).toBe(false);
    expect(rows.get(row.taskId)!.status).toBe("running");
    expect(await markSucceeded(row.taskId, second!, { x: 1 })).toBe(true);
    expect(rows.get(row.taskId)).toMatchObject({ status: "succeeded", result: { x: 1 } });
  });

  it("超过天花板的 running 不许重认领;forceTimeoutIfExpired 写 timeout(LONG_OP_TIMEOUT);之后 owner 的 succeeded 写不进(状态不回退)", async () => {
    const row = await createLongOp({ kind: "flink-ai-sql", params: { prompt: "p", sinkType: "s3" }, userId: "u1" });
    const token = (await claimForRun(row.taskId))!;
    rows.get(row.taskId)!.startedAt = isoAgo(CEILING_MS + 10);
    rows.get(row.taskId)!.heartbeatAt = isoAgo(STALE_MS + 10);
    expect(await reclaimStale(row.taskId)).toBeNull();
    expect(await forceTimeoutIfExpired(row.taskId)).toBe(true);
    expect(rows.get(row.taskId)).toMatchObject({ status: "timeout", error: LONG_OP_TIMEOUT_ERROR });
    expect(await markSucceeded(row.taskId, token, { late: true })).toBe(false);
    expect(rows.get(row.taskId)!.status).toBe("timeout");
    expect(await forceTimeoutIfExpired(row.taskId)).toBe(false);
  });
});

describe("模块 55 store:终态字段(resultStatus / errorStatus / errorBody)", () => {
  it("markSucceeded 带 resultStatus 201 落库;200 不落(缺省就是 200);meta.model 落库", async () => {
    const a = await createLongOp({ kind: "catalog-create-table", params: { spec: { kind: "redshift" } as never, env: "dev" }, userId: "u1" });
    const ta = (await claimForRun(a.taskId))!;
    await markSucceeded(a.taskId, ta, { kind: "redshift" }, { resultStatus: 201 });
    expect(rows.get(a.taskId)).toMatchObject({ status: "succeeded", resultStatus: 201 });
    const b = await createLongOp({ kind: "flink-ai-sql", params: { prompt: "p", sinkType: "s3" }, userId: "u1" });
    const tb = (await claimForRun(b.taskId))!;
    await markSucceeded(b.taskId, tb, { sql: "x" }, { resultStatus: 200, meta: { model: { modelId: "m", modelSource: "runtime" } } });
    expect(rows.get(b.taskId)!.resultStatus).toBeUndefined();
    expect(rows.get(b.taskId)!.meta).toEqual({ model: { modelId: "m", modelSource: "runtime" } });
  });

  it("markFailed 带 errorStatus / errorBody 落库;failureOf 把 LongOpHttpError 归一、普通 Error 只留文案(≤ 1000 字)", async () => {
    const row = await createLongOp({ kind: "modeling-unbind", params: { entity: "codetable", id: "ct1", targetId: "tgt_home", cleanup: false }, userId: "u1" });
    const token = (await claimForRun(row.taskId))!;
    const body = { success: false, error: { message: "没有可解绑的落地记录", code: "NOT_FOUND", detail: { reason: "nothing-to-unbind" } } };
    const http = new LongOpHttpError(404, "没有可解绑的落地记录", { code: "NOT_FOUND", body });
    expect(failureOf(http)).toEqual({ error: "没有可解绑的落地记录", errorStatus: 404, errorBody: body });
    expect(failureOf(new Error("x".repeat(1200)))).toEqual({ error: "x".repeat(1200) });
    await markFailed(row.taskId, token, failureOf(http));
    expect(rows.get(row.taskId)).toMatchObject({ status: "failed", error: "没有可解绑的落地记录", errorStatus: 404, errorBody: body });
    expect(await markTimeoutByOwner(row.taskId, token)).toBe(false);
  });

  it("LongOpHttpError.fromResponse:吸收路由映射器产出的 Response(状态 + 原信封 + message / code / detail)", async () => {
    const res = new Response(JSON.stringify({ success: false, error: { message: "执行环境 tgt_x 现在不能承接:冷", code: "CONFLICT", detail: { reason: "target-not-ready" } } }), { status: 409 });
    const err = await LongOpHttpError.fromResponse(res, new Error("cause"));
    expect(err).toBeInstanceOf(LongOpHttpError);
    expect(err.status).toBe(409);
    expect(err.message).toBe("执行环境 tgt_x 现在不能承接:冷");
    expect(err.code).toBe("CONFLICT");
    expect(err.detail).toEqual({ reason: "target-not-ready" });
    expect(err.body).toEqual({ success: false, error: { message: "执行环境 tgt_x 现在不能承接:冷", code: "CONFLICT", detail: { reason: "target-not-ready" } } });
    // 原 Response 的 body 没被消耗
    expect((await res.json()).error.code).toBe("CONFLICT");
  });
});

describe("模块 55 store:读时对账决策与开关", () => {
  it("reconcileDecision 五态:终态 terminal / pending claim / 超天花板 timeout(优先于 stale)/ stale reclaim / 新鲜 running", () => {
    const now = Date.now();
    const base = { createdAt: new Date(now - 1000).toISOString() };
    expect(reconcileDecision({ ...base, status: "succeeded" }, now)).toBe("terminal");
    expect(reconcileDecision({ ...base, status: "failed" }, now)).toBe("terminal");
    expect(reconcileDecision({ ...base, status: "pending" }, now)).toBe("claim");
    expect(reconcileDecision({ ...base, status: "running", startedAt: new Date(now - CEILING_MS - 1).toISOString(), heartbeatAt: new Date(now).toISOString() }, now)).toBe("timeout");
    expect(reconcileDecision({ ...base, status: "running", startedAt: new Date(now - 10).toISOString(), heartbeatAt: new Date(now - STALE_MS - 1).toISOString() }, now)).toBe("reclaim");
    expect(reconcileDecision({ ...base, status: "running", startedAt: new Date(now - 10).toISOString(), heartbeatAt: new Date(now).toISOString() }, now)).toBe("running");
  });

  it("LONG_OPS_ASYNC 开关:缺省开;0 / false / off 关;AI_ASYNC 旧名不再被认", () => {
    expect(longOpsAsyncEnabled({})).toBe(true);
    expect(longOpsAsyncEnabled({ LONG_OPS_ASYNC: "0" })).toBe(false);
    expect(longOpsAsyncEnabled({ LONG_OPS_ASYNC: "false" })).toBe(false);
    expect(longOpsAsyncEnabled({ LONG_OPS_ASYNC: "off" })).toBe(false);
    expect(longOpsAsyncEnabled({ AI_ASYNC: "0" } as NodeJS.ProcessEnv)).toBe(true);
  });
});
