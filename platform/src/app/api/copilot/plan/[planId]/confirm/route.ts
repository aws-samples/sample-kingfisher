export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { getActiveEnv } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { getPlan, getStep, confirmStep, listSteps } from "@/lib/copilot/plan/plan-service";
import { getStepHandler } from "@/lib/copilot/plan/step-handlers/registry";
import type { CopilotCaller } from "@/lib/copilot/tools/types";

// POST /api/copilot/plan/[planId]/confirm  { stepId }
// gated 确认(awaiting-confirmation → confirmed)。editor。
// 【L2 语义】确认一步 = ①调 StepHandler.createDraft 建对应 draft(status=draft,不跑)②回填 draft id + execHint
//   ③标记 confirmed。之后引擎【不代执行】(autoExecute=false),只给用户"去哪页点"的指引。
// query-only 步骤不建资源(createDraft 返回空 id),仅给 execHint 指引去查询页。
// 未来 L3:确认后引擎才会 claim 执行(见 executor 门控)。
export async function POST(req: NextRequest, props: { params: Promise<{ planId: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  const stepId = String(body?.stepId || "").trim();
  if (!stepId) return apiError("缺少 stepId", 400, { code: "VALIDATION_FAILED" });

  try {
    const plan = await getPlan(ctx.projectId, params.planId);
    if (!plan) return apiError("执行计划不存在", 404, { code: "NOT_FOUND" });
    const step = await getStep(params.planId, stepId);
    if (!step) return apiError("步骤不存在", 404, { code: "NOT_FOUND" });
    if (step.status !== "awaiting-confirmation") {
      return apiError(`该步骤当前状态为「${step.status}」,只有等待确认(awaiting-confirmation)的步骤可确认`, 409, { code: "CONFLICT" });
    }

    const handler = getStepHandler(step.stepType);
    if (!handler) return apiError(`未知步骤类型:${step.stepType}`, 400, { code: "VALIDATION_FAILED" });

    // ① 建 draft(L1;query-only 返回空 id 不建资源)。带调用者身份,过闸2/RBAC。
    const authz = req.headers.get("authorization") || "";
    const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
    const caller: CopilotCaller = { token, projectId: ctx.projectId, env: getActiveEnv(req) };

    let draftResourceId = "";
    let draftResourceKind = "";
    try {
      const r = await handler.createDraft(step, caller);
      draftResourceId = r.draftResourceId;
      draftResourceKind = r.draftResourceKind;
    } catch (e: any) {
      return apiError(`建草稿失败:${String(e?.message || e).slice(0, 200)}`, 500);
    }

    // ② execHint(基于已建 draft 深链)。
    const execHint = handler.execHint({ ...step, draftResourceId });

    // ③ 标记 confirmed(条件写:仅 awaiting-confirmation→confirmed)。
    const okConfirm = await confirmStep(params.planId, stepId, { draftResourceId, draftResourceKind, execHint });
    if (!okConfirm) return apiError("步骤状态已变化,请刷新重试", 409, { code: "CONFLICT" });

    recordAudit(req, "copilot.plan.confirm-step", {
      resourceType: "copilot-plan",
      resourceId: params.planId,
      detail: { stepId, stepType: step.stepType, draftResourceId, draftResourceKind },
    }).catch(() => {});
    // 每建一个 draft 额外记 copilot.plan.draft(可追溯 Copilot 建了什么),draftResourceId 为空(query-only)不记。
    if (draftResourceId) {
      recordAudit(req, "copilot.plan.draft", {
        resourceType: draftResourceKind, resourceId: draftResourceId,
        detail: { planId: params.planId, stepId, stepType: step.stepType },
      }).catch(() => {});
    }

    const steps = await listSteps(params.planId);
    return apiOk({ stepId, draftResourceId, draftResourceKind, execHint, steps });
  } catch (e: any) {
    if (e?.name === "ConditionalCheckFailedException") return apiError("计划已被其他操作更新,请刷新重试", 409, { code: "CONFLICT" });
    return apiError(e?.message || "确认失败", 500);
  }
}
