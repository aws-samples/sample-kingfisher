// AgentCore 协议层共享装配基类。
//
// 三个 AI 能力(GenBI / netadvisor / paramadvisor)的 AgentCore 栈,协议层(Gateway/GatewayTarget/
// Runtime 门控/托管 Memory + Memory 角色 + Outputs)【逐字节同构】,此前是三份 copy-paste(754 行)。
// 本基类收敛协议层,各栈只声明业务差异(命名/工具 schema/env/Description)。
//
// 🔑 零资源重建保证:所有资源以【栈本身】作 scope、id 字符串由调用方【原样传入】,故 CloudFormation
//    逻辑 ID 与抽取前逐字节一致。已用 cdk synth diff 实测证明(逻辑 ID 全等,模板 0 差异)。接入后
//    须再 synth-diff 复验 0 变化方可部署——这是本重构"零回归"的机器证明,比无头验证更硬。
//
// 不收敛的部分(各栈自建,业务差异):ECR repo / 技能 Lambda(打包策略 asset vs esbuild 不同) /
// Gateway 角色 / Runtime 角色 / Lambda 只读权限。这些在各栈 constructor 里,基类只管协议层装配。
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ecr from "aws-cdk-lib/aws-ecr";

/** 逻辑 ID(CfnResource/Role 的 construct id)—— 必须传抽取前的原值,保证逻辑 ID 不变。 */
export interface AgentCoreResourceIds {
  gateway: string; target: string; runtime: string; memory: string; memoryRole: string;
}

export interface AgentCoreResourceProps {
  stack: cdk.Stack;
  ids: AgentCoreResourceIds;
  /** 业务侧已建好的资源(ECR/技能 Lambda ARN/两角色 ARN)。 */
  repo: ecr.Repository;
  skillFnArn: string;
  gatewayRoleArn: string;
  runtimeRoleArn: string;
  modelId: string;
  /** capabilityId 派生 AgentRuntimeName(bgp_<id>_agent)/Memory Name(bgp_<id>_memory)/namespace(/<id>/{actorId})。 */
  capabilityId: string;
  // Gateway 业务文案
  gatewayName: string;
  gatewayInstructions: string;
  gatewayDescription: string;
  // GatewayTarget 业务文案 + 工具 schema(纯业务差异)
  targetName: string;
  targetDescription: string;
  tools: any[];
  // Runtime 门控 + env + 文案
  runtimeCtxKey: string;   // 如 "paramadvisor-runtime"
  tagCtxKey: string;       // 如 "paramadvisor-agent-tag"
  runtimeEnv: Record<string, string>; // GATEWAY_URL/BEDROCK_MODEL_ID 之外的额外 env
  runtimeDescription: string;
  // Memory 业务文案(各栈原文,消除抽取前后差异 → synth-diff 0)
  memoryDescription: string;
  memoryStrategyName: string;
  // Output 前缀,如 "ParamAdvisor"
  outputPrefix: string;
}

/**
 * 装配 Gateway → GatewayTarget → Runtime(门控) → Memory(+角色) + 5 个 CfnOutput。
 * scope=stack、id 原样传入 → 逻辑 ID 与抽取前逐字节一致。
 */
export function buildAgentCoreResources(p: AgentCoreResourceProps): void {
  const s = p.stack;

  // ── Gateway(MCP,入站 AWS_IAM:调用方用 SigV4,免 OAuth)──
  const gateway = new cdk.CfnResource(s, p.ids.gateway, {
    type: "AWS::BedrockAgentCore::Gateway",
    properties: {
      Name: p.gatewayName,
      RoleArn: p.gatewayRoleArn,
      AuthorizerType: "AWS_IAM",
      ProtocolType: "MCP",
      ProtocolConfiguration: { Mcp: { SupportedVersions: ["2025-03-26"], Instructions: p.gatewayInstructions } },
      Description: p.gatewayDescription,
    },
  });
  const gatewayId = gateway.getAtt("GatewayIdentifier").toString();
  const gatewayUrl = gateway.getAtt("GatewayUrl").toString();

  // ── GatewayTarget(一个 Lambda 后端,内联工具 schema)──
  const target = new cdk.CfnResource(s, p.ids.target, {
    type: "AWS::BedrockAgentCore::GatewayTarget",
    properties: {
      GatewayIdentifier: gatewayId,
      Name: p.targetName,
      Description: p.targetDescription,
      CredentialProviderConfigurations: [{ CredentialProviderType: "GATEWAY_IAM_ROLE" }],
      TargetConfiguration: { Mcp: { Lambda: { LambdaArn: p.skillFnArn, ToolSchema: { InlinePayload: p.tools } } } },
    },
  });
  target.addDependency(gateway);

  // ── Runtime(门控:镜像须先推到 ECR)──
  const withRuntime = !!s.node.tryGetContext(p.runtimeCtxKey);
  const imageTag = (s.node.tryGetContext(p.tagCtxKey) as string) || "latest";
  if (withRuntime) {
    const runtime = new cdk.CfnResource(s, p.ids.runtime, {
      type: "AWS::BedrockAgentCore::Runtime",
      properties: {
        AgentRuntimeName: `bgp_${p.capabilityId}_agent`,
        AgentRuntimeArtifact: { ContainerConfiguration: { ContainerUri: `${p.repo.repositoryUri}:${imageTag}` } },
        RoleArn: p.runtimeRoleArn,
        NetworkConfiguration: { NetworkMode: "PUBLIC" },
        ProtocolConfiguration: "HTTP",
        EnvironmentVariables: { GATEWAY_URL: gatewayUrl, BEDROCK_MODEL_ID: p.modelId, ...p.runtimeEnv },
        Description: p.runtimeDescription,
      },
    });
    runtime.addDependency(target);
    new cdk.CfnOutput(s, `${p.outputPrefix}RuntimeArn`, { value: runtime.getAtt("AgentRuntimeArn").toString() });
  }

  // ── AgentCore 托管 Memory(短期会话事件 + 语义长期记忆)+ Memory 执行角色 ──
  const memoryRole = new iam.Role(s, p.ids.memoryRole, {
    roleName: `bgp-${p.capabilityId}-memory-role`,
    assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
  });
  memoryRole.addToPolicy(new iam.PolicyStatement({
    actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
    resources: ["*"],
  }));
  const memory = new cdk.CfnResource(s, p.ids.memory, {
    type: "AWS::BedrockAgentCore::Memory",
    properties: {
      Name: `bgp_${p.capabilityId}_memory`,
      Description: p.memoryDescription,
      EventExpiryDuration: 90,
      MemoryExecutionRoleArn: memoryRole.roleArn,
      MemoryStrategies: [{ SemanticMemoryStrategy: { Name: p.memoryStrategyName, Namespaces: [`/${p.capabilityId}/{actorId}`] } }],
    },
  });
  new cdk.CfnOutput(s, `${p.outputPrefix}MemoryId`, { value: memory.getAtt("MemoryId").toString() });
  new cdk.CfnOutput(s, `${p.outputPrefix}MemoryArn`, { value: memory.getAtt("MemoryArn").toString() });
  new cdk.CfnOutput(s, `${p.outputPrefix}EcrRepoUri`, { value: p.repo.repositoryUri });
  new cdk.CfnOutput(s, `${p.outputPrefix}GatewayUrl`, { value: gatewayUrl });
  new cdk.CfnOutput(s, `${p.outputPrefix}GatewayId`, { value: gatewayId });
}
