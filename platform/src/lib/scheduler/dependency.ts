// @kf-batch 50-WP13-mwaa-region —— MWAA 环境 / 桶只经解析器(home 逐字节不变)
// @kf-batch 50-WP17-serverless-workflow
// 🔴🔴 **本文件原来整条链都恒打主控区**(第 6 处同族缺陷,2026-09-11 抓到):
//   · 下游工作流:模块级 `homeMwaaEndpoint().envName` + `new MWAAClient(AWS_REGION)` ⇒ 对绑在别区的
//     下游执行 `dags trigger`,主控区**根本没有那个 DAG** ⇒ Airflow CLI 静默失败,而平台照样写了一行
//     `running` 并把工作流标成 running ⇒ **台账显示在跑、其实一次都没跑**;主控区若恰有同名 DAG,
//     还会**触发错的那一个**(= 用户明令禁止的跨区域调度);serverless 下游则完全没有分路。
//   · 下游同步:模块级 `new GlueClient(AWS_REGION)` ⇒ 别区的 Glue 作业 `EntityNotFound`,
//     被外层 try 吞成一行 console.error ⇒ 依赖链**静默断掉**。
//   根治 = 两条都按**下游自己的落点**解析(与触发路由同一套解析器),serverless 走 StartWorkflowRun。
import { schedulerEndpointFor, isServerlessEndpoint, mwaaCli } from "@/lib/scheduler/mwaa-endpoint";
import { bindingTargets, resolveGlueBinding } from "@/lib/exec-env/data-plane-target";
import { glueClientFor } from "@/lib/exec-env/target-clients";
import { serverlessWorkflowArnOf } from "@/lib/workflow/publish-dag";
import { startWorkflowRun } from "@/lib/scheduler/serverless/workflow-client";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { StartJobRunCommand } from "@aws-sdk/client-glue";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { ulid } from "ulid";
// @kf-batch 52-P52.2-W2a-run-stamp — task-runs 唯一写通道(50 SPEC §6 S10)。
import { putRunRecord, updateRunRecord, resolveRunStamp } from "@/lib/monitor/run-records";
// 序 61 B-133 —— 扇出前核对下游源的外部网络对象(与同步启动核心同一作者)
import { reconcileDatasourceNetwork } from "@/lib/datasource/network-reconcile";
import type { DataSource } from "@/types/datasource";

// SCH-03 — dependency scheduling.
//
// An upstream sync task / workflow declares a `triggers: string[]` array of downstream
// IDs. When the upstream run succeeds (detected in the sync poll / glue-status backfill /
// workflow status backfill), we fan out and start each downstream. Best-effort: never
// throws into the caller's success path.

const USER_ID = "default-user";

// Start a downstream sync task by launching its (already-provisioned) Glue job and
// recording a run. A downstream that has never been run from the platform has no Glue job
// yet — we skip it (and log) rather than provision one here.
async function startDownstreamSync(task: any, upstreamId: string): Promise<void> {
  if (!task.glueJobName) {
    console.warn(`[SCH-03] downstream sync ${task.taskId} has no Glue job yet; skipping (run it once from the platform first)`);
    return;
  }
  // 序 61 B-133 —— 扇出前核对下游源的外部网络对象:平台组 / 连接被平台外删除 ⇒ 按源行重建接回再起作业;
  //   用户自带对象 / 密钥缺失 ⇒ 不发 StartJobRun,落一条 failed 运行行(与启动路径同一句中文),用户在运行历史里看得到。
  if (typeof task.datasourceId === "string" && task.datasourceId) {
    const { Item: dsRow } = await docClient.send(
      new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: task.datasourceId } })
    );
    if (dsRow) {
      const net = await reconcileDatasourceNetwork(dsRow as DataSource, { via: "scheduler.dependency" });
      if (net.kind === "broken") {
        const at = new Date().toISOString();
        await putRunRecord({
          taskId: task.taskId, runId: ulid(), taskType: "sync", startedAt: at, status: "failed",
          triggeredBy: "dependency", stamp: resolveRunStamp(task),
          extra: { upstreamId, finishedAt: at, duration: 0, error: net.message, errorKind: "datasource-network-broken", metrics: { rowsRead: 0, rowsWritten: 0 } },
        });
        console.warn(`[SCH-03] downstream sync ${task.taskId} not started (network object missing): ${net.message}`);
        return;
      }
    }
  }
  // 🔴 Glue 客户端按**下游同步任务自己的落点**建(原来是模块级主控区客户端 ⇒ 别区作业 EntityNotFound 被吞掉)
  const binding = await resolveGlueBinding({ targetId: bindingTargets(task)[0] });
  const glue = await glueClientFor(binding.region);
  const { JobRunId } = await glue.send(new StartJobRunCommand({ JobName: task.glueJobName }));
  const runId = ulid();
  const now = new Date().toISOString();
  // @kf-batch 52-P52.2-W2a-run-stamp
  // 归属取**下游任务行**(不是上游):这条 run 是下游任务的 run,归下游所在项目。
  await putRunRecord({
    taskId: task.taskId, runId, taskType: "sync", startedAt: now,
    triggeredBy: "dependency", stamp: resolveRunStamp(task),
    extra: { upstreamId, glueJobName: task.glueJobName, glueJobRunId: JobRunId, metrics: { rowsRead: 0, rowsWritten: 0 } },
  });
  await docClient.send(new UpdateCommand({
    TableName: TABLES.SYNC_TASKS,
    Key: { userId: USER_ID, taskId: task.taskId },
    UpdateExpression: "SET #s = :s, lastRunId = :r, updatedAt = :now",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":s": "running", ":r": runId, ":now": now },
  }));
  console.log(`[SCH-03] started downstream sync ${task.taskId} (run ${runId}) from upstream ${upstreamId}`);
}

// Trigger a downstream workflow by triggering its Airflow DAG and recording a run.
async function triggerDownstreamWorkflow(wf: any, upstreamId: string): Promise<void> {
  if (!wf.airflowDagId) {
    console.warn(`[SCH-03] downstream workflow ${wf.workflowId} not published; skipping`);
    return;
  }
  const now = new Date().toISOString();
  const target = bindingTargets(wf)[0];
  const ep = await schedulerEndpointFor(target);
  if (isServerlessEndpoint(ep)) {
    // 🔴 serverless:StartWorkflowRun;**不预写台账行** —— 键是 `<服务侧 per-run dag_id>#<targetId>`,
    //   平台事先算不出来,预写就是第二行(与手动触发那条路同一条纪律)。
    const arn = await serverlessWorkflowArnOf(wf, ep);
    if (!arn) {
      console.warn(`[SCH-03] downstream workflow ${wf.workflowId} 在 ${ep.region} 找不到 serverless 产物;skip`);
      return;
    }
    const r = await startWorkflowRun(ep.region, arn);
    console.log(`[SCH-03] triggered downstream serverless workflow ${wf.workflowId}(serviceRunId=${r.RunId})from upstream ${upstreamId}`);
  } else {
    const runId = ulid();
    const res = await mwaaCli(ep, `dags trigger ${wf.airflowDagId} -r ${runId}`);
    if (!res.ok) throw new Error(res.stderr || res.stdout || "dags trigger 失败");
    // @kf-batch 52-P52.2-W2a-run-stamp — 归属取下游工作流行。
    await putRunRecord({
      taskId: wf.workflowId, runId, taskType: "workflow", startedAt: now,
      triggeredBy: "dependency", stamp: resolveRunStamp(wf, target),
      extra: { upstreamId, airflowDagId: wf.airflowDagId, airflowRunId: runId, result: String(res.stdout || "").slice(0, 500) },
    });
  }
  await docClient.send(new UpdateCommand({
    TableName: TABLES.WORKFLOWS,
    Key: { userId: USER_ID, workflowId: wf.workflowId },
    UpdateExpression: "SET #s = :s, lastRunAt = :now, lastRunStatus = :rs, updatedAt = :now",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":s": "active", ":now": now, ":rs": "running" },
  }));
  console.log(`[SCH-03] downstream workflow ${wf.workflowId} 已按落点 ${target} 触发(upstream ${upstreamId})`);
}

// Read the upstream entity's `triggers` (it may be a sync task or a workflow).
async function readTriggers(upstreamId: string): Promise<string[]> {
  const { Item: sync } = await docClient.send(
    new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId: upstreamId } })
  );
  if (sync?.triggers?.length) return sync.triggers;
  const { Item: wf } = await docClient.send(
    new GetCommand({ TableName: TABLES.WORKFLOWS, Key: { userId: USER_ID, workflowId: upstreamId } })
  );
  if (wf?.triggers?.length) return wf.triggers;
  return [];
}

// Fire all downstream tasks configured on the upstream. Idempotency is the caller's
// responsibility — invoke once per terminal "succeeded" transition. Best-effort.
export async function triggerDownstream(upstreamId: string): Promise<void> {
  try {
    const downstreamIds = await readTriggers(upstreamId);
    if (!downstreamIds.length) return;
    for (const id of downstreamIds) {
      try {
        // Resolve each downstream as a sync task first, then a workflow.
        const { Item: sync } = await docClient.send(
          new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId: id } })
        );
        if (sync) { await startDownstreamSync(sync, upstreamId); continue; }
        const { Item: wf } = await docClient.send(
          new GetCommand({ TableName: TABLES.WORKFLOWS, Key: { userId: USER_ID, workflowId: id } })
        );
        if (wf) { await triggerDownstreamWorkflow(wf, upstreamId); continue; }
        console.warn(`[SCH-03] downstream ${id} not found (neither sync task nor workflow)`);
      } catch (e: any) {
        console.error(`[SCH-03] failed to trigger downstream ${id}: ${e.message}`);
      }
    }
  } catch (e: any) {
    console.error(`[SCH-03] triggerDownstream(${upstreamId}) failed: ${e.message}`);
  }
}

// Exactly-once wrapper: marks the run record's `downstreamFired` flag with a conditional
// write and only fans out if THIS caller won the race. This makes downstream triggering
// safe to call from every completion path (sync poll, glue-status backfill, workflow
// status backfill, and the DAG's own on_success write) without double-starting anything.
export async function fireDownstreamOnce(upstreamId: string, runId: string): Promise<void> {
  // @kf-batch 52-P52.2-W2a-run-stamp
  // 🔴 顺带修一个幽灵行洞:原条件只有 `attribute_not_exists(downstreamFired)`,而它对
  // **根本不存在的行恒真** ⇒ upstreamId/runId 打错时 DDB 会 upsert 出一条只有
  // `{taskId, runId, downstreamFired:true}` 的 run(监控页会看到一条无名无状态的运行)。
  // 唯一写通道无条件叠加 `attribute_exists(taskId)`,该洞在结构上关闭;
  // 条件不满足(已 fire 过 **或** 行不存在)一律回 false ⇒ 不扇出,与原语义一致。
  const won = await updateRunRecord({
    taskId: upstreamId,
    runId,
    set: { downstreamFired: true },
    extraCondition: "attribute_not_exists(downstreamFired)",
  }).catch(() => false); // 瞬时错误:与原实现一样,不扇出
  if (!won) return;
  await triggerDownstream(upstreamId);
}

