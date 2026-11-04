export const dynamic = "force-dynamic";
// POST /api/internal/dataplane-jobs/step  { jobId } —— **平台内部端点**(唯一调用方:本进程的推进泵,回环)。
//
// 一步 = 抢 lease → 执行 / 轮询一步 → 写回(墙钟 45s;④-2)。逻辑全在 `runJobStep`,
// 页面「立即推进」走同一份(admin 鉴权)。
// 🔴 鉴权复用 内部守卫(不经 CloudFront + 来源头 + Secrets Manager 共享密钥),来源名 `dataplane-job-pump`;
//    分发 Lambda 的来源敲不开这里(`expectedSource` 精确判)。
// 🔴 请求体只认 jobId:做什么、以谁的名义做,都从作业行读(入队时由有权的路由写定)。
// 🔴 被拒必留痕;正常推进不逐次写审计(15s 一轮会把审计表刷成噪声)—— 作业里每个 admin 动作自己有意图 / 结果审计。
import { NextRequest, NextResponse } from "next/server";
import { writeAuditRecord } from "@/lib/audit";
import { verifyInternalCaller, DATAPLANE_JOB_PUMP_PRINCIPAL, INTERNAL_SOURCE_DATAPLANE_JOB_PUMP } from "@/lib/scheduler/internal-guard";
import { runJobStep } from "@/lib/dataplane-jobs/runner";
import { isDataplaneJobId } from "@/lib/dataplane-jobs/model";
import { STEP_ENDPOINT_PATH } from "@/lib/dataplane-jobs/schema";

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status });
}

export async function POST(req: NextRequest) {
  const verdict = await verifyInternalCaller(req.headers, { expectedSource: INTERNAL_SOURCE_DATAPLANE_JOB_PUMP });
  if (!verdict.ok) {
    await writeAuditRecord(
      { actor: DATAPLANE_JOB_PUMP_PRINCIPAL.actor },
      "internal.dataplane-job.denied",
      { resourceType: "dataplane-job", resourceId: "-", detail: { status: verdict.status, reason: verdict.reason } },
      { method: "POST", path: STEP_ENDPOINT_PATH }
    ).catch((e) => console.error("[internal/dataplane-jobs/step] 审计写失败:%s", String(e)));
    return json(verdict.status, { success: false, error: { message: verdict.reason } });
  }
  let jobId = "";
  try {
    const body = (await req.json()) as { jobId?: unknown };
    jobId = typeof body?.jobId === "string" ? body.jobId.trim() : "";
  } catch {
    /* 下面统一按缺参处理 */
  }
  if (!isDataplaneJobId(jobId)) return json(400, { success: false, error: { message: "缺合法 jobId" } });

  try {
    const out = await runJobStep(jobId, { respectSchedule: true });
    switch (out.kind) {
      case "paused":
        return json(503, { success: false, error: { message: "数据面作业已停泵(BGP_DATAPLANE_JOBS_PAUSED=1)" } });
      case "missing":
        return json(404, { success: false, error: { message: "作业不存在" } });
      case "busy":
      case "stale":
        return json(409, { success: false, error: { message: out.kind === "busy" ? "作业正由别的推进者持有" : "本次推进被接手,结果已作废" } });
      default:
        return json(200, { success: true, data: { outcome: out.kind, job: out.job } });
    }
  } catch (e) {
    return json(500, { success: false, error: { message: String((e as Error)?.message ?? e).slice(0, 500) } });
  }
}
