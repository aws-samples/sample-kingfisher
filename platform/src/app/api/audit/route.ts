export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { queryAuditLog } from "@/lib/audit";
// @kf-batch 50-WP4ter-coverage —— 执行范围(工单 SC-12)
import { requireScope } from "@/lib/exec-env/scope";
import { getActiveProjectId } from "@/lib/projects/guard";
import { NextResponse } from "next/server";

// AUTH-04 — list operation audit entries (most recent first). Protected by the platform
// middleware like every other /api/* route.
export async function GET(req: NextRequest) {
  try {
    // @kf-batch 50-WP4ter-coverage —— 审计页是平台级(无 requireProject)⇒ 项目上下文取活跃项目头,
    // 🔴 不许塞 null(塞 null 会让设了项目白名单的 target 在这一页恒 403,而它在别的页好得很)
    const scope = await requireScope(req, getActiveProjectId(req));
    if (scope instanceof NextResponse) return scope;
    const limit = Number(req.nextUrl.searchParams.get("limit") || 200);
    const items = await queryAuditLog(Number.isFinite(limit) ? limit : 200, { scope });
    return apiOk(items);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
