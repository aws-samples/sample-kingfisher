export const dynamic = "force-dynamic";

// POST /api/engines/[engine]/[id]/backfill  body { startDate, endDate }
// 对 [startDate, endDate](含端点,≤31 天)每个业务日期各提交一次 job-run,triggeredBy="backfill",
// 各自带 runDate。顺序提交(每次一条 run 记录),完成情况看运行历史。结构照抄 etl-jobs backfill。

import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { isEngineType, getProvider } from "@/lib/engines/registry";
import { dateRange } from "@/lib/etl/run-params";
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
  let dates: string[];
  try {
    dates = dateRange(body?.startDate, body?.endDate);
  } catch (e: any) {
    return apiError(e.message, 400, { code: "VALIDATION_FAILED" });
  }

  try {
    const provider = getProvider(params.engine);
    const runs: Array<{ runDate: string; runId: string }> = [];
    // @kf-batch 50-W5-seg2-WP10a —— 行为主体传给 provider 写区域审计(不带 targetId ⇒ home,同意前置为空操作)
    const actor = userActor(guard.identity);
    for (const d of dates) {
      const res = await provider.submit(job, { runDate: d, triggeredBy: "backfill", actor });
      runs.push({ runDate: d, runId: res.runId });
    }
    recordAudit(req, `engine.${params.engine}.backfill`, {
      resourceType: "engine-job",
      resourceId: job.jobId,
      detail: { startDate: body.startDate, endDate: body.endDate, count: runs.length },
    }).catch(() => {});
    return apiOk({ count: runs.length, runs });
  } catch (e: any) {
    const r = residencyErrorResponse(e);
    if (r) return r;
    return apiError(`补数失败: ${e.message}`, 500, { code: "UPSTREAM_ERROR" });
  }
}
