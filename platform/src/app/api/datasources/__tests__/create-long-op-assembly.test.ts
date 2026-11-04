// 序 57 / B-129 —— JDBC 建源 provision 段接长操作框架:装配层判据(路由 ↔ submitLongOp ↔ 执行体 ↔ datasource-service ↔ SDK)。
//
// 【缺陷原形】第四十七轮 nap 首跑:主控区视角「新建数据源」点「完成」⇒ 页面 60 秒 504,服务端却在第 66 秒把源建出来(CloudTrail:
//   CreateSecret 之后空档 64 秒才到 IAM GetRole)。请求路径同步串着 核角色 → 探网段 / 建组 → 建 Glue 连接 → 落库,没有超时预算。
// 【判据钉的事实】
//   ① 快路径:201 与接入前同形(data = 行 + provisionedResources);长操作行 succeeded / resultStatus 201;租约释放;
//   ② 🔴 停顿注入(IAM GetRole 挂住 > 等待预算):路由在预算到点就回 202 协议记号(label「新建数据源」),**不等停顿结束**;
//      后台照常建完,落库恰一行,任务行 succeeded;
//   ③ 🔴 租约:同名并发两次 ⇒ 一次受理、一次 409 LONG_OP_IN_PROGRESS,落库恰一行,被拒那次路由建的密钥被删(不留孤儿);
//   ④ 🔴 中途失败(Glue 建连接抛)⇒ 500「创建数据源失败: …」原口径;已建的平台安全组 / 密钥按逆序清掉,不落库;
//      用户指定了自己的组 ⇒ 失败时**不删用户的组**(负向控制);
//   ⑤ Glue 角色核验:IAM 抛网络类错误 ⇒ 503「…Glue 作业角色未就位…」且**不走 CreateRole**(原来 catch {} 把一切错误当「角色不存在」去建);
//      失败不缓存,下一次建源重新核;成功缓存 ⇒ 两次建源只核一次。
// 【只 mock 真外部】EC2 / RDS / Glue / Secrets Manager / IAM 客户端、DDB(长操作表用内存版夹具,数据源表用内存数组)、项目守卫、审计、OM、
//   读源表结构、连通性收口(它要 JDBC ping + 写库)。路由 / 驱动器 / 执行体 / datasource-service 一律真装配。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.hoisted(() => {
  process.env.LONG_OPS_SYNC_WAIT_MS = "150";
  process.env.LONG_OPS_HEARTBEAT_MS = "20";
  delete process.env.LONG_OPS_ASYNC;
});

type Call = { svc: string; cmd: string; input: any };
const h = vi.hoisted(() => ({
  calls: [] as Call[],
  dsRows: [] as any[],
  iamDelayMs: 0,
  iamError: null as Error | null,
  glueCreateError: null as Error | null,
  sgNames: {} as Record<string, string>,
  ulidSeq: 0,
  settled: [] as any[],
}));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fake(svc: string, answer: (cmd: string, input: any) => any | Promise<any>) {
  return {
    send: async (c: any) => {
      const cmd = c.constructor.name;
      h.calls.push({ svc, cmd, input: c.input });
      return answer(cmd, c.input);
    },
  };
}

vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real: any = await orig();
  const ec2 = fake("ec2", (cmd, input) => {
    if (cmd === "CreateSecurityGroupCommand") {
      const id = `sg-plat-${input.GroupName.slice(-8)}`;
      h.sgNames[id] = input.GroupName;
      return { GroupId: id };
    }
    if (cmd === "DescribeVpcsCommand") return { Vpcs: [{ VpcId: input.VpcIds[0], CidrBlock: "10.0.0.0/16" }] };
    if (cmd === "DescribeSubnetsCommand") {
      // B-133 第二刀:写 Glue 连接前按子网事实取 AZ;用户给的子网在 1c(与下方用例给的 availabilityZone 一致),其余在 1a
      const ids: string[] = input.SubnetIds ?? input.Filters?.find((f: any) => f.Name === "subnet-id")?.Values ?? [];
      return { Subnets: ids.map((x) => ({ SubnetId: x, VpcId: x === "subnet-user" ? "vpc-user" : "vpc-default", AvailabilityZone: x === "subnet-user" ? "us-east-1c" : "us-east-1a" })) };
    }
    if (cmd === "DescribeSecurityGroupsCommand") {
      const id = input.GroupIds?.[0];
      if (!(id in h.sgNames)) { const e: any = new Error("nf"); e.name = "InvalidGroup.NotFound"; throw e; }
      return { SecurityGroups: [{ GroupId: id, GroupName: h.sgNames[id] }] };
    }
    if (cmd === "DeleteSecurityGroupCommand") { delete h.sgNames[input.GroupId]; return {}; }
    return {};
  });
  const rds = fake("rds", () => ({ DBInstances: [] }));
  const glue = fake("glue", (cmd) => {
    if (cmd === "CreateConnectionCommand" && h.glueCreateError) throw h.glueCreateError;
    return {};
  });
  const sm = fake("sm", (cmd, input) => {
    if (cmd === "CreateSecretCommand") return { ARN: `arn:aws:secretsmanager:us-east-1:000000000000:secret:${input.Name}-AbCdEf` };
    if (cmd === "GetSecretValueCommand") return { SecretString: JSON.stringify({ username: "u", password: "p" }) };
    return {};
  });
  return { ...real, ec2ClientFor: async () => ec2, rdsClientFor: async () => rds, glueClientFor: async () => glue, secretsClientFor: async () => sm, homeRegion: () => "us-east-1" };
});

vi.mock("@/lib/aws/clients", async (orig) => {
  const real: any = await orig();
  const iam = fake("iam", async (cmd) => {
    if (cmd === "GetRoleCommand") {
      if (h.iamDelayMs) await sleep(h.iamDelayMs);
      if (h.iamError) throw h.iamError;
      return { Role: { Arn: "arn:aws:iam::000000000000:role/bgp-glue-role" } };
    }
    return { Role: { Arn: "arn:aws:iam::000000000000:role/bgp-glue-role" } };
  });
  return { ...real, sdkClient: (k: any, C: any, o: any) => (C?.name === "IAMClient" ? iam : real.sdkClient(k, C, o)) };
});

vi.mock("@/lib/aws/dynamodb", async () => {
  const mem = await import("@/lib/long-ops/__tests__/fixtures/mem-long-ops");
  return {
    TABLES: { ...mem.TABLES, DATASOURCES: "bgp-datasources" },
    docClient: {
      send: async (cmd: any) => {
        if (cmd.input?.TableName === mem.TABLES.LONG_OPS) return mem.docClient.send(cmd);
        if (cmd.constructor.name === "PutCommand") { h.dsRows.push(cmd.input.Item); return {}; }
        return {};
      },
    },
  };
});
vi.mock("@/lib/projects/guard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects/guard")>("@/lib/projects/guard");
  return { ...actual, requireProject: vi.fn(async () => ({ identity: { username: "t", sub: "s", groups: [] }, projectId: "proj-a", role: "editor" })) };
});
vi.mock("@/lib/datasource/schema-reader", () => ({ readSourceSchema: vi.fn(async () => []) }));
vi.mock("@/lib/openmetadata/om-push", () => ({ pushDataSourceToOpenMetadata: vi.fn(async () => undefined) }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/datasource/reachability-probe", () => ({ settleAfterConfigCheck: vi.fn(async (row: any) => { h.settled.push(row); return { kind: "testing" }; }) }));
vi.mock("ulid", () => ({ ulid: () => `01HXAAAAAAAAAAAAAAAADS${String(++h.ulidSeq).padStart(4, "0")}` }));

import { rows, resetMemLongOps } from "@/lib/long-ops/__tests__/fixtures/mem-long-ops";
import { POST } from "@/app/api/datasources/route";
import { __resetGlueRoleCache, platformDsSgName } from "@/lib/aws/datasource-service";
import { LONG_OP_PROTOCOL } from "@/lib/long-ops/protocol";

const post = (extra: Record<string, unknown> = {}) =>
  POST(new NextRequest("https://x.test/api/datasources", {
    method: "POST",
    headers: { "x-correlation-id": "corr-b129" },
    body: JSON.stringify({ name: "ds-b129", type: "mysql", host: "10.1.2.3", port: 3306, database: "db1", username: "u", password: "p", targetId: "tgt_home", ...extra }),
  }));

const taskRows = () => [...rows.values()].filter((r) => !String(r.taskId).startsWith("lease#"));
const leaseRows = () => [...rows.values()].filter((r) => String(r.taskId).startsWith("lease#"));
const cmds = (svc: string) => h.calls.filter((c) => c.svc === svc).map((c) => c.cmd);

async function waitUntil(pred: () => boolean, budgetMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > budgetMs) throw new Error("waitUntil 超时");
    await sleep(10);
  }
}

beforeEach(() => {
  resetMemLongOps();
  __resetGlueRoleCache();
  h.calls.length = 0;
  h.dsRows.length = 0;
  h.settled.length = 0;
  h.iamDelayMs = 0;
  h.iamError = null;
  h.glueCreateError = null;
  h.sgNames = {};
  h.ulidSeq = 0;
  process.env.DEFAULT_VPC_ID = "vpc-default";
  process.env.DEFAULT_SUBNET_ID = "subnet-default";
  process.env.DEFAULT_AZ = "us-east-1a";
});

describe("B-129 ①:快路径与接入前同形", () => {
  it("201;data = 行 + provisionedResources;落库恰一行(不存口令);任务行 succeeded / resultStatus 201;租约释放;收口 fire-and-forget 已接", async () => {
    const res = await post();
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ datasourceId: "01HXAAAAAAAAAAAAAAAADS0001", name: "ds-b129", type: "mysql", status: "testing", projectId: "proj-a", createdBy: "t", username: "u" });
    expect(body.data.provisionedResources).toEqual({
      secretArn: "arn:aws:secretsmanager:us-east-1:000000000000:secret:bgp/datasource/01HXAAAAAAAAAAAAAAAADS0001-AbCdEf",
      glueConnectionName: "bgp-conn-AAAAAADS0001",
      securityGroupId: "sg-plat-AADS0001", vpcId: "vpc-default", subnetId: "subnet-default",
    });
    expect(body.data.password).toBeUndefined();
    expect(h.dsRows).toHaveLength(1);
    expect(h.dsRows[0].password).toBeUndefined();
    expect(taskRows()).toHaveLength(1);
    expect(taskRows()[0]).toMatchObject({ kind: "datasource-create", status: "succeeded", resultStatus: 201, userId: "s", correlationId: "corr-b129" });
    expect(taskRows()[0].params.secretArn).toMatch(/^arn:aws:secretsmanager:/);
    expect(JSON.stringify(taskRows()[0].params)).not.toMatch(/"password"/);
    expect(leaseRows()).toEqual([]);
    expect(cmds("sm")).toEqual(["CreateSecretCommand", "GetSecretValueCommand"]);
    await waitUntil(() => h.settled.length === 1);
    expect(h.settled[0].datasourceId).toBe("01HXAAAAAAAAAAAAAAAADS0001");
  });
});

describe("B-129 ②:一跳停顿不再撞墙", () => {
  it("🔴 IAM GetRole 挂住 600 ms(> 等待预算 150 ms)⇒ 路由在预算到点回 202 协议记号(不等停顿结束);后台建完落库恰一行、任务行 succeeded", async () => {
    h.iamDelayMs = 600;
    const started = Date.now();
    const res = await post();
    const elapsed = Date.now() - started;
    expect(res.status).toBe(202);
    expect(elapsed, "202 必须在预算到点就回,不是等停顿结束").toBeLessThan(500);
    const body = await res.json();
    expect(body.data).toMatchObject({ kind: "datasource-create", label: "新建数据源", status: "running", async: true, protocol: LONG_OP_PROTOCOL });
    expect(h.dsRows, "202 时还没落库").toHaveLength(0);
    await waitUntil(() => taskRows()[0]?.status === "succeeded", 3_000);
    expect(h.dsRows).toHaveLength(1);
    expect(taskRows()[0]).toMatchObject({ resultStatus: 201 });
    expect(taskRows()[0].result.datasourceId).toBe("01HXAAAAAAAAAAAAAAAADS0001");
    expect(taskRows()[0].result.provisionedResources.glueConnectionName).toBe("bgp-conn-AAAAAADS0001");
    expect(leaseRows()).toEqual([]);
  });

  it("停顿 + 中途失败也走异步终态:202 后任务行 failed / errorStatus 500 带原口径文案;产物已清理、不落库", async () => {
    h.iamDelayMs = 400;
    h.glueCreateError = new Error("glue boom");
    const res = await post();
    expect(res.status).toBe(202);
    await waitUntil(() => taskRows()[0]?.status === "failed", 3_000);
    expect(taskRows()[0]).toMatchObject({ errorStatus: 500 });
    expect(String(taskRows()[0].error)).toContain("创建数据源失败: glue boom");
    expect(h.dsRows).toHaveLength(0);
    await waitUntil(() => cmds("sm").includes("DeleteSecretCommand"));
    expect(cmds("ec2")).toContain("DeleteSecurityGroupCommand");
    expect(leaseRows()).toEqual([]);
  });
});

describe("B-129 ③:对象租约 —— 同名再点一次不会建出第二条", () => {
  it("🔴 同名并发两次 ⇒ 一次受理(201 / 202)、一次 409 LONG_OP_IN_PROGRESS;落库恰一行;被拒那次路由建的密钥被删", async () => {
    h.iamDelayMs = 300;
    const [a, b] = await Promise.all([post(), post()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([202, 409]);
    const rejected = a.status === 409 ? a : b;
    const rb = await rejected.json();
    expect(rb.error.code).toBe("LONG_OP_IN_PROGRESS");
    expect(rb.error.message).toContain("新建数据源");
    await waitUntil(() => taskRows().some((r) => r.status === "succeeded"), 3_000);
    expect(h.dsRows).toHaveLength(1);
    expect(taskRows()).toHaveLength(1);
    // 两次 CreateSecret(路由各建一个)⇒ 被拒那次的密钥被 DeleteSecret 删掉,受理那次的留着
    const created = h.calls.filter((c) => c.svc === "sm" && c.cmd === "CreateSecretCommand").map((c) => c.input.Name);
    expect(created).toHaveLength(2);
    const deleted = h.calls.filter((c) => c.svc === "sm" && c.cmd === "DeleteSecretCommand").map((c) => c.input.SecretId);
    expect(deleted).toHaveLength(1);
    const keptId = h.dsRows[0].datasourceId;
    expect(deleted[0]).not.toContain(keptId);
    expect(created.some((n) => deleted[0].includes(n))).toBe(true);
  });

  it("不同名并发两次 ⇒ 两次都受理,落库两行(租约按项目 + 名字,不是全局锁)", async () => {
    const [a, b] = await Promise.all([post({ name: "ds-one" }), post({ name: "ds-two" })]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(h.dsRows).toHaveLength(2);
  });
});

describe("B-129 ④:中途失败不留孤儿", () => {
  it("🔴 Glue 建连接抛 ⇒ 500「创建数据源失败: …」(原口径);已建的平台安全组与密钥被清掉;不落库;Glue 连接没建成就不删", async () => {
    h.glueCreateError = new Error("InvalidInputException: subnet not found");
    const res = await post();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toBe("创建数据源失败: InvalidInputException: subnet not found");
    expect(h.dsRows).toHaveLength(0);
    const ec2 = cmds("ec2");
    expect(ec2.slice(0, 4)).toEqual(["CreateSecurityGroupCommand", "AuthorizeSecurityGroupIngressCommand", "DescribeVpcsCommand", "AuthorizeSecurityGroupIngressCommand"]);
    // B-133 第二刀:建连接前先按子网事实取 AZ(DescribeSubnets),建连接抛后才是清理序
    expect(ec2.slice(4)).toEqual(["DescribeSubnetsCommand", "DescribeSecurityGroupsCommand", "DeleteSecurityGroupCommand"]);
    const del = h.calls.find((c) => c.svc === "ec2" && c.cmd === "DeleteSecurityGroupCommand")!;
    expect(h.sgNames[del.input.GroupId]).toBeUndefined();
    expect(del.input.GroupId).toBe("sg-plat-AADS0001");
    expect(cmds("glue")).toEqual(["CreateConnectionCommand"]);
    expect(cmds("sm").filter((c) => c === "DeleteSecretCommand")).toHaveLength(2); // 执行体清理一次 + 路由兜底一次(幂等)
    expect(taskRows()[0]).toMatchObject({ status: "failed", errorStatus: 500 });
    expect(leaseRows()).toEqual([]);
  });

  it("负向控制:用户指定了自己的子网 + 组 ⇒ 平台不建组;失败时**不删用户的组**,只删密钥", async () => {
    h.glueCreateError = new Error("glue boom");
    const res = await post({ network: { subnetId: "subnet-user", securityGroupIds: ["sg-user-1", "sg-user-2"] } });
    expect(res.status).toBe(500);
    expect(cmds("ec2").filter((c) => /^(Create|Authorize|Delete)/.test(c))).toEqual([]);
    expect(cmds("sm")).toContain("DeleteSecretCommand");
    expect(h.dsRows).toHaveLength(0);
  });

  it("用户指定网络的成功路径:组全部进 Glue 连接(B-54 不回归)", async () => {
    const res = await post({ network: { subnetId: "subnet-user", securityGroupIds: ["sg-user-1", "sg-user-2"], availabilityZone: "us-east-1c" } });
    expect(res.status).toBe(201);
    const conn = h.calls.find((c) => c.svc === "glue" && c.cmd === "CreateConnectionCommand")!;
    expect(conn.input.ConnectionInput.PhysicalConnectionRequirements).toEqual({ SubnetId: "subnet-user", SecurityGroupIdList: ["sg-user-1", "sg-user-2"], AvailabilityZone: "us-east-1c" });
    expect(h.dsRows[0].networkConfig.securityGroupIds).toEqual(["sg-user-1", "sg-user-2"]);
    expect(cmds("ec2").filter((c) => /^(Create|Authorize|Delete)/.test(c))).toEqual([]);
  });

  it("平台安全组名 = platformDsSgName(datasourceId)(删的就是自己建的那个)", () => {
    expect(platformDsSgName("01HXAAAAAAAAAAAAAAAADS0001")).toBe("bgp-ds-AADS0001");
  });
});

describe("B-129 ⑤:Glue 角色核验出请求路径", () => {
  it("🔴 IAM 抛网络类错误(TimeoutError)⇒ 503「…Glue 作业角色未就位…」;**不走 CreateRole**;密钥清掉、不落库", async () => {
    h.iamError = Object.assign(new Error("socket timed out"), { name: "TimeoutError" });
    const res = await post();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.message).toContain("Glue 作业角色未就位");
    expect(body.error.message).toContain("socket timed out");
    expect(body.error.code).toBe("UPSTREAM_ERROR");
    expect(cmds("iam")).toEqual(["GetRoleCommand"]);
    expect(cmds("ec2")).toEqual([]);
    expect(cmds("sm")).toContain("DeleteSecretCommand");
    expect(h.dsRows).toHaveLength(0);
  });

  it("失败不缓存:上一次 IAM 失败后,下一次建源重新核一次并成功 201", async () => {
    h.iamError = Object.assign(new Error("throttled"), { name: "Throttling" });
    expect((await post()).status).toBe(503);
    h.iamError = null;
    expect((await post({ name: "ds-again" })).status).toBe(201);
    expect(cmds("iam")).toEqual(["GetRoleCommand", "GetRoleCommand"]);
  });

  it("成功缓存:两次建源只核一次 IAM GetRole(角色是部署期基础设施,不在每次建源的路径上核)", async () => {
    expect((await post({ name: "ds-a" })).status).toBe(201);
    expect((await post({ name: "ds-b" })).status).toBe(201);
    expect(cmds("iam")).toEqual(["GetRoleCommand"]);
    expect(h.dsRows).toHaveLength(2);
  });

  it("角色确实不存在(NoSuchEntity)才补建:CreateRole + 3 条托管策略 + 内联策略各一次,之后缓存", async () => {
    h.iamError = Object.assign(new Error("not found"), { name: "NoSuchEntityException" });
    const res = await post();
    expect(res.status).toBe(201);
    expect(cmds("iam")).toEqual(["GetRoleCommand", "CreateRoleCommand", "AttachRolePolicyCommand", "AttachRolePolicyCommand", "AttachRolePolicyCommand", "PutRolePolicyCommand"]);
    h.iamError = null;
    expect((await post({ name: "ds-next" })).status).toBe(201);
    expect(cmds("iam")).toHaveLength(6);
  });
});
