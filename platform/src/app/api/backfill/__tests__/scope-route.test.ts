// `GET /api/backfill` 的执行范围过滤 —— **B 类(绑定列表),但字段名是 `execTargets` 不是 `targets`**。
//
// 🔴 为什么必须可执行:这里最容易出的错是「用默认字段名过滤」——
//    `bindingTargets({targets: undefined, targetId: undefined})` 一律回落 home ⇒
//    **所有**计划在任何非 home 视角下全部消失,而在 home 视角下全都在。
//    症状看起来像「过滤生效了」,其实是把整张表当成了 home 的。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

let plans: Array<Record<string, unknown>> = [];

vi.mock("@/lib/backfill/service", () => ({ listPlans: vi.fn(async () => plans) }));

vi.mock("@/lib/projects/guard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects/guard")>("@/lib/projects/guard");
  return { ...actual, requireProject: vi.fn(async () => ({ identity: {}, projectId: "proj-a", role: "viewer" })) };
});

vi.mock("@/lib/exec-env/registry", () => ({
  getTargetRaw: vi.fn(async (id: string) =>
    ["tgt_home", "tgt_usw2_a"].includes(id) ? { targetId: id, ready: true } : null
  ),
  descriptorViolation: vi.fn(() => null),
}));

import { GET } from "../route";
import { BACKFILL_PLAN_BINDING_ATTR } from "@/lib/backfill/types";

const req = (qs = "") => new NextRequest(`https://x.test/api/backfill${qs}`);
const ids = async (qs = "") => ((await (await GET(req(qs))).json()).data?.plans ?? []).map((p: any) => p.planId);

beforeEach(() => {
  plans = [
    { planId: "p1", execTargets: ["tgt_home"] },
    { planId: "p2", execTargets: ["tgt_usw2_a"] },
    { planId: "p3", execTargets: ["tgt_home", "tgt_usw2_a"] },
    { planId: "p4" }, // 存量行:无 execTargets ⇒ 三级回落归 home
  ];
});

describe("字段名", () => {
  it("绑定字段名由补数模块自己导出(不许在别处写字面量)", () => {
    expect(BACKFILL_PLAN_BINDING_ATTR).toBe("execTargets");
  });
});

describe("过滤", () => {
  it("缺省 = 全部(回滚点)", async () => {
    expect(await ids()).toEqual(["p1", "p2", "p3", "p4"]);
    expect(await ids("?scope=global")).toEqual(["p1", "p2", "p3", "p4"]);
  });

  it("🔴 home 视角含存量无绑定的行", async () => {
    expect(await ids("?scope=tgt_home")).toEqual(["p1", "p3", "p4"]);
  });

  it("🔴 非 home 视角**只**留真绑了它的(用默认字段名过滤会得到空数组 —— 那就是那个 bug)", async () => {
    expect(await ids("?scope=tgt_usw2_a")).toEqual(["p2", "p3"]);
  });

  it("行上是单值 `targetId` 时也认(三级回落第二级)", async () => {
    plans = [{ planId: "s1", targetId: "tgt_usw2_a" }];
    expect(await ids("?scope=tgt_usw2_a")).toEqual(["s1"]);
    expect(await ids("?scope=tgt_home")).toEqual([]);
  });

  it("compare 视角 = 并集", async () => {
    expect(await ids("?scope=cmp:tgt_home,tgt_usw2_a")).toEqual(["p1", "p2", "p3", "p4"]);
  });
});

describe("拒因(一律不回落)", () => {
  it("文法非法 ⇒ 400 INVALID_SCOPE", async () => {
    const res = await GET(req("?scope=us-west-2"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_SCOPE");
  });

  it("不存在的 target ⇒ 404,且响应里没有任何 planId", async () => {
    const res = await GET(req("?scope=tgt_zzz9"));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("planId");
  });
});
