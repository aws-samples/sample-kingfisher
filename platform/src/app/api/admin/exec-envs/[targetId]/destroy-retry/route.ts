export const dynamic = "force-dynamic";
// @kf-batch 50-WP30-decommission
// POST /api/admin/exec-envs/[targetId]/destroy-retry —— 「重试销毁」(WP-30 施工序 5)。
// 适用:销毁卡住(decommissioning + lastError,无在途会话),或审批已通过而销毁没能起来。
// 入参 `{confirm}` 必须逐字等于 region(强确认再来一次:每一次销毁都是一次「真删」)。
// 🔴 复用**同一份**删除计划(审批单 / 最终快照名不变)⇒ build 侧见快照已在就不再拍、也绝不删快照(build 角色显式 Deny);
//    不重新审批:审批批的是「删掉这个环境」,重试只是把没删完的删完。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { retryDestroy } from "@/lib/exec-env/decommission";
import { decommissionErrorResponse } from "@/lib/exec-env/decommission-http";

const CLIENT_FIELDS = ["confirm"];

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
    const r = await retryDestroy(params.targetId, { confirm: body.confirm }, { username: identity.username });
    recordAudit(req, "exec-env.destroy.retry", { resourceType: "exec-env", resourceId: params.targetId, targetId: params.targetId, detail: r }).catch(() => {});
    return apiOk({ ...r, note: "已重新触发销毁;同一份删除计划、同一个最终快照名" });
  } catch (e) {
    recordAudit(req, "exec-env.destroy.retry.rejected", {
      resourceType: "exec-env", resourceId: params.targetId, targetId: params.targetId,
      detail: { error: String((e as Error)?.message ?? e).slice(0, 300) },
    }).catch(() => {});
    return decommissionErrorResponse(e, "重试销毁");
  }
}
