export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { auditObservedScheduledRun } from "@/lib/exec-env/residency-audit";

const USER_ID = "default-user";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const { Item: job } = await docClient.send(
      new GetCommand({ TableName: TABLES.ETL_JOBS, Key: { userId: USER_ID, jobId: params.id } })
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
    // 观测后审计:列表里出现的**定时** run 若在跨法域 target 上且尚无区域审计 ⇒ 现在补写
    //    (SPEC v3.23 §3.2;幂等 pending 抢占协议;非定时 / home 行零 I/O;失败不影响列表)
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
