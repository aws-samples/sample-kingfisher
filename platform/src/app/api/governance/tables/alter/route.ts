export const dynamic = "force-dynamic";
// 数据目录「修改表结构」:POST { targetId, schema, table, desired: 列[], confirmName?, dryRun? }
//   · dryRun ⇒ 只回计划(加 / 删 / 注释 / 加宽)+ 语句 + 拒绝项,任一登录用户可看;
//   · 执行 ⇒ 仅平台管理员;prod 环境 ⇒ 审批单 type "ddl"(202);其它 ⇒ 当场执行(home 直跑 / 非主控区 admin 执行器 alter-model-table);
//   · 计划含删列 ⇒ 必须 confirmName === 物理表名,否则 409 DECISION_REQUIRED(不可逆,重档确认)。
//   🔴 写接口不读 scope;落点只来自请求体 targetId。
// 三个分支都要读一次目标区真实列(数仓冷时 >45s)⇒ 主体整段在 lib/governance/long-ops.ts(catalog-alter-table,
//   mode = dryRun / execute / request-approval),45s 未终态 ⇒ 202(协议 long-op/1)+ 客户端传输层轮询;状态码 / 文案与接入前逐字相同。
import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-response";
import { requireProject, getActiveEnv } from "@/lib/projects/guard";
import { isProtectedEnv } from "@/lib/projects/constants";
import { requestedTargetId } from "@/lib/place/resolve";
import { getCorrelationId } from "@/lib/observability/logger";
import { safeIdent } from "@/lib/modeling/redshift";
import { normalizeDesiredColumns } from "@/lib/governance/catalog-ddl";
import { catalogDdlErrorResponse } from "@/lib/governance/catalog-ddl-http";
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";

export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  try {
    const body = await req.json().catch(() => ({}));
    const targetId = requestedTargetId(body?.targetId, "governance.tables.alter");
    const schema = String(body?.schema || "").trim();
    const table = String(body?.table || "").trim();
    if (!schema || !table) return apiError("缺少 schema / table", 400);
    safeIdent(schema);
    safeIdent(table);
    const desired = normalizeDesiredColumns(body?.desired);
    const confirmName = typeof body?.confirmName === "string" ? body.confirmName : undefined;
    const env = getActiveEnv(req);
    const base = { targetId, schema, table, desired, ...(confirmName !== undefined ? { confirmName } : {}), env, projectId: ctx.projectId };

    if (body?.dryRun === true) {
      const result = await submitLongOp({ kind: "catalog-alter-table", params: { mode: "dryRun", ...base }, correlationId: getCorrelationId(req) }, { req, identity: ctx.identity });
      return longOpResponse(req, result);
    }
    if (!ctx.identity.isPlatformAdmin) return apiError("仅平台管理员可以改表结构", 403, { code: "RBAC_DENIED" } as never);
    const mode = isProtectedEnv(env) ? "request-approval" : "execute";
    const result = await submitLongOp({ kind: "catalog-alter-table", params: { mode, ...base }, correlationId: getCorrelationId(req) }, { req, identity: ctx.identity });
    return longOpResponse(req, result);
  } catch (e) {
    const lo = longOpErrorResponse(e);
    if (lo) return lo;
    const r = catalogDdlErrorResponse(e);
    if (r) return r;
    return apiError(String((e as Error)?.message ?? e), 500);
  }
}
