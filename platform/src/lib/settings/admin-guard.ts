// @kf-batch 50-W5-seg2-WP8
// 模块 51 — /api/admin/model-config/** 的路由内纵深守卫(51 SPEC §2:middleware.ts 网关强制 bgp-admin 之外,
// 路由内再做一层 `isPlatformAdmin`,照 `api/admin/users/route.ts` 的 requireAdmin 写法复刻;P2-4)。
//
// 🔴 与 51 SPEC §2 补强⑤ 同源的风险提醒:`identity.ts` 在 Cognito 未配置时给所有人 isPlatformAdmin:true(demo 模式)。
//    这正是 gptTransportReady() 本波恒 false 的理由之一 —— 守卫挡不住 demo 部署里的「任何人」。
import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-response";
import { resolveIdentity, type Identity } from "@/lib/auth/identity";

export async function requirePlatformAdmin(req: NextRequest): Promise<{ identity: Identity } | NextResponse> {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效,请重新登录", 401, { code: "UNAUTHENTICATED" });
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可配置 AI 模型", 403, { code: "RBAC_DENIED" });
  return { identity };
}

/**
 * 51 SPEC §2 规定的**扁平**错误体(`{ error:"ProbeFailed"|"NotAllowedFamily"|"NotInCatalog"|"VersionConflict"|"RateLimited"|"TransportNotVerified"|"ScopeParamRenamed", … }`)。
 * 与全站 `apiError` 的 `{ success:false, error:{message} }` 形状不同 —— 合同把 `error` 定成机器可读枚举串,
 * 验收脚本按 `body.error` 断言;这里同时保留 `success:false` 与人话 `message`,前端两种读法都通。
 */
export function modelConfigError(
  // @kf-batch 50-WP4-o1-scope —— 新增 `ScopeParamRenamed`(50 SPEC v3.34 §2.6.0:参数 `scope` → `settingScope`,旧名即拒不留别名)
  // @kf-batch 51-v2-multi-vendor —— 新增 `ToolUseUnavailable`(51 SPEC §7.4 ③′:toolUse:"probe" 的系列探测通过但拿不到 tool-use 证据,不许设为全局默认)
  error: "ProbeFailed" | "NotAllowedFamily" | "NotInCatalog" | "VersionConflict" | "RateLimited" | "TransportNotVerified" | "ToolUseUnavailable" | "ValidationFailed" | "CatalogUnavailable" | "StoreUnavailable" | "ScopeParamRenamed",
  status: number,
  extra: Record<string, unknown> = {}
) {
  return NextResponse.json({ success: false, error, ...extra }, { status });
}
