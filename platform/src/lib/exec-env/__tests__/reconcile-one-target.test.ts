// 🔴 `reconcileOneTarget`(人点「检测初始化」与周期 reconciler 的 SSOT)的**两条对称承重**:
//
// ① **成功路回归钉**:有在途 operation ∧ 其 exact build 已 SUCCEEDED ⇒ **自动 finalize**
//    (= 崩在 build 成功之后不需要人点;这是 2a 抽 SSOT 时顺带拿到的红利,必须钉住不被重构掉)。
// ② **失败路只读禁令**(审核 §19.8 第 5 条):build 已失败终止 / attach 丢响应 / startUncertain,
//    reconciler **只分类不落锤** —— 绝不清 operation、绝不清顶层锁。清锁只能走恢复端点 + 管理员确认。
//    这条如果破了,就等于把"自动接管陈锁"偷偷放回来 = 可能放第二次部署去撞还在跑的 CloudFormation。
import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  getTargetRawMock,
  finalizeMock,
  writeProbeResultMock,
  reconcileAfterProbeMock,
  deploymentNeedsFinalizeMock,
  probeInputOfMock,
  readBuildStatusMock,
  describeTemplateVersionMock,
  runProbeMock,
  ddbSendMock,
} = vi.hoisted(() => ({
  getTargetRawMock: vi.fn(),
  finalizeMock: vi.fn(),
  writeProbeResultMock: vi.fn(),
  reconcileAfterProbeMock: vi.fn(),
  deploymentNeedsFinalizeMock: vi.fn(),
  probeInputOfMock: vi.fn(),
  readBuildStatusMock: vi.fn(),
  describeTemplateVersionMock: vi.fn(),
  runProbeMock: vi.fn(),
  ddbSendMock: vi.fn(),
}));

vi.mock("@/lib/exec-env/registry", () => ({
  getTargetRaw: getTargetRawMock,
  finalizeTargetResources: finalizeMock,
  writeProbeResult: writeProbeResultMock,
  reconcileAfterProbe: reconcileAfterProbeMock,
  deploymentNeedsFinalize: deploymentNeedsFinalizeMock,
  probeInputOf: probeInputOfMock,
}));
vi.mock("@/lib/exec-env/deploy-control", () => ({
  readBuildStatus: readBuildStatusMock,
  describeObservedTemplateVersion: describeTemplateVersionMock,
  isTerminalFailedBuildStatus: (p: string) => ["FAILED", "FAULT", "TIMED_OUT", "STOPPED"].includes(p),
  noBuildRecoveryWindow: (startedAt: string, now = Date.now()) => {
    const earliest = Date.parse(startedAt) + 2 * 60 * 60 * 1000 + 5 * 60 * 1000;
    return { earliestRecoverAt: new Date(earliest).toISOString(), recoverable: now >= earliest };
  },
  // 第二证据(CodeBuild 列表无该 operation 的 build)—— 本文件不测它,缺省「查不到证据」
  START_ABSENCE_MIN_AGE_MS: 5 * 60 * 1000,
  verifyNoBuildForOperation: async () => ({ absent: false, verifiedAt: Date.now() }),
}));
vi.mock("@/lib/exec-env/probe-runner", () => ({ runProbe: runProbeMock }));
vi.mock("@/lib/aws/dynamodb", () => ({
  docClient: { send: ddbSendMock },
  TABLES: { EXECUTION_ENVS: "bgp-execution-envs" },
}));

import { reconcileOneTarget, RECONCILE_PLACE_VIA } from "@/lib/exec-env/reconcile";
// 完成序在第一个 AWS 调用之前记落点决策(真账本,不 mock)
import { __setRequestStoreProvider, decisionsOfCurrentRequest } from "@/lib/place/context";

const CANON = "2026-09-01T00:00:00.000Z";
const ACCT = "123456789012";
const OP = "op_2b0001";
const HASH = "c".repeat(64);
const green = { at: CANON, ok: true, items: [{ name: "datalakeBucket", ok: true }] };

const operation = (over: Record<string, unknown> = {}) => ({
  kind: "deploy",
  operationId: OP,
  lockEpoch: 4,
  openSnapshotHash: HASH,
  buildId: "b_2b",
  startedAt: CANON,
  disruptive: true,
  ...over,
});

const item = (over: Record<string, unknown> = {}, opOver: Record<string, unknown> = {}) => ({
  pk: "env",
  sk: "tgt_usw2_a",
  targetId: "tgt_usw2_a",
  version: 11,
  accountId: ACCT,
  region: "us-west-2",
  partition: "aws",
  status: "upgrading",
  ready: true,
  components: ["core"],
  probe: green,
  lockEpoch: 4,
  deployLockToken: OP,
  deployLockOperationId: OP,
  deployLockExpiresAt: 1_800_000_000_000,
  spec: { intent: "serve", desiredComponents: ["core"] },
  observed: { phase: "ready", health: "healthy", components: ["core"], probe: green, operation: operation(opOver) },
  ...over,
});

beforeEach(() => {
  for (const m of [
    getTargetRawMock,
    finalizeMock,
    writeProbeResultMock,
    reconcileAfterProbeMock,
    deploymentNeedsFinalizeMock,
    probeInputOfMock,
    readBuildStatusMock,
    describeTemplateVersionMock,
    runProbeMock,
    ddbSendMock,
  ]) {
    m.mockReset();
  }
  deploymentNeedsFinalizeMock.mockReturnValue(true); // 有 deploy operation ⇒ 真实实现恒 true
  probeInputOfMock.mockReturnValue({ region: "us-west-2", accountId: ACCT, partition: "aws", components: ["core"], resources: undefined, agentcore: undefined });
  runProbeMock.mockResolvedValue(green);
  writeProbeResultMock.mockResolvedValue(undefined);
  reconcileAfterProbeMock.mockResolvedValue({ advanced: true, reason: "deployment-completed" });
  finalizeMock.mockResolvedValue(undefined);
});

describe("🔴 ①:build SUCCEEDED ⇒ reconciler 自动 finalize(不需人点)", () => {
  it("携 exact fence(operation 自己的 buildId/epoch/hash/startedAt)调 finalizeTargetResources", async () => {
    getTargetRawMock.mockResolvedValue(item());
    readBuildStatusMock.mockResolvedValue({ phase: "SUCCEEDED", stacks: [], logsTail: "", observedVersion: null });

    const out = await reconcileOneTarget("tgt_usw2_a");

    expect(finalizeMock).toHaveBeenCalledTimes(1);
    expect(finalizeMock.mock.calls[0][0]).toBe("tgt_usw2_a");
    expect(finalizeMock.mock.calls[0][1].fence).toMatchObject({
      kind: "deploy",
      operationId: OP,
      lockEpoch: 4,
      openSnapshotHash: HASH,
      buildId: "b_2b",
      startedAt: CANON,
      fromPhase: "ready",
      buildPhase: "SUCCEEDED",
      region: "us-west-2",
    });
    expect(out.finalized).toBe(true);
    expect(out.evidenceKind).toBe("deploy");
    // 🔴 成功路不得报"需人工恢复"(否则页面会在正常完成时弹恢复入口)
    expect(out.recovery).toBeUndefined();
    // 🔴 只查 operation 自己的 buildId(禁 lastBuildId 补洞)
    expect(readBuildStatusMock).toHaveBeenCalledWith(expect.objectContaining({ targetId: "tgt_usw2_a" }), "b_2b");
  });
});

describe("🔴 ② 失败路:只分类,绝不落锤", () => {
  /**
   * 🔴 断言这一轮里没有任何"清锁/清 operation"的 DDB 写(reconciler 无权做这件事)。
   *
   * 【第一版是**近乎恒绿**的假门禁,复审揪出,这里重写】
   *   ① 只 for 循环遍历 updates 而没断"updates 必须为空" ⇒ 失败路上一条写都不产生时,循环零次 = 空断言;
   *   ② 正则写成 `/REMOVE[^]*deployLockToken/` 只咬**字面属性名**,而真正的失败写入方发的是
   *      `REMOVE #token, #expiry, #owner`(别名)⇒ 真回归会从别名那侧整条漏网。
   *   ⇒ 现在:显式断"零清锁写",并用**别名与字面量都覆盖**的判据,外加自检样本证明它会咬。
   */
  const LOCK_CLEAR_RE = /REMOVE[\s\S]*?(deployLockToken|#token)/;
  function expectNoLockClearingWrite() {
    // 自检:证明判据能咬住真实的两种写法(否则这条门禁又是恒绿的)
    expect(LOCK_CLEAR_RE.test("SET #o = :obs REMOVE #token, #expiry, #owner")).toBe(true);
    expect(LOCK_CLEAR_RE.test("SET x = :y REMOVE deployLockToken, deployLockExpiresAt")).toBe(true);
    expect(LOCK_CLEAR_RE.test("SET #o = :obs, #st = :status")).toBe(false);

    const updates = ddbSendMock.mock.calls
      .map((c) => (c[0] as { input?: { UpdateExpression?: string } }).input?.UpdateExpression ?? "")
      .filter((u) => u.length > 0);
    // 🔴 显式断"零写" —— 失败路上 reconciler 连 telemetry 都不该发(有 operation ⇒ 窄通道跳过)
    expect(updates.filter((u) => LOCK_CLEAR_RE.test(u)), "reconciler 发出了清锁写 —— 违审核 §19.8 第 5 条").toEqual([]);
    expect(updates, "失败路 reconciler 不该产生任何 lifecycle 写").toEqual([]);
    expect(finalizeMock, "失败路不得 finalize").not.toHaveBeenCalled();
  }

  it("build FAILED ⇒ recovery=terminal-build-failure,零 finalize、零清锁写", async () => {
    getTargetRawMock.mockResolvedValue(item());
    readBuildStatusMock.mockResolvedValue({ phase: "FAILED", stacks: [], logsTail: "", observedVersion: null });
    reconcileAfterProbeMock.mockResolvedValue({ advanced: false, reason: "deployment-not-finalized" });

    const out = await reconcileOneTarget("tgt_usw2_a");

    expect(out.recovery).toMatchObject({
      kind: "terminal-build-failure",
      operationId: OP,
      lockEpoch: 4,
      buildId: "b_2b",
      buildStatus: "FAILED",
      recoverableNow: true,
    });
    expect(out.finalized).toBe(false);
    expect(String(out.finalizeError)).toContain("FAILED");
    expectNoLockClearingWrite();
  });

  it("build IN_PROGRESS ⇒ **不报**需恢复(那是正常等待窗,不是卡死)", async () => {
    getTargetRawMock.mockResolvedValue(item());
    readBuildStatusMock.mockResolvedValue({ phase: "IN_PROGRESS", stacks: [], logsTail: "", observedVersion: null });
    reconcileAfterProbeMock.mockResolvedValue({ advanced: false, reason: "deployment-not-finalized" });

    const out = await reconcileOneTarget("tgt_usw2_a");
    expect(out.recovery).toBeUndefined();
    expectNoLockClearingWrite();
  });

  it("无 buildId 且**窗内**(刚开的会话)⇒ start-uncertain,recoverableNow=false + 给出 earliestRecoverAt", async () => {
    // startedAt 取"刚刚":安全窗 = startedAt + 项目超时 + 裕度 ⇒ 现在必然还没到。
    const justNow = new Date(Date.now() - 60_000).toISOString();
    getTargetRawMock.mockResolvedValue(item({}, { buildId: undefined, startedAt: justNow }));
    reconcileAfterProbeMock.mockResolvedValue({ advanced: false, reason: "deployment-not-finalized" });

    const out = await reconcileOneTarget("tgt_usw2_a");
    expect(out.recovery).toMatchObject({ kind: "start-uncertain", buildStatus: "no-build", recoverableNow: false });
    expect(out.recovery?.earliestRecoverAt).toBe(
      new Date(Date.parse(justNow) + 2 * 60 * 60 * 1000 + 5 * 60 * 1000).toISOString()
    );
    // 无 buildId ⇒ 压根不查 CodeBuild(没有可查的对象)
    expect(readBuildStatusMock).not.toHaveBeenCalled();
    expectNoLockClearingWrite();
  });

  it("无 buildId 且**过窗**(陈旧会话)⇒ recoverableNow=true(结构性:build 早被项目超时杀掉了)", async () => {
    getTargetRawMock.mockResolvedValue(item({}, { buildId: undefined, startedAt: CANON })); // 远早于现在
    reconcileAfterProbeMock.mockResolvedValue({ advanced: false, reason: "deployment-not-finalized" });

    const out = await reconcileOneTarget("tgt_usw2_a");
    expect(out.recovery).toMatchObject({ kind: "start-uncertain", buildStatus: "no-build", recoverableNow: true });
    expectNoLockClearingWrite();
  });

  it("attach 丢响应 ⇒ attach-ambiguous,查候选 buildId 定性(候选终态 ⇒ 可恢复)", async () => {
    getTargetRawMock.mockResolvedValue(
      item({}, { buildId: undefined, attachUncertain: { at: CANON, message: "lost", candidateBuildId: "b_cand" } })
    );
    readBuildStatusMock.mockResolvedValue({ phase: "FAILED", stacks: [], logsTail: "", observedVersion: null });
    reconcileAfterProbeMock.mockResolvedValue({ advanced: false, reason: "deployment-not-finalized" });

    const out = await reconcileOneTarget("tgt_usw2_a");
    expect(out.recovery).toMatchObject({ kind: "attach-ambiguous", buildId: "b_cand", buildStatus: "FAILED", recoverableNow: true });
    expect(readBuildStatusMock).toHaveBeenCalledWith(expect.anything(), "b_cand");
    expectNoLockClearingWrite();
  });

  it("🔴 失败路仍照常刷 probe.at(stale 网不能因为卡住就断)但不写 health 完成态", async () => {
    getTargetRawMock.mockResolvedValue(item());
    readBuildStatusMock.mockResolvedValue({ phase: "STOPPED", stacks: [], logsTail: "", observedVersion: null });
    reconcileAfterProbeMock.mockResolvedValue({ advanced: false, reason: "deployment-not-finalized" });

    await reconcileOneTarget("tgt_usw2_a");
    expect(writeProbeResultMock).toHaveBeenCalledWith("tgt_usw2_a", green);
    // 有在途 operation ⇒ telemetry 窄通道不介入(reason 不是 telemetry-only)
    expect(describeTemplateVersionMock).not.toHaveBeenCalled();
  });
});

// (2026-10-23 …9435 observe 复验抓到):已启用环境点「检测初始化」走的是
//   「不需 finalize」路 ⇒ 此前唯一的记账点 readBuildStatus 根本不会被调 ⇒ 整条完成序零决策,目标区探活全记未归因。
//   修 = reconcileOneTarget 开头就记(不依赖偶然路径);本判据钉「runProbe 被调那一刻账本里已有决策」+「readBuildStatus 确实一次没调」。
describe("🔴 已启用环境(不需 finalize)也在 runProbe 之前记落点决策", () => {
  it("runProbe 被调时 decisions[0] = {tgt_usw2_a, reconcileOneTarget};readBuildStatus 零调用(坐实这条路此前零决策)", async () => {
    const store = {};
    __setRequestStoreProvider(() => store);
    try {
      deploymentNeedsFinalizeMock.mockReturnValue(false);
      getTargetRawMock.mockResolvedValue(
        item({ status: "active", lockEpoch: 4, deployLockToken: undefined, deployLockOperationId: undefined, deployLockExpiresAt: undefined,
               observed: { phase: "ready", health: "healthy", components: ["core"], probe: green } })
      );
      let atProbe = -1;
      runProbeMock.mockImplementation(async () => {
        atProbe = decisionsOfCurrentRequest().decisions.length;
        return green;
      });
      await reconcileOneTarget("tgt_usw2_a");
      expect(readBuildStatusMock).not.toHaveBeenCalled();
      expect(runProbeMock).toHaveBeenCalledTimes(1);
      expect(atProbe, "runProbe 被调时账本里还没有决策").toBeGreaterThanOrEqual(1);
      expect(decisionsOfCurrentRequest().decisions[0]).toEqual({ targetId: "tgt_usw2_a", via: RECONCILE_PLACE_VIA });
    } finally {
      __setRequestStoreProvider(null);
    }
  });
});
