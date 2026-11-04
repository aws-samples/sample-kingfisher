export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { assignRequirement, availableActions, getRequirement } from "@/lib/requirements/service";

// POST /api/requirements/[id]/assign — 经理指派研发。
// Body: { assigneeName, assigneeSub?, priority?, dueDate? }
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const r = await getRequirement(params.id);
  if (!r) return apiError("需求不存在", 404);
  const ctx = await requireProject(req, "viewer", r.projectId);
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  const res = await assignRequirement(r, ctx.identity, {
    assigneeName: body.assigneeName,
    assigneeSub: body.assigneeSub,
    priority: body.priority,
    dueDate: body.dueDate,
  });
  if (!res.ok) return apiError(res.error || "指派失败", res.status || 400);
  recordAudit(req, "requirement.assign", {
    resourceType: "requirement",
    resourceId: r.requirementId,
    detail: { assignee: body.assigneeName, priority: body.priority },
  }).catch(() => {});
  return apiOk({ ...res.requirement, _actions: availableActions(res.requirement!, ctx.identity) });
}
