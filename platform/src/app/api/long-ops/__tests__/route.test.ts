// GET /api/long-ops/[taskId] 判据(= ai/tasks route.test 泛化):鉴权 / 归属 / 抢占驱动 / 重认领 / 天花板强制 timeout /
// 终态字段(result · resultStatus · errorStatus · errorBody · label)/ 终态顶层 `_meta` / 别名路由同一 handler。
// 只 mock 真外部:DynamoDB(内存夹具,条件写按真表达式求值)、身份、执行体注册表(业务侧)。表服务层与驱动器用真代码。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  who: { sub: "u1", username: "u1", groups: [] } as null | Record<string, unknown>,
  execCalls: 0,
  exec: null as null | ((params: unknown, ctx: unknown) => Promise<{ data: unknown; meta?: unknown; resultStatus?: number }>),
}));
vi.hoisted(() => { process.env.LONG_OPS_STALE_MS = "50"; process.env.LONG_OPS_MAX_MS = "200"; });
vi.mock("@/lib/aws/dynamodb", () => import("@/lib/long-ops/__tests__/fixtures/mem-long-ops"));
vi.mock("@/lib/auth/identity", () => ({
  requireIdentity: vi.fn(async () => h.who ?? new Response(JSON.stringify({ success: false, error: { message: "未认证" } }), { status: 401 })),
}));
vi.mock("@/lib/long-ops/registry", async () => {
  const { LONG_OP_KINDS } = await import("@/lib/long-ops/kinds");
  const run = async (params: unknown, ctx: unknown) => {
    h.execCalls++;
    return h.exec ? h.exec(params, ctx) : { data: { codeTableId: "ct1", landedByTarget: { tgt_usw2_a: { status: "ok" } } } };
  };
  return { LONG_OP_EXECUTORS: Object.fromEntries(LONG_OP_KINDS.map((kind) => [kind, run])) };
});

import { rows, resetMemLongOps } from "@/lib/long-ops/__tests__/fixtures/mem-long-ops";
import { createLongOp, claimForRun, markFailed, markSucceeded, CEILING_MS, STALE_MS, LONG_OP_TIMEOUT_ERROR } from "@/lib/long-ops/store";
import { GET } from "../[taskId]/route";
import { GET as ALIAS_GET } from "@/app/api/ai/tasks/[taskId]/route";

const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const get = (taskId: string) => GET(new NextRequest(`http://x/api/long-ops/${taskId}`, { headers: { authorization: "Bearer t", "x-correlation-id": "corr-get" } }), { params: { taskId } });
async function body(res: Response) { return res.json(); }
async function pendingLand(correlationId = "corr-post-1") {
  return createLongOp({ kind: "modeling-land", params: { codeTableId: "ct1", targets: ["tgt_usw2_a"], force: false, probeOnly: false }, userId: "u1", correlationId });
}
async function waitUntil(pred: () => boolean, budgetMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!pred()) { if (Date.now() - started > budgetMs) throw new Error("waitUntil 超时"); await sleep(5); }
}

beforeEach(() => { resetMemLongOps(); h.who = { sub: "u1", username: "u1", groups: [] }; h.execCalls = 0; h.exec = null; });

describe("GET /api/long-ops/[taskId]", () => {
  it("未认证 ⇒ 401;不存在 ⇒ 404 NOT_FOUND;别人的任务 ⇒ 403 RBAC_DENIED(都不触发执行)", async () => {
    const row = await pendingLand();
    h.who = null;
    expect((await get(row.taskId)).status).toBe(401);
    h.who = { sub: "u1", username: "u1", groups: [] };
    const nf = await get("nope");
    expect(nf.status).toBe(404);
    expect((await body(nf)).error.code).toBe("NOT_FOUND");
    h.who = { sub: "someone-else", username: "x", groups: [] };
    const forbidden = await get(row.taskId);
    expect(forbidden.status).toBe(403);
    expect((await body(forbidden)).error.code).toBe("RBAC_DENIED");
    expect(h.execCalls).toBe(0);
  });

  it("pending ⇒ 本次 GET 抢占并后台驱动(立即回 running);随后终态 succeeded:result / label / elapsedMs,无 meta.model 时无 _meta", async () => {
    const row = await pendingLand();
    const res = await get(row.taskId);
    expect(res.status).toBe(200);
    expect((await body(res)).data).toMatchObject({ taskId: row.taskId, kind: "modeling-land", label: "码表落地到执行区", status: "running" });
    await waitUntil(() => rows.get(row.taskId)!.status === "succeeded");
    expect(h.execCalls).toBe(1);
    const done = await body(await get(row.taskId));
    expect(done.data).toMatchObject({ status: "succeeded", result: { codeTableId: "ct1" } });
    expect(done.data.resultStatus).toBeUndefined();
    expect(done._meta).toBeUndefined();
  });

  it("终态 succeeded 带 meta.model ⇒ 顶层 _meta(模型 + 提交那次的 correlationId);resultStatus 201 回显", async () => {
    const row = await createLongOp({ kind: "flink-ai-sql", params: { prompt: "p", sinkType: "s3" }, userId: "u1", correlationId: "corr-post-9" });
    const token = (await claimForRun(row.taskId))!;
    await markSucceeded(row.taskId, token, { sql: "x" }, { meta: { model: { modelId: "us.moonshotai.kimi-k3", modelSource: "runtime" } }, resultStatus: 201 });
    const done = await body(await get(row.taskId));
    expect(done.data).toMatchObject({ status: "succeeded", result: { sql: "x" }, resultStatus: 201 });
    expect(done._meta).toMatchObject({ modelId: "us.moonshotai.kimi-k3", modelSource: "runtime", correlationId: "corr-post-9" });
  });

  it("终态 succeeded 且行 resultRaw(编排四条)⇒ 回显 resultRaw: true(客户端据此不包信封);不标的行不回显", async () => {
    const row = await createLongOp({ kind: "workflow-publish", params: { workflowId: "wf1" }, userId: "u1", correlationId: "corr-post-raw" });
    const token = (await claimForRun(row.taskId))!;
    await markSucceeded(row.taskId, token, { success: true, dagId: "bgp_wf1" }, { resultRaw: true });
    const done = await body(await get(row.taskId));
    expect(done.data).toMatchObject({ status: "succeeded", result: { success: true, dagId: "bgp_wf1" }, resultRaw: true });
    const plain = await createLongOp({ kind: "flink-ai-sql", params: { prompt: "p", sinkType: "s3" }, userId: "u1", correlationId: "corr-post-10" });
    const token2 = (await claimForRun(plain.taskId))!;
    await markSucceeded(plain.taskId, token2, { sql: "x" });
    expect((await body(await get(plain.taskId))).data.resultRaw).toBeUndefined();
  });

  it("终态 failed ⇒ 200 + status failed + error / errorStatus / errorBody 原样(失败是任务的终态,不是轮询请求的失败)", async () => {
    const row = await pendingLand();
    const token = (await claimForRun(row.taskId))!;
    const errorBody = { success: false, error: { message: "执行环境 tgt_usw2_a 现在不能承接:冷", code: "CONFLICT" } };
    await markFailed(row.taskId, token, { error: "执行环境 tgt_usw2_a 现在不能承接:冷", errorStatus: 409, errorBody });
    const res = await get(row.taskId);
    expect(res.status).toBe(200);
    expect((await body(res)).data).toMatchObject({ status: "failed", error: "执行环境 tgt_usw2_a 现在不能承接:冷", errorStatus: 409, errorBody });
  });

  it("running + 心跳 stale ⇒ 重认领并由本进程接管(执行一次);running + 心跳新鲜 ⇒ 只回 running 不执行", async () => {
    const row = await pendingLand();
    const token = (await claimForRun(row.taskId))!;
    expect(token).toBeTruthy();
    const fresh = await body(await get(row.taskId));
    expect(fresh.data.status).toBe("running");
    expect(h.execCalls).toBe(0);
    rows.get(row.taskId)!.heartbeatAt = isoAgo(STALE_MS + 10);
    const res = await body(await get(row.taskId));
    expect(res.data.status).toBe("running");
    await waitUntil(() => rows.get(row.taskId)!.status === "succeeded");
    expect(h.execCalls).toBe(1);
    expect(rows.get(row.taskId)!.runToken).not.toBe(token);
  });

  it("running 超过 300s 天花板 ⇒ forceTimeoutIfExpired,回 timeout(LONG_OP_TIMEOUT),绝不重跑", async () => {
    const row = await pendingLand();
    await claimForRun(row.taskId);
    rows.get(row.taskId)!.startedAt = isoAgo(CEILING_MS + 10);
    rows.get(row.taskId)!.heartbeatAt = isoAgo(CEILING_MS + 10);
    const res = await body(await get(row.taskId));
    expect(res.data).toMatchObject({ status: "timeout", error: LONG_OP_TIMEOUT_ERROR });
    expect(rows.get(row.taskId)!.status).toBe("timeout");
    await sleep(20);
    expect(h.execCalls).toBe(0);
  });

  it("别名 GET /api/ai/tasks/[taskId] 是同一个 handler(过渡,下一发版删)", async () => {
    expect(ALIAS_GET).toBe(GET);
  });
});
