export const dynamic = "force-dynamic";
// @kf-batch 50-B51-backfill-pump
// POST /api/internal/backfill/tick  { projectId, planId } —— **平台内部端点**(唯一调用方:本进程的补数推进泵,回环)。
//
// 推进 = `backfill/runner.ts#tick`,与补数页的 `/api/backfill/[planId]/tick` **同一个函数**(幂等:领取实例是条件写,
// 泵与页面同时推也不会重复提交)。
// 🔴 鉴权复用内部守卫(不经 CloudFront + 来源头 + Secrets Manager 共享密钥),来源名 `backfill-pump`;
//    分发 Lambda / 数据面作业泵的来源敲不开这里(`expectedSource` 精确判)。
// 🔴 请求体只认两个键;推什么、按什么并发,都从计划行读(建计划时由有权的路由写定)。
// 🔴 被拒必留痕;正常推进不逐次写审计(30s 一轮会把审计表刷成噪声)。
import { NextRequest, NextResponse } from "next/server";
import { writeAuditRecord } from "@/lib/audit";
import { verifyInternalCaller, BACKFILL_PUMP_PRINCIPAL, INTERNAL_SOURCE_BACKFILL_PUMP } from "@/lib/scheduler/internal-guard";
import { tick } from "@/lib/backfill/runner";
import { getPlan } from "@/lib/backfill/service";
import { BACKFILL_TICK_ENDPOINT_PATH } from "@/lib/backfill/pump";

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status });
}

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export async function POST(req: NextRequest) {
  const verdict = await verifyInternalCaller(req.headers, { expectedSource: INTERNAL_SOURCE_BACKFILL_PUMP });
  if (!verdict.ok) {
    await writeAuditRecord(
      { actor: BACKFILL_PUMP_PRINCIPAL.actor },
      "internal.backfill.denied",
      { resourceType: "backfill-plan", resourceId: "-", detail: { status: verdict.status, reason: verdict.reason } },
      { method: "POST", path: BACKFILL_TICK_ENDPOINT_PATH }
    ).catch((e) => console.error("[internal/backfill/tick] 审计写失败:%s", String(e)));
    return json(verdict.status, { success: false, error: { message: verdict.reason } });
  }
  let projectId = "";
  let planId = "";
  try {
    const body = (await req.json()) as { projectId?: unknown; planId?: unknown };
    projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
    planId = typeof body?.planId === "string" ? body.planId.trim() : "";
  } catch {
    /* 下面统一按缺参处理 */
  }
  if (!ID_RE.test(projectId) || !ID_RE.test(planId)) return json(400, { success: false, error: { message: "缺合法 projectId / planId" } });
  try {
    if (!(await getPlan(projectId, planId))) return json(404, { success: false, error: { message: "补数计划不存在" } });
    const r = await tick(projectId, planId);
    return json(200, { success: true, data: r });
  } catch (e) {
    return json(500, { success: false, error: { message: String((e as Error)?.message ?? e).slice(0, 500) } });
  }
}
