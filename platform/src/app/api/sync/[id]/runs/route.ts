export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
// 序 61 B-133 —— 存量 / 调度运行时写的失败行只有 AWS 原话 ⇒ 读侧按闭合清单翻成中文结论(写侧已分类的行原样)
import { presentRunRow } from "@/lib/sync/run-error";

const USER_ID = "default-user";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const { Item: task } = await docClient.send(
      new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId: params.id } })
    );
    if (task) {
      const guard = await guardResourceAccess(req, task, "viewer");
      if (guard instanceof NextResponse) return guard;
    }
    const { Items = [] } = await docClient.send(new QueryCommand({
      TableName: TABLES.TASK_RUNS,
      KeyConditionExpression: "taskId = :tid",
      ExpressionAttributeValues: { ":tid": params.id },
      ScanIndexForward: false,
      Limit: 200,
    }));

    const runs = Items.map((row) => presentRunRow(row));
    const succeeded = runs.filter((r) => r.status === "succeeded").length;
    const stats = {
      total: runs.length,
      successRate: runs.length > 0 ? succeeded / runs.length : 0,
      avgDuration: runs.length > 0 ? runs.reduce((s, r) => s + (r.duration || 0), 0) / runs.length : 0,
      totalRows: runs.reduce((s, r) => s + (r.metrics?.rowsWritten || 0), 0),
    };

    return apiOk({ runs, stats });
  } catch (e: any) {
    return apiOk({ runs: [], stats: { total: 0, successRate: 0, avgDuration: 0, totalRows: 0 } });
  }
}
