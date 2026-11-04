import { homeRegion } from "@/lib/place/home-region";
import { NextRequest, NextResponse } from "next/server";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { CORRELATION_HEADER, newCorrelationId } from "@/lib/observability/logger";
import { OBSERVE_URL_HEADER } from "@/lib/place/observe-header";
import { authMode, cognitoPoolId, cognitoClientId, AUTH_UNCONFIGURED_MESSAGE } from "@/lib/auth/auth-mode";
// 内部端点的头部判定(纯函数,零 node 内置,edge 安全)
import { INTERNAL_API_PREFIX, internalSourceVerdict } from "@/lib/scheduler/internal-source";

// Platform-wide API auth gate. Every /api/* route requires a valid Cognito ID token,
// EXCEPT /api/public/* (e.g. the runtime config endpoint used to bootstrap login).
// Verification is edge-safe (jose, remote JWKS).
// 🔴 生产上线批次 A:不再「没配 Cognito = 全站放开」。三态唯一判定见 lib/auth/auth-mode.ts:
//    cognito ⇒ 校验;显式 BGP_AUTH_DISABLED=1 ⇒ 放开(仅本机开发);两者都没有 ⇒ 503 拒绝服务。

const issuerOf = (poolId: string) => {
  const region = poolId.split("_")[0] || homeRegion();
  return poolId ? `https://cognito-idp.${region}.amazonaws.com/${poolId}` : "";
};

// Cache the remote JWKS across invocations (keyed in module scope).
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  const issuer = issuerOf(cognitoPoolId());
  if (!issuer) return null;
  if (!jwks) jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return jwks;
}

// Stamp the correlation id on a response so the browser / support can quote it.
function withCid(res: NextResponse, cid: string): NextResponse {
  res.headers.set(CORRELATION_HEADER, cid);
  return res;
}

// Pass-through that also injects the correlation id into the DOWNSTREAM request headers,
// so Node API routes can read it via getCorrelationId(req) and tie their logs to this request.
function proceed(req: NextRequest, cid: string): NextResponse {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(CORRELATION_HEADER, cid);
  // 落点观测器要知道「这次调用来自哪个请求、哪个视角」。
  // 🔴 永远覆盖入站同名头(浏览器伪造不了观测输入);它**只是观测输入**,不是落点来源。
  requestHeaders.set(OBSERVE_URL_HEADER, `${req.nextUrl.pathname}${req.nextUrl.search}`);
  return withCid(NextResponse.next({ request: { headers: requestHeaders } }), cid);
}

function unauthorized(cid: string) {
  return withCid(
    NextResponse.json(
      { success: false, error: { message: "未认证或登录态已失效，请重新登录", correlationId: cid } },
      { status: 401 }
    ),
    cid
  );
}

function forbidden(cid: string) {
  return withCid(
    NextResponse.json(
      { success: false, error: { message: "运营分析账号仅可使用智能问数与提交需求", correlationId: cid } },
      { status: 403 }
    ),
    cid
  );
}

// 运营分析账号（仅 bgp-analyst，无任何特权组）只能访问以下 API。其余 /api/* 一律 403。
// 这是网关层的硬性收口；各业务路由内的项目角色守卫为第二层防御。
const ANALYST_ALLOW: { prefix: string; methods: string[] }[] = [
  { prefix: "/api/genbi", methods: ["GET", "POST"] }, // 智能问数：问答 + 历史
  { prefix: "/api/redshift/connections", methods: ["GET"] }, // GenBI 工作组选择器（只读元数据）
  { prefix: "/api/redshift/databases", methods: ["GET"] }, // GenBI 数据库选择器（只读元数据）
  { prefix: "/api/requirements", methods: ["GET", "POST"] }, // 提需求 + 我的需求（特权子动作由路由守卫再拦）
  { prefix: "/api/projects", methods: ["GET"] }, // 项目切换器（只读，禁建/改）
];

function isAnalystOnly(groups: string[]): boolean {
  const g = new Set(groups);
  return g.has("bgp-analyst") && !g.has("bgp-admin") && !g.has("bgp-manager") && !g.has("bgp-developer");
}

function analystAllowed(pathname: string, method: string): boolean {
  return ANALYST_ALLOW.some((a) => pathname.startsWith(a.prefix) && a.methods.includes(method));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // Reuse an inbound correlation id (e.g. from an upstream / retry) or mint a new one.
  // It is propagated downstream to API routes and echoed on every response.
  const cid = req.headers.get(CORRELATION_HEADER) || newCorrelationId();

  if (pathname.startsWith("/api/public/")) return proceed(req, cid); // bootstrap endpoints
  // 🔴 `/api/internal/**` 没有 Cognito 身份(调用方是主控区的分发 Lambda),鉴权由路由内的内部守卫做
  //    (共享密钥 + 来源)。这里先挡掉**一切经 CloudFront 进来的**请求(公网入口必带 X-Amz-Cf-Id)——
  //    公网上的人连密钥比对那一步都走不到。其余放行给路由守卫(纵深防御:路由会把这两道再判一遍)。
  if (pathname.startsWith(INTERNAL_API_PREFIX)) {
    const v = internalSourceVerdict(req.headers);
    if (v && !v.ok) {
      return withCid(NextResponse.json({ success: false, error: { message: v.reason, correlationId: cid } }, { status: v.status }), cid);
    }
    return proceed(req, cid);
  }
  if (req.method === "OPTIONS") return proceed(req, cid);
  const mode = authMode();
  if (mode === "disabled") return proceed(req, cid); // 显式关闭(仅本机开发 / 单测)
  if (mode === "unconfigured") {
    return NextResponse.json(
      { success: false, error: { message: AUTH_UNCONFIGURED_MESSAGE, code: "UPSTREAM_ERROR" } },
      { status: 503, headers: { [CORRELATION_HEADER]: cid } },
    );
  }

  const header = req.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return unauthorized(cid);
  const token = header.slice(7).trim();
  const ks = getJwks();
  if (!token || !ks) return unauthorized(cid);

  try {
    const { payload } = await jwtVerify(token, ks, { issuer: issuerOf(cognitoPoolId()) });
    const aud = payload.aud;
    const clientId = cognitoClientId();
    const audOk = Array.isArray(aud) ? aud.includes(clientId) : aud === clientId;
    if (!audOk || payload["token_use"] !== "id") return unauthorized(cid);
    // 运营分析账号：网关层白名单收口（仅智能问数 + 提需求）。
    const groups = (payload["cognito:groups"] as string[]) || [];
    if (isAnalystOnly(groups) && !analystAllowed(pathname, req.method)) return forbidden(cid);
    // 平台管理面（/api/admin/**：列用户 / 建号 / 改角色-可提权 / 禁用）网关层收口:必须 bgp-admin。
    // 与路由内 requireAdmin 守卫构成纵深防御(避免任何 /api/admin 子路由漏加守卫导致越权)。
    if (pathname.startsWith("/api/admin") && !groups.includes("bgp-admin")) return forbidden(cid);
    return proceed(req, cid);
  } catch {
    return unauthorized(cid);
  }
}

export const config = {
  matcher: ["/api/:path*"],
};
