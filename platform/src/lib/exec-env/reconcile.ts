// @kf-batch 50-P50.3b-2a-reconciler
// 执行环境【单 target 调和】—— probe 路由(人点「检测初始化」)与周期 reconciler 的【唯一共享实现】(SSOT)。
//
// 【为什么抽出来】v3.15 §22 的完成序(初读核 exact build → finalize → 强读 candidate → 捕获 evidence →
//   runProbe → 写 raw probe → reconcileAfterProbe → 稳态 telemetry)以前只活在 admin probe 路由 POST 里,
//   靠"人点按钮"驱动。P50.3b-2a 的周期 reconciler 要对 listTargetsRaw() 的每个 target 跑同一条链、只是去掉人点 ⇒
//   抽成本函数,**人点路由与周期 reconciler 调同一个它**(SSOT,零漂移)。probe 路由退化为「auth + 调本函数 + 审计 + HTTP 映射」。
//
// 🔴 与 route 旧体逐行等价的部分(finalize 决策 + captureProbeEvidence)原样搬入;**新增**仅稳态 telemetry 一段:
//   evidence=none 且 reconcile 判为 telemetry-only 时,用本次 probe 回写 observed.health(fail-open 反转禁令)+ observedVersion。

import {
  getTargetRaw,
  finalizeTargetResources,
  writeProbeResult,
  reconcileAfterProbe,
  deploymentNeedsFinalize,
  probeInputOf,
  type FinalizeLifecycleFence,
  type ProbeLifecycleEvidence,
  type ProbeReconcileResult,
  type TargetStatus,
} from "@/lib/exec-env/registry";
import {
  specObservedOf,
  classifyDescriptor,
  transitionPhase,
  LifecycleConflictError,
  reconcileTelemetry,
  type ProbeResult,
} from "@/lib/exec-env/lifecycle";
import {
  readBuildStatus,
  describeObservedTemplateVersion,
  isTerminalFailedBuildStatus,
  noBuildRecoveryWindow,
  verifyNoBuildForOperation,
  START_ABSENCE_MIN_AGE_MS,
} from "@/lib/exec-env/deploy-control";
import { runProbe } from "@/lib/exec-env/probe-runner";
// @kf-batch 50-WP31-place-first-class 序 31 二刀 ⑤ —— 完成序整条都打在 targetId 这一个区上(build-status / finalize 的 CFN 读 /
//   evidence 捕获 / runProbe):决策记在最前面,不依赖「需要 finalize 才经 readBuildStatus 顺带记一笔」这条偶然路径。
import { notePlaceDecision } from "@/lib/place/context";

/** 落点决策记账里的作者名(观测清单按它归类;判据按它过滤)。 */
export const RECONCILE_PLACE_VIA = "reconcileOneTarget";

/** target 不存在(route 映射 404;reconciler-loop 记日志 —— 刚 list 出来的 target 一般不会缺)。 */
export class ReconcileTargetNotFoundError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ReconcileTargetNotFoundError";
  }
}

/** 只代表对**初始快照中的 exact operation.buildId** 调 build-status 得到的成功证据;禁用 lastBuildId 补洞。 */
type VerifiedBuild =
  | (Extract<FinalizeLifecycleFence, { kind: "deploy" }> & { buildPhase: "SUCCEEDED" })
  | (Extract<FinalizeLifecycleFence, { kind: "legacy" }> & { buildPhase: "SUCCEEDED" });

function sameComponentList(a: readonly string[], b: readonly string[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * finalize 后、runProbe 前捕获 exact 完成证据(§22.2)。evidence 不只绑 operation:runProbe 实际读取
 * region/components/resources/agentcore,故这些输入也快照化,否则同-version 非法 writer 可让旧绿清新态。
 * 🔴 与 probe 路由旧体逐行等价(整段搬入,不改语义)。
 */
function captureProbeEvidence(
  candidate: NonNullable<Awaited<ReturnType<typeof getTargetRaw>>>,
  verifiedBuild: VerifiedBuild | undefined
): ProbeLifecycleEvidence {
  if (!Number.isInteger(candidate.version)) {
    throw new Error(`target ${candidate.targetId} 缺整数 version`);
  }

  const hasSpec = candidate.spec !== undefined;
  const hasObserved = candidate.observed !== undefined;
  if (hasSpec !== hasObserved) throw new Error("spec/observed 只存在一侧");
  const probeInput = probeInputOf(candidate);

  if (!hasSpec) {
    specObservedOf(candidate); // strict legacy schema;只取校验副作用,不用 stored probe 推 phase。
    const noLegacyLock =
      candidate.deployLockToken === undefined &&
      candidate.deployLockExpiresAt === undefined &&
      candidate.deployLockOperationId === undefined;
    const legacyBuild = verifiedBuild?.kind === "legacy" ? verifiedBuild : undefined;
    const verifiedLegacy =
      legacyBuild?.buildPhase === "SUCCEEDED" &&
      legacyBuild.region === candidate.region &&
      legacyBuild.accountId === candidate.accountId &&
      legacyBuild.partition === candidate.partition &&
      candidate.lockEpoch === legacyBuild.lockEpoch &&
      candidate.deployLockToken === legacyBuild.lockToken &&
      candidate.deployLockOperationId === legacyBuild.operationId &&
      candidate.lastOperationId === legacyBuild.operationId &&
      candidate.lastBuildId === legacyBuild.buildId;
    const mode =
      candidate.ready === true && ["active", "degraded"].includes(candidate.status) && noLegacyLock
        ? "stable"
        : candidate.ready === true &&
            ["initializing", "upgrading"].includes(candidate.status) &&
            verifiedLegacy
          ? "e99"
          : candidate.ready !== true &&
              ["initializing", "testing"].includes(candidate.status) &&
              verifiedLegacy
            ? "initial"
            : undefined;
    if (!mode) return { kind: "none", expectedVersion: candidate.version as number };
    const base = {
      kind: "legacy" as const,
      expectedVersion: candidate.version as number,
      status: candidate.status,
      ready: candidate.ready,
      components: [...(candidate.components ?? [])],
      probeInput,
    };
    if (mode === "stable") return { ...base, mode };
    return {
      ...base,
      mode,
      legacySession: {
        lockEpoch: legacyBuild!.lockEpoch,
        lockToken: legacyBuild!.lockToken,
        operationId: legacyBuild!.operationId,
        buildId: legacyBuild!.buildId,
      },
    };
  }

  const { spec, observed } = specObservedOf(candidate);
  const operation = observed.operation;
  if (
    operation?.kind === "deploy" &&
    operation.buildId &&
    typeof operation.openSnapshotHash === "string" &&
    /^[a-f0-9]{64}$/.test(operation.openSnapshotHash) &&
    Number.isInteger(operation.lockEpoch) &&
    operation.lockEpoch >= 1 &&
    operation.disruptive === true &&
    verifiedBuild?.kind === "deploy" &&
    verifiedBuild.buildPhase === "SUCCEEDED" &&
    verifiedBuild.operationId === operation.operationId &&
    verifiedBuild.lockEpoch === operation.lockEpoch &&
    verifiedBuild.openSnapshotHash === operation.openSnapshotHash &&
    verifiedBuild.buildId === operation.buildId &&
    verifiedBuild.startedAt === operation.startedAt &&
    verifiedBuild.fromPhase === observed.phase &&
    verifiedBuild.region === candidate.region &&
    verifiedBuild.accountId === candidate.accountId &&
    verifiedBuild.partition === candidate.partition &&
    sameComponentList(verifiedBuild.desiredComponents, spec.desiredComponents) &&
    candidate.lockEpoch === operation.lockEpoch &&
    candidate.deployLockToken === operation.operationId &&
    candidate.deployLockOperationId === operation.operationId
  ) {
    return {
      kind: "deploy",
      expectedVersion: candidate.version as number,
      fromPhase: observed.phase,
      operationId: operation.operationId,
      lockEpoch: operation.lockEpoch,
      openSnapshotHash: operation.openSnapshotHash,
      buildId: operation.buildId,
      desiredComponents: [...spec.desiredComponents],
      observedComponents: [...observed.components],
      probeInput,
      startedAt: operation.startedAt,
    };
  }

  // 初读没有 operation、build 尚未成功,或 finalize 期间 operation 已更换:都只能写 telemetry。
  return { kind: "none", expectedVersion: candidate.version as number };
}

/**
 * 🔴 P50.3b-2b:**需要人工恢复**的在途会话分类(SPEC §3.5b)。
 * 由 `reconcileOneTarget` **只读**得出:reconciler 每 tick 都会算它,但**绝不据它清锁**(审核 §19.8 第 5 条)——
 * 它的唯一用途是让 UI/运维看见"卡住了、为什么、最早什么时候能恢复",恢复动作必须走 recover 路由 + 管理员确认。
 */
export type RecoveryKind =
  | "terminal-build-failure" // build 已失败终止(最常见)
  | "attach-ambiguous" // StartBuild 成功但 attach buildId 丢响应(operation.attachUncertain)
  | "start-uncertain" // open 成功但 StartBuild 结果未知(无 buildId),须等结构性安全窗
  | "legacy-terminal-failure"; // 无双轴的存量 item 残留锁 + 其 lastBuildId 已失败终止

export interface RecoveryNeed {
  kind: RecoveryKind;
  operationId: string;
  lockEpoch: number;
  buildId?: string;
  /** 终态词;`start-uncertain`(无 buildId 可查)时为 `"no-build"`。 */
  buildStatus: string;
  startedAt?: string;
  /** 仅 `start-uncertain`:最早可恢复时刻(= startedAt + 项目超时 + 裕度)。 */
  earliestRecoverAt?: string;
  /** 现在是否已满足"可以走恢复端点"的时间前提(CFN 处置仍由端点现查,此处不预判)。 */
  recoverableNow: boolean;
}

export interface ReconcileOutcome {
  probe: ProbeResult;
  finalized: boolean;
  evidenceKind: ProbeLifecycleEvidence["kind"];
  /** 🔴 只读分类:在途会话已确定失败/不明,需人工恢复(见 RecoveryNeed);无则 undefined。 */
  recovery?: RecoveryNeed;
  /** reconcileAfterProbe 结果(未冲突时);冲突走 reconcileConflict。 */
  reconcile?: ProbeReconcileResult;
  /** LifecycleConflictError 的消息(条件写冲突;route 转 structured 200,loop 视为正常跳过)。 */
  reconcileConflict?: string;
  /** 稳态 telemetry 写结果(evidence=none∧telemetry-only 时才有)。 */
  telemetry?: { written: boolean; reason?: string };
  finalizeError?: string;
  /** 最终强一致重读的物化投影(route 回显;loop 记日志)。 */
  status: TargetStatus;
  ready: boolean;
}

/**
 * 🔴 单 target 调和(SSOT):probe 路由与周期 reconciler 的共享实现。
 * 顺序 = v3.15 §22 完整完成序 + P50.3b-2a 稳态 telemetry。**不做 auth / 不写审计 / 不碰 HTTP**(那是调用方的事)。
 */
export async function reconcileOneTarget(targetId: string): Promise<ReconcileOutcome> {
  notePlaceDecision({ targetId, via: RECONCILE_PLACE_VIA }); // 第一个 await 之前(D11);周期 reconciler 在请求外调 ⇒ no-op
  const initial = await getTargetRaw(targetId);
  if (!initial) throw new ReconcileTargetNotFoundError(`执行目标不存在:${targetId}`);

  const needsFinalize = deploymentNeedsFinalize(initial);
  const hasSpec = initial.spec !== undefined;
  const hasObserved = initial.observed !== undefined;
  if (hasSpec !== hasObserved) throw new Error("spec/observed 只存在一侧");
  if (!Number.isInteger(initial.version)) throw new Error("target 缺整数 version");

  const initialAxes = hasObserved ? specObservedOf(initial) : undefined;
  const initialOperation = initialAxes?.observed.operation;
  let verifiedBuild: VerifiedBuild | undefined;
  let finalizeFence: FinalizeLifecycleFence | undefined;
  let mayFinalize = false;
  let finalized = !needsFinalize;
  let finalizeError: string | undefined;
  let recovery: RecoveryNeed | undefined;

  if (initialOperation?.kind === "deploy") {
    // 🔴 必须是 operation 自己的 buildId;上一轮 lastBuildId 不是本轮证据。
    if (!initialOperation.buildId) {
      finalizeError = "部署 operation 尚无 buildId;等待 broker attach/reconciler 恢复";
      // 🔴 P50.3b-2b 只读分类:无 buildId ⇒ 完成 fence 结构上不可能 ⇒ 必须人工恢复。
      //    attach 丢响应时有候选 buildId 可查其终态(仍不 attach、仍不自动清锁);否则压根没 build 可查。
      // @kf-batch 50-WP15-airflow-serverless —— 与 recovery.ts 同一份第二证据:CodeBuild 列表里没有该 operation 的 build ⇒ 不必等结构窗
      const startedMsForEvidence = Date.parse(initialOperation.startedAt);
      const nowForEvidence = Date.now();
      const evidence =
        !initialOperation.attachUncertain?.candidateBuildId && Number.isFinite(startedMsForEvidence) && nowForEvidence - startedMsForEvidence >= START_ABSENCE_MIN_AGE_MS
          ? await verifyNoBuildForOperation(initialOperation.operationId, initialOperation.startedAt, nowForEvidence).catch(() => undefined)
          : undefined;
      const candidate = initialOperation.attachUncertain?.candidateBuildId ?? (evidence && !evidence.absent ? evidence.candidateBuildId : undefined);
      const window = noBuildRecoveryWindow(initialOperation.startedAt, nowForEvidence, evidence);
      if (candidate) {
        const candidateBuild = await readBuildStatus(initial, candidate).catch(() => ({ phase: "UNKNOWN" }));
        recovery = {
          kind: "attach-ambiguous",
          operationId: initialOperation.operationId,
          lockEpoch: initialOperation.lockEpoch,
          buildId: candidate,
          buildStatus: candidateBuild.phase,
          startedAt: initialOperation.startedAt,
          // 候选 build 已定性(终态)即可恢复,不必等结构性安全窗。
          recoverableNow: candidateBuild.phase === "SUCCEEDED" || isTerminalFailedBuildStatus(candidateBuild.phase),
        };
      } else {
        recovery = {
          kind: "start-uncertain",
          operationId: initialOperation.operationId,
          lockEpoch: initialOperation.lockEpoch,
          buildStatus: "no-build",
          startedAt: initialOperation.startedAt,
          earliestRecoverAt: window.earliestRecoverAt || undefined,
          recoverableNow: window.recoverable,
        };
      }
    } else if (
      typeof initialOperation.openSnapshotHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(initialOperation.openSnapshotHash)
    ) {
      finalizeError = "部署 operation 缺合法 openSnapshotHash,拒绝完成";
    } else if (!Number.isInteger(initialOperation.lockEpoch) || initialOperation.lockEpoch < 1) {
      finalizeError = "部署 operation 缺合法 lockEpoch(>=1),拒绝完成";
    } else {
      const build = await readBuildStatus(initial, initialOperation.buildId);
      if (build.phase === "SUCCEEDED") {
        verifiedBuild = {
          kind: "deploy",
          region: initial.region,
          accountId: initial.accountId,
          partition: initial.partition,
          expectedVersion: initial.version as number,
          operationId: initialOperation.operationId,
          lockEpoch: initialOperation.lockEpoch,
          openSnapshotHash: initialOperation.openSnapshotHash,
          buildId: initialOperation.buildId,
          startedAt: initialOperation.startedAt,
          fromPhase: initialAxes!.observed.phase,
          desiredComponents: [...initialAxes!.spec.desiredComponents],
          buildPhase: "SUCCEEDED",
        };
        finalizeFence = verifiedBuild;
        mayFinalize = true;
      } else {
        finalizeError = `部署 build 尚未成功(phase=${build.phase}),不执行完成转移`;
        // 🔴 已失败终止 ⇒ 需人工恢复(reconciler **只呈现,绝不清锁**,审核 §19.8 第 5 条)。
        //    IN_PROGRESS/UNKNOWN 不算 —— 那是"还在跑",本来就该等。
        if (isTerminalFailedBuildStatus(build.phase)) {
          recovery = {
            kind: "terminal-build-failure",
            operationId: initialOperation.operationId,
            lockEpoch: initialOperation.lockEpoch,
            buildId: initialOperation.buildId,
            buildStatus: build.phase,
            startedAt: initialOperation.startedAt,
            recoverableNow: true,
          };
        }
      }
    }
  } else if (!hasObserved && needsFinalize) {
    const legacyEpoch = initial.lockEpoch;
    const legacyToken = initial.deployLockToken;
    const legacyOwner = initial.deployLockOperationId;
    const legacyOperationId = initial.lastOperationId;
    const legacyBuildId = initial.lastBuildId;
    if (
      !Number.isInteger(legacyEpoch) ||
      (legacyEpoch as number) < 1 ||
      typeof legacyToken !== "string" ||
      legacyToken.length === 0 ||
      typeof legacyOwner !== "string" ||
      legacyOwner.length === 0 ||
      typeof legacyOperationId !== "string" ||
      legacyOperationId.length === 0 ||
      legacyOwner !== legacyOperationId ||
      typeof legacyBuildId !== "string" ||
      legacyBuildId.length === 0
    ) {
      finalizeError = "legacy 待完成记录缺 exact epoch/token/owner/lastOperationId/lastBuildId";
    } else {
      // 禁止 lastBuildId fallback:对 legacy,它就是本次已锁定 holder 的 canonical build。
      const build = await readBuildStatus(initial, legacyBuildId);
      if (build.phase === "SUCCEEDED") {
        verifiedBuild = {
          kind: "legacy",
          region: initial.region,
          accountId: initial.accountId,
          partition: initial.partition,
          expectedVersion: initial.version as number,
          status: initial.status,
          ready: initial.ready,
          components: [...(initial.components ?? [])],
          probe: initial.probe,
          lockEpoch: legacyEpoch as number,
          lockToken: legacyToken,
          operationId: legacyOperationId,
          buildId: legacyBuildId,
          buildPhase: "SUCCEEDED",
        };
        finalizeFence = verifiedBuild;
        mayFinalize = true;
      } else {
        finalizeError = `legacy build 尚未成功(phase=${build.phase}),保留锁且不完成`;
        if (isTerminalFailedBuildStatus(build.phase)) {
          recovery = {
            kind: "legacy-terminal-failure",
            operationId: legacyOperationId,
            lockEpoch: legacyEpoch as number,
            buildId: legacyBuildId,
            buildStatus: build.phase,
            recoverableNow: true,
          };
        }
      }
    }
  } else if (hasObserved && needsFinalize) {
    // 现代 axes 处于待完成 phase 却没有 deploy operation,不能借 legacy 规则晋级。
    mayFinalize = false;
    finalizeError = `现代 lifecycle 缺 deploy operation(phase=${initialAxes!.observed.phase})`;
  }

  if (needsFinalize && mayFinalize && finalizeFence) {
    try {
      await finalizeTargetResources(targetId, { fence: finalizeFence });
      finalized = true;
    } catch (error) {
      finalized = false;
      finalizeError = String((error as Error)?.message ?? error);
    }
  }

  // 🔴 无论 finalize 成败都重新强一致读取;probe 必须打在这个 candidate 上。
  const candidate = await getTargetRaw(targetId);
  if (!candidate) throw new Error("finalize 后 target 消失");
  const evidence = captureProbeEvidence(candidate, verifiedBuild);

  const probe = await runProbe(candidate);
  await writeProbeResult(targetId, probe); // 🔴 刷新顶层 probe.at(stale gate 时间源),无条件、不涨 version

  let reconcile: ProbeReconcileResult | undefined;
  let reconcileConflict: string | undefined;
  try {
    reconcile = await reconcileAfterProbe(targetId, { probe, finalized, evidence });
  } catch (error) {
    if (!(error instanceof LifecycleConflictError)) throw error;
    reconcileConflict = error.message;
  }

  // 🔴 P50.3b-2a 稳态 telemetry:无在途完成(evidence=none)且 reconcile 判为 telemetry-only 时,
  //    用本次 probe 回写 observed.health(fail-open 反转禁令)+ observedVersion。有在途 operation/完成路时不介入。
  let telemetry: { written: boolean; reason?: string } | undefined;
  if (evidence.kind === "none" && reconcile?.reason === "telemetry-only") {
    const templateVersion = await describeObservedTemplateVersion(candidate).catch(() => undefined);
    telemetry = await reconcileTelemetry(targetId, { probe, templateVersion });
  }

  // 🔴 P50.3b-4:**按 spec.intent 驱动 phase**(观测态只由控制器写 —— 人只写 spec,phase 归这里)。
  //    · `intent=drain` ∧ phase=ready ⇒ ready→draining(排空中);
  //    · `intent=serve` ∧ phase=draining ∧ **本次探活全绿** ⇒ draining→ready(回服务)。
  //  🔴 回服务刻意要求**全绿探活**:不是"把标记翻回去就算好了" —— 排空期间可能正好在做维护,
  //     资源状态未知,必须过与首次 ready 同一条证据路。
  //  🔴 `draining → decommissioning` **刻意不在这里驱动**:那一步意味着真销毁,须走 §4.6
  //     (影响预览 → 输名强确认 → 审批 → 销毁,数据桶 RETAIN)⇒ 归 P50.3。这里推过去会造出
  //     "标成退役而资源全在"的 tombstone 谎。
  let intentDrive: { from: string; to: string } | { skipped: string } | undefined;
  {
    const cur = await getTargetRaw(targetId);
    const cls = cur ? classifyDescriptor(cur) : undefined;
    if (cls && cls.kind !== "invalid" && !cls.observed.operation) {
      const want =
        cls.spec.intent === "drain" && cls.observed.phase === "ready"
          ? "draining"
          : cls.spec.intent === "serve" && cls.observed.phase === "draining" && probe.ok
            ? "ready"
            : undefined;
      if (want) {
        try {
          await transitionPhase(targetId, {
            expectedVersion: cur!.version as number,
            from: cls.observed.phase,
            post: { spec: cls.spec, observed: { ...cls.observed, phase: want as never, probe } },
            reason: `intent=${cls.spec.intent} 驱动 ${cls.observed.phase}→${want}`,
          });
          intentDrive = { from: cls.observed.phase, to: want };
        } catch (error) {
          // 并发/条件拒 ⇒ 下 tick 再来(与 telemetry 同款:控制器不与管理操作抢写)
          intentDrive = { skipped: String((error as Error)?.message ?? error).slice(0, 160) };
        }
      }
    }
  }

  const after = await getTargetRaw(targetId);
  if (!after) throw new Error("probe 完成后 target 消失");

  return {
    probe,
    finalized,
    evidenceKind: evidence.kind,
    ...(intentDrive ? { intentDrive } : {}),
    // 🔴 finalize 成功(会话已正常完成)后不再报"需恢复" —— 分类是初读快照算的,完成路跑通即作废。
    ...(recovery && !finalized ? { recovery } : {}),
    reconcile,
    reconcileConflict,
    telemetry,
    finalizeError,
    status: after.status,
    ready: after.ready === true,
  };
}
