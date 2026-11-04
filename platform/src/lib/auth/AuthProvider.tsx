"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { CognitoUserPool, CognitoUser, AuthenticationDetails, CognitoUserSession } from "amazon-cognito-identity-js";
import { useT } from "@/lib/i18n/useT";
import { normalizeApiResponse } from "@/lib/http/non-json-envelope";
// 长操作统一框架的客户端传输层:202(协议 long-op/1)在这里跟到终态再交回同形响应,页面调用点零改动。
import { peekLongOpAccepted, followLongOp } from "@/lib/long-ops/client/follow";

// Module-level pool ref so non-React helpers (the fetch interceptor below) can read the
// current ID token without going through React state.
let poolRef: CognitoUserPool | null = null;

// Resolves once AuthProvider has finished (re)building the Cognito pool and restoring any
// existing session. The fetch interceptor / getToken wait for this before reading the token,
// so /api requests fired on a fresh page load don't race ahead of auth init and 401.
let _authReadyResolve: (() => void) | null = null;
const _authReady: Promise<void> = new Promise((r) => { _authReadyResolve = r; });
function markAuthReady() { if (_authReadyResolve) { _authReadyResolve(); _authReadyResolve = null; } }

export async function getIdTokenStandalone(): Promise<string | null> {
  // Wait for auth init (with a timeout so a slow/missing config never hangs requests).
  await Promise.race([_authReady, new Promise<void>((r) => setTimeout(r, 4000))]);
  const pool = poolRef;
  if (!pool) return null;
  const u = pool.getCurrentUser();
  if (!u) return null;
  // 🔴🔴 `getSession` 的回调**可能永远不来**(刷新 token 的网络请求卡住、并发调用丢回调),
  // 而它外面这个 Promise 没有兜底 ⇒ 整条调用链**永久挂住**。后果不是「慢」,是**功能死掉**:
  // 调用方普遍写成 `setXLoading(true) … finally setXLoading(false)`,promise 不 settle 就轮不到
  // `finally` ⇒ loading 永久 true。真环境实测(2026-09-18,无头页面级验证抓到):数据治理的
  // 数据目录一直转圈,而 antd `Input.Search` 在 loading 态**会吞掉搜索触发** ⇒ 用户在 146 个资产里
  // 搜任何东西都零反应、也没有任何报错。⇒ 这里必须有超时:拿不到就回 null(调用方已有 null 分支)。
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done(null), 8000);
    try {
      u.getSession((err: any, session: CognitoUserSession | null) => {
        clearTimeout(timer);
        done(err ? null : session?.getIdToken().getJwtToken() || null);
      });
    } catch {
      clearTimeout(timer);
      done(null);
    }
  });
}

interface AuthCtx {
  user: CognitoUser | null;
  loading: boolean;
  configured: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  getToken: () => Promise<string | null>;
  /** 🔴 生产上线批次 A:登录用户在页面上改自己的密码(Cognito ChangePassword:先校验旧密码)。 */
  changePassword: (oldPassword: string, newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthCtx>({
  user: null, loading: true, configured: false,
  login: async () => {}, logout: () => {}, getToken: async () => null,
  changePassword: async () => { throw new Error("not ready"); },
});

export const useAuth = () => useContext(AuthContext);

// Global fetch interceptor: attach the Cognito ID token (+ active project/env headers) to
// same-origin /api calls and redirect to /login on 401. Installed at MODULE-EVAL time (below)
// so it patches window.fetch before any component effect runs — otherwise a page's data
// fetch (child effect runs before the provider's effect) would fire on a hard load/refresh
// before the interceptor exists and 401. getIdTokenStandalone waits for auth-ready internally.
function installFetchInterceptor() {
  if (typeof window === "undefined" || (window as any).__bgpFetchPatched) return;
  (window as any).__bgpFetchPatched = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: any, init?: any) => {
    // 所有 /api/ 下的响应(含 /api/public)在这里过一遍 normalizeApiResponse —— 状态 ≥ 400 且正文不是 JSON
    //   (边缘访问规则 403 / 网关 502 504 的 HTML 页)整形成标准错误信封,调用点的 `res.json()` 不再抛「Unexpected token <」。
    const isApi = typeof input === "string" && input.startsWith("/api/");
    if (isApi && input.startsWith("/api/public/")) return normalizeApiResponse(await orig(input, init));
    if (isApi) {
      const token = await getIdTokenStandalone();
      const headers = new Headers((init && init.headers) || {});
      if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
      try {
        const pid = window.localStorage.getItem("bgp-active-project");
        if (pid && !headers.has("x-bgp-project")) headers.set("x-bgp-project", pid);
      } catch {}
      try {
        const env = window.localStorage.getItem("bgp-active-env");
        if (env && !headers.has("x-bgp-env")) headers.set("x-bgp-env", env);
      } catch {}
      const res = await orig(input, { ...(init || {}), headers });
      if (res.status === 401 && window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
      // 已接入长操作的路由在 45s 内没出结果会回 202 `{ taskId, kind, label, async:true, protocol:"long-op/1" }`
      //   这里用原生 fetch(带同一套头)轮询 GET /api/long-ops/[taskId] 到终态,再整形成与同步响应**完全一样**的 Response 交回,
      //   调用点的 `res.status` / `res.json()` 分支一行不改。只认协议记号:GenBI warming 的 202 原样放行。
      const accepted = await peekLongOpAccepted(res);
      if (accepted) return followLongOp(accepted, { fetchImpl: orig, headers });
      return normalizeApiResponse(res);
    }
    return orig(input, init);
  };
}
// Install as early as possible (client module eval), before any component effect.
installFetchInterceptor();


export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CognitoUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [pool, setPool] = useState<CognitoUserPool | null>(null);
  const [configured, setConfigured] = useState(false);
  const t = useT();

  // Ensure the global fetch interceptor is installed (idempotent; also installed at module
  // eval time below so the very first data fetch on a hard load is intercepted).
  useEffect(() => { installFetchInterceptor(); }, []);

  // Fetch the Cognito config at runtime (NEXT_PUBLIC_* aren't inlined at build) and build
  // the user pool, then restore any existing session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/public/config", { cache: "no-store" });
        const cfg = (await res.json())?.data || {};
        if (cfg.userPoolId && cfg.clientId) {
          const p = new CognitoUserPool({ UserPoolId: cfg.userPoolId, ClientId: cfg.clientId });
          poolRef = p;
          if (!cancelled) { setPool(p); setConfigured(true); }
          const current = p.getCurrentUser();
          if (current) {
            current.getSession((err: any) => {
              if (!cancelled) { if (!err) setUser(current); setLoading(false); }
              markAuthReady();
            });
            return;
          }
        }
      } catch {
        // fall through: treated as unconfigured (open) below
      }
      if (!cancelled) setLoading(false);
      markAuthReady();
    })();
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    if (!pool) throw new Error(t("Cognito 未配置"));
    return new Promise<void>((resolve, reject) => {
      const cognitoUser = new CognitoUser({ Username: username, Pool: pool });
      cognitoUser.authenticateUser(new AuthenticationDetails({ Username: username, Password: password }), {
        onSuccess: () => { setUser(cognitoUser); resolve(); },
        onFailure: (err) => reject(err),
        newPasswordRequired: () => reject(new Error(t("需要重置密码"))),
      });
    });
  }, [pool, t]);

  const logout = useCallback(() => {
    user?.signOut();
    setUser(null);
  }, [user]);

  const getToken = useCallback(async (): Promise<string | null> => getIdTokenStandalone(), []);

  const changePassword = useCallback(async (oldPassword: string, newPassword: string): Promise<void> => {
    const u = user || pool?.getCurrentUser();
    if (!u) throw new Error(t("未登录"));
    // changePassword 要一个有效会话(access token);getSession 顺带刷新过期的 token。
    await new Promise<void>((resolve, reject) => u.getSession((err: unknown) => (err ? reject(err) : resolve())));
    await new Promise<void>((resolve, reject) =>
      u.changePassword(oldPassword, newPassword, (err) => (err ? reject(err) : resolve())));
  }, [user, pool, t]);

  return (
    <AuthContext.Provider value={{ user, loading, configured, login, logout, getToken, changePassword }}>
      {children}
    </AuthContext.Provider>
  );
}
