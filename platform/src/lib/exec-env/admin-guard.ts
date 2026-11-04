// @kf-batch 50-P50.2c-control-api
// exec-env 控制面 API 的路由内守卫(SPEC §2.1:`/api/admin/exec-envs*`,bgp-admin)。
//
// 🔴 纵深防御的第二道:网关层 `middleware.ts:104` 已对 `/api/admin/**` 强制 bgp-admin,
// 但路由内**仍必须再守一次**(照 `api/admin/users/route.ts` 的先例注释:避免任何
// /api/admin 子路由因 middleware 规则变动 / 路径改挂而静默失守)。
import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-response";
import { resolveIdentity, type Identity } from "@/lib/auth/identity";

/**
 * 校验平台管理员身份。通过返回 Identity,不通过返回可直接 return 的 NextResponse
 * (照 `requireProject` 的 `instanceof NextResponse` 用法惯例)。
 */
export async function requireExecEnvAdmin(req: NextRequest): Promise<Identity | NextResponse> {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效,请重新登录", 401, { code: "UNAUTHENTICATED" });
  if (!identity.isPlatformAdmin) {
    return apiError("仅平台管理员(bgp-admin)可管理执行环境", 403, { code: "RBAC_DENIED" });
  }
  return identity;
}
