export const dynamic = "force-dynamic";
// POST /api/admin/exec-envs/[targetId]/probe —— 探活 + 生命周期完成(DESIGN §4.1 step4 / INTERACTION §1.3)。
//
// 🔴 v3.15/-2a:完成序的**实现**已抽到 `lib/exec-env/reconcile.ts#reconcileOneTarget`(SSOT
//   人点「检测初始化」与**周期 reconciler**调同一个它,去掉"人点按钮"即得周期驱动)。本路由只做四件:
//   ① auth(requireExecEnvAdmin)② 调 reconcileOneTarget ③ 审计 ④ HTTP 映射。
//   完成序细节(初读核 exact build → finalize → 强读 candidate → 捕获 evidence → runProbe → 写 raw probe →
//   reconcileAfterProbe → 稳态 telemetry)见 reconcile.ts;LifecycleConflictError 已在其内转为
//   outcome.reconcileConflict(structured 200);ReconcileTargetNotFoundError → 404;其它异常 → 502。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { reconcileOneTarget, ReconcileTargetNotFoundError } from "@/lib/exec-env/reconcile";
import { isValidTargetId } from "@/lib/exec-env/target-id";
// 控制面未放行该 region 时把真因写进 finalizeError(页面渲染它)
import { getTargetRaw } from "@/lib/exec-env/registry";
import { isControlPlaneRegionEnabled, regionNotEnabledHint } from "@/lib/exec-env/control-plane-regions";

export async function POST(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) {
    return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  }

  try {
    // 退役中 / 已删除的环境不探活(没有要服务的资源;销毁进度走 destroy-observe)
    const pre = await getTargetRaw(params.targetId);
    const prePhase = (pre?.observed as { phase?: string } | undefined)?.phase;
    if (prePhase === "decommissioning" || prePhase === "gone") {
      return apiError(
        prePhase === "gone" ? "该执行环境已删除,不再探活" : "该执行环境正在销毁 / 销毁卡住 —— 进度与卡住原因看「销毁进度」(destroy-observe),不做探活",
        409,
        { code: "CONFLICT" }
      );
    }
    const outcome = await reconcileOneTarget(params.targetId);
    // 🔴 finalize 失败 + 该 region 未被控制面放行 ⇒ 真因是 IAM 区域条件,不是「描述符缺资源」。把人话 + 运维命令放到 finalizeError
    //    最前面(原始错误保留在后,便于排障);`regionEnabled` 单独给前端做 Alert。
    const t = await getTargetRaw(params.targetId);
    const regionEnabled = t ? isControlPlaneRegionEnabled(t.region) : true;
    const finalizeError =
      outcome.finalizeError && t && !regionEnabled
        ? `${regionNotEnabledHint(t.region)} —— 原始错误:${outcome.finalizeError}`
        : outcome.finalizeError;

    recordAudit(req, "exec-env.probe", {
      resourceType: "exec-env",
      resourceId: params.targetId,
      detail: {
        ok: outcome.probe.ok,
        items: outcome.probe.items.length,
        finalized: outcome.finalized,
        evidenceKind: outcome.evidenceKind,
        reconcileAdvanced: outcome.reconcile?.advanced === true,
        telemetryWritten: outcome.telemetry?.written === true,
        status: outcome.status,
        ready: outcome.ready,
      },
    }).catch(() => {});

    // 🔴 响应只信 reconcileOneTarget 的最终强一致重读,不在 route 本地伪造 ready/status。
    return apiOk({
      probe: outcome.probe,
      finalized: outcome.finalized,
      ready: outcome.ready,
      status: outcome.status,
      ...(outcome.reconcile ? { reconcile: outcome.reconcile } : {}),
      regionEnabled,
      ...(finalizeError ? { finalizeError } : {}),
      ...(outcome.reconcileConflict
        ? { reconcileError: { code: "LIFECYCLE_CONFLICT", message: outcome.reconcileConflict } }
        : {}),
    });
  } catch (error: unknown) {
    if (error instanceof ReconcileTargetNotFoundError) {
      return apiError(`执行目标不存在:${params.targetId}`, 404, { code: "NOT_FOUND" });
    }
    return apiError(`探活失败:${String((error as Error)?.message ?? error)}`, 502, { code: "UPSTREAM_ERROR" });
  }
}
