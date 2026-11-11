// 用户管理路由的三件事,钉用户可见的结果:
//   ① 列表读失败不许呈成「空列表」(原来 catch 里回 200 + [],页面显示「暂无数据」像是没有用户)⇒ 502 带原因;
//   ② 非管理员的拒因是「需要平台管理员」(与网关同一句,单一作者),不是运营分析那句;
//   ③ 建号 / 禁用 / 启用 / 改角色四个写动作都进审计(此前只有重置密码记了),审计里绝不出现口令。
// 只 mock 真外部(Cognito 客户端)与身份 / 审计出口。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { ADMIN_REQUIRED_MESSAGE } from "@/lib/auth/forbidden-messages";

const h = vi.hoisted(() => {
  process.env.COGNITO_USER_POOL_ID = "us-east-1_TESTPOOL";
  return { sent: [] as any[], admin: true, listFails: false, audits: [] as Array<{ action: string; opts: any }> };
});

vi.mock("@aws-sdk/client-cognito-identity-provider", async (orig) => {
  const real: any = await orig();
  class CognitoIdentityProviderClient {
    async send(cmd: any) {
      h.sent.push(cmd);
      if (cmd instanceof real.ListUsersCommand && h.listFails) throw new Error("Cognito unreachable (simulated)");
      return {};
    }
  }
  return { ...real, CognitoIdentityProviderClient };
});
vi.mock("@/lib/auth/identity", () => ({
  resolveIdentity: async () => ({ username: "admin", isPlatformAdmin: h.admin }),
}));
vi.mock("@/lib/audit", () => ({
  recordAudit: (_req: unknown, action: string, opts: unknown) => { h.audits.push({ action, opts }); },
}));

import { GET, POST, PUT } from "@/app/api/admin/users/route";

const req = (method: string, body?: unknown) =>
  new NextRequest("http://x/api/admin/users", { method, ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });
const PW = "Newpass#2026x";
const cmdNames = () => h.sent.map((c) => c.constructor.name);

describe("用户管理路由:读失败如实、拒因准确、写动作全进审计", () => {
  beforeEach(() => { h.sent.length = 0; h.audits.length = 0; h.admin = true; h.listFails = false; });

  it("① Cognito 列用户失败 ⇒ 502 + success:false + 原因(不是 200 空列表)", async () => {
    h.listFails = true;
    const r = await GET(req("GET"));
    expect(r.status).toBe(502);
    const body = await r.json();
    expect(body.success).toBe(false);
    expect(body.error.message).toContain("读取用户列表失败");
    expect(body.error.code).toBe("UPSTREAM_ERROR");
  });

  it("① 正常路径仍是 200 + 数组", async () => {
    const r = await GET(req("GET"));
    expect(r.status).toBe(200);
    expect(Array.isArray((await r.json()).data)).toBe(true);
  });

  it("② 非平台管理员:GET / POST / PUT 都 403,拒因 = 网关同一句「需要平台管理员」,Cognito 一次没被调", async () => {
    h.admin = false;
    for (const r of [await GET(req("GET")), await POST(req("POST", { username: "u1", password: PW })), await PUT(req("PUT", { username: "u1", action: "disable" }))]) {
      expect(r.status).toBe(403);
      const m = (await r.json()).error.message;
      expect(m).toBe(ADMIN_REQUIRED_MESSAGE);
      expect(m).not.toContain("运营分析");
    }
    expect(h.sent).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("③ 建号 ⇒ 审计 user.create 记用户名与角色,审计里没有口令 / 邮箱", async () => {
    const r = await POST(req("POST", { username: "new-dev", email: "dev@example.com", password: PW, role: "Developer" }));
    expect(r.status).toBe(200);
    expect(cmdNames()).toEqual(expect.arrayContaining(["AdminCreateUserCommand", "AdminSetUserPasswordCommand", "AdminAddUserToGroupCommand"]));
    expect(h.audits.map((a) => a.action)).toEqual(["user.create"]);
    expect(h.audits[0].opts).toMatchObject({ resourceType: "user", resourceId: "new-dev", detail: { role: "Developer", groupName: "bgp-developer" } });
    const dump = JSON.stringify(h.audits);
    expect(dump).not.toContain(PW);
    expect(dump).not.toContain("dev@example.com");
  });

  it.each([
    ["disable", "user.disable", "AdminDisableUserCommand"],
    ["enable", "user.enable", "AdminEnableUserCommand"],
  ])("③ %s ⇒ Cognito %s + 审计 %s 作用在指定用户上", async (action, audit, cmd) => {
    const r = await PUT(req("PUT", { username: "pm-tester", action }));
    expect(r.status).toBe(200);
    expect(cmdNames()).toEqual([cmd]);
    expect(h.sent[0].input).toMatchObject({ Username: "pm-tester" });
    expect(h.audits).toEqual([{ action: audit, opts: { resourceType: "user", resourceId: "pm-tester" } }]);
  });

  it("③ 改角色 ⇒ 审计 user.role.change 带新角色与组名", async () => {
    const r = await PUT(req("PUT", { username: "pm-tester", action: "changeRole", role: "Admin" }));
    expect(r.status).toBe(200);
    expect(cmdNames()).toContain("AdminAddUserToGroupCommand");
    expect(h.audits).toEqual([{ action: "user.role.change", opts: { resourceType: "user", resourceId: "pm-tester", detail: { role: "Admin", groupName: "bgp-admin" } } }]);
  });

  it("③ 重置密码的审计照旧,且 Cognito 失败时不写「成功」审计(审计跟在真动作之后)", async () => {
    const r = await PUT(req("PUT", { username: "pm-tester", action: "resetPassword", password: PW }));
    expect(r.status).toBe(200);
    expect(h.audits.map((a) => a.action)).toEqual(["user.password.reset"]);
    expect(JSON.stringify(h.audits)).not.toContain(PW);
  });
});
