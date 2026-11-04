export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { runChecks } from "@/lib/quality/service";
import { recordAudit } from "@/lib/audit";
// @kf-batch 50-WP2-directquery —— 执行目标从 **body** 来,不从 `?scope=` 来(50 SPEC §2.6.3:
// 写/执行路由一律不读 scope —— 地址栏里的视图状态不该决定「在哪个区真跑」;门禁 scope-write-guard 钉住)。
// 页面把当前视角的 target 显式放进 body,并在按钮上复述(护栏 2)。
import { getActiveProjectId } from "@/lib/projects/guard";
// @kf-batch 50-WP4quater-reads(工单 SC-8)
import { scopedFqn } from "@/lib/governance/scoped-fqn";
// @kf-batch 50-WP31-place-first-class
import { requestedTargetId } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";

// 模块 19: 运行一张表的全部启用质量规则（仅平台管理员）。对 Redshift 执行校验、写结果、算评分/SLA。
export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可运行质量检查", 403);
  const body = await req.json().catch(() => ({}));
  if (!body?.fqn) return apiError("缺少 fqn");
  try {
    // @kf-batch 50-WP31-place-first-class —— 🔴 落点必须点名(缺 / 非法 ⇒ 400):原来「没给 = 主控区」,
    //   而规则 / 结果的键也跟着落点走 ⇒ 漏传就去主控区那张表上跑、结果又写进主控区的键
    const targetId = requestedTargetId(body?.targetId, "运行质量检查");
    // @kf-batch 50-WP4quater-reads(工单 SC-8)—— 🔴 规则与结果都按**这个区的这张表**取 / 写。
    // 用裸 fqn 的后果:在 usw2 跑检查,取到的是主控区那张表的规则、结果又盖掉主控区的结果 ——
    // 两个区的质量分从此互相污染(用户的词:「串味」)。
    const qKey = scopedFqn(body.fqn, targetId);
    const out = await runChecks(qKey, { targetId, projectId: getActiveProjectId(req) });
    // @kf-batch 50-WP2-directquery —— 「该区没装数仓」= 能力态,不是错误:如实回,页面整块降级。
    // 🔴 这种情况下**一条规则都没跑** ⇒ 不写运行审计(写了就等于台账里多一次没发生的运行)。
    if ("capability" in out) return apiOk(out);
    recordAudit(req, "quality.run", {
      resourceType: "quality-run",
      resourceId: qKey,
      // @kf-batch 50-WP4ter-coverage —— 审计盖真落点(工单 SC-12):这次检查真跑在哪个区。
      targetId,
      detail: { score: out.summary.score, slaBreached: out.summary.slaBreached, targetId },
    }).catch(() => {});
    return apiOk({ capability: "available" as const, ...out });
  } catch (e: any) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    return apiError(e.message);
  }
}
