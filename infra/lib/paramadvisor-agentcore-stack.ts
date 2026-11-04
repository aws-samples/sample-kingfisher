// 参数辅助顾问 on AgentCore 基建栈(平台标准第二个实现,照抄 netadvisor-agentcore-stack.ts)。
// 平台标准见 docs/design/28-agentcore-standard/DESIGN.md;只改「业务层」:资源命名 bgp-paramadvisor-* /
// 工具定义(2 个) / Lambda 只读 IAM。协议层(Gateway AWS_IAM 入站 + GatewayTarget + Runtime 门控 +
// 托管 Memory + 三角色)与 esbuild 单源打包骨架 100% 复用。
//
// 部署顺序(两遍部署,同标准 §5):
//   1) 先部署本栈(不带 -c paramadvisor-runtime):建 ECR + 技能 Lambda + Gateway + GatewayTarget + Memory + 三角色。
//   2) buildx 构建 ARM64 Agent 镜像(--provenance=false --sbom=false)推到本栈输出的 ECR。
//   3) 再次部署带 `-c paramadvisor-runtime=1 -c paramadvisor-agent-tag=<git短SHA>`:创建 Runtime。
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as path from "path";
import { Construct } from "constructs";
import { attachParamAdvisorReadOnlyPolicy } from "./paramadvisor-iam";
import { resolveModelId } from "./shared/model"; // 模块47 L0:模型 ID 收敛 SSOT(ai-model.json)
import { buildAgentCoreResources } from "./shared/agentcore-base"; // 模块47 L1:协议层共享基类

export interface ParamAdvisorAgentCoreStackProps extends cdk.StackProps {
  modelId?: string;
}

export class ParamAdvisorAgentCoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ParamAdvisorAgentCoreStackProps = {}) {
    super(scope, id, props);
    const region = cdk.Stack.of(this).region;
    // 模块47 L0:默认模型走全平台 SSOT(ai-model.json,当前 sonnet-4-5)。props > env > SSOT。
    const modelId = resolveModelId(props.modelId);

    // platform 目录(Lambda 源码 + tsconfig + lock 所在)。infra/lib → ../../platform。
    const platformRoot = path.join(__dirname, "..", "..", "platform");

    // ── ECR 仓库(Agent 容器镜像,ARM64)──
    const repo = new ecr.Repository(this, "ParamAdvisorAgentRepo", {
      repositoryName: "bgp-paramadvisor-agent",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      imageScanOnPush: false,
    });

    // ── 技能 Lambda(Gateway target 后端;esbuild 单源打包 skills-handler.ts)──
    // 与进程内 param-advisor 同一份源码。node20 自动 external @aws-sdk/*(运行时自带 v3)。
    const skillFn = new NodejsFunction(this, "ParamAdvisorSkillsFn", {
      functionName: "bgp-paramadvisor-skills",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(platformRoot, "src", "lib", "param-advisor", "skills-handler.ts"),
      handler: "handler",
      projectRoot: platformRoot,
      depsLockFilePath: path.join(platformRoot, "package-lock.json"),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      bundling: {
        format: OutputFormat.CJS,
        target: "node20",
        tsconfig: path.join(platformRoot, "tsconfig.json"), // 解析 `@/` 别名
      },
      environment: {
        PARAM_ADVISOR_REGION: region, // history-probe 读默认 region
      },
    });
    // 技能 Lambda 只读 IAM:独立 ManagedPolicy 挂 Lambda role(不碰平台 TaskRole)。全只读。
    attachParamAdvisorReadOnlyPolicy(this, "ParamAdvisorReadOnlyPolicy", skillFn.role!, { region });

    // ── Gateway 出站角色(被 bedrock-agentcore 服务 assume,去调用 target Lambda)──
    const gatewayRole = new iam.Role(this, "ParamAdvisorGatewayRole", {
      roleName: "bgp-paramadvisor-gateway-role",
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
    });
    skillFn.grantInvoke(gatewayRole);
    skillFn.addPermission("InvokeByAgentCore", {
      principal: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
      action: "lambda:InvokeFunction",
    });

    // ── Runtime 执行角色(被 bedrock-agentcore assume:调 Bedrock 模型 + 调 Gateway + 日志 + 拉镜像)──
    const runtimeRole = new iam.Role(this, "ParamAdvisorRuntimeRole", {
      roleName: "bgp-paramadvisor-runtime-role",
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

    this.buildAgentCore({ repo, skillFn, gatewayRole, runtimeRole, modelId });
  }

  private buildAgentCore(a: {
    repo: ecr.Repository; skillFn: NodejsFunction; gatewayRole: iam.Role; runtimeRole: iam.Role;
    modelId: string;
  }) {
    // 模块47 L1:协议层(Gateway/Target/Runtime门控/Memory+角色+Outputs)走共享基类。
    // id 原样传入 → 逻辑 ID 与抽取前逐字节一致(cdk synth diff 已验 0 变化,零资源重建)。
    buildAgentCoreResources({
      stack: this,
      ids: { gateway: "ParamAdvisorGateway", target: "ParamAdvisorTarget", runtime: "ParamAdvisorRuntime", memory: "ParamAdvisorMemory", memoryRole: "ParamAdvisorMemoryRole" },
      repo: a.repo, skillFnArn: a.skillFn.functionArn, gatewayRoleArn: a.gatewayRole.roleArn, runtimeRoleArn: a.runtimeRole.roleArn,
      modelId: a.modelId, capabilityId: "paramadvisor",
      gatewayName: "bgp-paramadvisor-gateway",
      gatewayInstructions: "托管服务参数辅助只读技能:探测 Glue/Flink/DMS 作业运行历史,启发式推荐 worker/并行度/超时/Iceberg/Redshift 表设计等高级参数,给推荐值+理由+置信度。全部只读,绝不修改资源。",
      gatewayDescription: "Managed-service parameter advisor skills gateway (read-only history probe / heuristic recommend tools)",
      targetName: "paramadvisorskills",
      targetDescription: "Parameter advisor read-only skills backed by one Lambda",
      tools: [
        { Name: "recommend_parameters", Description: "一站式参数推荐:探测作业运行历史(如有 jobRef)→确定性启发式引擎推荐→组装一键预填。返回 recommendations(每参数:推荐值/理由/置信度/是否与当前值不同)、questions(缺失的关键工作负载特征)、historyFacts(历史摘要)、prefill。可传 workloadOverride 补充从对话中获得的特征(estimatedDataGB/hasLobColumns/productionGrade/kinesisShards/joinKey/timeColumn/writeFrequency 等)。",
          InputSchema: { Type: "object", Properties: { request: { Type: "object", Description: "参数推荐请求上下文(由系统注入,含 channel/workload/current/jobRef)。" }, workloadOverride: { Type: "object", Description: "可选:模型从多轮对话中抽取的工作负载特征补充,合并进 workload 后重算。" } }, Required: [] } },
        { Name: "inspect_job_history", Description: "深挖单个作业的运行历史明细(时长分布/成功率/最近失败原因/当前配置)。传 jobRef{kind,id};缺省用请求上下文里的 jobRef。",
          InputSchema: { Type: "object", Properties: { request: { Type: "object", Description: "参数推荐请求上下文(由系统注入)。" }, jobRef: { Type: "object", Description: "要深挖的作业引用。", Properties: { kind: { Type: "string", Description: "glue-job | flink-app | dms-task" }, id: { Type: "string", Description: "Glue JobName / MSAF 应用名 / DMS 任务 ARN 或 identifier" } } } }, Required: [] } },
      ],
      runtimeCtxKey: "paramadvisor-runtime", tagCtxKey: "paramadvisor-agent-tag",
      runtimeEnv: { PARAMADVISOR_MAX_ITERS: "6", PARAMADVISOR_MAX_TOKENS: "2000" },
      runtimeDescription: "Parameter advisor agent (Bedrock Converse loop over Gateway MCP tools)",
      memoryDescription: "Parameter advisor conversation memory: short-term events + semantic long-term records",
      memoryStrategyName: "paramadvisorSemantic",
      outputPrefix: "ParamAdvisor",
    });
  }
}
