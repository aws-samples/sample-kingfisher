export const dynamic = "force-dynamic";

// @kf-batch 50-WP20-retire-classic-mwaa
// POST /api/admin/exec-envs/[targetId]/retire-components —— **摘掉一个已经不在现网的组件**。
//
// 【为什么必须有这个端点(2026-09-14 真环境撞出来的缺口)】平台有「补充部署」(加组件)却没有反向动作。
//   用户拍板把经典 MWAA 从部署里去掉、`BgpMwaaStack` 删净之后,home 的描述符还写着 `mwaa`
//   ⇒ 周期 reconciler 探活发现它不在 ⇒ home 永久 `degraded`;而两条既有修复路径都拒它
//   (`adoptHomeComponents` 要 status=active 且明写「摘组件不是采纳」;`reconcileTarget` 要 ready=false)
//   ⇒ 唯一出路只剩手改 DDB,而那是红线。
//
// 【本路由只做四件事】① auth ② 入参白名单 + **输名强确认** ③ 先真探再交给 `retireComponents`(判定全在 lib)④ 审计 + HTTP 映射。
// 🔴 关键安全条件在 lib 里:**探活还绿着的组件一律拒摘** —— 摘掉一个活着的组件 = 把它从平台视野里藏起来。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { getTargetRaw, retireComponents, ComponentRetirementRefused, resourceKeysFreedByRetiring } from "@/lib/exec-env/registry";
import { runProbe } from "@/lib/exec-env/probe-runner";

const CLIENT_FIELDS = ["components", "confirm"];

export async function POST(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) {
    return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError("请求体不是合法 JSON", 400, { code: "VALIDATION_FAILED" });
  }
  const extra = Object.keys(body ?? {}).filter((k) => !CLIENT_FIELDS.includes(k));
  if (extra.length) {
    return apiError(`入参含不允许的字段:${extra.join(", ")}(只接 ${CLIENT_FIELDS.join(", ")})`, 400, { code: "VALIDATION_FAILED" });
  }
  const components = Array.isArray(body.components) ? body.components.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
  if (components.length === 0) return apiError("components 为空:没给要摘的组件", 400, { code: "VALIDATION_FAILED" });
  // 🔴 输名强确认(与「删除项目 / 强制重建」同一手法):摘组件会让平台停止认识那份能力
  if (body.confirm !== params.targetId) {
    return apiError(
      `这是一个会改变执行环境能力面的操作:请把 confirm 填成执行环境 id(${params.targetId})以确认`,
      400,
      { code: "VALIDATION_FAILED", detail: { reason: "confirm-required", willFreeResources: [] } }
    );
  }

  const before = await getTargetRaw(params.targetId);
  if (!before) return apiError(`注册表里没有 ${params.targetId}`, 404, { code: "NOT_FOUND" });

  // 🔴 **先真探**:摘除的合法性完全建立在「它真的不在了」这一条事实上,不能信调用方的说法
  let probe;
  try {
    probe = await runProbe(before);
  } catch (e) {
    return apiError(`摘除前真探失败,拒绝在不知道现状的情况下改描述符:${String((e as Error)?.message ?? e)}`, 502, { code: "UPSTREAM_ERROR" });
  }

  try {
    const out = await retireComponents({
      targetId: params.targetId,
      components,
      expectedVersion: Number(before.version),
      probe,
    });
    recordAudit(req, "exec-env.retire-components", {
      resourceType: "exec-env",
      resourceId: params.targetId,
      detail: { ...out, before: before.components },
    }).catch(() => {});
    return apiOk(out);
  } catch (e) {
    if (e instanceof ComponentRetirementRefused) {
      return apiError(`摘除被拒:${e.message}`, 409, {
        code: "CONFLICT",
        detail: { reason: "retire-refused", wouldFree: resourceKeysFreedByRetiring(before.components ?? [], components) },
      });
    }
    return apiError(`摘除组件失败:${String((e as Error)?.message ?? e)}`, 502, { code: "UPSTREAM_ERROR" });
  }
}
