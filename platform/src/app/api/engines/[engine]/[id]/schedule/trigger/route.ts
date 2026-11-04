export const dynamic = "force-dynamic";
// @kf-batch 50-WP15-airflow-serverless(施工序 6)
// POST /api/engines/[engine]/[id]/schedule/trigger —— EMR 引擎作业的〔触发一次〕(S-7);与 etl-jobs 同一份分路 lib/scheduler/trigger.ts。
import { NextRequest, NextResponse } from "next/server";
// @kf-batch 50-WP31-place-first-class —— targets 子集的唯一解析作者
import { requestedSubset } from "@/lib/place/resolve";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { guardResourceAccess } from "@/lib/projects/guard";
import { isEngineType } from "@/lib/engines/registry";
import { emrBaseDagIdOf } from "@/lib/engines/emr/schedule-fanout";
import { triggerScheduledRuns } from "@/lib/scheduler/trigger";
import { MwaaNotInstalled, mwaaErrorResponse } from "@/lib/scheduler/mwaa-endpoint";
import { requireResidencyAckForTargets, residencyErrorResponse } from "@/lib/exec-env/residency-audit";
import { AuditUnavailable, ResidencyAckRequired } from "@/lib/exec-env/residency";
import type { EmrEngineJob } from "@/lib/engines/emr/types";

const USER_ID = "default-user";

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ engine: string; id: string }> }
) {
  const params = await props.params;
  if (!isEngineType(params.engine)) return apiError("未知引擎", 400, { code: "VALIDATION_FAILED" });
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.ENGINE_JOBS, Key: { userId: USER_ID, jobId: params.id } }));
  if (!Item) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const guard = await guardResourceAccess(req, Item, "editor");
  if (guard instanceof NextResponse) return guard;
  const job = Item as EmrEngineJob;
  const body = await req.json().catch(() => ({}));
  const only: string[] | undefined = requestedSubset(body);
  const deployments = ((job as unknown as { deployments?: Record<string, { scheduler?: string; workflowArn?: string } | undefined> }).deployments ?? {});
  const deployed = Object.keys(deployments);
  const targets = only && only.length ? only.filter((t) => deployed.includes(t)) : deployed;
  if (targets.length === 0) return apiError("该作业没有已发布的调度产物 —— 先〔发布到 MWAA 调度〕再触发(触发 ≠ 发布)", 409, { code: "CONFLICT" });
  try {
    await requireResidencyAckForTargets(guard.identity, targets);
    const rows = await triggerScheduledRuns({ baseDagId: emrBaseDagIdOf(job), deployments, targets });
    recordAudit(req, "engine-job.schedule.trigger", { resourceType: "engine-job", resourceId: job.jobId, detail: { engine: params.engine, rows } }).catch(() => {});
    return apiOk({ rows, partial: rows.some((r) => r.status !== "ok") });
  } catch (e: unknown) {
    if (e instanceof ResidencyAckRequired || e instanceof AuditUnavailable) {
      // residencyErrorResponse 对非驻留类错误回 null;Next 的路由类型检查要求 POST 只回 Response ⇒ 显式收窄
      const r = residencyErrorResponse(e);
      if (r) return r;
    }
    if (e instanceof MwaaNotInstalled) return mwaaErrorResponse(e);
    return apiError(`触发失败:${String((e as Error)?.message ?? e)}`, 500);
  }
}
