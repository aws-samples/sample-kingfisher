export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { flinkJobTarget } from "@/lib/realtime/flink-service";
import { getCorrelationId } from "@/lib/observability/logger";
// 停止主体(pauseFlinkJob 等 MSAF 离开运行态最多 2 分钟 → 写 stopping → 审计)在 lib/realtime/long-ops.ts(flink-stop)。
//   超 45 秒由统一框架转 202,页面右下「正在后台执行:停止实时作业」;对象租约 `flink:<jobId>`。
import { submitLongOp, longOpResponse, longOpErrorResponse } from "@/lib/long-ops/driver";

const USER_ID = "default-user";

// POST /api/flink/jobs/[id]/stop — 停止(暂停)作业:仅 StopApplication 停 KPU 计费,
// 【保留 MSAF 应用与日志组】。用户拍板:UI 停止 ≠ 删除——停止后后台 Flink 应用仍在,
// 可再启动、可 AI 诊断、可看日志;只有 UI「删除」才真正销毁应用。
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item: job } = await docClient.send(new GetCommand({ TableName: TABLES.FLINK_JOBS, Key: { userId: USER_ID, jobId: params.id } }));
  if (!job) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const ctx = await guardResourceAccess(req, job, "editor");
  if (ctx instanceof NextResponse) return ctx;
  try {
    const result = await submitLongOp(
      { kind: "flink-stop", params: { jobId: params.id, targetId: flinkJobTarget(job) }, correlationId: getCorrelationId(req) },
      { req, identity: ctx.identity },
    );
    return longOpResponse(req, result);
  } catch (e: any) {
    const lo = longOpErrorResponse(e);
    if (lo) return lo;
    return apiError(String(e?.message || e), 500);
  }
}
