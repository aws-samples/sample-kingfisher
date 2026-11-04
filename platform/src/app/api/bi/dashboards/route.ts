// 仪表盘集合路由:GET 列表 / POST 建。
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { listDashboards, createDashboard } from "@/lib/bi/dashboards";

export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  try {
    return apiOk(await listDashboards(ctx.projectId));
  } catch (e: any) {
    return apiError(e?.message || "查询仪表盘失败", 500);
  }
}

export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  try {
    const dashboard = await createDashboard(body, { projectId: ctx.projectId, createdBy: ctx.identity.username });
    recordAudit(req, "bi.dashboard.create", { resourceType: "bi-dashboard", resourceId: dashboard.dashboardId }).catch(() => {});
    return apiOk(dashboard, 201);
  } catch (e: any) {
    return apiError(e?.message || "创建仪表盘失败", 400);
  }
}
