// @kf-batch 50-P50.3b-2a-reconciler
// deriveHealthFromProbe(纯,穷举 green/streak/core-red)+ reconcileTelemetry(周期 telemetry 窄通道)。
// 🔴 本文件钉住 P50.3b-2a 最承重不变量:**fail-open 反转禁令** —— 探活红 ⇒ health 降级 ⇒ 派生 status≠active
//    (绝不因 reconciler 刷新了 probe.at 就把红探活的 target 当"新鲜+active"放行)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const getMock = vi.fn();
const updateMock = vi.fn();
vi.mock("@/lib/aws/dynamodb", () => ({
  docClient: { send: (cmd: { __kind: string }) => (cmd.__kind === "get" ? getMock(cmd) : updateMock(cmd)) },
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

import {
  deriveHealthFromProbe,
  reconcileTelemetry,
  adoptLegacy,
  HEALTH_DOWNGRADE_STREAK,
  type TargetObserved,
  type ProbeResult,
} from "@/lib/exec-env/lifecycle";
import type { ExecutionTarget } from "@/lib/exec-env/registry";

const CANON = "2026-09-02T00:00:00.000Z";
const probe = (ok: boolean, items: Array<{ name: string; ok: boolean }>): ProbeResult => ({ at: CANON, ok, items });
const GREEN = probe(true, [{ name: "datalakeBucket", ok: true }]); // 覆盖 core
const RED_CORE = probe(false, [{ name: "datalakeBucket", ok: false }]); // core 项红
const RED_NONCORE = probe(false, [
  { name: "datalakeBucket", ok: true },
  { name: "dms:subnet-group", ok: false },
]); // core 绿、非 core 红
const obs = (over: Partial<TargetObserved> = {}): TargetObserved => ({
  phase: "ready",
  health: "healthy",
  components: ["core"],
  ...over,
});

describe("deriveHealthFromProbe(纯,fail-open 反转禁令的核心)", () => {
  it("全绿且精确覆盖 → healthy,streak 清 0", () => {
    expect(deriveHealthFromProbe(obs({ unhealthyStreak: 5 }), GREEN)).toEqual({ health: "healthy", unhealthyStreak: 0 });
  });
  it("首次红(streak 0→1 < 阈值)→ 保持原 health,只累加 streak(单次瞬时失败不误杀)", () => {
    expect(deriveHealthFromProbe(obs({ health: "healthy", unhealthyStreak: 0 }), RED_CORE)).toEqual({
      health: "healthy",
      unhealthyStreak: 1,
    });
  });
  it("连续红达阈值 + core 全绿 → degraded(核心可服务)", () => {
    expect(
      deriveHealthFromProbe(obs({ components: ["core", "dms"], unhealthyStreak: HEALTH_DOWNGRADE_STREAK - 1 }), RED_NONCORE)
    ).toEqual({ health: "degraded", unhealthyStreak: HEALTH_DOWNGRADE_STREAK });
  });
  it("🔴 连续红达阈值 + core 有红 → unknown(fail-closed;serviceabilityReason 会拒)", () => {
    expect(deriveHealthFromProbe(obs({ unhealthyStreak: HEALTH_DOWNGRADE_STREAK - 1 }), RED_CORE)).toEqual({
      health: "unknown",
      unhealthyStreak: HEALTH_DOWNGRADE_STREAK,
    });
  });
  it("从 unknown 恢复:绿探活即回 healthy、streak 清 0", () => {
    expect(deriveHealthFromProbe(obs({ health: "unknown", unhealthyStreak: 9 }), GREEN)).toEqual({
      health: "healthy",
      unhealthyStreak: 0,
    });
  });
  it("probe.ok 但覆盖不全(缺声称组件的项)⇒ 不算 green(fail-closed 不认 healthy)", () => {
    const partial = probe(true, [{ name: "datalakeBucket", ok: true }]); // 只覆盖 core
    const r = deriveHealthFromProbe(obs({ components: ["core", "dms"], unhealthyStreak: 0 }), partial);
    expect(r.health).toBe("healthy"); // streak 0→1 < 阈值,保持;但不是"绿"
    expect(r.unhealthyStreak).toBe(1);
  });
});

describe("reconcileTelemetry(窄通道)", () => {
  beforeEach(() => {
    getMock.mockReset();
    updateMock.mockReset();
  });
  const modernReady = (over: Record<string, unknown> = {}) => ({
    Item: {
      pk: "env",
      sk: "tgt_usw2_a",
      targetId: "tgt_usw2_a",
      version: 7,
      accountId: "123456789012",
      region: "us-west-2",
      partition: "aws",
      status: "active",
      ready: true,
      components: ["core"],
      spec: { intent: "serve", desiredComponents: ["core"] },
      observed: { phase: "ready", health: "healthy", components: ["core"] },
      ...over,
    },
  });
  const obsWritten = () => updateMock.mock.calls[0][0].input.ExpressionAttributeValues[":obs"] as TargetObserved;
  const cmdInput = () => updateMock.mock.calls[0][0].input;

  it("modern ready 无 operation + 绿 probe → 写 health=healthy、status=active;🔴 不涨 version;含 no-operation + version 守卫", async () => {
    getMock.mockResolvedValue(modernReady());
    updateMock.mockResolvedValue({});
    const r = await reconcileTelemetry("tgt_usw2_a", { probe: GREEN });
    expect(r).toEqual({ written: true });
    const cmd = cmdInput();
    expect(cmd.UpdateExpression).not.toContain(":next"); // 🔴 不涨 version(ROADMAP「不抢 version」)
    expect(cmd.ConditionExpression).toContain("attribute_not_exists(#o.#op)"); // 绝不与在途 deploy 抢写
    expect(cmd.ConditionExpression).toContain("#v = :expected");
    expect(cmd.ExpressionAttributeValues[":expected"]).toBe(7);
    expect(obsWritten().health).toBe("healthy");
    expect(cmd.ExpressionAttributeValues[":status"]).toBe("active");
  });

  it("🔴🔴 fail-open 反转禁令:core 红达阈值 → health=unknown、派生 status≠active(绝不因 probe.at 新鲜放行红探活)", async () => {
    getMock.mockResolvedValue(
      modernReady({ observed: { phase: "ready", health: "healthy", components: ["core"], unhealthyStreak: 1 } })
    );
    updateMock.mockResolvedValue({});
    const r = await reconcileTelemetry("tgt_usw2_a", { probe: RED_CORE });
    expect(r).toEqual({ written: true });
    expect(obsWritten().health).toBe("unknown");
    expect(obsWritten().unhealthyStreak).toBe(2);
    expect(cmdInput().ExpressionAttributeValues[":status"]).not.toBe("active");
  });

  it("有在途 operation → 跳过(不与 deploy 抢写),不发 Update", async () => {
    getMock.mockResolvedValue(
      modernReady({
        observed: {
          phase: "ready",
          health: "healthy",
          components: ["core"],
          operation: { kind: "deploy", operationId: "op1", lockEpoch: 1, startedAt: CANON, disruptive: true },
        },
      })
    );
    expect(await reconcileTelemetry("tgt_usw2_a", { probe: GREEN })).toEqual({ written: false, reason: "operation-in-flight" });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("phase≠ready → 跳过(verifying/provisioning 归转移路,不做 health telemetry)", async () => {
    getMock.mockResolvedValue(
      modernReady({ observed: { phase: "provisioning", health: "unknown", components: ["core"] } })
    );
    const r = await reconcileTelemetry("tgt_usw2_a", { probe: GREEN });
    expect(r.written).toBe(false);
    expect(r.reason).toContain("phase=provisioning");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("legacy(无 spec/observed)→ 跳过 not-modern(收养走 reconcileAfterProbe,不走 telemetry)", async () => {
    getMock.mockResolvedValue({
      Item: {
        pk: "env",
        sk: "tgt_usw2_a",
        targetId: "tgt_usw2_a",
        version: 3,
        status: "active",
        ready: true,
        components: ["core"],
        accountId: "123456789012",
        region: "us-west-2",
        partition: "aws",
      },
    });
    const r = await reconcileTelemetry("tgt_usw2_a", { probe: GREEN });
    expect(r.written).toBe(false);
    expect(r.reason).toContain("not-modern");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("并发冲突(CCF)→ {written:false, reason:raced},不抛(下 tick 再来)", async () => {
    getMock.mockResolvedValue(modernReady());
    updateMock.mockRejectedValue(Object.assign(new Error("c"), { name: "ConditionalCheckFailedException" }));
    expect(await reconcileTelemetry("tgt_usw2_a", { probe: GREEN })).toEqual({ written: false, reason: "raced" });
  });

  it("templateVersion 传入 → 写进 observed.templateVersion(observedVersion 真写入方)", async () => {
    getMock.mockResolvedValue(modernReady());
    updateMock.mockResolvedValue({});
    await reconcileTelemetry("tgt_usw2_a", { probe: GREEN, templateVersion: "2026-09-02T01:02:03.000Z" });
    expect(obsWritten().templateVersion).toBe("2026-09-02T01:02:03.000Z");
  });

  it("坏 probe(非 canonical at)⇒ 抛,零 DDB 写", async () => {
    getMock.mockResolvedValue(modernReady());
    await expect(reconcileTelemetry("tgt_usw2_a", { probe: { at: "2026", ok: true, items: [{ name: "x", ok: true }] } as ProbeResult })).rejects.toThrow();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("adoptLegacy 据 stored probe.ok DEMOTE(P50.3b-2a legacy 侧 fail-open 反转禁令;re-audit 揪出的回归)", () => {
  // 🔴 reconciler 对 legacy target 也无条件刷新顶层 probe.at,废掉"红探活 15min 后 stale"安全网 ⇒
  //    adoptLegacy 必须据 stored probe.ok DEMOTE(红→unknown fail-closed),否则红探活的 legacy active 目标永远可服务。
  const legacy = (probe?: ProbeResult): ExecutionTarget =>
    ({ targetId: "tgt_usw2_a", status: "active", ready: true, components: ["core"], ...(probe ? { probe } : {}) } as unknown as ExecutionTarget);

  it("legacy active+ready 无 probe → healthy(原行为不变)", () => {
    expect(adoptLegacy(legacy()).observed.health).toBe("healthy");
  });
  it("legacy active+ready + 绿 probe → healthy", () => {
    expect(adoptLegacy(legacy(GREEN)).observed.health).toBe("healthy");
  });
  it("🔴 非 home legacy active+ready + 红 probe → health=unknown(fail-closed);phase 仍 ready(只降级 health,不碰 #12 的 phase 提升)", () => {
    const r = adoptLegacy(legacy(RED_CORE));
    expect(r.observed.phase).toBe("ready"); // phase 由 status/ready 派生,不据 probe 降级(不碰拒绝清单 #12)
    expect(r.observed.health).toBe("unknown"); // health 据 stored 红 probe 降级(允许:#12 只禁 PROMOTE)
  });
  it("home(tgt_home)legacy active + 红 probe → 仍 healthy(既有行为本批不改;与 stale 豁免同口径,避免全平台 fail-closed)", () => {
    const home = { targetId: "tgt_home", status: "active", ready: true, components: ["core"], probe: RED_CORE } as unknown as ExecutionTarget;
    expect(adoptLegacy(home).observed.health).toBe("healthy");
  });
});
