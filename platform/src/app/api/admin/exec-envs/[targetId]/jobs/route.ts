export const dynamic = "force-dynamic";
// @kf-batch 50-WP9a-durable-jobs
// GET /api/admin/exec-envs/[targetId]/jobs?kind=supply|canary —— 该执行环境的数据面长作业(新的在前)。
//
// 🔴 回的是 DTO(`toPublicJob` 允许列表):lease / runToken / revision / 私有 state(含 statementId 与审计 id)永不出去。
// 🔴 页面阶段 == DDB 行(判据 JB-1):这里不做任何「推断阶段」,原样回行上的 phase;空表回空数组(页面「暂无作业」)。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { listJobsByTarget, countActiveJobs } from "@/lib/dataplane-jobs/store";
import { toPublicJob } from "@/lib/dataplane-jobs/dto";
import { JOB_KINDS, dataplaneJobsPaused, type JobKind } from "@/lib/dataplane-jobs/schema";

export async function GET(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) {
    return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  }
  const kindParam = req.nextUrl.searchParams.get("kind");
  if (kindParam !== null && !(JOB_KINDS as readonly string[]).includes(kindParam)) {
    return apiError(`kind 只能是 ${JOB_KINDS.join(" / ")}`, 400, { code: "VALIDATION_FAILED" });
  }
  try {
    const rows = await listJobsByTarget(params.targetId, { ...(kindParam ? { kind: kindParam as JobKind } : {}), maxItems: 500 });
    return apiOk({
      targetId: params.targetId,
      paused: dataplaneJobsPaused(),
      active: await countActiveJobs(params.targetId),
      jobs: rows.map(toPublicJob),
    });
  } catch (e) {
    return apiError((e as Error)?.message ?? String(e), 500);
  }
}
