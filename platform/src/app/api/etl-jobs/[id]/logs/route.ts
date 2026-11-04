export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
// @kf-batch 50-WP18c-capacity-visibility —— 「云侧没给算力」的判定与文案:单一作者
import { diagnoseRunLogs, isStillRunning } from "@/lib/etl/run-diagnosis";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { GetJobRunCommand } from "@aws-sdk/client-glue";
import { GetLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { DescribeStatementCommand } from "@aws-sdk/client-redshift-data";
// @kf-batch 50-P50.3-engines —— per-target 客户端(Glue / CloudWatch Logs / Redshift Data)
import { resolveGlueBinding, redshiftClientForTarget, stampedTargetOf } from "@/lib/exec-env/data-plane-target";
import { glueClientFor, logsClientFor } from "@/lib/exec-env/target-clients";
// @kf-batch 50-WP15-airflow-serverless(施工序 6):serverless 调度 run 的任务日志在 CloudWatch(按台账 scheduler 分路)
import { readServerlessTaskLogs } from "@/lib/scheduler/serverless/task-logs";

// @kf-batch 50-P50.3-engines
// 🔴 **模块级 home 客户端已删**(原来 `glue` / `cwl` / `rsData` 三个)。
// 这条路径就是用户 2026-09-04 当场撞到的那个 bug 的现场:非 home 的 run 用 home 客户端去查,
// Redshift 侧报「Query does not exist.」、Glue 侧报 EntityNotFound、CloudWatch 侧取到**空日志**
// (最坏的一种:界面上"空日志"与"作业没输出"长得一模一样)。
// ⇒ 三个客户端全部按**这条 run 的执行区**建。
const USER_ID = "default-user";

// 取一个 CloudWatch 日志流的事件（best-effort）。
async function fetchLogStream(cwl: { send: (c: unknown) => Promise<any> }, logGroupName: string, logStreamName: string, limit = 300): Promise<string[]> {
  try {
    const out = await cwl.send(
      new GetLogEventsCommand({ logGroupName, logStreamName, limit, startFromHead: true })
    );
    return (out.events || []).map((e: { message?: string }) => e.message || "").filter(Boolean);
  } catch {
    // 流不存在（作业刚启动还没产出日志）等情况，返回提示而非报错。
    return [];
  }
}

// GET /api/etl-jobs/[id]/logs?runId=<runId>
// Glue: CloudWatch /aws-glue/jobs/{error,output} (logStream=JobRunId) + GetJobRun.ErrorMessage。
// Redshift: Data API DescribeStatement（含子语句错误）。RBAC: viewer。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item: job } = await docClient.send(
    new GetCommand({ TableName: TABLES.ETL_JOBS, Key: { userId: USER_ID, jobId: params.id } })
  );
  if (!job) return apiError("作业不存在", 404);
  const guard = await guardResourceAccess(req, job, "viewer");
  if (guard instanceof NextResponse) return guard;

  const runId = req.nextUrl.searchParams.get("runId") || job.lastRunId;
  if (!runId) return apiOk({ logs: ["（暂无运行记录）"], status: job.lastRunStatus || "unknown" });

  const { Item: run } = await docClient.send(
    new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId: params.id, runId } })
  );
  if (!run) return apiOk({ logs: ["（找不到该运行记录）"], status: "unknown" });

  // ---- Glue ----
  // @kf-batch 50-WP15-airflow-serverless —— serverless 调度跑出的 run:日志在 /aws/mwaa-serverless/<workflow>/(INTERACTION §2.2b)
  if (run.scheduler === "serverless") {
    const tid = String(run.targetId ?? "tgt_home");
    const arn = ((job.deployments ?? {}) as Record<string, { workflowArn?: string } | undefined>)[tid]?.workflowArn;
    if (!arn) {
      return apiOk({ status: run.status, error: run.error || null, scheduler: "serverless", logs: [`(该 target ${tid} 的 serverless workflow 已下线,台账里没有 workflowArn;历史日志可到 CloudWatch 按 workflow 名查看)`] });
    }
    const r = await readServerlessTaskLogs({ workflowArn: arn, ledger: { runId, startedAt: run.startedAt, finishedAt: run.finishedAt } });
    return apiOk({ status: run.status, error: run.error || null, scheduler: "serverless", logGroup: r.logGroup, logStream: r.logStream, workflowRunId: r.workflowRunId, runType: r.runType, taskStatus: r.taskStatus, logs: r.logs });
  }

  if (run.glueJobRunId && run.glueJobName) {
    const lines: string[] = [];
    let status = run.status;
    let errorMessage = run.error;
    // 🔴 按**这条 run 的执行区**解析客户端;解析不到就**如实说**(不假装"暂无日志")。
    let glueC: { send: (c: unknown) => Promise<any> } | null = null;
    let cwlC: { send: (c: unknown) => Promise<any> } | null = null;
    let execRegion = "";
    try {
      const b = await resolveGlueBinding({ targetId: stampedTargetOf(run) });
      execRegion = b.region;
      glueC = (await glueClientFor(b.region)) as any;
      cwlC = (await logsClientFor(b.region)) as any;
    } catch (e) {
      return apiError(
        `取不到这条运行的执行区域(targetId=${(run as { targetId?: string }).targetId || "(空)"}):` +
          `${(e as Error)?.message}。🔴 刻意不回落 home 去查 —— 那会取到一份**别的区域的空日志**,` +
          `而界面上"空日志"与"作业没输出"看起来一模一样`,
        409,
        { code: "CONFLICT" }
      );
    }
    try {
      const { JobRun } = await glueC!.send(new GetJobRunCommand({ JobName: run.glueJobName, RunId: run.glueJobRunId }));
      status = (JobRun?.JobRunState || run.status || "").toLowerCase();
      errorMessage = JobRun?.ErrorMessage || run.error;
    } catch { /* best-effort */ }

    if (errorMessage) lines.push(`[Glue 错误摘要] ${errorMessage}`, "");

    const errLog = await fetchLogStream(cwlC!, "/aws-glue/jobs/error", run.glueJobRunId, 400);
    if (errLog.length) {
      lines.push("===== 错误日志 /aws-glue/jobs/error =====");
      lines.push(...errLog);
      lines.push("");
    }
    const outLog = await fetchLogStream(cwlC!, "/aws-glue/jobs/output", run.glueJobRunId, 400);
    if (outLog.length) {
      lines.push("===== 输出日志 /aws-glue/jobs/output（含 print/show） =====");
      lines.push(...outLog);
    }
    if (!lines.length) {
      lines.push(
        "（暂无日志。Glue 作业冷启动约 1-2 分钟，日志产出有延迟；或作业刚提交。可稍后刷新。）",
        `JobRunId: ${run.glueJobRunId} · 执行区域: ${execRegion}`
      );
    }
    // @kf-batch 50-WP18c-capacity-visibility
    // 🔴 「云侧还没给算力」必须**说出来**:2026-09-16 实测 us-east-1 的 Glue 连着两次只分到 driver、
    //   十几分钟拿不到 executor(Spark 反复报 task starvation),而用户在页面上只看到一个「运行中」、
    //   日志弹窗里一个字都没解释 ⇒ 「排队等资源 / 脚本挂住了 / 平台坏了」三件事分不开,
    //   而它们的下一步完全不同(等 / 改代码 / 报障)。判定走单一作者,结论放在**第一行**
    //   (两个页面的日志弹窗都直接渲染 `logs`,不用各改一遍界面),同时把结构化结论一并回给前端备用。
    const diag = diagnoseRunLogs(errLog.length ? errLog : lines, isStillRunning(status));
    if (diag.kind !== "none") lines.unshift(diag.advice, "");
    return apiOk({
      engine: "glue",
      status,
      error: errorMessage || null,
      glueJobRunId: run.glueJobRunId,
      ...(diag.kind !== "none" ? { diagnosis: diag } : {}),
      logs: lines,
    });
  }

  // ---- Redshift ----
  if (run.statementId) {
    const lines: string[] = [];
    try {
      // @kf-batch 50-P50.3-mrquery
      // 🔴 用**这条 run 实际执行的那个 region** 的客户端:statementId 是 region 内的,
      // 拿 home 的客户端去查 us-west-2 的语句只会得到 `Query does not exist.`
      // (2026-09-04 用户实测就是这么撞上的)。region 取 run 记录上的章。
      const rsForRun = await redshiftClientForTarget(stampedTargetOf(run));
      const desc = await rsForRun.send(new DescribeStatementCommand({ Id: run.statementId }));
      lines.push(`状态: ${desc.Status}`, `语句数: ${desc.SubStatements?.length || 1}`, "");
      if (desc.Error) lines.push(`[错误] ${desc.Error}`, "");
      for (const s of desc.SubStatements || []) {
        lines.push(`— 语句: ${(s.QueryString || "").replace(/\s+/g, " ").slice(0, 200)}`);
        lines.push(`  状态: ${s.Status}${s.Error ? ` | 错误: ${s.Error}` : ""}${s.ResultRows != null ? ` | 影响行数: ${s.ResultRows}` : ""}`);
      }
      return apiOk({ engine: "redshift", status: (desc.Status || "").toLowerCase(), error: desc.Error || null, logs: lines });
    } catch (e: any) {
      // 错误信息里带上**该 run 的执行区域**:多区域排障第一个问题永远是「我到底打到哪了」
      const tid = String((run as { targetId?: unknown }).targetId ?? "无章(存量,主控区)");
      return apiOk({
        engine: "redshift", status: run.status, error: run.error || e.message,
        logs: [`无法获取语句详情(执行区域 ${tid}): ${e.message}`],
      });
    }
  }

  return apiOk({ status: run.status, error: run.error || null, logs: ["（该运行无可用日志引用）"] });
}
