export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProjectConfigAdmin } from "@/lib/projects/guard";
import { DEFAULT_PROJECT_ID } from "@/lib/projects/constants";
import {
  getApproval,
  decideApproval,
  putMember,
} from "@/lib/projects/project-service";
import { isProjectRole } from "@/lib/projects/constants";
import { isResourceType, ResourceType } from "@/lib/versions/version-service";
import { executePromote } from "@/lib/env/promote-service";
import { grantAccess } from "@/lib/governance/classification";
import { recordAudit } from "@/lib/audit";
// 删除执行环境的审批(平台 admin 专属;批准 ⇒ 写删除计划 + broker 销毁)
import { EXEC_ENV_DELETE_APPROVAL_TYPE, preflightApprovedDelete, startApprovedDestroy } from "@/lib/exec-env/decommission";
import { decommissionErrorResponse } from "@/lib/exec-env/decommission-http";
// prod 环境的数据目录建表 / 改表审批(批准 ⇒ 由批准人身份执行同一份编排)
import { DDL_APPROVAL_TYPE, isDdlApprovalPayload } from "@/lib/governance/catalog-ddl";
// 批准后的建表 / 改表执行是长操作(目标区数仓冷时 >45s)⇒ 主体在 lib/governance/long-ops.ts(approval-execute-ddl),
//   decideApproval 仍在路由里先做;45s 未终态 ⇒ 202(协议 long-op/1)+ 客户端传输层轮询,终态 data = `{ ...decided, ddl }` 与同步分支同形。
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";
import { getCorrelationId } from "@/lib/observability/logger";

// POST /api/approvals/[id] — approve or reject a request。
// Body: { decision: "approve" | "reject", reason? }
// Approving a `membership` request writes the requester's membership row (real effect).
//
// 🔴 **D4 收紧**:决策人由「项目 owner」改为 **平台 admin ∨(manager ∧ 该项目 owner)**
//    (交互 §1.2:developer-owner 的「待我审批」收件箱同步不再包含本项目 —— 见 approvals/route.ts)。
// 🔴 **顺手修一处存在性预言机**:改动前先回答"审批不存在 / 已处理"、**之后**才鉴权 ⇒
//    任一登录用户可用 approvalId 探测审批是否存在/状态。现在**授权在存在性之前**
//    (审批读出来只为拿到它的归属项目;读不到时按 `guardResourceAccess` 同款约定落到默认空间判权)。
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const approval = await getApproval(params.id);
  const ctx = await requireProjectConfigAdmin(req, approval?.projectId ?? DEFAULT_PROJECT_ID);
  if (ctx instanceof NextResponse) return ctx;
  if (!approval) return apiError("审批不存在", 404);
  if (approval.status !== "pending") return apiError("该审批已处理", 400);

  const body = await req.json().catch(() => ({}));
  const decision = body?.decision === "approve" ? "approved" : body?.decision === "reject" ? "rejected" : null;
  if (!decision) return apiError("decision 必须是 approve 或 reject");

  // 🔴 删除执行环境:**只许平台管理员**决策(本项目 owner ∧ 研发经理也不行
  //   这张单毁的是一整个区,不属于任何项目的配置权);批准前**先零写预检**(影响预览必须仍等于申请时那一份、仍为 0),
  //   预检不过 ⇒ 409,审批单保持待审(审批人可以驳回)。批准后写删除计划 + 起销毁;起不来 ⇒ 审批照样成立,页面给「重试销毁」。
  if (approval.type === EXEC_ENV_DELETE_APPROVAL_TYPE) {
    if (!ctx.identity.isPlatformAdmin) {
      return apiError("删除执行环境的审批只有平台管理员(bgp-admin)可以决策", 403, { code: "RBAC_DENIED" });
    }
    if (decision === "approved") {
      try {
        await preflightApprovedDelete(approval);
      } catch (e) {
        return decommissionErrorResponse(e, "删除审批预检");
      }
    }
    const decided = await decideApproval(params.id, decision, ctx.identity.username, body.reason);
    if (!decided) return apiError("审批状态已变更，请刷新", 409);
    const targetId = String(approval.payload?.targetId ?? "");
    let destroy: Record<string, unknown> | undefined;
    if (decision === "approved") {
      try {
        destroy = { started: true, ...(await startApprovedDestroy(decided, { username: ctx.identity.username })) };
      } catch (e) {
        destroy = { started: false, error: String((e as Error)?.message ?? e).slice(0, 400), hint: "审批已通过;请在执行环境详情页点「重试销毁」" };
      }
    }
    recordAudit(req, "approval.decide", {
      resourceType: "approval",
      resourceId: params.id,
      targetId,
      detail: { decision, type: approval.type, targetId, previewHash: approval.payload?.previewHash, snapshot: approval.payload?.snapshot, requestedBy: approval.requestedBy, destroy },
    }).catch(() => {});
    return apiOk({ ...decided, ...(destroy ? { destroy } : {}) });
  }

  try {
    const updated = await decideApproval(params.id, decision, ctx.identity.username, body.reason);
    if (!updated) return apiError("审批状态已变更，请刷新", 409);

    // Apply the effect of an approved membership request.
    if (decision === "approved" && approval.type === "membership") {
      const role = approval.payload?.role;
      if (isProjectRole(role)) {
        await putMember(
          approval.projectId,
          {
            username: approval.requestedBy,
            sub: approval.requestedBySub,
            role,
          },
          ctx.identity.username
        );
      }
    }

    // Apply the effect of an approved deploy (cross-env promotion) request (module 15).
    let promoteResult: any = undefined;
    if (decision === "approved" && approval.type === "deploy") {
      const p = approval.payload || {};
      if (isResourceType(p.resourceType) && typeof p.resourceId === "string" && typeof p.toEnv === "string") {
        promoteResult = await executePromote(
          p.resourceType as ResourceType,
          p.resourceId,
          p.toEnv,
          ctx.identity.username
        );
      }
    }

    // 批准 prod 环境的建表 / 改表 ⇒ 现在执行(失败如实回 4xx/5xx;审批单已置 approved,申请人重新提交即可)
    // 执行 + 审计记录在执行体里;这里只提交并按混合响应回(同步 200 `{ ...updated, ddl }` 与接入前逐字相同)
    if (decision === "approved" && approval.type === DDL_APPROVAL_TYPE) {
      if (!isDdlApprovalPayload(approval.payload)) return apiError("审批单 payload 不是合法的建表 / 改表请求", 400);
      try {
        const result = await submitLongOp(
          { kind: "approval-execute-ddl", params: { approvalId: params.id, payload: approval.payload, decided: updated as unknown as Record<string, unknown> }, correlationId: getCorrelationId(req) },
          { req, identity: ctx.identity },
        );
        return longOpResponse(req, result);
      } catch (e) {
        const lo = longOpErrorResponse(e);
        if (lo) return lo;
        throw e;
      }
    }

    // Apply the effect of an approved data-access request (module 18): grant the requester
    // access to the table → masking is lifted for that user on that table.
    if (decision === "approved" && approval.type === "data-access") {
      const fqn = approval.payload?.fqn;
      if (typeof fqn === "string" && fqn) {
        await grantAccess(approval.requestedBy, fqn, ctx.identity.username, params.id);
      }
    }

    recordAudit(req, "approval.decide", {
      resourceType: "approval",
      resourceId: params.id,
      detail: { decision, projectId: approval.projectId, type: approval.type },
    }).catch(() => {});
    return apiOk({ ...updated, ...(promoteResult ? { promote: promoteResult } : {}) });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
