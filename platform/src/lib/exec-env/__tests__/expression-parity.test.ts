// 🔴 DynamoDB 表达式**配平门禁**(真环境才炸、普通 mock 测不出的一类):
//    DynamoDB 拒绝"定义在 ExpressionAttributeNames/Values 里却未在 UpdateExpression/ConditionExpression
//    中被引用"的 #alias/:val(ValidationException);反之"引用了却未定义"同样拒。
// 本测试把该规则编码成断言,用**真实调用** transitionPhase / mergeComponentResources / reconcileTarget
// **逐分支**捕获真实 UpdateCommand 再双向配平——覆盖每个 fence 分支 + resources/agentcore 存在与否两路。
// (缘由:两个专项审计 agent 连续卡死;这条确定性门禁比 agent 可靠,且永久留存。)
import { describe, it, expect, beforeEach, vi } from "vitest";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock("@/lib/aws/dynamodb", () => ({
  docClient: { send: sendMock },
  TABLES: { EXECUTION_ENVS: "bgp-execution-envs" },
}));

import {
  transitionPhase,
  reconcileTelemetry,
  recordOperationFailure,
  type TargetSpec,
  type TargetObserved,
  type ProbeResult,
  type ProbeInputSnapshot,
  type DeploymentCompletionFence,
  type LegacyCompletionFence,
  type EnableLifecycleFence,
} from "@/lib/exec-env/lifecycle";
import { mergeComponentResources, reconcileTarget, type ExecutionTarget, type FinalizeLifecycleFence } from "@/lib/exec-env/registry";

/** DynamoDB 规则:UpdateExpression+ConditionExpression 里出现的 #/:token 与 names/values 定义**双向相等**。 */
function parity(input: {
  UpdateExpression?: string;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}) {
  const expr = `${input.UpdateExpression ?? ""} ${input.ConditionExpression ?? ""}`;
  const nameToks = new Set(expr.match(/#[A-Za-z0-9_]+/g) ?? []);
  const valToks = new Set(expr.match(/:[A-Za-z0-9_]+/g) ?? []);
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  return {
    unusedNames: Object.keys(names).filter((n) => !nameToks.has(n)),
    unusedValues: Object.keys(values).filter((v) => !valToks.has(v)),
    undefinedNames: [...nameToks].filter((n) => !(n in names)),
    undefinedValues: [...valToks].filter((v) => !(v in values)),
  };
}
function expectBalanced(input: Parameters<typeof parity>[0], label: string) {
  const r = parity(input);
  expect(r.unusedNames, `${label}:定义但未用的 #name(真环境 ValidationException)`).toEqual([]);
  expect(r.unusedValues, `${label}:定义但未用的 :value`).toEqual([]);
  expect(r.undefinedNames, `${label}:用了但未定义的 #name`).toEqual([]);
  expect(r.undefinedValues, `${label}:用了但未定义的 :value`).toEqual([]);
}
const lastUpdate = () => {
  const calls = sendMock.mock.calls.map((c) => c[0]).filter((cmd) => "input" in cmd && String(cmd.input.UpdateExpression ?? "").length);
  return calls[calls.length - 1].input;
};

const CANON = "2026-09-01T00:00:00.000Z";
const serve: TargetSpec = { intent: "serve", desiredComponents: ["core"] };
const green: ProbeResult = { at: CANON, ok: true, items: [{ name: "datalakeBucket", ok: true }] };
const pi = (over: Partial<ProbeInputSnapshot> = {}): ProbeInputSnapshot => ({
  region: "us-west-2",
  accountId: "123456789012",
  partition: "aws",
  components: ["core"],
  resources: undefined,
  agentcore: undefined,
  ...over,
});
const exact = (p: ProbeInputSnapshot) => ({ probeAt: CANON, probe: green, desiredComponents: ["core"], observedComponents: ["core"], probeInput: p });
const deployFence = (p: ProbeInputSnapshot): DeploymentCompletionFence => ({ ...exact(p), operationId: "op_1", lockEpoch: 1, openSnapshotHash: "a".repeat(64), buildId: "b_1", startedAt: CANON });
const stableFence = (p: ProbeInputSnapshot): LegacyCompletionFence => ({ mode: "stable", ...exact(p) });
const sessionFence = (p: ProbeInputSnapshot, mode: "e99" | "initial"): LegacyCompletionFence => ({ mode, session: { lockEpoch: 1, lockToken: "op_1", operationId: "op_1", buildId: "b_1" }, ...exact(p) });
const enableFence = (p: ProbeInputSnapshot): EnableLifecycleFence => ({ ...exact(p), expectedVersion: 3, fromPhase: "verifying" });
const greenObs = (phase: TargetObserved["phase"]): TargetObserved => ({ phase, health: "healthy", components: ["core"], probe: green });

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue({});
});

describe("🔴 transitionPhase 每个 fence 分支的 DynamoDB names/values 配平", () => {
  // resources/agentcore 两路:undefined(attribute_not_exists 分支) 与 存在(= :val 分支)。
  const inputs: Array<[string, ProbeInputSnapshot]> = [
    ["无 resources/agentcore", pi()],
    ["有 resources/agentcore", pi({ resources: { datalakeBucket: "b" }, agentcore: { genbiRuntimeArn: "arn" } })],
  ];

  for (const [label, p] of inputs) {
    it(`completion provisioning→verifying(${label})`, async () => {
      await transitionPhase("tgt_usw2_a", { from: "provisioning", post: { spec: serve, observed: greenObs("verifying") }, expectedVersion: 3, completionFence: deployFence(p), reason: "t" });
      expectBalanced(lastUpdate(), `completion prov→ver(${label})`);
    });
    it(`completion ready→ready(${label})`, async () => {
      await transitionPhase("tgt_usw2_a", { from: "ready", post: { spec: serve, observed: greenObs("ready") }, expectedVersion: 3, completionFence: deployFence(p), reason: "t" });
      expectBalanced(lastUpdate(), `completion ready→ready(${label})`);
    });
    it(`legacy stable(ifAbsent)(${label})`, async () => {
      await transitionPhase("tgt_usw2_a", { from: "ready", ifAbsent: true, post: { spec: serve, observed: greenObs("ready") }, expectedVersion: 3, legacyCompletionFence: stableFence(p), reason: "t" });
      expectBalanced(lastUpdate(), `legacy stable(${label})`);
    });
    it(`legacy e99(ifAbsent+session)(${label})`, async () => {
      await transitionPhase("tgt_usw2_a", { from: "ready", ifAbsent: true, post: { spec: serve, observed: greenObs("ready") }, expectedVersion: 3, legacyCompletionFence: sessionFence(p, "e99"), reason: "t" });
      expectBalanced(lastUpdate(), `legacy e99(${label})`);
    });
    it(`legacy initial(ifAbsent+session,verifying→verifying)(${label})`, async () => {
      await transitionPhase("tgt_usw2_a", { from: "verifying", ifAbsent: true, post: { spec: serve, observed: greenObs("verifying") }, expectedVersion: 3, legacyCompletionFence: sessionFence(p, "initial"), reason: "t" });
      expectBalanced(lastUpdate(), `legacy initial(${label})`);
    });
    it(`enable verifying→ready(${label})`, async () => {
      await transitionPhase("tgt_usw2_a", { from: "verifying", post: { spec: serve, observed: greenObs("ready") }, expectedVersion: 3, enableFence: enableFence(p), reason: "t" });
      expectBalanced(lastUpdate(), `enable(${label})`);
    });
  }

  it("ordinary provisioning→verifying + guards(equals + absent)", async () => {
    await transitionPhase("tgt_usw2_a", { from: "provisioning", post: { spec: serve, observed: greenObs("verifying") }, expectedVersion: 3, guards: [{ path: "probe.ok", equals: true }, { path: "ready", absent: true }], reason: "t" });
    expectBalanced(lastUpdate(), "ordinary+guards");
  });
});

describe("🔴 mergeComponentResources / reconcileTarget 的 fence 写配平", () => {
  const ACCT = "123456789012";
  const FULL = {
    vpcId: "vpc-0123456789abcdef0",
    dataKeyArn: `arn:aws:kms:us-west-2:${ACCT}:key/aaaabbbb-cccc-dddd-eeee-ffffffffffff`,
    privateSubnetIds: ["subnet-0123456789abcdef0"],
    datalakeBucket: `bgp-datalake-${ACCT}-tgt-usw2-a`,
    scriptsBucket: `bgp-glue-scripts-${ACCT}-tgt-usw2-a`,
    tableBucket: "bgp-table-bucket-tgt-usw2-a",
    athenaWorkgroup: "bgp-athena-tgt-usw2-a",
    glueRoleArn: `arn:aws:iam::${ACCT}:role/bgp-glue-role`,
    emrSecurityGroupId: "sg-0123456789abcdef0",
    emrSubnetIds: ["subnet-0123456789abcdef0"],
  };
  const DMS = { dmsSubnetGroup: "bgp-dms-subnet-group-tgt-usw2-a" };
  const item = (over: Record<string, unknown> = {}) => ({
    pk: "env", sk: "tgt_usw2_a", targetId: "tgt_usw2_a", partition: "aws", accountId: ACCT, region: "us-west-2",
    jurisdiction: "home", version: 3, components: ["core"], resources: { ...FULL }, ...over,
  });
  const LOCK = { lockEpoch: 5, deployLockToken: "op_leg", deployLockOperationId: "op_leg", lastOperationId: "op_leg", lastBuildId: "b_leg" };
  const legFence = (it: Record<string, unknown>): FinalizeLifecycleFence => ({
    kind: "legacy", region: "us-west-2", accountId: ACCT, partition: "aws", expectedVersion: it.version as number,
    status: it.status as ExecutionTarget["status"], ready: it.ready as boolean | undefined, components: (it.components as string[]) ?? [],
    probe: it.probe as ProbeResult | undefined, lockEpoch: 5, lockToken: "op_leg", operationId: "op_leg", buildId: "b_leg",
  });

  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
  });

  it("mergeComponentResources(legacy bug#11 upgrading,有 addition)", async () => {
    const it2 = item({ ...LOCK, status: "upgrading", ready: true });
    sendMock.mockImplementation((cmd: { __kind?: string; input?: unknown }) => (cmd.input && String((cmd.input as { UpdateExpression?: string }).UpdateExpression ?? "").length ? {} : { Item: it2 }));
    await mergeComponentResources("tgt_usw2_a", { components: ["core", "dms"], resources: DMS, expectedVersion: 3, finalizeFence: legFence(it2) });
    expectBalanced(lastUpdate(), "merge legacy");
  });

  it("reconcileTarget(legacy 初装 finalize fence,patch=resources+components)", async () => {
    const it2 = item({ ...LOCK, status: "initializing" });
    sendMock.mockImplementation((cmd: { input?: unknown }) => (cmd.input && String((cmd.input as { UpdateExpression?: string }).UpdateExpression ?? "").length ? {} : { Item: it2 }));
    await reconcileTarget("tgt_usw2_a", { resources: { ...FULL }, components: ["core"] }, { expectedVersion: 3, finalizeFence: legFence(it2) });
    expectBalanced(lastUpdate(), "reconcile legacy fence");
  });

  it("reconcileTarget(无 fence,普通内容修补)", async () => {
    const it2 = item({ status: "initializing" });
    sendMock.mockImplementation((cmd: { input?: unknown }) => (cmd.input && String((cmd.input as { UpdateExpression?: string }).UpdateExpression ?? "").length ? {} : { Item: it2 }));
    await reconcileTarget("tgt_usw2_a", { displayName: "美西 A" }, { expectedVersion: 3 });
    expectBalanced(lastUpdate(), "reconcile no-fence");
  });
});

describe("🔴 reconcileTelemetry(2a 周期 telemetry 窄通道)的 DynamoDB names/values 配平", () => {
  // 🔴 新增 DDB 写命令必须纳入本配平门禁 —— reconcileTelemetry 的 unused-names bug 真环境才炸、mock 测不出
  //    ([[mine-reviewer-reference-impl]] 铁律)。捕获它的真实 UpdateCommand 逐向配平。
  const ACCT = "123456789012";
  const modernItem = {
    pk: "env", sk: "tgt_usw2_a", targetId: "tgt_usw2_a", version: 7,
    accountId: ACCT, region: "us-west-2", partition: "aws", status: "active", ready: true, components: ["core"],
    spec: { intent: "serve", desiredComponents: ["core"] },
    observed: { phase: "ready", health: "healthy", components: ["core"] },
  };
  beforeEach(() => {
    sendMock.mockReset();
    // Get → 返回 modern item;Update → {}(与 merge/reconcile 用例同款按 UpdateExpression 路由)。
    sendMock.mockImplementation((cmd: { input?: { UpdateExpression?: string } }) =>
      cmd.input && String(cmd.input.UpdateExpression ?? "").length ? {} : { Item: modernItem }
    );
  });

  it("modern ready 稳态 telemetry 写:names/values 双向配平(防真环境 ValidationException)", async () => {
    const r = await reconcileTelemetry("tgt_usw2_a", { probe: green });
    expect(r).toEqual({ written: true });
    expectBalanced(lastUpdate(), "reconcileTelemetry");
  });
});

describe("🔴 recordOperationFailure(2b 唯一失败写入方)的 DynamoDB names/values 配平", () => {
  // 🔴 同上铁律:新增 DDB 写命令必须纳入配平门禁。本写入方有 **2 mode × buildId 有无** 四条分支,
  //    每条都按分支注册 names/values(buildId 缺失走 attribute_not_exists),逐条真捕获配平。
  const ACCT = "123456789012";
  const OP = "op_2b0001";
  const HASH = "c".repeat(64);
  const operation = (withBuild: boolean) => ({
    kind: "deploy" as const,
    operationId: OP,
    lockEpoch: 4,
    openSnapshotHash: HASH,
    ...(withBuild ? { buildId: "b_2b" } : {}),
    startedAt: CANON,
    disruptive: true,
  });
  const modernItem = (withBuild: boolean, phase: "ready" | "provisioning") => ({
    pk: "env", sk: "tgt_usw2_a", targetId: "tgt_usw2_a", version: 11,
    accountId: ACCT, region: "us-west-2", partition: "aws",
    status: phase === "ready" ? "upgrading" : "initializing", ready: phase === "ready", components: ["core"],
    lockEpoch: 4, deployLockToken: OP, deployLockOperationId: OP, deployLockExpiresAt: 1_800_000_000_000,
    spec: { intent: "serve", desiredComponents: ["core"] },
    observed: { phase, health: "healthy", components: ["core"], probe: green, operation: operation(withBuild) },
  });
  const legacyItem = () => ({
    pk: "env", sk: "tgt_usw2_a", targetId: "tgt_usw2_a", version: 11,
    accountId: ACCT, region: "us-west-2", partition: "aws",
    status: "initializing", ready: false, components: ["core"], probe: green,
    lockEpoch: 4, deployLockToken: "tok_leg", deployLockOperationId: OP, deployLockExpiresAt: 1_800_000_000_000,
    lastOperationId: OP, lastBuildId: "b_leg",
  });
  const disposition = { buildStatus: "FAILED", checkedAt: CANON, stacks: [{ name: "BgpExecEnv-tgt-usw2-a-core", status: "UPDATE_ROLLBACK_COMPLETE", pendingChangeSets: 0 }] };
  const decision = { decisionId: "recover-20260903-abcd", decidedBy: "admin" };
  const routeGet = (item: unknown) =>
    sendMock.mockImplementation((cmd: { input?: { UpdateExpression?: string } }) =>
      cmd.input && String(cmd.input.UpdateExpression ?? "").length ? {} : { Item: item }
    );

  beforeEach(() => {
    sendMock.mockReset();
  });

  for (const [label, withBuild] of [["有 buildId", true], ["无 buildId(startUncertain)", false]] as Array<[string, boolean]>) {
    it(`modern ready 升级失败(${label}):配平`, async () => {
      routeGet(modernItem(withBuild, "ready"));
      const r = await recordOperationFailure("tgt_usw2_a", {
        fence: {
          mode: "modern", region: "us-west-2", accountId: ACCT, partition: "aws", expectedVersion: 11,
          fromPhase: "ready", operationId: OP, lockEpoch: 4, openSnapshotHash: HASH,
          ...(withBuild ? { buildId: "b_2b" } : {}),
          startedAt: CANON, desiredComponents: ["core"], observedComponents: ["core"],
        },
        disposition: withBuild ? disposition : { ...disposition, buildStatus: "no-build" },
        decision,
      });
      expect(r).toEqual({ cleared: true, mode: "modern" });
      expectBalanced(lastUpdate(), `recordOperationFailure modern(${label})`);
    });

    it(`modern provisioning 初装失败(${label}):配平`, async () => {
      routeGet(modernItem(withBuild, "provisioning"));
      await recordOperationFailure("tgt_usw2_a", {
        fence: {
          mode: "modern", region: "us-west-2", accountId: ACCT, partition: "aws", expectedVersion: 11,
          fromPhase: "provisioning", operationId: OP, lockEpoch: 4, openSnapshotHash: HASH,
          ...(withBuild ? { buildId: "b_2b" } : {}),
          startedAt: CANON, desiredComponents: ["core"], observedComponents: ["core"],
        },
        disposition: withBuild ? disposition : { ...disposition, buildStatus: "no-build" },
        decision,
      });
      expectBalanced(lastUpdate(), `recordOperationFailure modern provisioning(${label})`);
    });
  }

  for (const [label, withBuild] of [["带 lastBuildId", true], ["不带 buildId 绑定", false]] as Array<[string, boolean]>) {
    it(`legacy 残留锁清理(${label}):配平`, async () => {
      routeGet(legacyItem());
      const r = await recordOperationFailure("tgt_usw2_a", {
        fence: {
          mode: "legacy", region: "us-west-2", accountId: ACCT, partition: "aws", expectedVersion: 11,
          lockEpoch: 4, lockToken: "tok_leg", operationId: OP,
          ...(withBuild ? { buildId: "b_leg" } : {}),
          status: "initializing", components: ["core"],
        },
        disposition,
        decision,
      });
      expect(r).toEqual({ cleared: true, mode: "legacy" });
      expectBalanced(lastUpdate(), `recordOperationFailure legacy(${label})`);
    });
  }
});
