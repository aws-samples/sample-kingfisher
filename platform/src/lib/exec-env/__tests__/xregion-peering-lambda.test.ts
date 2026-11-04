// @kf-batch 50-WP23-xregion-peering
// **跨区通路 home 侧接线**(`infra/lambda/xregion-peering`)的门禁。
//
// 【为什么这段一定要有真行为测试】它是全仓唯一会**改主控区路由表**的代码:
//   · 少加一条 ⇒ 某个 AZ 的任务回写不了台账(间歇性失败,最难查);
//   · 多删一条 ⇒ 把别人的路由删了;
//   · 两个环境撞同一网段 ⇒ 必须**响亮报错**(注册期分配有一个并发窄窗口,兜底就在这里)。
// 🔴 用**同形的假 EC2 客户端**(send(command) → 记录 + 应答),不 mock 兄弟模块:
//    真正的外部只有 EC2 API 这一个(见记忆 mock-hides-the-seam)。
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "../../../../..");
const LAMBDA = resolve(REPO, "infra/lambda/xregion-peering/index.mjs");

const PCX = "pcx-0123456789abcdef0";
const LOCAL = "10.128.0.0/16";
const EP = "vpce-0123456789abcdef0";

interface World {
  peeringState?: string;
  /** 端点落在哪些子网 */
  endpointSubnets?: string[];
  routeTables?: Array<Record<string, unknown>>;
  enis?: string[];
}

/** 假 EC2 客户端:按命令类名应答,并把发出的写操作记进 `calls`。 */
function fakeEc2(w: World = {}) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const state = { peering: w.peeringState ?? "active" };
  const client = {
    calls,
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = cmd.constructor.name;
      calls.push({ name, input: cmd.input });
      switch (name) {
        case "DescribeVpcPeeringConnectionsCommand":
          return { VpcPeeringConnections: [{ VpcPeeringConnectionId: PCX, Status: { Code: state.peering } }] };
        case "AcceptVpcPeeringConnectionCommand":
          state.peering = "active";
          return {};
        case "DescribeVpcEndpointsCommand":
          return {
            VpcEndpoints: [
              { VpcEndpointId: EP, VpcId: "vpc-home", SubnetIds: w.endpointSubnets ?? ["subnet-h1", "subnet-h2"], NetworkInterfaceIds: w.enis ?? ["eni-1", "eni-2"] },
            ],
          };
        case "DescribeRouteTablesCommand":
          return { RouteTables: w.routeTables ?? defaultTables() };
        case "DescribeNetworkInterfacesCommand":
          return { NetworkInterfaces: [{ PrivateIpAddress: "10.0.3.17" }, { PrivateIpAddress: "10.0.2.31" }] };
        case "CreateRouteCommand":
        case "DeleteRouteCommand":
          return {};
        default:
          throw new Error(`假客户端没给 ${name} 备应答`);
      }
    },
  };
  return client;
}

const defaultTables = () => [
  { RouteTableId: "rtb-h1", Associations: [{ SubnetId: "subnet-h1" }], Routes: [{ DestinationCidrBlock: "10.0.0.0/16", GatewayId: "local" }] },
  { RouteTableId: "rtb-h2", Associations: [{ SubnetId: "subnet-h2" }], Routes: [{ DestinationCidrBlock: "10.0.0.0/16", GatewayId: "local" }] },
  { RouteTableId: "rtb-main", Associations: [{ Main: true }], Routes: [] },
];

async function load() {
  return (await import(LAMBDA)) as {
    handler: (e: unknown, deps?: Record<string, unknown>) => Promise<{ PhysicalResourceId: string; Data: Record<string, string> }>;
    homeRouteTables: (ec2: unknown, endpointId: string) => Promise<Array<{ RouteTableId?: string }>>;
  };
}

const event = (RequestType: string, over: Record<string, unknown> = {}) => ({
  RequestType,
  ResourceProperties: {
    HomeRegion: "us-east-1",
    PeeringConnectionId: PCX,
    LocalVpcCidr: LOCAL,
    HomeDdbEndpointId: EP,
    TargetId: "tgt_usw2_a",
    ...over,
  },
});

describe("🔴 Create:accept + 每张相关路由表都加回程路由 + 读回 ENI IP", () => {
  it("pending-acceptance ⇒ 先 accept;两张表各加一条;IP 排序后返回", async () => {
    const { handler } = await load();
    const ec2 = fakeEc2({ peeringState: "pending-acceptance" });
    const out = await handler(event("Create"), { ec2, pollMs: 1 });
    expect(ec2.calls.some((c) => c.name === "AcceptVpcPeeringConnectionCommand"), "pending 必须 accept").toBe(true);
    const created = ec2.calls.filter((c) => c.name === "CreateRouteCommand");
    // 🔴 断**具体加到哪两张表**:只断「加了两条」的话,把两条都加到同一张表也能过
    expect(created.map((c) => c.input.RouteTableId).sort()).toEqual(["rtb-h1", "rtb-h2"]);
    for (const c of created) {
      expect(c.input.DestinationCidrBlock, "目的地必须是**本环境**网段").toBe(LOCAL);
      expect(c.input.VpcPeeringConnectionId).toBe(PCX);
    }
    expect(out.Data.EndpointIps, "IP 要排序(顺序抖动 = 无意义的 changeset)").toBe("10.0.2.31,10.0.3.17");
    expect(out.PhysicalResourceId).toBe("homelink-tgt_usw2_a");
  });

  it("已经 active ⇒ 不再 accept(幂等,Update 会反复跑)", async () => {
    const { handler } = await load();
    const ec2 = fakeEc2({ peeringState: "active" });
    await handler(event("Update"), { ec2, pollMs: 1 });
    expect(ec2.calls.some((c) => c.name === "AcceptVpcPeeringConnectionCommand")).toBe(false);
  });

  it("路由已经是我们这条 ⇒ 不重复创建(幂等)", async () => {
    const { handler } = await load();
    const tables = defaultTables();
    for (const t of tables.slice(0, 2)) {
      (t as { Routes: Array<Record<string, unknown>> }).Routes.push({ DestinationCidrBlock: LOCAL, VpcPeeringConnectionId: PCX });
    }
    const ec2 = fakeEc2({ routeTables: tables });
    await handler(event("Create"), { ec2, pollMs: 1 });
    expect(ec2.calls.filter((c) => c.name === "CreateRouteCommand")).toHaveLength(0);
  });

  // 🔴 冲突落在**第二张**表:这才测得出「先全部核对、再全部创建」这个性质。
  //    写第一版判据时我把冲突放在第一张表 ⇒ 零副作用是**运气**(还没轮到创建就抛了),
  //    而实现当时确实是边核对边创建 —— 判据在测运气,不是测性质。改判据的同时把实现也改成两段式。
  it.each([
    ["第一张表", 0],
    ["第二张表", 1],
  ])("🔴🔴 同一网段已被别的 peering 占(%s)⇒ 抛 + **一条都不许加**", async (_label, idx) => {
    const { handler } = await load();
    const tables = defaultTables();
    (tables[idx] as { Routes: Array<Record<string, unknown>> }).Routes.push({ DestinationCidrBlock: LOCAL, VpcPeeringConnectionId: "pcx-someone-else" });
    const ec2 = fakeEc2({ routeTables: tables });
    await expect(handler(event("Create"), { ec2, pollMs: 1 })).rejects.toThrow(/pcx-someone-else/);
    expect(ec2.calls.filter((c) => c.name === "CreateRouteCommand"), "半套路由比没有更难查").toHaveLength(0);
  });

  it("peering 进终态(rejected/failed)⇒ 抛,并说清不要重试同一条", async () => {
    const { handler } = await load();
    const ec2 = fakeEc2({ peeringState: "rejected" });
    await expect(handler(event("Create"), { ec2, pollMs: 1 })).rejects.toThrow(/不要重试/);
  });

  it("端点没有 ENI ⇒ 抛(私有托管域会指向空值,回写照样走不通)", async () => {
    const { handler } = await load();
    const ec2 = fakeEc2({ enis: [] });
    await expect(handler(event("Create"), { ec2, pollMs: 1 })).rejects.toThrow(/ENI 私有 IP/);
  });

  it("缺属性 ⇒ 抛(不猜默认值)", async () => {
    const { handler } = await load();
    const ec2 = fakeEc2();
    await expect(handler(event("Create", { LocalVpcCidr: "" }), { ec2, pollMs: 1 })).rejects.toThrow(/LocalVpcCidr/);
  });
});

describe("🔴 子网没有显式关联 ⇒ 回落 VPC 的**主**路由表(漏了 = 回程包无路可走)", () => {
  it("端点子网只有一个且无显式关联 ⇒ 选中主路由表", async () => {
    const { homeRouteTables } = await load();
    const tables = [
      { RouteTableId: "rtb-h1", Associations: [{ SubnetId: "subnet-other" }], Routes: [] },
      { RouteTableId: "rtb-main", Associations: [{ Main: true }], Routes: [] },
    ];
    const ec2 = fakeEc2({ routeTables: tables, endpointSubnets: ["subnet-nolink"] });
    const picked = await homeRouteTables(ec2, EP);
    expect(picked.map((r) => r.RouteTableId)).toEqual(["rtb-main"]);
  });

  it("显式关联优先于主路由表(不能两张都挑)", async () => {
    const { homeRouteTables } = await load();
    const ec2 = fakeEc2({ endpointSubnets: ["subnet-h1"] });
    const picked = await homeRouteTables(ec2, EP);
    expect(picked.map((r) => r.RouteTableId)).toEqual(["rtb-h1"]);
  });
});

describe("🔴 Delete:只删「本网段 + 本 peering」那些路由", () => {
  it("命中的删、别人的留", async () => {
    const { handler } = await load();
    const tables = defaultTables();
    (tables[0] as { Routes: Array<Record<string, unknown>> }).Routes.push({ DestinationCidrBlock: LOCAL, VpcPeeringConnectionId: PCX });
    (tables[1] as { Routes: Array<Record<string, unknown>> }).Routes.push({ DestinationCidrBlock: LOCAL, VpcPeeringConnectionId: "pcx-other" });
    const ec2 = fakeEc2({ routeTables: tables });
    const out = await handler(event("Delete"), { ec2, pollMs: 1 });
    const del = ec2.calls.filter((c) => c.name === "DeleteRouteCommand");
    expect(del.map((c) => c.input.RouteTableId)).toEqual(["rtb-h1"]);
    expect(out.Data.RemovedRoutes).toBe("1");
  });

  it("🔴 读不到东西也不许让删除失败(栈删不掉比留一条 blackhole 更糟)", async () => {
    const { handler } = await load();
    const ec2 = {
      calls: [],
      async send() {
        throw new Error("AccessDenied");
      },
    };
    const out = await handler(event("Delete"), { ec2, pollMs: 1 });
    expect(out.Data.RemovedRoutes).toBe("0");
  });
});
