export const dynamic = "force-dynamic";

import { homeRegion } from "@/lib/place/home-region";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { recommendRole, ROLE_ENGINES } from "@/lib/role-advisor";
import type { AdviseInput } from "@/lib/role-advisor";

// POST /api/role-advisor/recommend
// Body: RoleAdviceRequest(engine 必需 + 资源画像)。确定性引擎秒回最小权限策略 + 信任策略,供 UI 展示/复制/一键创建。
// 只读推荐(不建任何东西);登录即可。一键创建走 /api/role-advisor/create(仅管理员)。
export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效，请重新登录", 401);

  let body: AdviseInput;
  try { body = (await req.json()) as AdviseInput; }
  catch { return apiError("请求体无效", 400, { code: "VALIDATION_FAILED" }); }

  if (!body.engine || !ROLE_ENGINES.includes(body.engine)) {
    return apiError(`缺少或未知 engine(可选 ${ROLE_ENGINES.join("/")})`, 400, { code: "VALIDATION_FAILED" });
  }

  try {
    const rec = await recommendRole({
      ...body,
      accountId: body.accountId || process.env.AWS_ACCOUNT_ID || undefined,
      // L4 过渡:语义是缺省回落主控区(静默默认值类),再按落点改
      region: body.region || homeRegion(),
    });
    return apiOk(rec);
  } catch (err: unknown) {
    return apiError(`角色推荐失败: ${err instanceof Error ? err.message : String(err)}`, 500, { code: "INTERNAL" });
  }
}
