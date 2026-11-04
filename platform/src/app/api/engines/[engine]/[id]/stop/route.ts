export const dynamic = "force-dynamic";

// POST /api/engines/[engine]/[id]/stop  body { runId? }
// SPI 分派：getProvider(engine).stop()。EMR CancelJobRun + 收口 stopped。

import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { isEngineType, getProvider } from "@/lib/engines/registry";

const USER_ID = "default-user";

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ engine: string; id: string }> }
) {
  const params = await props.params;
  if (!isEngineType(params.engine)) return apiError("未知引擎", 400, { code: "VALIDATION_FAILED" });
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.ENGINE_JOBS, Key: { userId: USER_ID, jobId: params.id } })
  );
  if (!Item) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const guard = await guardResourceAccess(req, Item, "editor");
  if (guard instanceof NextResponse) return guard;

  const job = Item as any;
  const body = await req.json().catch(() => ({}));
  const runId = body?.runId || job.lastRunId;
  if (!runId) return apiError("无运行中的 run 可停止", 400, { code: "VALIDATION_FAILED" });

  // 取该 run 的 nativeRunId（EMR jobRunId）。
  const { Item: run } = await docClient.send(
    new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId: params.id, runId } })
  );
  if (!run || !run.nativeRunId) return apiError("找不到该运行记录或缺少原生 run 标识", 404, { code: "NOT_FOUND" });

  try {
    await getProvider(params.engine).stop(job, runId, String(run.nativeRunId));
    recordAudit(req, `engine.${params.engine}.stop`, {
      resourceType: "engine-job",
      resourceId: job.jobId,
      detail: { runId, nativeRunId: run.nativeRunId },
    }).catch(() => {});
    return apiOk({ stopped: true, runId });
  } catch (e: any) {
    return apiError(`停止失败: ${e.message}`, 500, { code: "UPSTREAM_ERROR" });
  }
}
