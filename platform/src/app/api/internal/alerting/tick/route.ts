export const dynamic = "force-dynamic";
// POST /api/internal/alerting/tick  { projectId } —— **平台内部端点**(唯一调用方:本进程的告警 / SLA 评估泵,回环)。
//
// 评估 = `alerting/tick.ts#alertingTick`:规则评估与告警中心「立即评估」**同一个函数**(事件条件写去重,
// 泵与按钮同时跑也不重复告警);SLA 预测与 `/api/sla/predict` **同一个函数**。
// 🔴 鉴权复用内部守卫(不经 CloudFront + 来源头 + Secrets Manager 共享密钥),来源名 `alerting-pump`;
//    分发 Lambda / 别的泵的来源敲不开这里(`expectedSource` 精确判)。
// 🔴 请求体只认一个键;评估哪些规则 / 哪些 SLA,都从项目下的配置行读(建规则 / 建 SLA 时由有权的路由写定)。
// 🔴 被拒必留痕;正常评估不逐次写审计(每分钟一轮会把审计表刷成噪声;产生新事件时事件行本身就是留痕)。
import { NextRequest, NextResponse } from "next/server";
import { writeAuditRecord } from "@/lib/audit";
import { verifyInternalCaller, ALERTING_PUMP_PRINCIPAL, INTERNAL_SOURCE_ALERTING_PUMP } from "@/lib/scheduler/internal-guard";
import { alertingTick } from "@/lib/alerting/tick";
import { getProject } from "@/lib/projects/project-service";
import { ALERTING_TICK_ENDPOINT_PATH } from "@/lib/alerting/pump";

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status });
}

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export async function POST(req: NextRequest) {
  const verdict = await verifyInternalCaller(req.headers, { expectedSource: INTERNAL_SOURCE_ALERTING_PUMP });
  if (!verdict.ok) {
    await writeAuditRecord(
      { actor: ALERTING_PUMP_PRINCIPAL.actor },
      "internal.alerting.denied",
      { resourceType: "alert-rule", resourceId: "-", detail: { status: verdict.status, reason: verdict.reason } },
      { method: "POST", path: ALERTING_TICK_ENDPOINT_PATH }
    ).catch((e) => console.error("[internal/alerting/tick] 审计写失败:%s", String(e)));
    return json(verdict.status, { success: false, error: { message: verdict.reason } });
  }
  let projectId = "";
  try {
    const body = (await req.json()) as { projectId?: unknown };
    projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
  } catch {
    /* 下面统一按缺参处理 */
  }
  if (!ID_RE.test(projectId)) return json(400, { success: false, error: { message: "缺合法 projectId" } });
  try {
    if (!(await getProject(projectId))) return json(404, { success: false, error: { message: "项目不存在" } });
    const r = await alertingTick(projectId);
    return json(200, { success: true, data: r });
  } catch (e) {
    return json(500, { success: false, error: { message: String((e as Error)?.message ?? e).slice(0, 500) } });
  }
}
