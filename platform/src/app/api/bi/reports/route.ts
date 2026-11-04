// 报表 widget 集合路由:GET 列表 / POST 建。
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { listReports, createReport } from "@/lib/bi/reports";
// 与 analyses 同一条:**opt-in** 过滤(默认不过滤),
// 每行回派生的 `regions`。用户原话:「我觉得可以增加一个过滤能力,默认不过滤。」
import { readScope } from "@/lib/exec-env/scope";
import { scopeTargets } from "@/lib/scope/scope";
import { reportRegions, filterDefinitionsByRegions } from "@/lib/bi/definition-regions";

export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  try {
    const rows = await listReports(ctx.projectId);
    const withRegions = rows.map((r) => ({ ...r, regions: reportRegions(r) }));
    const scope = readScope(req);
    const on = req.nextUrl.searchParams.get("scopeFilter") === "1";
    return apiOk(
      filterDefinitionsByRegions(withRegions, (r) => r.regions, scope ? scopeTargets(scope) : [], on)
    );
  } catch (e: any) {
    return apiError(e?.message || "查询报表失败", 500);
  }
}

export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  try {
    const report = await createReport(body, { projectId: ctx.projectId, createdBy: ctx.identity.username });
    recordAudit(req, "bi.report.create", { resourceType: "bi-report", resourceId: report.reportId }).catch(() => {});
    return apiOk(report, 201);
  } catch (e: any) {
    return apiError(e?.message || "创建报表失败", 400);
  }
}
