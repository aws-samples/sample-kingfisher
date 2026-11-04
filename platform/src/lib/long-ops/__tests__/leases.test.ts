// 对象租约判据(55 DESIGN §2.8):占 / 冲突 409 / 回滚 / 死租约自愈(holder 终态 · 超天花板 · 建行宽限)/ 终态释放(三条终态写)/
// 路由守卫 resourceBusyResponse / 驱动器两条路径先占租约。只 mock 真外部 DynamoDB(内存夹具按真条件表达式求值,Put / Delete 条件也真判)。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.hoisted(() => { process.env.LONG_OPS_STALE_MS = "50"; process.env.LONG_OPS_MAX_MS = "200"; process.env.LONG_OPS_HEARTBEAT_MS = "5"; });
vi.mock("@/lib/aws/dynamodb", () => import("./fixtures/mem-long-ops"));
import { rows, resetMemLongOps } from "./fixtures/mem-long-ops";
import {
  CEILING_MS, LEASE_HOLDER_GRACE_MS, LEASE_PK_PREFIX, LONG_OP_IN_PROGRESS_CODE, LongOpHttpError,
  acquireLeases, assertResourcesFree, releaseLeases, createLongOp, claimForRun, markSucceeded, markFailed, forceTimeoutIfExpired,
} from "../store";
import { submitLongOp, longOpErrorResponse } from "../driver";
import { resourceBusyResponse } from "../guard";
import { LONG_OP_KINDS, resourceKey } from "../kinds";
import type { LongOpExecContext, LongOpExecutorRegistry, LongOpExecOutput } from "../executor-types";

const CT = resourceKey("codetable", "ct1");
const DIM = resourceKey("dimension", "mt1");
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const leaseRow = (resource: string) => rows.get(LEASE_PK_PREFIX + resource);

async function expect409(promise: Promise<unknown>): Promise<LongOpHttpError> {
  let caught: unknown;
  try { await promise; } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(LongOpHttpError);
  const err = caught as LongOpHttpError;
  expect(err.status).toBe(409);
  expect(err.code).toBe(LONG_OP_IN_PROGRESS_CODE);
  return err;
}

beforeEach(() => resetMemLongOps());

describe("租约 store:占 / 冲突 / 回滚", () => {
  it("占到 ⇒ lease#<资源> 行(holder / kind / acquiredAt);同对象第二个 holder ⇒ 409 LONG_OP_IN_PROGRESS,文案带标签与「正在进行中」,detail 指回占住者", async () => {
    await createLongOp({ taskId: "t1", kind: "modeling-land", params: { codeTableId: "ct1", force: false, probeOnly: false }, userId: "u1" });
    await acquireLeases("t1", "modeling-land", [CT]);
    expect(leaseRow(CT)).toMatchObject({ resource: CT, holder: "t1", kind: "modeling-land" });
    const err = await expect409(acquireLeases("t2", "modeling-unbind", [CT]));
    expect(err.message).toMatch(/「码表落地到执行区」正在进行中.已 \d+ 秒.,请等它结束后再操作/);
    expect(err.detail).toMatchObject({ taskId: "t1", kind: "modeling-land", resource: CT });
    expect(leaseRow(CT)!.holder, "被拒者不许覆盖").toBe("t1");
  });

  it("多资源按字典序占;中途撞上 ⇒ 已占的全部回滚", async () => {
    await createLongOp({ taskId: "t1", kind: "modeling-apply", params: { modelTableId: "mt1", force: false, probeOnly: false }, userId: "u1" });
    await acquireLeases("t1", "modeling-apply", [DIM]);
    await expect409(acquireLeases("t2", "approval-execute-ddl", [DIM, CT, "table:tgt_home:s.t"]));
    expect(leaseRow(CT), "codetable 排在 dimension 前面已占过,必须回滚").toBeUndefined();
    expect(leaseRow("table:tgt_home:s.t")).toBeUndefined();
    expect(leaseRow(DIM)!.holder).toBe("t1");
  });

  it("空数组 = 无需租约;releaseLeases 只删自己名下的(条件 holder=:h),幂等", async () => {
    await acquireLeases("t1", "copilot-ask", []);
    expect([...rows.keys()].filter((k) => k.startsWith(LEASE_PK_PREFIX))).toEqual([]);
    await createLongOp({ taskId: "t1", kind: "modeling-land", params: { codeTableId: "ct1", force: false, probeOnly: false }, userId: "u1" });
    await acquireLeases("t1", "modeling-land", [CT]);
    await releaseLeases("someone-else", [CT]);
    expect(leaseRow(CT)!.holder).toBe("t1");
    await releaseLeases("t1", [CT]);
    await releaseLeases("t1", [CT]);
    expect(leaseRow(CT)).toBeUndefined();
  });
});

describe("租约 store:死租约自愈(不靠时钟,靠 holder 的真状态)", () => {
  it("holder 已终态 ⇒ 视为已释放:新 holder 占到并覆盖", async () => {
    rows.set("t-old", { taskId: "t-old", kind: "modeling-land", status: "succeeded", createdAt: isoAgo(5_000), startedAt: isoAgo(5_000), finishedAt: isoAgo(1_000) });
    rows.set(LEASE_PK_PREFIX + CT, { taskId: LEASE_PK_PREFIX + CT, resource: CT, holder: "t-old", kind: "modeling-land", acquiredAt: isoAgo(5_000), ttl: 0 });
    await acquireLeases("t-new", "modeling-unbind", [CT]);
    expect(leaseRow(CT)).toMatchObject({ holder: "t-new", kind: "modeling-unbind" });
  });

  it("holder 行 running 但已超天花板 ⇒ 顺手强制 timeout 并放开;running 且未超天花板(即便心跳 stale)⇒ 仍占着", async () => {
    rows.set("t-dead", { taskId: "t-dead", kind: "modeling-land", status: "running", runToken: "tok", createdAt: isoAgo(CEILING_MS + 100), startedAt: isoAgo(CEILING_MS + 100), heartbeatAt: isoAgo(CEILING_MS + 100) });
    rows.set(LEASE_PK_PREFIX + CT, { taskId: LEASE_PK_PREFIX + CT, resource: CT, holder: "t-dead", kind: "modeling-land", acquiredAt: isoAgo(CEILING_MS + 100), ttl: 0 });
    await acquireLeases("t-new", "modeling-land", [CT]);
    expect(leaseRow(CT)!.holder).toBe("t-new");
    expect(rows.get("t-dead")!.status, "超天花板的 holder 被如实判 timeout(绝不重跑)").toBe("timeout");

    rows.set("t-live", { taskId: "t-live", kind: "modeling-apply", status: "running", runToken: "tok", createdAt: isoAgo(100), startedAt: isoAgo(100), heartbeatAt: isoAgo(90) });
    rows.set(LEASE_PK_PREFIX + DIM, { taskId: LEASE_PK_PREFIX + DIM, resource: DIM, holder: "t-live", kind: "modeling-apply", acquiredAt: isoAgo(100), ttl: 0 });
    const err = await expect409(acquireLeases("t-x", "modeling-apply", [DIM]));
    expect(err.message).toContain("「维表应用到执行区」正在进行中");
  });

  it("holder 行不存在:建行宽限内算占着(驱动器先占后建行);超宽限 ⇒ 死租约放开", async () => {
    rows.set(LEASE_PK_PREFIX + CT, { taskId: LEASE_PK_PREFIX + CT, resource: CT, holder: "t-fresh", kind: "modeling-land", acquiredAt: isoAgo(1_000), ttl: 0 });
    await expect409(acquireLeases("t-x", "modeling-land", [CT]));
    rows.set(LEASE_PK_PREFIX + CT, { taskId: LEASE_PK_PREFIX + CT, resource: CT, holder: "t-gone", kind: "modeling-land", acquiredAt: isoAgo(LEASE_HOLDER_GRACE_MS + 1_000), ttl: 0 });
    await acquireLeases("t-x", "modeling-land", [CT]);
    expect(leaseRow(CT)!.holder).toBe("t-x");
  });
});

describe("租约 store:终态释放(三条终态写都释放;条件写失败不释放别人的)", () => {
  async function held(taskId: string) {
    await acquireLeases(taskId, "modeling-land", [CT]);
    await createLongOp({ taskId, leases: [CT], kind: "modeling-land", params: { codeTableId: "ct1", force: false, probeOnly: false }, userId: "u1" });
    expect(rows.get(taskId)!.leases).toEqual([CT]);
    return (await claimForRun(taskId))!;
  }
  it("markSucceeded ⇒ 租约删", async () => {
    const tok = await held("t1");
    await markSucceeded("t1", tok, { ok: true });
    expect(leaseRow(CT)).toBeUndefined();
  });
  it("markFailed ⇒ 租约删;被取代的旧 token 写不进 ⇒ 不释放", async () => {
    const tok = await held("t1");
    expect(await markFailed("t1", "stale-token", { error: "x" })).toBe(false);
    expect(leaseRow(CT)!.holder).toBe("t1");
    await markFailed("t1", tok, { error: "boom", errorStatus: 400 });
    expect(leaseRow(CT)).toBeUndefined();
  });
  it("forceTimeoutIfExpired(reconcile 侧,无 owner)⇒ 租约删", async () => {
    await held("t1");
    rows.get("t1")!.startedAt = isoAgo(CEILING_MS + 10);
    expect(await forceTimeoutIfExpired("t1")).toBe(true);
    expect(leaseRow(CT)).toBeUndefined();
  });
});

describe("租约:路由守卫 assertResourcesFree / resourceBusyResponse", () => {
  it("没人占 ⇒ 过;占着 ⇒ 409 响应(信封 code LONG_OP_IN_PROGRESS);死租约 ⇒ 顺手清掉并放行", async () => {
    expect(await resourceBusyResponse([CT])).toBeNull();
    await createLongOp({ taskId: "t1", kind: "modeling-land", params: { codeTableId: "ct1", force: false, probeOnly: false }, userId: "u1" });
    await claimForRun("t1");
    await acquireLeases("t1", "modeling-land", [CT]);
    const res = await resourceBusyResponse([CT]);
    expect(res!.status).toBe(409);
    const body = await res!.json();
    expect(body).toMatchObject({ success: false, error: { code: LONG_OP_IN_PROGRESS_CODE } });
    expect(body.error.message).toMatch(/「码表落地到执行区」正在进行中/);
    await expect409(assertResourcesFree([CT]));
    rows.get("t1")!.status = "failed";
    await assertResourcesFree([CT]);
    expect(leaseRow(CT), "死租约被守卫顺手清掉").toBeUndefined();
  });
});

function registry(impl: (params: unknown, ctx: LongOpExecContext) => Promise<LongOpExecOutput>): LongOpExecutorRegistry {
  return Object.fromEntries(LONG_OP_KINDS.map((kind) => [kind, impl])) as unknown as LongOpExecutorRegistry;
}
function ctxOf(): LongOpExecContext {
  const req = new NextRequest("http://x/api/modeling/codetables/ct1/land", { method: "POST", headers: { authorization: "Bearer tok-1" } });
  return { req, identity: { sub: "u1", username: "u1", groups: [] } as unknown as LongOpExecContext["identity"] };
}
const LAND = { kind: "modeling-land" as const, params: { codeTableId: "ct1", targets: ["tgt_usw2_a"], force: false, probeOnly: false } };

describe("租约:驱动器 submitLongOp 先占租约", () => {
  it("同一码表并发两次落地:第一次 202 执行中;第二次**同步** 409(不建第二行);解绑预览(无租约)照常;第一次终态后租约放开、第三次成功", async () => {
    const reg = registry(async () => { await sleep(150); return { data: { landed: true } }; });
    const ctx = ctxOf();
    const first = await submitLongOp(LAND, ctx, { registry: reg, waitMs: 20 });
    expect(first.mode).toBe("async");
    const taskRowsBefore = [...rows.keys()].filter((k) => !k.startsWith(LEASE_PK_PREFIX)).length;
    const err = await expect409(submitLongOp(LAND, ctx, { registry: reg, waitMs: 20 }));
    expect(err.detail).toMatchObject({ taskId: (first as { taskId: string }).taskId, kind: "modeling-land" });
    expect([...rows.keys()].filter((k) => !k.startsWith(LEASE_PK_PREFIX)).length, "被拒不建任务行").toBe(taskRowsBefore);
    const preview = await submitLongOp({ kind: "modeling-unbind-preview", params: { entity: "codetable", id: "ct1", targetId: "tgt_usw2_a" } }, ctx, { registry: reg, waitMs: 500 });
    expect(preview.mode).toBe("sync");
    await sleep(250);
    expect(leaseRow(CT)).toBeUndefined();
    const third = await submitLongOp(LAND, ctx, { registry: reg, waitMs: 500 });
    expect(third.mode).toBe("sync");
    expect(longOpErrorResponse(err)!.status).toBe(409);
  });

  it("执行体抛错 ⇒ 终态 failed ⇒ 租约同样放开", async () => {
    const reg = registry(async () => { throw new LongOpHttpError(400, "坏参数"); });
    await expect(submitLongOp(LAND, ctxOf(), { registry: reg, waitMs: 500 })).rejects.toBeInstanceOf(LongOpHttpError);
    expect(leaseRow(CT)).toBeUndefined();
  });

  it("LONG_OPS_ASYNC=0 纯同步路径:执行期间租约在(holder 以 sync-only- 开头),执行完释放", async () => {
    let seenHolder: string | undefined;
    const reg = registry(async () => { seenHolder = leaseRow(CT)?.holder; return { data: { ok: true } }; });
    const out = await submitLongOp(LAND, ctxOf(), { registry: reg, env: { LONG_OPS_ASYNC: "0" } as NodeJS.ProcessEnv });
    expect(out.mode).toBe("sync");
    expect(seenHolder).toMatch(/^sync-only-/);
    expect(leaseRow(CT)).toBeUndefined();
  });
});
