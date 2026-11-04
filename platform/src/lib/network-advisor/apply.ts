// 模块:网络顾问 Phase 2 —— 一键修复执行器。
//
// 安全边界(经用户 2026-07-14 明确授权突破"顾问只读"红线,仅限本执行器):
//  1) 仅支持【低风险 + 可逆】子集:开 VPC DNS 属性、建 S3 Gateway Endpoint、建计算 SG、SG 自引用入站。
//     其余(建 NAT / 改路由 / NACL / binlog / 跨账号)一律不自动执行,仅在 UI 展示步骤。
//  2) 只【创建/放行】补网络资源,绝不删除或改动已有网络(create/authorize,不 delete/revoke)。
//  3) 参数由服务端用实时 probe 的 EnvironmentFacts 重解析——不信任客户端传入的 params(防越权/防伪造)。
//  4) 幂等:执行前先查是否已存在(已存在则视为成功,不重复建)。
//  5) 仅平台管理员可调用(在 route 层用 requireAdmin 强制);每次执行走审计。

// 散建客户端收口到唯一工厂(L3)
// 改网络也打在**该落点的 region**(与探测同一份 facts.region),不再有模块级主控区客户端
import { regionalClient } from "@/lib/aws/clients";
import {
  type EC2Client,
  ModifyVpcAttributeCommand,
  CreateVpcEndpointCommand,
  DescribeRouteTablesCommand,
} from "@aws-sdk/client-ec2";
import { probeEnvironment } from "./environment-probe";
import { isAutoApplicable } from "./apply-policy";
import type { PlacedConnectivityRequest, RemediationType, EnvironmentFacts, VpcFact } from "./types";

export { isAutoApplicable } from "./apply-policy";

export interface ApplyInput {
  req: PlacedConnectivityRequest; // 用于服务端重新 probe(拿实时 facts);落点已由路由解析
  type: RemediationType;
  targetIndex?: number; // 该 remediation 关联的目标(用于取目标 VPC)
}

export interface ApplyResult {
  success: boolean;
  applied: boolean; // true=本次真执行了;false=已存在(幂等跳过)或不支持
  action: string;
  detail: string;
  resourceId?: string;
  error?: string;
}

// 选出本次操作的 VPC(fact 对象):优先目标所在 VPC,否则 facts 里第一个 VPC。
function pickVpc(facts: EnvironmentFacts, targetIndex?: number): VpcFact | undefined {
  const t = targetIndex != null ? facts.targets[targetIndex] : undefined;
  const vpcId = t?.vpcId || facts.vpcs[0]?.vpcId;
  return facts.vpcs.find((v) => v.vpcId === vpcId) || facts.vpcs[0];
}

// 开 VPC 的 DNS 支持/主机名(Interface Endpoint 私有 DNS、多数 VPC 访问的前提)。可逆(可关回)。
async function applyEnableDns(ec2: EC2Client, facts: EnvironmentFacts, targetIndex?: number): Promise<ApplyResult> {
  const action = "ec2:ModifyVpcAttribute";
  const vpc = pickVpc(facts, targetIndex);
  if (!vpc) return { success: false, applied: false, action, detail: "未解析到 VPC", error: "no-vpc" };
  if (vpc.dnsSupport && vpc.dnsHostnames) {
    return { success: true, applied: false, action, detail: `VPC ${vpc.vpcId} 的 DNS 支持/主机名已开启,无需修改`, resourceId: vpc.vpcId };
  }
  await ec2.send(new ModifyVpcAttributeCommand({ VpcId: vpc.vpcId, EnableDnsSupport: { Value: true } }));
  await ec2.send(new ModifyVpcAttributeCommand({ VpcId: vpc.vpcId, EnableDnsHostnames: { Value: true } }));
  return { success: true, applied: true, action, detail: `已为 VPC ${vpc.vpcId} 开启 DNS 支持 + DNS 主机名`, resourceId: vpc.vpcId };
}

// 建 S3 Gateway Endpoint(EMR/Glue 私有子网访问 S3 的免 NAT 通路)。幂等:已存在则跳过。可逆(可删)。
async function applyS3GatewayEndpoint(ec2: EC2Client, facts: EnvironmentFacts, targetIndex?: number): Promise<ApplyResult> {
  const action = "ec2:CreateVpcEndpoint";
  const vpc = pickVpc(facts, targetIndex);
  if (!vpc) return { success: false, applied: false, action, detail: "未解析到 VPC", error: "no-vpc" };
  const serviceName = `com.amazonaws.${facts.region}.s3`;

  // 幂等:probe 已探测该 VPC 的 endpoints;若已有 S3 Gateway Endpoint 则跳过(不重复建)。
  const hit = (vpc.endpoints || []).find((e) => e.type === "Gateway" && (e.service === serviceName || e.service.endsWith(".s3")));
  if (hit) {
    return { success: true, applied: false, action, detail: `VPC ${vpc.vpcId} 已存在 S3 Gateway Endpoint`, resourceId: hit.id };
  }

  // 服务端重解析私有子网的路由表(不信客户端占位符)。关联所有私有子网的路由表。
  let routeTableIds: string[] = Array.from(new Set(
    vpc.subnets.filter((s) => !s.isPublic && s.routeTableId).map((s) => s.routeTableId as string)
  ));
  if (routeTableIds.length === 0) {
    // 兜底:取该 VPC 的主路由表。
    const rts = await ec2.send(new DescribeRouteTablesCommand({ Filters: [{ Name: "vpc-id", Values: [vpc.vpcId] }] }));
    routeTableIds = (rts.RouteTables || [])
      .filter((rt) => (rt.Associations || []).some((a) => a.Main))
      .map((rt) => rt.RouteTableId as string)
      .filter(Boolean);
  }
  if (routeTableIds.length === 0) {
    return { success: false, applied: false, action, detail: `VPC ${vpc.vpcId} 未解析到可关联的路由表`, error: "no-route-table" };
  }

  const created = await ec2.send(new CreateVpcEndpointCommand({
    VpcEndpointType: "Gateway",
    VpcId: vpc.vpcId,
    ServiceName: serviceName,
    RouteTableIds: routeTableIds,
  }));
  return {
    success: true, applied: true, action,
    detail: `已为 VPC ${vpc.vpcId} 创建 S3 Gateway Endpoint,关联 ${routeTableIds.length} 个路由表`,
    resourceId: created.VpcEndpoint?.VpcEndpointId,
  };
}

// 入口:据 type 分派到具体执行器。type 不在白名单 → notApplicable(不执行)。
export async function applyRemediation(input: ApplyInput): Promise<ApplyResult> {
  const { req, type, targetIndex } = input;
  if (!isAutoApplicable(type)) {
    return { success: false, applied: false, action: "(手动)", detail: `修复类型 ${type} 不支持一键执行,请按展示步骤手动处理`, error: "not-auto-applicable" };
  }
  // 服务端实时探测,拿权威 facts(不信客户端传入参数)。
  const facts = await probeEnvironment(req);
  const ec2 = await regionalClient("ec2", facts.region);
  try {
    if (type === "enable-dns-attributes") return await applyEnableDns(ec2, facts, targetIndex);
    if (type === "create-s3-gateway-endpoint") return await applyS3GatewayEndpoint(ec2, facts, targetIndex);
    return { success: false, applied: false, action: "(未知)", detail: `未实现的修复类型 ${type}`, error: "unimplemented" };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, applied: false, action: type, detail: `执行失败:${msg}`, error: msg };
  }
}
