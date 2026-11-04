export const dynamic = "force-dynamic";
// @kf-batch 50-SEQ47c-catalog-ddl —— 数据目录「新建表」:POST { kind: redshift|s3tables, targetId, schema, table, columns[], comment? }
//   · 仅平台管理员(与建模页「落地」同口径);
//   · 当前环境(x-bgp-env)是 prod ⇒ 不执行,建审批单 type "ddl"(202 + approvalId;项目空间批准后由 executeApprovedDdl 执行);
//   · 其它环境 ⇒ 当场执行:Redshift 走建模落地通道(登记台账 + applyModelTableById),S3 Tables 走 s3tables CreateTable。
//   🔴 写接口不读 scope;落点只来自请求体 targetId(validateCreateSpec 校验)。
// 模块 55 / 序 50:执行分支的主体在 lib/governance/long-ops.ts(catalog-create-table,成功 201);目标区数仓冷时 45s 未终态 ⇒ 202(协议 long-op/1)
//   + 客户端传输层轮询。审批单分流留在路由(不打数仓,不是长操作)。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject, getActiveEnv } from "@/lib/projects/guard";
import { isProtectedEnv } from "@/lib/projects/constants";
import { createApproval } from "@/lib/projects/project-service";
import { recordAudit } from "@/lib/audit";
import { getCorrelationId } from "@/lib/observability/logger";
import { validateCreateSpec, DDL_APPROVAL_TYPE } from "@/lib/governance/catalog-ddl";
import { catalogDdlErrorResponse } from "@/lib/governance/catalog-ddl-http";
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";

export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.identity.isPlatformAdmin) return apiError("仅平台管理员可以建表", 403, { code: "RBAC_DENIED" } as never);
  try {
    const body = await req.json().catch(() => ({}));
    const spec = validateCreateSpec(body);
    const env = getActiveEnv(req);
    const resourceId = `${spec.kind}:${spec.schema}.${spec.table}`;
    if (isProtectedEnv(env)) {
      const approval = await createApproval({
        projectId: ctx.projectId,
        type: DDL_APPROVAL_TYPE,
        payload: { action: "create", env, spec },
        targetIds: [spec.targetId],
        requestedBy: ctx.identity.username,
        requestedBySub: ctx.identity.sub,
      });
      recordAudit(req, "governance.table.create.request", { resourceType: "catalog-table", resourceId, targetId: spec.targetId, detail: { env, approvalId: approval.approvalId } }).catch(() => {});
      return apiOk({ pending: true, approvalId: approval.approvalId, env }, 202);
    }
    const result = await submitLongOp(
      { kind: "catalog-create-table", params: { spec, env }, correlationId: getCorrelationId(req) },
      { req, identity: ctx.identity },
    );
    return longOpResponse(req, result);
  } catch (e) {
    const lo = longOpErrorResponse(e);
    if (lo) return lo;
    const r = catalogDdlErrorResponse(e);
    if (r) return r;
    return apiError(String((e as Error)?.message ?? e), 500);
  }
}
