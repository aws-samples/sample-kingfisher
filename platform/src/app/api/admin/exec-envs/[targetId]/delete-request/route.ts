export const dynamic = "force-dynamic";
// POST /api/admin/exec-envs/[targetId]/delete-request —— 申请删除(INTERACTION §1.4 机制 A + C)。
// 入参 `{confirm, previewHash}`:`confirm` 必须**逐字等于该环境的 region**(强确认,防手滑);
// `previewHash` 是用户看过的那一份影响预览的指纹 —— 服务端重算,不一致 ⇒ 409 PREVIEW_DRIFT 要求重新预览。
// 前置:非主控区 / 已停止承接 / 三个数都是 0 / 无在途会话 / 没有另一张待审批的删除申请;任一不满足 ⇒ 409 并点名。
// 通过 ⇒ 建 bgp-approvals(type=exec-env-delete,带影响预览**快照**供收件箱回放),**不立即销毁**。
// 非平台管理员:网关 + 路由内守卫两道 403。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { requestDelete } from "@/lib/exec-env/decommission";
import { decommissionErrorResponse } from "@/lib/exec-env/decommission-http";

const CLIENT_FIELDS = ["confirm", "previewHash"];

export async function POST(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError("请求体不是合法 JSON", 400, { code: "VALIDATION_FAILED" });
  }
  const extra = Object.keys(body ?? {}).filter((k) => !CLIENT_FIELDS.includes(k));
  if (extra.length) return apiError(`入参含不允许的字段:${extra.join(", ")}(只接 ${CLIENT_FIELDS.join(", ")})`, 400, { code: "VALIDATION_FAILED" });
  try {
    const { approval, impact } = await requestDelete(params.targetId, { confirm: body.confirm, previewHash: body.previewHash }, { username: identity.username, sub: identity.sub });
    recordAudit(req, "exec-env.delete-request", {
      resourceType: "exec-env",
      resourceId: params.targetId,
      targetId: params.targetId,
      detail: { approvalId: approval.approvalId, previewHash: impact.previewHash, counts: impact.counts, retained: impact.retained },
    }).catch(() => {});
    return apiOk({ approvalId: approval.approvalId, status: approval.status, previewHash: impact.previewHash, note: "已提交删除申请,等待平台管理员审批;审批通过后才会开始销毁" }, 201);
  } catch (e) {
    recordAudit(req, "exec-env.delete-request.rejected", {
      resourceType: "exec-env",
      resourceId: params.targetId,
      targetId: params.targetId,
      detail: { error: String((e as Error)?.message ?? e).slice(0, 300) },
    }).catch(() => {});
    return decommissionErrorResponse(e, "申请删除");
  }
}
