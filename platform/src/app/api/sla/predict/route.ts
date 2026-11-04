export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { getSla, saveLastPrediction, pushBreachAlert } from "@/lib/baseline/sla-service";
import { getBaseline } from "@/lib/baseline/learn";
// @kf-batch 50-WP4quater-reads(工单 SC-15)—— 🔴 预测必须用**这条 run 所在区**的基线。
// 用合计基线的后果不是「差一点」:两个区的时长分布混在一起,ETA 对两个区都不准,
// 而破线预警看起来一切正常(它有数字、只是那个数字属于别的区)。
import { baselineFor } from "@/lib/baseline/target-baseline";
import { predictEta, confirmBreachMultiWindow } from "@/lib/baseline/predict";
import { normalizeRuntime } from "@/lib/baseline/workflow-runtime";
import type { SlaPrediction } from "@/lib/baseline/types";

const USER_ID = "default-user";

// POST /api/sla/predict  { slaId, runId, startedAt?, triggerAt?, runtime?, breachHistory?, push? }
// 对进行中运行滚动预测 ETA + 破线判定(幂等,dedupeKey 保证同 run 只推一次)。editor(可能推告警)。
// runtime:节点级运行态(回放/注入用,验收"中途变慢");缺省则视作全节点 pending(基线保守 ETA)。
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

    const now = Date.now();
    const startedAtMs = body?.startedAt ? Date.parse(body.startedAt) : now;
    const triggerAtMs = body?.triggerAt ? Date.parse(body.triggerAt) : startedAtMs;

    // 取 DAG(workflow SLA)或单任务退化。
    let dag: any = { nodes: [], edges: [] };
    if (sla.target.scope === "workflow" && sla.target.workflowId) {
      const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.WORKFLOWS, Key: { userId: USER_ID, workflowId: sla.target.workflowId } }));
      if (Item?.dagDefinition) dag = Item.dagDefinition;
    } else if (sla.target.scope === "task" && sla.target.taskId) {
      // 单任务 SLA:退化为单节点 DAG。
      dag = { nodes: [{ id: sla.target.taskId, type: "task", data: { label: sla.target.taskId } }], edges: [] };
    }
    const nodeIds = (dag.nodes || []).map((n: any) => String(n.id));

    // 这条 run 跑在哪个区(run 行上的章;取不到就由 `baselineFor` 回落主控区)。
    // 🔴 从 body 里**不接受** targetId:那是让调用方决定「拿哪个区的基线算」,一旦传错就是
    // 「用 A 区的基线给 B 区的运行预测」,而错得完全无声。真值只能来自 run 记录本身。
    let runTargetId: string | undefined;
    try {
      const taskIdForRun = sla.target.taskId || sla.target.workflowId || "";
      if (taskIdForRun) {
        const { Item } = await docClient.send(
          new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId: taskIdForRun, runId }, ProjectionExpression: "targetId" })
        );
        if (typeof Item?.targetId === "string" && Item.targetId) runTargetId = Item.targetId;
      }
    } catch { /* best-effort:取不到就走回落 */ }

    // 每节点基线时长(缺基线用 0;冷启动节点不阻断预测)。
    const baselineCache: Record<string, number> = {};
    for (const id of nodeIds) {
      const row = await getBaseline(ctx.projectId, id).catch(() => null);
      const b = baselineFor(row, runTargetId);
      // 🔴 `baselineFor` 在「这个区没跑过」时回 null(刻意不回落合计)⇒ 这里就是 0 = 冷启动,
      // 与「没有基线」同一处置;绝不用别的区的数字冒充。
      baselineCache[id] = b?.durationSec?.p90 || b?.durationSec?.p50 || 0;
    }
    const baselineDurationOf = (id: string) => baselineCache[id] || 0;

    const runtime = normalizeRuntime(body?.runtime, nodeIds);

    const pred = predictEta({
      dag, baselineDurationOf, runtime, startedAtMs, triggerAtMs,
      slaTarget: sla.target, warnLeadMin: sla.warnLeadMin, now,
    });

    // 多窗口燃尽率去抖:breachHistory=最近若干次预测的 willBreach(旧→新,由调用方/前端维护)。
    const history: boolean[] = Array.isArray(body?.breachHistory) ? body.breachHistory.map(Boolean) : [];
    const confirmedBreach = confirmBreachMultiWindow(pred.willBreach, history);

    const prediction: SlaPrediction = {
      runId,
      etaAt: new Date(pred.etaAtMs).toISOString(),
      willBreach: pred.willBreach,
      riskLevel: pred.riskLevel,
      criticalPathNode: pred.criticalPathNode,
      slaAt: new Date(pred.slaAtMs).toISOString(),
      marginMin: pred.marginMin,
      at: new Date(now).toISOString(),
    };
    await saveLastPrediction(ctx.projectId, sla.slaId, prediction);

    // 推送:仅当多窗口确认破线且调用方允许 push(默认 true)。幂等由 dedupeKey 保证。
    let push: { pushed: boolean; status?: string } = { pushed: false };
    if (confirmedBreach && body?.push !== false) {
      push = await pushBreachAlert(sla, prediction, { node: pred.criticalPathNode });
    }

    return apiOk({ prediction, confirmedBreach, remainingSec: pred.remainingSec, push });
  } catch (e: any) {
    return apiError(e?.message || "预测失败", 500);
  }
}
