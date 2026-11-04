export const dynamic = "force-dynamic";
// 数据目录「修改表结构」抽屉的真实列:GET ?targetId=&schema=&table=
//   读该执行区 svv_columns(含注释),并回答「这张表能不能图形化改」:建模台账里有没有 / schema 是否平台全局 / 类型是否全在白名单。
//   🔴 落点来自 URL 的 targetId(缺 ⇒ 400),不读 scope,不回落主控区。
// 主体在 lib/governance/long-ops.ts(catalog-read-columns);目标区数仓冷时 45s 未终态 ⇒ 202 + 客户端传输层轮询。
import { NextRequest } from "next/server";
import { apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { requestedTargetId } from "@/lib/place/resolve";
import { getCorrelationId } from "@/lib/observability/logger";
import { catalogDdlErrorResponse } from "@/lib/governance/catalog-ddl-http";
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";

export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证", 401, { code: "UNAUTHENTICATED" });
  try {
    const q = req.nextUrl.searchParams;
    const targetId = requestedTargetId(q.get("targetId"), "governance.tables.columns");
    const schema = String(q.get("schema") || "").trim();
    const table = String(q.get("table") || "").trim();
    if (!schema || !table) return apiError("缺少 schema / table", 400);
    const result = await submitLongOp(
      { kind: "catalog-read-columns", params: { targetId, schema, table }, correlationId: getCorrelationId(req) },
      { req, identity },
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
