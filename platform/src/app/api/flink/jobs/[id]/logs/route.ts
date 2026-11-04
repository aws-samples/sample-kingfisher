export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { readFlinkLogs, flinkJobTarget } from "@/lib/realtime/flink-service";

const USER_ID = "default-user";

// GET /api/flink/jobs/[id]/logs — MSAF 应用 CloudWatch 运行日志(最近若干条)。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item: job } = await docClient.send(new GetCommand({ TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId: params.id } }));
  if (!job) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, job, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const logs = await readFlinkLogs(params.id, 150, flinkJobTarget(job));
  return apiOk({ jobId: params.id, logs });
}
