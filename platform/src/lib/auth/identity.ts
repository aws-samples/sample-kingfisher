// 真实身份解析 (v1.4.0)
//
// Replaces the hardcoded `default-user` identity. Reuses verify-token.ts' `verifyRequest`
// (aws-jwt-verify: validates RS256 signature, issuer, audience, expiry) to read the real
// Cognito sub / cognito:username / cognito:groups.
//
// Degradation: 🔴 生产上线批次 A 起只在**显式** BGP_AUTH_DISABLED=1(本机开发 / 单测)时返回演示
// 超管身份;没配 Cognito 又没显式关闭 ⇒ null(401)。三态唯一判定见 lib/auth/auth-mode.ts。

import { NextRequest } from "next/server";
import { verifyRequest } from "./verify-token";
import { authMode } from "./auth-mode";

// 组名的唯一定义处已搬到 `./groups`(纯常量、零依赖 ⇒ 前端也能 import;见该文件说明)。
// 这里原样 re-export:既有的 `import { PLATFORM_ADMIN_GROUP } from "@/lib/auth/identity"`
// 全部**逐字不变**,行为变化为 0。
import { PLATFORM_ADMIN_GROUP, MANAGER_GROUP, DEVELOPER_GROUP } from "./groups";
export { PLATFORM_ADMIN_GROUP, MANAGER_GROUP, DEVELOPER_GROUP };

// The physical DynamoDB partition value retained for zero-migration (see module 13 design).
// Resource tables still key by userId = this constant; tenancy/ownership live in the
// projectId / createdBy attributes, not in the partition key.
export const LEGACY_PARTITION = "default-user";

export interface Identity {
  sub: string; // Cognito sub (stable id)
  username: string; // cognito:username (human-readable), falls back to sub
  email?: string;
  groups: string[]; // cognito:groups
  isPlatformAdmin: boolean; // member of bgp-admin → super-user across all projects
  isManager: boolean; // member of bgp-manager (or platform admin) → 需求受理/指派/验收
  isDeveloper: boolean; // member of bgp-developer (or platform admin)
  demo: boolean; // true when Cognito unconfigured (open/demo mode)
}

// Resolve the caller's identity. Returns null only when Cognito is configured AND the token
// is missing/invalid (the platform middleware already rejects those at the edge, so this is
// a defense-in-depth check). Never throws.
export async function resolveIdentity(req: NextRequest): Promise<Identity | null> {
  // 🔴 生产上线批次 A:演示管理员身份只在**显式** BGP_AUTH_DISABLED=1 时给;
  //   没配 Cognito 又没显式关闭 ⇒ null(= 401),绝不再默认成平台管理员。
  const mode = authMode();
  if (mode === "unconfigured") return null;
  if (mode === "disabled") {
    return {
      sub: LEGACY_PARTITION,
      username: LEGACY_PARTITION,
      groups: [PLATFORM_ADMIN_GROUP],
      isPlatformAdmin: true,
      isManager: true,
      isDeveloper: true,
      demo: true,
    };
  }
  const u = await verifyRequest(req);
  if (!u) return null;
  const groups = u.groups || [];
  const isPlatformAdmin = groups.includes(PLATFORM_ADMIN_GROUP);
  return {
    sub: u.userId,
    username: u.username || u.userId,
    email: u.email,
    groups,
    isPlatformAdmin,
    isManager: isPlatformAdmin || groups.includes(MANAGER_GROUP),
    isDeveloper: isPlatformAdmin || groups.includes(DEVELOPER_GROUP),
    demo: false,
  };
}

/**
 * 「必须是**已校验**的登录身份」守卫:拿不到 ⇒ 401。用户维度的数据(问数卡片 / 历史 / 任务)一律按它的
 * `sub` 分区,不再用 `get-user.getUserId` —— 那个函数**不验签**地解 JWT,而且缺 token 时回 "default-user"。
 */
export async function requireIdentity(req: NextRequest): Promise<Identity | Response> {
  const identity = await resolveIdentity(req).catch(() => null);
  if (!identity) {
    return new Response(JSON.stringify({ success: false, error: { message: "未认证或登录态已失效,请重新登录", code: "UNAUTHENTICATED" } }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }
  return identity;
}
