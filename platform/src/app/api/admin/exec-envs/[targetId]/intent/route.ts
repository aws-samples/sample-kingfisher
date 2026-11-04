export const dynamic = "force-dynamic";
// POST /api/admin/exec-envs/[targetId]/intent —— 排空 / 回服务(SPEC §1.1 双轴:spec 由人写)。
//
// 【它买到什么】排空(drain)= "这个 target 不再承接**新**工作,在途的让它跑完"。运维在维护、腾挪、
//   或准备退役前需要这个动作;没有它,运维只能去改状态字段或干脆不排空(后者更危险)。
//   准入判定读 `serviceabilityReason(spec, observed)`,`intent ≠ serve` **立刻**判不可用
//   ⇒ 停接新活是**同步生效**的,不必等 reconciler 把 phase 改成 draining(phase 是观测态,归控制器)。
//
// 🔴 三条闸(缺一条都会变成"看起来能点其实有害"):
//   ① **只允许 serve / drain** —— `delete` 会把 phase 推向 decommissioning/gone,而**真销毁栈**是 §4.6
//      (影响预览 → 输名强确认 → 审批 → 销毁;数据桶 RETAIN)、。放开它就会造出
//      "标成已退役而资源全在"的 tombstone 谎,比不做更糟;
//   ② 🔴 **home 不许排空** —— home 是控制面自己的执行环境,排空它 = 平台自断双腿(自我 DoS)。
//      与"home 不显示删除入口"同一条口径;
//   ③ **在途部署会话期间一律拒**(在 `setSpecIntent` 里同时做内存检查与条件写):完成栅栏断言
//      `post.spec.intent === "serve"`,部署途中改 intent 会让那次部署**永远完不成**、滞留成需 2b 人工恢复的会话。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { getTargetRaw } from "@/lib/exec-env/registry";
import { isHome, isValidTargetId } from "@/lib/exec-env/target-id";
import { setSpecIntent, PhaseTransitionError } from "@/lib/exec-env/lifecycle";

/** 客户端字段白名单(多一个就拒;`expectedVersion` 由服务端自读 —— 客户端给版本号等于把乐观锁交给它)。 */
const CLIENT_FIELDS = ["intent"];

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
  if (extra.length > 0) {
    return apiError(`入参含不允许的字段:${extra.join(", ")}(只接 ${CLIENT_FIELDS.join(", ")})`, 400, {
      code: "VALIDATION_FAILED",
    });
  }
  const intent = (body as { intent?: unknown }).intent;
  if (intent !== "serve" && intent !== "drain") {
    return apiError(
      `intent 只允许 "serve"(回服务)或 "drain"(排空);收到 ${JSON.stringify(intent)}。` +
        `退役/删除必须走 §4.6 删除流程(影响预览 → 输名强确认 → 审批 → 销毁;数据桶 RETAIN),不能只改标记`,
      400,
      { code: "VALIDATION_FAILED" }
    );
  }

  // 🔴 home 不许排空(自我 DoS);放在读描述符之前判,连"存不存在"都不必泄露给这条路径
  if (isHome(params.targetId) && intent === "drain") {
    return apiError(
      "home 执行环境不允许排空 —— 它是控制面自己的执行环境,排空它等于平台自断双腿(与「home 不显示删除入口」同一口径)",
      403,
      { code: "RBAC_DENIED" }
    );
  }

  try {
    const target = await getTargetRaw(params.targetId);
    if (!target) return apiError(`执行目标不存在:${params.targetId}`, 404, { code: "NOT_FOUND" });
    if (!Number.isInteger(target.version)) {
      return apiError("描述符缺 version,无法做乐观锁写入(数据坏了,不是调用方的错)", 500, { code: "INTERNAL" });
    }

    const before = { intent: target.spec?.intent ?? "(legacy 无 spec)", status: target.status, phase: target.observed?.phase };
    const r = await setSpecIntent(params.targetId, intent, { expectedVersion: target.version as number });
    const after = await getTargetRaw(params.targetId);
    recordAudit(req, intent === "drain" ? "exec-env.drain" : "exec-env.serve", {
      resourceType: "exec-env",
      resourceId: params.targetId,
      detail: { before, after: { intent, status: after?.status, phase: after?.observed?.phase } },
    }).catch(() => {});
    return apiOk({
      targetId: params.targetId,
      intent,
      // phase 由 reconciler 在下一 tick 驱动(ready→draining / draining→ready 需全绿探活)—— 如实告知
      phase: after?.observed?.phase ?? r.phaseHint,
      status: after?.status,
      note:
        intent === "drain"
          ? "已停止承接新工作(同步生效);phase 将在下一次探活周期内变为 draining"
          : "已恢复承接意图;phase 需下一次**全绿探活**才回到 ready(不是翻个标记就算好)",
    });
  } catch (e: unknown) {
    if (e instanceof PhaseTransitionError) {
      return apiError(e.message, 409, { code: "CONFLICT" });
    }
    return apiError(`设置 intent 失败:${String((e as Error)?.message ?? e)}`, 500, { code: "INTERNAL" });
  }
}
