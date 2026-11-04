// 把 FAIL/UNKNOWN 的裁决翻译成可执行补救动作（每条带 API 预览）。
//
// Phase 1：只生成、不执行（autoApplicable 一律 false，UI 仅展示"要做什么"）。
// Phase 2(2026-07-14 用户授权)：低风险可逆子集 autoApplicable=true,UI 挂"授权执行"按钮,
//   经 /api/network-advisor/apply 执行(见 apply.ts AUTO_APPLICABLE 白名单)。

import { RULE_BY_ID } from "./rules";
import { isAutoApplicable } from "./apply-policy";
import type {
  ApiPreview,
  ConnectivityRequest,
  EnvironmentFacts,
  Remediation,
  RemediationType,
  Ruling,
} from "./types";

let seq = 0;
function rid(type: string): string {
  seq = (seq + 1) % 100000;
  return `rem-${type}-${seq}`;
}

// 各补救类型的风险与可逆性元数据。
const META: Record<RemediationType, { risk: Remediation["risk"]; reversible: boolean; action: string }> = {
  "create-sg": { risk: "low", reversible: true, action: "ec2:CreateSecurityGroup" },
  "add-sg-self-ref": { risk: "low", reversible: true, action: "ec2:AuthorizeSecurityGroupIngress" },
  "add-sg-egress-to-target": { risk: "low", reversible: true, action: "ec2:AuthorizeSecurityGroupEgress" },
  "add-source-ingress-from-sg": { risk: "medium", reversible: true, action: "ec2:AuthorizeSecurityGroupIngress" },
  "replace-cidr-rule-with-sgref": { risk: "medium", reversible: true, action: "ec2:RevokeSecurityGroupIngress+Authorize" },
  "create-s3-gateway-endpoint": { risk: "low", reversible: true, action: "ec2:CreateVpcEndpoint" },
  "create-interface-endpoint": { risk: "medium", reversible: true, action: "ec2:CreateVpcEndpoint" },
  "enable-dns-attributes": { risk: "medium", reversible: true, action: "ec2:ModifyVpcAttribute" },
  "add-route-to-target-cidr": { risk: "high", reversible: true, action: "ec2:CreateRoute" },
  "add-nat-or-endpoint": { risk: "high", reversible: false, action: "ec2:CreateNatGateway / CreateVpcEndpoint" },
  "pick-subnet-in-target-az": { risk: "low", reversible: true, action: "(选择不同子网，无需 AWS 写操作)" },
  "widen-endpoint-policy": { risk: "high", reversible: true, action: "ec2:ModifyVpcEndpoint" },
  "open-nacl": { risk: "high", reversible: true, action: "ec2:CreateNetworkAclEntry" },
  "request-cross-account-access": { risk: "medium", reversible: true, action: "(需对端账号操作，无法自动执行)" },
  "set-zeroetl-resource-policy": { risk: "medium", reversible: true, action: "redshift:PutResourcePolicy" },
  "enable-binlog": { risk: "high", reversible: true, action: "rds:ModifyDBParameterGroup" },
  manual: { risk: "medium", reversible: true, action: "(手动)" },
};

// 标题/原因文案（按补救类型）。
function describe(type: RemediationType, ruling: Ruling): { title: string; why: string } {
  const base = RULE_BY_ID[ruling.ruleId];
  const why = `规则 [${ruling.ruleId}] ${ruling.status}：${ruling.detail}${base ? `（依据：${base.awsCitation}）` : ""}`;
  const titles: Record<RemediationType, string> = {
    "create-sg": "为计算侧创建专用安全组",
    "add-sg-self-ref": "给计算安全组加自引用入站规则（ENI 互通）",
    "add-sg-egress-to-target": "给计算安全组加到目标端口的出站规则",
    "add-source-ingress-from-sg": "在目标安全组放行来自计算安全组 SG-ID 的入站",
    "replace-cidr-rule-with-sgref": "把目标入站的 CIDR 规则收窄为引用计算 SG-ID（最小权限）",
    "create-s3-gateway-endpoint": "创建 S3 gateway endpoint（免费，私有访问 S3）",
    "create-interface-endpoint": "创建该服务的 interface endpoint（PrivateLink）",
    "enable-dns-attributes": "为 VPC 开启 DNS 解析/主机名（interface endpoint 私有 DNS 所需）",
    "add-route-to-target-cidr": "在路由表中添加到目标 VPC CIDR 的路由",
    "add-nat-or-endpoint": "为私有子网提供出网（NAT 网关或 VPC endpoint）",
    "pick-subnet-in-target-az": "改选与目标/连接 AZ 一致的子网",
    "widen-endpoint-policy": "放宽 VPC endpoint 策略以放行目标资源",
    "open-nacl": "在子网 NACL 放行目标端口（双向）",
    "request-cross-account-access": "申请跨账号访问（peering/PrivateLink + 对端放行）",
    "set-zeroetl-resource-policy": "为 Redshift namespace 设置资源策略授权源 ARN",
    "enable-binlog": "在源 RDS 参数组开启 ROW 格式 binlog",
    manual: "需手动处理",
  };
  return { title: titles[type], why };
}

// 据 ruling 构造 apiPreview 的参数（尽力填具体值，缺则留占位）。
function buildPreview(type: RemediationType, ruling: Ruling, facts: EnvironmentFacts | null, req: ConnectivityRequest): ApiPreview | undefined {
  const meta = META[type];
  const target = ruling.forTargetIndex != null ? facts?.targets[ruling.forTargetIndex] : undefined;
  const vpcId = facts?.vpcs[0]?.vpcId;
  const params: Record<string, unknown> = {};
  switch (type) {
    case "add-source-ingress-from-sg":
      params.targetSecurityGroupIds = target?.securityGroupIds;
      params.port = target?.port;
      params.fromComputeSecurityGroupId = "<计算 SG-ID（授权时填入）>";
      break;
    case "add-sg-self-ref":
      params.computeSecurityGroupId = "<计算 SG-ID>";
      params.rule = "all-traffic, source=self";
      break;
    case "create-s3-gateway-endpoint":
      params.vpcId = target?.vpcId || vpcId;
      params.serviceName = `com.amazonaws.${facts?.region}.s3`;
      params.routeTableIds = "<私有子网路由表>";
      break;
    case "create-interface-endpoint":
      params.vpcId = target?.vpcId || vpcId;
      params.service = target?.target.kind === "aws-service" ? (target.target as any).service : "<service>";
      params.privateDnsEnabled = true;
      params.securityGroupRule = ":443 from VPC CIDR";
      break;
    case "enable-dns-attributes":
      params.vpcId = vpcId;
      params.enableDnsSupport = true;
      params.enableDnsHostnames = true;
      break;
    case "set-zeroetl-resource-policy":
      params.namespace = "<目标 Redshift namespace>";
      params.sourceArn = "<源 RDS ARN>";
      break;
    default:
      break;
  }
  return { action: meta.action, params, reversible: meta.reversible };
}

export function buildRemediations(rulings: Ruling[], facts: EnvironmentFacts | null, req: ConnectivityRequest): Remediation[] {
  const out: Remediation[] = [];
  const seen = new Set<string>();
  for (const r of rulings) {
    if (r.status === "PASS") continue;
    const type = (r.remediationType || RULE_BY_ID[r.ruleId]?.remediationType || "manual") as RemediationType;
    // 去重：同类型 + 同目标只给一条。
    const key = `${type}:${r.forTargetIndex ?? "-"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const meta = META[type];
    const { title, why } = describe(type, r);
    out.push({
      id: rid(type),
      type,
      title,
      why,
      apiPreview: buildPreview(type, r, facts, req),
      autoApplicable: isAutoApplicable(type), // Phase 2:低风险可逆子集可一键执行(其余仍只读展示步骤)
      risk: meta.risk,
      forTargetIndex: r.forTargetIndex,
    });
  }
  return out;
}
