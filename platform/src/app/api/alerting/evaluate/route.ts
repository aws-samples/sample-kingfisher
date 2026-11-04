export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { evaluate } from "@/lib/alerting/evaluate";

// POST /api/alerting/evaluate — 触发一次告警评估(editor)。幂等:同一 run/窗口不重复告警。
// 首期由告警中心/大屏轮询或手动"立即评估"调用(无常驻 worker,零常驻成本)。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  try {
    const summary = await evaluate(ctx.projectId, ctx.identity.username);
    if (summary.newEvents > 0) {
      recordAudit(req, "alerting.evaluate", { resourceType: "alert-event", detail: { newEvents: summary.newEvents, rules: summary.rulesEvaluated } }).catch(() => {});
    }
    return apiOk(summary);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
