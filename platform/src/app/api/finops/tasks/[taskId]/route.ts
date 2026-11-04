export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { listCostRuns } from "@/lib/finops/store";
// 排行按 (task, target) 分行后,展开明细要只看**那一行**的执行环境
// 每条 run 回带 `effectiveTargetId`(归属判定 = 范围过滤同一条规则 `scalarTargetOf`,存量无章行归主控区),
// 前端按它等值筛 —— 不在前端再写一遍「缺章 ⇒ 主控区」的规则(那会成为第二个作者)。
import { scalarTargetOf } from "@/lib/exec-env/scope";

// GET /api/finops/tasks/[taskId] — 单任务 run 级成本明细(纯读)。RBAC: viewer。
export async function GET(req: NextRequest, props: { params: Promise<{ taskId: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;

  try {
    const runs = await listCostRuns(params.taskId);
    const items = runs.map((r) => ({ ...r, effectiveTargetId: scalarTargetOf(r as unknown as Record<string, unknown>, "cost") }));
    return apiOk({ items });
  } catch (e: unknown) {
    return apiError((e as Error).message || String(e), 500);
  }
}
