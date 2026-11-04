export const dynamic = "force-dynamic";
// POST /api/admin/exec-envs/[targetId]/drain —— 删除流程第一步「停止承接」(SPEC §2.1 `drain {reason}`)。
//
// 🔴 与 `.../intent {intent:"drain"}` 是**同一个写通道**(`lifecycle.setSpecIntent`):本路由只多收一个 `reason`
//   并把它留进审计(删除流程要回放「为什么停的」)。停接新活是同步生效的 —— 准入内核读 spec.intent,
//   此后新绑定 / 新调度 / 新 run 一律 409 且拒因以「该执行环境已停止承接」开头(ED-B1)。
// 🔴 home 不许(自断双腿,与 intent 路由同一口径);已批准删除(intent=delete)的不许改回(写通道里拒)。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { getTargetRaw } from "@/lib/exec-env/registry";
import { isHome, isValidTargetId } from "@/lib/exec-env/target-id";
import { setSpecIntent } from "@/lib/exec-env/lifecycle";
import { decommissionErrorResponse } from "@/lib/exec-env/decommission-http";
import { STOPPED_ACCEPTING } from "@/lib/exec-env/decommission";

const CLIENT_FIELDS = ["reason"];

export async function POST(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError("请求体不是合法 JSON", 400, { code: "VALIDATION_FAILED" });
  }
  const extra = Object.keys(body ?? {}).filter((k) => !CLIENT_FIELDS.includes(k));
  if (extra.length) return apiError(`入参含不允许的字段:${extra.join(", ")}(只接 ${CLIENT_FIELDS.join(", ")})`, 400, { code: "VALIDATION_FAILED" });
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason || reason.length > 500) return apiError("reason 必填(1–500 字):为什么停止承接 —— 删除流程的审计要回放它", 400, { code: "VALIDATION_FAILED" });
  if (isHome(params.targetId)) {
    return apiError("主控区执行环境不允许停止承接 —— 它是控制面自己的执行环境(与「主控区不显示删除入口」同一口径)", 403, { code: "RBAC_DENIED" });
  }
  try {
    const t = await getTargetRaw(params.targetId);
    if (!t) return apiError(`执行目标不存在:${params.targetId}`, 404, { code: "NOT_FOUND" });
    if (!Number.isInteger(t.version)) return apiError("描述符缺 version,无法做乐观锁写入", 500, { code: "INTERNAL" });
    const before = { intent: t.spec?.intent ?? "(legacy)", status: t.status, phase: t.observed?.phase };
    await setSpecIntent(params.targetId, "drain", { expectedVersion: t.version as number });
    const after = await getTargetRaw(params.targetId);
    recordAudit(req, "exec-env.drain", {
      resourceType: "exec-env",
      resourceId: params.targetId,
      detail: { reason, before, after: { intent: after?.spec?.intent, status: after?.status, phase: after?.observed?.phase }, via: "delete-flow" },
    }).catch(() => {});
    return apiOk({
      targetId: params.targetId,
      intent: "drain",
      status: after?.status,
      phase: after?.observed?.phase,
      note: `${STOPPED_ACCEPTING}(同步生效):新绑定 / 新调度 / 新运行一律拒;在途作业跑完。下一步:打开影响预览,三个数都为 0 后申请删除`,
    });
  } catch (e) {
    return decommissionErrorResponse(e, "停止承接");
  }
}
