// 🔴🔴 `POST /api/network-advisor/probe` 的 EC2 客户端必须按**请求点名的执行环境所在区**建。
// 只 mock 真外部:注册表(DDB 读侧)、EC2 SDK(记下构造时的 region)。路由 → place → probeEnvironment → lib/aws/clients 唯一工厂真跑。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown> | null>,
  ec2Regions: [] as string[],
  ec2Calls: [] as string[],
}));
vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    getTargetRaw: vi.fn(async (id: string) => h.rows[id] ?? null),
    descriptorViolation: vi.fn(() => null),
  };
});
vi.mock("@aws-sdk/client-ec2", () => {
  const mk = (n: string) => { const C = class { constructor(public input: any) {} }; Object.defineProperty(C, "name", { value: n }); return C; };
  class EC2Client {
    constructor(public config: { region: string }) { h.ec2Regions.push(config.region); }
    async send(cmd: any) {
      const n = cmd.constructor.name as string;
      h.ec2Calls.push(n);
      if (n === "DescribeVpcsCommand") return { Vpcs: [{ VpcId: "vpc-in-that-region", CidrBlock: "10.9.0.0/16", IsDefault: false }] };
      if (n === "DescribeVpcAttributeCommand") return { EnableDnsSupport: { Value: true }, EnableDnsHostnames: { Value: true } };
      return {};
    }
  }
  const names = ["DescribeVpcsCommand","DescribeSubnetsCommand","DescribeSecurityGroupsCommand","DescribeRouteTablesCommand","DescribeNatGatewaysCommand",
    "DescribeVpcEndpointsCommand","DescribeNetworkAclsCommand","DescribeVpcAttributeCommand","DescribeVpcPeeringConnectionsCommand","DescribeTransitGatewayAttachmentsCommand",
    "ModifyVpcAttributeCommand","CreateVpcEndpointCommand"];
  return { EC2Client, ...Object.fromEntries(names.map((n) => [n, mk(n)])) };
});

const descriptor = (targetId: string, region: string, resources: Record<string, unknown> = {}) => ({
  targetId, region, accountId: "000000000000", partition: "aws", status: "active", ready: true, resources,
});
const post = async (body: unknown) => {
  const { POST } = await import("../probe/route");
  const res = await POST(new Request("http://x/api/network-advisor/probe", { method: "POST", body: JSON.stringify(body) }) as never);
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  h.rows = { tgt_home: descriptor("tgt_home", "us-east-1"), tgt_usw2_a: descriptor("tgt_usw2_a", "us-west-2", { vpcId: "vpc-in-that-region" }) };
  h.ec2Regions.length = 0; h.ec2Calls.length = 0;
  process.env.AWS_REGION = "us-east-1";
  delete process.env.BGP_DATAPLANE_CREDS;
  vi.resetModules();
});

describe("POST /api/network-advisor/probe:按落点 region 探测", () => {
  it("🔴 缺 targetId ⇒ 400 PLACE_UNDECIDABLE,一次 EC2 调用都不发(不默认主控区)", async () => {
    const r = await post({ computeKind: "glue", targets: [{ kind: "aws-service", service: "s3" }] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("PLACE_UNDECIDABLE");
    expect(h.ec2Regions).toEqual([]);
  });

  it("🔴 执行环境不存在 ⇒ 409 PLACE_UNAVAILABLE,不回落主控区", async () => {
    const r = await post({ computeKind: "glue", targets: [], targetId: "tgt_ghost" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("PLACE_UNAVAILABLE");
    expect(h.ec2Regions).toEqual([]);
  });

  it("🔴🔴 targetId=tgt_usw2_a ⇒ EC2 客户端建在 **us-west-2**(改动前恒主控区),facts.region 同;客户端带的 region 不算", async () => {
    const r = await post({ computeKind: "glue", targets: [{ kind: "aws-service", service: "s3" }], targetId: "tgt_usw2_a", region: "us-east-1" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.region).toBe("us-west-2");
    expect(h.ec2Regions, "EC2 客户端必须且只按落点 region 建").toEqual(["us-west-2"]);
    expect(h.ec2Calls).toContain("DescribeVpcsCommand");
    expect(r.body.data.vpcs.map((v: { vpcId: string }) => v.vpcId)).toEqual(["vpc-in-that-region"]);
  });

  it("对照:targetId=tgt_home ⇒ 建在主控区 us-east-1(落点是什么就探什么,不是「永远 us-west-2」)", async () => {
    const r = await post({ computeKind: "glue", targets: [], targetId: "tgt_home" });
    expect(r.status).toBe(200);
    expect(r.body.data.region).toBe("us-east-1");
    expect(h.ec2Regions).toEqual(["us-east-1"]);
  });
});
