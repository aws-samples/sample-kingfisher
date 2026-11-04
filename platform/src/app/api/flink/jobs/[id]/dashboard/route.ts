export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { flinkDashboardUrl, flinkJobTarget } from "@/lib/realtime/flink-service";

const USER_ID = "default-user";

// GET /api/flink/jobs/[id]/dashboard — 签发原生 Flink Web UI(Dashboard)临时访问 URL(仅 RUNNING 态)。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item: job } = await docClient.send(new GetCommand({ TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId: params.id } }));
  if (!job) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, job, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  try {
    const url = await flinkDashboardUrl(params.id, flinkJobTarget(job));
    if (!url) return apiError("仅作业 RUNNING 时可打开 Flink 控制台(请先启动并等待进入运行态)", 409, { code: "VALIDATION_FAILED" });
    return apiOk({ url });
  } catch (e: any) {
    return apiError("签发 Flink 控制台地址失败: " + String(e?.message || e), 500);
  }
}
