// @netadvisor/core — 规则目录/提示词渲染所需的核心类型单一来源。
//
// 【core 契约】(照 @genbi/core、@paramadvisor/core)core 内部所有文件引用类型都走 "./types"
// (相对路径,不用 @/ alias),保证 core 能独立编译成 CJS 给容器 agent import 时无 alias 解析问题。
//
// 【模块47 L3】只放 core(rules 目录/renderRulesForPrompt 渲染)真正需要的 4 个类型:
//   RuleDef(规则定义) + ComputeKind/RemediationType/RuleStatus/Target(RuleDef 字段引用)。
// 其余顾问契约(ConnectivityRequest/Recommendation/EnvironmentFacts/Prefill/Ruling…)仍留
// network-advisor/types.ts(不牵连进 core);后者反向 re-export 本文件这些类型,对外 API 逐字不变。
//
// ⚠️ 下列类型定义必须与 network-advisor/types.ts 的原始定义逐字一致(RemediationType/Target 是大
// 联合类型)。原 types.ts 反向 re-export 本文件 → 全平台单一定义,杜绝"两个 Target"漂移。

// 计算侧类型——决定 prefill 形态与 channel 特定规则(如 Glue 的 AZ 必须匹配子网)。
export type ComputeKind =
  | "glue" // Glue Connection / Job:PhysicalConnectionRequirements{SubnetId,SecurityGroupIdList,AvailabilityZone}
  | "dms" // DMS 复制实例:replication subnet group(≥2 AZ) + VPC SGs
  | "flink" // MSAF:VpcConfiguration{SubnetIds[],SecurityGroupIds[]}
  | "zeroetl" // RDS→Redshift Zero-ETL:AWS 托管网络(建议性 + resource policy/binlog 杠杆)
  | "lambda-vpc" // VPC 内 Lambda:subnetIds[]+securityGroupIds[]
  | "emr" // 未来:EMR 集群
  | "generic"; // 兜底:仅给 subnets+SGs+AZs

// 平台支持自动发现/判定网络的 AWS 服务(interface/gateway endpoint 判定用)。
export type AwsServiceName =
  | "s3"
  | "s3tables"
  | "dynamodb"
  | "kinesis"
  | "secretsmanager"
  | "kms"
  | "glue"
  | "sts"
  | "logs"
  | "redshift-data"
  | "athena"
  | "bedrock";

// 计算侧要"到达"的目标。判别联合——target-resolver 据 kind 解析出 VPC/SG/端口/AZ/CIDR。
export type Target =
  | { kind: "datasource"; datasourceId: string; port?: number } // 平台托管数据源(RDS 或外部)
  | { kind: "rds"; instanceId?: string; endpoint?: string; port?: number }
  | { kind: "aurora"; clusterId: string; role?: "writer" | "reader"; port?: number }
  | { kind: "redshift"; flavor: "provisioned" | "serverless"; identifier: string; port?: number }
  | { kind: "aws-service"; service: AwsServiceName } // S3/Kinesis/SecretsManager… endpoint 判定
  | { kind: "msk"; clusterArn: string; auth?: "iam" | "sasl-scram" | "tls" | "plaintext" }
  | { kind: "opensearch"; domainOrEndpoint: string; port?: number }
  | { kind: "host"; host: string; port: number; tls?: boolean } // 自建 EC2 / 本地 / 按 DNS/IP
  | { kind: "external"; host: string; port: number; vendor?: "snowflake" | "bigquery" | "other" };

// L2 裁决状态——渲染进 prompt 也是 Ruling.status。
export type RuleStatus = "PASS" | "FAIL" | "UNKNOWN";

// 补救动作类型——RuleDef.remediationType 引用,也是 Remediation.type / Ruling.remediationType。
export type RemediationType =
  | "create-sg"
  | "add-sg-self-ref" // 计算 SG 自引用(ENI 互通)
  | "add-sg-egress-to-target" // 计算 SG 出站到目标端口
  | "add-source-ingress-from-sg" // 目标 SG 入站放行计算 SG-ID
  | "replace-cidr-rule-with-sgref" // 最小权限:CIDR → SG-ref
  | "create-s3-gateway-endpoint"
  | "create-interface-endpoint"
  | "enable-dns-attributes"
  | "add-route-to-target-cidr"
  | "add-nat-or-endpoint"
  | "pick-subnet-in-target-az" // Glue AZ 匹配
  | "widen-endpoint-policy"
  | "open-nacl"
  | "request-cross-account-access"
  | "set-zeroetl-resource-policy"
  | "enable-binlog"
  | "manual"; // 需用户手动(本地防火墙、跨账号 RT…)

// 单条规则定义——rules.ts 的 RULES 数组元素。
export interface RuleDef {
  id: string;
  title: string;
  // 人类可读的 MUST 规则陈述——渲染进 L3 prompt,也是裁决理由模板。
  statement: string;
  awsCitation: string;
  severity: "hard" | "soft"; // hard=不满足则阻断可达;soft=最佳实践(最小权限等)
  remediationType: RemediationType;
  // 该规则对哪些 computeKind / endpointModel 生效(judge 据此 appliesTo 过滤)。
  appliesToCompute?: ComputeKind[]; // 省略=全部
}
