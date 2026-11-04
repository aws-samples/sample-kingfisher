export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { isResourceType, loadResource, resourceLabel, ResourceType } from "@/lib/versions/version-service";
import { isEnv, isProtectedEnv, DEFAULT_ENV, DEFAULT_PROJECT_ID } from "@/lib/projects/constants";
import { executePromote } from "@/lib/env/promote-service";
import { createApproval } from "@/lib/projects/project-service";
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
import { recordAudit } from "@/lib/audit";

// POST /api/promote  body { type, id, toEnv }
// Promote a config resource into another environment.
//   - into a protected env (prod): creates a "deploy" approval (pending); the project owner
//     approves it in /api/approvals/[id], which then executes the promotion.
//   - otherwise (dev/staging): executes immediately (caller must be editor+).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { type, id, toEnv } = body || {};
  if (!isResourceType(type) || !id) return apiError("缺少或非法的 type / id");
  if (!isEnv(toEnv)) return apiError("toEnv 必须是 dev / staging / prod");

  const source = await loadResource(type as ResourceType, id);
  if (!source) return apiError("源资源不存在", 404);

  const ctx = await guardResourceAccess(req, source, "editor");
  if (ctx instanceof NextResponse) return ctx;

  const fromEnv = source.env || DEFAULT_ENV;
  if (fromEnv === toEnv) return apiError("源环境与目标环境相同");
  const projectId = source.projectId || DEFAULT_PROJECT_ID;

  try {
    // Protected target → require approval (unless the immediate executor would also be the
    // approver; we still record an approval for an audit trail and require an explicit
    // approve step, matching production "prod change needs sign-off" expectations).
    if (isProtectedEnv(toEnv)) {
      const approval = await createApproval({
        projectId,
        type: "deploy",
        payload: { resourceType: type, resourceId: id, fromEnv, toEnv, name: source.name || "" },
        // 🔴 从**被晋升的那个作业行**派生执行区
        // 「把一个只在 us-west-2 跑的作业晋升到 prod」这件事,审批人需要知道它落在哪个区。
        // 派生而不是让请求方传:传的话就能传错,而审批是权限边界动作,错了没人看得出来。
        targetIds: bindingTargets(source as { targets?: unknown; targetId?: unknown }),
        requestedBy: ctx.identity.username,
        requestedBySub: ctx.identity.sub,
      });
      recordAudit(req, "promote.request", {
        resourceType: type,
        resourceId: id,
        detail: { fromEnv, toEnv, approvalId: approval.approvalId },
      }).catch(() => {});
      return apiOk({ pending: true, approvalId: approval.approvalId, toEnv }, 202);
    }

    // Non-protected target → execute now.
    const result = await executePromote(type as ResourceType, id, toEnv, ctx.identity.username);
    recordAudit(req, "promote.execute", {
      resourceType: type,
      resourceId: id,
      detail: { fromEnv, toEnv, targetId: result.targetId, created: result.created },
    }).catch(() => {});
    return apiOk({ pending: false, ...result, label: resourceLabel(type as ResourceType) });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
