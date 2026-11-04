export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { GetLogEventsCommand, DescribeLogStreamsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
// @kf-batch 50-WP7-sync-pushdown —— CloudWatch 日志组是 region 内的:非 home 的 Glue 作业日志在
// **那个区**的日志组里,home 客户端取到的空与「作业没输出」长得一模一样(问 A 答 B)。
import { bindingTargets, regionOfTarget } from "@/lib/exec-env/data-plane-target";
import { logsClientFor } from "@/lib/exec-env/target-clients";

const USER_ID = "default-user";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const { Item: task } = await docClient.send(new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId: params.id } }));
    if (task) {
      const guard = await guardResourceAccess(req, task, "viewer");
      if (guard instanceof NextResponse) return guard;
    }
    if (!task?.glueJobName) return apiOk(["任务未启动，无日志"]);
    const tid = bindingTargets(task as { targets?: unknown; targetId?: unknown })[0];
    const cwl = await logsClientFor(await regionOfTarget(tid));

    // Get latest run's glueJobRunId
    let targetRunId = "";
    try {
      const { Items = [] } = await docClient.send(new QueryCommand({
        TableName: TABLES.TASK_RUNS, KeyConditionExpression: "taskId = :t",
        ExpressionAttributeValues: { ":t": params.id }, ScanIndexForward: false, Limit: 1,
      }));
      if (Items[0]?.glueJobRunId) targetRunId = Items[0].glueJobRunId;
    } catch {}

    const logGroups = ["/aws-glue/jobs/output", "/aws-glue/jobs/logs-v2"];
    const allLogs: string[] = [];

    for (const logGroup of logGroups) {
      try {
        const { logStreams = [] } = await cwl.send(new DescribeLogStreamsCommand({
          logGroupName: logGroup, orderBy: "LastEventTime", descending: true, limit: 20,
        }));

        // Find stream matching the latest job run ID (partial match)
        let streams = targetRunId
          ? logStreams.filter((s) => s.logStreamName?.includes(targetRunId.slice(0, 20)))
          : [];

        // Fallback: if no match, use most recent
        if (streams.length === 0) streams = logStreams.slice(0, 3);

        for (const stream of streams.slice(0, 2)) {
          try {
            const { events = [] } = await cwl.send(new GetLogEventsCommand({
              logGroupName: logGroup, logStreamName: stream.logStreamName!, startFromHead: false, limit: 200,
            }));
            for (const e of events) { if (e.message) allLogs.push(e.message.trim()); }
          } catch {}
        }
        if (allLogs.length > 0) break;
      } catch {}
    }

    return apiOk(allLogs.length > 0 ? allLogs : ["日志生成中... Glue Job 日志通常有 1-2 分钟延迟"]);
  } catch {
    return apiOk(["日志加载失败"]);
  }
}
