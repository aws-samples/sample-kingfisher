export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { canCreateProject, CREATE_PROJECT_DENY_MESSAGE } from "@/lib/projects/config-permissions";
import { createProject, listVisibleProjects, listDiscoverableProjects } from "@/lib/projects/project-service";
import { recordAudit } from "@/lib/audit";
// 执行范围。
// 🔴 项目本身是全局对象,但它有**按执行环境的白名单**(`ExecutionTarget.access`);
// 「本项目在这个区能不能用」是数据驻留最关键的一格,而这一页原来一个字都不说。
// ⇒ 单区视角 = 只列**在该区获授权**的项目,并随响应回按区计数(护栏 1 的 N 由页面显示)。
import { requireScope } from "@/lib/exec-env/scope";
import { scopeTargets } from "@/lib/scope/scope";

// GET /api/projects — projects visible to the caller (default workspace + memberships;
// platform admins see all). Used by the project switcher and the /projects page.
//   ?discover=1 → ALL projects annotated with { myRole, pending } so a non-member can
//                 discover projects and request access (the approval flow).
export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  try {
    if (req.nextUrl.searchParams.get("discover")) {
      return apiOk(await listDiscoverableProjects(identity));
    }
    const projects = await listVisibleProjects(identity);
    const scope = await requireScope(req, null);
    if (scope instanceof Response) return scope as never;
    const ids = scopeTargets(scope);
    if (ids.length === 0) return apiOk(projects);

    const { getTargetRaw } = await import("@/lib/exec-env/registry");
    const { accessAllows } = await import("@/lib/exec-env/residency");
    // 逐 target 读一次描述符(单区视角就是一次);读不到 ⇒ **不过滤**并在响应里说明,
    // 🔴 绝不「读不到就当没授权」把项目藏起来(那是最坏的失败方式:用户以为项目丢了)。
    const targets = await Promise.all(ids.map((id) => getTargetRaw(id).catch(() => null)));
    const usable = targets.filter((t): t is NonNullable<typeof t> => !!t);
    const countsByTarget: Record<string, number> = {};
    for (const t of usable) {
      countsByTarget[t.targetId] = projects.filter((p) =>
        accessAllows(t as { access?: unknown }, (p as { projectId: string }).projectId)
      ).length;
    }
    if (usable.length === 0) {
      return apiOk(projects, 200, { scopeNote: "读不到这些执行环境的授权清单,已按未过滤显示" });
    }
    const filtered = projects.filter((p) =>
      usable.some((t) => accessAllows(t as { access?: unknown }, (p as { projectId: string }).projectId))
    );
    return apiOk(filtered, 200, { countsByTarget });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

// POST /api/projects — create a project (caller becomes owner). 白名单式最小权限:
// 仅平台管理员 / manager 可建项目;其余(含 developer)一律拒绝。
// 🔴 **D4 收紧(52 DESIGN §D4,用户拍板)**:改动前还包含 `bgp-developer`。
//    判据统一到 `canCreateProject()` —— `/projects` 页的「+ 新建项目空间」按钮用**同一个函数**
//    决定显隐(交互 §1.1:对 developer 直接隐藏,而不是点了才 403)。
export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  if (!canCreateProject(identity.groups)) {
    return apiError(CREATE_PROJECT_DENY_MESSAGE, 403, { code: "RBAC_DENIED" });
  }

  const body = await req.json().catch(() => ({}));
  if (!body?.name) return apiError("缺少项目名称 name");
  try {
    const project = await createProject({ name: body.name, description: body.description }, identity);
    recordAudit(req, "project.create", {
      resourceType: "project",
      resourceId: project.projectId,
      detail: { name: project.name },
    }).catch(() => {});
    return apiOk(project, 201);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
