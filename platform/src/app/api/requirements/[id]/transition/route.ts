export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { applyTransition, availableActions, getRequirement, type ActionName } from "@/lib/requirements/service";

// POST /api/requirements/[id]/transition — 统一状态机转移。
// Body: { action: ActionName, note?: string }
// 守卫在 service.applyTransition 内（按动作判定经理/被指派人/提出人）。
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const r = await getRequirement(params.id);
  if (!r) return apiError("需求不存在", 404);
  const ctx = await requireProject(req, "viewer", r.projectId);
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  const action = body?.action as ActionName;
  if (!action) return apiError("缺少 action");
  const res = await applyTransition(r, action, ctx.identity, body.note);
  if (!res.ok) return apiError(res.error || "转移失败", res.status || 400);
  recordAudit(req, `requirement.${action}`, {
    resourceType: "requirement",
    resourceId: r.requirementId,
    detail: { action, toStatus: res.requirement?.status },
  }).catch(() => {});
  return apiOk({ ...res.requirement, _actions: availableActions(res.requirement!, ctx.identity) });
}
