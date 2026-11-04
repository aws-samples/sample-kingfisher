export const dynamic = "force-dynamic";

import { homeRegion } from "@/lib/place/home-region";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { recordAudit } from "@/lib/audit";
import { provisionRole } from "@/lib/role-advisor/provisioner";
import { ROLE_ENGINES } from "@/lib/role-advisor";
import type { RoleAdviceRequest } from "@/lib/role-advisor";

// POST /api/role-advisor/create —— 一键创建执行角色(受控前缀 bgp-job-role-* + PermissionsBoundary 防提权)。
// 仅平台管理员;策略由服务端确定性引擎生成(不接受客户端任意策略);幂等;走审计。返回 ARN 供前端自动填入。
export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效，请重新登录", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可一键创建执行角色", 403);

  let body: RoleAdviceRequest;
  try { body = (await req.json()) as RoleAdviceRequest; }
  catch { return apiError("请求体无效", 400); }
  if (!body.engine || !ROLE_ENGINES.includes(body.engine)) {
    return apiError(`缺少或未知 engine(可选 ${ROLE_ENGINES.join("/")})`, 400);
  }

  try {
    const result = await provisionRole({
      ...body,
      accountId: body.accountId || process.env.AWS_ACCOUNT_ID || undefined,
      // L4 过渡:语义是缺省回落主控区(静默默认值类),再按落点改
      region: body.region || homeRegion(),
    });
    recordAudit(req, "role-advisor.create", {
      resourceType: "iam-role",
      resourceId: result.roleName,
      detail: { engine: body.engine, roleArn: result.roleArn, created: result.created, boundary: result.permissionsBoundary },
    }).catch(() => {});
    return apiOk(result);
  } catch (err: unknown) {
    return apiError(`创建角色失败: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
}
