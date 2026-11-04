// 用户管理「重置密码」:平台管理员给任何用户(含 admin 自己)设新密码。钉住用户可见的结果:
//   非管理员 403 且 Cognito 一次没被调 · 不符合用户池策略 400 且没调 · 合法 ⇒ AdminSetUserPassword(永久)
//   作用在**指定的那个用户**上 · 审计不带口令 · 未知动作 400(原来静默当成功)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => {
  process.env.COGNITO_USER_POOL_ID = "us-east-1_TESTPOOL";
  return { sent: [] as any[], admin: true, audits: [] as any[] };
});

vi.mock("@aws-sdk/client-cognito-identity-provider", async (orig) => {
  const real: any = await orig();
  class CognitoIdentityProviderClient {
    async send(cmd: any) { h.sent.push(cmd); return {}; }
  }
  return { ...real, CognitoIdentityProviderClient };
});
vi.mock("@/lib/auth/identity", () => ({
  resolveIdentity: async () => ({ username: "admin", isPlatformAdmin: h.admin }),
}));
vi.mock("@/lib/audit", () => ({
  recordAudit: (_req: unknown, action: string, opts: unknown) => { h.audits.push({ action, opts }); },
}));

import { PUT } from "@/app/api/admin/users/route";

const put = (body: unknown) =>
  PUT(new NextRequest("http://x/api/admin/users", { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
const GOOD = "Newpass#2026x";

describe("用户管理:管理员重置任意用户的密码", () => {
  beforeEach(() => { h.sent.length = 0; h.audits.length = 0; h.admin = true; });

  it("非平台管理员 ⇒ 403,Cognito 一次没被调", async () => {
    h.admin = false;
    const r = await put({ username: "pm-tester", action: "resetPassword", password: GOOD });
    expect(r.status).toBe(403);
    expect(h.sent).toHaveLength(0);
  });

  it.each([["", "缺失"], ["short1A!", "太短"], ["alllowercase123!", "缺大写"], ["NoSymbolsHere123", "缺符号"]])(
    "不符合用户池策略(%s / %s)⇒ 400,Cognito 一次没被调", async (pw) => {
      const r = await put({ username: "pm-tester", action: "resetPassword", password: pw });
      expect(r.status).toBe(400);
      expect(h.sent).toHaveLength(0);
    });

  it("合法 ⇒ AdminSetUserPassword(永久)作用在指定用户上;包括 admin 自己", async () => {
    for (const u of ["pm-tester", "admin"]) {
      h.sent.length = 0;
      const r = await put({ username: u, action: "resetPassword", password: GOOD });
      expect(r.status).toBe(200);
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0].constructor.name).toBe("AdminSetUserPasswordCommand");
      expect(h.sent[0].input).toEqual({ UserPoolId: "us-east-1_TESTPOOL", Username: u, Password: GOOD, Permanent: true });
    }
  });

  it("审计记下谁被重置,但绝不带口令", async () => {
    await put({ username: "pm-tester", action: "resetPassword", password: GOOD });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].action).toBe("user.password.reset");
    expect(JSON.stringify(h.audits[0])).not.toContain(GOOD);
  });

  it("未知动作 ⇒ 400(原来静默当成功);缺 username ⇒ 400", async () => {
    expect((await put({ username: "pm-tester", action: "resetPasswrd", password: GOOD })).status).toBe(400);
    expect((await put({ action: "disable" })).status).toBe(400);
    expect(h.sent).toHaveLength(0);
  });

  it("正控制:原有的禁用动作照旧下发", async () => {
    const r = await put({ username: "pm-tester", action: "disable" });
    expect(r.status).toBe(200);
    expect(h.sent[0].constructor.name).toBe("AdminDisableUserCommand");
  });
});
