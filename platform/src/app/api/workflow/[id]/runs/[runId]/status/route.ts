export const dynamic = "force-dynamic";
// @kf-batch 50-WP13-mwaa-region —— MWAA 环境 / 桶只经解析器(home 逐字节不变)
import { schedulerEndpointFor, isServerlessEndpoint, mwaaClientFor, MwaaNotInstalled, mwaaErrorResponse } from "@/lib/scheduler/mwaa-endpoint";
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
// @kf-batch 50-WP17-serverless-workflow —— serverless 的 reconcile-on-read(判据 slsw SW-12)
import { readServerlessRunState } from "@/lib/scheduler/serverless/task-logs";
import { serverlessWorkflowArnOf } from "@/lib/workflow/publish-dag";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { CreateCliTokenCommand } from "@aws-sdk/client-mwaa";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { fireDownstreamOnce } from "@/lib/scheduler/dependency";
import { guardResourceAccess } from "@/lib/projects/guard";
// @kf-batch 52-P52.2-W2a-run-stamp — task-runs 唯一写通道(50 SPEC §6 S10)。
import { updateRunRecord, resolveRunStamp } from "@/lib/monitor/run-records";

// WF-07 — backfill a workflow run's status/duration from Airflow.
//
// The trigger route records the run as status="running" but never updates it (workflow
// runs go through MWAA/Airflow, unlike sync runs which Glue polls in sync/[id]/glue-status).
// This route closes that gap: it reads the run from the shared bgp-task-runs table, asks
// Airflow for the DAG run's terminal state via the MWAA CLI, and writes back
// status/finishedAt/duration when the run has finished. It is idempotent and safe to call
// repeatedly (the frontend polls it for any still-"running" rows in the 运行历史 tab).

const USER_ID = "default-user";
// @kf-batch 50-WP17-serverless-workflow
// 🔴 这里原来是**模块级**的 `new MWAAClient({ region: AWS_REGION })` + `homeMwaaEndpoint().envName`
//    ⇒ 回填一个**别区**工作流的运行状态时,问的是主控区的 Airflow:那儿没有这个 DAG ⇒ `list-runs` 空 ⇒
//    走到下面的「孤儿宽限期」分支,把一次**跑得好好的** run 在 3 分钟后标成 failed(看板假红,还会误触发下游)。
//    改成按这个工作流的落点解析(经典走该区 Airflow CLI;serverless 走服务 API)。

// Map an Airflow dag-run state to our task-run status vocabulary.
function mapState(s: string): "succeeded" | "failed" | "running" {
  const v = (s || "").toLowerCase();
  if (v === "success") return "succeeded";
  if (v === "failed") return "failed";
  return "running"; // queued / running / scheduled / up_for_retry ...
}

// Run a single MWAA CLI command on **该工作流那个区**的环境(端点解析 + 客户端按区都在 mwaa-endpoint 里)。
async function mwaaCliFor(ep: { region: string; envName: string }, command: string): Promise<string> {
  const { CliToken, WebServerHostname } = await mwaaClientFor(ep.region).send(new CreateCliTokenCommand({ Name: ep.envName }));
  const res = await fetch(`https://${WebServerHostname}/aws_mwaa/cli`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CliToken}`, "Content-Type": "text/plain" },
    body: command,
  });
  const body = await res.json();
  return Buffer.from(body.stdout || "", "base64").toString();
}

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string; runId: string }> }
) {
  const params = await props.params;
  try {
    const { Item: wf } = await docClient.send(
      new GetCommand({ TableName: TABLES.WORKFLOWS, Key: { userId: USER_ID, workflowId: params.id } })
    );
    if (wf) {
      const guard = await guardResourceAccess(req, wf, "viewer");
      if (guard instanceof NextResponse) return guard;
    }
    // bgp-task-runs is shared by sync + workflow (pk taskId, sk runId).
    const { Item: run } = await docClient.send(
      new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId: params.id, runId: params.runId } })
    );
    if (!run) return apiError("运行记录不存在", 404);

    // Already terminal — nothing to backfill. (Still attempt the guarded downstream fire:
    // the DAG's own on_success callback may have marked it succeeded before we polled.)
    if (run.status === "succeeded" || run.status === "failed") {
      if (run.status === "succeeded") fireDownstreamOnce(params.id, params.runId).catch(() => {});
      return apiOk({ status: run.status, finishedAt: run.finishedAt, duration: run.duration, backfilled: false });
    }

    const dagId = run.airflowDagId;
    if (!dagId) return apiOk({ status: run.status, backfilled: false });

    // 🔴 落点解析:状态回填必须问**这个工作流自己那个区**的调度器。
    let ep;
    try {
      ep = await schedulerEndpointFor(bindingTargets((wf ?? {}) as { targets?: unknown; targetId?: unknown })[0] || "tgt_home");
    } catch (e) {
      if (e instanceof MwaaNotInstalled) return mwaaErrorResponse(e);
      throw e;
    }

    // ── serverless:reconcile-on-read(SW-12)────────────────────────────────
    // 🔴 台账行只说「这次 run 开始了」:节点 task 被服务硬杀(60 min 上限 / 基础设施)时**没有任何代码在跑**,
    //    行会停在 running。状态的真值在**服务侧**(与 T-13 同一条纪律),所以这里以服务侧为准回填。
    //    刻意不做定时补偿器:那是另一套要部署、要监控、还会自己坏的东西。
    if (isServerlessEndpoint(ep)) {
      const workflowArn = await serverlessWorkflowArnOf(
        { workflowId: params.id, airflowDagId: String(dagId), deployments: (wf as { deployments?: unknown })?.deployments },
        ep
      );
      if (!workflowArn) return apiOk({ status: run.status, backfilled: false, reason: "SCHEDULER_ARTIFACT_MISSING" });
      let sls;
      try {
        sls = await readServerlessRunState({
          workflowArn,
          ledger: { runId: String(params.runId), startedAt: run.startedAt as string, finishedAt: run.finishedAt as string },
        });
      } catch {
        return apiOk({ status: run.status, backfilled: false });   // 服务侧抖动:下一次轮询再来
      }
      const st = String(sls.state ?? "").toUpperCase();
      // 服务侧词表 → 台账词表(只认终态;STARTING/QUEUED/RUNNING/STOPPING 都还没完)
      const mapped = st === "SUCCESS" ? "succeeded" : (st === "FAILED" || st === "STOPPED" || st === "ERROR") ? "failed" : "";
      if (!mapped) return apiOk({ status: run.status, backfilled: false, serviceState: sls.state ?? null, matchedBy: sls.how });
      const startMs = Date.parse(sls.startedAt || (run.startedAt as string) || "");
      const endMs = Date.parse(sls.endedAt || new Date().toISOString());
      const duration = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? Math.round((endMs - startMs) / 1000) : (run.duration as number) || 0;
      const finishedAt = Number.isFinite(endMs) ? new Date(endMs).toISOString() : new Date().toISOString();
      await updateRunRecord({
        taskId: params.id, runId: params.runId,
        set: { status: mapped, finishedAt, duration },
        stamp: resolveRunStamp(wf, ep.targetId),
      });
      if (mapped === "succeeded") fireDownstreamOnce(params.id, params.runId).catch(() => {});
      return apiOk({ status: mapped, finishedAt, duration, backfilled: true, scheduler: "serverless", serviceState: sls.state, matchedBy: sls.how, runType: sls.runType });
    }

    // Ask Airflow for this DAG's runs and locate ours by run_id (set via `dags trigger -r`).
    let airflowRuns: any[] = [];
    try {
      const out = await mwaaCliFor(ep, `dags list-runs -d ${dagId} -o json`);
      airflowRuns = JSON.parse(out || "[]");
    } catch {
      // MWAA hiccup / parse error — leave as running, the next poll will retry.
      return apiOk({ status: run.status, backfilled: false });
    }

    const wanted = run.airflowRunId || params.runId;
    const match = airflowRuns.find((r: any) => (r.run_id || r.dag_run_id || r.runId) === wanted);
    if (!match) {
      // The platform records a run as "running" at trigger time using its own runId, then
      // relies on Airflow (`dags trigger -r <runId>`) to carry that id. A successful trigger
      // makes the DAG run appear in list-runs within seconds — even while queued/running it
      // matches above and settles normally. If, after a grace period, NO Airflow run carries
      // our runId, the trigger never produced a DAG run (the trigger call failed or timed out
      // after the row was written). Such a row would otherwise stay "running" forever and keep
      // the UI polling. Settle it to a terminal "failed" so it reflects reality and stops.
      const startedMs = Date.parse(run.startedAt || "");
      const ageMs = Number.isFinite(startedMs) ? Date.now() - startedMs : Number.POSITIVE_INFINITY;
      const ORPHAN_GRACE_MS = 3 * 60 * 1000;
      if (ageMs > ORPHAN_GRACE_MS) {
        const now = new Date().toISOString();
        // @kf-batch 52-P52.2-W2a-run-stamp
        await updateRunRecord({
          taskId: params.id, runId: params.runId,
          set: {
            status: "failed", finishedAt: now,
            error: "触发未在 Airflow 生成运行（触发可能失败或超时），已自动标记为失败",
          },
          stamp: resolveRunStamp(wf),
        });
        return apiOk({ status: "failed", finishedAt: now, backfilled: true, orphaned: true });
      }
      return apiOk({ status: run.status, backfilled: false });
    }

    const status = mapState(match.state);
    if (status === "running") return apiOk({ status, backfilled: false });

    // Terminal: compute duration from Airflow's start/end (fall back to our startedAt → now).
    const startMs = Date.parse(match.start_date || run.startedAt || "");
    const endRaw = match.end_date || new Date().toISOString();
    const endMs = Date.parse(endRaw);
    const duration =
      Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
        ? Math.round((endMs - startMs) / 1000)
        : run.duration || 0;
    const finishedAt = Number.isFinite(endMs) ? new Date(endMs).toISOString() : new Date().toISOString();

    // @kf-batch 52-P52.2-W2a-run-stamp
    await updateRunRecord({
      taskId: params.id, runId: params.runId,
      set: { status, finishedAt, duration },
      stamp: resolveRunStamp(wf),
    });

    // Reflect the outcome on the workflow's last-run summary (best-effort).
    await docClient
      .send(
        new UpdateCommand({
          TableName: TABLES.WORKFLOWS,
          Key: { userId: USER_ID, workflowId: params.id },
          UpdateExpression: "SET lastRunStatus = :rs, lastRunAt = :f, updatedAt = :now",
          ExpressionAttributeValues: { ":rs": status, ":f": finishedAt, ":now": new Date().toISOString() },
        })
      )
      .catch(() => {});

    // SCH-03: on success, fan out to any configured downstream tasks/workflows (this
    // route returns early when already terminal, so this fires once per run).
    if (status === "succeeded") fireDownstreamOnce(params.id, params.runId).catch(() => {});

    return apiOk({ status, finishedAt, duration, backfilled: true });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
