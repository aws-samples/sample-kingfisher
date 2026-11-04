export const dynamic = "force-dynamic";
// @kf-batch 50-WP30-discard
// POST /api/admin/exec-envs/[targetId]/discard —— WP-30 路 A「弃置」:从没装出来的执行环境退役(→ deleted),释放该区名额。
// 入参 `{confirm, decisionId}`:`confirm` 必须**逐字等于 targetId**(机制 A 强确认,防手滑);`decisionId` 是审计键。
// 判定与写入全在 `lib/exec-env/discard.ts`(路由不判「这算 409 还是 403」)。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { discardTarget, DiscardRefused } from "@/lib/exec-env/discard";

const CLIENT_FIELDS = ["confirm", "decisionId"];
const DECISION_ID_RE = /^[A-Za-z0-9_:-]{6,64}$/;

export async function POST(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return apiError("请求体不是合法 JSON", 400, { code: "VALIDATION_FAILED" }); }
  const extra = Object.keys(body ?? {}).filter((k) => !CLIENT_FIELDS.includes(k));
  if (extra.length) return apiError(`入参含不允许的字段:${extra.join(", ")}(只接 ${CLIENT_FIELDS.join(", ")})`, 400, { code: "VALIDATION_FAILED" });
  if (body.confirm !== params.targetId) {
    return apiError(`确认文字必须逐字等于 ${params.targetId}`, 400, { code: "VALIDATION_FAILED" });
  }
  if (typeof body.decisionId !== "string" || !DECISION_ID_RE.test(body.decisionId)) {
    return apiError("decisionId 非法(需 6-64 位 [A-Za-z0-9_:-])", 400, { code: "VALIDATION_FAILED" });
  }
  try {
    const r = await discardTarget(params.targetId, { username: identity.username, decisionId: body.decisionId });
    recordAudit(req, "exec-env.discard", { resourceType: "exec-env", resourceId: params.targetId, detail: { ...r, decisionId: body.decisionId } }).catch(() => {});
    return apiOk(r);
  } catch (e) {
    if (e instanceof DiscardRefused) return apiError(e.message, e.httpStatus, { code: e.code, ...(e.detail ? { detail: e.detail } : {}) });
    return apiError(`弃置失败:${String((e as Error)?.message ?? e).slice(0, 300)}`, 500, { code: "INTERNAL" });
  }
}
