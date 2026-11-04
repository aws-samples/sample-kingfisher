export const dynamic = "force-dynamic";
// MWAA 环境 / 桶只经解析器(home 逐字节不变)
// 🔴 任务日志要去**这个工作流自己那个区**的 Airflow 取。
// 打主控区环境取一个别区的 DAG 日志,回的是 404 ⇒ 界面显示「暂无日志」,与「任务没输出」长得一样。
import { schedulerEndpointFor, isServerlessEndpoint } from "@/lib/scheduler/mwaa-endpoint";
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
import { mwaaClientFor } from "@/lib/scheduler/mwaa-endpoint";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { MWAAClient, InvokeRestApiCommand } from "@aws-sdk/client-mwaa";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { readServerlessTaskLogs } from "@/lib/scheduler/serverless/task-logs";
import { serverlessWorkflowArnOf } from "@/lib/workflow/publish-dag";

const USER_ID = "default-user";

// WF-04 — fetch a single task node's logs for a workflow run.
//
// MWAA's CLI has no `tasks logs` command, so we call the Airflow REST API through the
// MWAA `InvokeRestApi` action (clean, no web-login/session cookie dance). The platform
// task role already grants `airflow:*`, so no extra IAM is required. Endpoint:
//   GET /dags/{dag}/dagRuns/{run}/taskInstances/{task}/logs/{try}?full_content=true



export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string; runId: string; task: string }> }
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
    const { Item: run } = await docClient.send(
      new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId: params.id, runId: params.runId } })
    );
    if (!run) return apiError("运行记录不存在", 404);
    const dagId = run.airflowDagId;
    if (!dagId) return apiError("该运行无关联 DAG", 400);
    const airflowRunId = run.airflowRunId || params.runId;
    const tryNumber = Number(req.nextUrl.searchParams.get("try") || 1) || 1;
    const taskId = decodeURIComponent(params.task);

    let content = "";
    try {
      const ep = await schedulerEndpointFor(bindingTargets(wf as { targets?: unknown; targetId?: unknown })[0] || "tgt_home");
      // serverless 侧的任务日志走服务 API + CloudWatch:
      //   台账行 → 服务侧 run(**精确**对:任务实例 id 前缀 = 台账 runId 的 raw 段)→ 该节点的
      //   任务实例(按 `_<task_id>_<attempt>` 尾缀,取最大 attempt)→ LogStream → 日志组。
      if (isServerlessEndpoint(ep)) {
        const workflowArn = await serverlessWorkflowArnOf(
          { workflowId: params.id, airflowDagId: String(dagId), deployments: (wf as { deployments?: unknown })?.deployments },
          ep
        );
        if (!workflowArn) {
          return apiError(`${ep.region} 上找不到这个工作流的 serverless workflow(名字 ${dagId})—— 请重新发布一次`, 409, { code: "SCHEDULER_ARTIFACT_MISSING" });
        }
        const r = await readServerlessTaskLogs({
          workflowArn,
          ledger: { runId: String(params.runId), startedAt: run.startedAt as string, finishedAt: run.finishedAt as string },
          taskId,
        });
        return apiOk({
          taskId, tryNumber, scheduler: "serverless", logs: r.logs,
          logGroup: r.logGroup, logStream: r.logStream, workflowRunId: r.workflowRunId,
          taskStatus: r.taskStatus, runType: r.runType,
        });
      }
      const mwaa = mwaaClientFor(ep.region);
      const out = await mwaa.send(
        new InvokeRestApiCommand({
          Name: ep.envName,
          Method: "GET",
          Path: `/dags/${dagId}/dagRuns/${encodeURIComponent(airflowRunId)}/taskInstances/${encodeURIComponent(taskId)}/logs/${tryNumber}`,
          QueryParameters: { full_content: true } as any,
        })
      );
      const resp: any = out.RestApiResponse;
      // Airflow returns { content, continuation_token } as JSON, or sometimes plain text.
      if (typeof resp === "string") content = resp;
      else if (resp && typeof resp.content === "string") content = resp.content;
      else if (resp) content = JSON.stringify(resp);
    } catch (e: any) {
      return apiOk({ taskId, tryNumber, logs: [`日志获取失败: ${e.message}`] });
    }

    // Split into lines for the viewer; Airflow log content is one big string.
    const logs = content ? content.split("\n") : ["暂无日志"];
    return apiOk({ taskId, tryNumber, logs });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
