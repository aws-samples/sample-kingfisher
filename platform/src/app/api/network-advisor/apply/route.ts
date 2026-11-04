export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { recordAudit } from "@/lib/audit";
import { applyRemediation, isAutoApplicable } from "@/lib/network-advisor/apply";
import type { ConnectivityRequest, RemediationType } from "@/lib/network-advisor";
import { placeConnectivityRequest } from "@/lib/network-advisor";
import { placeErrorResponse } from "@/lib/place/route";

// POST /api/network-advisor/apply —— 网络顾问一键修复(Phase 2)。
// 实际创建"补网络"资源(开 VPC DNS / 建 S3 Gateway Endpoint)。经用户授权突破顾问只读边界:
// 仅低风险可逆动作、只创建不删改、参数服务端重解析、仅平台管理员、走审计。
// Body: { req: ConnectivityRequest, type: RemediationType, targetIndex?: number }
export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效，请重新登录", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可执行网络一键修复", 403);

  let body: { req?: ConnectivityRequest; type?: RemediationType; targetIndex?: number };
  try { body = await req.json(); } catch { return apiError("请求体无效", 400); }
  if (!body?.req?.computeKind || !Array.isArray(body.req?.targets) || !body.type) {
    return apiError("缺少 req(computeKind/targets) 或 type", 400);
  }
  if (!isAutoApplicable(body.type)) {
    return apiError(`修复类型 ${body.type} 不支持一键执行,请按展示步骤手动处理`, 400);
  }

  try {
    // 改网络打在请求点名的执行环境所在区(缺 targetId ⇒ 400,不默认主控区)
    const placed = await placeConnectivityRequest(body.req, "network-advisor/apply");
    const result = await applyRemediation({ req: placed, type: body.type, targetIndex: body.targetIndex });
    // 审计:无论成败都记(创建了什么资源、由谁)。
    recordAudit(req, "network-advisor.apply", {
      resourceType: "network",
      resourceId: result.resourceId || body.type,
      detail: { type: body.type, action: result.action, applied: result.applied, success: result.success, detail: result.detail },
    }).catch(() => {});
    if (!result.success) return apiError(result.detail || "执行失败", 500);
    return apiOk(result);
  } catch (e: unknown) {
    const placeErr = placeErrorResponse(e);
    if (placeErr) return placeErr;
    return apiError(e instanceof Error ? e.message : String(e), 500);
  }
}
