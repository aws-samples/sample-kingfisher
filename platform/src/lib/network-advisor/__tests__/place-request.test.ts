// @kf-batch 41-B115-netadvisor-place
// 🔴🔴 网络顾问的落点必须由请求点名、region 必须来自注册表描述符(B-115)。
//
// 【缺陷原形(序 31 二刀 ⑤ 代码盘点 + …9435 observe 未归因榜 11 次)】L1 探测 / 目标解析 / 一键修复的 EC2 / RDS / Redshift 客户端
//   都是模块级 NET_ADVISOR.region(= 主控区);`ConnectivityRequest.region?` 字段存在但探测器根本不看它 ⇒ 数据源或目标在别的区时,
//   顾问拿到的是主控区的 VPC / 子网 / 安全组事实,裁决与建议按错的 VPC 给。
// 【这组判据钉的事实】placeConnectivityRequest 是三条路由共用的唯一落点作者:缺 targetId ⇒ PlaceUndecidable(400,不默认主控区);
//   执行环境不存在 ⇒ PlaceUnavailable(409,不回落);region / placeVpcId 来自描述符,客户端带的同名字段被丢弃。
// 只 mock 真外部(注册表 = DDB 读侧)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const reg = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown> | null>,
}));
vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    getTargetRaw: vi.fn(async (id: string) => reg.rows[id] ?? null),
    descriptorViolation: vi.fn(() => null),
  };
});

const descriptor = (targetId: string, region: string, resources: Record<string, unknown> = {}) => ({
  targetId, region, accountId: "000000000000", partition: "aws", status: "active", ready: true, resources,
});

beforeEach(() => {
  reg.rows = {
    tgt_home: descriptor("tgt_home", "us-east-1"),
    tgt_usw2_a: descriptor("tgt_usw2_a", "us-west-2", { vpcId: "vpc-usw2" }),
  };
  process.env.DEFAULT_VPC_ID = "vpc-home-default";
  vi.resetModules();
});

describe("网络顾问:请求落点(B-115)", () => {
  it("🔴 缺 targetId ⇒ PlaceUndecidable(路由 400),**不**默认主控区", async () => {
    const { placeConnectivityRequest } = await import("@/lib/network-advisor/place");
    const { PlaceUndecidable } = await import("@/lib/place/types");
    await expect(
      placeConnectivityRequest({ computeKind: "glue", targets: [] } as never, "network-advisor/probe")
    ).rejects.toBeInstanceOf(PlaceUndecidable);
  });

  it("🔴 执行环境不存在 ⇒ PlaceUnavailable(路由 409),不回落主控区", async () => {
    const { placeConnectivityRequest } = await import("@/lib/network-advisor/place");
    const { PlaceUnavailable } = await import("@/lib/place/types");
    await expect(
      placeConnectivityRequest({ computeKind: "glue", targets: [], targetId: "tgt_ghost" }, "network-advisor/probe")
    ).rejects.toBeInstanceOf(PlaceUnavailable);
  });

  it("region / placeVpcId 来自**描述符**;客户端带的 region / placeVpcId 一律丢弃", async () => {
    const { placeConnectivityRequest } = await import("@/lib/network-advisor/place");
    const placed = await placeConnectivityRequest(
      { computeKind: "glue", targets: [{ kind: "aws-service", service: "s3" }], targetId: "tgt_usw2_a", region: "us-east-1", placeVpcId: "vpc-forged" } as never,
      "network-advisor/probe"
    );
    expect(placed.region).toBe("us-west-2");
    expect(placed.placeVpcId).toBe("vpc-usw2");
    expect(placed.targetId).toBe("tgt_usw2_a");
    expect(placed.targets).toEqual([{ kind: "aws-service", service: "s3" }]);
  });

  it("主控区描述符没写 vpcId ⇒ placeVpcId 取部署期 DEFAULT_VPC_ID;非主控区没写 ⇒ 不给(不许拿主控区 VPC 去别的区找)", async () => {
    reg.rows.tgt_usw2_a = descriptor("tgt_usw2_a", "us-west-2");
    const { placeConnectivityRequest } = await import("@/lib/network-advisor/place");
    const home = await placeConnectivityRequest({ computeKind: "glue", targets: [], targetId: "tgt_home" }, "x");
    expect(home.region).toBe("us-east-1");
    expect(home.placeVpcId).toBe("vpc-home-default");
    const usw2 = await placeConnectivityRequest({ computeKind: "glue", targets: [], targetId: "tgt_usw2_a" }, "x");
    expect(usw2.placeVpcId).toBeUndefined();
  });
});
