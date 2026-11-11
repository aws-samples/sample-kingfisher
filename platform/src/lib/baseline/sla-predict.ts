// 「对一条 SLA 的一次运行算一次破线预测(并按需推送)」的**唯一作者**。
//
// 两个调用方走同一个函数:
//   · `POST /api/sla/predict`(页面 / 回放注入,调用方可以传节点级运行态与自己攒的 breachHistory);
//   · 后台评估泵(`lib/alerting/tick.ts`):对每条启用的 SLA 找出绑定对象的在途运行,逐条滚动预测,
//     多窗口确认历史落在 SLA 行(`breachHistory`),确认破线即经通道推送(按 (slaId, runId) 去重)。
// 原来这段逻辑只住在路由文件里 ⇒ 后台要预测就得再抄一份;抄两份的下场是「页面预测的数字与后台推送的数字对不上」。
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { saveLastPrediction, saveBreachHistory, pushBreachAlert, BREACH_HISTORY_MAX } from "@/lib/baseline/sla-service";
import { getBaseline } from "@/lib/baseline/learn";
// 🔴 预测必须用**这条 run 所在区**的基线。
// 用合计基线的后果不是「差一点」:两个区的时长分布混在一起,ETA 对两个区都不准,
// 而破线预警看起来一切正常(它有数字、只是那个数字属于别的区)。
import { baselineFor } from "@/lib/baseline/target-baseline";
import { predictEta, confirmBreachMultiWindow } from "@/lib/baseline/predict";
import { normalizeRuntime } from "@/lib/baseline/workflow-runtime";
import type { SlaPrediction, SlaRow } from "@/lib/baseline/types";

const USER_ID = "default-user";

export interface PredictRunInput {
  runId: string;
  startedAt?: string;
  triggerAt?: string;
  /** 节点级运行态(回放 / 注入用,验收「中途变慢」);缺省视作全节点 pending(基线保守 ETA)。 */
  runtime?: Record<string, unknown>;
  /** 最近若干次预测的 willBreach(旧 → 新),多窗口确认用。 */
  breachHistory?: boolean[];
  /** 确认破线时是否经通道推送(缺省 true)。 */
  push?: boolean;
  now?: number;
}

export interface PredictRunResult {
  prediction: SlaPrediction;
  confirmedBreach: boolean;
  remainingSec: number;
  push: { pushed: boolean; status?: string };
}

/** 这条 run 跑在哪个区:真值只来自 run 记录本身(调用方传的 targetId 不接受 —— 传错了就是「用 A 区基线给 B 区预测」且无声)。 */
async function targetOfRun(sla: SlaRow, runId: string): Promise<string | undefined> {
  const taskIdForRun = sla.target.taskId || sla.target.workflowId || "";
  if (!taskIdForRun) return undefined;
  try {
    const { Item } = await docClient.send(
      new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId: taskIdForRun, runId }, ProjectionExpression: "targetId" })
    );
    return typeof Item?.targetId === "string" && Item.targetId ? Item.targetId : undefined;
  } catch {
    return undefined; // best-effort:取不到就走回落
  }
}

/** 对一条启用的 SLA 的一次运行算一次预测;落 lastPrediction;确认破线且允许推送 ⇒ 经通道推送。 */
export async function predictSlaRun(projectId: string, sla: SlaRow, input: PredictRunInput): Promise<PredictRunResult> {
  const now = input.now ?? Date.now();
  const startedAtMs = input.startedAt ? Date.parse(input.startedAt) : now;
  const triggerAtMs = input.triggerAt ? Date.parse(input.triggerAt) : startedAtMs;

  // 取 DAG(workflow SLA)或单任务退化。
  let dag: { nodes?: unknown[]; edges?: unknown[] } = { nodes: [], edges: [] };
  if (sla.target.scope === "workflow" && sla.target.workflowId) {
    const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.WORKFLOWS, Key: { userId: USER_ID, workflowId: sla.target.workflowId } }));
    if (Item?.dagDefinition) dag = Item.dagDefinition;
  } else if (sla.target.scope === "task" && sla.target.taskId) {
    // 单任务 SLA:退化为单节点 DAG。
    dag = { nodes: [{ id: sla.target.taskId, type: "task", data: { label: sla.target.taskId } }], edges: [] };
  }
  const nodeIds = ((dag.nodes || []) as Array<{ id: unknown }>).map((n) => String(n.id));

  const runTargetId = await targetOfRun(sla, input.runId);

  // 每节点基线时长(缺基线用 0;冷启动节点不阻断预测)。
  const baselineCache: Record<string, number> = {};
  for (const id of nodeIds) {
    const row = await getBaseline(projectId, id).catch(() => null);
    const b = baselineFor(row, runTargetId);
    // 🔴 `baselineFor` 在「这个区没跑过」时回 null(刻意不回落合计)⇒ 这里就是 0 = 冷启动,
    // 与「没有基线」同一处置;绝不用别的区的数字冒充。
    baselineCache[id] = b?.durationSec?.p90 || b?.durationSec?.p50 || 0;
  }
  const baselineDurationOf = (id: string) => baselineCache[id] || 0;

  const runtime = normalizeRuntime(input.runtime as Record<string, unknown> | undefined, nodeIds);

  const pred = predictEta({
    dag, baselineDurationOf, runtime, startedAtMs, triggerAtMs,
    slaTarget: sla.target, warnLeadMin: sla.warnLeadMin, now,
  });

  // 多窗口燃尽率去抖:breachHistory = 最近若干次预测的 willBreach(旧→新)。
  const history: boolean[] = Array.isArray(input.breachHistory) ? input.breachHistory.map(Boolean) : [];
  const confirmedBreach = confirmBreachMultiWindow(pred.willBreach, history);

  const prediction: SlaPrediction = {
    runId: input.runId,
    etaAt: new Date(pred.etaAtMs).toISOString(),
    willBreach: pred.willBreach,
    riskLevel: pred.riskLevel,
    criticalPathNode: pred.criticalPathNode,
    slaAt: new Date(pred.slaAtMs).toISOString(),
    marginMin: pred.marginMin,
    at: new Date(now).toISOString(),
  };
  await saveLastPrediction(projectId, sla.slaId, prediction);

  // 推送:仅当多窗口确认破线且调用方允许 push(默认 true)。幂等由 dedupeKey 保证。
  let push: { pushed: boolean; status?: string } = { pushed: false };
  if (confirmedBreach && input.push !== false) {
    push = await pushBreachAlert(sla, prediction, { node: pred.criticalPathNode });
  }
  return { prediction, confirmedBreach, remainingSec: pred.remainingSec, push };
}

/** 在途运行(与运行台账的状态词一致:`running`)。 */
export interface InFlightRun {
  runId: string;
  startedAt?: string;
}

/** 这条 SLA 绑定对象(任务 / 工作流)当前在途的运行(Query 运行台账的那一个分区;最多翻 5 页)。 */
export async function listInFlightRuns(sla: SlaRow): Promise<InFlightRun[]> {
  const taskId = sla.target.taskId || sla.target.workflowId || "";
  if (!taskId) return [];
  const out: InFlightRun[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < 5; page++) {
    const r = await docClient.send(
      new QueryCommand({
        TableName: TABLES.TASK_RUNS,
        KeyConditionExpression: "taskId = :t",
        FilterExpression: "#s = :running",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":t": taskId, ":running": "running" },
        ProjectionExpression: "runId, startedAt",
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      })
    );
    for (const it of r.Items ?? []) {
      const runId = String(it.runId ?? "");
      if (runId) out.push({ runId, startedAt: typeof it.startedAt === "string" ? it.startedAt : undefined });
    }
    startKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!startKey) break;
  }
  // 最近开始的在前(lastPrediction 只存一份 ⇒ 存最新那次运行的)
  out.sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
  return out;
}

export interface SlaSweepSummary {
  runs: number;
  breachAlerts: number;
}

/**
 * 后台泵用:对这条启用的 SLA 的每个在途运行滚动预测一次;多窗口确认历史从 SLA 行读、预测后写回。
 * 多个在途运行时逐条预测(每条各自去重推送),lastPrediction 落最新开始的那条(先预测旧的、最后预测最新的)。
 */
export async function predictInFlightRuns(projectId: string, sla: SlaRow, now = Date.now()): Promise<SlaSweepSummary> {
  const runs = await listInFlightRuns(sla);
  let breachAlerts = 0;
  for (const run of [...runs].reverse()) {
    const prior = sla.breachHistory && sla.breachHistory.runId === run.runId ? sla.breachHistory.flags : [];
    const r = await predictSlaRun(projectId, sla, { runId: run.runId, startedAt: run.startedAt, breachHistory: prior, push: true, now });
    const flags = [...prior, r.prediction.willBreach].slice(-BREACH_HISTORY_MAX);
    await saveBreachHistory(projectId, sla.slaId, run.runId, flags);
    sla = { ...sla, breachHistory: { runId: run.runId, flags } };
    if (r.push.pushed) breachAlerts++;
  }
  return { runs: runs.length, breachAlerts };
}
