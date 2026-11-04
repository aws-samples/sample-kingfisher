// @kf-batch 50-P50.2c-control-api
// probe-runner 单测(真实探活的判定逻辑;client 全 mock)。
//
// 【本文件的三条承重】
// ① **单项失败不掀翻整轮**:一项红,其余照常有结论,整体 ok=false;
// ② **components 驱动**:未装组件不探;**已装但未实现探活的组件必须红**(跳过 = 假绿,
//    probe.ok 是 enableTarget 的启用前置);
// ③ **资源字段缺失 ⇒ 该项红**(拿 undefined 去打 AWS 只会得到一个更难懂的错)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const { s3Send, s3tSend, athenaSend, ec2Send, iamSend, clientRegions, rssSend, mwaaSend, dmsSend2, r53Send } = vi.hoisted(() => ({
  r53Send: vi.fn(),
  rssSend: vi.fn(),
  mwaaSend: vi.fn(),
  dmsSend2: vi.fn(),
  s3Send: vi.fn(),
  s3tSend: vi.fn(),
  athenaSend: vi.fn(),
  ec2Send: vi.fn(),
  iamSend: vi.fn(),
  clientRegions: { s3: "", s3t: "", athena: "", ec2: "", iam: "" } as Record<string, string>,
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    constructor(cfg: { region: string }) {
      clientRegions.s3 = cfg.region;
    }
    send = s3Send;
  },
  HeadBucketCommand: class {
    constructor(public input: { Bucket: string }) {}
  },
}));
vi.mock("@aws-sdk/client-s3tables", () => ({
  S3TablesClient: class {
    constructor(cfg: { region: string }) {
      clientRegions.s3t = cfg.region;
    }
    send = s3tSend;
  },
  ListTableBucketsCommand: class {
    constructor(public input: { prefix: string }) {}
  },
}));
vi.mock("@aws-sdk/client-athena", () => ({
  AthenaClient: class {
    constructor(cfg: { region: string }) {
      clientRegions.athena = cfg.region;
    }
    send = athenaSend;
  },
  GetWorkGroupCommand: class {
    constructor(public input: { WorkGroup: string }) {}
  },
}));
vi.mock("@aws-sdk/client-ec2", () => ({
  EC2Client: class {
    constructor(cfg: { region: string }) {
      clientRegions.ec2 = cfg.region;
    }
    send = ec2Send;
  },
  DescribeSecurityGroupsCommand: class {
    constructor(public input: { GroupIds: string[] }) {}
  },
  // @kf-batch 50-WP16-zero-egress:零出网两项要读路由表 / NAT / 端点
  DescribeRouteTablesCommand: class {
    constructor(public input: unknown) {}
  },
  DescribeNatGatewaysCommand: class {
    constructor(public input: unknown) {}
  },
  // @kf-batch 50-WP23-xregion-peering:形态换成跨区 peering ⇒ 读它的状态与对端网段
  DescribeVpcPeeringConnectionsCommand: class {
    constructor(public input: unknown) {}
  },
}));
// @kf-batch 50-WP16-zero-egress:私有托管域(Route 53 全局)
vi.mock("@aws-sdk/client-route-53", () => ({
  Route53Client: class {
    send = r53Send;
  },
  GetHostedZoneCommand: class {
    constructor(public input: unknown) {}
  },
  ListResourceRecordSetsCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock("@aws-sdk/client-redshift-serverless", () => ({
  RedshiftServerlessClient: class { send = rssSend; },
  GetWorkgroupCommand: class { constructor(public input: unknown) {} },
}));
vi.mock("@aws-sdk/client-mwaa", () => ({
  MWAAClient: class { send = mwaaSend; },
  GetEnvironmentCommand: class { constructor(public input: unknown) {} },
}));
vi.mock("@aws-sdk/client-database-migration-service", () => ({
  DatabaseMigrationServiceClient: class { send = dmsSend2; },
  DescribeReplicationSubnetGroupsCommand: class { constructor(public input: unknown) {} },
}));
vi.mock("@aws-sdk/client-iam", () => ({
  IAMClient: class {
    constructor(cfg: { region: string }) {
      clientRegions.iam = cfg.region;
    }
    send = iamSend;
  },
  GetRoleCommand: class {
    constructor(public input: { RoleName: string }) {}
  },
}));
// 序 48:S3 Tables 联邦目录(区级)由「检测初始化」幂等开通 —— 只 mock 真外部 Glue 客户端,ensure 逻辑(lib/aws/s3tables-catalog.ts)真跑
const { glueSend } = vi.hoisted(() => ({ glueSend: vi.fn() }));
vi.mock("@aws-sdk/client-glue", () => ({
  GlueClient: class {
    constructor(cfg: { region: string }) {
      clientRegions.glue = cfg.region;
    }
    send = glueSend;
  },
  GetCatalogCommand: class {
    constructor(public input: { CatalogId: string }) {}
  },
  CreateCatalogCommand: class {
    constructor(public input: { Name: string; CatalogInput: unknown }) {}
  },
}));

import { runProbe, PROBE_RUNNER_VIA } from "@/lib/exec-env/probe-runner";
// 序 31 二刀 ⑤:探活在第一个 AWS 调用之前记落点决策(真账本,不 mock)
import { __setRequestStoreProvider, decisionsOfCurrentRequest } from "@/lib/place/context";
// B-105:探活器产物 ↔ 组件归属契约必须装配在一起判(两边各自的单测都绿过,装起来却是坏的)
import { componentForProbeItem, isGreenProbeForComponents } from "@/lib/exec-env/component-contract";
import type { ExecutionTarget } from "@/lib/exec-env/registry";

const ACCT = "123456789012";
// agentcore 控制面(P50.2e3):一个 client 发 3 种命令,按命令类名分发。
const { acSend } = vi.hoisted(() => ({ acSend: vi.fn() }));
vi.mock("@aws-sdk/client-bedrock-agentcore-control", () => ({
  BedrockAgentCoreControlClient: class {
    send = acSend;
  },
  GetAgentRuntimeCommand: class {
    constructor(public input: { agentRuntimeId: string }) {}
  },
  GetMemoryCommand: class {
    constructor(public input: { memoryId: string }) {}
  },
  GetGatewayCommand: class {
    constructor(public input: { gatewayIdentifier: string }) {}
  },
}));

const AGENTCORE_BAG = {
  genbiRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/bgp_genbi_agent-AbCd1234",
  genbiMemoryId: "bgp_genbi_memory-XyZ98765",
  gatewayUrl: "https://bgp-genbi-gateway-tkwcjvfxby.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
};

/** agentcore 三资源全健康(状态字面值 = 真环境核过的 READY/ACTIVE/READY)。 */
function agentcoreHealthy() {
  acSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    const kind = cmd.constructor.name;
    if (kind === "GetAgentRuntimeCommand") return { status: "READY" };
    if (kind === "GetMemoryCommand") return { memory: { status: "ACTIVE" } };
    if (kind === "GetGatewayCommand") return { status: "READY", gatewayUrl: AGENTCORE_BAG.gatewayUrl };
    throw new Error(`未知命令 ${kind}`);
  });
}

const RESOURCES = {
  datalakeBucket: `bgp-datalake-${ACCT}-tgt-usw2-a`,
  scriptsBucket: `bgp-glue-scripts-${ACCT}-tgt-usw2-a`,
  tableBucket: "bgp-table-bucket-tgt-usw2-a",
  athenaWorkgroup: "bgp-athena-tgt-usw2-a",
  glueRoleArn: `arn:aws:iam::${ACCT}:role/bgp-glue-role`,
  emrSecurityGroupId: "sg-0123456789abcdef0",
  // @kf-batch 50-WP16-zero-egress:底座资源袋的零出网键(SPEC §3.16-E)
  vpcId: "vpc-0123456789abcdef0",
  endpointIds: "vpce-aaa,vpce-bbb,vpce-ccc",
  // @kf-batch 50-WP23-xregion-peering:跨区通路从「本区的跨区端点」换成「跨区 peering」
  //   (老形态 `crossRegionDdbEndpointId` 被组织 SCP 拦死、在本组织永远建不出来 ⇒ 判据不许再钉它)
  homeLinkPeeringId: "pcx-0123456789abcdef0",
  homeLinkHostedZoneId: "Z02066582K5P8SB5ZQ2GD",
};

// @kf-batch 50-WP23-xregion-peering
const HOME_CIDR = "10.0.0.0/16";
/** 本区两张私有子网路由表:都关联了子网、都有到主控区的 peering 路由(健康形态)。 */
let ROUTE_TABLES: () => Array<Record<string, unknown>> = () => [
  {
    RouteTableId: "rtb-1",
    Associations: [{ SubnetId: "subnet-a" }],
    Routes: [
      { DestinationCidrBlock: "10.128.0.0/16", GatewayId: "local" },
      { DestinationCidrBlock: HOME_CIDR, VpcPeeringConnectionId: "pcx-0123456789abcdef0" },
    ],
  },
  {
    RouteTableId: "rtb-2",
    Associations: [{ SubnetId: "subnet-b" }],
    Routes: [
      { DestinationCidrBlock: "10.128.0.0/16", GatewayId: "local" },
      { DestinationCidrBlock: HOME_CIDR, VpcPeeringConnectionId: "pcx-0123456789abcdef0" },
    ],
  },
];

function target(over: Record<string, unknown> = {}): ExecutionTarget {
  return {
    pk: "env",
    sk: "tgt_usw2_a",
    targetId: "tgt_usw2_a",
    partition: "aws",
    accountId: ACCT,
    region: "us-west-2",
    status: "testing",
    components: ["core"],
    resources: RESOURCES,
    ...over,
  } as unknown as ExecutionTarget;
}

/** 全部服务返回"存在且健康"。 */
function allHealthy() {
  s3Send.mockResolvedValue({});
  s3tSend.mockResolvedValue({ tableBuckets: [{ name: RESOURCES.tableBucket }] });
  athenaSend.mockResolvedValue({ WorkGroup: { State: "ENABLED" } });
  // @kf-batch 50-WP16-zero-egress:一个 EC2 client 现在发 4 种命令 ⇒ 按命令类名分发
  //   (原来 mockResolvedValue 一把梭,新命令会拿到 SecurityGroups 形状的响应 ⇒ 判据读到 undefined 而假绿/假红)
  ec2Send.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    switch (cmd.constructor.name) {
      case "DescribeSecurityGroupsCommand":
        return { SecurityGroups: [{ GroupId: RESOURCES.emrSecurityGroupId }] };
      case "DescribeRouteTablesCommand":
        // 零出网:只有 VPC 内部路由 + 到主控区的 peering 路由,没有 0.0.0.0/0
        // 🔴 **两张**子网路由表都要有那条 peering 路由(少一张 = 那个 AZ 的任务静默回写不了)
        return { RouteTables: ROUTE_TABLES() };
      case "DescribeNatGatewaysCommand":
        return { NatGateways: [] };
      case "DescribeVpcPeeringConnectionsCommand":
        return {
          VpcPeeringConnections: [
            {
              VpcPeeringConnectionId: RESOURCES.homeLinkPeeringId,
              Status: { Code: "active" },
              // 对端网段从 peering 身上读(不在描述符里另存一份 ⇒ 不会漂)
              AccepterVpcInfo: { CidrBlock: HOME_CIDR },
            },
          ],
        };
      default:
        throw new Error(`测试没给 ${cmd.constructor.name} 备响应`);
    }
  });
  r53Send.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    switch (cmd.constructor.name) {
      case "GetHostedZoneCommand":
        return { VPCs: [{ VPCId: RESOURCES.vpcId, VPCRegion: "us-west-2" }] };
      case "ListResourceRecordSetsCommand":
        // @kf-batch 50-WP23:A 记录 + 主控区端点 ENI 的私有 IP(跨 region 拿不到 DnsEntries 做 ALIAS)
        return { ResourceRecordSets: [{ Type: "A", ResourceRecords: [{ Value: "10.0.2.31" }, { Value: "10.0.3.17" }] }] };
      default:
        throw new Error(`测试没给 ${cmd.constructor.name} 备响应`);
    }
  });
  iamSend.mockResolvedValue({ Role: {} });
  // 序 48:联邦目录已在(GetCatalog 成功)⇒ 该项绿且不建
  glueSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === "GetCatalogCommand") return { Catalog: { Name: "s3tablescatalog" } };
    throw new Error(`测试没给 ${cmd.constructor.name} 备响应`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("core 全绿", () => {
  it("9 项全 ok(两桶/表桶/WG/SG/角色 + 零出网两项 + 联邦目录),整体 ok=true,at 是可解析 ISO", async () => {
    allHealthy();
    const r = await runProbe(target());
    expect(r.items.map((i) => i.name).sort()).toEqual(
      [
        "athenaWorkgroup", "datalakeBucket", "emrSecurityGroupId", "glueRoleArn", "scriptsBucket", "tableBucket",
        // @kf-batch 50-WP16-zero-egress:非 home 的 core 必出这两项(home 不出 —— home 保留 NAT,见 WP-16 非目标)
        "network:egress-none", "network:home-link",
        // 序 48:该区 S3 Tables 联邦目录(候选区内加区不再经 redeploy-platform 第 3c 步 ⇒ 检测初始化幂等开通)
        "lake:s3tablescatalog",
      ].sort()
    );
    expect(r.items.every((i) => i.ok)).toBe(true);
    expect(r.ok).toBe(true);
    expect(Number.isFinite(Date.parse(r.at))).toBe(true);
    // Glue 客户端必须建在**目标区**(联邦目录是区级资源;建到 home 去 = 给错的区开通还报绿)
    expect(clientRegions.glue).toBe("us-west-2");
  });

  // 🔴 B-105(2026-10-19 …7237 序 48 真环境演练抓到):探活器新加了 `lake:s3tablescatalog`,但「探活项 → 组件」的唯一作者
  //   component-contract.ts 没登记它 ⇒ isGreenProbeForComponents 对**所有**环境恒 false ⇒ 新区探活 18 项全绿却
  //   `probe-coverage-mismatch`,相位永远停在 provisioning(页面「部署中」、「启用」灰);存量在用区几个 tick 后全部掉成 degraded。
  //   两侧各自的单测全绿(本文件钉了项名、契约测试手抄了项名)—— 接缝只能在装配层钉:探活器真跑、契约真判,只 mock AWS。
  it("🔴 B-105 装配:全绿探活的每一项都归属到声明组件,且精确覆盖判定为 true(新项没登记契约 ⇒ 这里红)", async () => {
    allHealthy();
    rssSend.mockResolvedValue({ workgroup: { status: "AVAILABLE" } });
    dmsSend2.mockResolvedValue({ ReplicationSubnetGroups: [{}] });
    const components = ["core", "redshift", "dms"];
    const r = await runProbe(
      target({
        components,
        resources: {
          ...RESOURCES,
          redshiftWorkgroup: "bgp-workgroup-tgt-usw2-a",
          dmsSubnetGroup: "bgp-dms-subnet-group-tgt-usw2-a",
          redshiftCopyRoleArn: `arn:aws:iam::${ACCT}:role/BgpExecEnv-tgt-usw2-a-redshift-copy-role`,
          dmsKinesisRoleArn: `arn:aws:iam::${ACCT}:role/BgpExecEnv-tgt-usw2-a-dms-kinesis-role`,
        },
      })
    );
    expect(r.ok).toBe(true);
    const orphan = r.items.filter((i) => componentForProbeItem(i.name) === null).map((i) => i.name);
    expect(orphan, `这些探活项归属不到任何组件(component-contract.ts 没登记):${orphan.join(", ")}`).toEqual([]);
    expect(isGreenProbeForComponents(components, r.items)).toBe(true);
  });

  // 序 48:目录不在 ⇒ 当场开通(CreateCatalog 真被调、入参指向本区)⇒ 项绿;开通被拒 ⇒ 项红带 aws 原话,不假装绿
  it("联邦目录不在 ⇒ CreateCatalog 开通后该项绿;CreateCatalog 被拒 ⇒ 该项红带原话,其余项不受影响", async () => {
    allHealthy();
    const created: unknown[] = [];
    glueSend.mockImplementation(async (cmd: { constructor: { name: string }; input?: unknown }) => {
      if (cmd.constructor.name === "GetCatalogCommand") throw Object.assign(new Error("Catalog not found"), { name: "EntityNotFoundException" });
      if (cmd.constructor.name === "CreateCatalogCommand") { created.push(cmd.input); return {}; }
      throw new Error(`测试没给 ${cmd.constructor.name} 备响应`);
    });
    const okRun = await runProbe(target());
    expect(okRun.items.find((i) => i.name === "lake:s3tablescatalog")?.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(JSON.stringify(created[0])).toContain("arn:aws:s3tables:us-west-2:");

    glueSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === "GetCatalogCommand") throw Object.assign(new Error("Catalog not found"), { name: "EntityNotFoundException" });
      throw Object.assign(new Error("User is not authorized to perform: glue:CreateCatalog"), { name: "AccessDeniedException" });
    });
    const badRun = await runProbe(target());
    const item = badRun.items.find((i) => i.name === "lake:s3tablescatalog")!;
    expect(item.ok).toBe(false);
    expect(item.error).toContain("glue:CreateCatalog");
    expect(badRun.items.filter((i) => i.ok)).toHaveLength(8);
    expect(badRun.ok).toBe(false);
  });

  it("region 级 client 按 target.region 现建;IAM 用 home region", async () => {
    allHealthy();
    await runProbe(target());
    expect(clientRegions.s3).toBe("us-west-2");
    expect(clientRegions.s3t).toBe("us-west-2");
    expect(clientRegions.athena).toBe("us-west-2");
    expect(clientRegions.ec2).toBe("us-west-2");
    expect(clientRegions.iam).toBe(process.env.AWS_REGION || "us-east-1");
    // IAM 的 RoleName 取 ARN 最后一段
    expect(iamSend.mock.calls[0][0].input).toEqual({ RoleName: "bgp-glue-role" });
  });
});

describe("🔴 @kf-batch 50-WP16-zero-egress 灰度门:零出网两项只对**已切换**的 target 出", () => {
  it("没切换(资源袋无 endpointIds)⇒ **不出**这两项,状态不因此掉成降级", async () => {
    allHealthy();
    const { endpointIds, homeLinkPeeringId, homeLinkHostedZoneId, ...legacy } = RESOURCES;
    void endpointIds; void homeLinkPeeringId; void homeLinkHostedZoneId;
    const r = await runProbe(target({ resources: legacy }));
    const names = r.items.map((i) => i.name);
    expect(names).not.toContain("network:egress-none");
    expect(names).not.toContain("network:home-link");
    // 🔴 承重:平台代码一上线不许把还没走升级动线的存量环境判红(它们本来是好的)
    expect(r.items.every((i) => i.ok)).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("已切换但现网又冒出 NAT ⇒ egress-none 红(切换后的漂移照样抓得到)", async () => {
    allHealthy();
    ec2Send.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      switch (cmd.constructor.name) {
        case "DescribeSecurityGroupsCommand":
          return { SecurityGroups: [{ GroupId: RESOURCES.emrSecurityGroupId }] };
        case "DescribeRouteTablesCommand":
          return { RouteTables: [{ RouteTableId: "rtb-1", Routes: [{ DestinationCidrBlock: "10.0.0.0/16" }] }] };
        case "DescribeNatGatewaysCommand":
          return { NatGateways: [{ NatGatewayId: "nat-zombie", State: "available" }] };
        case "DescribeVpcPeeringConnectionsCommand":
          return { VpcPeeringConnections: [{ Status: { Code: "active" }, AccepterVpcInfo: { CidrBlock: HOME_CIDR } }] };
        default:
          throw new Error(`测试没给 ${cmd.constructor.name} 备响应`);
      }
    });
    const r = await runProbe(target());
    const item = r.items.find((i) => i.name === "network:egress-none");
    expect(item?.ok).toBe(false);
    expect(item?.error).toContain("NAT");
  });

  it("home 永不出这两项(WP-16 非目标:主控区 VPC 的 NAT 另立包)", async () => {
    allHealthy();
    const r = await runProbe(target({ targetId: "tgt_home", sk: "tgt_home", region: "us-east-1" }));
    expect(r.items.map((i) => i.name)).not.toContain("network:egress-none");
  });
});

// @kf-batch 50-WP23-xregion-peering
// 🔴🔴 `network:home-link` 改判:老形态(本区的**跨区**端点)被组织 SCP 拦死、在本组织永远建不出来
//    ⇒ 判据钉的必须是新形态(peering active + **每张**子网路由表都有回程路由 + 私有托管域有带值的 A 记录)。
//    这一组每条都对应一个「部署全绿、回写静默超时」的形状。
describe("🔴🔴 network:home-link 认的是 peering 形态", () => {
  const ec2With = (over: Record<string, unknown>) =>
    ec2Send.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      switch (cmd.constructor.name) {
        case "DescribeSecurityGroupsCommand":
          return { SecurityGroups: [{ GroupId: RESOURCES.emrSecurityGroupId }] };
        case "DescribeRouteTablesCommand":
          return { RouteTables: (over.RouteTables as unknown[]) ?? ROUTE_TABLES() };
        case "DescribeNatGatewaysCommand":
          return { NatGateways: [] };
        case "DescribeVpcPeeringConnectionsCommand":
          return (
            (over.Peering as Record<string, unknown>) ?? {
              VpcPeeringConnections: [{ Status: { Code: "active" }, AccepterVpcInfo: { CidrBlock: HOME_CIDR } }],
            }
          );
        default:
          throw new Error(`测试没给 ${cmd.constructor.name} 备响应`);
      }
    });
  const link = async (over: Record<string, unknown> = {}, t = target()) => {
    allHealthy();
    ec2With(over);
    const r = await runProbe(t);
    return r.items.find((i) => i.name === "network:home-link")!;
  };

  it("健康形态 ⇒ 绿(正控制:下面每条负向都必须**只因为**自己那一处变红)", async () => {
    expect((await link()).ok).toBe(true);
  });

  it("描述符缺 homeLinkPeeringId ⇒ 红,并点名这个字段", async () => {
    const { homeLinkPeeringId, ...rest } = RESOURCES;
    void homeLinkPeeringId;
    const item = await link({}, target({ resources: { ...rest, endpointIds: RESOURCES.endpointIds } }));
    expect(item.ok).toBe(false);
    expect(item.error).toContain("homeLinkPeeringId");
  });

  it("peering 还在 pending-acceptance ⇒ 红,但话说清是**传播窗口**(不是配置错)", async () => {
    const item = await link({ Peering: { VpcPeeringConnections: [{ Status: { Code: "pending-acceptance" }, AccepterVpcInfo: { CidrBlock: HOME_CIDR } }] } });
    expect(item.ok).toBe(false);
    expect(item.error).toMatch(/还在建/);
  });

  it("peering 被删 ⇒ 红(查不到)", async () => {
    const item = await link({ Peering: { VpcPeeringConnections: [] } });
    expect(item.ok).toBe(false);
    expect(item.error).toMatch(/不存在/);
  });

  it("🔴 只有一张路由表有回程路由 ⇒ 红(另一张那个 AZ 会**间歇性**回写不了,最难查的一类)", async () => {
    const half = ROUTE_TABLES();
    (half[1] as { Routes: unknown[] }).Routes = [{ DestinationCidrBlock: "10.128.0.0/16", GatewayId: "local" }];
    const item = await link({ RouteTables: half });
    expect(item.ok).toBe(false);
    expect(item.error).toMatch(/1\/2/);
  });

  it("🔴 回程路由指向**别的** peering ⇒ 红(不是「有一条到主控区的路由」就算过)", async () => {
    const wrong = ROUTE_TABLES();
    for (const rt of wrong) {
      (rt as { Routes: Array<Record<string, unknown>> }).Routes[1] = { DestinationCidrBlock: HOME_CIDR, VpcPeeringConnectionId: "pcx-someone-else" };
    }
    const item = await link({ RouteTables: wrong });
    expect(item.ok).toBe(false);
    expect(item.error).toMatch(/0\/2/);
  });

  it("私有托管域里的 A 记录**没有值** ⇒ 红(有记录不等于解析得到东西)", async () => {
    allHealthy();
    ec2With({});
    r53Send.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === "GetHostedZoneCommand") return { VPCs: [{ VPCId: RESOURCES.vpcId }] };
      return { ResourceRecordSets: [{ Type: "A", ResourceRecords: [] }] };
    });
    const r = await runProbe(target());
    const item = r.items.find((i) => i.name === "network:home-link")!;
    expect(item.ok).toBe(false);
    expect(item.error).toMatch(/没有带值的 A 记录/);
  });

  it("ALIAS 形态也算(判据不许只认新写法 —— 存量环境用的是 ALIAS)", async () => {
    allHealthy();
    ec2With({});
    r53Send.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === "GetHostedZoneCommand") return { VPCs: [{ VPCId: RESOURCES.vpcId }] };
      return { ResourceRecordSets: [{ Type: "A", AliasTarget: { DNSName: "vpce-x.vpce.amazonaws.com" } }] };
    });
    const r = await runProbe(target());
    expect(r.items.find((i) => i.name === "network:home-link")!.ok).toBe(true);
  });
});

describe("🔴 单项失败不掀翻整轮", () => {
  it("HeadBucket 抛(桶被删)⇒ 两桶项红带原因,其余 6 项照常绿(含零出网两项),整体 ok=false", async () => {
    allHealthy();
    s3Send.mockRejectedValue(new Error("NotFound: 404"));
    const r = await runProbe(target());
    const red = r.items.filter((i) => !i.ok);
    expect(red.map((i) => i.name).sort()).toEqual(["datalakeBucket", "scriptsBucket"]);
    expect(red[0].error).toContain("404");
    // @kf-batch 50-WP16-zero-egress:4 → 6(零出网两项与桶无关,必须照常绿 —— 这正是「单项失败不掀翻整轮」);序 48 联邦目录项 ⇒ 7
    expect(r.items.filter((i) => i.ok)).toHaveLength(7);
    expect(r.ok).toBe(false);
  });

  it("S3Tables 前缀命中但精确名不匹配 ⇒ tableBucket 红(不是把相邻桶当自己的)", async () => {
    allHealthy();
    s3tSend.mockResolvedValue({ tableBuckets: [{ name: RESOURCES.tableBucket + "-other" }] });
    const r = await runProbe(target());
    const item = r.items.find((i) => i.name === "tableBucket")!;
    expect(item.ok).toBe(false);
    expect(item.error).toContain("不存在");
  });

  it("Athena workgroup 状态非 ENABLED ⇒ 红(存在但被禁用不算健康)", async () => {
    allHealthy();
    athenaSend.mockResolvedValue({ WorkGroup: { State: "DISABLED" } });
    const r = await runProbe(target());
    expect(r.items.find((i) => i.name === "athenaWorkgroup")!.ok).toBe(false);
  });
});

describe("🔴 components 驱动 + 资源缺失", () => {
  it("已装 redshift ⇒ 真探 workgroup(AVAILABLE 绿 / 非 AVAILABLE 红带状态)—— P50.2e2 从占位红升级为真探", async () => {
    allHealthy();
    rssSend.mockResolvedValue({ workgroup: { status: "AVAILABLE" } });
    const ok = await runProbe(target({ components: ["core", "redshift"], resources: { ...RESOURCES, redshiftWorkgroup: "bgp-workgroup", redshiftDatabase: "dev", redshiftSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:x" } }));
    expect(ok.items.find((i) => i.name === "redshift:workgroup")?.ok).toBe(true);

    rssSend.mockResolvedValue({ workgroup: { status: "MODIFYING" } });
    const bad = await runProbe(target({ components: ["core", "redshift"], resources: { ...RESOURCES, redshiftWorkgroup: "bgp-workgroup", redshiftDatabase: "dev", redshiftSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:x" } }));
    const item = bad.items.find((i) => i.name === "redshift:workgroup")!;
    expect(item.ok).toBe(false);
    expect(item.error).toContain("MODIFYING");
    expect(bad.ok).toBe(false);
  });

  it("mwaa/dms 真探:AVAILABLE/存在 ⇒ 绿;仍未实现真探的组件(kafka)保持红", async () => {
    allHealthy();
    mwaaSend.mockResolvedValue({ Environment: { Status: "AVAILABLE" } });
    dmsSend2.mockResolvedValue({ ReplicationSubnetGroups: [{}] });
    const r = await runProbe(target({ components: ["core", "mwaa", "dms", "kafka"], resources: { ...RESOURCES, dagBucket: "bgp-mwaa-dags-123456789012", mwaaEnvName: "bgp-mwaa", dmsSubnetGroup: "bgp-dms-subnet-group" } }));
    expect(r.items.find((i) => i.name === "mwaa:environment")?.ok).toBe(true);
    expect(r.items.find((i) => i.name === "dms:subnet-group")?.ok).toBe(true);
    const kafka = r.items.find((i) => i.name === "kafka")!;
    expect(kafka.ok).toBe(false);
    expect(kafka.error).toContain("未实现");
  });

  it("未装组件不探:components=[core] 时没有 redshift/mwaa 的项", async () => {
    allHealthy();
    const r = await runProbe(target());
    expect(r.items.some((i) => ["redshift", "mwaa", "dms"].includes(i.name))).toBe(false);
  });

  it("资源字段缺失 ⇒ 该项红并指向 finalizeTargetResources(不拿 undefined 去打 AWS)", async () => {
    allHealthy();
    const { athenaWorkgroup: _drop, ...rest } = RESOURCES;
    const r = await runProbe(target({ resources: rest }));
    const item = r.items.find((i) => i.name === "athenaWorkgroup")!;
    expect(item.ok).toBe(false);
    expect(item.error).toContain("finalizeTargetResources");
    expect(athenaSend).not.toHaveBeenCalled();
  });

  it("components 竟不含 core ⇒ 产出一条 core 红项(描述符坏了要能看见,不是空结果)", async () => {
    const r = await runProbe(target({ components: [] }));
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ name: "core", ok: false });
  });
});

describe("🔴 agentcore 真探(P50.2e3;字段在顶层 agentcore 袋,不在 resources)", () => {
  it("runtime READY + memory ACTIVE + gateway READY ⇒ 三项全绿", async () => {
    allHealthy();
    agentcoreHealthy();
    const r = await runProbe(target({ components: ["core", "agentcore"], agentcore: AGENTCORE_BAG }));
    const ac = r.items.filter((i) => i.name.startsWith("agentcore:"));
    expect(ac.map((i) => [i.name, i.ok])).toEqual([
      ["agentcore:runtime", true],
      ["agentcore:memory", true],
      ["agentcore:gateway", true],
    ]);
    expect(r.ok).toBe(true);
  });

  it("runtime 非 READY ⇒ runtime 项红带状态,memory/gateway 照常绿(单项失败不掀翻整轮)", async () => {
    allHealthy();
    agentcoreHealthy();
    acSend.mockImplementationOnce(async () => ({ status: "CREATING" })); // 首个调用是 GetAgentRuntime
    const r = await runProbe(target({ components: ["core", "agentcore"], agentcore: AGENTCORE_BAG }));
    const rt = r.items.find((i) => i.name === "agentcore:runtime")!;
    expect(rt.ok).toBe(false);
    expect(rt.error).toContain("CREATING");
    expect(r.items.find((i) => i.name === "agentcore:memory")!.ok).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("描述符缺 agentcore 袋 ⇒ 三项各自红并指明缺哪个字段(不拿 undefined 去打 AWS)", async () => {
    allHealthy();
    const r = await runProbe(target({ components: ["core", "agentcore"] }));
    const ac = r.items.filter((i) => i.name.startsWith("agentcore:"));
    expect(ac).toHaveLength(3);
    for (const item of ac) expect(item.ok).toBe(false);
    expect(ac[0].error).toContain("genbiRuntimeArn");
    expect(acSend).not.toHaveBeenCalled();
  });
});

// @kf-batch 50-W5-seg1-WP3 —— 执行角色键探活(有才探;名必须是本 target 名)
describe("🔴 WP-3 执行角色探活:键在才出项;非 home 的角色名必须是命名 SSOT 的本 target 名", () => {
  const PER_EMR = `arn:aws:iam::${ACCT}:role/BgpExecEnv-tgt-usw2-a-emr-role`;
  it("描述符没有 emrExecutionRoleArn ⇒ 不出项(前置由准入判,不由探活把存量 target 探红)", async () => {
    allHealthy();
    const r = await runProbe(target());
    expect(r.items.map((i) => i.name)).not.toContain("emrExecutionRoleArn");
    expect(r.ok).toBe(true);
  });
  it("有 emrExecutionRoleArn 且是本 target 名 ⇒ 出项 ok,IAM GetRole 查的就是那个名", async () => {
    allHealthy();
    const r = await runProbe(target({ resources: { ...RESOURCES, emrExecutionRoleArn: PER_EMR } }));
    const it = r.items.find((i) => i.name === "emrExecutionRoleArn");
    expect(it?.ok).toBe(true);
    expect(iamSend.mock.calls.map((c) => c[0].input.RoleName)).toContain("BgpExecEnv-tgt-usw2-a-emr-role");
  });
  it("🔴 有 emrExecutionRoleArn 但是 home 名 ⇒ 该项红、错因指路重新部署;其余项照常", async () => {
    allHealthy();
    const r = await runProbe(target({ resources: { ...RESOURCES, emrExecutionRoleArn: `arn:aws:iam::${ACCT}:role/bgp-emr-serverless-role` } }));
    const it = r.items.find((i) => i.name === "emrExecutionRoleArn");
    expect(it?.ok).toBe(false);
    expect(it?.error).toMatch(/不是本 target 的角色/);
    expect(it?.error).toMatch(/重新部署/);
    expect(r.ok).toBe(false);
  });
  it("redshift / dms 组件的可选角色键:有才探,项名 redshift:copy-role / dms:kinesis-role", async () => {
    allHealthy();
    rssSend.mockResolvedValue({ workgroup: { status: "AVAILABLE" } });
    dmsSend2.mockResolvedValue({ ReplicationSubnetGroups: [{}] });
    const r = await runProbe(
      target({
        components: ["core", "redshift", "dms"],
        resources: {
          ...RESOURCES,
          redshiftWorkgroup: "bgp-workgroup-tgt-usw2-a",
          dmsSubnetGroup: "bgp-dms-subnet-group-tgt-usw2-a",
          redshiftCopyRoleArn: `arn:aws:iam::${ACCT}:role/BgpExecEnv-tgt-usw2-a-redshift-copy-role`,
          dmsKinesisRoleArn: `arn:aws:iam::${ACCT}:role/BgpExecEnv-tgt-usw2-a-dms-kinesis-role`,
        },
      })
    );
    const names = r.items.map((i) => i.name);
    expect(names).toContain("redshift:copy-role");
    expect(names).toContain("dms:kinesis-role");
    expect(r.items.filter((i) => i.name.endsWith("-role")).every((i) => i.ok)).toBe(true);
  });
});

// @kf-batch 50-WP31-place-first-class 序 31 二刀 ⑤(2026-10-23 …9435 observe 复验抓到):已启用环境点「检测初始化」⇒ reconcileOneTarget
//   不需 finalize ⇒ 不经 readBuildStatus(此前整条流程唯一的记账点)⇒ runProbe 打到目标区的 CFN / S3 / EC2 / Redshift / Glue / DMS / Athena
//   全被观测器记成未归因(20 条 / 次)。修 = runProbe 自己在第一个 AWS 调用之前记决策;四个调用方(reconcile / enable / retire-components / seed-home)一并受益。
describe("🔴 序 31 二刀 ⑤:runProbe 在第一个 AWS 调用之前记落点决策", () => {
  it("有请求账本 ⇒ 第一次 send 时账本里已有 {tgt_usw2_a, runProbe};探活结果不受影响", async () => {
    const store = {};
    __setRequestStoreProvider(() => store);
    try {
      allHealthy();
      const seenAtSend: number[] = [];
      s3Send.mockImplementation(async () => {
        seenAtSend.push(decisionsOfCurrentRequest().decisions.length);
        return {};
      });
      const r = await runProbe(target());
      expect(r.ok).toBe(true);
      expect(decisionsOfCurrentRequest().decisions).toEqual([{ targetId: "tgt_usw2_a", via: PROBE_RUNNER_VIA }]);
      expect(seenAtSend.length).toBeGreaterThan(0);
      expect(seenAtSend.every((n) => n >= 1), `有 send 发生在决策之前:${JSON.stringify(seenAtSend)}`).toBe(true);
    } finally {
      __setRequestStoreProvider(null);
    }
  });
  it("请求外(周期 reconciler)⇒ 不记、不抛,探活照常", async () => {
    __setRequestStoreProvider(() => undefined);
    try {
      allHealthy();
      const r = await runProbe(target());
      expect(r.ok).toBe(true);
      expect(decisionsOfCurrentRequest().decisions).toEqual([]);
    } finally {
      __setRequestStoreProvider(null);
    }
  });
});
