export const dynamic = "force-dynamic";
// POST /api/admin/exec-envs/[targetId]/add-components —— 补充部署(SPEC §2.1 / §4.6)。
//
// 【与 deploy 的区别只有"入参组件集从哪来"】deploy 用注册表里已装的组件重跑;本端点让管理员
// 给出**最终想要的全集**,由 broker 拉起一次带新组件的部署。两者共用同一条部署通道
// (窄权 broker → CodeBuild),因此**deploy 有的闸这里一个都不能少**:
//   ① bgp-admin 守卫(网关 + 路由内双门);
//   ② 🔴 **跨法域前置闸** —— 少了它,add-components 就成了 deploy 那道 403 的绕行入口;
//   ③ operationId 服务端生成(它是部署锁 token 与审计键,客户端可指定 = 可预测可重放);
//   ④ 平台侧零状态写:注册表的 `components` **不在这里写** —— 由 finalizeTargetResources 在
//      真读到组件栈 Outputs 之后按 observed 语义回写(G 批 P1-1:资源存在前绝不声称)。
//
// 【只增不减】本端点拒绝"比现装组件更小的集合":减组件意味着要销毁有状态资源,那是删除流程
// (drain → 审批 → 销毁,§4.6)的地盘,绝不能靠"少传一个组件"顺手发生。
import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { getTargetRaw } from "@/lib/exec-env/registry";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import { invokeDeployBroker, brokerCodeToHttp } from "@/lib/exec-env/deploy-control";
import { planComponentAddition } from "@/lib/exec-env/implemented-components";

/**
 * 客户端字段白名单(多一个就拒 —— 与 register/broker 同哲学:拒而不是忽略)。
 * 🔴 P0-E(SPEC §3.5c ③):新增**可选** `approvedPlanHash` —— 管理员看过预演计划后带它来放行。
 *    平台侧只校**形态**并透传;"这次到底要不要审批"由 **build 侧重算**决定(平台可能被绕)。
 *    ⇒ 带了假 hash 不会放行(build 侧比对不上即失败),不带而计划需审批同样会被 build 拒。
 */
const CLIENT_FIELDS = ["components", "approvedPlanHash"];
/** sha256 hex 64 位**小写**(canonical);与 broker `validate.mjs` 的 PLAN_HASH_RE 逐字一致。 */
const PLAN_HASH_RE = /^[a-f0-9]{64}$/;

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
    return apiError(
      `入参含不允许的字段:${extra.join(", ")}(只接 ${CLIENT_FIELDS.join(", ")};` +
        `operationId 由服务端生成 —— 它是部署锁 token 与审计键)`,
      400,
      { code: "VALIDATION_FAILED" }
    );
  }

  try {
    const target = await getTargetRaw(params.targetId);
    if (!target) return apiError(`执行目标不存在:${params.targetId}`, 404, { code: "NOT_FOUND" });

    // 原「跨法域前置闸(403)」**已删**(DESIGN §18 决策 6quinquies:平台不设法务门)。
    //    跨法域 target 与同法域走同一条通道;它唯一的技术前置(装 residency-api + per-target 角色)由准入内核
    //    `residencyPrerequisite` 判,不在部署入口设门 —— 不装 residency-api 的跨法域 target 能部署、能探活,但 active 后**不承接**工作。

    // 组件集判定全部走纯函数(形状 / 必含 core / 只许已实现 / 只增不减 / 必须真有新增),
    // 判定逻辑**只此一份**,由 implemented-components.test.ts 无头真执行(仓内不单测 Next route)。
    const installed = Array.isArray(target.components) ? (target.components as string[]) : [];
    const plan = planComponentAddition(installed, (body as { components?: unknown }).components, target);
    if (!plan.ok) return apiError(plan.message, 400, { code: "VALIDATION_FAILED" });
    const { wanted, added } = plan;

    // 🔴 P0-E:审批指纹形态校验(大写 hex / 长度不对 / 空串一律拒;broker 那侧也会再校一次)
    const approvedPlanHashRaw = (body as { approvedPlanHash?: unknown }).approvedPlanHash;
    let approvedPlanHash: string | undefined;
    if (approvedPlanHashRaw !== undefined) {
      if (typeof approvedPlanHashRaw !== "string" || !PLAN_HASH_RE.test(approvedPlanHashRaw)) {
        return apiError(
          `approvedPlanHash 形态非法(须 sha256 hex 64 位小写,取自预演裁决的 planHash):${JSON.stringify(approvedPlanHashRaw)}`,
          400,
          { code: "VALIDATION_FAILED" }
        );
      }
      approvedPlanHash = approvedPlanHashRaw;
    }

    // operationId 服务端生成(op_ + 16 hex,匹配 broker 的 ^op_[a-z0-9]{8,32}$)
    const operationId = `op_${randomBytes(8).toString("hex")}`;
    const result = await invokeDeployBroker(params.targetId, wanted, operationId, {
      ...(approvedPlanHash ? { approvedPlanHash } : {}),
    });
    if (!result.ok) {
      recordAudit(req, "exec-env.add-components.rejected", {
        resourceType: "exec-env",
        resourceId: params.targetId,
        detail: { code: result.code, operationId, wanted, added },
      }).catch(() => {});
      return apiError(`补充部署被拒:${result.message}`, brokerCodeToHttp(result.code), {
        code: result.code === "locked" || result.code === "bad-status" ? "CONFLICT" : "UPSTREAM_ERROR",
        detail: { brokerCode: result.code },
      });
    }
    recordAudit(req, "exec-env.add-components", {
      resourceType: "exec-env",
      resourceId: params.targetId,
      detail: {
        buildId: result.buildId,
        operationId,
        added,
        components: wanted,
        lockEpoch: result.lockEpoch,
        // 审批留痕:批了哪一份计划(planHash 前 16 位足以对账,全量在预演审计里)
        ...(approvedPlanHash ? { approvedPlanHash: `${approvedPlanHash.slice(0, 16)}…` } : {}),
      },
    }).catch(() => {});
    return apiOk({ buildId: result.buildId, lockEpoch: result.lockEpoch, operationId, added, components: wanted });
  } catch (e: unknown) {
    // invoke 层故障(broker 不可达/契约漂移)= 上游错误,与 broker 的业务拒绝(上面)分开。
    return apiError(`触发补充部署失败:${String((e as Error)?.message ?? e)}`, 502, { code: "UPSTREAM_ERROR" });
  }
}
