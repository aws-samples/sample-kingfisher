export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { getPlan, setPlanStatus } from "@/lib/copilot/plan/plan-service";

// POST /api/copilot/plan/[planId]/control  { action: "pause"|"resume"|"cancel" }
// editor。pause/resume 切计划状态(L3 tick 据此决定是否推进);cancel 停计划。乐观锁冲突回 409。
// 注意:本期不含 retry/enable-autoexec —— L3 逐步代执行留接口默认关,开启是独立的显式动作(见设计 §8)。
export async function POST(req: NextRequest, props: { params: Promise<{ planId: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || "");
  try {
    const plan = await getPlan(ctx.projectId, params.planId);
    if (!plan) return apiError("执行计划不存在", 404, { code: "NOT_FOUND" });

    if (action === "pause") {
      await setPlanStatus(plan, "paused");
    } else if (action === "resume") {
      await setPlanStatus(plan, "running");
    } else if (action === "cancel") {
      await setPlanStatus(plan, "cancelled");
    } else {
      return apiError("未知操作", 400, { code: "VALIDATION_FAILED" });
    }

    recordAudit(req, "copilot.plan.control", {
      resourceType: "copilot-plan", resourceId: params.planId, detail: { action },
    }).catch(() => {});
    const updated = await getPlan(ctx.projectId, params.planId);
    return apiOk(updated);
  } catch (e: any) {
    if (e?.name === "ConditionalCheckFailedException") return apiError("计划已被其他操作更新,请刷新重试", 409, { code: "CONFLICT" });
    return apiError(e?.message || "操作失败", 500);
  }
}
