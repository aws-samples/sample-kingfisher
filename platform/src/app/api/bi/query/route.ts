// 模块 37 — BI 取数/预览:POST body={source, filters?, filterValues?}。
// 编辑期预览 + 仪表盘渲染共用。取数是读操作 → viewer 权限即可(结果必过 maskRows)。
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { getCorrelationId } from "@/lib/observability/logger";
import { executeBiQuery, executeBiDataApi, biLandingOf, type BiQueryError } from "@/lib/bi/query";
import { placeErrorResponse } from "@/lib/place/route";
import { buildSql, type BuilderSpec } from "@/lib/bi/query-builder";
import type { WidgetSource, DashboardFilter } from "@/lib/bi/types";

function isBiQueryError(e: unknown): e is BiQueryError {
  return !!e && typeof e === "object" && "status" in e && "error" in e;
}

export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const cid = getCorrelationId(req);
  const body = await req.json().catch(() => ({}));
  const rawSource = body?.source as { kind?: string } | undefined;
  if (!rawSource || !rawSource.kind) return apiError("缺少 source", 400, { code: "VALIDATION_FAILED", correlationId: cid });

  // v2:字段配置器发来 kind:"builder"(即 BuilderSpec)→ 编译成安全只读 SQL,转成 sql source 执行。
  // buildSql 内部标识符走真实 schema 白名单 + 格式校验,值位置转义;下游取数/脱敏零改动。
  let source: WidgetSource;
  let generatedSql: string | undefined;
  if (rawSource.kind === "builder") {
    try {
      const spec = rawSource as unknown as BuilderSpec;
      generatedSql = buildSql(spec);
      source = { kind: "sql", engine: spec.engine, sql: generatedSql };
    } catch (e) {
      return apiError(e instanceof Error ? e.message : "查询构建失败", 400, { code: "VALIDATION_FAILED", correlationId: cid });
    }
  } else {
    source = rawSource as WidgetSource;
  }

  try {
    if (source.kind === "dataapi") {
      const result = await executeBiDataApi(
        ctx.projectId,
        source.apiId,
        source.params || {},
        ctx.identity,
        cid
      );
      return apiOk(result);
    }
    const result = await executeBiQuery(source, {
      identity: ctx.identity,
      projectId: ctx.projectId,
      correlationId: cid,
      // @kf-batch 50-WP4ter-coverage —— 取数落点走 **body.targetId**(执行路由不读 `?scope=`,SPEC §2.6.3);
      // widget 自己声明的落点优先(见 executeBiQuery 的 opts.targetId 注释)。
      // @kf-batch 50-WP31-place-first-class —— 落点唯一作者 biLandingOf(widget 自带 > 请求点名;都没有 ⇒ 400)
      targetId: biLandingOf(source, body?.targetId, "preview"),
      filters: body?.filters as DashboardFilter[] | undefined,
      filterValues: body?.filterValues as Record<string, string> | undefined,
    });
    // 带上生成的 SQL(builder 模式),前端保存时把它写进 source.sql。
    return apiOk(generatedSql ? { ...result, sql: generatedSql } : result);
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
