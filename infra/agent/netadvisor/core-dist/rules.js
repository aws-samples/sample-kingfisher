"use strict";
// @netadvisor/core — L2 规则目录 · 单一事实源(Single Source of Truth)。
//
// 反幻觉核心设计:本文件既被 connectivity-judge.ts(确定性引擎)执行,又被 prompt.ts 渲染进
// 大模型 system prompt。于是"大模型知道的网络规则" === "引擎执行的规则",模型无法编造规则。
//
// 【模块47 L3】规则目录已下沉本 core(供容器 agent import core-dist,消 RULES_TEXT 手抄——
// 此前容器 agent.js 手抄本文件的规则文本,已真实漂移:AZ_MATCH 丢"运行时才失败"对比语义、
// PRIVATE_EGRESS 丢"拉脚本/写结果/暂存"括注)。network-advisor/rules.ts 反向 re-export 本文件,
// 进程内消费方(connectivity-judge/remediation/prompt)路径与用法逐字不变。
//
// 每条规则的 awsCitation 注明来源——内容移植自 AWS 官方 skill(Apache-2.0,见 NOTICE.md):
//   github.com/aws/agent-toolkit-for-aws
//   - plugins/aws-data-analytics/skills/connecting-to-data-source/references/{network-setup,troubleshooting}.md
//   - skills/specialized-skills/networking-and-content-delivery-skills/*
// 命令外壳(AWS CLI/call_aws)弃用,判断逻辑翻译成本平台的 EC2/RDS SDK 探测(见 environment-probe.ts)。
Object.defineProperty(exports, "__esModule", { value: true });
exports.TROUBLESHOOTING_ORDER = exports.RULE_BY_ID = exports.RULES = void 0;
exports.renderRulesForPrompt = renderRulesForPrompt;
exports.ruleApplies = ruleApplies;
// ── 规则定义集(id 与 connectivity-judge.ts 的 evaluator 一一对应)──
exports.RULES = [
    {
        id: "AZ_MATCH",
        title: "Glue 连接的 AZ 必须等于子网 AZ",
        statement: "对 Glue 连接（PhysicalConnectionRequirements），AvailabilityZone 必须与所选 SubnetId 的 AZ 完全一致，否则作业不是建连时失败、而是【运行时】才失败。",
        awsCitation: "connecting-to-data-source/references/network-setup.md；本仓 datasource-service.ts:203-207",
        severity: "hard",
        remediationType: "pick-subnet-in-target-az",
        appliesToCompute: ["glue"],
    },
    {
        id: "PRIVATE_EGRESS",
        title: "私有子网需 NAT 出网或 S3 gateway endpoint",
        statement: "计算 ENI 所在私有子网若要访问 S3（拉脚本/写结果/暂存），必须有 NAT 网关出网，或该 VPC 有 S3 gateway endpoint 且挂在子网路由表上；二者皆无则启动报 UnableToFindVpcEndpoint。优先 S3 gateway endpoint（免费、不出 AWS 骨干网）。",
        awsCitation: "connecting-to-data-source/references/{network-setup,troubleshooting}.md",
        severity: "hard",
        remediationType: "create-s3-gateway-endpoint",
    },
    {
        id: "SELF_REF",
        title: "计算安全组需自引用规则",
        statement: "计算（Glue/Flink 等）的安全组必须有一条自引用（all-traffic，source=自身 SG-ID）入站规则，因为运行时多个 ENI 之间要互相通信——即使单 worker 也需要。",
        awsCitation: "connecting-to-data-source/references/network-setup.md（“Glue ENIs must talk to each other … even single-worker”）",
        severity: "hard",
        remediationType: "add-sg-self-ref",
        appliesToCompute: ["glue", "flink", "emr"],
    },
    {
        id: "EGRESS_TO_TARGET",
        title: "计算安全组需出站到目标端口",
        statement: "计算安全组的出站规则必须允许到目标端口的流量（默认 SG 出站全放行；若被收窄则须显式放行目标端口）。",
        awsCitation: "connecting-to-data-source/references/network-setup.md",
        severity: "hard",
        remediationType: "add-sg-egress-to-target",
    },
    {
        id: "SOURCE_INGRESS_FROM_SG",
        title: "目标安全组需放行来自计算 SG-ID 的入站",
        statement: "目标（源库/数仓/服务）的安全组必须有一条入站规则，在目标端口上放行来自计算安全组【SG-ID】的流量——必须用 SG-ID 引用，不要用 CIDR，因为 ENI 的 IP 会变。",
        awsCitation: "connecting-to-data-source/references/network-setup.md（“use the SG ID, not a CIDR, ENIs change”）",
        severity: "hard",
        remediationType: "add-source-ingress-from-sg",
    },
    {
        id: "ROUTE",
        title: "必须有到目标 VPC CIDR 的路由",
        statement: "计算子网的路由表必须有到达目标 VPC CIDR 的路由：同 VPC 为 local 路由（自动）；跨 VPC 需经 peering（双方路由表都要加）/Transit Gateway（两侧附着都要路由）；本地经 VGW（VPN）或 TGW（Direct Connect）。",
        awsCitation: "connecting-to-data-source/references/network-setup.md（Cross-VPC and On-Prem 段）",
        severity: "hard",
        remediationType: "add-route-to-target-cidr",
    },
    {
        id: "INTERFACE_ENDPOINT",
        title: "非 S3/DynamoDB 的 AWS 服务私有访问需 interface endpoint",
        statement: "私有子网访问 SecretsManager/KMS/Kinesis/Logs 等 AWS 服务（非 S3/DynamoDB），若不走 NAT，则需要该服务的 interface endpoint（PrivateLink），且其安全组放行 :443 来自 VPC CIDR、VPC 开启私有 DNS。",
        awsCitation: "networking-and-content-delivery-skills/configuring-vpc-endpoints-for-private-aws-service-access",
        severity: "hard",
        remediationType: "create-interface-endpoint",
    },
    {
        id: "GATEWAY_ENDPOINT",
        title: "S3/DynamoDB gateway endpoint 须挂在子网路由表",
        statement: "gateway endpoint 仅适用于 S3 和 DynamoDB；它必须关联到计算子网所用的路由表，否则流量不会经 endpoint。",
        awsCitation: "networking-and-content-delivery-skills/configuring-vpc-endpoints-for-private-aws-service-access",
        severity: "hard",
        remediationType: "create-s3-gateway-endpoint",
    },
    {
        id: "DNS_ATTRS",
        title: "interface endpoint 私有 DNS 需 VPC 开启 DNS 属性",
        statement: "要用 interface endpoint 的私有 DNS，VPC 必须同时开启 enableDnsSupport 与 enableDnsHostnames，否则服务域名解析不到私有 IP。",
        awsCitation: "networking-and-content-delivery-skills/configuring-vpc-endpoints-for-private-aws-service-access",
        severity: "hard",
        remediationType: "enable-dns-attributes",
    },
    {
        id: "NACL",
        title: "子网 NACL 需放行目标端口（双向）",
        statement: "计算子网的网络 ACL 必须放行到目标端口的出站与对应的入站返回流量（含临时端口范围）；NACL 是无状态的，需双向规则。",
        awsCitation: "connecting-to-data-source/references/troubleshooting.md（Network 检查第 5 步）",
        severity: "hard",
        remediationType: "open-nacl",
    },
    {
        id: "IP_CAPACITY",
        title: "子网需有足够空闲 IP 供 ENI",
        statement: "计算子网需有足够空闲 IP 地址供运行时 ENI 分配；耗尽则作业无法启动。",
        awsCitation: "MSAF/Glue ENI planning（foundation-operations.md）",
        severity: "hard",
        remediationType: "pick-subnet-in-target-az",
    },
    {
        id: "AZ_COVERAGE",
        title: "放置须覆盖目标所在 AZ（HA 时 ≥2 AZ）",
        statement: "选择的子网应至少覆盖目标存在的一个 AZ；若要求高可用（如 DMS 复制子网组、生产作业），应跨 ≥2 个 AZ。",
        awsCitation: "creating-production-vpc-multi-az；DMS replication subnet group 要求",
        severity: "hard",
        remediationType: "pick-subnet-in-target-az",
    },
    {
        id: "DISCOVERABILITY",
        title: "目标必须可解析才能裁决",
        statement: "若目标无法被平台 API 发现（跨账号资源、Snowflake/BigQuery 等 SaaS、仅给主机名/IP 的自建库），则无法做权威裁决，需向用户索取 VPC/CIDR/SG 等信息。",
        awsCitation: "connecting-to-data-source/references/discovery.md（“Snowflake and BigQuery sources are not discoverable via AWS APIs”，“Never auto-select”）",
        severity: "hard",
        remediationType: "request-cross-account-access",
    },
    {
        id: "ENDPOINT_POLICY",
        title: "endpoint 策略不得拒绝目标资源",
        statement: "若 S3/服务 endpoint 配了自定义策略，必须确认它放行目标资源 ARN，否则即使网络通也会被策略拒绝。",
        awsCitation: "connecting-to-data-source/references/troubleshooting.md（UnableToFindVpcEndpoint / 策略限制）",
        severity: "hard",
        remediationType: "widen-endpoint-policy",
    },
    {
        id: "CROSS_REGION",
        title: "跨 region 无同 VPC 路径",
        statement: "目标在另一个 region 时不存在同 VPC 路径，需跨 region peering / TGW，或走公网 + TLS。",
        awsCitation: "connecting-vpcs-with-peering（同 region 限制）",
        severity: "hard",
        remediationType: "manual",
    },
    {
        id: "ZEROETL_POLICY",
        title: "Zero-ETL 需 Redshift namespace 资源策略授权源 ARN",
        statement: "RDS→Redshift Zero-ETL 集成需要目标 Redshift namespace 的资源策略授权源 RDS 的 ARN（含 aws:SourceArn 条件），否则集成建立失败。",
        awsCitation: "本仓 zeroetl-service.ts:158-177（ensureNamespaceResourcePolicy）",
        severity: "hard",
        remediationType: "set-zeroetl-resource-policy",
        appliesToCompute: ["zeroetl"],
    },
    {
        id: "ZEROETL_BINLOG",
        title: "Zero-ETL 源 RDS 需开启 ROW 格式 binlog",
        statement: "RDS→Redshift Zero-ETL 要求源库 binlog_format=ROW 且 binlog_row_image=full，否则 CDC 无法捕获变更。",
        awsCitation: "RDS Zero-ETL 前置要求",
        severity: "hard",
        remediationType: "enable-binlog",
        appliesToCompute: ["zeroetl"],
    },
    {
        id: "LEAST_PRIV",
        title: "最小权限：优先 SG-ref 与精确端口",
        statement: "在满足连通的前提下，优先用 SG-ID 引用而非 CIDR、放行精确端口而非全开；仅在用户要求最小权限时作为软约束提示。",
        awsCitation: "credential-security.md / 通用最小权限最佳实践",
        severity: "soft",
        remediationType: "replace-cidr-rule-with-sgref",
    },
];
exports.RULE_BY_ID = Object.fromEntries(exports.RULES.map((r) => [r.id, r]));
// 渲染规则集为 L3 system prompt 文本（单一事实源 → 模型与引擎同源）。
function renderRulesForPrompt() {
    const lines = ["以下是网络连通性的权威规则（你只能依据这些规则 + 工具返回的真实事实推理，禁止编造其它规则）："];
    for (const r of exports.RULES) {
        lines.push(`- [${r.id}] ${r.title}（${r.severity === "hard" ? "硬性" : "软性/最佳实践"}）：${r.statement}`);
    }
    return lines.join("\n");
}
// 判断规则是否适用于某 computeKind。
function ruleApplies(rule, compute) {
    return !rule.appliesToCompute || rule.appliesToCompute.includes(compute);
}
// 排障决策树（network → credentials → driver → SSL）——移植自 troubleshooting.md，注入 L3 prompt。
exports.TROUBLESHOOTING_ORDER = `连通性排障顺序（绝大多数失败是网络问题，按此序排查）：
1) 网络：子网路由到目标 VPC CIDR → 安全组（计算出站 + 自引用 + 目标入站放行计算 SG-ID）→ S3/interface endpoint 或 NAT → NACL → 目标库防火墙。
2) 凭证：Secrets Manager 可读、键名匹配、IAM DB Auth。
3) 驱动：JDBC 驱动 JAR / 类名 / 版本。
4) SSL：JDBC_ENFORCE_SSL 一致性、证书信任库。
常见错误→根因：连接超时→路由/SG/NAT 缺失；UnableToFindVpcEndpoint→缺 S3 endpoint；Access denied→凭证；No suitable driver→驱动；SSL handshake→SSL 配置。`;
