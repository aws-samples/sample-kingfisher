export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { listRecentEvents, listEventsByRule } from "@/lib/alerting/events";
// 执行范围
import { requireScope, filterRowsByScalar } from "@/lib/exec-env/scope";

// GET /api/alerting/events?ruleId=&limit= — 告警事件流(viewer)。带 ruleId 查单规则,否则跨规则最近事件。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const scope = await requireScope(req, ctx.projectId);
  if (scope instanceof NextResponse) return scope;
  const ruleId = req.nextUrl.searchParams.get("ruleId") || "";
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || 100), 500);
  try {
    const events = ruleId
      ? await listEventsByRule(ruleId, limit)
      : await listRecentEvents({ projectId: ctx.projectId, limit });
    // A 类标量过滤(事件行的章来自评估时算出的那个区);
    // 🔴 池化评估的事件没有章 ⇒ 经 `scalarTargetOf` 归主控区(它本来就是「全平台合起来」的口径)
    return apiOk(filterRowsByScalar(events as unknown as Array<Record<string, unknown>>, scope, "alert"));
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
