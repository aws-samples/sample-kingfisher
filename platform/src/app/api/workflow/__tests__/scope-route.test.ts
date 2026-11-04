// `GET /api/workflow` 的执行范围过滤。响应是**裸数组**(不是 apiOk 信封),别照抄别的路由。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

let rows: Array<Record<string, unknown>> = [];

vi.mock("@/lib/aws/dynamodb", () => ({
  docClient: { send: vi.fn(async () => ({ Items: rows })) },
  TABLES: { WORKFLOWS: "bgp-workflows" },
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/versions/version-service", () => ({ snapshotVersion: vi.fn(async () => {}) }));
vi.mock("@/lib/projects/guard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects/guard")>("@/lib/projects/guard");
  return {
    ...actual,
    requireProject: vi.fn(async () => ({ identity: { username: "u", sub: "s" }, projectId: "proj-a", role: "editor" })),
  };
});
vi.mock("@/lib/exec-env/registry", () => ({
  getTargetRaw: vi.fn(async (id: string) => (["tgt_home", "tgt_usw2_a"].includes(id) ? { targetId: id, ready: true } : null)),
  descriptorViolation: vi.fn(() => null),
}));

import { GET } from "../route";

const req = (qs = "") => new NextRequest(`https://x.test/api/workflow${qs}`);
const ids = async (qs = "") => {
  const body = await (await GET(req(qs))).json();
  // 🔴 裸数组:若哪天改成信封,这里要连同前端一起改(前端两种都吃,测试只钉当前合同)
  expect(Array.isArray(body)).toBe(true);
  return body.map((r: any) => r.workflowId);
};

beforeEach(() => {
  rows = [
    { workflowId: "w1", targets: ["tgt_home"] },
    { workflowId: "w2", targets: ["tgt_usw2_a"] },
    { workflowId: "w3" }, // 存量:发布只落主控区的 Airflow ⇒ 归主控区是真话
  ];
});

describe("GET 过滤", () => {
  it("缺省 = 全部(回滚点)", async () => {
    expect(await ids()).toEqual(["w1", "w2", "w3"]);
  });
  it("🔴 主控区视角含存量无章的行", async () => {
    expect(await ids("?scope=tgt_home")).toEqual(["w1", "w3"]);
  });
  it("🔴 非主控区视角只留真绑了它的", async () => {
    expect(await ids("?scope=tgt_usw2_a")).toEqual(["w2"]);
  });
  it("非法 / 不存在的 scope 一律拒,不回落", async () => {
    expect((await GET(req("?scope=@@"))).status).toBe(400);
    expect((await GET(req("?scope=tgt_nope"))).status).toBe(404);
  });
});
