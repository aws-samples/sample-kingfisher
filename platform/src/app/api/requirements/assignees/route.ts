export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { listMembers } from "@/lib/projects/project-service";
import { isManager } from "@/lib/requirements/service";

// GET /api/requirements/assignees — 当前项目可指派的研发名单（项目成员）。仅经理可见。
// 研发动作以 assignee==调用者 授权；这里返回项目成员供经理选择（含其项目角色，供经理判断）。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  if (!isManager(ctx.identity)) return apiError("仅经理可获取可指派名单", 403);
  try {
    const members = await listMembers(ctx.projectId);
    // 排除 viewer（只读成员不适合作为研发承接人），其余作为候选。
    const candidates = members
      .filter((m) => m.role !== "viewer")
      .map((m) => ({ username: m.username, sub: m.sub, role: m.role, email: m.email }));
    return apiOk(candidates);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
