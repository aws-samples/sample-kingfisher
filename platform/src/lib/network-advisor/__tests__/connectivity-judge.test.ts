import { describe, it, expect } from "vitest";
import { adjudicate, foldVerdict } from "../connectivity-judge";
import type {
  EnvironmentFacts,
  RecommendedPlacement,
  ResolvedTarget,
  SecurityGroupFact,
  SubnetFact,
  VpcFact,
  Ruling,
} from "../types";

// ── 事实构造助手（最小化样板，专注被测规则）──
function sg(groupId: string, opts: Partial<SecurityGroupFact> = {}): SecurityGroupFact {
  return { groupId, vpcId: "vpc-1", name: groupId, ingress: [], egress: [], ...opts };
}
function subnet(id: string, opts: Partial<SubnetFact> = {}): SubnetFact {
  return { subnetId: id, vpcId: "vpc-1", az: "us-east-1a", cidr: "10.0.1.0/24", isPublic: false, routesToIgw: false, routesToNat: false, freeIps: 200, ...opts };
}
function vpc(opts: Partial<VpcFact> = {}): VpcFact {
  return {
    vpcId: "vpc-1", cidr: "10.0.0.0/16", isDefault: false, dnsSupport: true, dnsHostnames: true,
    azs: ["us-east-1a"], natGatewayAzs: [], hasIgw: false,
    subnets: [subnet("subnet-a")], securityGroups: [], endpoints: [], nacls: [], peerings: [], tgwAttachments: [],
    ...opts,
  };
}
function facts(v: VpcFact, targets: ResolvedTarget[], degraded = false): EnvironmentFacts {
  return { region: "us-east-1", vpcs: [v], targets, degraded, missing: [], capturedAt: "2026-06-30T00:00:00Z" };
}
function rdsTarget(opts: Partial<ResolvedTarget> = {}): ResolvedTarget {
  return { target: { kind: "rds", instanceId: "db1" }, vpcId: "vpc-1", port: 3306, azs: ["us-east-1a"], securityGroupIds: ["sg-db"], endpointModel: "in-vpc", discoverable: true, ...opts };
}
const placement = (opts: Partial<RecommendedPlacement> = {}): RecommendedPlacement => ({
  vpcId: "vpc-1", subnetIds: ["subnet-a"], securityGroupIds: ["sg-compute"], availabilityZones: ["us-east-1a"], rationale: "", ...opts,
});
const find = (rulings: Ruling[], id: string) => rulings.find((r) => r.ruleId === id);

describe("L2 连通性裁决 — 场景矩阵", () => {
  it("#1 同 VPC 同 SG（自引用 + 自身放行）→ reachable", () => {
    const computeSg = sg("sg-x", {
      ingress: [{ protocol: "-1", cidrs: [], sgRefs: ["sg-x"], prefixListIds: [] }, { protocol: "tcp", fromPort: 3306, toPort: 3306, cidrs: [], sgRefs: ["sg-x"], prefixListIds: [] }],
    });
    const v = vpc({ securityGroups: [computeSg] });
    const t = rdsTarget({ securityGroupIds: ["sg-x"] });
    const { rulings, verdict } = adjudicate({ facts: facts(v, [t]), computeKind: "flink", placement: placement({ securityGroupIds: ["sg-x"] }) });
    expect(find(rulings, "ROUTE")?.status).toBe("PASS");
    expect(find(rulings, "SOURCE_INGRESS_FROM_SG")?.status).toBe("PASS");
    expect(verdict).toBe("reachable");
  });

  it("#3 缺源 SG 入站 → FAIL → reachable-after-fixes", () => {
    const computeSg = sg("sg-compute", { ingress: [{ protocol: "-1", cidrs: [], sgRefs: ["sg-compute"], prefixListIds: [] }] });
    const dbSg = sg("sg-db", {}); // 无入站规则
    const v = vpc({ securityGroups: [computeSg, dbSg] });
    const { rulings, verdict } = adjudicate({ facts: facts(v, [rdsTarget()]), computeKind: "flink", placement: placement() });
    expect(find(rulings, "SOURCE_INGRESS_FROM_SG")?.status).toBe("FAIL");
    expect(verdict).toBe("reachable-after-fixes");
  });

  it("#4 私有子网无 NAT 无 S3 endpoint + 目标 S3 → GATEWAY_ENDPOINT FAIL", () => {
    const v = vpc({ subnets: [subnet("subnet-a", { routesToNat: false })], endpoints: [] });
    const s3t: ResolvedTarget = { target: { kind: "aws-service", service: "s3" }, port: 443, securityGroupIds: [], endpointModel: "needs-gateway-endpoint", discoverable: true };
    const { rulings, verdict } = adjudicate({ facts: facts(v, [s3t]), computeKind: "glue", placement: placement() });
    expect(find(rulings, "GATEWAY_ENDPOINT")?.status).toBe("FAIL");
    expect(verdict).toBe("reachable-after-fixes");
  });

  it("#4b 有 S3 gateway endpoint → PASS", () => {
    const v = vpc({ endpoints: [{ id: "vpce-1", service: "com.amazonaws.us-east-1.s3", type: "Gateway", subnetIds: [], securityGroupIds: [] }] });
    const s3t: ResolvedTarget = { target: { kind: "aws-service", service: "s3" }, port: 443, securityGroupIds: [], endpointModel: "needs-gateway-endpoint", discoverable: true };
    const { rulings } = adjudicate({ facts: facts(v, [s3t]), computeKind: "glue", placement: placement() });
    expect(find(rulings, "GATEWAY_ENDPOINT")?.status).toBe("PASS");
  });

  it("#6 Glue AZ 不匹配 → AZ_MATCH FAIL", () => {
    const computeSg = sg("sg-compute", { ingress: [{ protocol: "-1", cidrs: [], sgRefs: ["sg-compute"], prefixListIds: [] }] });
    const dbSg = sg("sg-db", { ingress: [{ protocol: "tcp", fromPort: 3306, toPort: 3306, cidrs: [], sgRefs: ["sg-compute"], prefixListIds: [] }] });
    const v = vpc({ subnets: [subnet("subnet-a", { az: "us-east-1b" })], securityGroups: [computeSg, dbSg] });
    const { rulings } = adjudicate({ facts: facts(v, [rdsTarget()]), computeKind: "glue", placement: placement({ availabilityZones: ["us-east-1a"] }) });
    expect(find(rulings, "AZ_MATCH")?.status).toBe("FAIL");
  });

  it("#16 缺 SG 自引用 → SELF_REF FAIL（Glue/Flink）", () => {
    const computeSg = sg("sg-compute", {}); // 无自引用
    const v = vpc({ securityGroups: [computeSg] });
    const { rulings } = adjudicate({ facts: facts(v, [rdsTarget({ securityGroupIds: [] })]), computeKind: "glue", placement: placement() });
    expect(find(rulings, "SELF_REF")?.status).toBe("FAIL");
  });

  it("#15 目标用 CIDR 放行 + leastPrivilege → 连通 PASS 但 LEAST_PRIV FAIL", () => {
    const computeSg = sg("sg-compute", { ingress: [{ protocol: "-1", cidrs: [], sgRefs: ["sg-compute"], prefixListIds: [] }] });
    const dbSg = sg("sg-db", { ingress: [{ protocol: "tcp", fromPort: 3306, toPort: 3306, cidrs: ["10.0.0.0/16"], sgRefs: [], prefixListIds: [] }] });
    const v = vpc({ securityGroups: [computeSg, dbSg] });
    const { rulings } = adjudicate({ facts: facts(v, [rdsTarget()]), computeKind: "flink", placement: placement(), constraints: { leastPrivilege: true } });
    expect(find(rulings, "SOURCE_INGRESS_FROM_SG")?.status).toBe("PASS");
    expect(find(rulings, "LEAST_PRIV")?.status).toBe("FAIL");
  });

  it("#12 目标不可发现 → DISCOVERABILITY FAIL → needs-input", () => {
    const t: ResolvedTarget = { target: { kind: "host", host: "x", port: 5432 }, port: 5432, securityGroupIds: [], endpointModel: "unknown", discoverable: false, notes: ["按 IP"] };
    const { rulings, verdict } = adjudicate({ facts: facts(vpc(), [t]), computeKind: "glue", placement: placement() });
    expect(find(rulings, "DISCOVERABILITY")?.status).toBe("FAIL");
    expect(verdict).toBe("needs-input");
  });

  it("#20 Redshift Serverless 托管 VPC → ROUTE PASS（无需放置）", () => {
    const t: ResolvedTarget = { target: { kind: "redshift", flavor: "serverless", identifier: "wg" }, port: 5439, securityGroupIds: [], endpointModel: "managed-vpc", discoverable: true };
    const { rulings, verdict } = adjudicate({ facts: facts(vpc(), [t]), computeKind: "dms", placement: placement() });
    expect(find(rulings, "ROUTE")?.status).toBe("PASS");
    expect(verdict).toBe("reachable");
  });

  it("#32 跨 region → CROSS_REGION FAIL → unreachable", () => {
    const t: ResolvedTarget = { target: { kind: "rds", instanceId: "db" }, port: 3306, securityGroupIds: [], endpointModel: "cross-region", discoverable: true };
    const { rulings, verdict } = adjudicate({ facts: facts(vpc(), [t]), computeKind: "dms", placement: placement() });
    expect(find(rulings, "CROSS_REGION")?.status).toBe("FAIL");
    expect(verdict).toBe("unreachable");
  });

  it("#7 跨 VPC 无 peering/TGW → ROUTE FAIL", () => {
    const v = vpc({ vpcId: "vpc-1", peerings: [], tgwAttachments: [] });
    const t = rdsTarget({ vpcId: "vpc-2", securityGroupIds: [] });
    const { rulings } = adjudicate({ facts: facts(v, [t]), computeKind: "flink", placement: placement() });
    expect(find(rulings, "ROUTE")?.status).toBe("FAIL");
  });

  it("#7b 跨 VPC 有 peering → ROUTE UNKNOWN（需确认双向路由）", () => {
    const v = vpc({ peerings: [{ peeringId: "pcx-1", peerVpcId: "vpc-2", peerCidr: "10.1.0.0/16" }] });
    const t = rdsTarget({ vpcId: "vpc-2", securityGroupIds: [] });
    const { rulings } = adjudicate({ facts: facts(v, [t]), computeKind: "flink", placement: placement() });
    expect(find(rulings, "ROUTE")?.status).toBe("UNKNOWN");
  });

  it("D1 探测降级 → 相关规则 UNKNOWN，verdict 不谎报 reachable", () => {
    // 目标 SG 未探测到（跨 VPC/IAM 受限），degraded=true。
    const computeSg = sg("sg-compute", { ingress: [{ protocol: "-1", cidrs: [], sgRefs: ["sg-compute"], prefixListIds: [] }] });
    const v = vpc({ securityGroups: [computeSg] });
    const t = rdsTarget({ securityGroupIds: ["sg-db-not-probed"] });
    const { rulings, verdict } = adjudicate({ facts: facts(v, [t], true), computeKind: "flink", placement: placement() });
    expect(find(rulings, "SOURCE_INGRESS_FROM_SG")?.status).toBe("UNKNOWN");
    expect(verdict).not.toBe("reachable");
  });

  it("foldVerdict：全 PASS → reachable；含 hard FAIL → reachable-after-fixes", () => {
    expect(foldVerdict([{ ruleId: "ROUTE", title: "", status: "PASS", detail: "" }])).toBe("reachable");
    expect(foldVerdict([{ ruleId: "SELF_REF", title: "", status: "FAIL", detail: "" }])).toBe("reachable-after-fixes");
    expect(foldVerdict([{ ruleId: "DISCOVERABILITY", title: "", status: "FAIL", detail: "" }])).toBe("needs-input");
    expect(foldVerdict([{ ruleId: "CROSS_REGION", title: "", status: "FAIL", detail: "" }])).toBe("unreachable");
  });
});
