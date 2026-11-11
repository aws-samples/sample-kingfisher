// 网关(middleware)的两道角色收口,钉用户可见的结果:
//   · 仅 bgp-analyst 的账号:白名单内放行(含顶栏「执行范围」清单与数据湖表清单两条只读接口),
//     白名单外 403 且拒因是「运营分析账号仅可使用智能问数与提交需求」;
//   · 非 bgp-admin 的账号打 /api/admin/**:403 且拒因说「需要平台管理员」—— 不是运营分析那句
//     (2026-11-09 真环境:研发账号打开「用户管理」被告知自己是运营分析账号,据此找不到出路)。
// 只 mock 真外部(jose 的 JWKS 校验);路径匹配、方法匹配、文案选择都跑真代码。
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { ANALYST_FORBIDDEN_MESSAGE, ADMIN_REQUIRED_MESSAGE } from "@/lib/auth/forbidden-messages";

const h = vi.hoisted(() => ({
  groupsByToken: {} as Record<string, string[]>,
}));

vi.mock("jose", () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify: async (token: string) => {
    const groups = h.groupsByToken[token];
    if (!groups) throw new Error("bad token");
    return { payload: { aud: "client-p83", token_use: "id", "cognito:groups": groups } };
  },
}));

const KEYS = ["BGP_AUTH_DISABLED", "COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID", "NEXT_PUBLIC_COGNITO_USER_POOL_ID", "NEXT_PUBLIC_COGNITO_CLIENT_ID"] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.COGNITO_USER_POOL_ID = "us-east-1_p83pool";
  process.env.COGNITO_CLIENT_ID = "client-p83";
  h.groupsByToken = {
    analyst: ["bgp-analyst"],
    developer: ["bgp-developer"],
    manager: ["bgp-manager"],
    admin: ["bgp-admin"],
    "analyst-and-dev": ["bgp-analyst", "bgp-developer"],
  };
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function call(as: string, method: string, path: string) {
  const { middleware } = await import("@/middleware");
  const res = await middleware(new NextRequest(`http://x${path}`, { method, headers: { authorization: `Bearer ${as}` } }));
  let body: { success?: boolean; error?: { message?: string; correlationId?: string } } | null = null;
  if (res.status === 403 || res.status === 401) body = await res.json();
  return { status: res.status, message: body?.error?.message ?? "", cid: body?.error?.correlationId ?? "" };
}

describe("🔴 仅 bgp-analyst 账号:白名单放行 / 其余 403 带分析账号的拒因", () => {
  it("顶栏「执行范围」清单 GET /api/exec-targets 放行(否则多区域下下拉只剩「全部」,问数选不了区)", async () => {
    expect((await call("analyst", "GET", "/api/exec-targets?component=any")).status).not.toBe(403);
  });

  it("数据湖表清单 GET /api/athena/tables 放行(只读元数据,落点必填)", async () => {
    expect((await call("analyst", "GET", "/api/athena/tables?targetId=tgt_home")).status).not.toBe(403);
  });

  it("原白名单照旧:genbi GET / POST · redshift/connections GET · redshift/databases GET · requirements GET / POST · projects GET", async () => {
    for (const [m, p] of [
      ["GET", "/api/genbi/history"],
      ["POST", "/api/genbi/ask"],
      ["GET", "/api/redshift/connections"],
      ["GET", "/api/redshift/databases"],
      ["GET", "/api/requirements"],
      ["POST", "/api/requirements"],
      ["GET", "/api/projects"],
    ] as const) {
      expect((await call("analyst", m, p)).status, `${m} ${p}`).not.toBe(403);
    }
  });

  it("新放行的两条只放 GET:POST /api/exec-targets · PUT /api/athena/tables 仍 403", async () => {
    expect((await call("analyst", "POST", "/api/exec-targets")).status).toBe(403);
    expect((await call("analyst", "PUT", "/api/athena/tables")).status).toBe(403);
  });

  it("白名单外(GET /api/sync · POST /api/projects · GET /api/admin/users)⇒ 403,拒因 = 分析账号那句,带 correlationId", async () => {
    for (const [m, p] of [
      ["GET", "/api/sync"],
      ["POST", "/api/projects"],
      ["GET", "/api/admin/users"],
    ] as const) {
      const r = await call("analyst", m, p);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.message).toBe(ANALYST_FORBIDDEN_MESSAGE);
      expect(r.cid).not.toBe("");
    }
  });

  it("兼有 bgp-developer 的账号不是「仅分析」:白名单不作用(GET /api/sync 放行)", async () => {
    expect((await call("analyst-and-dev", "GET", "/api/sync")).status).not.toBe(403);
  });
});

describe("🔴 管理面 /api/admin/**:非 bgp-admin 一律 403,拒因说「需要平台管理员」而不是运营分析那句", () => {
  it.each([["developer"], ["manager"]])("%s 账号 GET /api/admin/users ⇒ 403 + 平台管理员拒因", async (who) => {
    const r = await call(who, "GET", "/api/admin/users");
    expect(r.status).toBe(403);
    expect(r.message).toBe(ADMIN_REQUIRED_MESSAGE);
    expect(r.message).not.toContain("运营分析");
    expect(r.cid).not.toBe("");
  });

  it("两句拒因不同句(同一句解释两种原因就是这次缺陷本身)", () => {
    expect(ADMIN_REQUIRED_MESSAGE).not.toBe(ANALYST_FORBIDDEN_MESSAGE);
    expect(ADMIN_REQUIRED_MESSAGE).toContain("平台管理员");
  });

  it("bgp-admin ⇒ 放行;研发账号打非管理面(GET /api/exec-targets · GET /api/sync)⇒ 放行", async () => {
    expect((await call("admin", "GET", "/api/admin/users")).status).not.toBe(403);
    expect((await call("developer", "GET", "/api/exec-targets?component=any")).status).not.toBe(403);
    expect((await call("developer", "GET", "/api/sync")).status).not.toBe(403);
  });

  it("没带 token ⇒ 401(与 403 分清:未登录 vs 无权)", async () => {
    const { middleware } = await import("@/middleware");
    expect((await middleware(new NextRequest("http://x/api/admin/users"))).status).toBe(401);
  });
});
