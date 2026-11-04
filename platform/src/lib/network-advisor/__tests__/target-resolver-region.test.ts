// @kf-batch 41-B115-netadvisor-place
// 🔴 目标解析用到的 RDS / Redshift / Redshift Serverless 客户端都按 ctx.region 建(改动前是三个模块级主控区客户端 ⇒ 别的区的实例永远「未发现」)。
// 只 mock 真外部(三个 SDK 客户端:记构造 region、回最小结果)。
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock 工厂会被提升到文件顶部 ⇒ 造假 SDK 的助手必须也在 hoisted 里
const h = vi.hoisted(() => {
  const regions: string[] = [];
  const mkSdk = (clientName: string, commands: string[], reply: (n: string) => unknown) => () => {
    const mk = (n: string) => { const C = class { constructor(public input: any) {} }; Object.defineProperty(C, "name", { value: n }); return C; };
    const Client = class { constructor(public config: { region: string }) { regions.push(`${clientName}@${config.region}`); } async send(cmd: any) { return reply(cmd.constructor.name); } };
    return { [clientName]: Client, ...Object.fromEntries(commands.map((n) => [n, mk(n)])) };
  };
  return { regions, mkSdk };
});
vi.mock("@aws-sdk/client-rds", h.mkSdk("RDSClient", ["DescribeDBInstancesCommand", "DescribeDBClustersCommand"], (n) =>
  n === "DescribeDBInstancesCommand"
    ? { DBInstances: [{ DBInstanceIdentifier: "db1", Endpoint: { Address: "db1.x", Port: 3306 }, DBSubnetGroup: { VpcId: "vpc-eu", Subnets: [] }, VpcSecurityGroups: [{ VpcSecurityGroupId: "sg-eu" }] }] }
    : { DBClusters: [] }));
vi.mock("@aws-sdk/client-redshift", h.mkSdk("RedshiftClient", ["DescribeClustersCommand"], () => ({ Clusters: [{ VpcId: "vpc-rs", Endpoint: { Port: 5439 }, VpcSecurityGroups: [] }] })));
vi.mock("@aws-sdk/client-redshift-serverless", h.mkSdk("RedshiftServerlessClient", ["GetWorkgroupCommand"], () => ({ workgroup: { endpoint: { port: 5439 } } })));

beforeEach(() => { h.regions.length = 0; delete process.env.BGP_DATAPLANE_CREDS; vi.resetModules(); });

describe("网络顾问 · 目标解析按落点 region 建客户端(B-115)", () => {
  it("rds / redshift(provisioned)/ redshift serverless 三种目标 ⇒ 三个客户端都建在 ctx.region", async () => {
    const { resolveTargets } = await import("@/lib/network-advisor/target-resolver");
    const ctx = { degraded: false, missing: [] as string[], region: "eu-west-1" };
    const out = await resolveTargets([
      { kind: "rds", instanceId: "db1" },
      { kind: "redshift", flavor: "provisioned", identifier: "c1" },
      { kind: "redshift", flavor: "serverless", identifier: "wg1" },
    ], ctx);
    expect(out[0].vpcId).toBe("vpc-eu");
    expect(out[0].securityGroupIds).toEqual(["sg-eu"]);
    expect(out[1].vpcId).toBe("vpc-rs");
    expect(out[2].endpointModel).toBe("managed-vpc");
    expect(h.regions.sort()).toEqual(["RDSClient@eu-west-1", "RedshiftClient@eu-west-1", "RedshiftServerlessClient@eu-west-1"]);
    expect(ctx.degraded).toBe(false);
  });

  it("同一进程里换一个 region ⇒ 另建一套客户端(按区缓存,不串区)", async () => {
    const { resolveTargets } = await import("@/lib/network-advisor/target-resolver");
    await resolveTargets([{ kind: "rds", instanceId: "db1" }], { degraded: false, missing: [], region: "eu-west-1" });
    await resolveTargets([{ kind: "rds", instanceId: "db1" }], { degraded: false, missing: [], region: "ap-southeast-1" });
    await resolveTargets([{ kind: "rds", instanceId: "db1" }], { degraded: false, missing: [], region: "eu-west-1" });
    expect(h.regions).toEqual(["RDSClient@eu-west-1", "RDSClient@ap-southeast-1"]);
  });
});
