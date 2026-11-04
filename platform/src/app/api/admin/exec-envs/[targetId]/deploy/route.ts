export const dynamic = "force-dynamic";
// POST /api/admin/exec-envs/[targetId]/deploy —— 触发部署(SPEC §2.1:响应 {buildId, lockEpoch})。
//
// 【平台侧刻意"什么都不做"的两件事,理由都在合同里】
// ① **不抢部署锁、不写状态**:锁与 `status→initializing` 都在 broker 内同一次条件写完成
//    (DESIGN:549 —— 锁若放调用方一侧,任何能直接 invoke broker 的人都能绕过它);
// ② **不透传除白名单参之外的任何东西**:broker 对未知字段是"拒"不是"忽略"(IR-P0-05)。
// 🔴 SPEC §2.1 v3.21:可选 `approvedPlanHash`(与 add-components 同形态)。
//   已启用 target 的「重新部署」= **升级**:源包一变即 `drift-unauthorized` 必须审批(§3.5c ④),而此前本路由
//   无法带审批 ⇒ 「重新部署」按钮在源漂移后根本走不通(开工勘出)。升级动线 = preview(同集)→ 看计划 → 本路由带 hash。
//   平台侧只是把批准递下去;要不要审批仍由 build 侧闸重算(纵深两道锁)。
import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { getTargetRaw } from "@/lib/exec-env/registry";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { invokeDeployBroker, brokerCodeToHttp } from "@/lib/exec-env/deploy-control";
import { incompleteEnvMessage, requiredComponentsForTarget } from "@/lib/exec-env/implemented-components";

export async function POST(req: NextRequest, props: { params: Promise<{ targetId: string }> }) {
  const params = await props.params;
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  if (!isValidTargetId(params.targetId)) {
    return apiError(`非法 targetId:${JSON.stringify(params.targetId)}`, 400, { code: "VALIDATION_FAILED" });
  }

  let body: Record<string, unknown> = {};
  try {
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return apiError("请求体不是合法 JSON", 400, { code: "VALIDATION_FAILED" });
  }

  try {
    const target = await getTargetRaw(params.targetId);
    if (!target) return apiError(`执行目标不存在:${params.targetId}`, 404, { code: "NOT_FOUND" });

    // 原「跨法域前置闸(403)」**已删**(DESIGN §18 决策 6quinquies:平台不设法务门)。
    //    跨法域 target 与同法域走同一条通道;它唯一的技术前置(装 residency-api + per-target 角色)由准入内核
    //    `residencyPrerequisite` 判,不在部署入口设门 —— 不装 residency-api 的跨法域 target 能部署、能探活,但 active 后**不承接**工作。

    // components:显式传则用之(broker 是校验权威);缺省用注册时的勾选集。
    const components = Array.isArray(body.components) ? (body.components as string[]) : (target.components ?? []);
    // ② —— 🔴🔴 不提供精简形态:下发集必须装齐完整组件集(显式传 components 也不能绕开)。
    //   不完整的存量环境 ⇒ 先〔补齐缺失组件〕(add-components),再重新部署。
    const requiredNow = requiredComponentsForTarget(target);
    const lackingNow = requiredNow.filter((c) => !(components as unknown[]).includes(c));
    if (lackingNow.length > 0) {
      return apiError(incompleteEnvMessage(lackingNow), 400, { code: "VALIDATION_FAILED" });
    }
    // approvedPlanHash:形态不对即 400(不是忽略 —— 忽略会让管理员以为批过了而 build 侧照样拒)
    const approvedPlanHashRaw = body.approvedPlanHash;
    let approvedPlanHash: string | undefined;
    if (approvedPlanHashRaw !== undefined) {
      if (typeof approvedPlanHashRaw !== "string" || !/^[a-f0-9]{64}$/.test(approvedPlanHashRaw)) {
        return apiError(
          `approvedPlanHash 形态非法(须 sha256 hex 64 位小写,取自预演裁决的 planHash):${JSON.stringify(approvedPlanHashRaw)}`,
          400,
          { code: "VALIDATION_FAILED" }
        );
      }
      approvedPlanHash = approvedPlanHashRaw;
    }
    // 🔴 operationId 服务端生成(op_ + 16 hex,匹配 broker 的 ^op_[a-z0-9]{8,32}$)——
    //    幂等/审计键不收客户端的:客户端可指定就可复用,复用会让审计里两次不同点击难以区分。
    const operationId = `op_${randomBytes(8).toString("hex")}`;

    const result = await invokeDeployBroker(params.targetId, components, operationId, {
      ...(approvedPlanHash ? { approvedPlanHash } : {}),
    });
    if (!result.ok) {
      recordAudit(req, "exec-env.deploy.rejected", {
        resourceType: "exec-env",
        resourceId: params.targetId,
        detail: { code: result.code, operationId },
      }).catch(() => {});
      return apiError(`部署被拒:${result.message}`, brokerCodeToHttp(result.code), {
        code: result.code === "locked" || result.code === "bad-status" ? "CONFLICT" : "UPSTREAM_ERROR",
        detail: { brokerCode: result.code },
      });
    }
    recordAudit(req, "exec-env.deploy", {
      resourceType: "exec-env",
      resourceId: params.targetId,
      detail: {
        buildId: result.buildId,
        operationId,
        components,
        lockEpoch: result.lockEpoch,
        // 审批留痕:批了哪一份计划(前 16 位足以对账,全量在预演审计里)
        ...(approvedPlanHash ? { approvedPlanHash: `${approvedPlanHash.slice(0, 16)}…` } : {}),
      },
    }).catch(() => {});
    return apiOk({ buildId: result.buildId, lockEpoch: result.lockEpoch, operationId });
  } catch (e: unknown) {
    // invoke 层故障(broker 不可达/契约漂移)= 上游错误,与 broker 的业务拒绝(上面)分开。
    return apiError(`触发部署失败:${String((e as Error)?.message ?? e)}`, 502, { code: "UPSTREAM_ERROR" });
  }
}
