// `GET /api/datasources` 的执行范围过滤 —— **A 类(标量章 `ownerTargetId`)下推 DDB**。
//
// 🔴 为什么必须可执行:A 类最容易出的错不是「忘了加」,而是
//   ① home 视角**只**写 `#scopeAttr = :scopeT0` ⇒ 存量无 `ownerTargetId` 的行(以及空串行)整批消失;
//   ② 把 scope 的占位符与本路由既有的 `#nm` / `#tp` / `#st` 撞名 ⇒ 表达式非法或过滤错。
// 两个都只在真组出表达式时才看得见。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const scans: Array<Record<string, any>> = [];

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { DATASOURCES: "bgp-datasources" },
  docClient: {
    send: vi.fn(async (cmd: { input?: Record<string, unknown> }) => {
      scans.push((cmd.input ?? {}) as Record<string, any>);
      return { Items: [] };
    }),
  },
}));

vi.mock("@/lib/projects/guard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects/guard")>("@/lib/projects/guard");
  return { ...actual, requireProject: vi.fn(async () => ({ identity: {}, projectId: "proj-a", role: "viewer" })) };
});

vi.mock("@/lib/exec-env/registry", () => ({
  // 🔴 同 etl-jobs:桩里**故意不给** `getTarget`(带准入的那个)。改回去立刻报「不是函数」。
  getTargetRaw: vi.fn(async (id: string) =>
    ["tgt_home", "tgt_usw2_a"].includes(id) ? { targetId: id, ready: true } : null
  ),
  descriptorViolation: vi.fn(() => null),
}));

vi.mock("@/lib/aws/datasource-service", () => ({
  createSecret: vi.fn(), detectNetwork: vi.fn(), ensureGlueRole: vi.fn(),
  createGlueConnection: vi.fn(), testConnection: vi.fn(),
}));
vi.mock("@/lib/datasource/schema-reader", () => ({ readSourceSchema: vi.fn() }));
vi.mock("@/lib/openmetadata/om-push", () => ({ pushDataSourceToOpenMetadata: vi.fn() }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));

import { GET } from "../route";

const req = (qs = "") => new NextRequest(`https://x.test/api/datasources${qs}`);
beforeEach(() => { scans.length = 0; });

describe("缺省(不带 scope)= 现状(回滚点)", () => {
  it("表达式里没有任何 target 维,占位符也没有 scope 前缀的", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(scans[0].FilterExpression).toBe("userId = :uid AND projectId = :pid");
    expect(JSON.stringify(scans[0].ExpressionAttributeValues)).not.toContain("scopeT");
    expect(scans[0].ExpressionAttributeNames).toBeUndefined();
  });

  it("显式 scope=global 与缺省**逐字节**等价", async () => {
    await GET(req("?scope=global"));
    await GET(req());
    expect(scans[0]).toEqual(scans[1]);
  });
});

describe("target 视角:下推 DDB", () => {
  it("🔴 home 视角必须同时捞「缺属性」与「空串」两种存量行", async () => {
    await GET(req("?scope=tgt_home"));
    const f = scans[0].FilterExpression as string;
    expect(f).toContain("#scopeAttr = :scopeT0");
    expect(f).toContain("attribute_not_exists(#scopeAttr)");
    expect(f).toContain("#scopeAttr = :scopeEmpty");
    expect(scans[0].ExpressionAttributeNames["#scopeAttr"]).toBe("ownerTargetId");
    expect(scans[0].ExpressionAttributeValues[":scopeEmpty"]).toBe("");
  });

  it("非 home 视角只有等值,**不带**任何存量兜底", async () => {
    await GET(req("?scope=tgt_usw2_a"));
    const f = scans[0].FilterExpression as string;
    expect(f).toContain("#scopeAttr = :scopeT0");
    expect(f).not.toContain("attribute_not_exists(#scopeAttr)");
    expect(scans[0].ExpressionAttributeValues[":scopeT0"]).toBe("tgt_usw2_a");
  });

  it("与既有筛选条件并存且占位符不撞名", async () => {
    await GET(req("?name=ord&type=mysql&status=active&scope=tgt_usw2_a"));
    const n = scans[0].ExpressionAttributeNames as Record<string, string>;
    expect(Object.keys(n).sort()).toEqual(["#nm", "#scopeAttr", "#st", "#tp"]);
    const f = scans[0].FilterExpression as string;
    for (const part of ["contains(#nm, :nm)", "#tp = :tp", "#st = :st", "#scopeAttr = :scopeT0"]) {
      expect(f).toContain(part);
    }
  });

  it("compare 视角:两个 target 或起来(点名 home 那一支带兜底)", async () => {
    await GET(req("?scope=cmp:tgt_home,tgt_usw2_a"));
    const f = scans[0].FilterExpression as string;
    expect(f).toContain(" OR ");
    expect(f).toContain("attribute_not_exists(#scopeAttr)");
    expect(scans[0].ExpressionAttributeValues[":scopeT1"]).toBe("tgt_usw2_a");
  });
});

describe("拒因(一律不回落)", () => {
  it("文法非法 ⇒ 400 且**一次 DDB 都没打**", async () => {
    const res = await GET(req("?scope=us-west-2"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_SCOPE");
    expect(scans).toEqual([]);
  });

  it("不存在的 target ⇒ 404,不回落 home", async () => {
    const res = await GET(req("?scope=tgt_zzz9"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("TARGET_NOT_FOUND");
    expect(scans).toEqual([]);
  });
});
