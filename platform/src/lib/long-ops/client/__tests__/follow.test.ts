// 模块 55 — 客户端传输层判据:只认 protocol long-op/1 的 202(GenBI / warming 的 202 原样放行);轮询到终态整形成与同步分支同形的
// Response(succeeded resultStatus / failed errorBody 还原原状态码 / timeout 504);非 JSON 5xx 瞬态继续;服务端 404 / 403 JSON 原样交回;
// 事件三相位;前端预算耗尽 504。零 DOM 依赖(事件经注入的 emit)。
import { describe, it, expect } from "vitest";
import { followLongOp, peekLongOpAccepted, terminalToResponse, LONG_OP_CLIENT_BUDGET_MS, LONG_OP_POLL_MS } from "../follow";
import { LONG_OP_PROTOCOL, LONG_OP_RESPONSE_HEADER, LONG_OP_TIMEOUT_MESSAGE } from "../../protocol";
import type { LongOpEventDetail } from "../events";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
const accepted = { taskId: "01TASK", kind: "modeling-land", label: "码表落地到执行区", status: "running" as const, async: true as const, protocol: LONG_OP_PROTOCOL };
const noSleep = async () => {};

function fetchSeq(responses: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("fetchSeq 用尽");
    return next();
  };
  return { fetchImpl, calls };
}

describe("模块 55 follow:peekLongOpAccepted 只认协议记号", () => {
  it("202 + protocol long-op/1 + taskId ⇒ 载荷;原 Response body 不被消耗", async () => {
    const res = json({ success: true, data: { taskId: "01TASK", kind: "modeling-land", label: "码表落地到执行区", status: "running", async: true, protocol: LONG_OP_PROTOCOL } }, 202);
    expect(await peekLongOpAccepted(res)).toEqual(accepted);
    expect((await res.json()).data.taskId).toBe("01TASK");
  });
  it("GenBI 的 202 `{taskId,status:\"pending\",async:true}`、B-95 的 202 `{status:\"warming\"}`、非 202、非 JSON ⇒ null(原样放行)", async () => {
    expect(await peekLongOpAccepted(json({ success: true, data: { taskId: "g1", status: "pending", async: true } }, 202))).toBeNull();
    expect(await peekLongOpAccepted(json({ success: true, data: { deleted: false, status: "warming", retryAfterMs: 5000 } }, 202))).toBeNull();
    expect(await peekLongOpAccepted(json({ success: true, data: { ...accepted } }, 200))).toBeNull();
    expect(await peekLongOpAccepted(new Response("<html>", { status: 202, headers: { "content-type": "text/html" } }))).toBeNull();
    expect(await peekLongOpAccepted(json({ success: true, data: { protocol: LONG_OP_PROTOCOL } }, 202))).toBeNull();
  });
});

describe("模块 55 follow:终态整形(与同步分支同形)", () => {
  it("succeeded ⇒ resultStatus ?? 200 + `{success:true,data,_meta?}` + 头 x-bgp-long-op", async () => {
    const res = terminalToResponse({ taskId: "01TASK", kind: "catalog-create-table", label: "x", status: "succeeded", result: { kind: "redshift" }, resultStatus: 201, elapsedMs: 5 }, { modelId: "m" });
    expect(res.status).toBe(201);
    expect(res.headers.get(LONG_OP_RESPONSE_HEADER)).toBe("01TASK");
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ success: true, data: { kind: "redshift" }, _meta: { modelId: "m" } });
  });
  it("resultRaw(序 50 第二批,编排四条)⇒ result 就是整个响应体,原样 JSON、不包 {success,data} 信封;resultStatus 缺省 200;头 x-bgp-long-op 照带", async () => {
    const raw = { success: true, dagId: "bgp_wf1", scheduler: "serverless", perTarget: [{ targetId: "tgt_home", ok: true }] };
    const res = terminalToResponse({ taskId: "01TASK", kind: "workflow-publish", label: "发布工作流", status: "succeeded", result: raw, resultRaw: true, elapsedMs: 5 });
    expect(res.status).toBe(200);
    expect(res.headers.get(LONG_OP_RESPONSE_HEADER)).toBe("01TASK");
    expect(await res.json()).toEqual(raw);
    const r207 = terminalToResponse({ taskId: "01TASK", kind: "workflow-unpublish", label: "下线工作流", status: "succeeded", result: raw, resultRaw: true, resultStatus: 207, elapsedMs: 5 });
    expect(r207.status).toBe(207);
    // 对照:同一份 result 不带 resultRaw ⇒ 包进信封(两条路径的区别只在这一位)
    expect(await terminalToResponse({ taskId: "01TASK", kind: "workflow-publish", label: "发布工作流", status: "succeeded", result: raw, elapsedMs: 5 }).json()).toEqual({ success: true, data: raw });
  });
  it("failed 带 errorBody ⇒ errorStatus + 原信封逐字;不带 ⇒ errorStatus ?? 500 + UPSTREAM_ERROR;timeout ⇒ 504 UPSTREAM_TIMEOUT", async () => {
    const body = { success: false, error: { message: "没有可解绑的落地记录", code: "NOT_FOUND", detail: { reason: "nothing-to-unbind" } } };
    const a = terminalToResponse({ taskId: "t", kind: "k", label: "l", status: "failed", error: "没有可解绑的落地记录", errorStatus: 404, errorBody: body, elapsedMs: 1 });
    expect(a.status).toBe(404);
    expect(await a.json()).toEqual(body);
    const b = terminalToResponse({ taskId: "t", kind: "k", label: "l", status: "failed", error: "炸了", elapsedMs: 1 });
    expect(b.status).toBe(500);
    expect(await b.json()).toEqual({ success: false, status: 500, error: { message: "炸了", code: "UPSTREAM_ERROR" } });
    const c = terminalToResponse({ taskId: "t", kind: "k", label: "l", status: "timeout", error: "LONG_OP_TIMEOUT", elapsedMs: 1 });
    expect(c.status).toBe(504);
    expect(await c.json()).toEqual({ success: false, status: 504, error: { message: LONG_OP_TIMEOUT_MESSAGE, code: "UPSTREAM_TIMEOUT" } });
  });
});

describe("模块 55 follow:followLongOp 轮询", () => {
  it("running → running → succeeded:轮询 GET /api/long-ops/<taskId> 带同一套头;事件 started / progress×2 / settled(succeeded);交回 200 同形", async () => {
    const { fetchImpl, calls } = fetchSeq([
      () => json({ success: true, data: { taskId: "01TASK", kind: "modeling-land", label: "l", status: "running", elapsedMs: 2000 } }),
      () => json({ success: true, data: { taskId: "01TASK", kind: "modeling-land", label: "l", status: "running", elapsedMs: 4000 } }),
      () => json({ success: true, data: { taskId: "01TASK", kind: "modeling-land", label: "l", status: "succeeded", result: { codeTableId: "ct1" }, elapsedMs: 6000 } }),
    ]);
    const events: LongOpEventDetail[] = [];
    const res = await followLongOp(accepted, { fetchImpl, headers: { Authorization: "Bearer t", "x-bgp-project": "p1" }, sleep: noSleep, emit: (d) => events.push(d) });
    expect(calls.map((c) => c.url)).toEqual(Array(3).fill("/api/long-ops/01TASK"));
    expect(new Headers(calls[0].init!.headers).get("Authorization")).toBe("Bearer t");
    expect(new Headers(calls[0].init!.headers).get("x-bgp-project")).toBe("p1");
    expect(res.status).toBe(200);
    expect(res.headers.get(LONG_OP_RESPONSE_HEADER)).toBe("01TASK");
    expect(await res.json()).toEqual({ success: true, data: { codeTableId: "ct1" } });
    expect(events.map((e) => e.phase)).toEqual(["started", "progress", "progress", "settled"]);
    expect(events.at(-1)).toMatchObject({ taskId: "01TASK", kind: "modeling-land", label: "码表落地到执行区", outcome: "succeeded" });
    expect(events[1].elapsedMs).toBe(2000);
  });

  it("终态 failed:errorBody 还原原状态码与信封;终态带 _meta 时 succeeded 响应顶层 _meta", async () => {
    const body = { success: false, error: { message: "执行环境 tgt_x 现在不能承接:冷", code: "CONFLICT" } };
    const a = fetchSeq([() => json({ success: true, data: { taskId: "01TASK", kind: "k", label: "l", status: "failed", error: "执行环境 tgt_x 现在不能承接:冷", errorStatus: 409, errorBody: body, elapsedMs: 1 } })]);
    const ra = await followLongOp(accepted, { fetchImpl: a.fetchImpl, sleep: noSleep, emit: () => {} });
    expect(ra.status).toBe(409);
    expect(await ra.json()).toEqual(body);
    const b = fetchSeq([() => json({ success: true, data: { taskId: "01TASK", kind: "flink-ai-sql", label: "l", status: "succeeded", result: { sql: "x" }, elapsedMs: 1 }, _meta: { modelId: "m", correlationId: "c" } })]);
    const rb = await followLongOp(accepted, { fetchImpl: b.fetchImpl, sleep: noSleep, emit: () => {} });
    expect(await rb.json()).toEqual({ success: true, data: { sql: "x" }, _meta: { modelId: "m", correlationId: "c" } });
  });

  it("瞬态:网络抛 / 非 JSON 502 继续轮询;服务端 404 / 403 JSON ⇒ 原信封 + 状态交回(settled aborted);服务端 timeout ⇒ 504", async () => {
    const a = fetchSeq([
      () => { throw new Error("network"); },
      () => new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }),
      () => json({ success: true, data: { taskId: "01TASK", kind: "k", label: "l", status: "succeeded", result: 1, elapsedMs: 1 } }),
    ]);
    expect((await followLongOp(accepted, { fetchImpl: a.fetchImpl, sleep: noSleep, emit: () => {} })).status).toBe(200);
    const b = fetchSeq([() => json({ success: false, error: { message: "任务不存在", code: "NOT_FOUND" } }, 404)]);
    const events: LongOpEventDetail[] = [];
    const rb = await followLongOp(accepted, { fetchImpl: b.fetchImpl, sleep: noSleep, emit: (d) => events.push(d) });
    expect(rb.status).toBe(404);
    expect(await rb.json()).toEqual({ success: false, error: { message: "任务不存在", code: "NOT_FOUND" } });
    expect(events.at(-1)).toMatchObject({ phase: "settled", outcome: "aborted" });
    const c = fetchSeq([() => json({ success: true, data: { taskId: "01TASK", kind: "k", label: "l", status: "timeout", error: "LONG_OP_TIMEOUT", elapsedMs: 300000 } })]);
    const rc = await followLongOp(accepted, { fetchImpl: c.fetchImpl, sleep: noSleep, emit: () => {} });
    expect(rc.status).toBe(504);
    expect((await rc.json()).error.code).toBe("UPSTREAM_TIMEOUT");
  });

  it("前端预算耗尽 ⇒ 504 timeout 同形(settled timeout);缺省轮询 2s / 预算 320s", async () => {
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const { fetchImpl } = fetchSeq(Array.from({ length: 5 }, () => () => json({ success: true, data: { taskId: "01TASK", kind: "k", label: "l", status: "running", elapsedMs: 1 } })));
      const events: LongOpEventDetail[] = [];
      const res = await followLongOp(accepted, { fetchImpl, budgetMs: 100, sleep: async () => { now += 30; }, emit: (d) => events.push(d) });
      expect(res.status).toBe(504);
      expect(events.at(-1)).toMatchObject({ phase: "settled", outcome: "timeout" });
    } finally {
      Date.now = realNow;
    }
    expect(LONG_OP_POLL_MS).toBe(2000);
    expect(LONG_OP_CLIENT_BUDGET_MS).toBe(320_000);
  });
});
