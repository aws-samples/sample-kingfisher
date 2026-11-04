export const dynamic = "force-dynamic";

// GET /api/engines/[engine]/[id]/runs —— 运行历史（Query bgp-task-runs by taskId）。

import { NextRequest, NextResponse } from "next/server";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { isEngineType } from "@/lib/engines/registry";
import { auditObservedScheduledRun } from "@/lib/exec-env/residency-audit";

const USER_ID = "default-user";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ engine: string; id: string }> }
) {
  const params = await props.params;
  if (!isEngineType(params.engine)) return apiOk([]);
  try {
    const { Item: job } = await docClient.send(
      new GetCommand({ TableName: TABLES.ENGINE_JOBS, Key: { userId: USER_ID, jobId: params.id } })
    );
    if (job) {
      const guard = await guardResourceAccess(req, job, "viewer");
      if (guard instanceof NextResponse) return guard;
    }
    const { Items = [] } = await docClient.send(
      new QueryCommand({
        TableName: TABLES.TASK_RUNS,
        KeyConditionExpression: "taskId = :t",
        ExpressionAttributeValues: { ":t": params.id },
        ScanIndexForward: false,
        Limit: 50,
      })
    );
    // 观测后审计(与 etl-jobs 运行列表同一口径;幂等、失败不影响列表)
    await Promise.all(
      (Items as Array<Record<string, unknown>>).map(async (r) => {
        const res = await auditObservedScheduledRun({ taskId: params.id, runId: String(r.runId ?? ""), targetId: r.targetId, triggeredBy: r.triggeredBy, residencyAuditId: r.residencyAuditId });
        if (res.auditId) r.residencyAuditId = res.auditId;
      })
    );
    return apiOk(Items);
  } catch {
    return apiOk([]);
  }
}
