export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { getSla } from "@/lib/baseline/sla-service";
// 预测本体是唯一作者 `lib/baseline/sla-predict.ts`(后台评估泵走同一个函数;两边算出的数字不许各一份)。
import { predictSlaRun } from "@/lib/baseline/sla-predict";

// POST /api/sla/predict  { slaId, runId, startedAt?, triggerAt?, runtime?, breachHistory?, push? }
// 对进行中运行滚动预测 ETA + 破线判定(幂等,dedupeKey 保证同 run 只推一次)。editor(可能推告警)。
// runtime:节点级运行态(回放/注入用,验收"中途变慢");缺省则视作全节点 pending(基线保守 ETA)。
// 🔴 从 body 里**不接受** targetId:那是让调用方决定「拿哪个区的基线算」,一旦传错就是
// 「用 A 区的基线给 B 区的运行预测」,而错得完全无声。真值只能来自 run 记录本身(sla-predict 里读)。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  try {
    const sla = await getSla(ctx.projectId, String(body?.slaId || ""));
    if (!sla) return apiError("SLA 不存在", 404, { code: "NOT_FOUND" });
    if (!sla.enabled) return apiError("SLA 已禁用", 400, { code: "VALIDATION_FAILED" });

    const runId = String(body?.runId || "");
    if (!runId) return apiError("缺少 runId", 400, { code: "VALIDATION_FAILED" });

    const r = await predictSlaRun(ctx.projectId, sla, {
      runId,
      startedAt: typeof body?.startedAt === "string" ? body.startedAt : undefined,
      triggerAt: typeof body?.triggerAt === "string" ? body.triggerAt : undefined,
      runtime: body?.runtime && typeof body.runtime === "object" ? body.runtime : undefined,
      breachHistory: Array.isArray(body?.breachHistory) ? body.breachHistory.map(Boolean) : [],
      push: body?.push !== false,
    });
    return apiOk({ prediction: r.prediction, confirmedBreach: r.confirmedBreach, remainingSec: r.remainingSec, push: r.push });
  } catch (e: any) {
    return apiError(e?.message || "预测失败", 500);
  }
}
