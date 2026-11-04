export const dynamic = "force-dynamic";
// @kf-batch 50-WP9a-durable-jobs
// POST /api/admin/exec-envs/[targetId]/provisioning-deadline —— **延期** provisioning 窗口(50 SPEC §3.9b;WP-9 合同差分 ③-2)。
//
// 请求体:`{ extendDays: 1..30 | provisioningDeadlineAt: ISO, reason: string, expectedEpoch?: number }`
//
// 🔴 为什么必须有这个端点:非 home 一注册就进 provisioning + 30 天;到期后**没供给凭证的项目在该区数据面整体 fail-closed**
//    (`privileged-cred` 的硬拒)。§3.9b 写了「延期只能走受审计、带 epoch 的专用操作」,代码里却没有 ——
//    于是到期那天唯一的出路是手改 DDB(红线)。
// 🔴 三道约束(任何一道不满足都拒):
//   ① 当前必须是 provisioning(isolated 不需要、legacy-seeded 没有 deadline);
//   ② 新 deadline 必须**晚于**当前 deadline(这是延期,不是改期),且以**现在**为基准 ≤ 30 天(registry 的同一个校验口);
//   ③ 先写意图审计,写不进去就不延期(fail-closed-on-audit);成功即 epoch++(旧 canary 结果随之失效,须重跑)。
// 🔴 必须写理由:延期是「回落共享 admin 的窗口再开 N 天」,事后复盘要能看到当时为什么。
import { NextRequest, NextResponse } from "next/server";
import { ulid } from "ulid";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import {
  getTargetRaw,
  extendProvisioningDeadline,
  CredentialTransitionRejected,
  PROVISIONING_MAX_WINDOW_MS,
} from "@/lib/exec-env/registry";
import { requireCredentialIsolationState } from "@/lib/exec-env/privileged-cred";

const DAY_MS = 86_400_000;

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
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 4 || reason.length > 500) {
    return apiError("必须写明延期理由(4–500 字):延期等于把回落共享 admin 的窗口再开 N 天,复盘要看得到为什么", 400, {
      code: "VALIDATION_FAILED",
    });
  }

  const now = Date.now();
  let newDeadline: string;
  if (typeof body.provisioningDeadlineAt === "string" && body.provisioningDeadlineAt) {
    newDeadline = body.provisioningDeadlineAt;
  } else if (typeof body.extendDays === "number" && Number.isInteger(body.extendDays) && body.extendDays >= 1) {
    if (body.extendDays * DAY_MS > PROVISIONING_MAX_WINDOW_MS) {
      return apiError(`extendDays 不得超过 ${PROVISIONING_MAX_WINDOW_MS / DAY_MS} 天(§3.9b:很远的 deadline 与无期限没有区别)`, 400, {
        code: "VALIDATION_FAILED",
      });
    }
    newDeadline = new Date(now + body.extendDays * DAY_MS).toISOString();
  } else {
    return apiError("必须给 extendDays(1–30 的整数)或 provisioningDeadlineAt(ISO 时间)", 400, { code: "VALIDATION_FAILED" });
  }

  try {
    const t = await getTargetRaw(params.targetId);
    if (!t) return apiError(`执行目标不存在:${params.targetId}`, 404, { code: "NOT_FOUND" });
    const iso = requireCredentialIsolationState(t);
    if (iso.state !== "provisioning") {
      return apiError(`只有 provisioning 状态才有供给截止时间可延(当前 ${iso.state})`, 409, { code: "CONFLICT" });
    }
    if (body.expectedEpoch !== undefined && body.expectedEpoch !== iso.epoch) {
      return apiError(`凭证世代已变(页面看到的是 ${String(body.expectedEpoch)},当前 ${iso.epoch})⇒ 刷新后重试`, 409, { code: "CONFLICT" });
    }
    const curMs = Date.parse(iso.provisioningDeadlineAt ?? "");
    const newMs = Date.parse(newDeadline);
    if (Number.isFinite(curMs) && Number.isFinite(newMs) && newMs <= curMs) {
      return apiError(`新截止 ${newDeadline} 不晚于当前截止 ${iso.provisioningDeadlineAt} ⇒ 这不是延期`, 409, { code: "CONFLICT" });
    }
    const operationId = `extend-${ulid()}`;

    // 🔴 先写意图审计,写不进去就不延期
    try {
      await recordAudit(req, "exec-env.provisioning-deadline.extend.intent", {
        resourceType: "exec-env",
        resourceId: params.targetId,
        detail: {
          fromDeadline: iso.provisioningDeadlineAt ?? null,
          toDeadline: newDeadline,
          expectedEpoch: iso.epoch,
          reason,
          operationId,
        },
      });
    } catch (e) {
      return apiError(`审计写入失败 ⇒ 拒绝延期(一次没有审计记录的窗口延长,事后无法复盘):${(e as Error)?.message ?? String(e)}`, 503, {
        code: "UPSTREAM_ERROR",
      });
    }

    const r = await extendProvisioningDeadline(params.targetId, {
      expectedEpoch: iso.epoch,
      provisioningDeadlineAt: newDeadline,
      operationId,
    });

    await recordAudit(req, "exec-env.provisioning-deadline.extend.done", {
      resourceType: "exec-env",
      resourceId: params.targetId,
      detail: { toDeadline: newDeadline, newEpoch: r.newEpoch, operationId },
    }).catch(() => {});

    return apiOk({
      targetId: params.targetId,
      fromDeadline: iso.provisioningDeadlineAt ?? null,
      provisioningDeadlineAt: newDeadline,
      epoch: r.newEpoch,
      operationId,
    });
  } catch (e: unknown) {
    if (e instanceof CredentialTransitionRejected) return apiError((e as Error).message, 409, { code: "CONFLICT" });
    return apiError((e as Error)?.message ?? String(e), 500);
  }
}
