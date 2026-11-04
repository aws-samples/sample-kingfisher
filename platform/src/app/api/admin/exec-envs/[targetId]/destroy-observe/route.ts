export const dynamic = "force-dynamic";
// @kf-batch 50-WP30-decommission
// POST /api/admin/exec-envs/[targetId]/destroy-observe —— 观测销毁并收口(WP-30 施工序 5;详情页销毁中时轮询,周期 reconciler 也调同一个函数)。
// build 还在跑 ⇒ 只读回报;build 结束 ⇒ 平台**自己真查目标区**:本 slug 无栈 ∧ 无本 target 的 VPC ∧ 托管服务不在 ⇒ `deleted`;
// 否则留 `decommissioning` 并把卡住的那个资源 + 真因写进 lastError(页面原样显示;不许假装删完)。
// 是 POST 不是 GET:它会写注册表(收口),GET 不许有副作用。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { observeDecommission } from "@/lib/exec-env/decommission";
import { decommissionErrorResponse } from "@/lib/exec-env/decommission-http";

export async function POST(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  try {
    const v = await observeDecommission(params.targetId);
    if (v.state === "settled-gone" || v.state === "settled-stuck") {
      // 收口是删除流程里「每步结果」的最后一步 ⇒ 审计
      recordAudit(req, v.state === "settled-gone" ? "exec-env.destroy.done" : "exec-env.destroy.stuck", {
        resourceType: "exec-env", resourceId: params.targetId, targetId: params.targetId,
        detail: { buildPhase: v.buildPhase, lastError: v.lastError, remaining: v.lastDestroy?.remaining, retained: v.lastDestroy?.retained, finalSnapshot: v.lastDestroy?.finalSnapshot },
      }).catch(() => {});
    }
    return apiOk(v);
  } catch (e) {
    return decommissionErrorResponse(e, "观测销毁");
  }
}
