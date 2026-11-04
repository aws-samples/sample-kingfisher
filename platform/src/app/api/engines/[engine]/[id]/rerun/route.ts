export const dynamic = "force-dynamic";

// POST /api/engines/[engine]/[id]/rerun  body { runId }
// 以某历史运行相同的业务日期(runDate)重新提交一次 job-run,triggeredBy="rerun"。照抄 etl-jobs rerun。

import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { isEngineType, getProvider } from "@/lib/engines/registry";
// @kf-batch 50-W5-seg2-WP10a
import { residencyErrorResponse, userActor } from "@/lib/exec-env/residency-audit";

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
  if (!job.script || !job.script.trim()) return apiError("脚本为空，请先编写脚本", 400, { code: "VALIDATION_FAILED" });

  const body = await req.json().catch(() => ({}));
  if (!body?.runId) return apiError("缺少 runId", 400, { code: "VALIDATION_FAILED" });

  // 取原运行的业务日期(若有),用同一 runDate 重跑。engine 运行记录同样落 bgp-task-runs(pk=jobId)。
  const { Item: prev } = await docClient.send(
    new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId: params.id, runId: body.runId } })
  );
  const runDate = prev?.runDate || undefined;

  try {
    // @kf-batch 50-W5-seg2-WP10a —— 行为主体传给 provider 写区域审计(重跑不带 targetId ⇒ home,同意前置为空操作;残留错误仍映射)
    const res = await getProvider(params.engine).submit(job, { runDate, triggeredBy: "rerun", actor: userActor(guard.identity) });
    recordAudit(req, `engine.${params.engine}.rerun`, {
      resourceType: "engine-job",
      resourceId: job.jobId,
      detail: { fromRunId: body.runId, runId: res.runId, runDate: res.runDate },
    }).catch(() => {});
    return apiOk(res);
  } catch (e: any) {
    const r = residencyErrorResponse(e);
    if (r) return r;
    return apiError(`重跑失败: ${e.message}`, 500, { code: "UPSTREAM_ERROR" });
  }
}
