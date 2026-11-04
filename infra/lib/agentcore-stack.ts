// 模块 26 — GenBI on AgentCore 基建栈。
// 用 CDK CfnResource 逃生舱创建 AWS::BedrockAgentCore::{Gateway,GatewayTarget,Runtime,RuntimeEndpoint}
//（本账号 us-east-1 实测 LIVE）。技能用 Lambda 实现并经 Gateway 暴露为 MCP 工具；Agent 跑在 Runtime。
//
// 部署顺序（解决"镜像先于 Runtime"的鸡蛋问题）：
//   1) 先部署本栈（不带 -c genbi-runtime）：建 ECR + 技能 Lambda + Gateway + GatewayTarget + 角色。
//   2) buildx 构建 ARM64 Agent 镜像并推到本栈输出的 ECR。
//   3) 再次部署本栈带 `-c genbi-runtime=1`：创建 Runtime + RuntimeEndpoint（引用镜像）。
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as kms from "aws-cdk-lib/aws-kms";
import * as path from "path";
import { Construct } from "constructs";
import { resolveModelId } from "./shared/model"; // 模块47 L0:模型 ID 收敛 SSOT(ai-model.json)
import { buildAgentCoreResources } from "./shared/agentcore-base";
// @kf-batch 50-P50.1-workgroup-ssot — home 的 workgroup 名取自命名 SSOT(部署侧出口)。
import { resourceName, HOME_TARGET_ID } from "./shared/naming";
// @kf-batch 52-P52.5a-supply — 资源 ARN 的 region 段唯一出口 + 显式轴声明。
import { regionalStatement } from "./shared/execution-regions"; // 模块47 L1:协议层共享基类

export interface AgentCoreStackProps extends cdk.StackProps {
  modelId?: string;
  dataKey?: kms.IKey; // 模块 27 (WS1) — 技能 Lambda 读 bgp-genbi-* 加密表需解密权限
  openMetadataUrl?: string; // 模块46 阶段3 — 技能 Lambda 的 fetch_om_descriptions 工具读 OM 表描述(供容器 retrieval)
}

export class AgentCoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgentCoreStackProps = {}) {
    super(scope, id, props);
    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;
    // 模块47 L0:默认模型走全平台 SSOT(ai-model.json,经 ./shared/model)。当前 sonnet-4-5——
    // 真实 converse 探测在多数账号开箱可用;sonnet-4-6/opus-4-x 多数账号需 Marketplace 订阅或未授权。
    // 优先级:props.modelId > env BEDROCK_MODEL_ID > SSOT 默认。
    const modelId = resolveModelId(props.modelId);

    // ── ECR 仓库（Agent 容器镜像，ARM64）──
    const repo = new ecr.Repository(this, "GenbiAgentRepo", {
      repositoryName: "bgp-genbi-agent",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      imageScanOnPush: false,
    });

    // ── 技能 Lambda（Gateway target 后端）──
    const skillFn = new lambda.Function(this, "GenbiSkillsFn", {
      functionName: "bgp-genbi-skills",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "genbi-skills")),
      timeout: cdk.Duration.seconds(120),
      memorySize: 256,
      environment: {
        REDSHIFT_WORKGROUP: resourceName("redshiftWorkgroup", { targetId: HOME_TARGET_ID }),
        REDSHIFT_DATABASE: "dev",
        REDSHIFT_SECRET_NAME: "redshift!bgp-namespace-admin",
        ATHENA_WORKGROUP: "bgp-athena",
        S3TABLES_CATALOG: "s3tablescatalog",
        S3TABLES_BUCKET: "bgp-table-bucket",
        S3TABLES_NAMESPACE: "ecommerce",
        GENBI_MAX_ROWS: "200",
        GENBI_CONTEXT_TABLE: "bgp-genbi-context",
        GENBI_SKILLS_TABLE: "bgp-genbi-skills",
        // v1.29.0 — HTTP/外部 API 技能出站域名白名单（逗号分隔；空=不限定域名，仍受内网 IP 守卫约束）。
        GENBI_HTTP_ALLOWLIST: (this.node.tryGetContext("genbi-http-allowlist") as string) || "",
        // 模块46 阶段3 路线B:fetch_om_descriptions 工具读 OM 表描述(容器 retrieval 语义检索用)。
        // 空则该工具返回空 map,retrieval 回退全表 grounding(不阻断问数)。
        OPENMETADATA_URL: props.openMetadataUrl || "",
      },
    });
    // 技能只读所需权限（与平台 TaskRole 同风格；只读查询，不建表）。
    skillFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        "redshift-data:ExecuteStatement", "redshift-data:DescribeStatement", "redshift-data:GetStatementResult",
        "redshift-serverless:GetCredentials",
        "secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret",
        "athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:StopQueryExecution",
        "glue:GetTable", "glue:GetTables", "glue:GetDatabase", "glue:GetDatabases", "glue:GetCatalog", "glue:GetPartitions",
        "lakeformation:GetDataAccess",
        "s3tables:GetTableBucket", "s3tables:GetNamespace", "s3tables:GetTable", "s3tables:GetTableData",
        "s3tables:ListTableBuckets", "s3tables:ListNamespaces", "s3tables:ListTables", "s3tables:GetTableMetadataLocation",
        "s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:GetBucketLocation",
      ],
      resources: ["*"],
    }));
    // 业务知识/口径/规则表只读（lookup_business_context 技能）。
    skillFn.addToRolePolicy(regionalStatement(this, {
      axis: "home",
      reason: "控制面单份:GenBI 业务口径/技能表按 50 SPEC §1.1 只在 home 存一份,各 target 共读同一份知识",
      actions: ["dynamodb:Query", "dynamodb:GetItem"],
      resources: (r) => [
        `arn:aws:dynamodb:${r}:${account}:table/bgp-genbi-context`,
        `arn:aws:dynamodb:${r}:${account}:table/bgp-genbi-context/index/*`,
        `arn:aws:dynamodb:${r}:${account}:table/bgp-genbi-skills`,
        `arn:aws:dynamodb:${r}:${account}:table/bgp-genbi-skills/index/*`,
      ],
    }));
    // 模块 27 (WS1): 上述两表用数据域 CMK 加密,技能 Lambda 读取需用该 key 解密。
    props.dataKey?.grant(skillFn, "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey");

    // ── Gateway 出站角色（被 bedrock-agentcore 服务 assume，去调用 target Lambda）──
    const gatewayRole = new iam.Role(this, "GenbiGatewayRole", {
      roleName: "bgp-genbi-gateway-role",
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
    });
    skillFn.grantInvoke(gatewayRole);
    skillFn.addPermission("InvokeByAgentCore", {
      principal: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
      action: "lambda:InvokeFunction",
    });

    // ── Runtime 执行角色（被 bedrock-agentcore assume：调 Bedrock 模型 + 调 Gateway + 日志 + 拉镜像）──
    const runtimeRole = new iam.Role(this, "GenbiRuntimeRole", {
      roleName: "bgp-genbi-runtime-role",
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

    // 续写：Gateway / GatewayTarget / Runtime 见同文件后半部分。
    this.buildAgentCore({ repo, skillFn, gatewayRole, runtimeRole, region, account, modelId });
  }

  private buildAgentCore(a: {
    repo: ecr.Repository; skillFn: lambda.Function; gatewayRole: iam.Role; runtimeRole: iam.Role;
    region: string; account: string; modelId: string;
  }) {
    // 工具 InputSchema 构造器(GenBI 特有:SQL 工具/无参工具的 schema 模板)。
    // @kf-batch 50-WP4ter-coverage
    // 🔴🔴 **落点入参必须在这里声明**(真环境 2026-09-10 抓到的静默跨区执行):
    // 容器在唯一漏斗里给每次工具调用并进 `rsRegion/rsWorkgroup/rsDatabase/rsSecretArn`,
    // 但 **AgentCore Gateway 会按 InputSchema 的 Properties 过滤入参** —— 没声明的直接被丢掉。
    // 症状极其隐蔽:`introspect_redshift_schema` 的 schema 是**空 Properties**(不过滤)⇒ 表结构
    // 正确地从 us-west-2 取回(21 张);而 `run_redshift_sql` 声明了 `{sql}` ⇒ 落点被过滤 ⇒
    // Lambda 回落到它自己的 env(主控区)执行 ⇒ 模型看到的是那个区的表、查的却是主控区,
    // 报「relation does not exist」**看起来像数据问题**,没有任何一处报「跨区」。
    // ⇒ 凡是会执行 SQL 的工具,都必须声明这四个可选入参;门禁 `agentcore-place-schema` 钉住两侧一致。
    // @kf-batch 50-WP31-place-first-class —— 序 4(L6):🔴 rs* / ath* 八个平面字段**合并**成一个 `place`(PlaceWire v1 的 JSON 文本,
    //   形状见 platform/place-wire.schema.json)。Gateway 过滤入参的规矩不变 ⇒ 仍必须在每个会执行 SQL 的工具里声明它;
    //   一个字段比八个更不容易漏(原来 Athena 那四个就漏过一次,B-26)。容器 / 技能 Lambda 用同一份读取函数,缺即拒。
    const PLACE_PROPS = {
      place: { Type: "string", Description: "执行落点(PlaceWire v1 JSON;平台注入,模型不要填)" },
    } as const;
    const sqlTool = (name: string, desc: string) => ({
      Name: name, Description: desc,
      InputSchema: {
        Type: "object",
        Properties: { sql: { Type: "string", Description: "只读 SELECT / WITH 查询" }, ...PLACE_PROPS },
        Required: ["sql"],
      },
    });
    const noArgTool = (name: string, desc: string) => ({
      Name: name, Description: desc,
      InputSchema: { Type: "object", Properties: {}, Required: [] },
    });

    // 模块47 L1:协议层走共享基类。id 原样传入 → 逻辑 ID 逐字节一致(synth diff 已验 0,零重建;
    // GenBI 是镜像红线相关能力,synth 0 差异是"不触发 Runtime/Memory 重建"的机器证明)。
    buildAgentCoreResources({
      stack: this,
      ids: { gateway: "GenbiGateway", target: "GenbiTarget", runtime: "GenbiRuntime", memory: "GenbiMemory", memoryRole: "GenbiMemoryRole" },
      repo: a.repo, skillFnArn: a.skillFn.functionArn, gatewayRoleArn: a.gatewayRole.roleArn, runtimeRoleArn: a.runtimeRole.roleArn,
      modelId: a.modelId, capabilityId: "genbi",
      gatewayName: "bgp-genbi-gateway",
      gatewayInstructions: "GenBI 只读数据查询技能：在 Redshift / Athena(S3 Tables) 执行只读 SQL、探查表结构。",
      gatewayDescription: "GenBI skills gateway (read-only SQL / schema tools)",
      targetName: "genbiskills",
      targetDescription: "GenBI read-only skills backed by one Lambda",
      tools: [
        sqlTool("run_redshift_sql", "在 Amazon Redshift 执行只读 SQL(仅 SELECT/WITH，PostgreSQL 方言)，返回列名与数据行。所有计算都在这里完成。"),
        sqlTool("run_athena_sql", "在 Amazon Athena 执行只读 SQL(仅 SELECT/WITH，Trino 方言)查询数据湖 S3 Tables。表用三段式联邦目录名。"),
        noArgTool("introspect_redshift_schema", "列出 Amazon Redshift 数仓中可查询的表与字段（schema/table/列名/类型）。"),
        noArgTool("introspect_s3tables_schema", "列出数据湖 S3 Tables 命名空间中可查询的表与字段。"),
        {
          Name: "lookup_business_context",
          Description: "查询业务口径/指标定义、术语别名、规则与注意事项。生成 SQL 前应调用以遵循正确口径（如金额单位、特定叫法、需排除的状态、测试数据标记等）。",
          InputSchema: { Type: "object", Properties: { projectId: { Type: "string", Description: "项目ID(用于范围)" }, keywords: { Type: "string", Description: "可选关键词，用问题文本粗筛相关口径/规则" } }, Required: [] },
        },
        {
          // 模块46 阶段3 路线B:容器 retrieval 经此取 OM 表描述(容器非 VPC/无 secretsmanager,
          // 由本 Lambda 代读)。返回 { tableName: description }。best-effort,失败返回空。
          Name: "fetch_om_descriptions",
          Description: "获取 OpenMetadata 中各表的业务描述(表名→描述映射),供语义表检索时理解表用途。无需参数。",
          InputSchema: { Type: "object", Properties: {}, Required: [] },
        },
        {
          Name: "list_registered_skills",
          Description: "列出本项目已注册的『业务技能』(经审核的参数化只读查询)。当用户问题可能匹配某个专用技能时,先调用本工具查看有哪些技能及其参数,再用 run_registered_skill 按名执行。",
          InputSchema: { Type: "object", Properties: { projectId: { Type: "string", Description: "项目ID" } }, Required: [] },
        },
        {
          Name: "run_registered_skill",
          Description: "按名执行一个已注册的业务技能(参数化只读查询),返回列名与数据行。技能与参数来自 list_registered_skills。优先用匹配的注册技能以保证口径一致。",
          // @kf-batch 50-WP4ter-coverage —— 注册技能也是**执行 SQL** 的工具 ⇒ 同样必须声明落点入参,
          // 否则「问数按区」在技能路径上照样静默落回主控区(与 run_redshift_sql 同一个坑)。
          InputSchema: { Type: "object", Properties: { skill: { Type: "string", Description: "技能名(来自 list_registered_skills)" }, params: { Type: "object", Description: "参数键值对" }, projectId: { Type: "string", Description: "项目ID" }, ...PLACE_PROPS }, Required: ["skill"] },
        },
      ],
      runtimeCtxKey: "genbi-runtime", tagCtxKey: "genbi-agent-tag",
      runtimeEnv: { GENBI_MAX_ITERS: "8", GENBI_MAX_TOKENS: "2200", GENBI_MODEL_ROWS: "50", GENBI_MAX_ROWS: "200" },
      runtimeDescription: "GenBI NL->SQL agent (Bedrock Converse loop over Gateway MCP tools)",
      memoryDescription: "GenBI conversation memory: short-term events + semantic long-term records",
      memoryStrategyName: "genbiSemantic",
      outputPrefix: "Genbi",
    });
  }
}