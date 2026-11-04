export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
// 🔴 治理记录按区。
// 目录 fqn 不含区(`redshift.<db>.<schema>.<table>`)⇒ 两个区的同名表**共用同一个 DDB 分区**:
// 一个区打的标签盖掉另一个区的、一个区跑绿另一个跑红的质量结果互相覆盖。
// 用户 2026-09-10 的原话是「同名表跨区会互相顶,按区出分会**串味**」。
// 修法:分区键加区前缀(`<targetId>::<fqn>`),**home 保持裸 fqn ⇒ 存量零迁移**。
import { scopedFqn, governanceTargetFrom } from "@/lib/governance/scoped-fqn";
import { resolveIdentity } from "@/lib/auth/identity";
import { listRules, createRule } from "@/lib/quality/service";
import { recordAudit } from "@/lib/audit";
// 后一半:点名必须是**已注册且装好**的执行环境(不存在 ⇒ 409,不再写孤儿记录 / 回降级结果)
import { requestedRegisteredPlace } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";

// 质量规则。GET ?fqn=（登录可读）；POST 建规则（仅平台管理员）。
export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  const fqn = req.nextUrl.searchParams.get("fqn");
  if (!fqn) return apiError("缺少 fqn");
  try {
    return apiOk(await listRules(scopedFqn(fqn, governanceTargetFrom(req.nextUrl.searchParams))));
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可管理质量规则", 403);
  const body = await req.json().catch(() => ({}));
  if (!body?.fqn) return apiError("缺少 fqn");
  try {
    // 🔴 同上:规则挂在**这个区的这张表**上。写裸 fqn 会让规则跑到另一个区去
    // 🔴 写入的落点必须**点名**(缺 / 非法 ⇒ 400)。原来没给就读 `?scope=`、
    //   再没有就主控区 ⇒ 页面「添加规则」两样都不带 ⇒ us-west-2 视角加的规则写进主控区那张表、列表(按区读)里看不见
    const rKey = scopedFqn(body.fqn, (await requestedRegisteredPlace(body.targetId, "添加质量规则")).targetId);
    const rule = await createRule(rKey, body, identity.username);
    recordAudit(req, "quality.rule.create", {
      resourceType: "quality-rule",
      resourceId: `${body.fqn}#${rule.ruleId}`,
      detail: { type: rule.type, column: rule.column },
    }).catch(() => {});
    return apiOk(rule, 201);
  } catch (e: any) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    return apiError(e.message); // validation errors → 400
  }
}
