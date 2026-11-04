export const dynamic = "force-dynamic";

// GET /api/engines/[engine]/[id]/logs?runId=<runId> —— SPI 分派 readLogs。
// EMR：读 S3 monitoring 日志（SPARK_DRIVER stdout/stderr）。

import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { isEngineType, getProvider } from "@/lib/engines/registry";
// serverless 调度 run 的任务日志在 CloudWatch(按台账 scheduler 分路)
import { readServerlessTaskLogs } from "@/lib/scheduler/serverless/task-logs";
// 「云侧没给算力」判定:与 ETL 侧同一个单一作者
import { diagnoseRunLogs, isStillRunning } from "@/lib/etl/run-diagnosis";

const USER_ID = "default-user";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ engine: string; id: string }> }
) {
  const params = await props.params;
  if (!isEngineType(params.engine)) return apiError("未知引擎", 400, { code: "VALIDATION_FAILED" });
  const { Item: job } = await docClient.send(
    new GetCommand({ TableName: TABLES.ENGINE_JOBS, Key: { userId: USER_ID, jobId: params.id } })
  );
  if (!job) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const guard = await guardResourceAccess(req, job, "viewer");
  if (guard instanceof NextResponse) return guard;

  const runId = req.nextUrl.searchParams.get("runId") || (job as any).lastRunId;
  if (!runId) return apiOk({ logs: ["（暂无运行记录）"], status: (job as any).lastRunStatus || "unknown" });

  const { Item: run } = await docClient.send(
    new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId: params.id, runId } })
  );
  if (!run) return apiOk({ logs: ["（找不到该运行记录）"], status: "unknown" });
  // serverless 调度跑出的 run 无 nativeRunId(runtime 只写台账),日志走 CloudWatch 任务日志
  if (run.scheduler === "serverless") {
    const tid = String(run.targetId ?? "tgt_home");
    const arn = (((job as { deployments?: Record<string, { workflowArn?: string } | undefined> }).deployments ?? {})[tid])?.workflowArn;
    if (!arn) {
      return apiOk({ engine: params.engine, status: run.status, error: run.error || null, scheduler: "serverless", logs: [`(该 target ${tid} 的 serverless workflow 已下线,台账里没有 workflowArn;历史日志可到 CloudWatch 按 workflow 名查看)`] });
    }
    const r = await readServerlessTaskLogs({ workflowArn: arn, ledger: { runId, startedAt: run.startedAt, finishedAt: run.finishedAt } });
    return apiOk({ engine: params.engine, status: run.status, error: run.error || null, scheduler: "serverless", logGroup: r.logGroup, logStream: r.logStream, workflowRunId: r.workflowRunId, runType: r.runType, taskStatus: r.taskStatus, logs: r.logs });
  }
  if (!run.nativeRunId) return apiOk({ status: run.status, error: run.error || null, logs: ["（该运行无可用日志引用）"] });

  try {
    const lines = await getProvider(params.engine).readLogs(job as any, runId, String(run.nativeRunId));
    const text = lines.map((l) => (l.level ? `[${l.level}] ${l.msg}` : l.msg));
    // 与 ETL 那条同一个作者:Spark 拿不到 executor 时
    // 要在**日志第一行**说清「云侧在排队,不是作业错也不是平台坏」+ 出路(EMR Serverless 同样跑 Spark)。
    const diag = diagnoseRunLogs(text, isStillRunning(run.status));
    if (diag.kind !== "none") text.unshift(diag.advice, "");
    return apiOk({
      engine: params.engine,
      status: run.status,
      error: run.error || null,
      nativeRunId: run.nativeRunId,
      ...(diag.kind !== "none" ? { diagnosis: diag } : {}),
      logs: text,
    });
  } catch (e: any) {
    return apiOk({ engine: params.engine, status: run.status, error: run.error || e.message, logs: [`无法获取日志: ${e.message}`] });
  }
}
