// 模块 43-B — 动态基线学习器。从 bgp-task-runs 历史学出每任务的时长/准点/成功率基线。
//
// 🔴 硬约束(用户反复强调):**学习必须排除 triggeredBy='backfill'** —— 否则补数大批量重算会
// 拉高 p90 失真。此外用 MAD 去异常兜底偶发慢跑。纯读 bgp-task-runs,零写回台账,不干扰在线。

import { ScanCommand, QueryCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { percentile, stdev, ewma, removeOutliersMAD, median } from "./stats";
import type { BaselineRow, DurationStats, TargetBaseline } from "./types";
// 模块47 P4.0:在线隔离标常量(单一定义,copilot/plan/types.ts 零依赖,import 安全无循环)。
import { COPILOT_TRIGGERED_BY } from "@/lib/copilot/plan/types";
// @kf-batch 50-WP4quater-reads(工单 SC-15)—— 「这条 run 归哪个区」只有一个作者(含缺章回落主控区)
import { scalarTargetOf } from "@/lib/exec-env/scope";

const ALGO_VERSION = "mad-ewma-v1";
export const MIN_SAMPLES = 7; // 样本 < 7 → lowConfidence(冷启动不误报)
const DEFAULT_WINDOW_DAYS = 30;
const baselinePk = (projectId: string) => `baseline#${projectId}`;

interface RunLite {
  taskId: string;
  // @kf-batch 50-WP4quater-reads(工单 SC-15)—— 这次 run 跑在哪个区(run-records 的章)。
  // 缺失 ⇒ 由 `scalarTargetOf` 统一回落主控区(落章之前作业只在主控区跑过,是历史事实)。
  targetId?: string;
  taskType?: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
  duration?: number;
  triggeredBy?: string;
  runDate?: string;
}

// 从一组成功 run 的时长算基线统计(已去 backfill、已去异常)。
export function computeDurationStats(durationsChrono: number[], windowDays: number): DurationStats {
  const cleaned = removeOutliersMAD(durationsChrono);
  return {
    p50: Math.round(percentile(cleaned, 50)),
    p90: Math.round(percentile(cleaned, 90)),
    p95: Math.round(percentile(cleaned, 95)),
    ewma: Math.round(ewma(durationsChrono)), // EWMA 用原时序(近期趋势),不去异常
    stdev: Math.round(stdev(cleaned)),
    samples: cleaned.length,
    windowDays,
  };
}

// 从原始 run 集(单任务)派生一条基线行。纯函数,可单测。
export function deriveBaseline(args: {
  projectId: string;
  taskId: string;
  runs: RunLite[];
  taskName?: string;
  windowDays?: number;
  now?: number;
}): BaselineRow {
  const windowDays = args.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = args.now ?? Date.now();
  const cutoff = new Date(now - windowDays * 86400_000).toISOString();

  // 窗口内 + 排除 backfill 与 copilot 触发(硬约束:在线隔离)。
  // 模块47 L4/P4.0:补 copilot 排除。补数(backfill)与 Copilot 代执行(copilot)都是"非常规触发",
  // 会污染任务运行基线(SLA/时长预测),须排除。COPILOT_TRIGGERED_BY 常量避免裸写字符串散落。
  const inWindow = args.runs.filter((r) =>
    (r.startedAt || r.finishedAt || "") >= cutoff &&
    r.triggeredBy !== "backfill" &&
    r.triggeredBy !== COPILOT_TRIGGERED_BY);
  const terminal = inWindow.filter((r) => r.status === "succeeded" || r.status === "failed");
  const succeeded = inWindow.filter((r) => r.status === "succeeded");

  // 时长样本:成功 run 且时长 > 0,按时间旧→新(EWMA 需时序)。
  const chrono = [...succeeded].sort((a, b) => (a.startedAt || "").localeCompare(b.startedAt || ""));
  const durations = chrono.map((r) => Number(r.duration || 0)).filter((d) => d > 0);
  const durationSec = computeDurationStats(durations, windowDays);

  // 排队延迟:此处无独立"调度触发时刻"字段,首期置 0(ETA 主要靠时长);字段保留供后续接入。
  const startDelay = { p50Sec: 0, p90Sec: 0 };

  // 准点率:成功 run 中时长 ≤ p90×1.5 的占比(相对自身基线,而非固定阈值)。样本不足则 100。
  const punctualThreshold = durationSec.p90 > 0 ? durationSec.p90 * 1.5 : Infinity;
  const onTime = durations.filter((d) => d <= punctualThreshold).length;
  const punctuality = { onTimeRate: durations.length ? Math.round((onTime / durations.length) * 100) : 100, samples: durations.length };

  const successRate = { value: terminal.length ? Math.round((succeeded.length / terminal.length) * 100) : 100, samples: terminal.length };

  // @kf-batch 50-WP4quater-reads(工单 SC-15)—— **按区各算一份**。
  // 🔴 复用**同一个** `statsOf`,不在这里把上面那段算法抄第二遍:抄一遍就等于「合计口径」与
  // 「按区口径」各有一个作者,将来只改一处就会让两个数字对不上(而对不上时没人知道哪个是对的)。
  const byTarget: Record<string, TargetBaseline> = {};
  for (const tid of Array.from(new Set(inWindow.map((r) => scalarTargetOf(r as unknown as Record<string, unknown>, "run"))))) {
    byTarget[tid] = statsOf(inWindow.filter((r) => scalarTargetOf(r as unknown as Record<string, unknown>, "run") === tid), windowDays);
  }
  const targets = Object.keys(byTarget).sort();

  return {
    pk: baselinePk(args.projectId),
    taskId: args.taskId,
    projectId: args.projectId,
    taskType: chrono[0]?.taskType || inWindow[0]?.taskType,
    taskName: args.taskName,
    durationSec,
    startDelay,
    punctuality,
    successRate,
    byTarget,
    targets,
    learnedAt: new Date(now).toISOString(),
    algoVersion: ALGO_VERSION,
    lowConfidence: durations.length < MIN_SAMPLES,
  };
}

/**
 * @kf-batch 50-WP4quater-reads(工单 SC-15)
 * 一组(已过窗口 / 已去 backfill 与 copilot 的)run → 一份基线统计。
 * `deriveBaseline` 的合计口径与每个区的口径**都调它**,所以两者永远是同一套算法。
 */
export function statsOf(runs: RunLite[], windowDays: number): TargetBaseline {
  const terminal = runs.filter((r) => r.status === "succeeded" || r.status === "failed");
  const succeeded = runs.filter((r) => r.status === "succeeded");
  const chrono = [...succeeded].sort((a, b) => (a.startedAt || "").localeCompare(b.startedAt || ""));
  const durations = chrono.map((r) => Number(r.duration || 0)).filter((d) => d > 0);
  const durationSec = computeDurationStats(durations, windowDays);
  const punctualThreshold = durationSec.p90 > 0 ? durationSec.p90 * 1.5 : Infinity;
  const onTime = durations.filter((d) => d <= punctualThreshold).length;
  return {
    durationSec,
    startDelay: { p50Sec: 0, p90Sec: 0 },
    punctuality: { onTimeRate: durations.length ? Math.round((onTime / durations.length) * 100) : 100, samples: durations.length },
    successRate: { value: terminal.length ? Math.round((succeeded.length / terminal.length) * 100) : 100, samples: terminal.length },
    lowConfidence: durations.length < MIN_SAMPLES,
  };
}

// 读某任务全部 run(Query by taskId,ScanIndexForward=false,取近 500)。
async function fetchRuns(taskId: string): Promise<RunLite[]> {
  const { Items = [] } = await docClient.send(new QueryCommand({
    TableName: TABLES.TASK_RUNS,
    KeyConditionExpression: "taskId = :t",
    ExpressionAttributeValues: { ":t": taskId },
    ScanIndexForward: false,
    Limit: 500,
  }));
  return Items as RunLite[];
}

// 学习单任务并落库。返回基线行。
export async function learnBaseline(projectId: string, taskId: string, taskName?: string): Promise<BaselineRow> {
  const runs = await fetchRuns(taskId);
  const baseline = deriveBaseline({ projectId, taskId, runs, taskName });
  await docClient.send(new PutCommand({ TableName: TABLES.BASELINES, Item: baseline }));
  return baseline;
}

// 全量学习:扫 bgp-task-runs 求出现过的 taskId 集,逐个学习。返回学到的任务数。
// (演示量级 Scan 够用;taskName 从各资源表 join,缺失则用 taskId。)
export async function learnAllBaselines(projectId: string): Promise<{ learned: number; taskIds: string[] }> {
  const { Items = [] } = await docClient.send(new ScanCommand({ TableName: TABLES.TASK_RUNS, ProjectionExpression: "taskId", Limit: 2000 }));
  const taskIds = Array.from(new Set((Items as RunLite[]).map((r) => r.taskId).filter(Boolean)));
  const names = await loadTaskNames();
  for (const taskId of taskIds) {
    await learnBaseline(projectId, taskId, names[taskId]).catch(() => {});
  }
  return { learned: taskIds.length, taskIds };
}

// 读取基线(单任务 / 全部)。
export async function getBaseline(projectId: string, taskId: string): Promise<BaselineRow | null> {
  const { Items = [] } = await docClient.send(new QueryCommand({
    TableName: TABLES.BASELINES,
    KeyConditionExpression: "pk = :p AND taskId = :t",
    ExpressionAttributeValues: { ":p": baselinePk(projectId), ":t": taskId },
  }));
  return (Items[0] as BaselineRow) || null;
}

export async function listBaselines(projectId: string): Promise<BaselineRow[]> {
  const { Items = [] } = await docClient.send(new QueryCommand({
    TableName: TABLES.BASELINES,
    KeyConditionExpression: "pk = :p",
    ExpressionAttributeValues: { ":p": baselinePk(projectId) },
  }));
  return Items as BaselineRow[];
}

// 各资源表名 join(与 ops-summary 同思路,best-effort)。
async function loadTaskNames(): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  const scan = (table: string, idKey: string) => docClient.send(new ScanCommand({
    TableName: table, ProjectionExpression: `${idKey}, #n`, ExpressionAttributeNames: { "#n": "name" },
  })).then((r) => { for (const it of r.Items || []) names[(it as any)[idKey]] = (it as any).name; }).catch(() => {});
  await Promise.all([
    scan(TABLES.SYNC_TASKS, "taskId"), scan(TABLES.WORKFLOWS, "workflowId"),
    scan(TABLES.ETL_JOBS, "jobId"), scan(TABLES.ENGINE_JOBS, "jobId"),
  ]);
  return names;
}
