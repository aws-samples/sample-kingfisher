export const dynamic = "force-dynamic";
// @kf-batch 50-P50.3b-2b-failure-recovery
// GET/POST /api/admin/exec-envs/[targetId]/recover —— 失败会话的**管理员恢复入口**
// (SPEC §3.5b;外部审核 §19.8 = 发布阻断项)。
//
// 【为什么必须有这个端点】在它之前,`observed.operation` + 顶层部署锁的**唯一**清除者是"成功完成 fence"⇒
//   build 失败 / CFN 回滚 / attach 丢响应 / startUncertain 超窗 / 进程崩在 open 之后,**全部**落进同一个洞:
//   target 永久"有锁 ⇒ 不承接新工作",唯一出路是手改 DDB(红线禁止)。⇒ 本端点 = 失败路径的唯一合法出口。
//
// 【本路由只做四件事】① auth ② 入参白名单 + **显式确认** ③ 调 `lib/exec-env/recovery.ts` ④ 审计 + HTTP 映射。
//   判定与执行(强读 → 分类 → 核 exact build 终态 → CFN 闸 → 唯一失败写入方)全在 lib ——
//   仓内不单测 Next route,判定放路由里就等于不可测;且 GET(页面渲染)与 POST(真恢复)必须共用同一份判据,
//   否则会出现"页面说可以恢复、接口却拒"。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { getTargetRaw } from "@/lib/exec-env/registry";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { describeRecoveryStatus, recoverFailedSession, RecoveryRefusedError } from "@/lib/exec-env/recovery";
import { FailureRecoveryError, LifecycleConflictError, LifecycleCommitUncertainError } from "@/lib/exec-env/lifecycle";

/** 客户端字段白名单(多一个就拒 —— 与 register/broker/add-components 同哲学:拒而不是忽略)。 */
const CLIENT_FIELDS = ["decisionId", "confirm", "expectedOperationId"];

/** 管理员决定 id:人可读、可检索、不可为空(进审计与 `observed.lastFailure`)。 */
const DECISION_ID_RE = /^[A-Za-z0-9_:-]{6,64}$/;

function mapError(error: unknown, prefix: string): NextResponse {
  if (error instanceof RecoveryRefusedError) {
    return apiError(`${prefix}${error.message}`, error.httpStatus, {
      code: error.code,
      ...(error.detail ? { detail: error.detail } : {}),
    });
  }
  if (error instanceof FailureRecoveryError) {
    return apiError(`恢复前置不满足:${error.message}`, 400, { code: "VALIDATION_FAILED" });
  }
  if (error instanceof LifecycleConflictError) {
    return apiError(`恢复被并发写入拒绝(未清锁):${error.message}`, 409, { code: "CONFLICT" });
  }
  if (error instanceof LifecycleCommitUncertainError) {
    return apiError(`恢复提交结果未知,请重新读取状态后再决定:${error.message}`, 502, { code: "UPSTREAM_ERROR" });
  }
  return apiError(`${prefix}${String((error as Error)?.message ?? error)}`, 502, { code: "UPSTREAM_ERROR" });
}

/** GET:只读描述"要不要恢复 / 现在能不能恢复 / 为什么不能"(页面横幅与按钮 disabled 态的唯一依据)。 */
export async function GET(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) {
    return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  }
  try {
    return apiOk(await describeRecoveryStatus(params.targetId));
  } catch (error: unknown) {
    return mapError(error, "读取恢复状态失败:");
  }
}

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
  const { decisionId, expectedOperationId } = body as { decisionId?: unknown; expectedOperationId?: unknown };
  // 🔴 显式确认是恢复的前提(审核 §19.8 ⑤:禁止静默自动恢复);expectedOperationId = "点名要清哪一次会话",
  //    期间若开了新 operation,fence 必失败 ⇒ 结构上不可能误清别人的会话。
  if (body.confirm !== true) {
    return apiError("必须显式确认(confirm=true):恢复会清除在途部署会话与部署锁,须管理员确认已核查基础设施", 400, {
      code: "VALIDATION_FAILED",
    });
  }
  if (typeof decisionId !== "string" || !DECISION_ID_RE.test(decisionId)) {
    return apiError(`decisionId 非法(需 6-64 位 [A-Za-z0-9_:-]):${JSON.stringify(decisionId)}`, 400, {
      code: "VALIDATION_FAILED",
    });
  }
  if (typeof expectedOperationId !== "string" || expectedOperationId.length === 0) {
    return apiError("必须给出 expectedOperationId(点名要恢复的那一次会话)", 400, { code: "VALIDATION_FAILED" });
  }

  try {
    const result = await recoverFailedSession(params.targetId, {
      decisionId,
      decidedBy: identity.username,
      expectedOperationId,
    });

    // 审计 before/after —— after 用强一致重读,不在 route 本地伪造。
    const after = await getTargetRaw(params.targetId);
    recordAudit(req, "exec-env.recover", {
      resourceType: "exec-env",
      resourceId: params.targetId,
      detail: {
        decisionId,
        mode: result.mode,
        kind: result.kind,
        buildStatus: result.buildStatus,
        stacks: result.disposition.stacks,
        checkedAt: result.disposition.checkedAt,
        before: result.before,
        after: {
          status: after?.status,
          ready: after?.ready,
          phase: (after?.observed as { phase?: string } | undefined)?.phase,
          health: (after?.observed as { health?: string } | undefined)?.health,
          lockCleared:
            after?.deployLockToken === undefined &&
            after?.deployLockExpiresAt === undefined &&
            after?.deployLockOperationId === undefined,
        },
      },
    }).catch(() => {});

    return apiOk({
      recovered: true,
      mode: result.mode,
      kind: result.kind,
      buildStatus: result.buildStatus,
      stacks: result.disposition.stacks,
      status: after?.status,
      ready: after?.ready === true,
      undeployedComponents: result.undeployedComponents,
      // 🔴 如实告知,不含糊:恢复只解开阻断;"能否重新承接工作"由下一次探活决定(≤4min 后周期 reconciler 会跑)。
      //    组件漂移必须点明 —— 恢复不跑 finalize,已声明但未落地的组件不会自动补齐(要再跑一次幂等部署)。
      note:
        (result.mode === "modern"
          ? "已记录失败并解除部署锁;health 已置 unknown(暂不承接新工作),下一次探活全绿后自动回到运行中"
          : "已解除存量残留部署锁;若该存量项本来就在服务(active/degraded 且 ready),下一次探活会按收养路重建双轴;" +
            "否则它会停在非可服务的存量态,直到你重新发起一次部署") +
        (result.undeployedComponents.length > 0
          ? `。⚠️ 这些组件已声明但尚未落地:${result.undeployedComponents.join("、")} —— 恢复不会补齐它们,` +
            "请重新发起一次部署(幂等)把它们装上"
          : ""),
    });
  } catch (error: unknown) {
    recordAudit(req, "exec-env.recover.rejected", {
      resourceType: "exec-env",
      resourceId: params.targetId,
      detail: {
        decisionId,
        expectedOperationId,
        reason: String((error as Error)?.message ?? error).slice(0, 500),
      },
    }).catch(() => {});
    return mapError(error, "恢复失败:");
  }
}
