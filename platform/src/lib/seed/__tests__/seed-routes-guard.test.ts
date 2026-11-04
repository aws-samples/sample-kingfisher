// @kf-batch 50-CAPSEED-seed-dispatch
// 造数入口的**权限 / 落点**判据(真跑路由):只 mock 身份守卫(登录 / 项目成员是外部事实)、调度对象的读写(DDB 边界)与审计落库。
// 🔴 钉:① 「立即造数」与「启停定时造数」只许平台管理员(编辑者 403,且**什么都不做**);
//        ② 「立即造数」不点名执行范围 ⇒ 400(绝不默认主控区);③ 管理员启停走唯一作者 setActionScheduleEnabled。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  admin: false,
  setCalls: [] as unknown[],
  row: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/projects/guard", () => {
  const ctx = () => ({ projectId: "p1", identity: { sub: "u1", username: "alice", isPlatformAdmin: h.admin } });
  return { requireProject: vi.fn(async () => ctx()), guardResourceAccess: vi.fn(async () => ctx()) };
});
vi.mock("@/lib/scheduler/action-schedules", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getActionSchedule: vi.fn(async () => h.row),
  setActionScheduleEnabled: vi.fn(async (...a: unknown[]) => {
    h.setCalls.push(a);
    return { enabled: true, cronExpression: "0 2 * * 0", dagId: "bgp_act_x" };
  }),
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}), writeAuditRecord: vi.fn(async () => {}) }));

import { POST as enablePost } from "@/app/api/schedule/enable/route";
import { POST as seedRunPost } from "@/app/api/seed/run/route";

const req = (url: string, body: unknown) =>
  new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  h.admin = false;
  h.setCalls.length = 0;
  h.row = {
    userId: "default-user", taskId: "seedsch_01X", kind: "seed", name: "周造数", projectId: "p1", targets: ["tgt_usw2_a"],
    action: "seed.run-once", params: { dataset: "gamedata" }, cronExpression: "0 2 * * 0", scheduleEnabled: false,
    ownerSub: "u0", ownerUsername: "admin",
  };
});

describe("CAP-SEED 入口权限 / 落点", () => {
  it("启停定时造数:非平台管理员 ⇒ 403,且没碰载体", async () => {
    const r = await enablePost(req("http://x/api/schedule/enable", { taskId: "seedsch_01X", taskType: "seed", cronExpression: "0 2 * * 0", enabled: true }));
    expect(r.status).toBe(403);
    expect(h.setCalls).toEqual([]);
  });

  it("启停定时造数:平台管理员 ⇒ 走唯一作者 setActionScheduleEnabled", async () => {
    h.admin = true;
    const r = await enablePost(req("http://x/api/schedule/enable", { taskId: "seedsch_01X", taskType: "seed", cronExpression: "0 2 * * 0", enabled: true }));
    expect(r.status).toBe(200);
    expect(h.setCalls).toHaveLength(1);
  });

  it("taskType 与行的种类对不上 ⇒ 404(不许拿治理的启停口子开造数的载体)", async () => {
    h.admin = true;
    const r = await enablePost(req("http://x/api/schedule/enable", { taskId: "seedsch_01X", taskType: "governance", enabled: true, cronExpression: "0 2 * * 0" }));
    expect(r.status).toBe(404);
    expect(h.setCalls).toEqual([]);
  });

  it("立即造数:非平台管理员 ⇒ 403", async () => {
    const r = await seedRunPost(req("http://x/api/seed/run", { targetId: "tgt_usw2_a", dataset: "gamedata" }));
    expect(r.status).toBe(403);
  });

  it("立即造数:不点名执行范围 ⇒ 400(绝不默认主控区)", async () => {
    h.admin = true;
    const r = await seedRunPost(req("http://x/api/seed/run", { dataset: "gamedata" }));
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).toContain("不会默认主控区");
  });
});
