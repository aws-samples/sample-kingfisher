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
  return { sent: [] as any[], admin: true, listFails: false, audits: [] as Array<{ action: string; opts: any }>, listUsers: [] as any[], groupsOf: {} as Record<string, string[]> };
});

vi.mock("@aws-sdk/client-cognito-identity-provider", async (orig) => {
  const real: any = await orig();
  class CognitoIdentityProviderClient {
    async send(cmd: any) {
      h.sent.push(cmd);
      if (cmd instanceof real.ListUsersCommand && h.listFails) throw new Error("Cognito unreachable (simulated)");
      if (cmd instanceof real.ListUsersCommand) return { Users: h.listUsers };
      if (cmd instanceof real.AdminListGroupsForUserCommand) return { Groups: (h.groupsOf[cmd.input.Username] || []).map((g: string) => ({ GroupName: g })) };
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
  beforeEach(() => { h.sent.length = 0; h.audits.length = 0; h.admin = true; h.listFails = false; h.listUsers = []; h.groupsOf = {}; });

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

  it("① 列表的角色按真实四组派生:manager ⇒ Manager · analyst ⇒ Analyst · 仅遗留 bgp-viewer ⇒ None(原来一律显示成 Viewer)", async () => {
    h.listUsers = ["pm-tester", "ops-analyst", "old-viewer", "dev-and-analyst"].map((u) => ({ Username: u, Enabled: true, UserStatus: "CONFIRMED" }));
    h.groupsOf = { "pm-tester": ["bgp-manager"], "ops-analyst": ["bgp-analyst"], "old-viewer": ["bgp-viewer"], "dev-and-analyst": ["bgp-analyst", "bgp-developer"] };
    const r = await GET(req("GET"));
    const roles = Object.fromEntries(((await r.json()).data as any[]).map((u) => [u.username, u.role]));
    expect(roles).toEqual({ "pm-tester": "Manager", "ops-analyst": "Analyst", "old-viewer": "None", "dev-and-analyst": "Developer" });
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

  it("② 建号 role 必填且闭合:缺省 / Viewer(旧三档)/ 乱值 ⇒ 400,Cognito 一次没被调(原来静默落成四组之外的 bgp-viewer)", async () => {
    for (const body of [{ username: "u2", password: PW }, { username: "u2", password: PW, role: "Viewer" }, { username: "u2", password: PW, role: "root" }]) {
      const r = await POST(req("POST", body));
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((await r.json()).error.message).toContain("Admin / Manager / Developer / Analyst / None");
    }
    expect(h.sent).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it.each([
    ["Manager", "bgp-manager"],
    ["Analyst", "bgp-analyst"],
  ])("③ 建号 role=%s ⇒ 加进真实平台组 %s(不再只有 Admin / Developer 两档)", async (role, group) => {
    const r = await POST(req("POST", { username: "u3", password: PW, role }));
    expect(r.status).toBe(200);
    const add = h.sent.find((c) => c.constructor.name === "AdminAddUserToGroupCommand");
    expect(add?.input).toMatchObject({ Username: "u3", GroupName: group });
    expect(h.audits[0].opts).toMatchObject({ detail: { role, groupName: group } });
  });

  it("③ 建号 role=None ⇒ 不进任何组(只靠项目成员资格),审计 groupName 为 null", async () => {
    const r = await POST(req("POST", { username: "u4", password: PW, role: "None" }));
    expect(r.status).toBe(200);
    expect(cmdNames()).not.toContain("AdminAddUserToGroupCommand");
    expect(cmdNames()).not.toContain("CreateGroupCommand");
    expect(h.audits[0].opts).toMatchObject({ detail: { role: "None", groupName: null } });
  });

  it("③ 改角色先从四个平台组 + 历史遗留 bgp-viewer 全部摘掉再加目标组(原来只摘三组 ⇒ manager / analyst 残留)", async () => {
    const r = await PUT(req("PUT", { username: "pm-tester", action: "changeRole", role: "Analyst" }));
    expect(r.status).toBe(200);
    const removed = h.sent.filter((c) => c.constructor.name === "AdminRemoveUserFromGroupCommand").map((c) => c.input.GroupName);
    expect(removed.sort()).toEqual(["bgp-admin", "bgp-analyst", "bgp-developer", "bgp-manager", "bgp-viewer"]);
    const add = h.sent.find((c) => c.constructor.name === "AdminAddUserToGroupCommand");
    expect(add?.input).toMatchObject({ Username: "pm-tester", GroupName: "bgp-analyst" });
    expect(h.audits).toEqual([{ action: "user.role.change", opts: { resourceType: "user", resourceId: "pm-tester", detail: { role: "Analyst", groupName: "bgp-analyst" } } }]);
  });

  it("③ 改角色成 None ⇒ 只摘组不加组;role 乱值 ⇒ 400 且不动 Cognito", async () => {
    const r = await PUT(req("PUT", { username: "pm-tester", action: "changeRole", role: "None" }));
    expect(r.status).toBe(200);
    expect(cmdNames()).not.toContain("AdminAddUserToGroupCommand");
    expect(h.audits[0].opts).toMatchObject({ detail: { role: "None", groupName: null } });
    h.sent.length = 0; h.audits.length = 0;
    const bad = await PUT(req("PUT", { username: "pm-tester", action: "changeRole", role: "Viewer" }));
    expect(bad.status).toBe(400);
    expect(h.sent).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
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
