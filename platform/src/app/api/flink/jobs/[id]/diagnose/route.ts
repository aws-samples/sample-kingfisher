export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { startFlinkDiagnosis, listDiagnostics } from "@/lib/diagnostics/service";

const USER_ID = "default-user";

// POST /api/flink/jobs/[id]/diagnose — 用 AWS DevOps Agent 对该 Flink 流作业发起故障诊断。
// 异步(后台调查),立即回执 diagnosticId;诊断记录持久化于 bgp-diagnostics,可回看。RBAC: viewer。
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item: job } = await docClient.send(new GetCommand({ TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId: params.id } }));
  if (!job) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, job, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  try {
    const rec = await startFlinkDiagnosis({ jobId: params.id, projectId: ctx.projectId, createdBy: ctx.identity.username });
    recordAudit(req, "flink.diagnose.start", { resourceType: "flink", resourceId: params.id, detail: { name: job.name, diagnosticId: rec.diagnosticId } }).catch(() => {});
    return apiOk({ diagnosticId: rec.diagnosticId, status: rec.status });
  } catch (e: any) {
    return apiError(`发起诊断失败: ${e.message || String(e)}`, 500);
  }
}

// GET /api/flink/jobs/[id]/diagnose — 该作业的历史诊断记录(留痕回看)。RBAC: viewer。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item: job } = await docClient.send(new GetCommand({ TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId: params.id } }));
  if (!job) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, job, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  try {
    const items = await listDiagnostics({ taskId: params.id });
    return apiOk(items);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
