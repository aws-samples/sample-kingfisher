// 网络连通性智能顾问 — 全部公共契约（通道无关入参 → 通道无关出参 + 一块通道特定 prefill）。
//
// 设计目标：这是一个独立、可复用的能力。任何后续模块（DMS/Glue/Flink/Zero-ETL/DataService(已于 2026-09 下线,@kf-batch 50-W5-seg2-WP1)/
// Lambda-vpc/EMR…）都只 import 本文件的类型 + index.ts 的函数，无需理解 VPC 内部细节。
//
// 三层：L1 环境感知(EnvironmentFacts) → L2 连通性裁决(Ruling) → L3 大模型顾问(ConnectivityRecommendation)。

// 【模块47 L3】ComputeKind/Target/RuleStatus/RemediationType/AwsServiceName 已下沉 @netadvisor/core
// (./core/types)——core 须独立编译成 CJS 给容器 import(rules 目录/renderRulesForPrompt 依赖它们)。
// 此处 import 供本文件内部类型引用 + 原样 re-export,消费方(本文件 + rules/prompt/judge/remediation/
// target-resolver…)路径与用法逐字不变,单一定义在 core,杜绝"两个 Target/RemediationType"类型漂移。
import type { ComputeKind, Target, RuleStatus, RemediationType, AwsServiceName } from "./core/types";
export type { ComputeKind, Target, RuleStatus, RemediationType, AwsServiceName };

// 用户可表达的约束（多轮对话里逐步加："最小权限"/"免NAT成本"…）。写相关默认 false——Phase 1 只读。
export interface Constraints {
  preferPrivate?: boolean; // 优先私有子网
  avoidNatCost?: boolean; // 免 NAT 成本（优先 S3 gateway / interface endpoint）
  leastPrivilege?: boolean; // 最小权限（CIDR 规则 → SG-ref，收窄端口）
  requireHA?: boolean; // 高可用（≥2 AZ）
  allowCreateSg?: boolean; // 允许建 SG（默认 true，无破坏性）
  allowModifySg?: boolean; // 允许改 SG 规则（默认 false → Phase 2 授权门禁）
  allowCreateEndpoint?: boolean; // 允许建 VPC endpoint（默认 false → Phase 2）
  pinnedVpcId?: string; // 用户钉死的 VPC
  pinnedSubnetIds?: string[];
  pinnedSecurityGroupIds?: string[];
  budgetUsd?: number; // Reachability Analyzer 升级的硬预算上限（Phase 2）
}

// 已预置的 ENI 宿主（如已建的 DMS 复制实例、Flink 应用）——复用其 VPC/SG，避免重复建。
export interface SourcePlacement {
  vpcId?: string;
  subnetIds?: string[];
  securityGroupIds?: string[];
  existingSecurityGroupIds?: string[]; // 已存在、可复用的 SG（如 bgp-dms SG）
}

// 顾问入口请求——消费方填这个。
// @kf-batch 41-B115-netadvisor-place —— 🔴 落点必须点名:`targetId` = 在哪个执行环境分析网络(纪律 1:缺 ⇒ 400,不默认主控区)。
//   region **不是入参**:由服务端按 targetId 从注册表描述符解析后写进 PlacedConnectivityRequest(客户端给的值不认)。
//   【缺陷原形 B-115】原来这里有 `region?: string // 默认 NET_ADVISOR.region`,而探测器根本不看它 —— L1 的 EC2 / RDS / Redshift
//   客户端都是模块级主控区客户端;数据源或目标在别的区时,顾问拿到的是主控区的 VPC / 子网 / 安全组事实,裁决与建议按错的 VPC 给。
export interface ConnectivityRequest {
  computeKind: ComputeKind;
  targets: Target[]; // 一个任务常需多目标（RDS 源 + S3 + Secrets）
  source?: SourcePlacement;
  constraints?: Constraints;
  /** 落点:计算要跑在 / 目标所在的执行环境 id(`tgt_home` / `tgt_<slug>`)。 */
  targetId: string;
  conversationId?: string; // 多轮记忆键（消费方生成；省略则单轮）
  userMessage?: string; // 自由文本轮次（"最小权限"/"免NAT"…）
  hints?: { sourceCidr?: string; preferredAz?: string };
}

/**
 * **已落点**的请求:lib 层(L1 探测 / 目标解析 / 一键修复 / 技能 Lambda / 长操作执行体)只收这个 ——
 * 没有 region 的请求在类型上就进不来(「拿主控区客户端去探别的区」在编译期就写不出来)。
 * 唯一作者 `place.ts#placeConnectivityRequest`(路由层调;region / placeVpcId 都来自描述符,不来自 env / 客户端)。
 */
export interface PlacedConnectivityRequest extends ConnectivityRequest {
  /** 该落点的 region。 */
  region: string;
  /** 该落点的平台 VPC(描述符 `resources.vpcId`;主控区取部署期 DEFAULT_VPC_ID)。没有别的线索时聚焦它 —— **不**拿主控区的 VPC id 去别的区找。 */
  placeVpcId?: string;
}

// ───────────────────────── L1 事实：确定性探测产物 ─────────────────────────

export interface SgRule {
  protocol: string; // "tcp" | "-1"(all) | …
  fromPort?: number;
  toPort?: number;
  cidrs: string[]; // IpRanges
  sgRefs: string[]; // UserIdGroupPairs（SG-ID 引用，最小权限优选）
  prefixListIds: string[];
}

export interface SecurityGroupFact {
  groupId: string;
  vpcId: string;
  name?: string;
  ingress: SgRule[];
  egress: SgRule[];
}

export interface SubnetFact {
  subnetId: string;
  vpcId: string;
  az: string;
  cidr: string;
  isPublic: boolean; // MapPublicIpOnLaunch 或路由到 IGW
  routesToIgw: boolean;
  routesToNat: boolean;
  freeIps: number | null; // AvailableIpAddressCount（null=未知）
  routeTableId?: string;
  name?: string;
}

export interface VpcEndpointFact {
  id: string;
  service: string; // 完整 service name，如 com.amazonaws.us-east-1.s3
  type: "Gateway" | "Interface";
  subnetIds: string[];
  securityGroupIds: string[];
  privateDnsEnabled?: boolean;
  routeTableIds?: string[];
  policyRestrictive?: boolean; // 策略文档非默认全放行
}

export interface NaclFact {
  naclId: string;
  subnetIds: string[];
  // 简化：只抽与判定相关的 allow/deny 端口规则。
  entries: { egress: boolean; protocol: string; ruleAction: "allow" | "deny"; fromPort?: number; toPort?: number; cidr?: string; ruleNumber: number }[];
}

export interface VpcFact {
  vpcId: string;
  cidr: string;
  isDefault: boolean;
  name?: string;
  dnsSupport: boolean; // enableDnsSupport
  dnsHostnames: boolean; // enableDnsHostnames
  azs: string[]; // 该 VPC 有子网的 AZ 列表
  natGatewayAzs: string[]; // 有 NAT 网关的 AZ
  hasIgw: boolean;
  subnets: SubnetFact[];
  securityGroups: SecurityGroupFact[];
  endpoints: VpcEndpointFact[];
  nacls: NaclFact[];
  peerings: { peeringId: string; peerVpcId: string; peerCidr?: string }[];
  tgwAttachments: { tgwId: string; routedCidrs: string[] }[];
}

// 目标解析结果——把抽象 Target 落成可裁决的具体网络坐标。
export type EndpointModel =
  | "in-vpc" // 目标有 ENI 在某 VPC（RDS/自建 EC2/in-VPC OpenSearch…）——走子网/SG/路由
  | "managed-public" // 托管且公网端点（公网 RDS / 默认 Snowflake）
  | "managed-vpc" // 托管 VPC 但不暴露 ENI 放置（Redshift Serverless / Zero-ETL）
  | "needs-gateway-endpoint" // S3/DynamoDB——私有访问需 gateway endpoint
  | "needs-interface-endpoint" // 其余 AWS 服务——需 interface endpoint
  | "cross-account"
  | "cross-region"
  | "internet" // 外部 SaaS，需出网
  | "unknown";

export interface ResolvedTarget {
  target: Target;
  vpcId?: string;
  cidr?: string; // 目标所在 VPC CIDR（路由判定用）
  port: number;
  azs?: string[];
  securityGroupIds: string[]; // 目标侧 SG（判源入站用）
  endpointModel: EndpointModel;
  discoverable: boolean; // 能否被平台 API 发现（跨账号/SaaS=false → 问用户）
  notes?: string[];
}

// L1 总产物。degraded/missing 支撑优雅降级（IAM 拒/限流时不崩，相关规则降级为 UNKNOWN）。
export interface EnvironmentFacts {
  region: string;
  source?: SourcePlacement;
  vpcs: VpcFact[];
  targets: ResolvedTarget[];
  degraded: boolean; // 任一探测失败 → true
  missing: string[]; // 失败原因（如 "ec2:DescribeRouteTables denied"）
  capturedAt: string; // ISO；Phase 2 apply 前查陈旧
}

// ───────────────────────── L2 裁决：确定性规则结论 ─────────────────────────
// RuleStatus 已下沉 @netadvisor/core(见文件顶部 re-export)——PASS | FAIL | UNKNOWN。

export interface Ruling {
  ruleId: string;
  title: string;
  status: RuleStatus;
  detail: string;
  forTargetIndex?: number; // 针对哪个目标
  remediationType?: RemediationType; // FAIL 时建议的补救类型
  authoritative?: boolean; // true=VPC Reachability Analyzer 背书（Phase 2）
}

// ───────────────────────── 出参：结构化建议（供 UI 一键预填） ─────────────────────────

export type Verdict =
  | "reachable" // 当前配置即可达
  | "reachable-after-fixes" // 做完 remediation 即可达
  | "unreachable" // 无可行补救（如跨 region 无路径）
  | "needs-input" // 缺信息（目标不可发现/空环境）
  | "unknown"; // 探测降级或裁决不确定

// RemediationType 已下沉 @netadvisor/core(见文件顶部 re-export)——rules.ts 的 RuleDef.remediationType
// 与本文件 Remediation.type / Ruling.remediationType 共用同一定义(单一事实源,杜绝漂移)。

// 补救动作的 API 预览——Phase 2 apply 前展示给用户。
export interface ApiPreview {
  action: string; // 如 "ec2:AuthorizeSecurityGroupIngress"
  params: Record<string, unknown>;
  reversible: boolean;
}

export interface Remediation {
  id: string;
  type: RemediationType;
  title: string;
  why: string;
  apiPreview?: ApiPreview;
  autoApplicable: boolean; // Phase 1 一律 false（只读）；Phase 2 部分 true
  risk: "low" | "medium" | "high";
  forTargetIndex?: number;
}

export interface RecommendedPlacement {
  vpcId: string;
  subnetIds: string[];
  securityGroupIds: string[];
  availabilityZones: string[];
  rationale: string;
}

// 通道特定预填——消费方按 channel 取用，一键填进自己的表单。
export type Prefill =
  | { channel: "glue"; subnetId: string; securityGroupIdList: string[]; availabilityZone: string }
  | { channel: "flink"; vpcConfiguration: { SubnetIds: string[]; SecurityGroupIds: string[] } }
  | { channel: "dms"; replicationSubnetGroupSubnetIds: string[]; vpcSecurityGroupIds: string[] }
  | { channel: "zeroetl"; note: string }
  | { channel: "lambda-vpc"; subnetIds: string[]; securityGroupIds: string[] }
  | { channel: "generic"; vpcId: string; subnetIds: string[]; securityGroupIds: string[]; availabilityZones: string[] };

// 顾问最终产物——消费方消费这个。
export interface ConnectivityRecommendation {
  verdict: Verdict;
  recommendedPlacement?: RecommendedPlacement; // needs-input/unreachable 时可省
  reasoning: string; // 人话解释（大模型生成；降级时为确定性文本）
  facts: EnvironmentFacts;
  rulings: Ruling[];
  remediations: Remediation[];
  prefill?: Prefill; // 一键预填（有 placement 时）
  questions?: string[]; // needs-input 时要问用户的
  confidence: number; // 0..1（Reachability 背书时更高）
  candidates?: { placement: RecommendedPlacement; score: number; reason: string }[]; // 多候选排序
  usage?: { inputTokens: number; outputTokens: number };
  llmAvailable?: boolean; // false=大模型降级，结果为确定性兜底（D3）
}
