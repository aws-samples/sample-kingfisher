// 参数辅助顾问 技能 Lambda 的【只读】IAM —— 独立 ManagedPolicy。
// 平台标准 docs/design/28-agentcore-standard/DESIGN.md §10:技能 Lambda 探测 IAM 走独立
// ManagedPolicy 挂 Lambda role,不碰平台 TaskRole([[taskrole-inline-policy-10kb-limit]])。
// 顾问只读(同 network-advisor-readonly-only 红线):只 Get/Describe 运行历史/配置,零写资源。
//
// 每个 action 对应 history-probe.ts 的实际调用(行号为写作时出处)。

import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { requestedRegionCondition } from "./shared/execution-regions";

// history-probe.ts 实际调用的只读 API。
const HISTORY_PROBE_ACTIONS = [
  "glue:GetJob",                      // history-probe.ts probeGlue:GetJobCommand
  "glue:GetJobRuns",                  // probeGlue:GetJobRunsCommand(近 20 次运行统计)
  "kinesisanalytics:DescribeApplication", // probeFlink:DescribeApplicationCommand(MSAF 用 kinesisanalytics 前缀)
  "dms:DescribeReplicationTasks",     // probeDms:DescribeReplicationTasksCommand
  "dms:DescribeTableStatistics",      // probeDms:DescribeTableStatisticsCommand(表装载统计)
  "dms:DescribeReplicationInstances", // probeDms:DescribeReplicationInstancesCommand(实例规格)
];

export interface ParamAdvisorReadOnlyProps {
  region: string;
}

// 建一个独立 ManagedPolicy 并挂到给定 role。全只读、本区域限定。
export function attachParamAdvisorReadOnlyPolicy(
  scope: Construct,
  id: string,
  role: iam.IRole,
  props: ParamAdvisorReadOnlyProps
): iam.ManagedPolicy {
  return new iam.ManagedPolicy(scope, id, {
    roles: [role],
    statements: [
      new iam.PolicyStatement({
        actions: HISTORY_PROBE_ACTIONS,
        resources: ["*"], // Get/Describe 多不支持资源级限定,用 region 条件收窄
        conditions: { StringEquals: { "aws:RequestedRegion": requestedRegionCondition(scope) } },
      }),
    ],
  });
}
