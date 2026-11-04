export const dynamic = "force-dynamic";
// /api/admin/exec-envs/[targetId]/jobs/[jobId]
//   GET  —— 一条作业的 DTO
//   POST —— 「立即推进」:与内部端点**同一份** `runJobStep`(同一套租约 + CAS),只是跳过退避等待
//
// 🔴 作业必须属于路径里的这个 targetId(交叉校验:拿 A 环境的页面去推 B 环境的作业 ⇒ 404,不泄露存在性)。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { getJob } from "@/lib/dataplane-jobs/store";
import { toPublicJob } from "@/lib/dataplane-jobs/dto";
import { isDataplaneJobId } from "@/lib/dataplane-jobs/model";
import { runJobStep } from "@/lib/dataplane-jobs/runner";

type Params = { params: Promise<{ targetId: string; jobId: string }> };

async function guard(req: NextRequest, params: Awaited<Params["params"]>) {
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) {
    return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  }
  if (!isDataplaneJobId(params.jobId)) return apiError("非法 jobId", 400, { code: "VALIDATION_FAILED" });
  const row = await getJob(params.jobId);
  if (!row || row.targetId !== params.targetId) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  return row;
}

export async function GET(req: NextRequest, props: Params) {
  const params = await props.params;
  try {
    const g = await guard(req, params);
    if (g instanceof NextResponse) return g;
    return apiOk(toPublicJob(g));
  } catch (e) {
    return apiError((e as Error)?.message ?? String(e), 500);
  }
}

export async function POST(req: NextRequest, props: Params) {
  const params = await props.params;
  try {
    const g = await guard(req, params);
    if (g instanceof NextResponse) return g;
    await recordAudit(req, "exec-env.dataplane-job.advance", {
      resourceType: "exec-env",
      resourceId: params.targetId,
      detail: { jobId: params.jobId, kind: g.kind, projectId: g.projectId },
    }).catch(() => {});
    const out = await runJobStep(params.jobId, { respectSchedule: false });
    switch (out.kind) {
      case "paused":
        return apiError("数据面作业已停泵(BGP_DATAPLANE_JOBS_PAUSED=1)⇒ 不推进", 503, { code: "UPSTREAM_ERROR" });
      case "missing":
        return apiError("作业不存在", 404, { code: "NOT_FOUND" });
      case "busy":
        return apiError("作业正由别的推进者持有(租约未过期)⇒ 稍后再看", 409, { code: "CONFLICT" });
      case "stale":
        return apiError("本次推进被接手,结果已作废 ⇒ 刷新后再看", 409, { code: "CONFLICT" });
      default:
        return apiOk({ outcome: out.kind, job: out.job });
    }
  } catch (e) {
    return apiError((e as Error)?.message ?? String(e), 500);
  }
}
