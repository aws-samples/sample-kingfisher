// 运维大屏聚合。一次性算出 /ops 大屏所有卡片数据:任务态分布、近 N 日趋势、
// Top 慢任务、成功率/准点率、甘特时间线数据、最近告警。复用共享运行台账 bgp-task-runs +
// 各资源表的名称 join(同 api/monitor/runs 口径)。演示量级 Scan 够用(实时级 GSI 留二期)。

import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { listRecentEvents } from "./events";
// 按区(run 与告警事件都过同一套标量过滤)
import { filterRowsByScalar, type TargetScope } from "@/lib/exec-env/scope";

interface Run {
  taskId: string;
  runId: string;
  taskType?: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
  duration?: number;
  triggeredBy?: string;
}

export interface OpsSummary {
  generatedAt: string;
  stats: { running: number; todayTotal: number; todaySuccess: number; todayFailed: number; successRate: number; avgDuration: number };
  statusDist: { label: string; value: number }[]; // 任务态分布(succeeded/failed/running/stopped)
  trend: { label: string; value: number }[]; // 近 7 日运行数
  topSlow: { taskName: string; taskType: string; duration: number; runId: string }[];
  gantt: { taskId: string; taskName: string; taskType: string; status: string; startedAt: string; finishedAt: string; duration: number }[];
  recentAlerts: { ruleName: string; severity: string; message: string; msgKey?: string; msgParams?: Record<string, string | number>; status: string; createdAt: string }[];
  punctualityRate: number; // 准点率:终态 run 中未超 30 分钟的占比(首期固定阈值,基线学习留二期)
}

const DEFAULT_PUNCTUAL_SECONDS = 30 * 60; // 首期固定"准点"阈值 30 分钟

async function scanTable(table: string, proj: string): Promise<any[]> {
  try {
    const { Items = [] } = await docClient.send(
      new ScanCommand({ TableName: table, ProjectionExpression: proj, ExpressionAttributeNames: { "#n": "name" } })
    );
    return Items;
  } catch {
    return [];
  }
}

/**
 * @param opts.scope 传了就只统计**该执行范围**的 run 与告警事件。
 *
 * 🔴 运维大屏原来是全平台一锅端 —— 而它恰恰是最需要按区看的一页:一个区的成功率塌了,
 * 混进另一个区的健康数据后大屏上还是一片绿(与告警池化是同一个病,只是这里表现为「看不出来」)。
 * 🔴 资源名映射(nameMap)**不按区过滤**:它只是 id → 名字的字典,过滤它只会让名字显示成 id。
 */
export async function buildOpsSummary(opts: { scope?: TargetScope } = {}): Promise<OpsSummary> {
  const now = new Date();
  const [{ Items: runsRaw = [] }, syncTasks, workflows, etlJobs, engineJobs, recentEvents] = await Promise.all([
    docClient.send(new ScanCommand({ TableName: TABLES.TASK_RUNS, Limit: 500 })),
    scanTable(TABLES.SYNC_TASKS, "taskId, #n"),
    scanTable(TABLES.WORKFLOWS, "workflowId, #n"),
    scanTable(TABLES.ETL_JOBS, "jobId, #n"),
    scanTable(TABLES.ENGINE_JOBS, "jobId, #n"),
    listRecentEvents({ limit: 12 }),
  ]);

  const nameMap: Record<string, string> = {};
  for (const t of syncTasks) nameMap[t.taskId] = t.name;
  for (const w of workflows) nameMap[w.workflowId] = w.name;
  for (const j of etlJobs) nameMap[j.jobId] = j.name;
  for (const j of engineJobs) nameMap[j.jobId] = j.name;

  // 先按区过滤 run,再算所有派生指标(分布 / 今日 / 甘特 / 趋势)
  const runsScoped = opts.scope
    ? (filterRowsByScalar(runsRaw as unknown as Array<Record<string, unknown>>, opts.scope, "run") as unknown as Run[])
    : (runsRaw as Run[]);
  const runs = (runsScoped as Run[]).map((r) => ({
    ...r,
    taskName: nameMap[r.taskId] || r.taskId?.slice(-12) || r.taskId,
    startedAt: r.startedAt || r.finishedAt || "",
    taskType: r.taskType || "workflow",
  }));

  // 任务态分布
  const statusCount: Record<string, number> = {};
  for (const r of runs) statusCount[r.status || "unknown"] = (statusCount[r.status || "unknown"] || 0) + 1;
  const statusDist = Object.entries(statusCount).map(([label, value]) => ({ label, value }));

  // 今日统计
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const todayRuns = runs.filter((r) => (r.startedAt || "") >= todayStart);
  const todaySuccess = todayRuns.filter((r) => r.status === "succeeded").length;
  const todayFailed = todayRuns.filter((r) => r.status === "failed").length;
  const durs = todayRuns.filter((r) => r.duration).map((r) => Number(r.duration));

  // 近 7 日趋势(按天计运行数)
  const trend: { label: string; value: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const dayStart = d.toISOString();
    const dayEnd = new Date(d.getTime() + 86400000).toISOString();
    const cnt = runs.filter((r) => (r.startedAt || "") >= dayStart && (r.startedAt || "") < dayEnd).length;
    trend.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, value: cnt });
  }

  // Top 慢任务(按 duration 降序,取终态 run 前 8)
  const topSlow = runs
    .filter((r) => Number(r.duration) > 0)
    .sort((a, b) => Number(b.duration) - Number(a.duration))
    .slice(0, 8)
    .map((r) => ({ taskName: r.taskName, taskType: r.taskType || "", duration: Number(r.duration), runId: r.runId }));

  // 甘特:最近有起止时间的 run,取最近 20 条(按开始时间)
  const gantt = runs
    .filter((r) => r.startedAt)
    .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))
    .slice(0, 20)
    .map((r) => ({
      taskId: r.taskId,
      taskName: r.taskName,
      taskType: r.taskType || "",
      status: r.status || "unknown",
      startedAt: r.startedAt || "",
      finishedAt: r.finishedAt || "",
      duration: Number(r.duration) || 0,
    }));

  // 准点率:今日终态 run 未超阈值的占比
  const todayTerminal = todayRuns.filter((r) => r.status === "succeeded" || r.status === "failed");
  const punctual = todayTerminal.filter((r) => Number(r.duration || 0) <= DEFAULT_PUNCTUAL_SECONDS).length;
  const punctualityRate = todayTerminal.length > 0 ? Math.round((punctual / todayTerminal.length) * 100) : 100;

  return {
    generatedAt: now.toISOString(),
    stats: {
      running: runs.filter((r) => r.status === "running").length,
      todayTotal: todayRuns.length,
      todaySuccess,
      todayFailed,
      successRate: todayRuns.length > 0 ? Math.round((todaySuccess / todayRuns.length) * 100) : 0,
      avgDuration: durs.length > 0 ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0,
    },
    statusDist,
    trend,
    topSlow,
    gantt,
    // 最近告警也按区(池化评估的事件没有章 ⇒ 归主控区)
    recentAlerts: (opts.scope
      ? (filterRowsByScalar(recentEvents as unknown as Array<Record<string, unknown>>, opts.scope, "alert") as unknown as typeof recentEvents)
      : recentEvents
    ).map((e) => ({ ruleName: e.ruleName, severity: e.severity, message: e.message, ...(e.msgKey ? { msgKey: e.msgKey } : {}), ...(e.msgParams ? { msgParams: e.msgParams } : {}), status: e.status, createdAt: e.createdAt })),
    punctualityRate,
  };
}
