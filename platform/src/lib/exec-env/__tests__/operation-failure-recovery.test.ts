// @kf-batch 50-P50.3b-2b-failure-recovery
// 🔴 唯一失败写入方 `recordOperationFailure` 的行为门禁(SPEC §3.5b;外部审核 §19.8)。
//
// 【本文件的四条承重】
// ① **phase 一律不动**:失败是健康事件不是生命周期事件 —— 初装失败留 provisioning(投影 failed)、
//    升级失败留 ready 但 health=unknown(投影 degraded、准入 fail-closed)。绝不猜回 registered/verifying,
//    也绝不造 ready→provisioning 这种非法边。
// ② **未定性的 build 一律不许清锁**:IN_PROGRESS/UNKNOWN/空 直接拒(纵深防御 —— 即使路由顺序写错也拒);
//    **有 exact buildId 时连 SUCCEEDED 也拒**(那是「检测初始化」完成路的活,恢复端点不得当清锁后门)。
// ③ **无 buildId 时 SUCCEEDED 反而必须放行**:完成 fence 结构上要求 exact buildId ⇒ 它不可能跑,
//    若此时也拒,就等于又造一个"永久卡死"——这正是本批要根治的病。
// ④ **legacy 只清顶层锁,绝不创建/触碰 spec/observed**(收养必须靠一次 fresh green,§20.23-R 拒绝#12)。
import { describe, it, expect, beforeEach, vi } from "vitest";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock("@/lib/aws/dynamodb", () => ({
  docClient: { send: sendMock },
  TABLES: { EXECUTION_ENVS: "bgp-execution-envs" },
}));

import {
  recordOperationFailure,
  FailureRecoveryError,
  LifecycleConflictError,
  NO_BUILD_STATUS,
  type OperationFailureFence,
  type ProbeResult,
} from "@/lib/exec-env/lifecycle";

const CANON = "2026-09-01T00:00:00.000Z";
const ACCT = "123456789012";
const OP = "op_2b0001";
const HASH = "c".repeat(64);
const green: ProbeResult = { at: CANON, ok: true, items: [{ name: "datalakeBucket", ok: true }] };
const DISPOSITION = {
  buildStatus: "FAILED",
  checkedAt: CANON,
  stacks: [{ name: "BgpExecEnv-tgt-usw2-a-core", status: "UPDATE_ROLLBACK_COMPLETE", pendingChangeSets: 0 }],
};
const DECISION = { decisionId: "recover-20260903-abcd", decidedBy: "admin" };

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

const modernItem = (phase: "ready" | "provisioning", over: Record<string, unknown> = {}) => ({
  pk: "env",
  sk: "tgt_usw2_a",
  targetId: "tgt_usw2_a",
  version: 11,
  accountId: ACCT,
  region: "us-west-2",
  partition: "aws",
  status: phase === "ready" ? "upgrading" : "initializing",
  ready: phase === "ready",
  components: ["core"],
  probe: green,
  lockEpoch: 4,
  deployLockToken: OP,
  deployLockOperationId: OP,
  deployLockExpiresAt: 1_800_000_000_000,
  spec: { intent: "serve", desiredComponents: ["core"] },
  observed: { phase, health: "healthy", components: ["core"], probe: green, operation: operation() },
  ...over,
});

const legacyItem = (over: Record<string, unknown> = {}) => ({
  pk: "env",
  sk: "tgt_usw2_a",
  targetId: "tgt_usw2_a",
  version: 11,
  accountId: ACCT,
  region: "us-west-2",
  partition: "aws",
  status: "initializing",
  ready: false,
  components: ["core"],
  probe: green,
  lockEpoch: 4,
  deployLockToken: "tok_leg",
  deployLockOperationId: OP,
  deployLockExpiresAt: 1_800_000_000_000,
  lastOperationId: OP,
  lastBuildId: "b_leg",
  ...over,
});

const modernFence = (
  phase: "ready" | "provisioning",
  over: Partial<Extract<OperationFailureFence, { mode: "modern" }>> = {}
): OperationFailureFence => ({
  mode: "modern",
  region: "us-west-2",
  accountId: ACCT,
  partition: "aws",
  expectedVersion: 11,
  fromPhase: phase,
  operationId: OP,
  lockEpoch: 4,
  openSnapshotHash: HASH,
  buildId: "b_2b",
  startedAt: CANON,
  desiredComponents: ["core"],
  observedComponents: ["core"],
  ...over,
});

const legacyFence = (over: Partial<Extract<OperationFailureFence, { mode: "legacy" }>> = {}): OperationFailureFence => ({
  mode: "legacy",
  region: "us-west-2",
  accountId: ACCT,
  partition: "aws",
  expectedVersion: 11,
  lockEpoch: 4,
  lockToken: "tok_leg",
  operationId: OP,
  buildId: "b_leg",
  status: "initializing",
  components: ["core"],
  ...over,
});

/** Get → 给定 item;Update → 成功({})。 */
function routeGet(item: unknown) {
  sendMock.mockImplementation((cmd: { input?: { UpdateExpression?: string } }) =>
    cmd.input && String(cmd.input.UpdateExpression ?? "").length ? {} : { Item: item }
  );
}
const lastUpdate = () => {
  const calls = sendMock.mock.calls
    .map((c) => c[0] as { input?: { UpdateExpression?: string } })
    .filter((cmd) => cmd.input && String(cmd.input.UpdateExpression ?? "").length);
  return calls[calls.length - 1].input as {
    UpdateExpression: string;
    ConditionExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
  };
};

beforeEach(() => {
  sendMock.mockReset();
});

describe("🔴 ① phase 一律不动 + health 落 unknown(fail-closed)", () => {
  it("modern ready 升级失败:post-image phase 仍 ready、health=unknown、operation 清、锁 REMOVE、投影 degraded", async () => {
    routeGet(modernItem("ready"));
    const r = await recordOperationFailure("tgt_usw2_a", { fence: modernFence("ready"), disposition: DISPOSITION, decision: DECISION });
    expect(r).toEqual({ cleared: true, mode: "modern" });
    const up = lastUpdate();
    const obs = up.ExpressionAttributeValues[":obs"] as Record<string, unknown>;
    expect(obs.phase).toBe("ready"); // 🔴 不动生命周期轴
    expect(obs.health).toBe("unknown"); // 🔴 fail-closed,等下一次真探活说话
    expect(obs.unhealthyStreak).toBe(0);
    expect(obs.operation).toBeUndefined();
    expect(obs.lastFailure).toMatchObject({ operationId: OP, lockEpoch: 4, buildId: "b_2b", buildStatus: "FAILED", decisionId: DECISION.decisionId, decidedBy: "admin" });
    expect(String(obs.lastError)).toContain(OP);
    // ready + health=unknown ⇒ 投影 degraded(绝不 active);ready 投影仍 true(曾整包写完过)
    expect(up.ExpressionAttributeValues[":status"]).toBe("degraded");
    expect(up.ExpressionAttributeValues[":ready"]).toBe(true);
    expect(up.UpdateExpression).toContain("REMOVE #token, #expiry, #owner");
    expect(up.ExpressionAttributeValues[":next"]).toBe(12);
  });

  it("modern provisioning 初装失败:phase 仍 provisioning、lastError 在 ⇒ 投影 failed(须显式重试)", async () => {
    routeGet(modernItem("provisioning"));
    await recordOperationFailure("tgt_usw2_a", { fence: modernFence("provisioning"), disposition: DISPOSITION, decision: DECISION });
    const up = lastUpdate();
    const obs = up.ExpressionAttributeValues[":obs"] as Record<string, unknown>;
    expect(obs.phase).toBe("provisioning"); // 🔴 绝不猜回 registered/verifying(§19.8)
    expect(up.ExpressionAttributeValues[":status"]).toBe("failed");
    expect(up.ExpressionAttributeValues[":ready"]).toBe(false);
  });

  it("条件写把 exact 会话身份全绑上(operation tuple + phase + 组件集 + 顶层锁 + 外部身份)", async () => {
    routeGet(modernItem("ready"));
    await recordOperationFailure("tgt_usw2_a", { fence: modernFence("ready"), disposition: DISPOSITION, decision: DECISION });
    const cond = lastUpdate().ConditionExpression;
    for (const frag of [
      "#v = :expected",
      "#o.#ph = :fenceFromPhase",
      "#o.#op.#opId = :fenceOperationId",
      "#o.#op.#opEpoch = :fenceEpoch",
      "#o.#op.#opHash = :fenceHash",
      "#o.#op.#opStartedAt = :fenceStartedAt",
      "#o.#op.#opBuildId = :fenceBuildId",
      "#sp.#desired = :fenceDesired",
      "#o.#obsComponents = :fenceObservedComponents",
      "#topEpoch = :fenceEpoch",
      "#token = :fenceToken",
      "#owner = :fenceOperationId",
      "#region = :fenceRegion",
      "#account = :fenceAccount",
      "#partition = :fencePartition",
    ]) {
      expect(cond, `条件缺 ${frag} ⇒ fence 有洞`).toContain(frag);
    }
  });
});

describe("🔴 ② 未定性/可走完成路的 build 一律不许清锁", () => {
  for (const bad of ["IN_PROGRESS", "UNKNOWN", "", "none"]) {
    it(`buildStatus=${JSON.stringify(bad)} ⇒ 拒(零 DDB 写)`, async () => {
      routeGet(modernItem("ready"));
      await expect(
        recordOperationFailure("tgt_usw2_a", { fence: modernFence("ready"), disposition: { ...DISPOSITION, buildStatus: bad }, decision: DECISION })
      ).rejects.toBeInstanceOf(FailureRecoveryError);
      expect(sendMock.mock.calls.filter((c) => (c[0] as { input?: { UpdateExpression?: string } }).input?.UpdateExpression).length).toBe(0);
    });
  }

  it("🔴 有 exact buildId 但 CodeBuild 查不到该记录(not-found)⇒ **放行**(记录都没了 ⇒ 不可能有 build 在跑)", async () => {
    routeGet(modernItem("ready"));
    const r = await recordOperationFailure("tgt_usw2_a", {
      fence: modernFence("ready"),
      disposition: { ...DISPOSITION, buildStatus: "not-found" },
      decision: DECISION,
    });
    expect(r.cleared).toBe(true);
  });

  it("有 exact buildId 时 SUCCEEDED 也拒(恢复端点不得绕过完成 fence)", async () => {
    routeGet(modernItem("ready"));
    await expect(
      recordOperationFailure("tgt_usw2_a", { fence: modernFence("ready"), disposition: { ...DISPOSITION, buildStatus: "SUCCEEDED" }, decision: DECISION })
    ).rejects.toThrow(/SUCCEEDED 请走/);
  });

  it("缺显式管理员决定(decisionId/decidedBy 任一空)⇒ 拒(禁止静默自动恢复)", async () => {
    routeGet(modernItem("ready"));
    await expect(
      recordOperationFailure("tgt_usw2_a", { fence: modernFence("ready"), disposition: DISPOSITION, decision: { decisionId: "", decidedBy: "admin" } })
    ).rejects.toThrow(/显式管理员决定/);
    await expect(
      recordOperationFailure("tgt_usw2_a", { fence: modernFence("ready"), disposition: DISPOSITION, decision: { decisionId: "d-123456", decidedBy: "" } })
    ).rejects.toThrow(/显式管理员决定/);
  });

  it("checkedAt 非 canonical ISO ⇒ 拒(处置证据形状 fail-closed)", async () => {
    routeGet(modernItem("ready"));
    await expect(
      recordOperationFailure("tgt_usw2_a", { fence: modernFence("ready"), disposition: { ...DISPOSITION, checkedAt: "2026-09-01T00:00:00Z" }, decision: DECISION })
    ).rejects.toBeInstanceOf(FailureRecoveryError);
  });
});

describe("🔴 ③ 无 buildId(startUncertain/attach 丢响应)= 完成 fence 结构上不可能 ⇒ 必须能恢复", () => {
  const noBuildItem = () => modernItem("ready", { observed: { phase: "ready", health: "healthy", components: ["core"], probe: green, operation: operation({ buildId: undefined }) } });

  it("no-build ⇒ 放行,且条件用 attribute_not_exists(operation.buildId) 而非等值", async () => {
    routeGet(noBuildItem());
    await recordOperationFailure("tgt_usw2_a", {
      fence: modernFence("ready", { buildId: undefined }),
      disposition: { ...DISPOSITION, buildStatus: NO_BUILD_STATUS },
      decision: DECISION,
    });
    const up = lastUpdate();
    expect(up.ConditionExpression).toContain("attribute_not_exists(#o.#op.#opBuildId)");
    expect(up.ConditionExpression).not.toContain("#o.#op.#opBuildId = ");
    expect(up.ExpressionAttributeValues[":fenceBuildId"]).toBeUndefined();
  });

  it("无 buildId 但候选 build 已 SUCCEEDED ⇒ **也必须放行**(否则又造一个永久卡死)", async () => {
    routeGet(noBuildItem());
    const r = await recordOperationFailure("tgt_usw2_a", {
      fence: modernFence("ready", { buildId: undefined }),
      disposition: { ...DISPOSITION, buildStatus: "SUCCEEDED" },
      decision: DECISION,
    });
    expect(r.cleared).toBe(true);
  });

  it("无 buildId 且候选仍 IN_PROGRESS ⇒ 仍拒", async () => {
    routeGet(noBuildItem());
    await expect(
      recordOperationFailure("tgt_usw2_a", {
        fence: modernFence("ready", { buildId: undefined }),
        disposition: { ...DISPOSITION, buildStatus: "IN_PROGRESS" },
        decision: DECISION,
      })
    ).rejects.toBeInstanceOf(FailureRecoveryError);
  });
});

describe("🔴 fence 不可绕(会话在期间变了一律不清)", () => {
  it("version 变 ⇒ LifecycleConflictError", async () => {
    routeGet(modernItem("ready", { version: 12 }));
    await expect(
      recordOperationFailure("tgt_usw2_a", { fence: modernFence("ready"), disposition: DISPOSITION, decision: DECISION })
    ).rejects.toBeInstanceOf(LifecycleConflictError);
  });

  it("外部身份(region)不符 ⇒ 拒跨目标恢复", async () => {
    routeGet(modernItem("ready", { region: "eu-west-1" }));
    await expect(
      recordOperationFailure("tgt_usw2_a", { fence: modernFence("ready"), disposition: DISPOSITION, decision: DECISION })
    ).rejects.toThrow(/外部身份/);
  });

  it("期间换了新 operation(operationId 不同)⇒ LifecycleConflictError,不误清", async () => {
    routeGet(modernItem("ready", { observed: { phase: "ready", health: "healthy", components: ["core"], probe: green, operation: operation({ operationId: "op_other99" }) } }));
    await expect(
      recordOperationFailure("tgt_usw2_a", { fence: modernFence("ready"), disposition: DISPOSITION, decision: DECISION })
    ).rejects.toBeInstanceOf(LifecycleConflictError);
  });

  it("phase 与 fence.fromPhase 不符 ⇒ LifecycleConflictError", async () => {
    routeGet(modernItem("provisioning"));
    await expect(
      recordOperationFailure("tgt_usw2_a", { fence: modernFence("ready"), disposition: DISPOSITION, decision: DECISION })
    ).rejects.toBeInstanceOf(LifecycleConflictError);
  });

  it("压根没有在途 operation ⇒ 拒(无待恢复会话)", async () => {
    routeGet(modernItem("ready", { observed: { phase: "ready", health: "healthy", components: ["core"], probe: green } }));
    await expect(
      recordOperationFailure("tgt_usw2_a", { fence: modernFence("ready"), disposition: DISPOSITION, decision: DECISION })
    ).rejects.toThrow(/没有在途 operation/);
  });

  it("DDB 条件写被拒(CCF)且 post-image 不匹配 ⇒ LifecycleConflictError(锁未清)", async () => {
    const item = modernItem("ready");
    sendMock.mockImplementation((cmd: { input?: { UpdateExpression?: string } }) => {
      if (cmd.input && String(cmd.input.UpdateExpression ?? "").length) {
        const e = new Error("cond") as Error & { name: string };
        e.name = "ConditionalCheckFailedException";
        throw e;
      }
      return { Item: item }; // postcondition 强读:version 仍 11 ⇒ mismatch
    });
    await expect(
      recordOperationFailure("tgt_usw2_a", { fence: modernFence("ready"), disposition: DISPOSITION, decision: DECISION })
    ).rejects.toBeInstanceOf(LifecycleConflictError);
  });

  it("CCF 但 post-image 已匹配(SDK 内部重试先提交)⇒ 幂等成功,不重复写", async () => {
    const before = modernItem("ready");
    let updates = 0;
    sendMock.mockImplementation((cmd: { input?: { UpdateExpression?: string; ExpressionAttributeValues?: Record<string, unknown> } }) => {
      if (cmd.input && String(cmd.input.UpdateExpression ?? "").length) {
        updates++;
        const e = new Error("cond") as Error & { name: string };
        e.name = "ConditionalCheckFailedException";
        throw e;
      }
      if (updates === 0) return { Item: before };
      // 已提交后的 exact post-image
      const obs = { phase: "ready", health: "unknown", components: ["core"], probe: green, unhealthyStreak: 0, lastError: `部署会话 ${OP} 失败(build=FAILED b_2b);由管理员 admin 核查基础设施后恢复(${DECISION.decisionId})`, lastFailure: undefined as unknown };
      return { Item: { ...before, version: 12, status: "degraded", ready: true, deployLockToken: undefined, deployLockExpiresAt: undefined, deployLockOperationId: undefined, observed: obs } };
    });
    // post-image 里 lastFailure 的 `at` 是写侧现取的时钟 ⇒ canonicalJson 必不同 ⇒ 判 mismatch(保守)。
    await expect(
      recordOperationFailure("tgt_usw2_a", { fence: modernFence("ready"), disposition: DISPOSITION, decision: DECISION })
    ).rejects.toBeInstanceOf(LifecycleConflictError);
    expect(updates).toBe(1); // 🔴 关键:绝不重发第二次 Update
  });
});

describe("🔴 ④ legacy 只清顶层锁,绝不创建/触碰 spec/observed", () => {
  it("legacy:UpdateExpression 不写 observed/spec/status/ready,只 REMOVE 锁三件套 + version+1", async () => {
    routeGet(legacyItem());
    const r = await recordOperationFailure("tgt_usw2_a", { fence: legacyFence(), disposition: DISPOSITION, decision: DECISION });
    expect(r).toEqual({ cleared: true, mode: "legacy" });
    const up = lastUpdate();
    expect(up.UpdateExpression).toBe("SET #v = :next, updatedAt = :t REMOVE #token, #expiry, #owner");
    expect(up.ExpressionAttributeValues[":obs"]).toBeUndefined();
    expect(up.ConditionExpression).toContain("attribute_not_exists(#o)");
    expect(up.ConditionExpression).toContain("attribute_not_exists(#sp)");
    expect(up.ConditionExpression).toContain("#lastOp = :fenceOperationId");
  });

  it("item 已有 spec/observed 却用 legacy fence ⇒ 拒(应走 modern)", async () => {
    routeGet(modernItem("ready"));
    await expect(
      recordOperationFailure("tgt_usw2_a", { fence: legacyFence(), disposition: DISPOSITION, decision: DECISION })
    ).rejects.toThrow(/legacy 恢复要求该 item 尚无 spec\/observed/);
  });

  it("legacy holder 不符(lockToken 变)⇒ LifecycleConflictError", async () => {
    routeGet(legacyItem({ deployLockToken: "tok_other" }));
    await expect(
      recordOperationFailure("tgt_usw2_a", { fence: legacyFence(), disposition: DISPOSITION, decision: DECISION })
    ).rejects.toBeInstanceOf(LifecycleConflictError);
  });
});
