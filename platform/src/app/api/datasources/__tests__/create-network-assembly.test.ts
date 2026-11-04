// @kf-batch 37-B54-ds-user-sg
// 建 JDBC 数据源的网络接入 —— 装配层判据(路由 ↔ datasource-service ↔ secrets ↔ SDK)。
//
// 🔴 只 mock 真外部:EC2 / RDS / Glue / Secrets Manager / IAM 客户端、DDB、项目守卫、审计、OM、读源表结构。
//    路由与 datasource-service 之间**一律不 mock**(接缝就在这里:路由拿到的网络形态 ⇒ Glue 连接 ⇒ 落库)。
//
// 两组判据:
//   ① 老路径(没指定网络 = 自动探测 + 新建 bgp-ds-*):AWS 调用**序列与参数逐字节**钉现状(B-54 改动前录制);
//   ② B-54:用户指定了子网 + 安全组 ⇒ 一个安全组都不建、不改任何规则;多个安全组全部进 Glue 连接。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// 序 57 / B-129:建源 provision 段经 submitLongOp;本文件钉的是 AWS 调用序列,用纯同步退路(LONG_OPS_ASYNC=0)让每次 POST 当场跑完
//   (混合响应 / 202 / 租约 / 清理在 app/api/datasources/__tests__/create-long-op-assembly.test.ts)。
vi.hoisted(() => { process.env.LONG_OPS_ASYNC = "0"; });

type Call = { svc: string; cmd: string; input: any };
const h = vi.hoisted(() => ({
  calls: [] as Call[],
  puts: [] as any[],
  dbInstances: [] as any[],
  dupSg: false,
  vpcCidr: "10.0.0.0/16" as string | undefined,
  getItem: undefined as any,
  deletes: [] as any[],
  sgNames: {} as Record<string, string>,
}));

function fake(svc: string, answer: (cmd: string, input: any) => any) {
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
      if (h.dupSg) { const e: any = new Error("dup"); e.Code = "InvalidGroup.Duplicate"; throw e; }
      return { GroupId: "sg-plat-new" };
    }
    if (cmd === "DescribeVpcsCommand") return { Vpcs: h.vpcCidr ? [{ VpcId: input.VpcIds[0], CidrBlock: h.vpcCidr }] : [] };
    if (cmd === "DescribeSubnetsCommand") {
      // B-133 第二刀:写 Glue 连接前按子网事实取 AZ(子网 ↔ 可用区各异,判据才能分辨「来自子网」与「来自探测 / 环境变量」)
      const facts: Record<string, [string, string]> = { "subnet-rds-a": ["vpc-rds", "us-east-1b"], "subnet-default": ["vpc-default", "us-east-1a"], "subnet-cust-1": ["vpc-rds", "us-east-1c"] };
      const ids: string[] = input.SubnetIds ?? input.Filters?.find((f: any) => f.Name === "subnet-id")?.Values ?? [];
      return { Subnets: ids.filter((x) => x in facts).map((x) => ({ SubnetId: x, VpcId: facts[x][0], AvailabilityZone: facts[x][1] })) };
    }
    if (cmd === "DescribeSecurityGroupsCommand") {
      if (input.GroupIds) {
        const id = input.GroupIds[0];
        if (!(id in h.sgNames)) { const e: any = new Error("nf"); e.name = "InvalidGroup.NotFound"; throw e; }
        return { SecurityGroups: [{ GroupId: id, GroupName: h.sgNames[id] }] };
      }
      return { SecurityGroups: [{ GroupId: "sg-plat-existing" }] };
    }
    return {};
  });
  const rds = fake("rds", (cmd) => (cmd === "DescribeDBInstancesCommand" ? { DBInstances: h.dbInstances } : {}));
  const glue = fake("glue", (cmd) => (cmd === "GetConnectionCommand" ? { Connection: { PhysicalConnectionRequirements: { SubnetId: "x" }, ConnectionProperties: { JDBC_CONNECTION_URL: "jdbc:x" } } } : {}));
  const sm = fake("sm", (cmd) => {
    if (cmd === "CreateSecretCommand") return { ARN: "arn:aws:secretsmanager:us-east-1:000000000000:secret:bgp/datasource/x" };
    if (cmd === "GetSecretValueCommand") return { SecretString: JSON.stringify({ username: "u", password: "p" }) };
    return {};
  });
  return {
    ...real,
    ec2ClientFor: async () => ec2,
    rdsClientFor: async () => rds,
    glueClientFor: async () => glue,
    secretsClientFor: async () => sm,
    homeRegion: () => "us-east-1",
  };
});

vi.mock("@/lib/aws/clients", async (orig) => {
  const real: any = await orig();
  const iam = fake("iam", (cmd) => (cmd === "GetRoleCommand" ? { Role: { Arn: "arn:aws:iam::000000000000:role/bgp-glue-role" } } : {}));
  return { ...real, sdkClient: (k: any, C: any, o: any) => (C?.name === "IAMClient" ? iam : real.sdkClient(k, C, o)) };
});

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { DATASOURCES: "bgp-datasources", LONG_OPS: "bgp-long-ops" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      // 序 50 第二批:PUT / DELETE 先核对象租约(读 bgp-long-ops 的 lease 行)⇒ 没有租约 = 空
      if (cmd.input?.TableName === "bgp-long-ops") return {};
      if (cmd.constructor.name === "PutCommand") h.puts.push(cmd.input.Item);
      if (cmd.constructor.name === "GetCommand") return { Item: h.getItem };
      if (cmd.constructor.name === "DeleteCommand") h.deletes.push(cmd.input.Key);
      return {};
    }),
  },
}));
vi.mock("@/lib/projects/guard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects/guard")>("@/lib/projects/guard");
  return {
    ...actual,
    requireProject: vi.fn(async () => ({ identity: { username: "t", sub: "s" }, projectId: "proj-a", role: "editor" })),
    guardResourceAccess: vi.fn(async () => ({ identity: { username: "t", sub: "s" }, projectId: "proj-a", role: "editor" })),
  };
});
vi.mock("@/lib/datasource/schema-reader", () => ({ readSourceSchema: vi.fn(async () => []) }));
vi.mock("@/lib/openmetadata/om-push", () => ({ pushDataSourceToOpenMetadata: vi.fn(async () => undefined) }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("ulid", () => ({ ulid: () => "01HXAAAAAAAAAAAAAAAADS0001" }));

import { POST } from "../route";
import { DELETE } from "../[id]/route";
import { __resetGlueRoleCache } from "@/lib/aws/datasource-service";

const RDS_HOST = "mydb.abc123.us-east-1.rds.amazonaws.com";
const post = (extra: Record<string, unknown> = {}) =>
  POST(new NextRequest("https://x.test/api/datasources", {
    method: "POST",
    body: JSON.stringify({
      name: "ds1", type: "mysql", host: RDS_HOST, port: 3306, database: "db1",
      username: "u", password: "p", targetId: "tgt_home", ...extra,
    }),
  }));
/** 只看网络相关的 AWS 调用(EC2 / RDS / Glue CreateConnection),凭证与 IAM 另断。 */
const netCalls = () =>
  h.calls.filter((c) => c.svc === "ec2" || c.svc === "rds" || (c.svc === "glue" && c.cmd === "CreateConnectionCommand"));
const ec2Writes = () =>
  h.calls.filter((c) => c.svc === "ec2" && /^(Create|Authorize|Revoke|Delete|Modify)/.test(c.cmd));

beforeEach(() => {
  // B-129 ②:Glue 角色核验进程内只核一次;本文件每条判据都钉「先建密钥、再查角色」,所以每条前清缓存
  __resetGlueRoleCache();
  h.calls.length = 0;
  h.puts.length = 0;
  h.deletes.length = 0;
  h.getItem = undefined;
  h.sgNames = {};
  h.dupSg = false;
  h.vpcCidr = "10.0.0.0/16";
  h.dbInstances = [{
    DBInstanceIdentifier: "mydb",
    Endpoint: { Address: RDS_HOST },
    DBSubnetGroup: { VpcId: "vpc-rds", Subnets: [{ SubnetIdentifier: "subnet-rds-a", SubnetAvailabilityZone: { Name: "us-east-1b" } }] },
  }];
  process.env.DEFAULT_VPC_ID = "vpc-default";
  process.env.DEFAULT_SUBNET_ID = "subnet-default";
  process.env.DEFAULT_AZ = "us-east-1a";
});

const GLUE_CONN = {
  Name: "bgp-conn-AAAAAADS0001",
  ConnectionType: "JDBC",
  // @kf-batch 44-jdbc-params —— MySQL 方言默认参数(B-86)也进 Glue 连接的 JDBC URL
  ConnectionProperties: { JDBC_CONNECTION_URL: `jdbc:mysql://${RDS_HOST}:3306/db1?zeroDateTimeBehavior=CONVERT_TO_NULL`, USERNAME: "u", PASSWORD: "p" },
};

describe("① 老路径(没指定网络)= 自动探测 + 新建 bgp-ds-*:AWS 调用序列逐字节钉现状", () => {
  it("RDS 主机:DescribeDBInstances → CreateSG → 自引用放行 → DescribeVpcs → 端口放行 → Glue 连接引用新组", async () => {
    const res = await post();
    expect(res.status).toBe(201);
    expect(netCalls()).toEqual([
      { svc: "rds", cmd: "DescribeDBInstancesCommand", input: {} },
      // 序 61 B-133:建组即带归属标签(被按「无网卡即孤儿」清理的工具误删过 ⇒ 标签让清理流程能排除、让人能看出归属)
      { svc: "ec2", cmd: "CreateSecurityGroupCommand", input: { GroupName: "bgp-ds-AADS0001", Description: "BGP datasource 01HXAAAAAAAAAAAAAAAADS0001", VpcId: "vpc-rds",
        TagSpecifications: [{ ResourceType: "security-group", Tags: [{ Key: "bgp:managed", Value: "datasource" }, { Key: "bgp:datasourceId", Value: "01HXAAAAAAAAAAAAAAAADS0001" }, { Key: "bgp:targetId", Value: "tgt_home" }] }] } },
      { svc: "ec2", cmd: "AuthorizeSecurityGroupIngressCommand", input: { GroupId: "sg-plat-new", IpPermissions: [{ IpProtocol: "-1", UserIdGroupPairs: [{ GroupId: "sg-plat-new" }] }] } },
      { svc: "ec2", cmd: "DescribeVpcsCommand", input: { VpcIds: ["vpc-rds"] } },
      { svc: "ec2", cmd: "AuthorizeSecurityGroupIngressCommand", input: { GroupId: "sg-plat-new", IpPermissions: [{ IpProtocol: "tcp", FromPort: 3306, ToPort: 3306, IpRanges: [{ CidrIp: "10.0.0.0/16" }] }] } },
      // B-133 第二刀:写连接前按子网事实核 AZ(自愈 / 改网络按源行重建时源行没有 AZ,建源也走同一个作者)
      { svc: "ec2", cmd: "DescribeSubnetsCommand", input: { Filters: [{ Name: "subnet-id", Values: ["subnet-rds-a"] }] } },
      { svc: "glue", cmd: "CreateConnectionCommand", input: { ConnectionInput: { ...GLUE_CONN, PhysicalConnectionRequirements: { SubnetId: "subnet-rds-a", SecurityGroupIdList: ["sg-plat-new"], AvailabilityZone: "us-east-1b" } } } },
    ]);
    // 落库形态逐字节:老路径不多也不少一个键(B-133 第二刀起多 availabilityZone 一个键)
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0].networkConfig).toStrictEqual({ vpcId: "vpc-rds", subnetId: "subnet-rds-a", availabilityZone: "us-east-1b", securityGroupId: "sg-plat-new", isRds: true, rdsInstanceId: "mydb" });
    const body = await res.json();
    expect(body.data?.provisionedResources ?? body.provisionedResources).toEqual({
      secretArn: "arn:aws:secretsmanager:us-east-1:000000000000:secret:bgp/datasource/x",
      glueConnectionName: "bgp-conn-AAAAAADS0001",
      securityGroupId: "sg-plat-new", vpcId: "vpc-rds", subnetId: "subnet-rds-a",
    });
  });

  it("非 RDS 主机:不查 RDS,用主控区默认网络建组", async () => {
    const res = await post({ host: "10.1.2.3" });
    expect(res.status).toBe(201);
    expect(netCalls().map((c) => c.cmd)).toEqual([
      "CreateSecurityGroupCommand", "AuthorizeSecurityGroupIngressCommand", "DescribeVpcsCommand", "AuthorizeSecurityGroupIngressCommand", "DescribeSubnetsCommand", "CreateConnectionCommand",
    ]);
    expect(netCalls()[0].input.VpcId).toBe("vpc-default");
    expect(netCalls()[5].input.ConnectionInput.PhysicalConnectionRequirements).toEqual({ SubnetId: "subnet-default", SecurityGroupIdList: ["sg-plat-new"], AvailabilityZone: "us-east-1a" });
    expect(h.puts[0].networkConfig).toStrictEqual({ vpcId: "vpc-default", subnetId: "subnet-default", availabilityZone: "us-east-1a", securityGroupId: "sg-plat-new", isRds: false, rdsInstanceId: undefined });
  });

  it("组已存在(InvalidGroup.Duplicate):按名 + VPC 查回那个组,不再放行", async () => {
    h.dupSg = true;
    const res = await post();
    expect(res.status).toBe(201);
    expect(netCalls().map((c) => c.cmd)).toEqual(["DescribeDBInstancesCommand", "CreateSecurityGroupCommand", "DescribeSecurityGroupsCommand", "DescribeSubnetsCommand", "CreateConnectionCommand"]);
    expect(netCalls()[2].input).toEqual({ Filters: [{ Name: "group-name", Values: ["bgp-ds-AADS0001"] }, { Name: "vpc-id", Values: ["vpc-rds"] }] });
    expect(h.puts[0].networkConfig.securityGroupId).toBe("sg-plat-existing");
  });

  it("读不到 VPC CIDR ⇒ 建源失败(不回落 10.0.0.0/16),且不建 Glue 连接、不落库", async () => {
    h.vpcCidr = undefined;
    const res = await post();
    expect(res.status).toBe(500);
    expect(h.calls.some((c) => c.cmd === "CreateConnectionCommand")).toBe(false);
    expect(h.puts).toHaveLength(0);
  });

  it("凭证与角色:先建密钥、再查角色(home),都在网络之前", async () => {
    await post();
    const order = h.calls.map((c) => `${c.svc}:${c.cmd}`);
    expect(order.slice(0, 2)).toEqual(["sm:CreateSecretCommand", "iam:GetRoleCommand"]);
  });
});

describe("① 老路径(非主控区落点):用落点那个区的网络事实,不读主控区 env", () => {
  it("detectNetwork 在非 home 落点:VPC / 子网 / AZ 取自落点,建组进那个 VPC", async () => {
    const { detectNetwork } = await import("@/lib/aws/datasource-service");
    const out = await detectNetwork("10.200.0.9", "postgresql", "01HXAAAAAAAAAAAAAAAADS0002", { targetId: "tgt_usw2_a",
      region: "us-west-2", home: false, vpcId: "vpc-usw2", subnetId: "subnet-usw2", availabilityZone: "us-west-2b",
    });
    expect(out).toStrictEqual({ vpcId: "vpc-usw2", subnetId: "subnet-usw2", availabilityZone: "us-west-2b", securityGroupId: "sg-plat-new", isRds: false, rdsInstanceId: undefined });
    expect(h.calls.map((c) => c.cmd)).toEqual(["CreateSecurityGroupCommand", "AuthorizeSecurityGroupIngressCommand", "DescribeVpcsCommand", "AuthorizeSecurityGroupIngressCommand"]);
    expect(h.calls[0].input.VpcId).toBe("vpc-usw2");
    expect(h.calls[3].input.IpPermissions[0].FromPort).toBe(5432);
  });
});

describe("② B-54:用户指定了子网 + 安全组 ⇒ 平台一个组都不建,用户的组全部进 Glue 连接", () => {
  const USER_NET = { subnetId: "subnet-cust-1", securityGroupIds: ["sg-cust-a", "sg-cust-b", "sg-cust-c"], availabilityZone: "us-east-1c" };

  it("🔴 零 EC2 写调用(不建组 / 不放行);仍做只读探测(RDS 识别 VPC)", async () => {
    const res = await post({ network: USER_NET });
    expect(res.status).toBe(201);
    expect(ec2Writes(), "用户指定了组还在建 / 改安全组 = B-54 复发").toEqual([]);
    // 正控制:探测照做(否则「零写」可能只是整段网络步骤被跳过了)
    expect(netCalls().map((c) => `${c.svc}:${c.cmd}`)).toEqual(["rds:DescribeDBInstancesCommand", "ec2:DescribeSubnetsCommand", "glue:CreateConnectionCommand"]);
  });

  it("🔴 Glue 连接引用**全部**用户组(原来只取第一个),子网 / AZ 用用户给的", async () => {
    await post({ network: USER_NET });
    const conn = h.calls.find((c) => c.cmd === "CreateConnectionCommand")!;
    expect(conn.input.ConnectionInput.PhysicalConnectionRequirements).toEqual({
      SubnetId: "subnet-cust-1", SecurityGroupIdList: ["sg-cust-a", "sg-cust-b", "sg-cust-c"], AvailabilityZone: "us-east-1c",
    });
  });

  it("落库:securityGroupId = 第一个(存量消费者)、securityGroupIds = 全部、不再有 platformSecurityGroupId", async () => {
    const res = await post({ network: USER_NET });
    expect(h.puts[0].networkConfig).toStrictEqual({
      vpcId: "vpc-rds", subnetId: "subnet-cust-1", availabilityZone: "us-east-1c", securityGroupId: "sg-cust-a",
      securityGroupIds: ["sg-cust-a", "sg-cust-b", "sg-cust-c"], isRds: true, rdsInstanceId: "mydb",
    });
    const body = await res.json();
    expect((body.data ?? body).provisionedResources.securityGroupId).toBe("sg-cust-a");
  });

  it("没选 AZ ⇒ 按**用户子网自己的**可用区事实(1c)写连接,不再沿用探测出的另一子网(RDS 子网组 1b)的 AZ(B-133 第二刀)", async () => {
    await post({ network: { subnetId: "subnet-cust-1", securityGroupIds: ["sg-cust-a"] } });
    const conn = h.calls.find((c) => c.cmd === "CreateConnectionCommand")!;
    expect(conn.input.ConnectionInput.PhysicalConnectionRequirements).toEqual({ SubnetId: "subnet-cust-1", SecurityGroupIdList: ["sg-cust-a"], AvailabilityZone: "us-east-1c" });
    expect(ec2Writes()).toEqual([]);
  });

  it("用户给的 AZ 与子网事实矛盾 ⇒ 500 拒绝写连接(不猜),零 EC2 写、不落库", async () => {
    const res = await post({ network: { subnetId: "subnet-cust-1", securityGroupIds: ["sg-cust-a"], availabilityZone: "us-east-1b" } });
    expect(res.status).toBe(500);
    expect((await res.json()).error?.message).toMatch(/可用区矛盾.*us-east-1b.*us-east-1c/);
    expect(h.calls.some((c) => c.cmd === "CreateConnectionCommand")).toBe(false);
    expect(ec2Writes()).toEqual([]);
    expect(h.puts).toHaveLength(0);
  });

  it("只给了一半(有子网、组清单为空)⇒ 走自动探测老路径(与改动前一致)", async () => {
    await post({ network: { subnetId: "subnet-cust-1", securityGroupIds: [] } });
    expect(ec2Writes().map((c) => c.cmd)).toEqual(["CreateSecurityGroupCommand", "AuthorizeSecurityGroupIngressCommand", "AuthorizeSecurityGroupIngressCommand"]);
    expect(h.puts[0].networkConfig.securityGroupIds).toBeUndefined();
  });

  it("组清单里有空串 / 非字符串 ⇒ 400,且什么 AWS 资源都不建(连密钥都不建)", async () => {
    for (const bad of [["sg-ok", ""], ["sg-ok", 42]]) {
      h.calls.length = 0;
      const res = await post({ network: { subnetId: "subnet-cust-1", securityGroupIds: bad } });
      expect(res.status).toBe(400);
      expect(h.calls, JSON.stringify(bad)).toEqual([]);
    }
    expect(h.puts).toHaveLength(0);
  });
});

describe("③ 删数据源:只删平台自建的组,用户的组永远不删;缺 platformSecurityGroupId 不报错", () => {
  const DSID = "01HXAAAAAAAAAAAAAAAADS0001"; // 平台组名 = bgp-ds-AADS0001(与 ① 建组时同一个名字)
  const del = () => DELETE(new NextRequest(`https://x.test/api/datasources/${DSID}`, { method: "DELETE" }), { params: { id: DSID } });
  const ec2Deletes = () => h.calls.filter((c) => c.cmd === "DeleteSecurityGroupCommand").map((c) => c.input.GroupId);

  it("B-54 新行(用户指定,无 platformSecurityGroupId):只查不删用户的组,行照删,200", async () => {
    h.sgNames = { "sg-cust-a": "customer-db", "sg-cust-b": "customer-app" };
    h.getItem = { datasourceId: DSID, projectId: "proj-a", networkConfig: { vpcId: "v", subnetId: "s", securityGroupId: "sg-cust-a", securityGroupIds: ["sg-cust-a", "sg-cust-b"], isRds: false } };
    const res = await del();
    expect(res.status).toBe(200);
    expect(ec2Deletes()).toEqual([]);
    expect(h.deletes).toEqual([{ userId: "default-user", datasourceId: DSID }]);
  });

  it("老路径行(平台自建组)⇒ 删那个组", async () => {
    h.sgNames = { "sg-plat-new": "bgp-ds-AADS0001" };
    h.getItem = { datasourceId: DSID, projectId: "proj-a", networkConfig: { vpcId: "v", subnetId: "s", securityGroupId: "sg-plat-new", isRds: false } };
    expect((await del()).status).toBe(200);
    expect(ec2Deletes()).toEqual(["sg-plat-new"]);
  });

  it("批次 A 存量行(用户组 + platformSecurityGroupId)⇒ 只删平台那个", async () => {
    h.sgNames = { "sg-plat-old": "bgp-ds-AADS0001", "sg-cust-a": "customer-db" };
    h.getItem = { datasourceId: DSID, projectId: "proj-a", networkConfig: { vpcId: "v", subnetId: "s", securityGroupId: "sg-cust-a", platformSecurityGroupId: "sg-plat-old", isRds: false } };
    expect((await del()).status).toBe(200);
    expect(ec2Deletes()).toEqual(["sg-plat-old"]);
  });

  it("🔴 用户选中了**另一条数据源**的 bgp-ds-* 组 ⇒ 不删(归属 = 组名恰好等于本源的平台组名,不是前缀)", async () => {
    h.sgNames = { "sg-other-ds": "bgp-ds-ZZZZ9999", "sg-plat-new": "bgp-ds-AADS0001" };
    h.getItem = { datasourceId: DSID, projectId: "proj-a", networkConfig: { vpcId: "v", subnetId: "s", securityGroupId: "sg-other-ds", securityGroupIds: ["sg-other-ds"], isRds: false } };
    expect((await del()).status).toBe(200);
    expect(ec2Deletes(), "删了别的数据源的平台组").toEqual([]);
    // 正控制:同一夹具里换成本源自己的组 ⇒ 照删(证明上面不是「什么都不删」)
    h.calls.length = 0;
    h.getItem = { ...h.getItem, networkConfig: { ...h.getItem.networkConfig, platformSecurityGroupId: "sg-plat-new" } };
    expect((await del()).status).toBe(200);
    expect(ec2Deletes()).toEqual(["sg-plat-new"]);
  });
});

// @kf-batch 44-jdbc-params —— 建源装配:路由 ↔ datasource-service ↔ provider 真连(用户附加参数进 Glue 连接 URL 与落库;不合法 ⇒ 400 零 AWS 调用)
describe("⑤ 附加 JDBC 参数(序 44 B-88)", () => {
  it("jdbcParams=useSSL=false ⇒ Glue 连接 URL = 方言默认参数 + 用户参数;落库 jdbcParams 归一化形态", async () => {
    const res = await post({ jdbcParams: " useSSL=false; serverTimezone=Asia/Shanghai " });
    expect(res.status).toBe(201);
    const glue = netCalls().find((c) => c.cmd === "CreateConnectionCommand");
    expect(glue?.input?.ConnectionInput?.ConnectionProperties?.JDBC_CONNECTION_URL).toBe(`jdbc:mysql://${RDS_HOST}:3306/db1?zeroDateTimeBehavior=CONVERT_TO_NULL&useSSL=false&serverTimezone=Asia/Shanghai`);
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0].jdbcParams).toBe("useSSL=false&serverTimezone=Asia/Shanghai");
  });
  it("不填 ⇒ 落库不写 jdbcParams 键(行形态与改动前相同)", async () => {
    const res = await post();
    expect(res.status).toBe(201);
    expect(h.puts[0]).not.toHaveProperty("jdbcParams");
  });
  it("不合法(值含空白)⇒ 400 VALIDATION_FAILED,什么都不建(零 AWS 调用、零落库)", async () => {
    const res = await post({ jdbcParams: "useSSL=fa lse" });
    expect(res.status).toBe(400);
    expect((await res.json()).error?.code).toBe("VALIDATION_FAILED");
    expect(h.calls.filter((c) => c.svc !== "sts")).toEqual([]);
    expect(h.puts).toHaveLength(0);
  });
});
