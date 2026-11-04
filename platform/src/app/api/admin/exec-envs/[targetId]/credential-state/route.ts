export const dynamic = "force-dynamic";
// @kf-batch 52-P52.5a-supply
// POST /api/admin/exec-envs/[targetId]/credential-state —— 推进凭证隔离状态(50 SPEC §3.9b)。
//
// 🔴 **为什么必须有这个端点**:§3.9b 的「唯一写通道」`advanceCredentialIsolationState()` 在 G 批就落地了,
// 但它**一个生产调用方都没有**(实测 `ast-count-callsites` = 0),而合同原文写着「调用方同样归 P52.5a」。
// 没有调用方 = 状态机永远停在初始态 = 隔离永远不收敛。本端点就是那个调用方。
//
// 🔴 **两条前进边、无逆向**:`legacy-seeded → provisioning → isolated`。本端点**不提供任何回退入口**
// (§3.9b:「不实现逆向 API;回滚应用代码不得回滚持久化状态」)。想回退只能重建 target。
//
// 🔴 **进 `isolated` 的前置由服务端硬校验,不信调用方的"我验过了"**:§3.9b 的前置格要求
// 「该 target 下全部在用项目均有 secret + canary 成功 + 旧 admin fallback 调用面已清零」。
// @kf-batch 50-WP9a-durable-jobs —— 🔴 canary 不再靠确认串:服务端**真跑**七条(permission-canary.ts),
//   前置改为 `evaluateIsolationPrereqs` 四项全满足:① 每个在用项目有 secret ② 最新 canary 全 pass ∧ epoch 一致 ∧ ≤24h
//   ③ 产物凭证扫描 = 0(扫描器归 WP-9b,之前一律 unavailable ⇒ 拒)④ 近 7 天 CredentialFallback = 0。
//   确认串保留作**具名承担**(谁按的这一下),但不再替代判据。
//
// 🔴 **审计 fail-closed**:状态迁移前先写「意图」审计,写不进去就**不迁移**(§3.9a 第 6 步同款纪律:
// 一次没有审计记录的权限边界变更,事后无法复盘"当时凭什么放行")。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import {
  getTargetRaw,
  advanceCredentialIsolationState,
  CredentialTransitionRejected,
  PROVISIONING_MAX_WINDOW_MS,
} from "@/lib/exec-env/registry";
import { requireCredentialIsolationState } from "@/lib/exec-env/privileged-cred";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { evaluateIsolationPrereqs, type IsolationPrereqVerdict } from "@/lib/exec-env/isolation-prereqs";

/** 进 `isolated` 必须带的显式确认串 —— 防"顺手点一下就切了稳态"。 */
const ISOLATE_CONFIRM = "我已完成 canary 与跨项目负测";

export async function POST(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) {
    return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return apiError("请求体必须是 JSON", 400, { code: "VALIDATION_FAILED" });
  }
  const toState = body.toState;
  if (toState !== "provisioning" && toState !== "isolated") {
    return apiError(
      `toState 只能是 provisioning 或 isolated(§3.9b 两条前进边);收到 ${JSON.stringify(toState)}。` +
        `本端点刻意不提供任何回退方向`,
      400,
      { code: "VALIDATION_FAILED" }
    );
  }

  try {
    const t = await getTargetRaw(params.targetId);
    if (!t) return apiError(`执行目标不存在:${params.targetId}`, 404, { code: "NOT_FOUND" });

    // 🔴 读当前状态用**同一个** fail-closed 读法(缺状态/未知即抛,不隐式当 legacy)。
    const iso = requireCredentialIsolationState(t);
    const fromState = iso.state;
    if (fromState === "isolated") {
      return apiError("已是 isolated(稳态,单调不可逆);无逆向 API", 409, { code: "CONFLICT" });
    }

    // ── 进 isolated 的前置:服务端硬校验(四项全满足才放行;确认串只作具名承担)──
    let prereq: IsolationPrereqVerdict | undefined;
    if (toState === "isolated") {
      if (body.confirm !== ISOLATE_CONFIRM) {
        return apiError(
          `进入 isolated 需显式确认(confirm 必须逐字等于「${ISOLATE_CONFIRM}」)。` +
            `确认串是操作者的具名承担;判据本身由服务端真跑(canary 七条 + 凭证存在性 + 产物扫描 + 回落指标)`,
          400,
          { code: "VALIDATION_FAILED" }
        );
      }
      prereq = await evaluateIsolationPrereqs(params.targetId, iso.epoch, Date.now());
      if (!prereq.ok) {
        // 🔴 一次把**全部**未满足项说清(点名项目),不让运维一项一项撞墙;查不到 ≠ 没问题,方向一律 fail-closed。
        const lines = prereq.failures.map((f) => {
          const named = (f.projects ?? []).slice(0, 10).map((p) => `${p.projectId}(${p.why})`).join("; ");
          return `[${f.key}] ${f.message}${named ? `:${named}` : ""}`;
        });
        return apiError(`进入 isolated 的前置未满足 ⇒ 拒绝:${lines.join(" | ")}`, 409, { code: "CONFLICT", detail: prereq });
      }
    }

    const now = Date.now();
    const deadline =
      toState === "provisioning"
        ? typeof body.provisioningDeadlineAt === "string" && body.provisioningDeadlineAt
          ? body.provisioningDeadlineAt
          : new Date(now + PROVISIONING_MAX_WINDOW_MS).toISOString()
        : undefined;

    // 🔴 先写「意图」审计,写不进去就不迁移(fail-closed-on-audit)。
    try {
      await recordAudit(req, "exec-env.credential-state.intent", {
        resourceType: "exec-env",
        resourceId: params.targetId,
        detail: {
          fromState,
          toState,
          expectedEpoch: iso.epoch,
          provisioningDeadlineAt: deadline,
          verifiedProjects: prereq?.projects?.length,
        },
      });
    } catch (e) {
      return apiError(
        `审计写入失败 ⇒ 拒绝迁移凭证状态(一次没有审计记录的权限边界变更,事后无法复盘"当时凭什么放行"):` +
          `${(e as Error)?.message ?? String(e)}`,
        503,
        // 审计表(DDB)是依赖 ⇒ 归 UPSTREAM_ERROR。刻意**不**新造一个 `AUDIT_FAILED` 码:
        // `ApiErrorCode` 是全平台前端在消费的封闭枚举,为一个端点加一个值会让所有 switch 漏分支。
        { code: "UPSTREAM_ERROR" }
      );
    }

    await advanceCredentialIsolationState(params.targetId, {
      fromState,
      toState,
      expectedEpoch: iso.epoch,
      operationId: typeof body.operationId === "string" ? body.operationId : undefined,
      provisioningDeadlineAt: deadline,
    });

    await recordAudit(req, "exec-env.credential-state.done", {
      resourceType: "exec-env",
      resourceId: params.targetId,
      detail: { fromState, toState, newEpoch: iso.epoch + 1, provisioningDeadlineAt: deadline },
    }).catch(() => {});

    return apiOk({
      targetId: params.targetId,
      fromState,
      toState,
      epoch: iso.epoch + 1,
      provisioningDeadlineAt: deadline,
      verifiedProjects: prereq?.projects?.length ?? null,
    });
  } catch (e: unknown) {
    if (e instanceof CredentialTransitionRejected) {
      return apiError((e as Error).message, 409, { code: "CONFLICT" });
    }
    return apiError((e as Error)?.message ?? String(e), 500);
  }
}
