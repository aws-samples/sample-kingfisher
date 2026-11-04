export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { resolveIdentity } from "@/lib/auth/identity";
import { recordAudit } from "@/lib/audit";
import { deleteSkill, GLOBAL_SCOPE } from "@/lib/genbi/skills";

// DELETE /api/genbi/skills/[id]?projectId=<pk> — 删除注册技能（editor；global 仅平台管理员）。
export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const pid = req.nextUrl.searchParams.get("projectId") || "";
  if (!pid) return apiError("缺少 projectId");
  if (pid === GLOBAL_SCOPE) {
    const identity = await resolveIdentity(req);
    if (!identity?.isPlatformAdmin) return apiError("仅平台管理员可删除 global 技能", 403);
  } else {
    const ctx = await requireProject(req, "editor", pid);
    if (ctx instanceof NextResponse) return ctx;
  }
  try {
    await deleteSkill(pid, params.id);
    recordAudit(req, "genbi.skill.delete", { resourceType: "genbi-skill", resourceId: params.id, detail: { projectId: pid } }).catch(() => {});
    return apiOk({ deleted: true });
  } catch (e: any) { return apiError(e.message, 500); }
}
