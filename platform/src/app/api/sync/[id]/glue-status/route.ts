export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { GetJobRunsCommand } from "@aws-sdk/client-glue";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { fireDownstreamOnce } from "@/lib/scheduler/dependency";
import { guardResourceAccess } from "@/lib/projects/guard";
// task-runs 唯一写通道(50 SPEC §6 S10)。
import { updateRunRecord, resolveRunStamp } from "@/lib/monitor/run-records";
// 状态查询按任务章取区(home 客户端查非 home 的 JobRun 必然
// 查不到,而本路由还会**写状态** ⇒ 用错区的「查不到」改状态就是写坏数据;区解析失败即抛,不回落)。
import { bindingTargets, regionOfTarget } from "@/lib/exec-env/data-plane-target";
import { glueClientFor } from "@/lib/exec-env/target-clients";
import { updateSyncTaskIfExists } from "@/lib/sync/task-write";

const USER_ID = "default-user";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const { Item: task } = await docClient.send(new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId: params.id } }));
    if (task) {
      const guard = await guardResourceAccess(req, task, "viewer");
      if (guard instanceof NextResponse) return guard;
    }
    if (!task?.glueJobName) return apiOk(null);

    const tid = bindingTargets(task as { targets?: unknown; targetId?: unknown })[0];
    const glue = await glueClientFor(await regionOfTarget(tid));
    const { JobRuns = [] } = await glue.send(new GetJobRunsCommand({ JobName: task.glueJobName, MaxResults: 1 }));
    if (JobRuns.length === 0) return apiOk(null);

    const run = JobRuns[0];
    const state = run.JobRunState;

    // Auto-update task and run status if Glue finished but DynamoDB not updated yet
    if ((state === "SUCCEEDED" || state === "FAILED" || state === "STOPPED") && task.status === "running") {
      const now = new Date().toISOString();
      const newStatus = state === "SUCCEEDED" ? "succeeded" : "error";

      // Update task status
      // 唯一写通道
      await updateSyncTaskIfExists({
        taskId: params.id,
        UpdateExpression: "SET #s = :s, updatedAt = :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": newStatus, ":now": now },
      });

      // Update latest run record
      let latestRunId: string | undefined;
      try {
        const { Items = [] } = await docClient.send(new QueryCommand({
          TableName: TABLES.TASK_RUNS, KeyConditionExpression: "taskId = :t",
          ExpressionAttributeValues: { ":t": params.id }, ScanIndexForward: false, Limit: 1,
        }));
        if (Items[0] && Items[0].status === "running") {
          latestRunId = Items[0].runId;
          await updateRunRecord({
            taskId: params.id, runId: Items[0].runId,
            set: {
              status: state === "SUCCEEDED" ? "succeeded" : "failed",
              finishedAt: now, duration: run.ExecutionTime || 0, error: run.ErrorMessage || null,
            },
            // 章按真落点显式盖(同步任务区维在 targets[],裸调必盖 home)
            stamp: resolveRunStamp(task, tid),
          });
        }
      } catch {}

      // SCH-03: on success, fan out to any configured downstream tasks/workflows
      // (exactly-once via the run record's downstreamFired flag).
      if (state === "SUCCEEDED" && latestRunId) fireDownstreamOnce(params.id, latestRunId).catch(() => {});
    }

    return apiOk({
      state, startedOn: run.StartedOn?.toISOString(), completedOn: run.CompletedOn?.toISOString(),
      executionTime: run.ExecutionTime, dpuSeconds: run.DPUSeconds,
      errorMessage: run.ErrorMessage, jobRunId: run.Id,
    });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
