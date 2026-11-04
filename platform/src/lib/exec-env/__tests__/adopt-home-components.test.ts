// @kf-batch 50-WP15-airflow-serverless
// 🔴 home 组件**只增采纳**通道(SPEC v3.28 §1.1 / §2.1 seed-home):真环境首刀 `POST seed-home` 走 reconcileTarget 被维修态门拒(HTTP 500),
//    home 永远声称不了控制面新建的 airflow-serverless。本文件钉五条硬约束(只 home / 只增不改 / 三处同步 / 真探全绿 / 条件写)。
// 🔴 涉网依赖一律顶层 import + 顶层 vi.mock(E-64)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getMock, updateMock } = vi.hoisted(() => ({ getMock: vi.fn(), updateMock: vi.fn() }));
vi.mock("@/lib/aws/dynamodb", () => ({
  docClient: { send: (cmd: { __kind: string }) => (cmd.__kind === "get" ? getMock(cmd) : updateMock(cmd)) },
  TABLES: { EXECUTION_ENVS: "bgp-execution-envs" },
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  GetCommand: class { __kind = "get"; constructor(public input: Record<string, unknown>) {} },
  PutCommand: class { __kind = "put"; constructor(public input: Record<string, unknown>) {} },
  QueryCommand: class { __kind = "query"; constructor(public input: Record<string, unknown>) {} },
  UpdateCommand: class { __kind = "update"; constructor(public input: Record<string, unknown>) {} },
}));
vi.mock("@/lib/exec-env/stack-outputs", () => ({ readExecEnvStackOutputs: vi.fn() }));
// seed-home.ts 在模块加载期构造 AWS 客户端 ⇒ 全部顶层 mock(只用它的纯函数 buildHomeDescriptor 造合法 home)
vi.mock("@aws-sdk/client-ec2", () => ({ EC2Client: class { send = vi.fn(); }, DescribeSecurityGroupsCommand: class { constructor(public input: unknown) {} } }));
vi.mock("@aws-sdk/client-secrets-manager", () => ({ SecretsManagerClient: class { send = vi.fn(); }, DescribeSecretCommand: class { constructor(public input: unknown) {} } }));
vi.mock("@aws-sdk/client-database-migration-service", () => ({ DatabaseMigrationServiceClient: class { send = vi.fn(); }, DescribeReplicationSubnetGroupsCommand: class { constructor(public input: unknown) {} } }));
vi.mock("@aws-sdk/client-iam", () => ({ IAMClient: class { send = vi.fn(); }, GetRoleCommand: class { constructor(public input: unknown) {} } }));
vi.mock("@aws-sdk/client-s3", () => ({ S3Client: class { send = vi.fn(); }, HeadBucketCommand: class { constructor(public input: unknown) {} } }));
vi.mock("@aws-sdk/client-bedrock-agentcore-control", () => ({
  BedrockAgentCoreControlClient: class { send = vi.fn(); },
  GetAgentRuntimeCommand: class { constructor(public input: unknown) {} },
  GetMemoryCommand: class { constructor(public input: unknown) {} },
  ListGatewaysCommand: class { constructor(public input: unknown) {} },
  GetGatewayCommand: class { constructor(public input: unknown) {} },
}));
vi.mock("@/lib/exec-env/aws-context", () => ({
  getControlPlaneContext: vi.fn(async () => ({ accountId: "123456789012", region: "us-east-1", partition: "aws" })),
}));

import { adoptHomeComponents, LifecyclePreconditionError, HOME_TARGET_ID } from "@/lib/exec-env/registry";
import { buildHomeDescriptor, type HomeFacts } from "@/lib/exec-env/seed-home";
import type { ProbeResult } from "@/lib/exec-env/lifecycle";

const ACCT = "123456789012";
const FACTS: HomeFacts = {
  accountId: ACCT,
  region: "us-east-1",
  partition: "aws",
  emrSecurityGroupId: "sg-0123456789abcdef0",
  emrSubnetIds: ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"],
  redshiftSecretArn: `arn:aws:secretsmanager:us-east-1:${ACCT}:secret:redshift-admin-AbCdEf`,
  dmsPresent: true,
  flinkPresent: true,
  flinkRoleArn: `arn:aws:iam::${ACCT}:role/bgp-flink-role`,
};
const SLS = { workflowBucket: `bgp-airflow-sls-${ACCT}`, roleArn: `arn:aws:iam::${ACCT}:role/bgp-airflow-sls-role`, sgId: "sg-0aaaaaaaaaaaaaaa1" };
const NOW = "2026-09-06T12:00:00.000Z";

/** 库里的 home:现网形状 = 双轴 + active/ready + version 2,尚未声称 airflow-serverless。 */
function homeItem(over: Record<string, unknown> = {}) {
  const d = buildHomeDescriptor(FACTS, "admin", NOW);
  return {
    ...d,
    pk: "env",
    sk: HOME_TARGET_ID,
    targetId: HOME_TARGET_ID,
    version: 2,
    spec: { intent: "serve", desiredComponents: [...d.components] },
    observed: { phase: "ready", health: "healthy", components: [...d.components] },
    ...over,
  } as Record<string, unknown>;
}
/** 本次候选 = 三样探到 ⇒ 组件 + 三键都多出来。 */
function candidate() {
  return buildHomeDescriptor({ ...FACTS, airflowServerless: SLS }, "admin", NOW);
}
function greenProbe(components: string[]): ProbeResult {
  // 项名口径 = component-contract:core 项是裸键名(datalakeBucket…),非 core 项是 `<组件>:<…>`
  const items = components.map((c) => ({ name: c === "core" ? "datalakeBucket" : `${c}:main`, ok: true, latencyMs: 5 }));
  return { at: NOW, ok: true, items } as unknown as ProbeResult;
}
const lastUpdate = () => updateMock.mock.calls[updateMock.mock.calls.length - 1][0].input as { UpdateExpression: string; ConditionExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Record<string, unknown> };
/** DynamoDB 规则:表达式里出现的 #/: token 与 names/values 定义**双向相等**(定义未用 / 用了未定义都是 ValidationException,mock 测不出)。 */
function expectBalanced(u: ReturnType<typeof lastUpdate>) {
  const text = `${u.UpdateExpression} ${u.ConditionExpression}`;
  const used = { names: new Set(text.match(/#[A-Za-z0-9_]+/g) ?? []), values: new Set(text.match(/:[A-Za-z0-9_]+/g) ?? []) };
  expect(Array.from(used.names).sort()).toEqual(Object.keys(u.ExpressionAttributeNames).sort());
  expect(Array.from(used.values).sort()).toEqual(Object.keys(u.ExpressionAttributeValues).sort());
}

describe("🔴 adoptHomeComponents(home 只增采纳通道)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMock.mockResolvedValue({});
  });

  it("正向:采纳 airflow-serverless + 三键 ⇒ components / spec.desiredComponents / observed.components 三处同步、resources 走 map-path 只增、probe 一并落;条件绑 version ∧ ready ∧ 无 operation ∧ 无锁", async () => {
    getMock.mockResolvedValue({ Item: homeItem() });
    const c = candidate();
    const r = await adoptHomeComponents({ components: c.components ?? [], resources: c.resources as Record<string, unknown>, expectedVersion: 2, probe: greenProbe(c.components ?? []) });
    expect(r.changed).toBe(true);
    expect(r.added).toEqual(["airflow-serverless"]);
    expect(r.addedResources.sort()).toEqual(["airflowServerlessRoleArn", "airflowServerlessSgId", "workflowBucket"]);
    const u = lastUpdate();
    expect(u.UpdateExpression).toContain("#comp = :comp");
    expect(u.UpdateExpression).toContain("#observed.#observedComponents = :observedComponents");
    expect(u.UpdateExpression).toContain("#spec.#desired = :desired");
    expect(u.UpdateExpression).toContain("#probe = :probe");
    expect(u.UpdateExpression).toMatch(/#res\.#resourceKey0 = :resourceValue0/);
    expect(u.UpdateExpression).not.toMatch(/#res = :/); // 绝不整袋覆盖
    for (const cond of ["#v = :expected", "#r = :true", "attribute_not_exists(#observed.#op)", "attribute_not_exists(#lock)"]) expect(u.ConditionExpression).toContain(cond);
    expect(u.ExpressionAttributeValues[":comp"]).toContain("airflow-serverless");
    expect(u.ExpressionAttributeValues[":desired"]).toEqual(u.ExpressionAttributeValues[":comp"]);
    expect(u.ExpressionAttributeValues[":observedComponents"]).toEqual(u.ExpressionAttributeValues[":comp"]);
    // 身份 / 状态 / 凭证状态机字段一个都不在 UpdateExpression 里
    for (const bad of ["accountId", "region", "partition", "status", "credentialIsolationState", "lockEpoch"]) expect(Object.values(u.ExpressionAttributeNames)).not.toContain(bad);
    expectBalanced(u);
  });

  it("幂等:候选与库里一致 ⇒ 零写(changed=false)", async () => {
    const full = candidate();
    getMock.mockResolvedValue({ Item: homeItem({ components: full.components, resources: full.resources, spec: { intent: "serve", desiredComponents: full.components }, observed: { phase: "ready", health: "healthy", components: full.components } }) });
    const r = await adoptHomeComponents({ components: full.components ?? [], resources: full.resources as Record<string, unknown>, expectedVersion: 2, probe: greenProbe(full.components ?? []) });
    expect(r.changed).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("🔴 只增不改:改既有资源键值 ⇒ 拒且零写", async () => {
    getMock.mockResolvedValue({ Item: homeItem() });
    const c = candidate();
    await expect(
      adoptHomeComponents({ components: c.components ?? [], resources: { ...(c.resources as Record<string, unknown>), dagBucket: "bgp-mwaa-dags-evil" }, expectedVersion: 2, probe: greenProbe(c.components ?? []) })
    ).rejects.toThrow(/只增不改/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("🔴 只增不减:候选少了既有组件 ⇒ 拒", async () => {
    getMock.mockResolvedValue({ Item: homeItem() });
    const c = candidate();
    await expect(
      adoptHomeComponents({ components: (c.components ?? []).filter((x) => x !== "flink"), resources: c.resources as Record<string, unknown>, expectedVersion: 2, probe: greenProbe(c.components ?? []) })
    ).rejects.toThrow(/摘掉 home 组件/);
  });

  it("🔴 非组件私有键(core 键)不许经采纳通道新增", async () => {
    getMock.mockResolvedValue({ Item: homeItem() });
    const c = candidate();
    await expect(
      adoptHomeComponents({ components: c.components ?? [], resources: { ...(c.resources as Record<string, unknown>), vpcId: "vpc-0123456789abcdef0" }, expectedVersion: 2, probe: greenProbe(c.components ?? []) })
    ).rejects.toThrow(/非组件资源键/);
  });

  it("🔴 真探未覆盖新组件 / 有红项 ⇒ 拒(声称没探过的组件 = 撒谎)", async () => {
    getMock.mockResolvedValue({ Item: homeItem() });
    const c = candidate();
    const without = greenProbe((c.components ?? []).filter((x) => x !== "airflow-serverless"));
    await expect(adoptHomeComponents({ components: c.components ?? [], resources: c.resources as Record<string, unknown>, expectedVersion: 2, probe: without })).rejects.toThrow(/真探未全绿或未覆盖/);
    const red = greenProbe(c.components ?? []);
    (red as unknown as { ok: boolean; items: Array<{ ok: boolean }> }).items[0].ok = false;
    (red as unknown as { ok: boolean }).ok = false;
    await expect(adoptHomeComponents({ components: c.components ?? [], resources: c.resources as Record<string, unknown>, expectedVersion: 2, probe: red })).rejects.toThrow(LifecyclePreconditionError);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("🔴 前置:非 active/ready、版本不符、在途 operation、残留部署锁 ⇒ 各自拒", async () => {
    const c = candidate();
    const args = { components: c.components ?? [], resources: c.resources as Record<string, unknown>, expectedVersion: 2, probe: greenProbe(c.components ?? []) };
    getMock.mockResolvedValue({ Item: homeItem({ status: "degraded" }) });
    await expect(adoptHomeComponents(args)).rejects.toThrow(/在服务中的 home/);
    getMock.mockResolvedValue({ Item: homeItem({ version: 3 }) });
    await expect(adoptHomeComponents(args)).rejects.toThrow(/版本已变/);
    getMock.mockResolvedValue({ Item: homeItem({ observed: { phase: "ready", health: "healthy", components: homeItem().components, operation: { kind: "deploy", operationId: "op_x" } } }) });
    await expect(adoptHomeComponents(args)).rejects.toThrow(LifecyclePreconditionError);
    getMock.mockResolvedValue({ Item: homeItem({ deployLockOperationId: "op_y" }) });
    await expect(adoptHomeComponents(args)).rejects.toThrow(/在途部署会话/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("条件写被拒(ConditionalCheckFailedException)⇒ 翻成人话的前置错误", async () => {
    getMock.mockResolvedValue({ Item: homeItem() });
    updateMock.mockRejectedValue(Object.assign(new Error("cond"), { name: "ConditionalCheckFailedException" }));
    const c = candidate();
    await expect(adoptHomeComponents({ components: c.components ?? [], resources: c.resources as Record<string, unknown>, expectedVersion: 2, probe: greenProbe(c.components ?? []) })).rejects.toThrow(/并发操作/);
  });
});
