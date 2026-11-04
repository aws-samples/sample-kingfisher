export const dynamic = "force-dynamic";
// @kf-batch 50-P50.3b-lifecycle-rootfix
// POST /api/admin/exec-envs/[targetId]/enable —— 启用(SPEC:37 状态机 verifying→ready;INTERACTION §1.3「全绿 → 启用」)。
//
// 🔴 v3.15(§21.4.1):**同一次 POST 内**真探 → 写 raw probe(不涨 version)→ 强读校验未变 → 构造
//   `EnableLifecycleFence` → `enableTarget`。绝不读任意历史 `probe.ok`(否则绕过 exact coverage/desired===observed)。
//   route 的 early check 只为好错误;真正裁决是 `enableTarget` 里 transitionPhase 的 enableFence 条件写。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import {
  getTargetRaw,
  enableTarget,
  writeProbeResult,
  probeInputOf,
  sameProbeInput,
  LifecyclePreconditionError,
} from "@/lib/exec-env/registry";
import { specObservedOf, LifecycleConflictError, type EnableLifecycleFence } from "@/lib/exec-env/lifecycle";
import { runProbe } from "@/lib/exec-env/probe-runner";
import { isValidTargetId } from "@/lib/exec-env/target-id";

export async function POST(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) {
    return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  }
  try {
    const initial = await getTargetRaw(params.targetId);
    if (!initial) return apiError(`执行目标不存在:${params.targetId}`, 404, { code: "NOT_FOUND" });
    if (!Number.isInteger(initial.version)) {
      return apiError("target 缺整数 version(不是 register 通道落的)", 409, { code: "CONFLICT" });
    }
    const { spec, observed } = specObservedOf(initial);
    if (observed.phase !== "verifying" || observed.operation) {
      return apiError("只有无 operation 的 verifying target 可 enable", 409, { code: "CONFLICT" });
    }
    const probeInput = probeInputOf(initial);
    const probe = await runProbe(initial); // 本次请求 fresh 真探
    await writeProbeResult(params.targetId, probe); // full canonical raw probe;不涨 version
    const candidate = await getTargetRaw(params.targetId);
    if (!candidate || candidate.version !== initial.version || !sameProbeInput(candidate, probeInput)) {
      return apiError("enable probe 期间 target 已变化", 409, { code: "CONFLICT" });
    }
    const fence: EnableLifecycleFence = {
      expectedVersion: initial.version as number,
      fromPhase: "verifying",
      probeAt: probe.at,
      probe,
      desiredComponents: [...spec.desiredComponents],
      observedComponents: [...observed.components],
      probeInput,
    };
    await enableTarget(params.targetId, { fence });
    recordAudit(req, "exec-env.enable", { resourceType: "exec-env", resourceId: params.targetId }).catch(() => {});
    return apiOk({ targetId: params.targetId, status: "active" });
  } catch (e: unknown) {
    if (e instanceof LifecyclePreconditionError || e instanceof LifecycleConflictError) {
      // 前置不满足 / 读到写之间被并发改(探活变红/状态迁移/version 变):明确 409,让调用方刷新后重试。
      return apiError(e.message, 409, { code: "CONFLICT" });
    }
    return apiError(`启用失败:${String((e as Error)?.message ?? e)}`, 502, { code: "UPSTREAM_ERROR" });
  }
}
