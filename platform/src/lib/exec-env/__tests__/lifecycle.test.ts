// @kf-batch 50-P50.3b-lifecycle-rootfix
// lifecycle.ts 纯核心的单测 —— 这些断言**同时是本批的门禁**(转移表全覆盖 / 投影全函数且旧 10 态全可达 /
// 收养自愈 / 单写通道条件写)。合同 SPEC §1.1 v3.15,台账 DESIGN §20.23。
//
// 🔴 涉网依赖(docClient)用**顶层 vi.mock + vi.hoisted**(记忆铁律:动态 import × vi.mock 拦不住、
//    会拿本机凭证真打 AWS;vi.hoisted 解 TDZ)。
import { describe, it, expect, beforeEach, vi } from "vitest";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock("@/lib/aws/dynamodb", () => ({
  docClient: { send: sendMock },
  TABLES: { EXECUTION_ENVS: "bgp-execution-envs" },
}));

import {
  TARGET_PHASES,
  PHASE_EDGES,
  isValidPhaseTransition,
  deriveStatusProjection,
  deriveReady,
  serviceabilityReason,
  adoptLegacy,
  specObservedOf,
  classifyDescriptor,
  DescriptorInvalidError,
  transitionPhase,
  PhaseTransitionError,
  LifecycleConflictError,
  type TargetPhase,
  type TargetSpec,
  type TargetObserved,
  type ProbeResult,
  type ProbeInputSnapshot,
  type DeploymentCompletionFence,
  type LegacyCompletionFence,
  type EnableLifecycleFence,
} from "@/lib/exec-env/lifecycle";
import { TARGET_STATUSES, type ExecutionTarget, type TargetStatus } from "@/lib/exec-env/registry";

const serve: TargetSpec = { intent: "serve", desiredComponents: ["core"] };
function obs(over: Partial<TargetObserved> = {}): TargetObserved {
  return { phase: "ready", health: "healthy", components: ["core"], ...over };
}

describe("PHASE_EDGES 权威转移表(门禁级)", () => {
  it("每个 TARGET_PHASES 成员都有条目,且边目标都是合法 phase", () => {
    for (const p of TARGET_PHASES) {
      expect(PHASE_EDGES[p], `phase ${p} 无转移表条目`).toBeDefined();
      for (const to of PHASE_EDGES[p]) {
        expect(TARGET_PHASES, `${p}→${to} 的目标不是合法 phase`).toContain(to);
      }
    }
  });

  it("gone 是终态(无出边)", () => {
    expect(PHASE_EDGES.gone).toEqual([]);
  });

  it("🔴 表里没有 `ready→provisioning` 这种老路(升级不改 phase,只置 operation)", () => {
    expect(PHASE_EDGES.ready).not.toContain("provisioning");
    expect(PHASE_EDGES.ready).not.toContain("verifying");
    expect(PHASE_EDGES.ready).not.toContain("initializing" as TargetPhase);
  });

  it("自转合法(幂等回写);非法边拒", () => {
    expect(isValidPhaseTransition("ready", "ready")).toBe(true);
    expect(isValidPhaseTransition("registered", "provisioning")).toBe(true);
    expect(isValidPhaseTransition("registered", "ready")).toBe(false);
    expect(isValidPhaseTransition("gone", "ready")).toBe(false);
  });
});

describe("deriveStatusProjection(全函数 + 旧 10 态全可达)", () => {
  // 每个旧 status 各造一组 (spec, observed) 命中它 —— 这就是"每个 legacy status 可达"的门禁。
  const cases: Array<[TargetStatus, TargetSpec, TargetObserved]> = [
    ["registered", serve, obs({ phase: "registered" })],
    ["failed", serve, obs({ phase: "provisioning", lastError: "boom" })],
    ["initializing", serve, obs({ phase: "provisioning" })],
    ["testing", serve, obs({ phase: "verifying" })],
    ["active", serve, obs({ phase: "ready", health: "healthy" })],
    ["degraded", serve, obs({ phase: "ready", health: "degraded" })],
    [
      "upgrading",
      serve,
      obs({ phase: "ready", operation: { kind: "deploy", operationId: "op_x", lockEpoch: 1, startedAt: "t", disruptive: true } }),
    ],
    ["draining", { intent: "drain", desiredComponents: ["core"] }, obs({ phase: "draining" })],
    ["decommissioning", { intent: "delete", desiredComponents: ["core"] }, obs({ phase: "decommissioning" })],
    ["deleted", { intent: "delete", desiredComponents: ["core"] }, obs({ phase: "gone" })],
  ];

  for (const [want, spec, observed] of cases) {
    it(`投影出 ${want}`, () => {
      expect(deriveStatusProjection(spec, observed)).toBe(want);
    });
  }

  it("🔴 旧 TARGET_STATUSES 的每一个都被上面某组命中(防漏态)", () => {
    const covered = new Set(cases.map(([w]) => w));
    for (const s of TARGET_STATUSES) {
      expect(covered.has(s), `旧 status ${s} 没有任何 (spec,observed) 能投影出来 = 漏态`).toBe(true);
    }
  });

  it("🔴 全函数:每个 phase 都有像(不抛不返 undefined)", () => {
    for (const p of TARGET_PHASES) {
      const r = deriveStatusProjection(serve, obs({ phase: p }));
      expect(TARGET_STATUSES, `phase ${p} 投影出非法 status ${r}`).toContain(r);
    }
  });

  it("upgrading 只由 ready+operation 得出(投影维度;可服务性另判 —— §20.2 任何 operation 在途都不承接)", () => {
    const upg = obs({ phase: "ready", operation: { kind: "deploy", operationId: "op_y", lockEpoch: 1, startedAt: "t", disruptive: false } });
    expect(deriveStatusProjection(serve, upg)).toBe("upgrading");
  });
});

describe("deriveReady 投影", () => {
  it("ready/draining/decommissioning ⇒ true;其余 ⇒ false", () => {
    expect(deriveReady(obs({ phase: "ready" }))).toBe(true);
    expect(deriveReady(obs({ phase: "draining" }))).toBe(true);
    expect(deriveReady(obs({ phase: "decommissioning" }))).toBe(true);
    for (const p of ["registered", "provisioning", "verifying", "gone"] as TargetPhase[]) {
      expect(deriveReady(obs({ phase: p })), `phase ${p} 不该 ready`).toBe(false);
    }
  });
});

describe("serviceabilityReason(准入的正交部分,不含新鲜度)", () => {
  it("serve + ready + 无 disruptive op ⇒ 可服务(null)", () => {
    expect(serviceabilityReason(serve, obs({ phase: "ready" }))).toBeNull();
  });
  it("🔴 degraded 仍可服务(与旧 RUNTIME_USABLE_STATUS={active,degraded} 一致)", () => {
    expect(serviceabilityReason(serve, obs({ phase: "ready", health: "degraded" }))).toBeNull();
  });
  it("intent≠serve ⇒ 拒", () => {
    expect(serviceabilityReason({ intent: "drain", desiredComponents: ["core"] }, obs())).toMatch(/^该执行环境已停止承接/);
  });
  it("phase≠ready ⇒ 拒", () => {
    expect(serviceabilityReason(serve, obs({ phase: "provisioning" }))).toMatch(/phase=provisioning/);
  });
  it("🔴 任何 operation 在途 ⇒ 拒(§20.2/拒绝#13:不只 disruptive —— 损坏数据写 disruptive=false 也拒;P0-E 前恒 true)", () => {
    const disruptive = obs({ phase: "ready", operation: { kind: "deploy", operationId: "op_z", lockEpoch: 1, startedAt: "t", disruptive: true } });
    expect(serviceabilityReason(serve, disruptive)).toMatch(/在途生命周期操作未完成/);
    // 损坏数据把 disruptive 写成 false 也必须拒(不能只判 disruptive===true)
    const forged = obs({ phase: "ready", operation: { kind: "deploy", operationId: "op_z", lockEpoch: 1, startedAt: "t", disruptive: false } });
    expect(serviceabilityReason(serve, forged)).toMatch(/在途生命周期操作未完成/);
  });
  it("🔴 health=unknown ⇒ 拒(矛盾 C fail-closed;仅 healthy/degraded 可服务)", () => {
    expect(serviceabilityReason(serve, obs({ phase: "ready", health: "unknown" }))).toMatch(/health/);
  });
});

describe("adoptLegacy(控制器收养存量,自愈)", () => {
  it("🔴 真环境 tgt_usw2_a 卡死形态(initializing∧ready∧stored probe.ok)⇒ **保守不推 ready**(拒绝#12:不据 stored probe;E-99 只由本次 fresh probe 自愈,Steps 3-4)", () => {
    const legacy = {
      targetId: "tgt_usw2_a",
      status: "initializing" as TargetStatus,
      ready: true,
      components: ["core", "dms", "flink"],
      probe: { at: "2026-09-01T16:00:00Z", ok: true, items: [{ name: "core:datalakeBucket", ok: true }] },
    } as unknown as ExecutionTarget;
    const { spec, observed } = adoptLegacy(legacy);
    expect(observed.phase).toBe("provisioning"); // 🔴 不再据 stored probe 推 ready(fail-open 被拒绝#12 禁)
    expect(observed.health).toBe("unknown");
    expect(spec.intent).toBe("serve");
    expect(spec.desiredComponents).toEqual(["core", "dms", "flink"]);
    expect(deriveStatusProjection(spec, observed)).toBe("initializing"); // 非 active,不冒充可服务
    expect(serviceabilityReason(spec, observed)).not.toBeNull(); // fail-closed:不可服务直到本次探活
  });

  it("home(status=active ∧ ready=true ∧ 无 probe)⇒ 收养成 ready(home 豁免 probe)", () => {
    const home = { targetId: "tgt_home", status: "active" as TargetStatus, ready: true, components: ["core", "redshift"] } as unknown as ExecutionTarget;
    const { observed } = adoptLegacy(home);
    expect(observed.phase).toBe("ready");
  });

  it("🔴 testing ∧ ready=true ∧ probe.ok ⇒ verifying(**不**自愈成 ready:testing 待人工启用,不能跳过 enable)", () => {
    const testing = {
      targetId: "tgt_usw2_t",
      status: "testing" as TargetStatus,
      ready: true,
      components: ["core"],
      probe: { at: "2026-09-01T16:00:00Z", ok: true, items: [{ name: "x", ok: true }] },
    } as unknown as ExecutionTarget;
    const { spec, observed } = adoptLegacy(testing);
    expect(observed.phase).toBe("verifying");
    expect(deriveStatusProjection(spec, observed)).toBe("testing"); // 投影仍是 testing,enable 按钮据此可用
    expect(deriveReady(observed)).toBe(false);
  });

  it("真·未整包写完的 legacy(initializing ∧ ready=false)⇒ provisioning(不冒充 ready)", () => {
    const half = { targetId: "tgt_usw2_b", status: "initializing" as TargetStatus, ready: false, components: ["core"] } as unknown as ExecutionTarget;
    const { observed } = adoptLegacy(half);
    expect(observed.phase).toBe("provisioning");
    expect(deriveReady(observed)).toBe(false);
  });

  it("非 home 且 ready=true 但 probe 未绿 ⇒ 不冒充 ready(fail-closed)", () => {
    const noProbe = { targetId: "tgt_usw2_c", status: "initializing" as TargetStatus, ready: true, components: ["core"] } as unknown as ExecutionTarget;
    expect(adoptLegacy(noProbe).observed.phase).not.toBe("ready");
    const redProbe = {
      targetId: "tgt_usw2_d",
      status: "initializing" as TargetStatus,
      ready: true,
      components: ["core"],
      probe: { at: "2026-09-01T16:00:00Z", ok: false, items: [{ name: "x", ok: false }] },
    } as unknown as ExecutionTarget;
    expect(adoptLegacy(redProbe).observed.phase).not.toBe("ready");
  });

  it("退役态映射到对应 intent/phase", () => {
    const draining = { targetId: "tgt_usw2_e", status: "draining" as TargetStatus, ready: true, components: ["core"], probe: { at: "2026-09-01T16:00:00Z", ok: true, items: [{ name: "x", ok: true }] } } as unknown as ExecutionTarget;
    const a = adoptLegacy(draining);
    expect(a.spec.intent).toBe("drain");
    expect(a.observed.phase).toBe("draining");
  });

  it("specObservedOf 优先真实 spec/observed,缺则收养", () => {
    const real = { targetId: "tgt_home", spec: { intent: "serve", desiredComponents: ["core"] }, observed: { phase: "ready", health: "healthy", components: ["core"] } } as unknown as ExecutionTarget;
    expect(specObservedOf(real).observed.phase).toBe("ready");
    const legacy = { targetId: "tgt_home", status: "active" as TargetStatus, ready: true, components: ["core"] } as unknown as ExecutionTarget;
    expect(specObservedOf(legacy).observed.phase).toBe("ready"); // 收养
  });
});

describe("classifyDescriptor 三分类(v2 审核矛盾 D:legacy/modern/invalid,fail-closed)", () => {
  it("spec/observed 都无 ⇒ legacy(按旧字段收养)", () => {
    const t = { targetId: "tgt_home", status: "active", ready: true, components: ["core"] } as unknown as ExecutionTarget;
    expect(classifyDescriptor(t).kind).toBe("legacy");
  });
  it("spec/observed 都有且合法 ⇒ modern", () => {
    const t = {
      targetId: "tgt_usw2_a",
      spec: { intent: "serve", desiredComponents: ["core"] },
      observed: { phase: "ready", health: "healthy", components: ["core"] },
    } as unknown as ExecutionTarget;
    expect(classifyDescriptor(t).kind).toBe("modern");
  });
  it("🔴 只存在一侧(半写)⇒ invalid,**绝不按 legacy 猜**(拒绝#11)", () => {
    const onlySpec = { targetId: "tgt_usw2_a", spec: { intent: "serve", desiredComponents: ["core"] } } as unknown as ExecutionTarget;
    expect(classifyDescriptor(onlySpec).kind).toBe("invalid");
    const onlyObs = { targetId: "tgt_usw2_a", observed: { phase: "ready", health: "healthy", components: ["core"] } } as unknown as ExecutionTarget;
    expect(classifyDescriptor(onlyObs).kind).toBe("invalid");
  });
  it("🔴 modern 但字段非法(坏 phase / 缺 core)⇒ invalid", () => {
    const badPhase = {
      targetId: "tgt_usw2_a",
      spec: { intent: "serve", desiredComponents: ["core"] },
      observed: { phase: "bogus", health: "healthy", components: ["core"] },
    } as unknown as ExecutionTarget;
    expect(classifyDescriptor(badPhase).kind).toBe("invalid");
    const noCoreSpec = {
      targetId: "tgt_usw2_a",
      spec: { intent: "serve", desiredComponents: ["dms"] },
      observed: { phase: "ready", health: "healthy", components: ["core"] },
    } as unknown as ExecutionTarget;
    expect(classifyDescriptor(noCoreSpec).kind).toBe("invalid");
  });
  it("🔴 specObservedOf 对 invalid **抛** DescriptorInvalidError(写入方 fail-closed)", () => {
    const onlySpec = { targetId: "tgt_usw2_a", spec: { intent: "serve", desiredComponents: ["core"] } } as unknown as ExecutionTarget;
    expect(() => specObservedOf(onlySpec)).toThrow(DescriptorInvalidError);
  });
});

describe("transitionPhase(唯一写通道 + 物化投影 + 受限自转 gate)", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
  });

  const post = (over: Partial<TargetObserved> = {}, spec: TargetSpec = serve) => ({
    spec,
    observed: obs(over),
  });

  // ── fence 夹具(§20:completion/legacy/enable 都要 canonical probe + exact 全绿覆盖)──────────
  const CANON = "2026-09-01T00:00:00.000Z";
  const green: ProbeResult = { at: CANON, ok: true, items: [{ name: "datalakeBucket", ok: true }] };
  const probeInput: ProbeInputSnapshot = {
    region: "us-west-2",
    accountId: "123456789012",
    partition: "aws",
    components: ["core"],
    resources: undefined,
    agentcore: undefined,
  };
  const exactGreen = { probeAt: CANON, probe: green, desiredComponents: ["core"], observedComponents: ["core"], probeInput };
  const deployFence: DeploymentCompletionFence = {
    ...exactGreen,
    operationId: "op_u",
    lockEpoch: 1,
    openSnapshotHash: "a".repeat(64),
    buildId: "b_1",
    startedAt: CANON,
  };
  const stableFence: LegacyCompletionFence = { mode: "stable", ...exactGreen };
  const enableFence: EnableLifecycleFence = { ...exactGreen, expectedVersion: 3, fromPhase: "verifying" };
  // 完成/enable 的 post.observed 必须 exact 匹配 fence(healthy、components=core、probe=green、无 operation)
  const greenObserved = (phase: TargetObserved["phase"]): TargetObserved => ({ phase, health: "healthy", components: ["core"], probe: green });

  it("🔴 非法转移在**任何 DDB 调用之前**就抛 PhaseTransitionError", async () => {
    await expect(
      transitionPhase("tgt_usw2_a", { from: "registered", post: post({ phase: "ready" }), expectedVersion: 1, reason: "test" })
    ).rejects.toBeInstanceOf(PhaseTransitionError);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("合法转移(provisioning→verifying):条件绑 version + 前态 phase;写 observed/spec + 物化 status/ready/components + version+1", async () => {
    await transitionPhase("tgt_usw2_a", { from: "provisioning", post: post({ phase: "verifying", components: ["core", "dms"] }), expectedVersion: 3, reason: "初装待启用" });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const input = sendMock.mock.calls[0][0].input;
    expect(input.ConditionExpression).toContain("#v = :expected");
    expect(input.ConditionExpression).toContain("#o.#ph = :from");
    expect(input.ExpressionAttributeValues[":from"]).toBe("provisioning");
    expect(input.UpdateExpression).toContain("#o = :obs");
    expect(input.UpdateExpression).toContain("#sp = :spec");
    expect(input.ExpressionAttributeValues[":obs"].phase).toBe("verifying");
    // 🔴 物化顶层投影(老 readers 读它)
    expect(input.UpdateExpression).toContain("#st = :status");
    expect(input.UpdateExpression).toContain("#r = :ready");
    expect(input.UpdateExpression).toContain("#c = :components");
    expect(input.ExpressionAttributeValues[":status"]).toBe("testing"); // verifying ⇒ testing
    expect(input.ExpressionAttributeValues[":ready"]).toBe(false);
    expect(input.ExpressionAttributeValues[":components"]).toEqual(["core", "dms"]);
    expect(input.ExpressionAttributeValues[":next"]).toBe(4);
  });

  it("🔴 首写收养(ifAbsent + stable legacyCompletionFence):绑 attribute_not_exists(observed,spec),不绑前态,且**不留未用的 #ph/:from**(§20.3 unused-names)", async () => {
    await transitionPhase("tgt_usw2_a", {
      from: "ready",
      ifAbsent: true,
      post: { spec: serve, observed: greenObserved("ready") },
      expectedVersion: 7,
      legacyCompletionFence: stableFence,
      reason: "收养存量(E-99 stable)",
    });
    const input = sendMock.mock.calls[0][0].input;
    expect(input.ConditionExpression).toContain("attribute_not_exists(#o)");
    expect(input.ConditionExpression).toContain("attribute_not_exists(#sp)");
    expect(input.ConditionExpression).not.toContain("#o.#ph = :from");
    expect(input.ConditionExpression).toContain("#v = :expected");
    // 🔴 ifAbsent 时 #ph/:from 绝不出现在 names/values(否则 unused ⇒ ValidationException)
    expect(input.ExpressionAttributeNames["#ph"]).toBeUndefined();
    expect(input.ExpressionAttributeValues[":from"]).toBeUndefined();
    // stable legacy fence:断言无残留锁 + 本次 probe
    expect(input.ConditionExpression).toContain("attribute_not_exists(#legacyToken)");
    expect(input.ExpressionAttributeValues[":legacyProbe"]).toEqual(green);
  });

  it("🔴 完成 deploy(ready→ready + completionFence):清 operation + 顶层锁 ⇒ 物化回 active(bug#11 根治的核心)", async () => {
    await transitionPhase("tgt_usw2_a", {
      from: "ready",
      post: { spec: serve, observed: greenObserved("ready") },
      expectedVersion: 3,
      completionFence: deployFence,
      reason: "补充部署完成",
    });
    const input = sendMock.mock.calls[0][0].input;
    // operation 已从 post 清除 ⇒ ready+healthy+无op ⇒ 物化 active
    expect(input.ExpressionAttributeValues[":obs"].operation).toBeUndefined();
    expect(input.ExpressionAttributeValues[":status"]).toBe("active");
    // 🔴 同一次写 REMOVE 顶层 deploy 锁
    expect(input.UpdateExpression).toContain("REMOVE");
    expect(input.UpdateExpression).toContain("deployLockToken");
    // exact fence 绑 operation tuple + 本次 probe.at
    expect(input.ConditionExpression).toContain("#o.#operation.#operationId = :fenceOperationId");
    expect(input.ExpressionAttributeValues[":fenceOperationId"]).toBe("op_u");
    expect(input.ExpressionAttributeValues[":fenceProbeAt"]).toBe(CANON);
  });

  it("🔴 completion post-image 仍留 operation ⇒ 抛(完成写必须清 operation)", async () => {
    await expect(
      transitionPhase("tgt_usw2_a", {
        from: "ready",
        post: { spec: serve, observed: { ...greenObserved("ready"), operation: { kind: "deploy", operationId: "op_u", lockEpoch: 1, startedAt: CANON, disruptive: true } } },
        expectedVersion: 3,
        completionFence: deployFence,
        reason: "非法:未清 operation",
      })
    ).rejects.toBeInstanceOf(PhaseTransitionError);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("🔴 verifying→ready 缺 enableFence ⇒ 抛(只能由 fresh enable fence 授权)", async () => {
    await expect(
      transitionPhase("tgt_usw2_a", { from: "verifying", post: { spec: serve, observed: greenObserved("ready") }, expectedVersion: 3, reason: "缺 enableFence" })
    ).rejects.toBeInstanceOf(PhaseTransitionError);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("🔴 enable(verifying→ready + enableFence):写 ready + 断言 attribute_not_exists(operation) + testing/ready=false 前态", async () => {
    await transitionPhase("tgt_usw2_a", {
      from: "verifying",
      post: { spec: serve, observed: greenObserved("ready") },
      expectedVersion: 3,
      enableFence,
      reason: "manual enable",
    });
    const input = sendMock.mock.calls[0][0].input;
    expect(input.ExpressionAttributeValues[":status"]).toBe("active");
    expect(input.ConditionExpression).toContain("attribute_not_exists(#o.#enableOperation)");
    expect(input.ConditionExpression).toContain("#enableStatus = :enableTesting");
    expect(input.ExpressionAttributeValues[":enableProbeAt"]).toBe(CANON);
  });

  it("🔴 ready→ready 缺任何 fence ⇒ 抛(受限自转不全局放开)", async () => {
    await expect(
      transitionPhase("tgt_usw2_a", { from: "ready", post: post({ phase: "ready" }), expectedVersion: 3, reason: "裸自转" })
    ).rejects.toBeInstanceOf(PhaseTransitionError);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("🔴 ifAbsent 与 legacyCompletionFence 必须成对(只给其一 ⇒ 抛)", async () => {
    await expect(
      transitionPhase("tgt_usw2_a", { from: "ready", ifAbsent: true, post: { spec: serve, observed: greenObserved("ready") }, expectedVersion: 7, reason: "裸 ifAbsent" })
    ).rejects.toBeInstanceOf(PhaseTransitionError);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("guards(equals)追加条件绑定:alias 用部件下标 #g0_0.#g0_1(§20.3;非属性名)", async () => {
    await transitionPhase("tgt_usw2_a", {
      from: "provisioning",
      post: post({ phase: "verifying" }),
      expectedVersion: 2,
      guards: [{ path: "probe.ok", equals: true }],
      reason: "全绿才进 verifying",
    });
    const input = sendMock.mock.calls[0][0].input;
    expect(input.ConditionExpression).toMatch(/#g0_0\.#g0_1 = :g0/);
    expect(input.ExpressionAttributeNames["#g0_0"]).toBe("probe");
    expect(input.ExpressionAttributeNames["#g0_1"]).toBe("ok");
    expect(input.ExpressionAttributeValues[":g0"]).toBe(true);
  });
  it("🔴 guards(absent):属性缺失用 attribute_not_exists,不塞 undefined(§20.3)", async () => {
    await transitionPhase("tgt_usw2_a", {
      from: "provisioning",
      post: post({ phase: "verifying" }),
      expectedVersion: 2,
      guards: [{ path: "ready", absent: true }],
      reason: "legacy ready 缺属性",
    });
    const input = sendMock.mock.calls[0][0].input;
    expect(input.ConditionExpression).toContain("attribute_not_exists(#g0_0)");
    expect(input.ExpressionAttributeNames["#g0_0"]).toBe("ready");
    expect(input.ExpressionAttributeValues[":g0"]).toBeUndefined(); // absent 不产生值
  });
  it("🔴 guards(equals:undefined)⇒ 抛(必须用 absent:true),且不发 DDB", async () => {
    await expect(
      transitionPhase("tgt_usw2_a", {
        from: "provisioning",
        post: post({ phase: "verifying" }),
        expectedVersion: 2,
        guards: [{ path: "probe.ok", equals: undefined }],
        reason: "非法",
      })
    ).rejects.toBeInstanceOf(PhaseTransitionError);
    expect(sendMock).not.toHaveBeenCalled();
  });
  it("🔴 guards(path 有空部件)⇒ 抛,且不发 DDB", async () => {
    await expect(
      transitionPhase("tgt_usw2_a", {
        from: "provisioning",
        post: post({ phase: "verifying" }),
        expectedVersion: 2,
        guards: [{ path: "probe..ok", equals: true }],
        reason: "非法 path",
      })
    ).rejects.toBeInstanceOf(PhaseTransitionError);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("🔴 ConditionalCheckFailed + postcondition mismatch ⇒ LifecycleConflictError(§20:先 exact 强读)", async () => {
    sendMock.mockReset();
    sendMock.mockRejectedValueOnce({ name: "ConditionalCheckFailedException" }); // UpdateCommand 被拒
    sendMock.mockResolvedValueOnce({ Item: undefined }); // postcondition 强读:无匹配 ⇒ mismatch
    await expect(
      transitionPhase("tgt_usw2_a", { from: "provisioning", post: post({ phase: "verifying" }), expectedVersion: 3, reason: "test" })
    ).rejects.toBeInstanceOf(LifecycleConflictError);
  });

  it("🔴 send 失败但 postcondition 证明已提交(幂等)⇒ 不抛、不重发", async () => {
    sendMock.mockReset();
    const observed = obs({ phase: "verifying" });
    sendMock.mockRejectedValueOnce({ name: "ConditionalCheckFailedException" });
    // postcondition 强读回 exact post-image(version+1、双轴、投影一致)⇒ match ⇒ 幂等成功
    sendMock.mockResolvedValueOnce({
      Item: { version: 4, spec: serve, observed, status: "testing", ready: false, components: ["core"] },
    });
    await expect(
      transitionPhase("tgt_usw2_a", { from: "provisioning", post: { spec: serve, observed }, expectedVersion: 3, reason: "幂等" })
    ).resolves.toBeUndefined();
  });
});
