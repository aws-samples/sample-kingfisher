// 运行历史探测 — 只读查 Glue 运行历史 / MSAF 应用配置 / DMS 任务统计,给推荐引擎实据。
// 全部 Get/Describe,零写([[network-advisor-readonly-only]] 同款红线:参数顾问只建议,绝不改资源)。
// 优雅降级:IAM 拒/资源不存在时不崩,degraded=true + missing 记原因,推荐退回纯启发式。

import { homeRegion } from "@/lib/place/home-region";
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { GlueClient, GetJobCommand, GetJobRunsCommand } from "@aws-sdk/client-glue";
import { KinesisAnalyticsV2Client, DescribeApplicationCommand } from "@aws-sdk/client-kinesis-analytics-v2";
import {
  DatabaseMigrationServiceClient,
  DescribeReplicationTasksCommand,
  DescribeReplicationInstancesCommand,
  DescribeTableStatisticsCommand,
} from "@aws-sdk/client-database-migration-service";
import type { DmsTaskStats, FlinkAppStats, GlueRunStats, HistoryFacts, JobRef } from "./types";

const REGION = process.env.PARAM_ADVISOR_REGION || homeRegion();

const glue = sdkClient("data-plane", GlueClient, { region: REGION });
const kda = sdkClient("data-plane", KinesisAnalyticsV2Client, { region: REGION });
const dms = sdkClient("data-plane", DatabaseMigrationServiceClient, { region: REGION });

function nowIso(): string {
  return new Date().toISOString();
}

export async function probeHistory(jobRef?: JobRef): Promise<HistoryFacts> {
  if (!jobRef?.id) {
    return { kind: "none", degraded: false, missing: [], capturedAt: nowIso() };
  }
  const missing: string[] = [];
  const facts: HistoryFacts = { kind: jobRef.kind, degraded: false, missing, capturedAt: nowIso() };

  try {
    if (jobRef.kind === "glue-job") facts.glue = await probeGlue(jobRef.id);
    else if (jobRef.kind === "flink-app") facts.flink = await probeFlink(jobRef.id);
    else if (jobRef.kind === "dms-task") facts.dms = await probeDms(jobRef.id);
  } catch (e) {
    missing.push(`${jobRef.kind} ${jobRef.id}: ${e instanceof Error ? e.message : String(e)}`);
    facts.degraded = true;
  }
  return facts;
}

// ── Glue:作业当前配置 + 近 20 次运行统计(P90 时长/成功率/最近错误)──
async function probeGlue(jobName: string): Promise<GlueRunStats> {
  const stats: GlueRunStats = { runs: 0, successRate: 0, avgDurationMin: null, p90DurationMin: null, maxDurationMin: null, lastErrors: [] };

  const { Job } = await glue.send(new GetJobCommand({ JobName: jobName }));
  stats.currentWorkerType = Job?.WorkerType;
  stats.currentNumberOfWorkers = Job?.NumberOfWorkers;
  stats.currentGlueVersion = Job?.GlueVersion;
  stats.currentTimeoutMin = Job?.Timeout;

  const { JobRuns = [] } = await glue.send(new GetJobRunsCommand({ JobName: jobName, MaxResults: 20 }));
  const done = JobRuns.filter((r) => r.JobRunState && r.JobRunState !== "RUNNING" && r.JobRunState !== "STARTING" && r.JobRunState !== "WAITING");
  stats.runs = done.length;
  if (!done.length) return stats;

  const ok = done.filter((r) => r.JobRunState === "SUCCEEDED");
  stats.successRate = ok.length / done.length;
  // ExecutionTime 为秒;只统计成功运行的时长(失败常提前退出,混入会低估)。
  const durMin = ok.map((r) => (r.ExecutionTime || 0) / 60).filter((m) => m > 0).sort((a, b) => a - b);
  if (durMin.length) {
    stats.avgDurationMin = round1(durMin.reduce((s, m) => s + m, 0) / durMin.length);
    stats.p90DurationMin = round1(durMin[Math.min(durMin.length - 1, Math.floor(durMin.length * 0.9))]);
    stats.maxDurationMin = round1(durMin[durMin.length - 1]);
  }
  stats.lastErrors = done
    .filter((r) => r.JobRunState === "FAILED" || r.JobRunState === "ERROR" || r.JobRunState === "TIMEOUT")
    .slice(0, 3)
    .map((r) => (r.ErrorMessage || r.JobRunState || "").slice(0, 200));
  return stats;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ── Flink/MSAF:应用当前资源配置与状态 ──
async function probeFlink(appName: string): Promise<FlinkAppStats> {
  const { ApplicationDetail: d } = await kda.send(new DescribeApplicationCommand({ ApplicationName: appName }));
  const pc = d?.ApplicationConfigurationDescription?.FlinkApplicationConfigurationDescription?.ParallelismConfigurationDescription;
  return {
    status: d?.ApplicationStatus,
    parallelism: pc?.Parallelism,
    parallelismPerKPU: pc?.ParallelismPerKPU,
    autoScalingEnabled: pc?.AutoScalingEnabled,
    runtimeVersion: d?.RuntimeEnvironment,
  };
}

// ── DMS:任务状态/迁移类型/表统计 + 复制实例规格 ──
async function probeDms(taskId: string): Promise<DmsTaskStats> {
  const stats: DmsTaskStats = {};
  const { ReplicationTasks = [] } = await dms.send(
    new DescribeReplicationTasksCommand({
      Filters: [{ Name: taskId.startsWith("arn:") ? "replication-task-arn" : "replication-task-id", Values: [taskId] }],
    })
  );
  const task = ReplicationTasks[0];
  if (!task) return stats;
  stats.status = task.Status;
  stats.migrationType = task.MigrationType;
  stats.fullLoadProgressPercent = task.ReplicationTaskStats?.FullLoadProgressPercent;

  // 表级统计(装载失败数)与实例规格,各自独立降级(任一失败不影响另一个)。
  try {
    const { TableStatistics = [] } = await dms.send(
      new DescribeTableStatisticsCommand({ ReplicationTaskArn: task.ReplicationTaskArn, MaxRecords: 100 })
    );
    stats.tablesLoaded = TableStatistics.filter((t) => t.TableState === "Table completed").length;
    stats.tablesErrored = TableStatistics.filter((t) => (t.TableState || "").toLowerCase().includes("error")).length;
  } catch { /* 表统计可选 */ }
  try {
    if (task.ReplicationInstanceArn) {
      const { ReplicationInstances = [] } = await dms.send(
        new DescribeReplicationInstancesCommand({
          Filters: [{ Name: "replication-instance-arn", Values: [task.ReplicationInstanceArn] }],
        })
      );
      stats.instanceClass = ReplicationInstances[0]?.ReplicationInstanceClass;
    }
  } catch { /* 实例规格可选 */ }
  return stats;
}
