// 模块 37 v4 — 分析看板取数:POST body={widget, filters?, filterValues?}。
// resolveWidgetSource 按绑字段+作用域把筛选器注入视觉对象 → 复用 executeBiQuery/executeBiDataApi(零改动)。
// 取数是读操作 → viewer 权限即可(结果必过 maskRows)。
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { getCorrelationId } from "@/lib/observability/logger";
import { executeBiQuery, executeBiDataApi, biLandingOf, type BiQueryError } from "@/lib/bi/query";
import { placeErrorResponse } from "@/lib/place/route";
import { resolveWidgetSource } from "@/lib/bi/analysis-query";
import type { BiWidget, AnalysisFilter } from "@/lib/bi/types";

function isBiQueryError(e: unknown): e is BiQueryError {
  return !!e && typeof e === "object" && "status" in e && "error" in e;
}

export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const cid = getCorrelationId(req);
  const body = await req.json().catch(() => ({}));
  const widget = body?.widget as BiWidget | undefined;
  if (!widget || !widget.source) return apiError("缺少 widget", 400, { code: "VALIDATION_FAILED", correlationId: cid });

  const filters = body?.filters as AnalysisFilter[] | undefined;
  const filterValues = body?.filterValues as Record<string, string> | undefined;

  let resolved;
  try {
    resolved = resolveWidgetSource(widget, filters, filterValues);
  } catch (e) {
    return apiError(e instanceof Error ? e.message : "筛选注入失败", 400, { code: "VALIDATION_FAILED", correlationId: cid });
  }

  try {
    if (resolved.source.kind === "dataapi") {
      const result = await executeBiDataApi(
        ctx.projectId,
        resolved.source.apiId,
        resolved.source.params || {},
        ctx.identity,
        cid
      );
      return apiOk(result);
    }
    const result = await executeBiQuery(resolved.source, {
      identity: ctx.identity,
      projectId: ctx.projectId,
      correlationId: cid,
      // @kf-batch 50-WP4ter-coverage —— 取数落点走 **body.targetId**(执行路由不读 `?scope=`,SPEC §2.6.3);
      // widget 自己声明的落点优先(见 executeBiQuery 的 opts.targetId 注释)。
      // @kf-batch 50-WP31-place-first-class —— 落点唯一作者 biLandingOf(widget 自带 > 请求点名;都没有 ⇒ 400)
      targetId: biLandingOf(resolved.source, body?.targetId, "saved"),
      filters: resolved.passthroughFilters,
      filterValues: resolved.passthroughValues,
    });
    return apiOk(result);
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    if (isBiQueryError(e)) {
      // @kf-batch 50-W5-seg2-WP1 — BiQueryError 自带 code 时优先透传(数据服务下线的 410 GONE),否则按 status 归类。
      const code = e.code ?? (e.status === 504 ? "UPSTREAM_TIMEOUT" : e.status >= 500 ? "UPSTREAM_ERROR" : "VALIDATION_FAILED");
      return apiError(e.error, e.status, { code, correlationId: cid });
    }
    return apiError(e instanceof Error ? e.message : "取数失败", 500, { code: "INTERNAL", correlationId: cid });
  }
}
