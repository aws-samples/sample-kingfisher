export const dynamic = "force-dynamic";
// @kf-batch 50-W5-seg2-WP10a
// GET /api/admin/exec-envs/[targetId]/acks —— 回查该执行目标的全部免责告知同意记录(50 SPEC v3.23 §2.1 / §3.2;bgp-admin)。
// 首行 = 注册时 admin 的同意(来自描述符 `residencyAck`,source=register);其余来自 S13 同意留存表的 GSI byTarget(source=ack)。
// 只读;详情页「已同意告知」卡读它。home 法域 target ⇒ 空列表(不是错误:没有需要同意的东西)。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { getTargetRaw } from "@/lib/exec-env/registry";
import { isCrossJurisdiction, jurisdictionOf } from "@/lib/exec-env/residency";
import { listAcksByTarget } from "@/lib/exec-env/residency-store";
import { isValidTargetId } from "@/lib/exec-env/target-id";

export interface AckView {
  source: "register" | "ack";
  by: string;
  sub?: string;
  at: string;
  version: string;
  textHash: string;
}

export async function GET(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) {
    return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  }
  const t = await getTargetRaw(params.targetId);
  if (!t) return apiError(`执行目标不存在:${params.targetId}`, 404, { code: "NOT_FOUND" });
  const acks: AckView[] = [];
  if (isCrossJurisdiction(t)) {
    let rows: Awaited<ReturnType<typeof listAcksByTarget>>;
    try {
      rows = await listAcksByTarget(params.targetId);
    } catch (e) {
      return apiError(`读取同意记录失败:${String((e as Error)?.message ?? e)}`, 503, { code: "UPSTREAM_ERROR" });
    }
    // 注册时的同意:v3.24 起注册路由同时写 S13 一行(source=register,带 sub);更早注册的 target 只有描述符上的 residencyAck ⇒ 回落描述符
    if (t.residencyAck && !rows.some((r) => r.source === "register")) {
      acks.push({ source: "register", by: t.residencyAck.by, at: t.residencyAck.at, version: t.residencyAck.version, textHash: t.residencyAck.textHash });
    }
    for (const r of rows) {
      acks.push({ source: r.source === "register" ? "register" : "ack", by: r.username, sub: r.userSub, at: r.at, version: r.version, textHash: r.textHash });
    }
    acks.sort((a, b) => a.at.localeCompare(b.at));
  }
  return apiOk({ targetId: params.targetId, jurisdiction: jurisdictionOf(t), acks });
}
