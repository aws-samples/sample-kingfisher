// 内部评估端点:只收告警 / SLA 评估泵这一个来源;评估调的是执行体 alertingTick(规则评估 = 页面同一个 evaluate);项目不存在 ⇒ 404 不评估。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  verdict: { ok: true } as Record<string, unknown>,
  expected: [] as unknown[],
  ticks: [] as string[],
  project: {} as Record<string, unknown> | null,
  audits: [] as string[],
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
vi.mock("@/lib/audit", () => ({ writeAuditRecord: vi.fn(async (_a: unknown, action: string) => { h.audits.push(action); }) }));
vi.mock("@/lib/alerting/tick", () => ({
  alertingTick: vi.fn(async (p: string) => {
    h.ticks.push(p);
    return { rulesEvaluated: 1, runsScanned: 3, newEvents: 1, slas: 1, runsPredicted: 1, breachAlerts: 0, slaErrors: 0 };
  }),
}));
vi.mock("@/lib/projects/project-service", () => ({ getProject: vi.fn(async () => h.project) }));

const { POST } = await import("../tick/route");
const { INTERNAL_SOURCE_ALERTING_PUMP } = await import("@/lib/scheduler/internal-source");
const call = (body: unknown) =>
  POST(new NextRequest("http://self:3000/api/internal/alerting/tick", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  h.verdict = { ok: true };
  h.expected = [];
  h.ticks = [];
  h.audits = [];
  h.project = { projectId: "proj-a" };
});

describe("POST /api/internal/alerting/tick", () => {
  it("只认评估泵这个来源,并调执行体 alertingTick(projectId),回它的汇总", async () => {
    const r = await call({ projectId: "proj-a" });
    expect(r.status).toBe(200);
    expect(h.expected).toEqual([{ expectedSource: INTERNAL_SOURCE_ALERTING_PUMP }]);
    expect(h.ticks).toEqual(["proj-a"]);
    expect((await r.json()).data).toMatchObject({ newEvents: 1, runsPredicted: 1 });
  });
  it("守卫拒绝 ⇒ 原样回状态码、留审计痕,不评估", async () => {
    h.verdict = { ok: false, status: 403, reason: "x" };
    const r = await call({ projectId: "proj-a" });
    expect(r.status).toBe(403);
    expect(h.ticks).toEqual([]);
    expect(h.audits).toEqual(["internal.alerting.denied"]);
  });
  it("缺参 / 非法 ⇒ 400 不评估", async () => {
    expect((await call({})).status).toBe(400);
    expect((await call({ projectId: "a b" })).status).toBe(400);
    expect(h.ticks).toEqual([]);
  });
  it("项目不存在 ⇒ 404 不评估", async () => {
    h.project = null;
    expect((await call({ projectId: "proj-z" })).status).toBe(404);
    expect(h.ticks).toEqual([]);
  });
});
