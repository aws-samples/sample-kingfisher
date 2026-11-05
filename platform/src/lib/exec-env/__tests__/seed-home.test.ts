// home seed 组装的单测(SPEC §1.1 实时查询分支)。
//
// 🔴 涉网依赖一律【顶层 import + 顶层 vi.mock】(事故 E1 的回归要求
//    动态 import × vi.mock 包名会 mock 不接管、拿本机凭证真打 AWS)。
import { describe, it, expect, vi, beforeEach } from "vitest";

// 🔴 vi.hoisted:seed-home.ts 在模块顶层构造 client,mock 工厂执行时普通顶层 const 还在 TDZ
//    (deploy-control.test.ts 同款坑;单跑本文件侥幸通过、全量跑必挂 —— 顺序敏感的假绿要用 hoisted 根治)。
const { ec2Send, smSend, dmsSend, iamSend, acSend, s3Send, mwaaSend, } = vi.hoisted(() => ({
  ec2Send: vi.fn(),
  smSend: vi.fn(),
  dmsSend: vi.fn(),
  iamSend: vi.fn(),
  acSend: vi.fn(),
  s3Send: vi.fn(),
  mwaaSend: vi.fn(async () => { throw Object.assign(new Error("Environment not found"), { name: "ResourceNotFoundException" }); }),
}));
vi.mock("@aws-sdk/client-ec2", () => ({
  EC2Client: class { send = ec2Send; },
  DescribeSecurityGroupsCommand: class { constructor(public input: unknown) {} },
}));
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class { send = smSend; },
  DescribeSecretCommand: class { constructor(public input: unknown) {} },
}));
vi.mock("@aws-sdk/client-database-migration-service", () => ({
  DatabaseMigrationServiceClient: class { send = dmsSend; },
  DescribeReplicationSubnetGroupsCommand: class { constructor(public input: unknown) {} },
}));
vi.mock("@aws-sdk/client-iam", () => ({
  IAMClient: class { send = iamSend; },
  GetRoleCommand: class { constructor(public input: unknown) {} },
}));
// S3 也必须顶层 mock(HeadBucket 探 workflowBucket;漏 mock = 拿本机凭证真打 AWS)
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { send = s3Send; },
  HeadBucketCommand: class { constructor(public input: unknown) {} },
}));
// 经典 MWAA 探测(GetEnvironment)也是真外部:以前没 mock ⇒ 本机拿真凭证真打 AWS、靠真账号「没有这个环境」返回
// ResourceNotFoundException 才绿;CI 上没有凭证就红(2026-11-05)。这里钉成「不存在」—— 正是「探到才声称」判据要的前提。
vi.mock("@aws-sdk/client-mwaa", () => ({
  MWAAClient: class { send = mwaaSend; },
  GetEnvironmentCommand: class { constructor(public input: unknown) {} },
}));
vi.mock("@aws-sdk/client-bedrock-agentcore-control", () => ({
  BedrockAgentCoreControlClient: class { send = acSend; },
  GetAgentRuntimeCommand: class { constructor(public input: unknown) {} },
  GetMemoryCommand: class { constructor(public input: unknown) {} },
  ListGatewaysCommand: class { constructor(public input: unknown) {} },
  GetGatewayCommand: class { constructor(public input: unknown) {} },
}));
vi.mock("@/lib/exec-env/aws-context", () => ({
  getControlPlaneContext: vi.fn(async () => ({ accountId: "123456789012", region: "us-east-1", partition: "aws" })),
}));

import { fetchHomeFacts, buildHomeDescriptor, type HomeFacts } from "@/lib/exec-env/seed-home";
import { descriptorViolation } from "@/lib/exec-env/registry";
import { HOME_TARGET_ID } from "@/lib/exec-env/target-id";

const FACTS: HomeFacts = {
  accountId: "123456789012",
  region: "us-east-1",
  partition: "aws",
  emrSecurityGroupId: "sg-0123456789abcdef0",
  emrSubnetIds: ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"],
  redshiftSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:redshift-admin-AbCdEf",
  dmsPresent: true,
  flinkPresent: true,
  flinkRoleArn: "arn:aws:iam::123456789012:role/bgp-flink-role",
  // 默认 false = 用户 2026-09-14 拍板后的现实(经典 MWAA 不再部署)
  mwaaPresent: false,
};

describe("buildHomeDescriptor(纯函数)", () => {
  it("🔴 候选描述符必须过 §3.1a 整包校验(与 seedHomeTarget 同一权威校验,不是我自己觉得完整)", () => {
    const d = buildHomeDescriptor(FACTS, "admin", "2026-09-01T00:00:00.000Z");
    const candidate = { ...d, pk: "env", sk: HOME_TARGET_ID, targetId: HOME_TARGET_ID };
    expect(descriptorViolation(candidate as never, HOME_TARGET_ID)).toBeNull();
  });

  it("seed 完整判据:ready=true + status=active + home 不变量 + legacy-seeded/epoch 0", () => {
    const d = buildHomeDescriptor(FACTS, "admin", "2026-09-01T00:00:00.000Z");
    expect(d.ready).toBe(true);
    expect(d.status).toBe("active");
    expect(d.isHome).toBe(true);
    expect(d.jurisdiction).toBe("home");
    expect(d.credentialIsolationState).toBe("legacy-seeded");
    expect(d.credentialEpoch).toBe(0);
    expect(d.version).toBe(1);
  });

  it("名字全部出自命名 SSOT 的 home 豁免(抽查关键四个 + 账号拼进桶名)", () => {
    const d = buildHomeDescriptor(FACTS, "admin", "2026-09-01T00:00:00.000Z");
    const r = d.resources as Record<string, unknown>;
    expect(r.datalakeBucket).toBe("bgp-datalake-123456789012");
    expect(r.redshiftWorkgroup).toBe("bgp-workgroup");
    expect(r.athenaWorkgroup).toBe("bgp-athena");
    // 名字仍要出自 SSOT,但只在**真有那个环境**时才写进袋子
    expect(r.mwaaEnvName, "经典 MWAA 不在时不许声称环境名(声称 = 描述符撒谎)").toBeUndefined();
    const withMwaa = buildHomeDescriptor({ ...FACTS, mwaaPresent: true }, "admin", "2026-09-01T00:00:00.000Z");
    expect((withMwaa.resources as Record<string, unknown>).mwaaEnvName).toBe("bgp-mwaa");
    expect(r.glueRoleArn).toBe("arn:aws:iam::123456789012:role/bgp-glue-role");
  });

  it("🔴 门控组件只声称查到的:dms/flink/**mwaa** 缺席时组件与资源都不出现(声称了没装,§3.1a 配套校验会拒)", () => {
    const d = buildHomeDescriptor({ ...FACTS, dmsPresent: false, flinkPresent: false, flinkRoleArn: undefined }, "a", "2026-09-01T00:00:00.000Z");
    expect(d.components).toEqual(["core", "redshift"]);
    const r = d.resources as Record<string, unknown>;
    expect(r.dmsSubnetGroup).toBeUndefined();
    expect(r.flinkRoleArn).toBeUndefined();
    // 且仍然过整包校验(组件↔资源配套自洽)
    const candidate = { ...d, pk: "env", sk: HOME_TARGET_ID, targetId: HOME_TARGET_ID };
    expect(descriptorViolation(candidate as never, HOME_TARGET_ID)).toBeNull();
  });
});

const AC_URL = "https://bgp-genbi-gateway-abcdef1234.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp";

/** agentcore 三资源全健康(runtime READY / memory ACTIVE / gateway READY,字面值真环境核过)。 */
function agentcoreHealthy() {
  acSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    const kind = cmd.constructor.name;
    if (kind === "GetAgentRuntimeCommand") return { status: "READY" };
    if (kind === "GetMemoryCommand") return { memory: { status: "ACTIVE" } };
    if (kind === "ListGatewaysCommand") return { items: [{ name: "bgp-genbi-gateway", gatewayId: "bgp-genbi-gateway-abcdef1234", status: "READY" }] };
    if (kind === "GetGatewayCommand") return { status: "READY", gatewayUrl: AC_URL };
    throw new Error(`未知命令 ${kind}`);
  });
}

describe("fetchHomeFacts(fail-closed:core 真值缺任一即抛)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.EMR_DEFAULT_SUBNET_IDS = "subnet-0123456789abcdef0,subnet-0123456789abcdef1";
    // agentcore 门控的 env 默认清空(不声称);要声称的用例自行设置——防本机 shell 的真值渗进测试
    delete process.env.GENBI_RUNTIME_ARN;
    delete process.env.GENBI_MEMORY_ID;
    ec2Send.mockResolvedValue({ SecurityGroups: [{ GroupId: "sg-0123456789abcdef0" }] });
    smSend.mockResolvedValue({ ARN: FACTS.redshiftSecretArn });
    dmsSend.mockResolvedValue({ ReplicationSubnetGroups: [{}] });
    iamSend.mockResolvedValue({ Role: { Arn: FACTS.flinkRoleArn } });
    s3Send.mockRejectedValue(Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } }));
  });

  it("全部就绪 ⇒ facts 完整且门控组件为真", async () => {
    const f = await fetchHomeFacts();
    expect(f.emrSecurityGroupId).toBe("sg-0123456789abcdef0");
    expect(f.emrSubnetIds).toHaveLength(2);
    expect(f.dmsPresent).toBe(true);
    expect(f.flinkPresent).toBe(true);
  });

  it("🔴 EMR SG 查不到 ⇒ 抛(不写半份描述符)", async () => {
    ec2Send.mockResolvedValue({ SecurityGroups: [] });
    await expect(fetchHomeFacts()).rejects.toThrow(/EMR 默认安全组/);
  });

  it("🔴 EMR_DEFAULT_SUBNET_IDS 为空 ⇒ 抛(部署期注入的真值缺失 = 平台栈部署异常,不臆造)", async () => {
    process.env.EMR_DEFAULT_SUBNET_IDS = "";
    await expect(fetchHomeFacts()).rejects.toThrow(/EMR_DEFAULT_SUBNET_IDS/);
  });

  it("🔴 托管 admin secret 查不到 ARN ⇒ 抛", async () => {
    smSend.mockResolvedValue({});
    await expect(fetchHomeFacts()).rejects.toThrow(/admin secret/);
  });

  it("门控组件**资源不存在**(NotFound 类)⇒ 只是不声称,不是错误(dms/flink 变 false)", async () => {
    dmsSend.mockRejectedValue(Object.assign(new Error("not found"), { name: "ResourceNotFoundFault" }));
    iamSend.mockRejectedValue(Object.assign(new Error("no such entity"), { name: "NoSuchEntityException" }));
    const f = await fetchHomeFacts();
    expect(f.dmsPresent).toBe(false);
    expect(f.flinkPresent).toBe(false);
    expect(f.airflowServerless).toBeUndefined();
  });

  // 真环境撞过:TaskRole 缺 GetRole ⇒ AccessDenied 被吞成「未部署」,seed-home 200 却不声称
  it("🔴 门控组件探测 **AccessDenied** ⇒ 抛(权限错不是「未部署」;不许静默不声称)", async () => {
    iamSend.mockRejectedValue(Object.assign(new Error("User is not authorized to perform: iam:GetRole"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }));
    await expect(fetchHomeFacts()).rejects.toThrow(/探测出错.*AccessDenied.*TaskRole/);
  });

  it("🔴 airflow-serverless:桶 HeadBucket 403(Forbidden)⇒ 抛;桶 / 角色 / SG 三样都在 ⇒ 声称并带三键", async () => {
    s3Send.mockRejectedValue(Object.assign(new Error("Forbidden"), { name: "Forbidden", $metadata: { httpStatusCode: 403 } }));
    await expect(fetchHomeFacts()).rejects.toThrow(/airflow-serverless 探测出错/);
    s3Send.mockResolvedValue({});
    iamSend.mockImplementation(async (cmd: { input: { RoleName?: string } }) =>
      ({ Role: { Arn: `arn:aws:iam::123456789012:role/${cmd.input.RoleName}` } }));
    ec2Send.mockImplementation(async (cmd: { input: { Filters?: Array<{ Values?: string[] }> } }) => {
      const wanted = cmd.input.Filters?.[0]?.Values?.[0] ?? "";
      return { SecurityGroups: [{ GroupId: wanted === "bgp-airflow-sls-sg" ? "sg-0aaaaaaaaaaaaaaa1" : "sg-0123456789abcdef0" }] };
    });
    const f = await fetchHomeFacts();
    expect(f.airflowServerless).toEqual({ workflowBucket: "bgp-airflow-sls-123456789012", roleArn: "arn:aws:iam::123456789012:role/bgp-airflow-sls-role", sgId: "sg-0aaaaaaaaaaaaaaa1" });
    const d = buildHomeDescriptor(f, "a", "2026-09-06T00:00:00.000Z");
    expect(d.components).toContain("airflow-serverless");
    expect((d.resources as Record<string, unknown>).workflowBucket).toBe("bgp-airflow-sls-123456789012");
  });
});

describe("🔴 agentcore 门控(runtime/memory/gateway 全健康才声称)", () => {
  const RT_ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/bgp_genbi_agent-AbCd1234";
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.EMR_DEFAULT_SUBNET_IDS = "subnet-0123456789abcdef0,subnet-0123456789abcdef1";
    process.env.GENBI_RUNTIME_ARN = RT_ARN;
    process.env.GENBI_MEMORY_ID = "bgp_genbi_memory-XyZ98765";
    ec2Send.mockResolvedValue({ SecurityGroups: [{ GroupId: "sg-0123456789abcdef0" }] });
    smSend.mockResolvedValue({ ARN: FACTS.redshiftSecretArn });
    dmsSend.mockResolvedValue({ ReplicationSubnetGroups: [{}] });
    iamSend.mockResolvedValue({ Role: { Arn: FACTS.flinkRoleArn } });
  });

  it("env 双真值 + 三资源健康 ⇒ facts.agentcore 三字段齐(gatewayUrl 来自 GetGateway 动态查,非 env 猜)", async () => {
    agentcoreHealthy();
    const f = await fetchHomeFacts();
    expect(f.agentcore).toEqual({
      genbiRuntimeArn: RT_ARN,
      genbiMemoryId: "bgp_genbi_memory-XyZ98765",
      gatewayUrl: AC_URL,
    });
  });

  it("env 缺任一 ⇒ 不声称(不是错误,不打 AWS)", async () => {
    delete process.env.GENBI_RUNTIME_ARN;
    const f = await fetchHomeFacts();
    expect(f.agentcore).toBeUndefined();
    expect(acSend).not.toHaveBeenCalled();
  });

  it("runtime 非 READY ⇒ 不声称(声称了 seed 前置真探会红、409 连 core 都上不了)", async () => {
    agentcoreHealthy();
    acSend.mockImplementationOnce(async () => ({ status: "CREATING" }));
    const f = await fetchHomeFacts();
    expect(f.agentcore).toBeUndefined();
  });

  it("ListGateways 找不到 bgp-genbi-gateway ⇒ 不声称", async () => {
    agentcoreHealthy();
    acSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      const kind = cmd.constructor.name;
      if (kind === "GetAgentRuntimeCommand") return { status: "READY" };
      if (kind === "GetMemoryCommand") return { memory: { status: "ACTIVE" } };
      if (kind === "ListGatewaysCommand") return { items: [{ name: "bgp-other-gateway", gatewayId: "x" }] };
      return {};
    });
    const f = await fetchHomeFacts();
    expect(f.agentcore).toBeUndefined();
  });

  it("🔴 声称 agentcore 的候选过 §3.1a 整包校验(组件↔agentcore 袋配套自洽)", () => {
    const withAc: HomeFacts = {
      ...FACTS,
      agentcore: { genbiRuntimeArn: RT_ARN, genbiMemoryId: "bgp_genbi_memory-XyZ98765", gatewayUrl: AC_URL },
    };
    const d = buildHomeDescriptor(withAc, "admin", "2026-09-01T00:00:00.000Z");
    expect(d.components).toContain("agentcore");
    expect((d as { agentcore?: Record<string, string> }).agentcore?.gatewayUrl).toBe(AC_URL);
    const candidate = { ...d, pk: "env", sk: HOME_TARGET_ID, targetId: HOME_TARGET_ID };
    expect(descriptorViolation(candidate as never, HOME_TARGET_ID)).toBeNull();
  });

  it("facts 无 agentcore ⇒ 组件与袋都不出现(与 dms/flink 缺席同口径)", () => {
    const d = buildHomeDescriptor(FACTS, "admin", "2026-09-01T00:00:00.000Z");
    expect(d.components).not.toContain("agentcore");
    expect((d as { agentcore?: unknown }).agentcore).toBeUndefined();
  });
});

describe("🔴🔴 经典 MWAA 下线:home 也不再部署它(用户 2026-09-14 拍板)", () => {
  it("`mwaa` 必须是**按事实门控**的,不许写死在组件字面量里", () => {
    const off = buildHomeDescriptor(FACTS, "a", "2026-09-01T00:00:00.000Z");
    const on = buildHomeDescriptor({ ...FACTS, mwaaPresent: true }, "a", "2026-09-01T00:00:00.000Z");
    expect(off.components).not.toContain("mwaa");
    expect(on.components).toContain("mwaa");
    // 🔴 判别力:写死时这两个断言里必有一个红(off 那条)
    expect((off.resources as Record<string, unknown>).mwaaEnvName).toBeUndefined();
    expect((on.resources as Record<string, unknown>).mwaaEnvName).toBe("bgp-mwaa");
  });

  it("两种形态都要过 §3.1a 整包校验(组件↔资源配套自洽 —— 少了 mwaa 也不许把 dagBucket 弄丢)", () => {
    for (const present of [false, true]) {
      const d = buildHomeDescriptor({ ...FACTS, mwaaPresent: present }, "a", "2026-09-01T00:00:00.000Z");
      const candidate = { ...d, pk: "env", sk: HOME_TARGET_ID, targetId: HOME_TARGET_ID };
      expect(descriptorViolation(candidate as never, HOME_TARGET_ID), `mwaaPresent=${present}`).toBeNull();
      // dagBucket 由平台栈建,与经典 MWAA 在不在无关 ⇒ 两种形态都必须有
      expect((d.resources as Record<string, unknown>).dagBucket).toBe("bgp-mwaa-dags-123456789012");
    }
  });

  it("🔴 部署侧:`deploy-all.sh` 默认**不**部署 BgpMwaaStack;`infra/bin/app.ts` 也只在 `-c classic-mwaa=1` 时实例化", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
    const sh = readFileSync(resolve(REPO, "scripts/deploy-all.sh"), "utf8");
    // 切出第 7 步整段再判(不猜正则)
    const i = sh.indexOf('say "7)');
    expect(i, "deploy-all 第 7 步不见了 ⇒ 形状变了,请同步本门禁").toBeGreaterThan(-1);
    const step7 = sh.slice(i, sh.indexOf('say "8)', i));
    expect(step7).toContain('if [[ "${DEPLOY_CLASSIC_MWAA:-0}" == "1" ]]; then');
    // 🔴 不许有**无条件**的 cdk deploy BgpMwaaStack(数计:全文件恰好一处,且在那个 if 里面)
    const deploys = (sh.match(/cdk deploy BgpMwaaStack/g) ?? []).length;
    expect(deploys, "BgpMwaaStack 的部署调用必须恰好一处").toBe(1);
    expect(step7.indexOf("cdk deploy BgpMwaaStack")).toBeGreaterThan(step7.indexOf('DEPLOY_CLASSIC_MWAA'));

    const appTs = readFileSync(resolve(REPO, "infra/bin/app.ts"), "utf8");
    const j = appTs.indexOf("new MwaaStack(");
    expect(j).toBeGreaterThan(-1);
    // 实例化必须在 context 判断之内(切出前 400 字符判,不猜)
    expect(appTs.slice(Math.max(0, j - 400), j)).toContain('tryGetContext("classic-mwaa") === "1"');
    // 🔴 栈类**不许删**:存量账号那一个要能被 CFN 认领与删除
    expect(appTs).toContain('import { MwaaStack } from "../lib/mwaa-stack";');
  });
});
