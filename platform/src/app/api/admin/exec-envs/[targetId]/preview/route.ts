export const dynamic = "force-dynamic";
// @kf-batch 50-P50.3b-3-p0e-baseline
// POST/GET /api/admin/exec-envs/[targetId]/preview —— P0-E 的**先看后批再做**第一阶段(SPEC §3.5c ①③)。
//
// 【它买到什么】把"这次补组件到底会改什么"从**猜**变成**看**:走同一条部署通道(窄权 broker → CodeBuild),
//   但带 `mode=preview` ⇒ build 只做 changeset 预演 + 出裁决,**不执行任何变更**、不开 operation、不上锁。
//   管理员看到逐条计划与 `planHash` 后,才决定要不要带这个 hash 去真部署。
//
// 【为什么裁决从构建日志取】buildspec **不许**写注册表(synth-gate 负向断言钉死:出现 `update-item` 即红)。
//   CodeBuild 里算出的裁决只能单向传回:build 打印带标记的一行,平台读日志取它。
//   🔴 平台拿到的是"**上游声称**的裁决",只用于**呈现**与填 `operation.disruptive`;
//      真正的闸在 build 里**重算**(不信任何递进来的结论)—— 平台这一侧被绕也毁不了数据。
//
// 【与 deploy/add-components 同款的闸,一个不少】① bgp-admin 双门 ② 🔴 跨法域前置闸(否则本端点成绕行入口)
//   ③ operationId 服务端生成 ④ 平台侧零状态写(预演本来就不该写任何东西)。
import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { getTargetRaw } from "@/lib/exec-env/registry";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import {
  invokeDeployBroker,
  brokerCodeToHttp,
  fetchImpactVerdict,
  readExactBuildPhase,
  BUILD_NOT_FOUND,
} from "@/lib/exec-env/deploy-control";
import { planComponentAddition } from "@/lib/exec-env/implemented-components";
import { summarizeImpact, type BaselineDrift } from "@/lib/exec-env/deploy-impact";

/** 客户端字段白名单(多一个就拒)。`components` = 想要的**最终全集**,与 add-components 同语义。 */
const CLIENT_FIELDS = ["components"];

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

  try {
    const target = await getTargetRaw(params.targetId);
    if (!target) return apiError(`执行目标不存在:${params.targetId}`, 404, { code: "NOT_FOUND" });

    // @kf-batch 50-W5-seg1-WP10a —— 原「跨法域前置闸(403)」**已删**(DESIGN §18 决策 6quinquies:平台不设法务门)。
    //    跨法域 target 与同法域走同一条通道;它唯一的技术前置(装 residency-api + per-target 角色)由准入内核
    //    `residencyPrerequisite` 判,不在部署入口设门 —— 不装 residency-api 的跨法域 target 能部署、能探活,但 active 后**不承接**工作。

    const installed = Array.isArray(target.components) ? (target.components as string[]) : [];
    // 🔴 WP-3(SPEC §2.1 v3.21):同集 = **升级预演**(`added=[]`)—— 已启用 target 的「重新部署」先走这里看计划
    //    (源包一变即 drift-unauthorized 需审批;没有这条,重新部署在 p0e-gate 必挂)。
    const plan = planComponentAddition(
      installed,
      (body as { components?: unknown }).components,
      target,
      { allowNoAddition: true }
    );
    if (!plan.ok) return apiError(plan.message, 400, { code: "VALIDATION_FAILED" });

    const operationId = `op_${randomBytes(8).toString("hex")}`;
    const result = await invokeDeployBroker(params.targetId, plan.wanted, operationId, { mode: "preview" });
    if (!result.ok) {
      recordAudit(req, "exec-env.preview.rejected", {
        resourceType: "exec-env",
        resourceId: params.targetId,
        detail: { code: result.code, operationId, wanted: plan.wanted },
      }).catch(() => {});
      return apiError(`预演被拒:${result.message}`, brokerCodeToHttp(result.code), {
        code: result.code === "locked" ? "CONFLICT" : "UPSTREAM_ERROR",
        detail: { brokerCode: result.code },
      });
    }
    recordAudit(req, "exec-env.preview", {
      resourceType: "exec-env",
      resourceId: params.targetId,
      detail: { buildId: result.buildId, operationId, components: plan.wanted, added: plan.added },
    }).catch(() => {});
    return apiOk({
      buildId: result.buildId,
      operationId,
      components: plan.wanted,
      added: plan.added,
      mode: "preview",
    });
  } catch (e: unknown) {
    return apiError(`触发预演失败:${String((e as Error)?.message ?? e)}`, 502, { code: "UPSTREAM_ERROR" });
  }
}

/**
 * GET ?buildId=… —— 取预演裁决。
 * 🔴 三种回法要分清(**绝不把"还没拿到"说成"没有影响"**):
 *   · build 还在跑 / 裁决行还没打印 ⇒ `{state:"pending"}`;
 *   · build 已结束但取不到裁决(日志权限、闸自己炸了)⇒ `{state:"unavailable"}` —— 调用方按 fail-closed 处理;
 *   · 拿到 ⇒ `{state:"ready", verdict, summary}`。
 */
export async function GET(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) {
    return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  }
  const buildId = req.nextUrl.searchParams.get("buildId") ?? "";
  // 形状校验:CodeBuild buildId 形如 `project:uuid`;不校验就等于把任意串喂给 BatchGetBuilds
  if (!/^[A-Za-z0-9_-]{1,128}:[0-9a-f-]{8,64}$/.test(buildId)) {
    return apiError("缺少或非法 buildId(形如 bgp-exec-env-deploy:<uuid>)", 400, { code: "VALIDATION_FAILED" });
  }
  try {
    const verdict = await fetchImpactVerdict(buildId);
    if (verdict) {
      // 🔴 裁决里的 target 必须与路径一致 —— 否则就是拿 A 的预演结果去给 B 放行
      if (verdict.target !== params.targetId) {
        return apiError(
          `裁决属于另一个 target(${verdict.target} ≠ ${params.targetId})—— 拒绝跨 target 复用预演结果`,
          409,
          { code: "CONFLICT" }
        );
      }
      return apiOk({
        state: "ready",
        verdict,
        summary: summarizeImpact({
          disruptive: verdict.disruptive,
          requiresApproval: verdict.requiresApproval,
          planHash: verdict.planHash,
          reasons: verdict.reasons,
          changeCount: verdict.changeCount,
          stackCount: verdict.stackCount,
          // 🔴 裁决没带基线判定(上游是旧版闸)⇒ 按最严当"看不清源身份"呈现,绝不当"无影响"
          baseline: (verdict.baseline as BaselineDrift | undefined) ?? {
            state: "unknown-source",
            disruptive: true,
            requiresApproval: true,
            why: "裁决未带基线判定(build 侧闸是旧版?)—— 按看不清处理",
          },
        }),
      });
    }
    // 还没拿到裁决 ⇒ 看 build 到底是"还在跑"还是"跑完了但没裁决"。
    // 🔴 `readExactBuildPhase` 是**窄**函数(只查这一个 build 的确切 phase),与 2b 恢复闸同一个:
    //    绝不用进度页那种"失败降级成 UNKNOWN"的读法 —— 这里分不清 pending 与 unavailable 就会误导管理员。
    const phase = await readExactBuildPhase(buildId);
    const running = phase === "IN_PROGRESS" || phase === "QUEUED";
    return apiOk({
      state: running ? "pending" : "unavailable",
      buildPhase: phase,
      ...(phase === BUILD_NOT_FOUND
        ? { hint: "CodeBuild 已无该 build 记录(超出保留期或 buildId 有误)⇒ 重新发起一次预演" }
        : {}),
    });
  } catch (e: unknown) {
    return apiError(`取预演裁决失败:${String((e as Error)?.message ?? e)}`, 502, { code: "UPSTREAM_ERROR" });
  }
}
