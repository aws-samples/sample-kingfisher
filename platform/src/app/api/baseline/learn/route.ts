export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { learnBaseline, learnAllBaselines } from "@/lib/baseline/learn";

// POST /api/baseline/learn  { taskId? }
// 手动触发一次学习:给 taskId 则单任务,否则全量。editor。学习器 DAG 亦可周期调本端点。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  try {
    if (body?.taskId) {
      const baseline = await learnBaseline(ctx.projectId, String(body.taskId), body?.taskName);
      recordAudit(req, "baseline.learn", { resourceType: "baseline", resourceId: body.taskId, detail: { scope: "task" } }).catch(() => {});
      return apiOk(baseline);
    }
    const res = await learnAllBaselines(ctx.projectId);
    recordAudit(req, "baseline.learn", { resourceType: "baseline", resourceId: "all", detail: { learned: res.learned } }).catch(() => {});
    return apiOk(res);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
