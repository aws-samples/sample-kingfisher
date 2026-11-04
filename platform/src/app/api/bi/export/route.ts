// CSV 导出:POST body={source, filters?, filterValues?, filename?}。
// 复用 executeBiQuery(结果已脱敏)→ 服务端拼 CSV,返回 text/csv 附件。viewer 权限。
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { getCorrelationId } from "@/lib/observability/logger";
import { executeBiQuery, executeBiDataApi, biLandingOf, type BiQueryError } from "@/lib/bi/query";
import { placeErrorResponse } from "@/lib/place/route";
import type { WidgetSource, DashboardFilter, BiQueryResult } from "@/lib/bi/types";

function isBiQueryError(e: unknown): e is BiQueryError {
  return !!e && typeof e === "object" && "status" in e && "error" in e;
}

// RFC 4180:含逗号/引号/换行的单元格用双引号包裹,内部引号翻倍。
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(result: BiQueryResult): string {
  const header = result.columns.map(csvCell).join(",");
  const lines = result.rows.map((row) => row.map(csvCell).join(","));
  // BOM 让 Excel 正确识别 UTF-8(中文列名不乱码)。
  return "\uFEFF" + [header, ...lines].join("\r\n"); // ↑ 字面 BOM 改转义（值逐字节相同）：不可见字符不进源码
}

// 安全的下载文件名(去掉路径分隔符/控制字符),默认 report.csv。
function safeFilename(name: unknown): string {
  const base = String(name || "report").replace(/[^\w.\-一-龥]+/g, "_").slice(0, 80) || "report";
  return base.toLowerCase().endsWith(".csv") ? base : base + ".csv";
}

export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const cid = getCorrelationId(req);
  const body = await req.json().catch(() => ({}));
  const source = body?.source as WidgetSource | undefined;
  if (!source || !source.kind) return apiError("缺少 source", 400, { code: "VALIDATION_FAILED", correlationId: cid });

  try {
    let result: BiQueryResult;
    if (source.kind === "dataapi") {
      result = await executeBiDataApi(ctx.projectId, source.apiId, source.params || {}, ctx.identity, cid);
    } else {
      result = await executeBiQuery(source, {
        // 已保存视觉对象的章(无章 = 「全部」视角建的 = 主控区),显式传下去
        targetId: biLandingOf(source, body?.targetId, "saved"),
        identity: ctx.identity,
        projectId: ctx.projectId,
        correlationId: cid,
        filters: body?.filters as DashboardFilter[] | undefined,
        filterValues: body?.filterValues as Record<string, string> | undefined,
      });
    }
    const csv = toCsv(result);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeFilename(body?.filename)}"`,
      },
    });
  } catch (e) {
    const pr = placeErrorResponse(e);
    if (pr) return pr;
    if (isBiQueryError(e)) {
      // BiQueryError 自带 code 时优先透传(数据服务下线的 410 GONE),否则按 status 归类。
      const code = e.code ?? (e.status === 504 ? "UPSTREAM_TIMEOUT" : e.status >= 500 ? "UPSTREAM_ERROR" : "VALIDATION_FAILED");
      return apiError(e.error, e.status, { code, correlationId: cid });
    }
    return apiError(e instanceof Error ? e.message : "导出失败", 500, { code: "INTERNAL", correlationId: cid });
  }
}
