// 删除执行环境的审批(ED-B3 的路由半边):钉住用户可见的结果
//   · 只有平台管理员能批 / 驳(本项目 owner ∧ 研发经理也不行)⇒ 否则 403,且审批单一个字没动;
//   · 批准前**零写**预检:影响清单漂移 ⇒ 409,审批单保持待审(决策一次都没发);
//   · 批准 ⇒ 决策落库 + 起销毁;起不来 ⇒ 审批照样成立,响应里说清「去重试销毁」;驳回 ⇒ 不预检、不起销毁;
//   · 通用 POST /api/approvals 不许伪造一张删除审批单;收件箱只给平台管理员看这类单。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  admin: true,
  approvals: [] as any[],
  decided: [] as any[],
  created: [] as any[],
  preflight: null as null | Error,
  started: [] as any[],
  startError: null as null | Error,
  audits: [] as any[],
}));

vi.mock("@/lib/projects/guard", () => ({
  requireProjectConfigAdmin: async () => ({ identity: { username: h.admin ? "platform-admin" : "mgr-owner", isPlatformAdmin: h.admin, groups: h.admin ? ["bgp-admin"] : ["bgp-manager"] }, projectId: "proj-default", role: "owner" }),
}));
vi.mock("@/lib/auth/identity", () => ({
  resolveIdentity: async () => ({ username: h.admin ? "platform-admin" : "mgr-owner", sub: "s", isPlatformAdmin: h.admin, groups: h.admin ? ["bgp-admin"] : ["bgp-manager"] }),
}));
vi.mock("@/lib/projects/project-service", () => ({
  getApproval: async (id: string) => h.approvals.find((a) => a.approvalId === id) ?? null,
  decideApproval: async (id: string, decision: string, by: string) => {
    h.decided.push({ id, decision, by });
    const a = h.approvals.find((x) => x.approvalId === id);
    return a ? { ...a, status: decision, decidedBy: by } : null;
  },
  listApprovals: async () => h.approvals,
  createApproval: async (x: any) => { h.created.push(x); return { approvalId: "new", ...x }; },
  getProject: async () => ({ projectId: "proj-default" }),
  resolveRole: async () => "owner",
  putMember: async () => undefined,
}));
vi.mock("@/lib/exec-env/decommission", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    preflightApprovedDelete: async () => { if (h.preflight) throw h.preflight; return {}; },
    startApprovedDestroy: async (a: any) => { if (h.startError) throw h.startError; h.started.push(a.approvalId); return { buildId: "b1", operationId: "op_1", finalSnapshotName: "bgp-final-tgt-usw2-a-20261011-0000", lockEpoch: 3 }; },
  };
});
vi.mock("@/lib/audit", () => ({ recordAudit: async (_r: unknown, action: string, opts: unknown) => { h.audits.push({ action, opts }); } }));

import { POST as DECIDE } from "@/app/api/approvals/[id]/route";
import { POST as CREATE, GET as INBOX } from "@/app/api/approvals/route";
import { DecommissionRefused } from "@/lib/exec-env/decommission";

const delApproval = () => ({
  approvalId: "A1", projectId: "proj-default", type: "exec-env-delete", status: "pending", requestedBy: "dev-admin",
  payload: { targetId: "tgt_usw2_a", region: "us-west-2", previewHash: "a".repeat(64), snapshot: { counts: { bindings: 0, schedules: 0, runningRuns: 0 }, retained: [] } },
  requestedAt: "2026-10-11T00:00:00.000Z", targetIds: ["tgt_usw2_a"],
});
const decide = (decision: string) =>
  DECIDE(new NextRequest("http://x/api/approvals/A1", { method: "POST", body: JSON.stringify({ decision }), headers: { "Content-Type": "application/json" } }), { params: { id: "A1" } });

beforeEach(() => {
  h.admin = true;
  h.approvals = [delApproval(), { approvalId: "M1", projectId: "proj-default", type: "membership", status: "pending", requestedBy: "u", payload: { role: "viewer" }, requestedAt: "2026-10-10T00:00:00.000Z" }];
  h.decided = []; h.created = []; h.started = []; h.audits = [];
  h.preflight = null; h.startError = null;
});

describe("删除执行环境的审批:只许平台管理员、批前零写预检、批后起销毁", () => {
  it("研发经理 ∧ 项目 owner ⇒ 403,审批单没动", async () => {
    h.admin = false;
    const r = await decide("approve");
    expect(r.status).toBe(403);
    expect(h.decided).toEqual([]);
    expect(h.started).toEqual([]);
  });

  it("预检不过(审批期间影响清单变了)⇒ 409,决策一次都没发", async () => {
    h.preflight = new DecommissionRefused("影响清单在审批期间变了", 409, "PREVIEW_DRIFT");
    const r = await decide("approve");
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("PREVIEW_DRIFT");
    expect(h.decided).toEqual([]);
  });

  it("批准 ⇒ 决策落库 + 起销毁;审计带快照与销毁结果", async () => {
    const r = await decide("approve");
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.data.status).toBe("approved");
    expect(body.data.destroy).toMatchObject({ started: true, buildId: "b1" });
    expect(h.decided).toEqual([{ id: "A1", decision: "approved", by: "platform-admin" }]);
    expect(h.started).toEqual(["A1"]);
    const audit = h.audits.find((a) => a.action === "approval.decide");
    expect(audit.opts.targetId).toBe("tgt_usw2_a");
    expect(audit.opts.detail.snapshot.counts.bindings).toBe(0);
  });

  it("起不来 ⇒ 审批照样成立,响应说清去「重试销毁」", async () => {
    h.startError = new Error("broker 拒绝销毁(locked)");
    const body = await (await decide("approve")).json();
    expect(body.data.status).toBe("approved");
    expect(body.data.destroy).toMatchObject({ started: false });
    expect(body.data.destroy.hint).toMatch(/重试销毁/);
  });

  it("驳回 ⇒ 不预检、不起销毁", async () => {
    h.preflight = new DecommissionRefused("不该被调到", 409, "CONFLICT");
    const r = await decide("reject");
    expect(r.status).toBe(200);
    expect(h.decided[0].decision).toBe("rejected");
    expect(h.started).toEqual([]);
  });

  it("通用入口不许伪造删除审批单;收件箱只给平台管理员看这类单", async () => {
    const r = await CREATE(new NextRequest("http://x/api/approvals", { method: "POST", body: JSON.stringify({ projectId: "proj-default", type: "exec-env-delete" }), headers: { "Content-Type": "application/json" } }));
    expect(r.status).toBe(400);
    expect(h.created).toEqual([]);
    h.admin = false;
    const mgr = await (await INBOX(new NextRequest("http://x/api/approvals"))).json();
    expect(mgr.data.map((a: any) => a.approvalId)).toEqual(["M1"]);
    h.admin = true;
    const adm = await (await INBOX(new NextRequest("http://x/api/approvals"))).json();
    expect(adm.data.map((a: any) => a.approvalId).sort()).toEqual(["A1", "M1"]);
  });
});

