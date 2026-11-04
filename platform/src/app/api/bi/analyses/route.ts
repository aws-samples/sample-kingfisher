// 模块 37 v4 — 分析看板集合路由:GET 列表 / POST 建。照抄 reports 路由的 guard/审计/信封。
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { listAnalyses, createAnalysis } from "@/lib/bi/analysis";
// @kf-batch 50-WP4quater-reads(工单 SC-28)—— 🔴 用户 2026-09-10 定案:「**增加一个过滤能力,
// 默认不过滤**」。所以这里是 **opt-in**:只有显式带 `?scopeFilter=1` 才按范围筛;
// 缺省(以及只带 `?scope=` 而不带这个开关)一律原样返回 —— 顶栏切区不该悄悄藏掉别区的报表。
// 每行都回派生出来的 `regions`(涉及哪些区),让列表能显示区标签、用户自己判断。
import { readScope } from "@/lib/exec-env/scope";
import { scopeTargets } from "@/lib/scope/scope";
import { analysisRegions, filterDefinitionsByRegions } from "@/lib/bi/definition-regions";

export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  try {
    const rows = await listAnalyses(ctx.projectId);
    const withRegions = rows.map((a) => ({ ...a, regions: analysisRegions(a) }));
    const scope = readScope(req);
    const on = req.nextUrl.searchParams.get("scopeFilter") === "1";
    return apiOk(
      filterDefinitionsByRegions(withRegions, (r) => r.regions, scope ? scopeTargets(scope) : [], on)
    );
  } catch (e: any) {
    return apiError(e?.message || "查询分析看板失败", 500);
  }
}

export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  try {
    const analysis = await createAnalysis(body, { projectId: ctx.projectId, createdBy: ctx.identity.username });
    recordAudit(req, "bi.analysis.create", { resourceType: "bi-analysis", resourceId: analysis.analysisId }).catch(() => {});
    return apiOk(analysis, 201);
  } catch (e: any) {
    return apiError(e?.message || "创建分析看板失败", 400);
  }
}
