// 失败会话恢复的【判定与执行】—— SPEC §3.5b / 外部审核 §19.8(发布阻断项)。
//
// 【为什么逻辑在 lib 而不在 route】仓内不单测 Next route(见 add-components route 注释),
//   判定放路由里就等于**不可测**。这里同时服务两个调用方,保证"页面看到的"与"接口放行的"是同一份判据:
//   · `GET  .../recover` → `assessRecovery()`  只读描述(能不能恢复、为什么不能、最早何时能)
//   · `POST .../recover` → `recoverFailedSession()` 真恢复(同一份 assess + CFN 闸 + 唯一失败写入方)
//   ⇒ 结构上不可能出现"页面说可以恢复、接口却拒"(或更糟:反过来)这种不一致。
//
// 🔴 本文件**不写任何状态**:清锁语义全在 `lifecycle.recordOperationFailure`(全仓唯一失败写入方)。

import { getTargetRaw, type ExecutionTarget } from "@/lib/exec-env/registry";
import {
  readExactBuildPhase,
  describeStackDisposition,
  isTerminalFailedBuildStatus,
  noBuildRecoveryWindow,
  verifyNoBuildForOperation,
  START_ABSENCE_MIN_AGE_MS,
  BUILD_NOT_FOUND,
  type StackDisposition,
} from "@/lib/exec-env/deploy-control";
import {
  recordOperationFailure,
  classifyDescriptor,
  NO_BUILD_STATUS,
  type OperationFailureFence,
} from "@/lib/exec-env/lifecycle";
import type { RecoveryKind } from "@/lib/exec-env/reconcile";

/** 恢复被拒:带 HTTP 语义,由路由原样映射(不在路由里重新判断"这算 400 还是 409")。 */
export class RecoveryRefusedError extends Error {
  readonly httpStatus: number;
  readonly code: "VALIDATION_FAILED" | "CONFLICT" | "NOT_FOUND";
  readonly detail?: Record<string, unknown>;
  constructor(
    msg: string,
    httpStatus: number,
    code: "VALIDATION_FAILED" | "CONFLICT" | "NOT_FOUND",
    detail?: Record<string, unknown>
  ) {
    super(msg);
    this.name = "RecoveryRefusedError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.detail = detail;
  }
}

/** 判定结果:要么没有待恢复会话,要么现在还不能恢复(带原因),要么齐备(带 exact fence)。 */
export type RecoveryAssessment =
  | { state: "none"; reason: string }
  | {
      state: "blocked";
      reason: string;
      httpStatus: number;
      code: "VALIDATION_FAILED" | "CONFLICT";
      /**
       * 🔴 **是否需要人来处理**(与"现在能不能恢复"是两件事):
       *   · build 还在跑(IN_PROGRESS/UNKNOWN)/ 已 SUCCEEDED 待「检测初始化」⇒ `false`(正常在途,别报警);
       *   · startUncertain 窗内 / 描述符形态坏 ⇒ `true`(确实卡住了,只是现在还不能落锤)。
       * 少了这个区分,页面会在**每一次正常部署**期间弹"需恢复"横幅 = 狼来了。
       */
      humanRecovery: boolean;
      detail?: Record<string, unknown>;
      kind?: RecoveryKind;
      buildStatus?: string;
      operationId?: string;
      earliestRecoverAt?: string;
    }
  | {
      state: "ready";
      kind: RecoveryKind;
      operationId: string;
      buildStatus: string;
      fence: OperationFailureFence;
      /** 审计 before 快照(路由原样记录)。 */
      before: Record<string, unknown>;
    };

/**
 * 🔴 判定该 target 有没有"待人工恢复"的会话、现在能不能恢复(**不查 CFN**:CFN 闸在执行阶段现查,
 * 因为它随时会变;这里只做与 item + build 终态相关的、稳定的判定)。
 *
 * @param expectedOperationId 调用方"点名"要恢复的会话;不给(GET 描述场景)则不做点名校验。
 */
export async function assessRecovery(
  target: ExecutionTarget,
  expectedOperationId?: string,
  now: number = Date.now()
): Promise<RecoveryAssessment> {
  if (!Number.isInteger(target.version)) {
    return { state: "blocked", reason: "描述符缺整数 version,拒绝恢复(fail-closed)", httpStatus: 409, code: "CONFLICT", humanRecovery: true };
  }
  const hasSpec = target.spec !== undefined;
  const hasObserved = target.observed !== undefined;
  if (hasSpec !== hasObserved) {
    return {
      state: "blocked",
      reason: "描述符半写(spec/observed 只存在一侧)—— 请先修复形态,恢复端点不猜",
      httpStatus: 409,
      code: "CONFLICT",
      humanRecovery: true,
    };
  }

  if (hasObserved) {
    // 🔴 只读判定用 `classifyDescriptor` 而**不是** `specObservedOf` —— 后者对 invalid 描述符**抛异常**,
    //    会让 GET .../recover 变成 502(页面拿不到阻断原因,运维只看到"读取失败")。
    //    lifecycle.ts 的三分类合同明写:只读准入方把 invalid 当「不可用 + 原因」返回,不抛(fail-closed 且可解释)。
    const cls = classifyDescriptor(target);
    if (cls.kind !== "modern") {
      return {
        state: "blocked",
        reason: `描述符形态非法(fail-closed):${cls.kind === "invalid" ? cls.reason : `期望 modern,实为 ${cls.kind}`}`,
        httpStatus: 409,
        code: "CONFLICT",
        humanRecovery: true,
      };
    }
    const { spec, observed } = cls;
    const operation = observed.operation;
    if (!operation) return { state: "none", reason: "没有在途部署会话 —— 无需恢复" };
    if (operation.kind !== "deploy") {
      return {
        state: "blocked",
        reason: `在途会话 kind=${operation.kind} 不支持恢复(本批只覆盖 deploy)`,
        httpStatus: 400,
        code: "VALIDATION_FAILED",
        humanRecovery: true,
        operationId: operation.operationId,
      };
    }
    if (expectedOperationId !== undefined && operation.operationId !== expectedOperationId) {
      return {
        state: "blocked",
        reason: `expectedOperationId 与在途会话不符(在途=${operation.operationId})—— 期间会话已变,拒绝误清`,
        httpStatus: 409,
        code: "CONFLICT",
        humanRecovery: false,
        operationId: operation.operationId,
      };
    }
    if (typeof operation.openSnapshotHash !== "string" || !Number.isInteger(operation.lockEpoch)) {
      return {
        state: "blocked",
        reason: "在途会话缺 openSnapshotHash/lockEpoch(形态坏),恢复端点不猜",
        httpStatus: 409,
        code: "CONFLICT",
        humanRecovery: true,
        operationId: operation.operationId,
      };
    }

    let buildStatus: string;
    let kind: RecoveryKind;
    if (operation.buildId) {
      // 🔴 exact:只查 operation 自己的 buildId,绝不用 lastBuildId 补洞。
      //    用窄读取器(不拉栈/日志),且它把"CodeBuild 查不到这个 build"单列成 BUILD_NOT_FOUND ——
      //    旧的 readBuildStatus 会把它压成 "none" 并被归入"状态未定 ⇒ 永远拒恢复",
      //    那就是第三个"有锁 + 无出路"的永久卡死门(build 记录过期/项目被重建即触发)。
      const phase = await readExactBuildPhase(operation.buildId);
      if (phase === BUILD_NOT_FOUND) {
        // 记录都没了 ⇒ 结构上不可能有 build 在跑 ⇒ 可恢复(CFN 闸仍另行把关)。
        return {
          state: "ready",
          kind: "terminal-build-failure",
          operationId: operation.operationId,
          buildStatus: BUILD_NOT_FOUND,
          fence: {
            mode: "modern",
            region: target.region,
            accountId: target.accountId,
            partition: target.partition,
            expectedVersion: target.version as number,
            fromPhase: observed.phase,
            operationId: operation.operationId,
            lockEpoch: operation.lockEpoch,
            openSnapshotHash: operation.openSnapshotHash,
            buildId: operation.buildId,
            startedAt: operation.startedAt,
            desiredComponents: [...spec.desiredComponents],
            observedComponents: [...observed.components],
          },
          before: {
            phase: observed.phase,
            health: observed.health,
            status: target.status,
            ready: target.ready,
            operationId: operation.operationId,
            lockEpoch: operation.lockEpoch,
            buildId: operation.buildId,
            buildRecordMissing: true,
          },
        };
      }
      const build = { phase };
      if (build.phase === "SUCCEEDED") {
        return {
          state: "blocked",
          reason:
            `本次部署 build 已 SUCCEEDED(${operation.buildId})—— 请走「检测初始化」完成它;` +
            "恢复端点不得绕过完成 fence 清锁",
          httpStatus: 400,
          code: "VALIDATION_FAILED",
          humanRecovery: false, // 正常完成路:点「检测初始化」即可,不该弹恢复
          operationId: operation.operationId,
          buildStatus: build.phase,
        };
      }
      if (!isTerminalFailedBuildStatus(build.phase)) {
        return {
          state: "blocked",
          reason: `本次部署 build 仍在跑/状态未定(phase=${build.phase})—— 清锁会放第二次部署去撞同一批栈,拒绝`,
          httpStatus: 409,
          code: "CONFLICT",
          humanRecovery: false, // 🔴 正常在途部署:别在每次部署期间弹"需恢复"(狼来了)
          operationId: operation.operationId,
          buildStatus: build.phase,
        };
      }
      buildStatus = build.phase;
      kind = "terminal-build-failure";
    } else {
      // 无 buildId ⇒ 完成 fence 结构上不可能(它要求 exact buildId)⇒ 恢复是唯一出路,
      // 但仍须先把那次 StartBuild 的结局**定性**(IN_PROGRESS/UNKNOWN 一律不许清)。
      const candidate = operation.attachUncertain?.candidateBuildId;
      if (candidate) {
        const build = { phase: await readExactBuildPhase(candidate) };
        if (
          build.phase !== "SUCCEEDED" &&
          build.phase !== BUILD_NOT_FOUND &&
          !isTerminalFailedBuildStatus(build.phase)
        ) {
          return {
            state: "blocked",
            reason: `attach 丢响应的候选 build 仍在跑/状态未定(${candidate} phase=${build.phase})—— 拒绝清锁`,
            httpStatus: 409,
            code: "CONFLICT",
            humanRecovery: true, // buildId 没 attach 上 ⇒ 完成 fence 永不可能触发,终将卡死,需人盯
            operationId: operation.operationId,
            buildStatus: build.phase,
            kind: "attach-ambiguous",
          };
        }
        buildStatus = build.phase;
        kind = "attach-ambiguous";
      } else {
        // 第二条证据:CodeBuild 项目里有没有这次 operation 的 build(会话 ≥ 5min 后才查,防与 broker StartBuild 竞态)。
        //   有 ⇒ 那就是 attach 丢响应的候选,按其真实终态定性;没有 ⇒ 不必等 2h15m 结构窗(真环境:broker open 后 post-image 不匹配即停,根本没起 build)。
        const startedMs = Date.parse(operation.startedAt);
        const evidence =
          Number.isFinite(startedMs) && now - startedMs >= START_ABSENCE_MIN_AGE_MS
            ? await verifyNoBuildForOperation(operation.operationId, operation.startedAt, now).catch(() => undefined)
            : undefined;
        if (evidence && !evidence.absent && evidence.candidateBuildId) {
          const phase = evidence.candidateStatus ?? "UNKNOWN";
          if (phase !== "SUCCEEDED" && phase !== BUILD_NOT_FOUND && !isTerminalFailedBuildStatus(phase)) {
            return {
              state: "blocked",
              reason: `CodeBuild 里找到了这次 operation 的 build(${evidence.candidateBuildId} phase=${phase},attach 丢响应)仍在跑/状态未定 —— 拒绝清锁`,
              httpStatus: 409,
              code: "CONFLICT",
              humanRecovery: true,
              operationId: operation.operationId,
              buildStatus: phase,
              kind: "attach-ambiguous",
            };
          }
          buildStatus = phase;
          kind = "attach-ambiguous";
        } else {
        const window = noBuildRecoveryWindow(operation.startedAt, now, evidence);
        if (!window.recoverable) {
          return {
            state: "blocked",
            reason:
              `本次会话 StartBuild 结果未知且无候选 buildId ⇒ 须等到 ${window.earliestRecoverAt || "(startedAt 不可解析)"}` +
              "(= 会话开始 + CodeBuild 项目超时 + 裕度)才能确定不会有 build 还在跑;在此之前拒绝清锁" +
              (evidence === undefined ? "(会话开始不足 5 分钟 / 无法查 CodeBuild 列表,暂不能用「列表里没有该 build」作证据)" : ""),
            httpStatus: 409,
            code: "CONFLICT",
            humanRecovery: true, // 确实卡住了,只是还没到结构性安全窗
            operationId: operation.operationId,
            buildStatus: NO_BUILD_STATUS,
            kind: "start-uncertain",
            earliestRecoverAt: window.earliestRecoverAt || undefined,
            detail: { earliestRecoverAt: window.earliestRecoverAt },
          };
        }
        buildStatus = NO_BUILD_STATUS;
        kind = "start-uncertain";
        }
      }
    }

    return {
      state: "ready",
      kind,
      operationId: operation.operationId,
      buildStatus,
      fence: {
        mode: "modern",
        region: target.region,
        accountId: target.accountId,
        partition: target.partition,
        expectedVersion: target.version as number,
        fromPhase: observed.phase,
        operationId: operation.operationId,
        lockEpoch: operation.lockEpoch,
        openSnapshotHash: operation.openSnapshotHash,
        ...(operation.buildId !== undefined ? { buildId: operation.buildId } : {}),
        startedAt: operation.startedAt,
        desiredComponents: [...spec.desiredComponents],
        observedComponents: [...observed.components],
      },
      before: {
        phase: observed.phase,
        health: observed.health,
        status: target.status,
        ready: target.ready,
        operationId: operation.operationId,
        lockEpoch: operation.lockEpoch,
        buildId: operation.buildId ?? null,
        startUncertain: operation.startUncertain?.at ?? null,
        attachUncertain: operation.attachUncertain?.candidateBuildId ?? null,
      },
    };
  }

  // ── legacy:无双轴,唯一可恢复形态 = 顶层锁残留 ──
  const lockToken = target.deployLockToken;
  const lockOwner = target.deployLockOperationId;
  const lastOperationId = target.lastOperationId;
  const lastBuildId = target.lastBuildId;
  if (lockToken === undefined && lockOwner === undefined && target.deployLockExpiresAt === undefined) {
    return { state: "none", reason: "(存量)目标没有残留部署锁 —— 无需恢复" };
  }
  if (
    typeof lockToken !== "string" ||
    typeof lockOwner !== "string" ||
    typeof lastOperationId !== "string" ||
    lockOwner !== lastOperationId ||
    !Number.isInteger(target.lockEpoch)
  ) {
    return {
      state: "blocked",
      reason:
        "存量残留锁缺 exact holder(deployLockToken/deployLockOperationId/lastOperationId/lockEpoch 须齐且 owner=lastOperationId)—— fail-closed",
      httpStatus: 409,
      code: "CONFLICT",
      humanRecovery: true,
    };
  }
  if (expectedOperationId !== undefined && lockOwner !== expectedOperationId) {
    return {
      state: "blocked",
      reason: `expectedOperationId 与残留锁 holder 不符(holder=${lockOwner})`,
      httpStatus: 409,
      code: "CONFLICT",
      humanRecovery: false,
      operationId: lockOwner,
    };
  }
  if (typeof lastBuildId !== "string" || lastBuildId.length === 0) {
    return {
      state: "blocked",
      reason: "存量残留锁没有 canonical lastBuildId 可核查 —— 无法证明那次 build 已终止,拒绝清锁(fail-closed)",
      httpStatus: 409,
      code: "CONFLICT",
      humanRecovery: true,
      operationId: lockOwner,
    };
  }
  const build = { phase: await readExactBuildPhase(lastBuildId) };
  if (build.phase === "SUCCEEDED") {
    return {
      state: "blocked",
      reason: `存量 holder 的 build 已 SUCCEEDED(${lastBuildId})—— 请走「检测初始化」的收养/完成路,不是恢复`,
      httpStatus: 400,
      code: "VALIDATION_FAILED",
      humanRecovery: false,
      operationId: lockOwner,
      buildStatus: build.phase,
    };
  }
  if (!isTerminalFailedBuildStatus(build.phase) && build.phase !== BUILD_NOT_FOUND) {
    return {
      state: "blocked",
      reason: `存量 holder 的 build 仍在跑/状态未定(phase=${build.phase})—— 拒绝清锁`,
      httpStatus: 409,
      code: "CONFLICT",
      humanRecovery: false,
      operationId: lockOwner,
      buildStatus: build.phase,
    };
  }
  return {
    state: "ready",
    kind: "legacy-terminal-failure",
    operationId: lockOwner,
    buildStatus: build.phase,
    fence: {
      mode: "legacy",
      region: target.region,
      accountId: target.accountId,
      partition: target.partition,
      expectedVersion: target.version as number,
      lockEpoch: target.lockEpoch as number,
      lockToken,
      operationId: lockOwner,
      buildId: lastBuildId,
      status: target.status,
      components: [...(target.components ?? [])],
    },
    before: {
      legacy: true,
      status: target.status,
      ready: target.ready,
      operationId: lockOwner,
      lockEpoch: target.lockEpoch,
      buildId: lastBuildId,
    },
  };
}

/** GET 的只读描述(页面渲染用):判定 + CFN 处置(CFN 只读,展示"现在为什么不能恢复"很关键)。 */
export interface RecoveryStatusView {
  /** 🔴 有在途部署会话/残留锁 ⇒ **禁止再发新部署**(审核 §19.8:禁静默重试);与 needed 是两件事。 */
  sessionInFlight: boolean;
  /** 🔴 **需要人来处理**(失败终止 / attach 丢响应 / startUncertain / 形态坏);正常在途部署为 false。 */
  needed: boolean;
  recoverableNow: boolean;
  reason: string;
  kind?: RecoveryKind;
  operationId?: string;
  buildStatus?: string;
  earliestRecoverAt?: string;
  cfn?: { stable: boolean; blockers: string[]; stacks: StackDisposition["stacks"]; checkedAt: string };
}

export async function describeRecoveryStatus(targetId: string): Promise<RecoveryStatusView> {
  const target = await getTargetRaw(targetId);
  if (!target) throw new RecoveryRefusedError(`执行目标不存在:${targetId}`, 404, "NOT_FOUND");
  const assessment = await assessRecovery(target);
  if (assessment.state === "none") {
    return { sessionInFlight: false, needed: false, recoverableNow: false, reason: assessment.reason };
  }
  if (assessment.state === "blocked") {
    return {
      // blocked ⇒ 一定有会话/残留锁在(否则是 none)⇒ 一律禁新部署;但"要不要报警"看 humanRecovery。
      sessionInFlight: true,
      needed: assessment.humanRecovery,
      recoverableNow: false,
      reason: assessment.reason,
      ...(assessment.kind ? { kind: assessment.kind } : {}),
      ...(assessment.operationId ? { operationId: assessment.operationId } : {}),
      ...(assessment.buildStatus ? { buildStatus: assessment.buildStatus } : {}),
      ...(assessment.earliestRecoverAt ? { earliestRecoverAt: assessment.earliestRecoverAt } : {}),
    };
  }
  // 时间/build 前提齐备 ⇒ 再看基础设施稳不稳(它决定"现在"能不能点恢复)。
  const cfn = await describeStackDisposition(target);
  return {
    sessionInFlight: true,
    needed: true,
    recoverableNow: cfn.stable,
    reason: cfn.stable
      ? `会话 ${assessment.operationId} 已确定失败(build=${assessment.buildStatus}),基础设施已稳定,可恢复`
      : `会话 ${assessment.operationId} 已确定失败,但目标 region 基础设施尚未稳定:${cfn.blockers.join(";")}`,
    kind: assessment.kind,
    operationId: assessment.operationId,
    buildStatus: assessment.buildStatus,
    cfn: { stable: cfn.stable, blockers: cfn.blockers, stacks: cfn.stacks, checkedAt: cfn.checkedAt },
  };
}

export interface RecoverResult {
  mode: OperationFailureFence["mode"];
  kind: RecoveryKind;
  buildStatus: string;
  disposition: StackDisposition;
  before: Record<string, unknown>;
  /**
   * 🔴 已声明(`spec.desiredComponents`)但尚未落地(`observed.components`)的组件。
   * 恢复**不跑 finalize**(那要 exact build fence),所以失败会话在 open 时已改过的 desired
   * 不会被自动补齐 ⇒ 必须**明确告诉管理员再跑一次幂等部署**,否则 target 会静默地回到 active
   * 却缺一个已声明的组件(审核复审发现的漂移)。
   */
  undeployedComponents: string[];
}

/**
 * 🔴 真恢复(POST):强一致读 → 同一份 assess(点名校验)→ CFN 闸(**绝不降级**)→ 唯一失败写入方。
 * 抛 `RecoveryRefusedError`(路由原样映射)或 lifecycle 的 `FailureRecoveryError/LifecycleConflictError/…`。
 */
export async function recoverFailedSession(
  targetId: string,
  input: { decisionId: string; decidedBy: string; expectedOperationId: string }
): Promise<RecoverResult> {
  const target = await getTargetRaw(targetId);
  if (!target) throw new RecoveryRefusedError(`执行目标不存在:${targetId}`, 404, "NOT_FOUND");
  const assessment = await assessRecovery(target, input.expectedOperationId);
  if (assessment.state === "none") {
    throw new RecoveryRefusedError(assessment.reason, 400, "VALIDATION_FAILED");
  }
  if (assessment.state === "blocked") {
    throw new RecoveryRefusedError(assessment.reason, assessment.httpStatus, assessment.code, assessment.detail);
  }

  // 🔴 CFN 闸:任何进行中动作 / 未执行 change set / **查询失败** ⇒ 拒(看不清 = 不安全,与进度页降级口径相反)。
  const disposition = await describeStackDisposition(target);
  if (!disposition.stable) {
    throw new RecoveryRefusedError(
      `目标 region 基础设施尚未稳定,拒绝清锁:${disposition.blockers.join(";")}`,
      409,
      "CONFLICT",
      { blockers: disposition.blockers, stacks: disposition.stacks }
    );
  }

  const result = await recordOperationFailure(targetId, {
    fence: assessment.fence,
    disposition: {
      buildStatus: assessment.buildStatus,
      checkedAt: disposition.checkedAt,
      stacks: disposition.stacks,
    },
    decision: { decisionId: input.decisionId, decidedBy: input.decidedBy },
  });

  const fence = assessment.fence;
  const undeployedComponents =
    fence.mode === "modern" ? fence.desiredComponents.filter((c) => !fence.observedComponents.includes(c)) : [];

  return {
    mode: result.mode,
    kind: assessment.kind,
    buildStatus: assessment.buildStatus,
    disposition,
    before: assessment.before,
    undeployedComponents,
  };
}
