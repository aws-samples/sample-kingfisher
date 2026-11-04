export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { updateRule, deleteRule } from "@/lib/quality/service";
import { recordAudit } from "@/lib/audit";
// 改 / 删也必须用同一个按区键,
// 否则会去主控区的分区上找一条本区的规则(找不到 ⇒ 404,而规则明明在)。
import { scopedFqn, governanceTargetFrom } from "@/lib/governance/scoped-fqn";

// 改 / 删质量规则（仅平台管理员）。fqn 走查询参数，ruleId 走路径。
export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可管理质量规则", 403);
  const fqn = req.nextUrl.searchParams.get("fqn");
  if (!fqn) return apiError("缺少 fqn");
  const body = await req.json().catch(() => ({}));
  try {
    const updated = await updateRule(scopedFqn(fqn, governanceTargetFrom(req.nextUrl.searchParams)), params.id, body);
    if (!updated) return apiError("规则不存在", 404);
    return apiOk(updated);
  } catch (e: any) {
    return apiError(e.message);
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!identity.isPlatformAdmin) return apiError("仅平台管理员可管理质量规则", 403);
  const fqn = req.nextUrl.searchParams.get("fqn");
  if (!fqn) return apiError("缺少 fqn");
  try {
    await deleteRule(scopedFqn(fqn, governanceTargetFrom(req.nextUrl.searchParams)), params.id);
    recordAudit(req, "quality.rule.delete", { resourceType: "quality-rule", resourceId: `${fqn}#${params.id}` }).catch(() => {});
    return apiOk({ deleted: true });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
