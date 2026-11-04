export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { detectTaskAnomalies, detectServiceAnomalies, settleAnomalies } from "@/lib/finops/anomaly";
import { evaluateBudgets } from "@/lib/finops/budget-eval";

// POST /api/finops/detect — 异常检测 + 闭环(34 通道推送 + 43-A 知识库沉淀)+ 预算评估。
// 全链幂等(事件 dedupeKey / occurrence 条件写 / 预算月度档标记),重复触发不重推。RBAC: editor。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;

  try {
    const anomalies = [...(await detectTaskAnomalies()), ...(await detectServiceAnomalies())];
    const settled = await settleAnomalies(anomalies);
    const budgets = await evaluateBudgets();
    return apiOk({ anomalies: settled, budgets });
  } catch (e: unknown) {
    return apiError((e as Error).message || String(e), 500);
  }
}
