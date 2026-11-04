export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { runEtlJob } from "@/lib/etl/job-service";
// @kf-batch 50-P50.3-mrquery
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
import { recordAudit } from "@/lib/audit";
import { guardResourceAccess } from "@/lib/projects/guard";
import type { EtlJob } from "@/types/etl-job";
// @kf-batch 50-W5-seg2-WP10a
import { requireResidencyAckForTargets, residencyErrorResponse, userActor } from "@/lib/exec-env/residency-audit";

const USER_ID = "default-user";

// POST /api/etl-jobs/[id]/rerun  body { runId }
// Re-runs the job with the SAME business date (runDate) as a previous run.
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
  if (!body?.runId) return apiError("缺少 runId");

  // Recover the original run's business date (if any).
  const { Item: prev } = await docClient.send(
    new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId: params.id, runId: body.runId } })
  );
  const runDate = prev?.runDate || undefined;

  // @kf-batch 50-P50.3-mrquery
  // 🔴🔴 **重跑必须跑在原来那条 run 的 region**。原实现不传 targetId ⇒ `runRedshiftSqlJob`
  // 取 `bindingTargets(job)[0]` = 绑定的第一个(通常是 home)⇒ **重跑一条 us-west-2 的 run
  // 会静默跑到 home**:业务上是"我要重算那个区的数据",结果算到了另一个区,而且不报错。
  // region 取**原 run 记录的章**(它就是"那次实际跑在哪"的权威)。
  const prevTarget = String((prev as { targetId?: string } | undefined)?.targetId || "").trim();
  const bound = bindingTargets(job);
  if (prevTarget && !bound.includes(prevTarget)) {
    // 🔴 原来那个区**已经被解绑**了 ⇒ 拒,不许悄悄换个区重跑。
    return apiError(
      `原运行发生在执行目标 ${prevTarget},而该作业现在已不绑定它(当前绑定:${bound.join("/")})⇒ 拒绝重跑。` +
        `重跑到别的区域会算出"看起来一样、其实换了数据源"的结果。请先把该目标重新绑上,或直接运行当前绑定。`,
      409,
      { code: "CONFLICT" }
    );
  }

  // @kf-batch 50-W5-seg2-WP10a —— 重跑也是一次运行提交:同意前置(409 带文案)+ 行为主体传给 job-service 写区域审计
  const rerunTarget = prevTarget || bound[0];
  try {
    await requireResidencyAckForTargets(guard.identity, rerunTarget ? [rerunTarget] : []);
  } catch (e) {
    const r = residencyErrorResponse(e);
    if (r) return r;
    throw e;
  }
  try {
    const res = await runEtlJob(job, {
      runDate,
      triggeredBy: "rerun",
      ...(prevTarget ? { targetId: prevTarget } : {}),
      actor: userActor(guard.identity),
    });
    recordAudit(req, "etl-job.rerun", {
      resourceType: "etl-job",
      resourceId: job.jobId,
      detail: { fromRunId: body.runId, runId: res.runId, runDate: res.runDate },
    }).catch(() => {});
    return apiOk(res);
  } catch (e: any) {
    const r = residencyErrorResponse(e);
    if (r) return r;
    return apiError(`重跑失败: ${e.message}`, 500);
  }
}
