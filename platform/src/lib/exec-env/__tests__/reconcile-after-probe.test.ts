// @kf-batch 50-P50.3b-lifecycle-rootfix
// reconcileAfterProbe(§21.4)—— bug#11 真正闭合的**核心完成命令**的正/反面单测(§11.2)。
//
// 正面:modern 初装(provisioning→verifying)/ ready 升级完成(ready→ready,清 operation ⇒ 回 active)/
//       legacy stable·e99·initial 收养。
// 反面(§11.2):任何证据在途变化都**不得晋级**——version 变 / 无 operation(none)/ operation 出现 /
//       probe-input 变 / operation 证据变 / desired 变 / observed 变 / probe 红 / finalize 未完 /
//       partial green / desired≠observed / legacy 被替换 / legacy 快照变 / stable 残留锁 / legacy session 变。
//
// 🔴 涉网依赖用顶层 vi.mock(记忆铁律:动态 import × vi.mock 拦不住)。updateMock=UpdateCommand(transitionPhase 落库),
//    getMock=GetCommand(getTargetRaw + postcondition 强读)。条件写在 mock 里不被求值 ⇒ 正面靠 fence 本地校验通过 + send 成功;
//    反面靠 reconcileAfterProbe 的早退(不进 transitionPhase)⇒ 断 updateMock 未被调用。
import { describe, it, expect, vi, beforeEach } from "vitest";

const getMock = vi.fn();
const updateMock = vi.fn();
vi.mock("@/lib/aws/dynamodb", () => ({
  docClient: {
    send: (cmd: { __kind: string }) => (cmd.__kind === "get" ? getMock(cmd) : updateMock(cmd)),
  },
  TABLES: { EXECUTION_ENVS: "bgp-execution-envs" },
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  GetCommand: class {
    __kind = "get";
    constructor(public input: Record<string, unknown>) {}
  },
  UpdateCommand: class {
    __kind = "update";
    constructor(public input: Record<string, unknown>) {}
  },
}));

import { reconcileAfterProbe, probeInputOf, type ProbeLifecycleEvidence, type ExecutionTarget } from "@/lib/exec-env/registry";
import type { ProbeResult } from "@/lib/exec-env/lifecycle";

const TID = "tgt_usw2_a";
const ACCT = "123456789012";
const CANON = "2026-09-01T00:00:00.000Z";
const HASH = "a".repeat(64);

const green = (items: Array<{ name: string; ok: boolean; error?: string }> = [{ name: "datalakeBucket", ok: true }]): ProbeResult => ({
  at: CANON,
  ok: items.every((i) => i.ok),
  items,
});
const GREEN_CORE = green();
const GREEN_CORE_DMS = green([{ name: "datalakeBucket", ok: true }, { name: "dms:subnet-group", ok: true }]);

function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pk: "env",
    sk: TID,
    targetId: TID,
    partition: "aws",
    accountId: ACCT,
    region: "us-west-2",
    version: 5,
    components: ["core"],
    ...over,
  };
}

/** modern item,observed.operation = 一次在途 deploy(顶层锁镜像一致)。 */
function modernDeployItem(over: Record<string, unknown> = {}, opOver: Record<string, unknown> = {}) {
  const operation = { kind: "deploy", operationId: "op_1", lockEpoch: 2, openSnapshotHash: HASH, buildId: "b_1", startedAt: CANON, disruptive: true, ...opOver };
  return base({
    lockEpoch: 2,
    deployLockToken: "op_1",
    deployLockOperationId: "op_1",
    lastOperationId: "op_1",
    lastBuildId: "b_1",
    spec: { intent: "serve", desiredComponents: ["core"] },
    observed: { phase: "provisioning", health: "unknown", components: ["core"], operation },
    ...over,
  });
}

function deployEvidence(item: Record<string, unknown>, over: Record<string, unknown> = {}): ProbeLifecycleEvidence {
  const observed = item.observed as { phase: string; components: string[]; operation: Record<string, unknown> };
  const spec = item.spec as { desiredComponents: string[] };
  const op = observed.operation;
  return {
    kind: "deploy",
    expectedVersion: item.version as number,
    fromPhase: observed.phase,
    operationId: op.operationId as string,
    lockEpoch: op.lockEpoch as number,
    openSnapshotHash: op.openSnapshotHash as string,
    buildId: op.buildId as string,
    startedAt: op.startedAt as string,
    desiredComponents: [...spec.desiredComponents],
    observedComponents: [...observed.components],
    probeInput: probeInputOf(item as unknown as ExecutionTarget),
    ...over,
  } as ProbeLifecycleEvidence;
}

/** legacy item(无双轴)。 */
function legacyItem(over: Record<string, unknown> = {}) {
  return base({ status: "active", ready: true, components: ["core"], ...over });
}

beforeEach(() => {
  vi.clearAllMocks();
  updateMock.mockResolvedValue({});
});

describe("reconcileAfterProbe —— 正面完成路", () => {
  it("modern 初装(provisioning→verifying):清 operation,写 verifying + 本次 probe,advanced=true", async () => {
    const item = modernDeployItem();
    getMock.mockResolvedValue({ Item: item });
    const r = await reconcileAfterProbe(TID, { probe: GREEN_CORE, finalized: true, evidence: deployEvidence(item) });
    expect(r.advanced).toBe(true);
    const input = updateMock.mock.calls[0][0].input;
    expect(input.ExpressionAttributeValues[":obs"].phase).toBe("verifying");
    expect(input.ExpressionAttributeValues[":obs"].operation).toBeUndefined(); // 🔴 operation 清除
    expect(input.UpdateExpression).toContain("REMOVE"); // 🔴 顶层 deploy 锁同写清
  });

  it("🔴 ready 升级完成(ready→ready):清 operation ⇒ 物化回 active(bug#11 根治核心)", async () => {
    const item = modernDeployItem({
      spec: { intent: "serve", desiredComponents: ["core", "dms"] },
      observed: {
        phase: "ready",
        health: "healthy",
        components: ["core", "dms"],
        operation: { kind: "deploy", operationId: "op_1", lockEpoch: 2, openSnapshotHash: HASH, buildId: "b_1", startedAt: CANON, disruptive: true },
      },
      components: ["core", "dms"],
    });
    getMock.mockResolvedValue({ Item: item });
    const r = await reconcileAfterProbe(TID, { probe: GREEN_CORE_DMS, finalized: true, evidence: deployEvidence(item) });
    expect(r.advanced).toBe(true);
    const input = updateMock.mock.calls[0][0].input;
    expect(input.ExpressionAttributeValues[":obs"].phase).toBe("ready");
    expect(input.ExpressionAttributeValues[":obs"].operation).toBeUndefined();
    expect(input.ExpressionAttributeValues[":status"]).toBe("active"); // ready+healthy+无op ⇒ active
  });

  it("legacy stable 收养(active∧ready∧无锁)⇒ ready,ifAbsent 首写", async () => {
    const item = legacyItem();
    getMock.mockResolvedValue({ Item: item });
    const evidence: ProbeLifecycleEvidence = {
      kind: "legacy",
      expectedVersion: 5,
      status: "active",
      ready: true,
      components: ["core"],
      probeInput: probeInputOf(item as unknown as ExecutionTarget),
      mode: "stable",
    };
    const r = await reconcileAfterProbe(TID, { probe: GREEN_CORE, finalized: true, evidence });
    expect(r.advanced).toBe(true);
    const input = updateMock.mock.calls[0][0].input;
    expect(input.ConditionExpression).toContain("attribute_not_exists(#o)"); // ifAbsent 首写收养
    expect(input.ExpressionAttributeValues[":obs"].phase).toBe("ready");
  });

  it("legacy e99 收养(initializing∧ready∧持锁 session)⇒ ready(bug#11 真环境 tgt_usw2_a 形态)", async () => {
    const item = legacyItem({
      status: "initializing",
      ready: true,
      lockEpoch: 3,
      deployLockToken: "op_e",
      deployLockOperationId: "op_e",
      lastOperationId: "op_e",
      lastBuildId: "b_e",
    });
    getMock.mockResolvedValue({ Item: item });
    const evidence: ProbeLifecycleEvidence = {
      kind: "legacy",
      expectedVersion: 5,
      status: "initializing",
      ready: true,
      components: ["core"],
      probeInput: probeInputOf(item as unknown as ExecutionTarget),
      mode: "e99",
      legacySession: { lockEpoch: 3, lockToken: "op_e", operationId: "op_e", buildId: "b_e" },
    };
    const r = await reconcileAfterProbe(TID, { probe: GREEN_CORE, finalized: true, evidence });
    expect(r.advanced).toBe(true);
    const input = updateMock.mock.calls[0][0].input;
    expect(input.ExpressionAttributeValues[":obs"].phase).toBe("ready");
    expect(input.UpdateExpression).toContain("REMOVE"); // e99 清 session 锁
  });

  it("legacy initial 收养(!ready∧持锁)⇒ verifying(初装完成,待人工 enable,不跳过)", async () => {
    const item = legacyItem({
      status: "initializing",
      ready: false,
      lockEpoch: 3,
      deployLockToken: "op_i",
      deployLockOperationId: "op_i",
      lastOperationId: "op_i",
      lastBuildId: "b_i",
    });
    getMock.mockResolvedValue({ Item: item });
    const evidence: ProbeLifecycleEvidence = {
      kind: "legacy",
      expectedVersion: 5,
      status: "initializing",
      ready: false,
      components: ["core"],
      probeInput: probeInputOf(item as unknown as ExecutionTarget),
      mode: "initial",
      legacySession: { lockEpoch: 3, lockToken: "op_i", operationId: "op_i", buildId: "b_i" },
    };
    const r = await reconcileAfterProbe(TID, { probe: GREEN_CORE, finalized: true, evidence });
    expect(r.advanced).toBe(true);
    expect(updateMock.mock.calls[0][0].input.ExpressionAttributeValues[":obs"].phase).toBe("verifying");
  });
});

describe("reconcileAfterProbe —— 反面:任何证据在途变化都不晋级(§11.2)", () => {
  const expectNoAdvance = async (item: Record<string, unknown>, input: { probe: ProbeResult; finalized: boolean; evidence: ProbeLifecycleEvidence }, reasonRe: RegExp) => {
    getMock.mockResolvedValue({ Item: item });
    const r = await reconcileAfterProbe(TID, input);
    expect(r.advanced).toBe(false);
    expect(r.reason ?? "").toMatch(reasonRe);
    expect(updateMock, "不晋级时绝不进 transitionPhase").not.toHaveBeenCalled();
  };

  it("version 变(probe 期间有人开/换 operation ⇒ version 已变)", async () => {
    const item = modernDeployItem({ version: 6 });
    await expectNoAdvance(item, { probe: GREEN_CORE, finalized: true, evidence: deployEvidence(item, { expectedVersion: 5 }) }, /evidence-version-changed/);
  });

  it("kind=none(初读无 operation)⇒ telemetry-only,只写 probe 不晋级", async () => {
    const item = legacyItem();
    await expectNoAdvance(item, { probe: GREEN_CORE, finalized: true, evidence: { kind: "none", expectedVersion: 5 } }, /telemetry-only/);
  });

  it("🔴 kind=none 但 current 已冒出 operation ⇒ operation-appeared(即使 version 没涨也再查一次)", async () => {
    const item = modernDeployItem();
    await expectNoAdvance(item, { probe: GREEN_CORE, finalized: true, evidence: { kind: "none", expectedVersion: 5 } }, /operation-appeared/);
  });

  it("probe-input 变(region 与快照不符)⇒ probe-input-changed", async () => {
    const item = modernDeployItem();
    const ev = deployEvidence(item);
    ev.probeInput = { ...ev.probeInput, region: "eu-west-1" };
    await expectNoAdvance(item, { probe: GREEN_CORE, finalized: true, evidence: ev }, /probe-input-changed/);
  });

  it("operation 证据变(operationId 不符)⇒ operation-evidence-changed", async () => {
    const item = modernDeployItem();
    await expectNoAdvance(item, { probe: GREEN_CORE, finalized: true, evidence: deployEvidence(item, { operationId: "op_OTHER" }) }, /operation-evidence-changed/);
  });

  it("desired 变(probe 期间 spec 改)⇒ desired-changed", async () => {
    const item = modernDeployItem();
    await expectNoAdvance(item, { probe: GREEN_CORE, finalized: true, evidence: deployEvidence(item, { desiredComponents: ["core", "dms"] }) }, /desired-changed|observed-not-desired|desired-not-observed/);
  });

  it("probe 红 ⇒ probe-red(不晋级)", async () => {
    const item = modernDeployItem();
    const red = green([{ name: "datalakeBucket", ok: false, error: "gone" }]);
    await expectNoAdvance(item, { probe: red, finalized: true, evidence: deployEvidence(item) }, /probe-red/);
  });

  it("finalize 未完成 ⇒ finalize-not-complete(不晋级)", async () => {
    const item = modernDeployItem();
    await expectNoAdvance(item, { probe: GREEN_CORE, finalized: false, evidence: deployEvidence(item) }, /finalize-not-complete/);
  });

  it("🔴 partial green(声称 core+dms 但 probe 只覆盖 core)⇒ probe-coverage-mismatch", async () => {
    const item = modernDeployItem({
      spec: { intent: "serve", desiredComponents: ["core", "dms"] },
      observed: {
        phase: "provisioning",
        health: "unknown",
        components: ["core", "dms"],
        operation: { kind: "deploy", operationId: "op_1", lockEpoch: 2, openSnapshotHash: HASH, buildId: "b_1", startedAt: CANON, disruptive: true },
      },
      components: ["core", "dms"],
    });
    // probe 只探了 core 一项且绿(ok=true),但组件集含 dms ⇒ 未精确覆盖
    await expectNoAdvance(item, { probe: GREEN_CORE, finalized: true, evidence: deployEvidence(item) }, /probe-coverage-mismatch/);
  });

  it("legacy 被 modern 替换(probe 后冒出双轴)⇒ legacy-replaced", async () => {
    const item = base({ spec: { intent: "serve", desiredComponents: ["core"] }, observed: { phase: "ready", health: "healthy", components: ["core"] } });
    const evidence: ProbeLifecycleEvidence = { kind: "legacy", expectedVersion: 5, status: "active", ready: true, components: ["core"], probeInput: probeInputOf(item as unknown as ExecutionTarget), mode: "stable" };
    await expectNoAdvance(item, { probe: GREEN_CORE, finalized: true, evidence }, /legacy-replaced/);
  });

  it("legacy 快照变(status 与证据不符)⇒ legacy-snapshot-changed", async () => {
    const item = legacyItem({ status: "degraded" });
    const evidence: ProbeLifecycleEvidence = { kind: "legacy", expectedVersion: 5, status: "active", ready: true, components: ["core"], probeInput: probeInputOf(item as unknown as ExecutionTarget), mode: "stable" };
    await expectNoAdvance(item, { probe: GREEN_CORE, finalized: true, evidence }, /legacy-snapshot-changed/);
  });

  it("🔴 stable legacy 却有残留锁 ⇒ stable-legacy-has-residual-lock(不凭 stable 清别人的锁)", async () => {
    const item = legacyItem({ deployLockToken: "op_x", deployLockOperationId: "op_x", lockEpoch: 9 });
    const evidence: ProbeLifecycleEvidence = { kind: "legacy", expectedVersion: 5, status: "active", ready: true, components: ["core"], probeInput: probeInputOf(item as unknown as ExecutionTarget), mode: "stable" };
    await expectNoAdvance(item, { probe: GREEN_CORE, finalized: true, evidence }, /stable-legacy-has-residual-lock/);
  });

  it("legacy session 证据变(锁 token 不符)⇒ legacy-session-evidence-changed", async () => {
    const item = legacyItem({ status: "initializing", ready: true, lockEpoch: 3, deployLockToken: "op_e", deployLockOperationId: "op_e", lastOperationId: "op_e", lastBuildId: "b_e" });
    const evidence: ProbeLifecycleEvidence = {
      kind: "legacy",
      expectedVersion: 5,
      status: "initializing",
      ready: true,
      components: ["core"],
      probeInput: probeInputOf(item as unknown as ExecutionTarget),
      mode: "e99",
      legacySession: { lockEpoch: 3, lockToken: "op_DIFFERENT", operationId: "op_e", buildId: "b_e" },
    };
    await expectNoAdvance(item, { probe: GREEN_CORE, finalized: true, evidence }, /legacy-session-evidence-changed/);
  });
});
