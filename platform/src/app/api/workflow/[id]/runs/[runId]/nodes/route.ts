export const dynamic = "force-dynamic";
// MWAA 环境 / 桶只经解析器(home 逐字节不变)
// 🔴 节点状态要去**这个工作流自己那个区**的 Airflow 查。
// 用主控区环境查一个别区的 DAG run,回的是「没有这个 dag」⇒ 界面上所有节点都是灰的,
// 看起来像「工作流没跑」,而它在那个区跑得好好的。
// 顺带:本文件原来抄了一份 `mwaaCli`(共 3 处副本),现在收成解析器里那一份(它按区建客户端)。
import { schedulerEndpointFor, isServerlessEndpoint, mwaaCli, MwaaNotInstalled, mwaaErrorResponse } from "@/lib/scheduler/mwaa-endpoint";
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { listServerlessNodeStates } from "@/lib/scheduler/serverless/task-logs";
import { serverlessWorkflowArnOf } from "@/lib/workflow/publish-dag";
// 每个节点行挂 backLink(它引用的作业 / 同步任务)⇒ 页面「节点详情」能点回作业自己的运行历史;task_id ↔ 节点用生成器那一份映射
import { withNodeBackLinks } from "@/lib/workflow/run-node-back-links";

const USER_ID = "default-user";

// WF-04 — list the task instances (nodes) of a workflow run with their states, so the UI
// can render per-node status and let the user drill into a node's logs.
//
// Uses the MWAA CLI `tasks states-for-dag-run <dagId> <runId> -o json`, which reads the
// Airflow metadata DB (no DAG parsing) and is supported on MWAA Airflow v2.

/** 该工作流所在区的 Airflow 上跑一条 CLI(端点解析 + 客户端按区,都在 mwaa-endpoint 里)。 */
async function cliForWorkflow(wf: unknown, command: string): Promise<string> {
  const ep = await schedulerEndpointFor(bindingTargets((wf ?? {}) as { targets?: unknown; targetId?: unknown })[0] || "tgt_home");
  if (isServerlessEndpoint(ep)) return ""; // serverless 没有 Airflow CLI —— 它走下面那条服务 API 的路
  const r = await mwaaCli(ep, command);
  return r.stdout;
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
    const { Item: run } = await docClient.send(
      new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId: params.id, runId: params.runId } })
    );
    if (!run) return apiError("运行记录不存在", 404);

    const dagId = run.airflowDagId;
    if (!dagId) return apiOk({ nodes: [] });
    const airflowRunId = run.airflowRunId || params.runId;

    // serverless 没有 Airflow CLI:逐节点状态问服务 API。
    // 🔴 只认 `GetTaskInstance`(列表不返回 TaskId、旧尝试还停在非终态);被 skip 连带的下游**不出现**在
    //   列表里 ⇒ 返回的节点可以比图里少,界面把缺的当 no_status(与经典同款),这不是 bug。
    const ep = await schedulerEndpointFor(bindingTargets((wf ?? {}) as { targets?: unknown; targetId?: unknown })[0] || "tgt_home");
    if (isServerlessEndpoint(ep)) {
      const workflowArn = await serverlessWorkflowArnOf(
        { workflowId: params.id, airflowDagId: String(dagId), deployments: (wf as { deployments?: unknown })?.deployments },
        ep
      );
      if (!workflowArn) {
        // 🔴 「读不到」不许回落成「没有」:如实说找不到产物,而不是给一个空节点列表(看起来像没跑)
        return apiError(`${ep.region} 上找不到这个工作流的 serverless workflow(名字 ${dagId})—— 请重新发布一次`, 409, { code: "SCHEDULER_ARTIFACT_MISSING" });
      }
      const r = await listServerlessNodeStates({
        workflowArn,
        ledger: { runId: String(params.runId), startedAt: run.startedAt as string, finishedAt: run.finishedAt as string },
      });
      return apiOk({ dagId, runId: r.runId ?? airflowRunId, nodes: withNodeBackLinks(r.nodes, (wf as { dagDefinition?: { nodes?: unknown[] } } | undefined)?.dagDefinition), scheduler: "serverless", runType: r.runType, matchedBy: r.how });
    }

    let nodes: any[] = [];
    try {
      const out = await cliForWorkflow(wf, `tasks states-for-dag-run ${dagId} ${airflowRunId} -o json`);
      const parsed = JSON.parse(out || "[]");
      // Normalize Airflow's field names (task_id/state/start_date/end_date/try_number).
      nodes = (Array.isArray(parsed) ? parsed : []).map((t: any) => ({
        taskId: t.task_id ?? t.taskId,
        state: t.state || "no_status",
        startDate: t.start_date || t.execution_date || null,
        endDate: t.end_date || null,
        tryNumber: Number(t.try_number ?? t.tryNumber ?? 1) || 1,
        duration: t.duration ?? null,
      })).filter((t: any) => t.taskId);
    } catch {
      // MWAA hiccup / parse error — return empty so the UI degrades gracefully.
      nodes = [];
    }

    return apiOk({ dagId, runId: airflowRunId, nodes: withNodeBackLinks(nodes as Array<{ taskId: string }>, (wf as { dagDefinition?: { nodes?: unknown[] } } | undefined)?.dagDefinition) });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
