// L1 环境感知层（确定性，无大模型）。探测真实 AWS 环境 → 结构化 EnvironmentFacts。
//
// 吸收并扩展 app/api/flink/network/route.ts 的 VPC/子网/SG 枚举 + datasource-service.ts 的
// RDS 探测；新增路由表/NAT/VPC endpoint/NACL/DNS 属性/peering/TGW 探测（顾问裁决所需）。
//
// 关键：每个 Describe 独立 try/catch。失败 → degraded=true + missing[] 记原因，相关事实留空，
// 让 L2 把依赖该事实的规则降级为 UNKNOWN，而不是整体崩溃（场景 D1/D6）。

// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { regionalClient } from "@/lib/aws/clients";
import {
  type EC2Client,
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  DescribeRouteTablesCommand,
  DescribeNatGatewaysCommand,
  DescribeVpcEndpointsCommand,
  DescribeNetworkAclsCommand,
  DescribeVpcAttributeCommand,
  DescribeVpcPeeringConnectionsCommand,
  DescribeTransitGatewayAttachmentsCommand,
  type RouteTable,
  type Subnet,
} from "@aws-sdk/client-ec2";
import { cacheKey, getCached, setCached } from "./cache";
import { resolveTargets, targetSignature, type ResolveCtx } from "./target-resolver";
// @kf-batch 50-WP31-place-first-class 序 31 二刀 ⑤:L1 探测的落点决策如实记账(见 probeEnvironment 开头)
import { notePlaceDecision } from "@/lib/place/context";

/** 决策记账里的作者名(观测清单按它归类)。 */
export const NETWORK_ADVISOR_PROBE_VIA = "networkAdvisorProbe";
import type {
  PlacedConnectivityRequest,
  EnvironmentFacts,
  NaclFact,
  SecurityGroupFact,
  SgRule,
  SubnetFact,
  VpcEndpointFact,
  VpcFact,
} from "./types";

// 累积探测过程中的降级信息 + 本次探测的落点(region)与按它建出来的 EC2 客户端。
// @kf-batch 41-B115-netadvisor-place —— 不再有模块级客户端:客户端随请求落点走。
interface ProbeCtx extends ResolveCtx {
  ec2: EC2Client;
}

function note(ctx: ProbeCtx, what: string, err: unknown) {
  ctx.degraded = true;
  const msg = err instanceof Error ? err.message : String(err);
  ctx.missing.push(`${what}: ${msg}`);
}

const nameTag = (tags?: { Key?: string; Value?: string }[]) => (tags || []).find((t) => t.Key === "Name")?.Value || undefined;

function mapSgRules(perms?: any[]): SgRule[] {
  return (perms || []).map((p) => ({
    protocol: p.IpProtocol ?? "-1",
    fromPort: p.FromPort,
    toPort: p.ToPort,
    cidrs: (p.IpRanges || []).map((r: any) => r.CidrIp).filter(Boolean),
    sgRefs: (p.UserIdGroupPairs || []).map((u: any) => u.GroupId).filter(Boolean),
    prefixListIds: (p.PrefixListIds || []).map((x: any) => x.PrefixListId).filter(Boolean),
  }));
}

// 判断某子网经其路由表是否有到 IGW / NAT 的默认路由。
function subnetRouting(subnetId: string, vpcId: string, routeTables: RouteTable[]): { rtId?: string; toIgw: boolean; toNat: boolean } {
  // 显式关联优先；否则用 VPC 主路由表（main=true 且无显式关联覆盖）。
  let rt = routeTables.find((r) => (r.Associations || []).some((a) => a.SubnetId === subnetId));
  if (!rt) rt = routeTables.find((r) => r.VpcId === vpcId && (r.Associations || []).some((a) => a.Main));
  if (!rt) return { toIgw: false, toNat: false };
  const routes = rt.Routes || [];
  const toIgw = routes.some((r) => (r.GatewayId || "").startsWith("igw-") && (r.DestinationCidrBlock === "0.0.0.0/0"));
  const toNat = routes.some((r) => !!r.NatGatewayId);
  return { rtId: rt.RouteTableId, toIgw, toNat };
}

async function probeVpcDetails(vpcId: string, ctx: ProbeCtx): Promise<Partial<VpcFact>> {
  const out: Partial<VpcFact> = {
    dnsSupport: true,
    dnsHostnames: false,
    subnets: [],
    securityGroups: [],
    endpoints: [],
    nacls: [],
    peerings: [],
    tgwAttachments: [],
    natGatewayAzs: [],
    azs: [],
    hasIgw: false,
  };
  const filt = [{ Name: "vpc-id", Values: [vpcId] }];

  // DNS 属性（interface endpoint 私有 DNS 前置）。两个属性各一次调用。
  try {
    const sup = await ctx.ec2.send(new DescribeVpcAttributeCommand({ VpcId: vpcId, Attribute: "enableDnsSupport" }));
    out.dnsSupport = sup.EnableDnsSupport?.Value !== false;
    const host = await ctx.ec2.send(new DescribeVpcAttributeCommand({ VpcId: vpcId, Attribute: "enableDnsHostnames" }));
    out.dnsHostnames = host.EnableDnsHostnames?.Value === true;
  } catch (e) {
    note(ctx, "ec2:DescribeVpcAttribute", e);
  }

  // 路由表（子网 routesToNat/Igw 判定 + IGW 存在性）。
  let routeTables: RouteTable[] = [];
  try {
    const { RouteTables = [] } = await ctx.ec2.send(new DescribeRouteTablesCommand({ Filters: filt }));
    routeTables = RouteTables;
    out.hasIgw = RouteTables.some((r) => (r.Routes || []).some((x) => (x.GatewayId || "").startsWith("igw-")));
  } catch (e) {
    note(ctx, "ec2:DescribeRouteTables", e);
  }

  // 子网（+ 经路由表算 routesToNat/Igw）。
  try {
    const { Subnets = [] } = await ctx.ec2.send(new DescribeSubnetsCommand({ Filters: filt }));
    out.subnets = Subnets.map((s: Subnet): SubnetFact => {
      const r = subnetRouting(s.SubnetId!, vpcId, routeTables);
      return {
        subnetId: s.SubnetId!,
        vpcId: s.VpcId!,
        az: s.AvailabilityZone || "",
        cidr: s.CidrBlock || "",
        isPublic: s.MapPublicIpOnLaunch === true || r.toIgw,
        routesToIgw: r.toIgw,
        routesToNat: r.toNat,
        freeIps: typeof s.AvailableIpAddressCount === "number" ? s.AvailableIpAddressCount : null,
        routeTableId: r.rtId,
        name: nameTag(s.Tags),
      };
    });
    out.azs = Array.from(new Set(out.subnets.map((s) => s.az).filter(Boolean)));
  } catch (e) {
    note(ctx, "ec2:DescribeSubnets", e);
  }

  // NAT 网关（按 AZ；私有子网出网判定）。
  try {
    const { NatGateways = [] } = await ctx.ec2.send(new DescribeNatGatewaysCommand({ Filter: filt }));
    const azById = new Map((out.subnets || []).map((s) => [s.subnetId, s.az]));
    out.natGatewayAzs = Array.from(
      new Set(
        NatGateways.filter((n) => n.State === "available")
          .map((n) => azById.get(n.SubnetId || "") || "")
          .filter(Boolean)
      )
    );
  } catch (e) {
    note(ctx, "ec2:DescribeNatGateways", e);
  }

  // VPC endpoints（S3 gateway / interface endpoint 判定 + 策略限制）。
  try {
    const { VpcEndpoints = [] } = await ctx.ec2.send(new DescribeVpcEndpointsCommand({ Filters: filt }));
    out.endpoints = VpcEndpoints.map((e: any): VpcEndpointFact => {
      let policyRestrictive = false;
      try {
        const doc = e.PolicyDocument ? JSON.parse(e.PolicyDocument) : null;
        // 默认全放行策略含 "*" Principal + "*" Action + 无 Condition；否则视为受限。
        const stmts: any[] = doc?.Statement || [];
        policyRestrictive = stmts.length > 0 && !stmts.some((s) => s.Effect === "Allow" && (s.Action === "*" || (Array.isArray(s.Action) && s.Action.includes("*"))) && !s.Condition);
      } catch { /* 解析失败保守按未限制 */ }
      return {
        id: e.VpcEndpointId,
        service: e.ServiceName || "",
        type: (e.VpcEndpointType as "Gateway" | "Interface") || "Interface",
        subnetIds: e.SubnetIds || [],
        securityGroupIds: (e.Groups || []).map((g: any) => g.GroupId).filter(Boolean),
        privateDnsEnabled: e.PrivateDnsEnabled,
        routeTableIds: e.RouteTableIds || [],
        policyRestrictive,
      };
    });
  } catch (e) {
    note(ctx, "ec2:DescribeVpcEndpoints", e);
  }

  // 安全组（自引用/入站/出站规则）。
  try {
    const { SecurityGroups = [] } = await ctx.ec2.send(new DescribeSecurityGroupsCommand({ Filters: filt }));
    out.securityGroups = SecurityGroups.map((g): SecurityGroupFact => ({
      groupId: g.GroupId!,
      vpcId: g.VpcId!,
      name: g.GroupName,
      ingress: mapSgRules(g.IpPermissions),
      egress: mapSgRules(g.IpPermissionsEgress),
    }));
  } catch (e) {
    note(ctx, "ec2:DescribeSecurityGroups", e);
  }

  // NACL（子网级端口阻断判定）。
  try {
    const { NetworkAcls = [] } = await ctx.ec2.send(new DescribeNetworkAclsCommand({ Filters: filt }));
    out.nacls = NetworkAcls.map((n): NaclFact => ({
      naclId: n.NetworkAclId!,
      subnetIds: (n.Associations || []).map((a) => a.SubnetId!).filter(Boolean),
      entries: (n.Entries || []).map((e) => ({
        egress: e.Egress === true,
        protocol: e.Protocol ?? "-1",
        ruleAction: (e.RuleAction as "allow" | "deny") || "allow",
        fromPort: e.PortRange?.From,
        toPort: e.PortRange?.To,
        cidr: e.CidrBlock,
        ruleNumber: e.RuleNumber ?? 0,
      })),
    }));
  } catch (e) {
    note(ctx, "ec2:DescribeNetworkAcls", e);
  }

  // VPC peering（跨 VPC 路由判定）。
  try {
    const { VpcPeeringConnections = [] } = await ctx.ec2.send(
      new DescribeVpcPeeringConnectionsCommand({
        Filters: [
          { Name: "requester-vpc-info.vpc-id", Values: [vpcId] },
        ],
      })
    );
    out.peerings = VpcPeeringConnections.filter((p) => p.Status?.Code === "active").map((p) => {
      const acc = p.AccepterVpcInfo;
      const req = p.RequesterVpcInfo;
      const peer = req?.VpcId === vpcId ? acc : req;
      return { peeringId: p.VpcPeeringConnectionId!, peerVpcId: peer?.VpcId || "", peerCidr: peer?.CidrBlock };
    });
  } catch (e) {
    note(ctx, "ec2:DescribeVpcPeeringConnections", e);
  }

  // TGW attachment（跨 VPC/本地路由判定）。routedCidrs 需查 TGW 路由表（权限/复杂度高），Phase 1 只记附着存在。
  try {
    const { TransitGatewayAttachments = [] } = await ctx.ec2.send(
      new DescribeTransitGatewayAttachmentsCommand({ Filters: [{ Name: "resource-id", Values: [vpcId] }] })
    );
    out.tgwAttachments = TransitGatewayAttachments.filter((t) => t.State === "available").map((t) => ({
      tgwId: t.TransitGatewayId || "",
      routedCidrs: [], // Phase 1 留空 → 跨 TGW 路由判定为 UNKNOWN（保守，场景 #9）
    }));
  } catch (e) {
    note(ctx, "ec2:DescribeTransitGatewayAttachments", e);
  }

  return out;
}

// 探测入口。scopeVpcId 给定则只探该 VPC（省调用）；否则探全部 VPC。
// @kf-batch 41-B115-netadvisor-place —— 探测在**请求落点的 region**做:EC2 客户端按 req.region 经唯一工厂建(序 31 二刀 ⑤ 曾把
//   模块级主控区客户端如实记成主控区决策,那是「如实记」,不是「修好」;本刀把能力缺口补上)。决策记成该落点本身(观测清单按 via 归类;
//   技能 Lambda 里没有请求上下文时本记账是 no-op)。
export async function probeEnvironment(req: PlacedConnectivityRequest): Promise<EnvironmentFacts> {
  notePlaceDecision({ targetId: req.targetId, via: NETWORK_ADVISOR_PROBE_VIA });
  const region = req.region;
  const ctx: ProbeCtx = { degraded: false, missing: [], region, ec2: await regionalClient("ec2", region) };
  const scopeVpcId = req.constraints?.pinnedVpcId || req.source?.vpcId;
  const sig = targetSignature(req.targets);
  const key = cacheKey(region, scopeVpcId, sig);

  const cached = getCached(key);
  if (cached) return cached;

  // 先解析目标（可能据 RDS 探测确定目标所在 VPC，用于聚焦 VPC 探测范围）。
  const resolved = await resolveTargets(req.targets, ctx);

  // 确定要探测的 VPC 集合：pinned/source 优先；否则目标所在 VPC + 默认 VPC；再否则全部。
  const focusVpcIds = new Set<string>();
  if (scopeVpcId) focusVpcIds.add(scopeVpcId);
  for (const r of resolved) if (r.vpcId) focusVpcIds.add(r.vpcId);
  // 平台自己在该落点的 VPC(描述符给;主控区 = 部署期 DEFAULT_VPC_ID)—— 原来这里用的是主控区的 DEFAULT_VPC_ID,在别的区按它过滤会把该区的 VPC 全筛掉。
  if (req.placeVpcId) focusVpcIds.add(req.placeVpcId);

  let vpcList: { vpcId: string; cidr: string; isDefault: boolean; name?: string }[] = [];
  try {
    const { Vpcs = [] } = await ctx.ec2.send(new DescribeVpcsCommand({}));
    vpcList = Vpcs.map((v) => ({ vpcId: v.VpcId!, cidr: v.CidrBlock || "", isDefault: v.IsDefault === true, name: nameTag(v.Tags) }));
  } catch (e) {
    note(ctx, "ec2:DescribeVpcs", e);
  }

  // 若有聚焦集合，只探这些；否则探全部（但全部时仍逐 VPC 拉详情，量大可由调用方 pin）。
  const toProbe = focusVpcIds.size > 0 ? vpcList.filter((v) => focusVpcIds.has(v.vpcId)) : vpcList;

  const vpcs: VpcFact[] = [];
  for (const v of toProbe) {
    const details = await probeVpcDetails(v.vpcId, ctx);
    vpcs.push({
      vpcId: v.vpcId,
      cidr: v.cidr,
      isDefault: v.isDefault,
      name: v.name,
      dnsSupport: details.dnsSupport ?? true,
      dnsHostnames: details.dnsHostnames ?? false,
      azs: details.azs || [],
      natGatewayAzs: details.natGatewayAzs || [],
      hasIgw: details.hasIgw || false,
      subnets: details.subnets || [],
      securityGroups: details.securityGroups || [],
      endpoints: details.endpoints || [],
      nacls: details.nacls || [],
      peerings: details.peerings || [],
      tgwAttachments: details.tgwAttachments || [],
    });
  }

  const facts: EnvironmentFacts = {
    region,
    source: req.source,
    vpcs,
    targets: resolved,
    degraded: ctx.degraded,
    missing: ctx.missing,
    capturedAt: new Date().toISOString(),
  };

  setCached(key, facts);
  return facts;
}
