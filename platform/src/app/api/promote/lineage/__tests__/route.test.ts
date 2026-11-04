// GET /api/promote/lineage 路由判据:参数校验 / 404 / 只读守卫 viewer / 透传 lineageStatus。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const svc = { lineageStatus: vi.fn() };
const vs = { loadResource: vi.fn() };
const guard = { guardResourceAccess: vi.fn() };
vi.mock("@/lib/env/promote-service", () => ({ lineageStatus: (...a: unknown[]) => svc.lineageStatus(...a) }));
vi.mock("@/lib/versions/version-service", () => ({
  isResourceType: (v: unknown) => ["workflow", "etl-job", "sync", "redshift-task", "engine-job"].includes(String(v)),
  loadResource: (...a: unknown[]) => vs.loadResource(...a),
}));
vi.mock("@/lib/projects/guard", () => ({ guardResourceAccess: (...a: unknown[]) => guard.guardResourceAccess(...a) }));

import { GET } from "../route";

const req = (qs: string) => new NextRequest(`http://localhost/api/promote/lineage${qs}`);

beforeEach(() => {
  svc.lineageStatus.mockReset(); vs.loadResource.mockReset(); guard.guardResourceAccess.mockReset();
  guard.guardResourceAccess.mockResolvedValue({ identity: { username: "u" } });
});

describe("GET /api/promote/lineage", () => {
  it("缺 / 非法 type、缺 id ⇒ 400,且不碰库", async () => {
    expect((await GET(req("?type=nope&id=x"))).status).toBe(400);
    expect((await GET(req("?type=etl-job"))).status).toBe(400);
    expect(vs.loadResource).not.toHaveBeenCalled();
  });
  it("资源不存在 ⇒ 404", async () => {
    vs.loadResource.mockResolvedValue(null);
    expect((await GET(req("?type=etl-job&id=j1"))).status).toBe(404);
    expect(svc.lineageStatus).not.toHaveBeenCalled();
  });
  it("守卫以 viewer 判(只读),守卫拒 ⇒ 原样返回它的响应", async () => {
    vs.loadResource.mockResolvedValue({ jobId: "j1", projectId: "p" });
    guard.guardResourceAccess.mockResolvedValue(NextResponse.json({ success: false }, { status: 403 }));
    const res = await GET(req("?type=etl-job&id=j1"));
    expect(res.status).toBe(403);
    expect(guard.guardResourceAccess).toHaveBeenCalledWith(expect.anything(), { jobId: "j1", projectId: "p" }, "viewer");
    expect(svc.lineageStatus).not.toHaveBeenCalled();
  });
  it("通过 ⇒ 200,data 就是 lineageStatus 的返回", async () => {
    vs.loadResource.mockResolvedValue({ jobId: "j1", projectId: "p" });
    svc.lineageStatus.mockResolvedValue({ lineageId: "j1", envs: [{ env: "dev", id: "j1", current: true }] });
    const res = await GET(req("?type=etl-job&id=j1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.envs[0]).toMatchObject({ env: "dev", current: true });
    expect(svc.lineageStatus).toHaveBeenCalledWith("etl-job", "j1");
  });
});
