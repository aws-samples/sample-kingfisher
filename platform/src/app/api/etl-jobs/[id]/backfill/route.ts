export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { runEtlJob } from "@/lib/etl/job-service";
// @kf-batch 50-P50.3-mrquery
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
import { dateRange } from "@/lib/etl/run-params";
import { recordAudit } from "@/lib/audit";
import { guardResourceAccess } from "@/lib/projects/guard";
import type { EtlJob } from "@/types/etl-job";
// @kf-batch 50-W5-seg2-WP10a
import { requireResidencyAckForTargets, residencyErrorResponse, userActor } from "@/lib/exec-env/residency-audit";

const USER_ID = "default-user";

// POST /api/etl-jobs/[id]/backfill  body { startDate, endDate }
// Triggers one run per business date in [startDate, endDate] (inclusive, ≤31 days), each
// parameterized with the corresponding ${ds}. Runs are fired sequentially (each creates its
// own run record, triggeredBy="backfill"); completion is tracked in the run history.
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.ETL_JOBS, Key: { userId: USER_ID, jobId: params.id } })
  );
  if (!Item) return apiError("作业不存在", 404);
  const guard = await guardResourceAccess(req, Item, "editor");
  if (guard instanceof NextResponse) return guard;
  const job = Item as EtlJob;
  if (!job.script || !job.script.trim()) return apiError("脚本为空，请先编写脚本");

  const body = await req.json().catch(() => ({}));
  let dates: string[];
  try {
    dates = dateRange(body?.startDate, body?.endDate);
  } catch (e: any) {
    return apiError(e.message);
  }

  try {
    // @kf-batch 50-P50.3-mrquery
    // 🔴 **补数要覆盖全部绑定的区**。原实现不传 targetId ⇒ 只补 `bindingTargets(job)[0]`
    // (通常是 home)⇒ 用户以为"这段日期补好了",而另一个区还是空的 = 静默只补一半。
    // 🔴 代价必须**显性**:总运行数 = 日期数 × 区数,响应里逐项回报(界面照实显示)。
    const bound = bindingTargets(job);
    // @kf-batch 50-W5-seg2-WP10a —— 补数 = N 次运行提交:同意前置先判全部绑定 target(409 带文案),行为主体传给 job-service 写区域审计
    await requireResidencyAckForTargets(guard.identity, bound);
    const actor = userActor(guard.identity);
    const runs: Array<{ runDate: string; runId: string; targetId: string }> = [];
    for (const d of dates) {
      for (const t of bound) {
        const res = await runEtlJob(job, { runDate: d, triggeredBy: "backfill", targetId: t, actor });
        runs.push({ runDate: d, runId: res.runId, targetId: res.targetId || t });
      }
    }
    recordAudit(req, "etl-job.backfill", {
      resourceType: "etl-job",
      resourceId: job.jobId,
      detail: { startDate: body.startDate, endDate: body.endDate, count: runs.length },
    }).catch(() => {});
    return apiOk({ count: runs.length, runs });
  } catch (e: any) {
    const r = residencyErrorResponse(e);
    if (r) return r;
    return apiError(`补数失败: ${e.message}`, 500);
  }
}
