// 模块 28 — 网络连通性顾问 on AgentCore 基建栈（平台标准首个样板）。
// 平台标准见 docs/design/28-agentcore-standard/DESIGN.md。照抄 agentcore-stack.ts(GenBI 先驱实现)，
// 只改「业务层」：资源命名 bgp-netadvisor-* / 工具定义(2 个) / Lambda 打包方式 / Lambda 只读 IAM。
// 协议层(Gateway AWS_IAM 入站 + GatewayTarget + Runtime 门控 + 托管 Memory + 三角色)100% 复用。
//
// ── 与 GenBI 蓝本的唯一结构差异：技能 Lambda 打包 ──
// GenBI 用手写 JS + Code.fromAsset(infra/lambda/genbi-skills)。本栈按标准打包策略走【esbuild 单源】：
// NodejsFunction entry 指向 platform/src/lib/network-advisor/skills-handler.ts —— 与进程内实现【同一份
// 源码】(零漂移)。8 个确定性模块不复制不改动。projectRoot 设为 platform(因源码/tsconfig/lock 都在那)，
// tsconfig 指向 platform/tsconfig.json 以解析 `@/` 别名(target-resolver.ts→@/lib/aws/dynamodb)。
// node20 运行时 esbuild 自动 external `@aws-sdk/*`(运行时自带 v3)。
//
// 部署顺序(解决"镜像先于 Runtime"的鸡蛋问题，同 GenBI)：
//   1) 先部署本栈(不带 -c netadvisor-runtime)：建 ECR + 技能 Lambda + Gateway + GatewayTarget + Memory + 三角色。
//   2) buildx 构建 ARM64 Agent 镜像并推到本栈输出的 ECR。
//   3) 再次部署本栈带 `-c netadvisor-runtime=1`：创建 Runtime + RuntimeEndpoint(引用镜像)。
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as kms from "aws-cdk-lib/aws-kms";
import * as path from "path";
import { Construct } from "constructs";
import { attachNetAdvisorReadOnlyPolicy } from "./netadvisor-iam";
import { resolveModelId } from "./shared/model"; // 模块47 L0:模型 ID 收敛 SSOT(ai-model.json)
import { buildAgentCoreResources } from "./shared/agentcore-base"; // 模块47 L1:协议层共享基类

export interface NetAdvisorAgentCoreStackProps extends cdk.StackProps {
  modelId?: string;
  dataKey?: kms.IKey; // 模块 27 (WS1) — 技能 Lambda 读 CMK 加密的 bgp-datasources 表需解密权限
}

export class NetAdvisorAgentCoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: NetAdvisorAgentCoreStackProps = {}) {
    super(scope, id, props);
    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;
    // 模块47 L0:默认模型走全平台 SSOT(ai-model.json,当前 sonnet-4-5)。props > env > SSOT。
    const modelId = resolveModelId(props.modelId);

    // platform 目录(Lambda 源码 + tsconfig + lock 所在)。infra/lib → ../../platform。
    const platformRoot = path.join(__dirname, "..", "..", "platform");

    // ── ECR 仓库(Agent 容器镜像，ARM64)──
    const repo = new ecr.Repository(this, "NetAdvisorAgentRepo", {
      repositoryName: "bgp-netadvisor-agent",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      imageScanOnPush: false,
    });

    // ── 技能 Lambda(Gateway target 后端；esbuild 单源打包 skills-handler.ts)──
    // 与进程内 network-advisor 同一份源码。node20 自动 external @aws-sdk/*(运行时自带 v3)。
    const skillFn = new NodejsFunction(this, "NetAdvisorSkillsFn", {
      functionName: "bgp-netadvisor-skills",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(platformRoot, "src", "lib", "network-advisor", "skills-handler.ts"),
      handler: "handler",
      projectRoot: platformRoot,
      depsLockFilePath: path.join(platformRoot, "package-lock.json"),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      bundling: {
        format: OutputFormat.CJS,
        target: "node20",
        tsconfig: path.join(platformRoot, "tsconfig.json"), // 解析 `@/` 别名(paths→./src/*)
        // externalModules 留默认：node20 自动 external @aws-sdk/*。
      },
      environment: {
        NET_ADVISOR_REGION: region, // environment-probe/target-resolver 读默认 region
      },
    });
    // 技能 Lambda 只读 IAM：独立 ManagedPolicy 挂 Lambda role(不碰平台 TaskRole)。全只读、永久只读。
    attachNetAdvisorReadOnlyPolicy(this, "NetAdvisorReadOnlyPolicy", skillFn.role!, {
      region,
      account,
      datasourcesTableName: "bgp-datasources",
    });
    // bgp-datasources 表用数据域 CMK 加密(实测 SSEType=KMS)，技能 Lambda GetItem 需用该 key 解密。
    props.dataKey?.grant(skillFn, "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey");

    // ── Gateway 出站角色(被 bedrock-agentcore 服务 assume，去调用 target Lambda)──
    const gatewayRole = new iam.Role(this, "NetAdvisorGatewayRole", {
      roleName: "bgp-netadvisor-gateway-role",
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
    });
    skillFn.grantInvoke(gatewayRole);
    skillFn.addPermission("InvokeByAgentCore", {
      principal: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
      action: "lambda:InvokeFunction",
    });

    // ── Runtime 执行角色(被 bedrock-agentcore assume：调 Bedrock 模型 + 调 Gateway + 日志 + 拉镜像)──
    const runtimeRole = new iam.Role(this, "NetAdvisorRuntimeRole", {
      roleName: "bgp-netadvisor-runtime-role",
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
    });
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream",
        "bedrock-agentcore:*",
        "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents",
        "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage", "ecr:GetAuthorizationToken",
        "xray:PutTraceSegments", "xray:PutTelemetryRecords",
        "cloudwatch:PutMetricData",
      ],
      resources: ["*"],
    }));

    // 续写：Gateway / GatewayTarget / Runtime / Memory 见 buildAgentCore。
    this.buildAgentCore({ repo, skillFn, gatewayRole, runtimeRole, modelId });
  }

  private buildAgentCore(a: {
    repo: ecr.Repository; skillFn: NodejsFunction; gatewayRole: iam.Role; runtimeRole: iam.Role;
    modelId: string;
  }) {
    // 模块47 L1:协议层走共享基类。id 原样传入 → 逻辑 ID 逐字节一致(synth diff 已验 0,零重建)。
    buildAgentCoreResources({
      stack: this,
      ids: { gateway: "NetAdvisorGateway", target: "NetAdvisorTarget", runtime: "NetAdvisorRuntime", memory: "NetAdvisorMemory", memoryRole: "NetAdvisorMemoryRole" },
      repo: a.repo, skillFnArn: a.skillFn.functionArn, gatewayRoleArn: a.gatewayRole.roleArn, runtimeRoleArn: a.runtimeRole.roleArn,
      modelId: a.modelId, capabilityId: "netadvisor",
      gatewayName: "bgp-netadvisor-gateway",
      gatewayInstructions: "网络连通性顾问只读技能：感知 VPC/子网/安全组/路由/端点环境，裁决 Glue/DMS/Flink 等计算到目标(RDS/Redshift/S3)的可达性，给放置建议与整改步骤。全部只读，绝不修改网络。",
      gatewayDescription: "Network connectivity advisor skills gateway (read-only probe / adjudicate tools)",
      targetName: "netadvisorskills",
      targetDescription: "Network advisor read-only skills backed by one Lambda",
      tools: [
        { Name: "analyze_connectivity", Description: "一条龙分析连通性：感知环境(VPC/子网/SG/路由/端点)→裁决计算(Glue/DMS/Flink 等)到目标的可达性→给放置候选与整改建议。返回结论 + 环境摘要(不含完整 SG 规则)。可选传 placement 指定候选放置，缺省用确定性 top1。",
          InputSchema: { Type: "object", Properties: { request: { Type: "object", Description: "连通性请求上下文(由系统注入，含 computeKind/targets/source/constraints/region)。" }, placement: { Type: "object", Description: "可选：模型指定的候选放置。", Properties: { vpcId: { Type: "string" }, subnetIds: { Type: "array", Items: { Type: "string" } }, securityGroupIds: { Type: "array", Items: { Type: "string" } }, availabilityZones: { Type: "array", Items: { Type: "string" } } } } }, Required: [] } },
        { Name: "inspect_security_group", Description: "深挖单个安全组的完整入站/出站规则(analyze_connectivity 的摘要不含完整规则时用)。传 groupId。",
          InputSchema: { Type: "object", Properties: { request: { Type: "object", Description: "连通性请求上下文(由系统注入)。" }, groupId: { Type: "string", Description: "要深挖的安全组 ID(如 sg-xxxx)。" } }, Required: ["groupId"] } },
      ],
      runtimeCtxKey: "netadvisor-runtime", tagCtxKey: "netadvisor-agent-tag",
      runtimeEnv: { NETADVISOR_MAX_ITERS: "8", NETADVISOR_MAX_TOKENS: "2600" },
      runtimeDescription: "Network connectivity advisor agent (Bedrock Converse loop over Gateway MCP tools)",
      memoryDescription: "Network advisor conversation memory: short-term events + semantic long-term records",
      memoryStrategyName: "netadvisorSemantic",
      outputPrefix: "NetAdvisor",
    });
  }
}
