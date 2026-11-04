// 网络连通性顾问 技能 Lambda 的【只读】IAM —— 独立 ManagedPolicy。
// 平台标准 docs/design/28-agentcore-standard/DESIGN.md §10:技能 Lambda 探测 IAM 走独立
// ManagedPolicy 挂 Lambda role,不碰平台 TaskRole([[taskrole-inline-policy-10kb-limit]])。
// 顾问【永久只读】([[network-advisor-readonly-only]]):只 Describe/Get,零写网络。
//
// 与 platform-stack.ts:353 的 NetworkAdvisorReadOnly(进程内版挂 TaskRole)不同:那份是【补充】
// 权限(假定 TaskRole 已有基础 ec2:Describe*);Lambda role 从零开始,故此处按 environment-probe.ts
// + target-resolver.ts 实际调用的 API 【列全】。
//
// Phase 2 由 netadvisor-agentcore-stack.ts 调 attachNetAdvisorReadOnlyPolicy(skillFn.role)。

import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
// @kf-batch 52-P52.5a-supply — regionalStatement:资源 ARN 的 region 段唯一出口 + 显式轴声明。
import { requestedRegionCondition, regionalStatement } from "./shared/execution-regions";

// environment-probe.ts 实际调用的 EC2 只读 API(每个 Describe 见该文件对应行)。
const EC2_PROBE_ACTIONS = [
  "ec2:DescribeVpcs",                       // environment-probe.ts:268
  "ec2:DescribeSubnets",                    // :116
  "ec2:DescribeSecurityGroups",             // :180
  "ec2:DescribeRouteTables",                // :107
  "ec2:DescribeNatGateways",                // :139
  "ec2:DescribeVpcEndpoints",               // :154
  "ec2:DescribeNetworkAcls",                // :194
  "ec2:DescribeVpcAttribute",               // :96,98
  "ec2:DescribeVpcPeeringConnections",      // :214
  "ec2:DescribeTransitGatewayAttachments",  // :233
];

// target-resolver.ts 实际调用的目标解析只读 API(RDS/Redshift/Serverless)。
const TARGET_RESOLVE_ACTIONS = [
  "rds:DescribeDBInstances",                // target-resolver.ts:63
  "rds:DescribeDBClusters",                 // :120
  "redshift:DescribeClusters",              // :141
  "redshift-serverless:GetWorkgroup",       // :159
];

// 参数:接收要挂策略的 role(通常是技能 Lambda 的执行 role)+ region(条件限定)+
// datasource 表 ARN(target-resolver.ts:89 GetItem bgp-datasources)。
export interface NetAdvisorReadOnlyProps {
  region: string;
  account: string;
  datasourcesTableName?: string; // 默认 bgp-datasources
}

// 建一个独立 ManagedPolicy 并挂到给定 role。全只读、本区域限定。
export function attachNetAdvisorReadOnlyPolicy(
  scope: Construct,
  id: string,
  role: iam.IRole,
  props: NetAdvisorReadOnlyProps
): iam.ManagedPolicy {
  const table = props.datasourcesTableName || "bgp-datasources";
  return new iam.ManagedPolicy(scope, id, {
    roles: [role],
    statements: [
      // ── L1 环境感知 + 目标解析(EC2/RDS/Redshift,全只读,本区域限定)──
      new iam.PolicyStatement({
        actions: [...EC2_PROBE_ACTIONS, ...TARGET_RESOLVE_ACTIONS],
        resources: ["*"], // Describe* 不支持资源级限定,用 region 条件收窄
        conditions: { StringEquals: { "aws:RequestedRegion": requestedRegionCondition(scope) } },
      }),
      // ── datasource 目标解析:读平台数据源表(target-resolver.ts:89)──
      regionalStatement(scope, {
        axis: "home",
        reason: "控制面单份:数据源注册表只在 home 存一份(50 SPEC §1.1)",
        actions: ["dynamodb:GetItem"],
        resources: (r) => [`arn:aws:dynamodb:${r}:${props.account}:table/${table}`],
      }),
    ],
  });
}
