// Standard Cognito JWT verification for protected API routes.
//
// Unlike the legacy `get-user.ts` (which only base64-decodes the JWT body without
// verifying anything), this validates the token's RS256 signature against the user
// pool's JWKS and checks expiry, issuer (the pool) and audience (the app client) via
// the official `aws-jwt-verify` library. The frontend sends the Cognito **ID token**.

import { NextRequest, NextResponse } from "next/server";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { apiError } from "@/lib/api-response";

// 🔴 生产上线批次 A:环境变量与模式判定收成一处(lib/auth/auth-mode.ts),这里不再各读一份。
import { authMode, cognitoPoolId, cognitoClientId, AUTH_UNCONFIGURED_MESSAGE } from "./auth-mode";

export function isAuthConfigured(): boolean {
  return authMode() === "cognito";
}

// Lazily build the verifier (only when Cognito is configured). It caches the pool's
// JWKS in memory and transparently refreshes it on key rotation.
let _verifier: any = null;
function getVerifier() {
  if (!isAuthConfigured()) return null;
  if (!_verifier) {
    _verifier = CognitoJwtVerifier.create({
      userPoolId: cognitoPoolId(),
      tokenUse: "id", // the platform frontend sends the Cognito ID token
      clientId: cognitoClientId(), // validates the `aud` claim
    });
  }
  return _verifier;
}

export interface AuthedUser {
  userId: string;
  username?: string;
  email?: string;
  groups: string[];
}

function bearerToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

// Verify the request's bearer token. Returns the authenticated user on success, or
// null when the token is missing/invalid/expired (signature, exp, iss and aud checked).
export async function verifyRequest(req: NextRequest): Promise<AuthedUser | null> {
  const verifier = getVerifier();
  if (!verifier) return null;
  const token = bearerToken(req);
  if (!token) return null;
  try {
    const p = await verifier.verify(token);
    return {
      userId: String(p.sub),
      username: typeof p["cognito:username"] === "string" ? p["cognito:username"] : undefined,
      email: typeof p.email === "string" ? p.email : undefined,
      groups: Array.isArray(p["cognito:groups"]) ? (p["cognito:groups"] as string[]) : [],
    };
  } catch {
    return null;
  }
}

// Enforce authentication. Returns the AuthedUser, or a 401 NextResponse for the caller
// to return directly:
//
//     const auth = await requireAuth(req);
//     if (auth instanceof NextResponse) return auth;
//
// 🔴 生产上线批次 A:只有**显式** BGP_AUTH_DISABLED=1 才放开;没配 Cognito 又没显式关闭 ⇒ 503。
export async function requireAuth(req: NextRequest): Promise<AuthedUser | NextResponse> {
  const mode = authMode();
  if (mode === "disabled") return { userId: "local-dev", groups: [] };
  if (mode === "unconfigured") return apiError(AUTH_UNCONFIGURED_MESSAGE, 503, { code: "UPSTREAM_ERROR" });
  const user = await verifyRequest(req);
  if (!user) {
    return apiError("未认证或登录态已失效，请重新登录", 401);
  }
  return user;
}
