// 建模两条列表路由(码表 / 维度建模)的执行范围过滤 —— B 类,字段名就是 `targets`。
//
// 🔴 这两条路由**不走 `requireProject`**(建模定义是平台级的,守卫是 `resolveIdentity`)。
//    于是范围校验的项目上下文只能取「当前活跃项目头」:塞 null 会让设了项目白名单的 target
//    在建模页恒 403(而它在别的页面好得很)—— 那种「只有这一页说无权」最难查。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

let modelTables: Array<Record<string, unknown>> = [];
let codeTables: Array<Record<string, unknown>> = [];
const seenProjectIds: Array<string | null | undefined> = [];

vi.mock("@/lib/auth/identity", () => ({ resolveIdentity: vi.fn(async () => ({ username: "u1", isPlatformAdmin: true })) }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/modeling/dimensions", () => ({
  listModelTables: vi.fn(async () => modelTables),
  listModelTablesEnriched: vi.fn(async () => modelTables),
  createModelTable: vi.fn(),
}));
vi.mock("@/lib/modeling/service", () => ({
  listCodeTables: vi.fn(async () => codeTables),
  listCodeTablesEnriched: vi.fn(async () => codeTables),
  createCodeTable: vi.fn(),
}));

vi.mock("@/lib/exec-env/registry", () => ({
  getTargetRaw: vi.fn(async (id: string) =>
    ["tgt_home", "tgt_usw2_a", "tgt_locked"].includes(id) ? { targetId: id, ready: true } : null
  ),
  descriptorViolation: vi.fn(() => null),
}));
vi.mock("@/lib/exec-env/residency", () => ({
  accessAllows: vi.fn((t: { targetId?: string }, projectId: unknown) => {
    seenProjectIds.push(projectId as string);
    // `tgt_locked` 只授权给 proj-a —— 用来证明「项目上下文取的是活跃项目头,不是 null」
    return t.targetId !== "tgt_locked" || projectId === "proj-a";
  }),
  accessDeniedReason: vi.fn(() => "未授权"),
}));

import { GET as getDimensions } from "../dimensions/route";
import { GET as getCodetables } from "../codetables/route";

function req(path: string, qs = "", projectId?: string): NextRequest {
  return new NextRequest(`https://x.test/api/modeling/${path}${qs}`, {
    headers: projectId ? { "x-bgp-project": projectId } : {},
  });
}
const dimIds = async (qs = "", pid?: string) =>
  ((await (await getDimensions(req("dimensions", qs, pid))).json()).data ?? []).map((x: any) => x.modelTableId);
const ctIds = async (qs = "", pid?: string) =>
  ((await (await getCodetables(req("codetables", qs, pid))).json()).data ?? []).map((x: any) => x.codeTableId);

beforeEach(() => {
  seenProjectIds.length = 0;
  modelTables = [
    { modelTableId: "m1", targets: ["tgt_home"] },
    { modelTableId: "m2", targets: ["tgt_usw2_a"] },
    { modelTableId: "m3" }, // 存量:无 targets ⇒ 归 home
  ];
  codeTables = [
    { codeTableId: "c1", targets: ["tgt_usw2_a"] },
    { codeTableId: "c2" },
  ];
});

describe("维度建模", () => {
  it("缺省 = 全部(回滚点)", async () => {
    expect(await dimIds()).toEqual(["m1", "m2", "m3"]);
  });
  it("home 视角含存量无绑定的行", async () => {
    expect(await dimIds("?scope=tgt_home")).toEqual(["m1", "m3"]);
  });
  it("非 home 视角只留落到该区的", async () => {
    expect(await dimIds("?scope=tgt_usw2_a")).toEqual(["m2"]);
  });
  it("文法非法 ⇒ 400,不回落", async () => {
    const res = await getDimensions(req("dimensions", "?scope=eu-west-1"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_SCOPE");
  });
});

describe("码表", () => {
  it("非 home 视角只留落到该区的;home 视角拿到存量行", async () => {
    expect(await ctIds("?scope=tgt_usw2_a")).toEqual(["c1"]);
    expect(await ctIds("?scope=tgt_home")).toEqual(["c2"]);
  });
});

describe("🔴 项目上下文", () => {
  it("校验时把**活跃项目头**交给白名单判定(不是 null)", async () => {
    await dimIds("?scope=tgt_home", "proj-a");
    expect(seenProjectIds).toContain("proj-a");
  });

  it("白名单 target:带对项目头 ⇒ 200(该区没绑任何定义 ⇒ 空列表);项目不对 ⇒ 403,不静默给全部", async () => {
    const ok = await getDimensions(req("dimensions", "?scope=tgt_locked", "proj-a"));
    expect(ok.status).toBe(200);
    expect((await ok.json()).data).toEqual([]);
    const denied = await getDimensions(req("dimensions", "?scope=tgt_locked", "proj-zzz"));
    expect(denied.status).toBe(403);
    const b = await denied.json();
    expect(b.error.code).toBe("TARGET_FORBIDDEN");
    expect(JSON.stringify(b)).not.toContain("modelTableId");
  });
});
