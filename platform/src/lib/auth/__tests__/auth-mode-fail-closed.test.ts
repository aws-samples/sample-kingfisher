// @kf-batch 50-PROD-A-launch-hardening
// 🔴 「没配 Cognito」不再等于「全站放开 + 人人是管理员」(规则见 lib/auth/auth-mode.ts)。
//   vitest 全局显式设了 BGP_AUTH_DISABLED=1(既有单测的演示身份语义)⇒ 这里逐条**删掉它**再验。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const KEYS = ["BGP_AUTH_DISABLED", "COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID", "NEXT_PUBLIC_COGNITO_USER_POOL_ID", "NEXT_PUBLIC_COGNITO_CLIENT_ID"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const apiReq = (path = "/api/projects", headers: Record<string, string> = {}) => new NextRequest(`http://x${path}`, { headers });

describe("🔴 鉴权三态:没有静默的第三条路", () => {
  it("authMode:都没配 ⇒ unconfigured;只配一半 ⇒ 仍 unconfigured;显式关闭 ⇒ disabled;配齐 ⇒ cognito", async () => {
    const { authMode } = await import("@/lib/auth/auth-mode");
    expect(authMode()).toBe("unconfigured");
    process.env.COGNITO_USER_POOL_ID = "us-east-1_abc";
    expect(authMode()).toBe("unconfigured");
    process.env.BGP_AUTH_DISABLED = "1";
    expect(authMode()).toBe("disabled");
    process.env.COGNITO_CLIENT_ID = "client";
    expect(authMode()).toBe("cognito"); // 配齐时显式关闭不生效(生产不可能被一个开关关掉鉴权)
    process.env.BGP_AUTH_DISABLED = "true";
    delete process.env.COGNITO_CLIENT_ID;
    expect(authMode(), "只认字面量 1,不认 true / yes").toBe("unconfigured");
  });

  it("未配置 ⇒ resolveIdentity 回 null(不再是平台管理员)", async () => {
    const { resolveIdentity } = await import("@/lib/auth/identity");
    expect(await resolveIdentity(apiReq())).toBeNull();
  });

  it("未配置 ⇒ 中间件 503,且说清原因;/api/public/* 照常放行", async () => {
    const { middleware } = await import("@/middleware");
    const r = await middleware(apiReq("/api/projects"));
    expect(r.status).toBe(503);
    expect(JSON.stringify(await r.json())).toContain("鉴权未配置");
    const pub = await middleware(apiReq("/api/public/config"));
    expect(pub.status).not.toBe(503);
  });

  it("未配置 ⇒ requireAuth 503(原来回一个 local-dev 身份)", async () => {
    const { requireAuth } = await import("@/lib/auth/verify-token");
    const r = await requireAuth(apiReq());
    expect((r as Response).status).toBe(503);
  });

  it("正控制:显式关闭 ⇒ 中间件放行、身份是本地演示管理员", async () => {
    process.env.BGP_AUTH_DISABLED = "1";
    const { middleware } = await import("@/middleware");
    expect((await middleware(apiReq())).status).not.toBe(503);
    const { resolveIdentity } = await import("@/lib/auth/identity");
    expect((await resolveIdentity(apiReq()))?.isPlatformAdmin).toBe(true);
  });

  it("配了 Cognito、没带 token ⇒ 401(不是放行、也不是 503)", async () => {
    process.env.COGNITO_USER_POOL_ID = "us-east-1_abc";
    process.env.COGNITO_CLIENT_ID = "client";
    const { middleware } = await import("@/middleware");
    expect((await middleware(apiReq())).status).toBe(401);
  });
});
