// @kf-batch 50-P50.2c-control-api
// P50.2 切片 e —— 部署回写 / ready 置位 / 探活写入 / 启用 的窄写通道单测。
//
// 【本文件的四条承重】
// ① **缺一个 CFN Output 就一个字节都不写**(§20.11-N2:半份描述符比没有更糟);
// ② **ready 置位前候选必须整包过 §3.1a**("整包写完"必须是真的,校验不过不置);
// ③ **writeProbeResult 的形状 fail-closed**(垃圾 at 会污染 stale 判定的时间源;空 items 的
//    every() 恒 true 会造假绿;ok 与 items 矛盾的结果不许落库);
// ④ **enableTarget 前置三绑进条件写**(ready ∧ probe.ok ∧ status=testing —— 读到写之间的
//    变化由 DDB 拒,不靠读时判断)。
// 另:钉住 reconcileTarget 的**集成缝修正**(register 不写 ready 字段 × 旧条件 `#r = :false`
// 对缺失属性恒 false ⇒ 刚 register 的 item 永远回写不进去)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const getMock = vi.fn();
const putMock = vi.fn();
const queryMock = vi.fn();
const updateMock = vi.fn();
vi.mock("@/lib/aws/dynamodb", () => ({
  docClient: {
    send: (cmd: { __kind: string }) =>
      cmd.__kind === "get"
        ? getMock(cmd)
        : cmd.__kind === "put"
          ? putMock(cmd)
          : cmd.__kind === "update"
            ? updateMock(cmd)
            : queryMock(cmd),
  },
  TABLES: { EXECUTION_ENVS: "bgp-execution-envs" },
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  GetCommand: class {
    __kind = "get";
    constructor(public input: Record<string, unknown>) {}
  },
  PutCommand: class {
    __kind = "put";
    constructor(public input: Record<string, unknown>) {}
  },
  QueryCommand: class {
    __kind = "query";
    constructor(public input: Record<string, unknown>) {}
  },
  UpdateCommand: class {
    __kind = "update";
    constructor(public input: Record<string, unknown>) {}
  },
}));

// 🔴 mock 取数层模块本身(@/ 别名 mock 已证可靠),不 mock @aws-sdk —— 第一版在 registry 里
// 动态 import CFN 并 vi.mock 包名,实测 **mock 没生效、单测拿本机凭证真打了 AWS**(--no-cache 复现,
// 错误消息是真 CFN 的 "Stack with id ... does not exist" 格式)。教训:涉网依赖一律顶层 import,
// 测试 mock 已证可靠的那一层;"动态 import + 包名 mock" 这种没验证过的机制不进测试。
const readOutputsMock = vi.fn();
vi.mock("@/lib/exec-env/stack-outputs", () => ({
  readExecEnvStackOutputs: (...a: unknown[]) => readOutputsMock(...a),
}));

import {
  mergeComponentResources,
  finalizeTargetResources,
  writeProbeResult,
  enableTarget,
  reconcileTarget,
  probeInputOf,
  LifecyclePreconditionError,
  type ExecutionTarget,
  type FinalizeLifecycleFence,
} from "@/lib/exec-env/registry";
import type { ProbeResult, EnableLifecycleFence } from "@/lib/exec-env/lifecycle";

const TID = "tgt_usw2_a";
const ACCT = "123456789012";
const NOW_ISO = new Date().toISOString();

/** 刚 register 落的身份骨架(🔴 没有 ready 字段、没有 resources —— 这正是集成缝的形状)。 */
function registeredItem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pk: "env",
    sk: TID,
    targetId: TID,
    partition: "aws",
    accountId: ACCT,
    region: "us-west-2",
    jurisdiction: "home",
    status: "initializing",
    components: ["core"],
    credentialIsolationState: "legacy-seeded",
    credentialEpoch: 0,
    version: 3,
    createdBy: "admin",
    updatedAt: NOW_ISO,
    ...over,
  };
}

/** 完整资源袋(全部过 §3.1a 的形态/归属校验)。 */
const FULL_RESOURCES = {
  vpcId: "vpc-0123456789abcdef0",
  dataKeyArn: `arn:aws:kms:us-west-2:${ACCT}:key/aaaabbbb-cccc-dddd-eeee-ffffffffffff`,
  privateSubnetIds: ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"],
  datalakeBucket: `bgp-datalake-${ACCT}-tgt-usw2-a`,
  scriptsBucket: `bgp-glue-scripts-${ACCT}-tgt-usw2-a`,
  tableBucket: "bgp-table-bucket-tgt-usw2-a",
  athenaWorkgroup: "bgp-athena-tgt-usw2-a",
  glueRoleArn: `arn:aws:iam::${ACCT}:role/bgp-glue-role`,
  // @kf-batch 50-W5-seg1-WP3:core 栈从此吐 EMR 执行角色(本 target 名)
  emrExecutionRoleArn: `arn:aws:iam::${ACCT}:role/BgpExecEnv-tgt-usw2-a-emr-role`,
  emrSecurityGroupId: "sg-0123456789abcdef0",
  emrSubnetIds: ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"],
};

/** base/core 两栈的标准 Outputs(OutputKey = 描述符字段名,栈组合同;子网列表是逗号串)。 */
function stockOutputs(): { base: Record<string, string>; core: Record<string, string> } {
  return {
    base: {
      vpcId: FULL_RESOURCES.vpcId,
      dataKeyArn: FULL_RESOURCES.dataKeyArn,
      privateSubnetIds: FULL_RESOURCES.privateSubnetIds.join(","),
      targetId: TID,
    },
    core: {
      datalakeBucket: FULL_RESOURCES.datalakeBucket,
      scriptsBucket: FULL_RESOURCES.scriptsBucket,
      tableBucket: FULL_RESOURCES.tableBucket,
      athenaWorkgroup: FULL_RESOURCES.athenaWorkgroup,
      glueRoleArn: FULL_RESOURCES.glueRoleArn,
      // @kf-batch 50-W5-seg1-WP3:core 栈从此必吐 EMR 执行角色(本 target 名;缺则 finalize 整轮拒)
      emrExecutionRoleArn: FULL_RESOURCES.emrExecutionRoleArn,
      emrSecurityGroupId: FULL_RESOURCES.emrSecurityGroupId,
      emrSubnetIds: FULL_RESOURCES.emrSubnetIds.join(","),
    },
  };
}

// 🔴 v3.15(§21):finalize/merge 现在**强制收 fence**;assertFinalizeFence 会逐字段核 item↔fence 一致。
//    legacy 顶层锁字段(broker 部署时写);legFence 据 item 现值构造匹配的 legacy fence。
const LEG_LOCK = {
  lockEpoch: 5,
  deployLockToken: "op_leg1234",
  deployLockOperationId: "op_leg1234",
  lastOperationId: "op_leg1234",
  lastBuildId: "b_leg_1",
} as const;

/** 初装/升级前遗留(bug#11)的 legacy finalize item:身份骨架 + broker 锁。 */
function finalizeItem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return registeredItem({ ...LEG_LOCK, ...over });
}

/** 与 item 一致的 legacy finalize fence(reconcile 初装路 / merge 的 bug#11 升级路)。 */
function legFence(item: Record<string, unknown>): FinalizeLifecycleFence {
  return {
    kind: "legacy",
    region: "us-west-2",
    accountId: ACCT,
    partition: "aws",
    expectedVersion: item.version as number,
    status: item.status as ExecutionTarget["status"],
    ready: item.ready as boolean | undefined,
    components: (item.components as string[]) ?? [],
    probe: item.probe as ProbeResult | undefined,
    lockEpoch: LEG_LOCK.lockEpoch,
    lockToken: LEG_LOCK.deployLockToken,
    operationId: LEG_LOCK.deployLockOperationId,
    buildId: LEG_LOCK.lastBuildId,
  };
}

const GREEN_PROBE: ProbeResult = { at: NOW_ISO, ok: true, items: [{ name: "datalakeBucket", ok: true }] };

beforeEach(() => {
  vi.clearAllMocks();
  updateMock.mockResolvedValue({});
});

// ══════════════════════════════════════════════════════════════════════════════
// finalizeTargetResources
// ══════════════════════════════════════════════════════════════════════════════
describe("finalizeTargetResources(CFN Outputs → 资源袋 → 经 reconcileTarget 落库;强制收 exact fence §21.1.1)", () => {
  it("正常:两栈 Outputs 齐 ⇒ 组装资源袋(逗号串 split 成数组)并条件写落库", async () => {
    const item = finalizeItem();
    readOutputsMock.mockResolvedValue(stockOutputs());
    getMock.mockResolvedValue({ Item: item });
    const resources = await finalizeTargetResources(TID, { fence: legFence(item) });
    // 取数层收到的是 (region, targetId)
    expect(readOutputsMock).toHaveBeenCalledWith("us-west-2", TID);
    expect(resources).toEqual(FULL_RESOURCES);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const cmd = updateMock.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(cmd.input.Key).toEqual({ pk: "env", sk: TID });
    // 落库经 reconcileTarget:version 乐观锁 + 维修态条件在(细断言在下面的集成缝回归)
    expect(String(cmd.input.ConditionExpression)).toContain("#v = :expected");
    const values = cmd.input.ExpressionAttributeValues as Record<string, unknown>;
    expect(values[":expected"]).toBe(3);
  });

  it("🔴 base 栈自报的 targetId 与请求不符 ⇒ 拒(防把同 region 另一个 target 的资源写进来)", async () => {
    const outs = stockOutputs();
    outs.base.targetId = "tgt_usw2_b";
    const item = finalizeItem();
    readOutputsMock.mockResolvedValue(outs);
    getMock.mockResolvedValue({ Item: item });
    await expect(finalizeTargetResources(TID, { fence: legFence(item) })).rejects.toThrow(/自报 targetId=.*tgt_usw2_b.*≠ tgt_usw2_a/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("🔴 缺任一 CFN Output ⇒ 指名道姓拒,且一个字节都不写(§20.11-N2)", async () => {
    const outs = stockOutputs();
    delete outs.core.emrSubnetIds;
    const item = finalizeItem();
    readOutputsMock.mockResolvedValue(outs);
    getMock.mockResolvedValue({ Item: item });
    await expect(finalizeTargetResources(TID, { fence: legFence(item) })).rejects.toThrow(/CFN Outputs 缺:core\.emrSubnetIds/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  // ── P50.3a:可选组件栈 → observed 组件回写 ──────────────────────────────────
  it("🔴 读到组件栈 ⇒ 资源袋合并该组件的实名 + `components` 按 **observed** 回写(core + 真读到的)", async () => {
    readOutputsMock.mockResolvedValue({
      ...stockOutputs(),
      components: {
        dms: { dmsSubnetGroup: "bgp-dms-subnet-group-tgt-usw2-a" },
        flink: { flinkRoleArn: `arn:aws:iam::${ACCT}:role/BgpExecEnv-tgt-usw2-a-flink-role` },
      },
    });
    const item = finalizeItem();
    getMock.mockResolvedValue({ Item: item });
    const resources = await finalizeTargetResources(TID, { fence: legFence(item) });
    expect(resources.dmsSubnetGroup).toBe("bgp-dms-subnet-group-tgt-usw2-a");
    expect(resources.flinkRoleArn).toBe(`arn:aws:iam::${ACCT}:role/BgpExecEnv-tgt-usw2-a-flink-role`);
    // components 与 resources 必须**同一次**写(patch 的 :k1 = 新组件全集;fence 的 :ffComponents 是旧值,插入更晚)
    const cmd = updateMock.mock.calls[0][0] as { input: Record<string, unknown> };
    const values = cmd.input.ExpressionAttributeValues as Record<string, unknown>;
    expect(values[":k1"]).toEqual(["core", "dms", "flink"]); // 固定次序(orderComponents)
  });

  it("🔴 组件栈**存在**却缺合同要求的 Output ⇒ 指名道姓拒且零写入(不静默「那就不声称这个组件」)", async () => {
    readOutputsMock.mockResolvedValue({
      ...stockOutputs(),
      components: { redshift: { redshiftWorkgroup: "bgp-workgroup-tgt-usw2-a", redshiftDatabase: "dev" } }, // 缺 secretArn
    });
    const item = finalizeItem();
    getMock.mockResolvedValue({ Item: item });
    await expect(finalizeTargetResources(TID, { fence: legFence(item) })).rejects.toThrow(/组件栈 redshift 的 CFN Outputs 缺:redshift\.redshiftSecretArn/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  // @kf-batch 50-WP23-xregion-peering
  // 🔴🔴 **一个「写了没接上」的真缺陷**:base 栈从 WP-16 起就输出 `endpointIds` /
  //    `homeLinkHostedZoneId`(以及 WP-23 的 `homeLinkPeeringId` / `vpcCidr`),探活也照它们写了
  //    `network:egress-none` / `network:home-link` 两项 —— 而资源袋的组装是一张**写死的键清单**,
  //    压根没装它们 ⇒ `res.endpointIds` 恒为 undefined ⇒ 探活灰度门恒 false ⇒ **那两项从来没跑过**。
  //    两边各自都对,单测与门禁全绿。这条判据就是那个接缝。
  it("🔴 base 的网络观测键必须进资源袋(读到就写;缺了 ⇒ 探活的零出网两项永远不出)", async () => {
    const outs = stockOutputs();
    outs.base.endpointIds = "vpce-aaa,vpce-bbb";
    outs.base.homeLinkPeeringId = "pcx-0123456789abcdef0";
    outs.base.homeLinkHostedZoneId = "Z02066582K5P8SB5ZQ2GD";
    outs.base.vpcCidr = "10.128.0.0/16";
    readOutputsMock.mockResolvedValue({ ...outs, components: {} });
    const item = finalizeItem();
    getMock.mockResolvedValue({ Item: item });
    const written = await finalizeTargetResources(TID, { fence: legFence(item) });
    expect(written.endpointIds).toBe("vpce-aaa,vpce-bbb");
    expect(written.homeLinkPeeringId).toBe("pcx-0123456789abcdef0");
    expect(written.homeLinkHostedZoneId).toBe("Z02066582K5P8SB5ZQ2GD");
    expect(written.vpcCidr).toBe("10.128.0.0/16");
    // 🔴 必须**真的落库**(只看返回值 = 只证明函数内部算过一遍)
    const cmd = updateMock.mock.calls[0][0] as { input: Record<string, unknown> };
    const values = cmd.input.ExpressionAttributeValues as Record<string, Record<string, unknown>>;
    const bag = Object.values(values).find((v) => v && typeof v === "object" && "endpointIds" in v);
    expect(bag, "写库的资源袋里没有 endpointIds").toBeTruthy();
    expect((bag as Record<string, unknown>).homeLinkPeeringId).toBe("pcx-0123456789abcdef0");
  });

  it("🔴 老版本 base 栈没有这些 Output ⇒ **不算合同破坏**(缺就不写,不整轮拒)", async () => {
    readOutputsMock.mockResolvedValue({ ...stockOutputs(), components: {} });
    const item = finalizeItem();
    getMock.mockResolvedValue({ Item: item });
    const written = await finalizeTargetResources(TID, { fence: legFence(item) });
    expect(written.endpointIds).toBeUndefined();
    expect(written.homeLinkPeeringId).toBeUndefined();
    expect(updateMock).toHaveBeenCalled(); // 照样写(只是袋里没有这几个键)
  });

  it("注册时勾了组件但那个栈没装成 ⇒ components **变短**为 observed(不保留没有资源支撑的声称)", async () => {
    readOutputsMock.mockResolvedValue({ ...stockOutputs(), components: {} });
    const item = finalizeItem({ components: ["core", "redshift"] });
    getMock.mockResolvedValue({ Item: item });
    await finalizeTargetResources(TID, { fence: legFence(item) });
    const cmd = updateMock.mock.calls[0][0] as { input: Record<string, unknown> };
    const values = cmd.input.ExpressionAttributeValues as Record<string, unknown>;
    expect(values[":k1"]).toEqual(["core"]);
  });

  it("旧形态 outputs(无 components 键)不炸:等价于「没有可选组件」", async () => {
    readOutputsMock.mockResolvedValue(stockOutputs()); // 只有 base/core
    const item = finalizeItem();
    getMock.mockResolvedValue({ Item: item });
    const resources = await finalizeTargetResources(TID, { fence: legFence(item) });
    expect(resources).toEqual(FULL_RESOURCES);
  });

  it("栈不存在(部署未完成)⇒ LifecyclePreconditionError 指向先 deploy,零写入", async () => {
    readOutputsMock.mockRejectedValue(
      new Error("读不到栈 BgpExecEnv-tgt-usw2-a-base(region=us-west-2):does not exist —— 部署未完成或未部署,先 deploy 再回写")
    );
    const item = finalizeItem();
    getMock.mockResolvedValue({ Item: item });
    await expect(finalizeTargetResources(TID, { fence: legFence(item) })).rejects.toThrow(LifecyclePreconditionError);
    await expect(finalizeTargetResources(TID, { fence: legFence(item) })).rejects.toThrow(/读不到栈 BgpExecEnv-tgt-usw2-a-base/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("target 不存在 / 缺 version ⇒ 拒(在核 fence 之前)", async () => {
    const item = finalizeItem();
    getMock.mockResolvedValueOnce({ Item: undefined });
    await expect(finalizeTargetResources(TID, { fence: legFence(item) })).rejects.toThrow(/执行目标不存在/);
    getMock.mockResolvedValueOnce({ Item: finalizeItem({ version: undefined }) });
    await expect(finalizeTargetResources(TID, { fence: legFence(item) })).rejects.toThrow(/缺 version/);
  });

  it("🔴 fence 与 item 不一致(如 lockEpoch 对不上)⇒ assertFinalizeFence 拒且零写入(§21.1.1)", async () => {
    const item = finalizeItem();
    readOutputsMock.mockResolvedValue(stockOutputs());
    getMock.mockResolvedValue({ Item: item });
    const badFence = { ...legFence(item), lockEpoch: 999 } as FinalizeLifecycleFence;
    await expect(finalizeTargetResources(TID, { fence: badFence })).rejects.toThrow(/finalize.*(tuple|snapshot).*已变化/);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 集成缝回归:register 不写 ready 字段 × reconcile 的条件写
// ══════════════════════════════════════════════════════════════════════════════
describe("🔴 集成缝回归:刚 register 的 item(无 ready 属性)必须能被 reconcile 回写", () => {
  it("reconcileTarget 的 ConditionExpression 用 (attribute_not_exists(#r) OR #r = :false),不是裸 #r = :false", async () => {
    // 旧条件 `#r = :false` 对**不存在的属性**求值为 false ⇒ 每个刚 register 的 item 必然
    // ConditionalCheckFailed,部署回写永远进不去 —— 这是切片 c(register 刻意不写 ready)
    // 与 v3.7 reconcile 条件的集成缝,本测试钉住修正后的形状。
    getMock.mockResolvedValue({ Item: registeredItem({ resources: FULL_RESOURCES }) });
    await reconcileTarget(TID, { displayName: "美西 A" }, { expectedVersion: 3 });
    const cmd = updateMock.mock.calls[0][0] as { input: { ConditionExpression: string } };
    expect(cmd.input.ConditionExpression).toContain("(attribute_not_exists(#r) OR #r = :false)");
    expect(cmd.input.ConditionExpression).not.toMatch(/AND #r = :false AND/);
  });
});

// 🔴 v3.15(§22):markTargetTested 已删除(初装→verifying 由 reconcileAfterProbe 携本次 fresh probe 完成);
//    见 reconcileAfterProbe 的完成路测试(registry.test.ts / 新增 reconcile-after-probe.test.ts)。

// ══════════════════════════════════════════════════════════════════════════════
// writeProbeResult
// ══════════════════════════════════════════════════════════════════════════════
describe("writeProbeResult(探活结果的专用窄通道;形状 fail-closed)", () => {
  const okProbe = { at: NOW_ISO, ok: true, items: [{ name: "datalakeBucket", ok: true }] };

  it("成功:只 SET probe + updatedAt,条件 attribute_exists(sk),不动 version", async () => {
    await writeProbeResult(TID, okProbe);
    const cmd = updateMock.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(cmd.input.UpdateExpression).toBe("SET probe = :p, updatedAt = :t");
    expect(cmd.input.ConditionExpression).toBe("attribute_exists(sk)");
    expect(String(cmd.input.UpdateExpression)).not.toContain("version");
  });

  it("🔴 非 canonical at ⇒ 拒(完成态 fence 要 exact 等值,松格式会让完成写永远拒;§21.4 parseProbeResult)", async () => {
    await expect(writeProbeResult(TID, { ...okProbe, at: "soon" })).rejects.toThrow(/probe\.at 不是 canonical/);
    expect(updateMock).not.toHaveBeenCalled();
    // 缺毫秒/带偏移也不是 canonical(round-trip 不稳)
    await expect(writeProbeResult(TID, { ...okProbe, at: "2026-09-01T00:00:00Z" })).rejects.toThrow(/canonical/);
  });

  it("🔴 空 items ⇒ 拒(空数组的 every() 恒 true = 什么都没探也能全绿;schema .min(1))", async () => {
    await expect(writeProbeResult(TID, { ...okProbe, items: [] })).rejects.toThrow(/形态非法|items/);
  });

  it("🔴 ok 与 items 矛盾 ⇒ 拒(items 有红却 ok:true 的结果不许落库)", async () => {
    await expect(
      writeProbeResult(TID, { at: NOW_ISO, ok: true, items: [{ name: "x", ok: false, error: "gone" }] })
    ).rejects.toThrow(/矛盾/);
  });

  it("元素形状坏(缺 name / ok 非布尔)⇒ 拒", async () => {
    await expect(
      writeProbeResult(TID, { at: NOW_ISO, ok: true, items: [{ name: "", ok: true }] })
    ).rejects.toThrow(/形态非法/);
    await expect(
      writeProbeResult(TID, { at: NOW_ISO, ok: true, items: [{ name: "x", ok: "yes" as unknown as boolean }] })
    ).rejects.toThrow(/形态非法/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// enableTarget
// ══════════════════════════════════════════════════════════════════════════════
describe("enableTarget(verifying→ready;只消费本次 fresh probe 的 EnableLifecycleFence §21.4.1)", () => {
  // modern verifying item(双轴齐、无 operation、无锁、raw 投影 status=testing/ready=false);probe = 本次 fresh green。
  function verifyingItem(over: Record<string, unknown> = {}) {
    return registeredItem({
      status: "testing",
      ready: false,
      resources: FULL_RESOURCES,
      probe: GREEN_PROBE,
      spec: { intent: "serve", desiredComponents: ["core"] },
      observed: { phase: "verifying", health: "unknown", components: ["core"], probe: GREEN_PROBE },
      ...over,
    });
  }
  function enableFenceFor(item: Record<string, unknown>): EnableLifecycleFence {
    const probe = item.probe as ProbeResult;
    return {
      expectedVersion: item.version as number,
      fromPhase: "verifying",
      probeAt: probe.at,
      probe,
      desiredComponents: [...(item.spec as { desiredComponents: string[] }).desiredComponents],
      observedComponents: [...(item.observed as { components: string[] }).components],
      probeInput: probeInputOf(item as unknown as ExecutionTarget),
    };
  }

  it("成功:verifying→ready,写 observed(phase=ready)+ 物化 status=active;enableFence 条件绑 attribute_not_exists(operation)+ testing/ready=false 前态", async () => {
    const item = verifyingItem();
    getMock.mockResolvedValue({ Item: item });
    await enableTarget(TID, { fence: enableFenceFor(item) });
    const cmd = updateMock.mock.calls[0][0] as { input: Record<string, unknown> };
    const cond = String(cmd.input.ConditionExpression);
    expect(cond).toContain("#v = :expected");
    expect(cond).toContain("attribute_not_exists(#o.#enableOperation)"); // 无在途 operation
    expect(cond).toContain("#enableStatus = :enableTesting"); // 前态投影 testing
    const values = cmd.input.ExpressionAttributeValues as Record<string, unknown>;
    expect((values[":obs"] as { phase: string }).phase).toBe("ready");
    expect(values[":status"]).toBe("active"); // ready + healthy + 无 op ⇒ active
    expect(values[":ready"]).toBe(true);
  });

  it("🔴 本次 probe 未全绿 ⇒ 拒(fence 的 probe 红 ⇒ validateExactGreen 拒),且不写", async () => {
    const redProbe: ProbeResult = { at: NOW_ISO, ok: false, items: [{ name: "datalakeBucket", ok: false, error: "e" }] };
    const item = verifyingItem({ probe: redProbe, observed: { phase: "verifying", health: "unknown", components: ["core"], probe: redProbe } });
    getMock.mockResolvedValue({ Item: item });
    await expect(enableTarget(TID, { fence: enableFenceFor(item) })).rejects.toThrow();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("phase 非 verifying ⇒ 拒且不写(LifecyclePreconditionError)", async () => {
    const item = verifyingItem({ observed: { phase: "ready", health: "healthy", components: ["core"], probe: GREEN_PROBE } });
    getMock.mockResolvedValue({ Item: item });
    await expect(enableTarget(TID, { fence: enableFenceFor(item) })).rejects.toThrow(LifecyclePreconditionError);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("🔴 observed.operation 在途 ⇒ 拒(升级中不许 enable)", async () => {
    const item = verifyingItem({
      observed: {
        phase: "verifying",
        health: "unknown",
        components: ["core"],
        probe: GREEN_PROBE,
        operation: { kind: "deploy", operationId: "op_x", lockEpoch: 1, startedAt: NOW_ISO, disruptive: true },
      },
    });
    getMock.mockResolvedValue({ Item: item });
    await expect(enableTarget(TID, { fence: enableFenceFor(item) })).rejects.toThrow(LifecyclePreconditionError);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("target 不存在 ⇒ LifecyclePreconditionError", async () => {
    const item = verifyingItem();
    getMock.mockResolvedValue({ Item: undefined });
    await expect(enableTarget(TID, { fence: enableFenceFor(item) })).rejects.toThrow(LifecyclePreconditionError);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 P50.3a 窄通道 mergeComponentResources —— 给**已启用**的 target 补充部署时回写
// 【为什么需要它】reconcileTarget 的维修态门要求 ready=false;而"给 active 环境加组件"是
// §2.1/§4.6 明文认可的操作 ⇒ 门缺通道(真跑实测:dms 栈建成了、回写被拒、组件永远进不了注册表)。
// 修法不是放宽那道门,而是另开只增不改的窄通道 —— 四条硬约束逐条钉在下面。
// ══════════════════════════════════════════════════════════════════════════════
describe("🔴 mergeComponentResources(补充部署窄通道:只增不改;§21.3 强制收 legacy/deploy fence)", () => {
  // 🔴 v3.15:普通 active-legacy **不能**在线 merge;只有"升级前部署遗留的 bug#11 item"(initializing/upgrading ∧ ready)
  //    才允许 legacy fence merge(§21.3)。以下夹具即该形态 + broker 锁。
  function bug11Item(over: Record<string, unknown> = {}) {
    return registeredItem({ ...LEG_LOCK, status: "upgrading", ready: true, resources: { ...FULL_RESOURCES }, ...over });
  }
  const DMS_RES = { dmsSubnetGroup: "bgp-dms-subnet-group-tgt-usw2-a" };
  const merge = (item: Record<string, unknown>, input: { components: string[]; resources: Record<string, unknown> }) =>
    mergeComponentResources(TID, { ...input, expectedVersion: item.version as number, finalizeFence: legFence(item) });

  beforeEach(() => {
    updateMock.mockResolvedValue({});
  });

  it("追加组件 + 组件私有资源:只写 components/resources.<新键>/version/updatedAt,身份与状态字段一个都不碰", async () => {
    const item = bug11Item();
    getMock.mockResolvedValue({ Item: item });
    await merge(item, { components: ["core", "dms"], resources: DMS_RES });
    const expr = updateMock.mock.calls[0][0].input.UpdateExpression as string;
    expect(expr).toContain("#comp = :comp");
    expect(expr).toMatch(/#res\.#resourceKey0 = :resourceValue0/); // §21.3 map 路径写(只增不改)
    expect(expr).toContain("#v = :next");
    for (const forbidden of ["#st ", "#r =", "credentialIsolationState", "accountId", "region", "partition"]) {
      expect(expr, `UpdateExpression 不该出现 ${forbidden}`).not.toContain(forbidden);
    }
    // 条件写三绑仍在(fence 条件在其后追加,故用 toContain)
    const cond = updateMock.mock.calls[0][0].input.ConditionExpression as string;
    expect(cond).toContain("attribute_exists(sk)");
    expect(cond).toContain("#v = :expected");
    expect(cond).toContain("#r = :true");
    expect(updateMock.mock.calls[0][0].input.ExpressionAttributeValues[":comp"]).toEqual(["core", "dms"]);
  });

  it("🔴 ① 只许碰组件私有键:新增 core/base 的键(如 datalakeBucket 之外的 vpcId)被拒", async () => {
    const item = bug11Item({ resources: { ...FULL_RESOURCES, vpcId: undefined } });
    getMock.mockResolvedValue({ Item: item });
    await expect(
      merge(item, { components: ["core", "dms"], resources: { ...DMS_RES, vpcId: "vpc-0aaaabbbbccccdddd" } })
    ).rejects.toThrow(/只许写 §3.1a 组件配套映射里的键/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("🔴 ② 只增不改:已有键的值不同 ⇒ 拒(改既有资源 = 在线改路由)", async () => {
    const item = bug11Item();
    getMock.mockResolvedValue({ Item: item });
    await expect(
      merge(item, { components: ["core"], resources: { datalakeBucket: "someone-elses-bucket" } })
    ).rejects.toThrow(/只增不改/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  // ── @kf-batch 50-WP18e-setvalued-resource:**集合型**观测键按集合判,不按字节判 ──────────────
  // 🔴 真环境实测(2026-09-16,段 w3h 之后):重新部署给 us-west-2 多建了一个接口端点(12 → 13),
  //   finalize 报「拒绝改写已有资源 resources.endpointIds」⇒ 不 finalize ⇒ target 停在 upgrading
  //   且**部署锁一直不放**⇒ 之后任何运维动作都被拒(「必须走 finalize/probe」而 probe 正好 finalize 不了)
  //   = **死锁**。逐字节比还顺带埋着「CFN Output 顺序不保证」那颗雷。
  it("🔴 集合型键**只增**(旧成员一个不少 + 有新增)⇒ 允许写", async () => {
    const item = bug11Item({ resources: { ...FULL_RESOURCES, endpointIds: "vpce-a,vpce-b" } });
    getMock.mockResolvedValue({ Item: item });
    await merge(item, { components: ["core"], resources: { endpointIds: "vpce-a,vpce-b,vpce-c" } });
    const expr = updateMock.mock.calls[0][0].input.UpdateExpression as string;
    expect(expr).toMatch(/#res\.#resourceKey0 = :resourceValue0/);
    expect(updateMock.mock.calls[0][0].input.ExpressionAttributeValues[":resourceValue0"]).toBe("vpce-a,vpce-b,vpce-c");
  });

  it("🔴 集合型键**只是顺序不同** ⇒ 视为无变化,不写(逐字节比会把重排当改写 ⇒ 同一个死锁)", async () => {
    const item = bug11Item({ resources: { ...FULL_RESOURCES, endpointIds: "vpce-a,vpce-b" } });
    getMock.mockResolvedValue({ Item: item });
    await merge(item, { components: ["core"], resources: { endpointIds: "vpce-b,vpce-a" } });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("🔴 集合型键**少了/换了**旧成员 ⇒ 照旧拒(那是在线改路由,必须走维修态)", async () => {
    const item = bug11Item({ resources: { ...FULL_RESOURCES, endpointIds: "vpce-a,vpce-b" } });
    getMock.mockResolvedValue({ Item: item });
    await expect(
      merge(item, { components: ["core"], resources: { endpointIds: "vpce-a,vpce-z" } })
    ).rejects.toThrow(/只增不改/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("🔴 非集合型键即使「看起来像加了一段」也照旧拒(集合语义只给显式清单里的键)", async () => {
    const item = bug11Item();
    getMock.mockResolvedValue({ Item: item });
    await expect(
      merge(item, { components: ["core"], resources: { datalakeBucket: `${FULL_RESOURCES.datalakeBucket},extra` } })
    ).rejects.toThrow(/只增不改/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("已有键的值**相同** ⇒ 视为无增量,不写(幂等重复调用不涨 version)", async () => {
    const item = bug11Item({ components: ["core", "dms"], resources: { ...FULL_RESOURCES, ...DMS_RES } });
    getMock.mockResolvedValue({ Item: item });
    await merge(item, { components: ["core", "dms"], resources: DMS_RES });
    expect(updateMock).not.toHaveBeenCalled();
  });

  // ── @kf-batch 50-W5-seg1-WP3:执行角色键的唯一例外(SPEC v3.21 §3.1a 规则 ②)────────────────────────
  // 【为什么必须有例外】WP-3 把 core 栈的 glueRoleArn 从 home 名切成本 target 名、并新增 emrExecutionRoleArn;
  //   已启用 target 的回写只有本通道,而 ①② 恰好把这两种写都拒掉 ⇒ 「重新部署切角色」根本写不进描述符(开工勘出)。
  //   例外由命名 SSOT 判定:「新增本 target 名」或「home 名 → 本 target 名」;桶 / workgroup / 凭证一个字节都碰不到。
  const PER_GLUE = `arn:aws:iam::${ACCT}:role/BgpExecEnv-tgt-usw2-a-glue-role`;
  const PER_EMR = `arn:aws:iam::${ACCT}:role/BgpExecEnv-tgt-usw2-a-emr-role`;

  it("🔴 E-147 切换:glueRoleArn home 名 → 本 target 名 ⇒ 放行(map 路径写该键;其余键一个不碰)", async () => {
    const item = bug11Item(); // FULL_RESOURCES.glueRoleArn = home 的 bgp-glue-role
    getMock.mockResolvedValue({ Item: item });
    await merge(item, { components: ["core"], resources: { glueRoleArn: PER_GLUE } });
    const call = updateMock.mock.calls[0][0].input;
    expect(call.UpdateExpression).toMatch(/#res\.#resourceKey0 = :resourceValue0/);
    expect(call.ExpressionAttributeNames["#resourceKey0"]).toBe("glueRoleArn");
    expect(call.ExpressionAttributeValues[":resourceValue0"]).toBe(PER_GLUE);
    expect(call.UpdateExpression).not.toMatch(/#res = /);
  });

  it("🔴 E-147 新增:emrExecutionRoleArn(core 新键)= 本 target 名 ⇒ 放行(不算「非组件资源键」)", async () => {
    const item = bug11Item({ resources: { ...FULL_RESOURCES, emrExecutionRoleArn: undefined } }); // 存量:还没有这个键
    getMock.mockResolvedValue({ Item: item });
    await merge(item, { components: ["core"], resources: { emrExecutionRoleArn: PER_EMR } });
    const call = updateMock.mock.calls[0][0].input;
    expect(call.ExpressionAttributeNames["#resourceKey0"]).toBe("emrExecutionRoleArn");
    expect(call.ExpressionAttributeValues[":resourceValue0"]).toBe(PER_EMR);
  });

  it.each([
    ["切成别的 target 的名", { glueRoleArn: `arn:aws:iam::${ACCT}:role/BgpExecEnv-tgt-euw1-b-glue-role` }],
    ["新增的 emr 角色不是本 target 名(home 名)", { emrExecutionRoleArn: `arn:aws:iam::${ACCT}:role/bgp-emr-serverless-role` }],
    ["新增的 copy 角色是别 target 的名", { redshiftCopyRoleArn: `arn:aws:iam::${ACCT}:role/BgpExecEnv-tgt-euw1-b-redshift-copy-role` }],
  ])("🔴 变异靶:%s ⇒ 拒且零写入", async (_n, res) => {
    const item = bug11Item();
    getMock.mockResolvedValue({ Item: item });
    await expect(merge(item, { components: ["core"], resources: res })).rejects.toThrow(/执行角色键只许/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("🔴 变异靶:本 target 名 → 切回 home 名 ⇒ 拒(单向门)", async () => {
    const item = bug11Item({ resources: { ...FULL_RESOURCES, glueRoleArn: PER_GLUE } });
    getMock.mockResolvedValue({ Item: item });
    await expect(merge(item, { components: ["core"], resources: { glueRoleArn: FULL_RESOURCES.glueRoleArn } })).rejects.toThrow(/执行角色键只许/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("🔴 例外不外溢:同一次 merge 里桶名改了照旧被「只增不改」拒(角色键放行不等于袋子放开)", async () => {
    const item = bug11Item();
    getMock.mockResolvedValue({ Item: item });
    await expect(
      merge(item, { components: ["core"], resources: { glueRoleArn: PER_GLUE, datalakeBucket: "someone-elses-bucket" } })
    ).rejects.toThrow(/只增不改/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("🔴 ③ 组件集只增不减:少传一个已装组件 ⇒ 拒并指向删除流程", async () => {
    const item = bug11Item({ components: ["core", "dms"], resources: { ...FULL_RESOURCES, ...DMS_RES } });
    getMock.mockResolvedValue({ Item: item });
    await expect(merge(item, { components: ["core"], resources: {} })).rejects.toThrow(/摘组件是删除流程/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("🔴 ④ post-image 过 §3.1a:声称组件却缺它的配套资源 ⇒ 拒且零写入", async () => {
    const item = bug11Item();
    getMock.mockResolvedValue({ Item: item });
    await expect(merge(item, { components: ["core", "dms"], resources: {} })).rejects.toThrow(/整包校验不过/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("🔴 未启用的 target 不走本通道(它该走 reconcile 的维修态门)", async () => {
    const item = finalizeItem(); // ready 未置
    getMock.mockResolvedValue({ Item: item });
    await expect(merge(item, { components: ["core", "dms"], resources: DMS_RES })).rejects.toThrow(/只服务\*\*已启用\*\*的 target/);
  });

  it("🔴 普通 active-legacy(非 initializing/upgrading)不能在线 merge(§21.3:legacy merge 前置)", async () => {
    const item = bug11Item({ status: "active" });
    getMock.mockResolvedValue({ Item: item });
    await expect(merge(item, { components: ["core", "dms"], resources: DMS_RES })).rejects.toThrow(/legacy merge 前置不满足/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("🔴 finalize 按 ready 分流:ready=true ⇒ 走窄通道(不再撞维修态门,组件能真落地)", async () => {
    const item = bug11Item();
    readOutputsMock.mockResolvedValue({ ...stockOutputs(), components: { dms: DMS_RES } });
    getMock.mockResolvedValue({ Item: item });
    await finalizeTargetResources(TID, { fence: legFence(item) });
    const expr = updateMock.mock.calls[0][0].input.UpdateExpression as string;
    // 窄通道的形状:map 路径写(#res.#resourceKeyN),而不是 reconcile 的整袋覆盖(#res = :res)
    expect(expr).toMatch(/#res\.#resourceKey0 = :resourceValue0/);
    expect(expr).not.toMatch(/#res = /);
    expect(updateMock.mock.calls[0][0].input.ExpressionAttributeValues[":comp"]).toEqual(["core", "dms"]);
  });
});
