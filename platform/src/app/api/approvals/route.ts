export const dynamic = "force-dynamic";
// @kf-batch 52-P52.1-D4
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import {
  createApproval,
  listApprovals,
  getProject,
  resolveRole,
} from "@/lib/projects/project-service";
import { isProjectRole } from "@/lib/projects/constants";
import { canManageProjectConfig } from "@/lib/projects/config-permissions";
import { recordAudit } from "@/lib/audit";
// @kf-batch 50-WP4quater-reads(工单 SC-33)—— 审批按执行范围。
// 🔴 只筛**带区的**审批(`deploy` 类从被晋升作业的 targets[] 派生);`membership` 是控制面动作、
// `data-access` 的 fqn 至今没有区维(SC-8)⇒ 这两类**不藏**。
// 🔴 而且要回一个 `hiddenByScope` 计数:审批收件箱是「我必须处理的事」,
// 被筛掉几条必须让用户看得见,否则就是静默漏办(护栏 1)。
import { readScope, filterRowsByApplicableScope } from "@/lib/exec-env/scope";
// @kf-batch 50-WP30-decommission —— 删除执行环境的审批单:只给平台管理员看 / 批;只许经专用入口建
import { EXEC_ENV_DELETE_APPROVAL_TYPE } from "@/lib/exec-env/decommission";

/** 🔴 删除执行环境的审批单只有平台管理员能决策(INTERACTION §1.4 机制 C)⇒ 也只给平台管理员看(看得见却按不动 = 撕裂)。 */
function visibleTo(a: { type: string }, identity: { isPlatformAdmin?: boolean }): boolean {
  return a.type !== EXEC_ENV_DELETE_APPROVAL_TYPE || identity.isPlatformAdmin === true;
}

// GET /api/approvals — list approval requests.
//   ?mine=1            → the caller's own requests
//   ?projectId=<id>    → requests in a project (caller must be owner of it)
//   ?status=pending    → filter by status
// With no filter, returns pending requests for projects the caller owns (review inbox).
export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  const p = req.nextUrl.searchParams;
  const mine = p.get("mine");
  const projectId = p.get("projectId") || undefined;
  const status = p.get("status") || undefined;

  try {
    if (mine) {
      return apiOk(await listApprovals({ requestedBy: identity.username, status }));
    }
    if (projectId) {
      // 🔴 D4:审批可见性与"谁能决策"必须同一判据 —— 否则会出现"看得见却按不动"
      //    (或更糟:看得见别人项目的审批内容)。
      const role = await resolveRole(identity, projectId);
      if (!canManageProjectConfig(identity.groups, role)) {
        return apiError("仅平台管理员,或本项目 owner 且具研发经理(bgp-manager)身份,可查看该项目审批", 403, {
          code: "RBAC_DENIED",
        });
      }
      return apiOk((await listApprovals({ projectId, status })).filter((a) => visibleTo(a, identity)));
    }
    // Review inbox: pending requests for projects the caller may actually decide on(D4 同判据)。
    const all = await listApprovals({ status: status || "pending" });
    const out = [];
    for (const a of all) {
      const role = await resolveRole(identity, a.projectId);
      if (canManageProjectConfig(identity.groups, role) && visibleTo(a, identity)) out.push(a);
    }
    // @kf-batch 50-WP4quater-reads(工单 SC-33)—— 按执行范围筛,但**未标区的一条都不藏**,
    // 并把「藏了几条」如实回出来:审批收件箱漏一条 = 一件该批的事没人批,而界面上毫无痕迹。
    const scope = readScope(req);
    if (!scope) return apiOk(out);
    const kept = filterRowsByApplicableScope(
      out as unknown as Array<Record<string, unknown>>,
      scope,
      "targetIds"
    ) as unknown as typeof out;
    return apiOk(kept, 200, {
      // 🔴 计数放在信封的 meta 里而不是混进数组:前端拿数组渲染表格,混进去会变成一行脏数据
      hiddenByScope: out.length - kept.length,
    });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

// POST /api/approvals — submit a membership/access request.
// Body: { projectId, type?: "membership", role: "editor"|"viewer"|"owner" }
export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401);
  const body = await req.json().catch(() => ({}));
  if (!body?.projectId) return apiError("缺少 projectId");
  const type = body.type || "membership";
  // @kf-batch 50-WP30-decommission —— 🔴 删除执行环境的申请**只能**经 delete-request 建(那里过了 drain / 影响预览 / 强确认 / 指纹);
  //   这里放行 = 任何登录用户都能伪造一张带任意 targetId 的删除审批单。
  if (type === EXEC_ENV_DELETE_APPROVAL_TYPE) {
    return apiError("删除执行环境的申请只能在执行环境详情页提交(POST /api/admin/exec-envs/[targetId]/delete-request)", 400, { code: "VALIDATION_FAILED" });
  }
  if (type === "membership" && !isProjectRole(body.role)) {
    return apiError("role 必须是 owner / editor / viewer");
  }
  if (type === "data-access" && !body.fqn) {
    return apiError("缺少 fqn（要申请访问的数据表）");
  }
  try {
    const project = await getProject(body.projectId);
    if (!project) return apiError("项目不存在", 404);
    const approval = await createApproval({
      projectId: body.projectId,
      type,
      payload: { role: body.role, note: body.note, ...(body.fqn ? { fqn: body.fqn } : {}) },
      requestedBy: identity.username,
      requestedBySub: identity.sub,
    });
    recordAudit(req, "approval.submit", {
      resourceType: "approval",
      resourceId: approval.approvalId,
      detail: { projectId: body.projectId, type, role: body.role, fqn: body.fqn },
    }).catch(() => {});
    return apiOk(approval, 201);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
