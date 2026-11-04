// `GET /api/sync` 的执行范围过滤 + `POST` 的区章 + `start` 的反向卡。
//
// 🔴 这一组判据要防的是**补出一个骗人的区维**:章写 usw2 而执行侧仍在主控区跑 ——
//    那比「没有区维」更坏(界面/审计/成本一致地记错区,跨法域下即数据出境)。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

let rows: Array<Record<string, unknown>> = [];

vi.mock("@/lib/aws/dynamodb", () => ({
  docClient: { send: vi.fn(async () => ({ Items: rows })) },
  TABLES: { SYNC_TASKS: "bgp-sync-tasks", DATASOURCES: "bgp-datasources" },
}));
vi.mock("@/lib/sync/reconcile", () => ({ reconcileSyncTask: vi.fn(async (it: unknown) => it) }));
vi.mock("@/lib/governance/lineage-service", () => ({ generateSyncLineage: vi.fn() }));
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

const req = (qs = "") => new NextRequest(`https://x.test/api/sync${qs}`);
const ids = async (qs = "") => ((await (await GET(req(qs))).json()).data ?? []).map((r: any) => r.taskId);

beforeEach(() => {
  rows = [
    { taskId: "t1", targets: ["tgt_home"] },
    { taskId: "t2", targets: ["tgt_usw2_a"] },
    { taskId: "t3", targets: ["tgt_home", "tgt_usw2_a"] },
    { taskId: "t4" }, // 存量行:无区章 ⇒ 三级回落归主控区(它确实只在主控区跑过)
  ];
});

describe("GET 过滤", () => {
  it("缺省 = 全部(回滚点:URL 与改动前逐字节相同)", async () => {
    expect(await ids()).toEqual(["t1", "t2", "t3", "t4"]);
    expect(await ids("?scope=global")).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("🔴 主控区视角含存量无章的行(少报即等于把存量任务藏起来)", async () => {
    expect(await ids("?scope=tgt_home")).toEqual(["t1", "t3", "t4"]);
  });

  it("🔴 非主控区视角只留真绑了它的", async () => {
    expect(await ids("?scope=tgt_usw2_a")).toEqual(["t2", "t3"]);
  });

  it("非法 scope ⇒ 400 且不回落(绝不悄悄给全部)", async () => {
    const res = await GET(req("?scope=@@bad"));
    expect(res.status).toBe(400);
    expect((await res.json()).error?.code).toBe("INVALID_SCOPE");
  });

  it("指向不存在的执行环境 ⇒ 404(不回落主控区)", async () => {
    const res = await GET(req("?scope=tgt_nope"));
    expect(res.status).toBe(404);
    expect((await res.json()).error?.code).toBe("TARGET_NOT_FOUND");
  });

  it("既有筛选与 scope 并存(不是二选一)", async () => {
    rows = [
      { taskId: "a", status: "draft", targets: ["tgt_usw2_a"] },
      { taskId: "b", status: "draft", targets: ["tgt_home"] },
    ];
    expect(await ids("?status=draft&scope=tgt_usw2_a")).toEqual(["a"]);
  });
});
