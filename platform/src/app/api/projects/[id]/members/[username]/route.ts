export const dynamic = "force-dynamic";
// @kf-batch 52-P52.1-D4
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProjectConfigAdmin } from "@/lib/projects/guard";
import { getProject, removeMember } from "@/lib/projects/project-service";
import { recordAudit } from "@/lib/audit";

// DELETE /api/projects/[id]/members/[username] — remove a member。项目创建者(owner)不可移除。
// 🔴 **D4 收紧**:由「项目 owner」改为 **平台 admin ∨(manager ∧ 本项目 owner)**。
export async function DELETE(
  req: NextRequest,
  props: { params: Promise<{ id: string; username: string }> }
) {
  const params = await props.params;
  const ctx = await requireProjectConfigAdmin(req, params.id);
  if (ctx instanceof NextResponse) return ctx;
  const username = decodeURIComponent(params.username);
  try {
    const project = await getProject(params.id);
    if (project?.ownerName && project.ownerName === username) {
      return apiError("不能移除项目创建者（owner）", 400);
    }
    await removeMember(params.id, username);
    recordAudit(req, "project.member.remove", {
      resourceType: "project",
      resourceId: params.id,
      detail: { username },
    }).catch(() => {});
    return apiOk({ removed: true });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
