// @kf-batch 50-B51-backfill-pump
// 内部推进端点:只收补数推进泵这一个来源;推进调的是与页面**同一个** tick;计划不存在 ⇒ 404 不推。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  verdict: { ok: true } as Record<string, unknown>,
  expected: [] as unknown[],
  ticks: [] as Array<[string, string]>,
  plan: {} as Record<string, unknown> | null,
}));
vi.mock("@/lib/scheduler/internal-guard", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    verifyInternalCaller: vi.fn(async (_h: Headers, opts: unknown) => {
      h.expected.push(opts);
      return h.verdict;
    }),
  };
});
vi.mock("@/lib/audit", () => ({ writeAuditRecord: vi.fn(async () => undefined) }));
vi.mock("@/lib/backfill/runner", () => ({
  tick: vi.fn(async (p: string, id: string) => {
    h.ticks.push([p, id]);
    return { planStatus: "running", progress: {}, submitted: 1, running: 1 };
  }),
}));
vi.mock("@/lib/backfill/service", () => ({ getPlan: vi.fn(async () => h.plan) }));

const { POST } = await import("../tick/route");
const { INTERNAL_SOURCE_BACKFILL_PUMP } = await import("@/lib/scheduler/internal-source");
const call = (body: unknown) =>
  POST(new NextRequest("http://self:3000/api/internal/backfill/tick", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  h.verdict = { ok: true };
  h.expected = [];
  h.ticks = [];
  h.plan = { planId: "01A" };
});

describe("POST /api/internal/backfill/tick", () => {
  it("只认补数推进泵这个来源,并调同一个 tick(projectId, planId)", async () => {
    const r = await call({ projectId: "proj-a", planId: "01A" });
    expect(r.status).toBe(200);
    expect(h.expected).toEqual([{ expectedSource: INTERNAL_SOURCE_BACKFILL_PUMP }]);
    expect(h.ticks).toEqual([["proj-a", "01A"]]);
  });
  it("守卫拒绝 ⇒ 原样回状态码,不推进", async () => {
    h.verdict = { ok: false, status: 403, reason: "x" };
    const r = await call({ projectId: "proj-a", planId: "01A" });
    expect(r.status).toBe(403);
    expect(h.ticks).toEqual([]);
  });
  it("缺参 / 非法 ⇒ 400 不推进", async () => {
    expect((await call({ projectId: "proj-a" })).status).toBe(400);
    expect((await call({ projectId: "a b", planId: "01A" })).status).toBe(400);
    expect(h.ticks).toEqual([]);
  });
  it("计划不存在 ⇒ 404 不推进", async () => {
    h.plan = null;
    expect((await call({ projectId: "proj-a", planId: "01Z" })).status).toBe(404);
    expect(h.ticks).toEqual([]);
  });
});
