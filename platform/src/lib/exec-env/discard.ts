// @kf-batch 50-WP30-discard
// WP-30 路 A「弃置」:把一个**从没装出来**的执行环境退役(→ gone,tombstone 保留审计),释放该区「一区一套」名额。
//
// 🔴 为什么要有它(2026-10-01 新账号第一章 `w5a` 真撞):在 ap-northeast-1 注册一次性 T3 ⇒ 部署失败(B-29)⇒
//   描述符卡在 provisioning(+ 一个已终态失败、没人收口的部署会话),目标区**没有任何资源** ⇒ 平台里没有任何合法出口
//   把它清掉;判据只能直改 DDB(绕过产品守卫 —— 用户明令禁止)。
// 🔴 判据按**事实**分流,不按状态名:「从没 ready ∧ 无资源袋 ∧ 目标区无本 slug 栈」才是弃置的前提;
//   装过的环境走路 B(drain → 审批 → 销毁),这里一律 409 指向它。
// 🔴 本文件**不发明任何写法**:失败会话收口复用 `recoverFailedSession`(全仓唯一失败写入方),
//   栈存在性复用 `describeStackDisposition`(与恢复 / 进度页同一作者),退役复用 `transitionPhase` + `DiscardFence`。
import { getTargetRaw, type ExecutionTarget } from "@/lib/exec-env/registry";
import { isHome } from "@/lib/exec-env/target-id";
import { specObservedOf, transitionPhase, type TargetPhase } from "@/lib/exec-env/lifecycle";
import { describeStackDisposition } from "@/lib/exec-env/deploy-control";
import { assessRecovery, recoverFailedSession } from "@/lib/exec-env/recovery";

export class DiscardRefused extends Error {
  constructor(message: string, readonly httpStatus: 403 | 404 | 409, readonly code: "RBAC_DENIED" | "NOT_FOUND" | "CONFLICT", readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = "DiscardRefused";
  }
}

const GO_ROUTE_B = "装过的环境要走「申请删除」(先停止承接 → 影响预览 → 审批 → 销毁),不能直接弃置";

export interface DiscardResult {
  targetId: string;
  region: string;
  before: { phase: string; status: string; operation?: string };
  /** 弃置前顺带收口了一个已终态失败的部署会话(复用唯一失败写入方) */
  recoveredOperationId?: string;
  noStacksVerifiedAt: string;
}

function refuseIfNotDiscardable(t: ExecutionTarget): { phase: TargetPhase } {
  if (isHome(t.targetId)) throw new DiscardRefused("主控区执行环境永不可删(它是控制面自己的执行环境)", 403, "RBAC_DENIED");
  const { observed } = specObservedOf(t);
  if (observed.phase === "gone") throw new DiscardRefused(`${t.targetId} 已经是已删除状态`, 409, "CONFLICT");
  if (observed.phase !== "registered" && observed.phase !== "provisioning") {
    throw new DiscardRefused(`${t.targetId} 当前阶段是 ${observed.phase}(装出来过或正在验收)—— ${GO_ROUTE_B}`, 409, "CONFLICT", { phase: observed.phase });
  }
  if ((t as { ready?: unknown }).ready === true) throw new DiscardRefused(`${t.targetId} 曾整包就绪过 —— ${GO_ROUTE_B}`, 409, "CONFLICT");
  const res = (t as { resources?: unknown }).resources;
  if (res && typeof res === "object" && Object.keys(res as object).length > 0) {
    throw new DiscardRefused(`${t.targetId} 已回写过资源清单(说明目标区建出过东西)—— ${GO_ROUTE_B}`, 409, "CONFLICT");
  }
  return { phase: observed.phase };
}

export async function discardTarget(targetId: string, actor: { username: string; decisionId: string }): Promise<DiscardResult> {
  let t = await getTargetRaw(targetId);
  if (!t) throw new DiscardRefused(`执行目标不存在:${targetId}`, 404, "NOT_FOUND");
  refuseIfNotDiscardable(t);
  const before = { phase: specObservedOf(t).observed.phase, status: String(t.status), operation: specObservedOf(t).observed.operation?.operationId };

  // ① 资源事实**先查**(在任何写之前):目标区不许有本 slug 的任何栈(含失败 / 回滚态);查不清也拒(fail-closed)。
  //    🔴 放在收口会话之前:被拒的请求**一个字都不许写**(先收口再发现有栈 = 拒了却改了描述符)
  const disp = await describeStackDisposition(t);
  if (disp.stacks.length > 0 || disp.blockers.length > 0) {
    throw new DiscardRefused(
      `目标区 ${t.region} 里还有这个环境的栈(${disp.stacks.map((s) => `${s.name}[${s.status}]`).join(", ") || "—"})` +
        `${disp.blockers.length ? `或查不清(${disp.blockers.join(";")})` : ""} —— ${GO_ROUTE_B}`,
      409, "CONFLICT", { stacks: disp.stacks, blockers: disp.blockers }
    );
  }

  // ② 有未收口的部署会话:只有它**已终态失败且可恢复**才顺带收口(唯一失败写入方);在途 / 看不清 ⇒ 拒
  let recoveredOperationId: string | undefined;
  const op = specObservedOf(t).observed.operation;
  if (op) {
    const a = await assessRecovery(t, op.operationId);
    if (a.state !== "ready") {
      throw new DiscardRefused(
        `部署会话 ${op.operationId} 还没收口:${a.reason} —— 等它结束(或按页面提示恢复)后再弃置`, 409, "CONFLICT",
        { operationId: op.operationId, recovery: a.state }
      );
    }
    await recoverFailedSession(targetId, { decisionId: actor.decisionId, decidedBy: actor.username, expectedOperationId: op.operationId });
    recoveredOperationId = op.operationId;
    t = await getTargetRaw(targetId);
    if (!t) throw new DiscardRefused(`执行目标不存在:${targetId}`, 404, "NOT_FOUND");
    refuseIfNotDiscardable(t);
  }

  // ③ 退役:同一次条件写钉「无 operation / 无锁 / 从没 ready / 无资源袋」
  const { spec, observed } = specObservedOf(t);
  const from = observed.phase as "registered" | "provisioning";
  // 🔴 operation 必须**删键**而不是置 undefined(DDB 序列化遇 undefined 直接抛;post-image 也不许带它)
  const { operation: _dropped, ...observedNoOp } = observed;
  void _dropped;
  await transitionPhase(targetId, {
    from,
    expectedVersion: Number(t.version),
    post: { spec: { ...spec, intent: "delete" }, observed: { ...observedNoOp, phase: "gone" } },
    discardFence: { expectedVersion: Number(t.version), fromPhase: from, noStacksVerifiedAt: disp.checkedAt },
    reason: `discard by ${actor.username}(WP-30 路 A:从没装出来、目标区无本环境的栈)`,
  });
  return { targetId, region: t.region, before, recoveredOperationId, noStacksVerifiedAt: disp.checkedAt };
}
