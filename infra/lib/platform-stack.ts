import * as cdk from "aws-cdk-lib";
// aws:RequestedRegion 单 region → region 列表的唯一出口(§12.1;缺省模板零 diff)
// regionalStatement:资源 ARN 的 region 段唯一出口 + 显式轴声明。
import { requestedRegionCondition, regionalStatement } from "./shared/execution-regions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3tables from "aws-cdk-lib/aws-s3tables";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as athena from "aws-cdk-lib/aws-athena";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
import { resolveModelId } from "./shared/model";
import { cloudfrontOriginFacingPrefixList } from "./shared/cloudfront-prefix-list";
// 命令表 + 分发 Lambda + 内部密钥(平台动作的主控区一侧)
import { ActionDispatch } from "./action-dispatch";
// home 的 workgroup 名取自命名 SSOT(部署侧出口)。
import { resourceName, HOME_TARGET_ID } from "./shared/naming"; // 模型 ID 收敛 SSOT(ai-model.json)
import { buildPlatformDataRole, platformDataRoleName } from "./shared/platform-data-role";
import { platformImageBuildArgs } from "./shared/build-info"; // 发版号进镜像(唯一作者)

interface PlatformStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  cognitoUserPoolId: string;
  cognitoClientId: string;
  openMetadataUrl?: string;
  // 数据域 CMK。DynamoDB 表用 customer-managed CMK 加密后,**调用方角色必须
  // 持 kms:Decrypt / GenerateDataKey**(与 S3 SSE-KMS 同理,DynamoDB 以调用者身份校验 KMS),
  // 否则读写加密表返回 AccessDeniedException(KMS key access denied)。
  dataKey: kms.IKey;
  // (WS4b-1) — 可选:CloudFront 前置 WAF WebACL ARN(CLOUDFRONT scope)。
  webAclArn?: string;
}

export class PlatformStack extends cdk.Stack {
  public readonly dagBucket: s3.Bucket;
  public readonly albSecurityGroup: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);

    const cluster = new ecs.Cluster(this, "BgpCluster", {
      vpc: props.vpc,
      clusterName: "bgp-cluster",
    });

    // S3 buckets
    // (WS1 — 加密/安全基线): 所有桶统一 ① 服务端加密(SSE-S3,显式开启)② 阻断一切
    // 公共访问 ③ 强制 TLS(拒绝非 HTTPS 请求)。这是零运行时风险的加固——SSE-S3 解密不需要
    // 调用方持 kms 权限。升级到 SSE-KMS(CMK)需先在 WS4 把读写 S3 的各角色精确授予 kms:Decrypt,
    // 否则运行时 AccessDenied;故 CMK 化留到 WS4 一并做。
    const accountId = cdk.Stack.of(this).account;
    const s3Hardened = {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    } as const;
    // 🔴 生产上线批次 A(2026-10-09):主控区放客户数据的资源一律 RETAIN、不带 autoDeleteObjects。
    //   原来是 DESTROY + 自动清空 ⇒ 一次误删栈 / 资源替换 = 客户数据湖整片消失;执行区早就是 RETAIN,两边做反了。
    //   代价:删环境后这些桶要人工清理(与执行区同口径)。
    new s3.Bucket(this, "DatalakeBucket", { bucketName: `bgp-datalake-${accountId}`, ...s3Hardened, removalPolicy: cdk.RemovalPolicy.RETAIN });
    new s3.Bucket(this, "GlueScriptsBucket", { bucketName: `bgp-glue-scripts-${accountId}`, ...s3Hardened, removalPolicy: cdk.RemovalPolicy.RETAIN });
    this.dagBucket = new s3.Bucket(this, "MwaaDagBucket", { bucketName: `bgp-mwaa-dags-${accountId}`, ...s3Hardened, removalPolicy: cdk.RemovalPolicy.RETAIN, versioned: true });

    // S3 Tables 表桶（Iceberg）。此前靠手工 `aws s3tables create-table-bucket --name bgp-table-bucket`
    // 预建，是 IaC 缺口：全新账号上不存在 → Athena / S3 Tables / 数据湖问数等功能运行时失败。
    // 纳入 CDK 保证从零部署可复现。命名空间 `ecommerce` 与各表由平台同步流程（Glue）按需创建。
    const s3TablesBucket = new s3tables.CfnTableBucket(this, "S3TablesBucket", {
      tableBucketName: "bgp-table-bucket",
    });
    s3TablesBucket.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // 自管 Athena workgroup（查询 S3 Tables / Iceberg），结果落到平台自有数据湖桶，
    // 不依赖 workshop 的 data-exploration / data-lake-stagings3bucket-*。强制 WG 配置：客户端
    // 不可覆盖结果位置与加密（SSE_S3）；引擎 v3。
    const athenaOutputLocation = `s3://bgp-datalake-${accountId}/athena-results/`;
    const athenaWorkgroup = new athena.CfnWorkGroup(this, "AthenaWorkGroup", {
      name: "bgp-athena",
      description: "BGP 平台查询 S3 Tables / Iceberg 的工作组",
      state: "ENABLED",
      recursiveDeleteOption: false,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        engineVersion: { selectedEngineVersion: "Athena engine version 3" },
        resultConfiguration: {
          outputLocation: athenaOutputLocation,
          encryptionConfiguration: { encryptionOption: "SSE_S3" },
        },
      },
    });
    athenaWorkgroup.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // Glue Job execution role
    // Glue 作业执行角色同样收敛——删 AmazonS3FullAccess / SecretsManagerReadWrite,
    // 改为限定到 bgp-* 桶与 bgp/* + redshift 托管密钥的精确策略。保留标准 AWSGlueServiceRole。
    const glueRole = new iam.Role(this, "GlueRole", {
      roleName: "bgp-glue-role",
      assumedBy: new iam.ServicePrincipal("glue.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSGlueServiceRole"),
      ],
    });
    glueRole.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation"],
      resources: [`arn:aws:s3:::bgp-*`, `arn:aws:s3:::bgp-*/*`],
    }));
    // Glue 作业读源库/Redshift 凭证(只读)。含 RDS/OM 等 CDK 默认命名密钥,故读放开到本账号
    // 本区域 secret(只读安全);Glue 作业不写密钥。
    glueRole.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "这是 **home 的** Glue 作业执行角色:只有主控区的 Glue 作业用它。非 home 的 Glue 作业用"
        + "该区自己的 per-target 角色(exec-env/exec-roles.ts),凭证也建在该区 ⇒ 本条不需要跨 region。",
      actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
      resources: (r) => [`arn:aws:secretsmanager:${r}:${cdk.Stack.of(this).account}:secret:*`],
    }));
    glueRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "redshift-serverless:GetCredentials",
        // B9 — Redshift COPY:从 workgroup 派生 namespace、读其已关联 IAM 角色(发现 COPY 的 IAM_ROLE,只读)。
        "redshift-serverless:GetWorkgroup",
        "redshift-serverless:GetNamespace",
        "redshift-data:ExecuteStatement",
        "redshift-data:BatchExecuteStatement",
        "redshift-data:DescribeStatement",
        "redshift-data:GetStatementResult",
        "redshift-data:CancelStatement",
      ],
      resources: ["*"],
    }));
    glueRole.addToPolicy(new iam.PolicyStatement({
      actions: ["s3tables:*", "lakeformation:*", "glue:*", "logs:*"],
      resources: ["*"],
    }));
    // 数据源生态:Glue 同步作业从【用户任意】DynamoDB 表 / S3 桶【只读】批读入湖仓。
    //   🔴 诚实边界(与 bgp-* 收敛的权衡,用户 2026-07-29 拍板 Resource=*):DDB/S3 源对接用户既有资源,
    //   Glue 作业(bgp-glue-role)必须能读任意 DDB 表 / 任意 S3 桶。全【只读】(DDB DescribeTable/Scan;S3 GetObject/ListBucket),
    //   不写用户资源;写只发生在平台自有 bgp-* 桶/Redshift(上面已限定)。
    glueRole.addToPolicy(new iam.PolicyStatement({
      actions: ["dynamodb:DescribeTable", "dynamodb:Scan", "dynamodb:Query", "dynamodb:GetItem", "dynamodb:BatchGetItem"],
      resources: ["*"], // 用户任意 DDB 表(含 index),只读
    }));
    glueRole.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation"],
      resources: ["*"], // 用户任意 S3 桶 + 对象,只读(S3 源批读;写仍限 bgp-* 见上)
    }));

    // (WS4a — 最小权限收敛): 删除全部 *FullAccess(IAMFullAccess / EC2FullAccess /
    // S3FullAccess / DynamoDBFullAccess / RedshiftFullAccess / GlueConsoleFullAccess /
    // SecretsManagerReadWrite),改为基于代码实际调用反推的精确内联策略 + Resource 收敛到 bgp-*。
    // 依据:对 platform/src 全量 grep AWS SDK Command 类(见 docs/design/27 WS4a 盘点)。
    // 仅保留两个低风险只读托管策略。
    const taskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        // CloudWatch Logs 只读(查 Glue/同步/作业日志);RDS 只读(数据源自动发现 DescribeDBInstances)。
        iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchLogsReadOnlyAccess"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonRDSReadOnlyAccess"),
        // (Secrets 不再用 SecretsManagerReadWrite 托管策略;下方精确内联策略已覆盖读/写/列举,
        //  写仅限 bgp/* + bgp-* 命名空间——收敛后移除,见提交说明。)
      ],
    });
    // 主控区的平台数据面角色(与执行环境 base 栈同一个作者)+ 任务角色可代入
    //   各区那一个角色(运行时注入点 platform/src/lib/aws/clients.ts#buildDataPlane;模式 BGP_DATAPLANE_CREDS)。
    //   🔴 本刀只增:任务角色的数据面直授一条没动(收回)。
    buildPlatformDataRole(this, "PlatformDataRole", { targetId: "tgt_home", account: accountId, region: this.region, partition: this.partition });
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: "AssumePlatformDataRoles",
      actions: ["sts:AssumeRole"],
      resources: [
        `arn:${this.partition}:iam::${accountId}:role/${platformDataRoleName("tgt_home")}`,
        `arn:${this.partition}:iam::${accountId}:role/BgpExecEnv-*-platform-data-role`,
      ],
    }));
    // 实时 CDC 控制面权限。按 lib/realtime/{dms-service,redshift-target}.ts 实际
    // 调用的 SDK 动作精确收敛(DMS 经典实例模式:实例 + 复制任务 + 连通性测试)。
    //  · DMS:**懒创建复制实例**(成本改造 2026-07-07:实例不再随栈常驻,建同步任务时按需 CreateReplicationInstance,
    //    用 BgpRealtimeStack 的固定名子网组/SG)、建/查/启复制任务、建/查 endpoint、连通性测试、查实例/连接/表统计。
    //  · 平台只编排,不直接写 Kinesis(那是 DMS 角色的事),故无 kinesis 权限。
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "dms:CreateReplicationInstance", "dms:CreateEndpoint", "dms:DescribeEndpoints",
        "dms:CreateReplicationTask", "dms:ModifyReplicationTask", "dms:DescribeReplicationTasks", "dms:StartReplicationTask",
        // 🔴 **停 + 删**:改动前平台压根不发这两个调用
        //   (于是 DMS 通道从来没被真正停过);真环境实测 502 的拒因就是缺 `dms:DeleteReplicationTask`。
        "dms:StopReplicationTask", "dms:DeleteReplicationTask",
        "dms:TestConnection", "dms:DescribeConnections",
        "dms:DescribeReplicationInstances", "dms:DescribeReplicationSubnetGroups", "dms:DescribeTableStatistics",
      ],
      resources: ["*"], // DMS 控制面动作不支持资源级限定;用区域条件收敛。
      conditions: { StringEquals: { "aws:RequestedRegion": requestedRegionCondition(this) } },
    }));
    // Redshift Serverless 控制面:仅 GetNamespace/UpdateNamespace(把 DMS COPY 角色关联到 namespace,踩坑⑥)。
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ["redshift-serverless:GetNamespace", "redshift-serverless:UpdateNamespace"],
      resources: ["*"],
      conditions: { StringEquals: { "aws:RequestedRegion": requestedRegionCondition(this) } },
    }));
    // (Zero-ETL) — "增量同步"真·CDC 控制面权限(按 lib/realtime/zeroetl-service.ts 实际调用收敛)。
    //  · RDS:建/删/查 Zero-ETL 托管集成(替代 Glue 假增量,修复 B6);
    //  · Redshift:namespace 资源策略(授权入站集成,Condition 锁源)+ 入站集成查询;
    //  · Redshift Serverless:建/查独立 namespace + workgroup(开 case-sensitive,隔离主库全局风险)。
    // 这些控制面动作多不支持资源级限定,用区域条件收敛(与上方 DMS 块一致)。
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "rds:CreateIntegration", "rds:DeleteIntegration", "rds:DescribeIntegrations",
        "redshift:PutResourcePolicy", "redshift:GetResourcePolicy",
        "redshift:CreateInboundIntegration", "redshift:DescribeInboundIntegrations",
        "redshift-serverless:CreateNamespace", "redshift-serverless:CreateWorkgroup",
        "redshift-serverless:GetWorkgroup", "redshift-serverless:ListNamespaces",
      ],
      resources: ["*"],
      conditions: { StringEquals: { "aws:RequestedRegion": requestedRegionCondition(this) } },
    }));
    // Zero-ETL CreateIntegration 需对【源 RDS 加密 CMK】(及目标 namespace 密钥)建授权 grant +
    // 读密钥元数据,否则报 "The KMS key ... you don't have permission to access it"。
    // ⚠️ 该缺口仅在 TaskRole 精确收敛后暴露——人工 CLI 验证用的是宽权限 admin 身份,故当时未现。
    // 用区域条件收敛(覆盖源/目标两侧密钥;后续可进一步限定到具体 key ARN)。
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "kms:DescribeKey", "kms:CreateGrant", "kms:ListGrants", "kms:RetireGrant",
        "kms:GenerateDataKey", "kms:Decrypt",
      ],
      resources: ["*"],
      conditions: { StringEquals: { "aws:RequestedRegion": requestedRegionCondition(this) } },
    }));
    // iam:PassRole —— 把固定角色传给消费它们的 AWS 服务,实时/批同步编排多处需要:
    //  · DMS 建 endpoint/任务用 dms-kinesis-role(SecretsManagerAccessRole/ServiceAccessRole);
    //  · redshift-serverless UpdateNamespace 关联 DMS COPY 角色到 namespace(踩坑⑥);
    //  · 数据源/批同步建 Glue 作业传 bgp-glue-role。
    // 最小权限靠【资源严格限定到这两个固定角色】实现(只能传这俩,且各角色信任策略本身再设门槛);
    // 不加 PassedToService 条件——消费服务种类多(dms/区域化dms/redshift/redshift-serverless/glue),
    // 条件值难穷举,漏一个就运行时 PassRole 拒绝(已实测踩坑)。资源限定已足够收敛。
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ["iam:PassRole"],
      resources: [`arn:aws:iam::${cdk.Stack.of(this).account}:role/bgp-dms-kinesis-role`, `arn:aws:iam::${cdk.Stack.of(this).account}:role/bgp-glue-role`, `arn:aws:iam::${cdk.Stack.of(this).account}:role/bgp-flink-role`, `arn:aws:iam::${cdk.Stack.of(this).account}:role/bgp-redshift-copy-role`],
    }));
    // iam:GetRole —— DMS 建 endpoint(CreateEndpoint)会校验 SecretsManagerAccessRole/ServiceAccessRole
    // 是否存在,平台侧需对这两个角色有 GetRole(实测缺失会报 "does not have IAM:GetRole permission")。
    // 严格限定到这两个固定角色,不放开到 *。
    // + home 的 bgp-airflow-sls-role(seed-home 探测 / 探活 airflow-serverless:role 都 GetRole 它;
    //   真环境撞过:缺它 ⇒ AccessDenied 被 seed-home 当「未部署」吞掉,HTTP 200 却不声称组件)
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ["iam:GetRole"],
      resources: [`arn:aws:iam::${cdk.Stack.of(this).account}:role/bgp-dms-kinesis-role`, `arn:aws:iam::${cdk.Stack.of(this).account}:role/bgp-glue-role`, `arn:aws:iam::${cdk.Stack.of(this).account}:role/bgp-flink-role`, `arn:aws:iam::${cdk.Stack.of(this).account}:role/bgp-redshift-copy-role`, `arn:aws:iam::${cdk.Stack.of(this).account}:role/bgp-airflow-sls-role`],
    }));
    // 🔴 bug #10(与 #7/#8 同族:**既有 IAM 的资源模式按 `bgp-*` 命名约定写死**):
    //    执行环境的 per-target 角色叫 `BgpExecEnv-<slug>-*`(IAM 全局资源,不能用 home 名 —— 同名必撞,
    //    §12 P0-D),于是探活的 `iam:GetRole` 一律 AccessDenied(实测 `flink:role` 探活红)。
    // 🔴 **不加** `aws:RequestedRegion` 条件:IAM 是**全局服务**,给它加 region 条件反而会拦掉调用。
    //    收敛靠资源模式本身 —— `BgpExecEnv-*` 只可能是执行环境栈组建出来的角色。
    // 原「⬜ `iam:PassRole` 到 `BgpExecEnv-*` 刻意还没给,到补」在此**补上四类**
    //    (下面独立的 ManagedPolicy);flink 那一类**仍登记未给**(MSAF 非 home 建应用不在,现在给 = 授未用之权)。
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: "ExecEnvPerTargetRoleRead",
      actions: ["iam:GetRole"],
      resources: [`arn:aws:iam::${cdk.Stack.of(this).account}:role/BgpExecEnv-*`],
    }));
    // ──:把 per-target 执行角色传给消费它们的服务(SPEC v3.21 §6.1 段二落地口径 3)──
    // 【为什么是独立 ManagedPolicy】TaskRole 的内联 DefaultPolicy 已逼近 IAM 10KB 拆分线(memory taskrole-inline-policy-10kb-limit),
    //   再往里追加会把既有语句重排进 OverflowPolicy、synth-gate §9f 当场判红。
    // 【资源模式】`BgpExecEnv-*-<kind>-role` 四模式,与命名 SSOT 的 target 模板 `BgpExecEnv-{slug}-*-role` 同形 ——
    //   只可能是执行环境栈组建出来的角色(平台 TaskRole 不持部署权,建不出这种名字)。
    //   与上面四个 home 固定名同口径**不加 PassedToService**(消费服务种类多:glue / emr-serverless / redshift /
    //   redshift-serverless / dms / 区域化 dms,漏一个就运行时 PassRole 拒 —— 已实测踩坑)。
    // 🔴 **flink 这一类在此补齐(原「登记未给」)**。
    // 起因是真环境无头验收当场抓到的:usw2 视角启动 Flink 作业 ⇒ HTTP 500
    //   `not authorized to perform: iam:PassRole on .../BgpExecEnv-tgt-usw2-a-flink-role`。
    // 「登记未给」这条口径已被用户 2026-09-10 明令推翻:「Flink **一定要加这个维度,不然白干了**,
    //   所有任务都在自己的区域跑」+「⚠️ **登记不算过关**」。此前已把 MSAF 的落点参数化,
    //   授权面却还停在那句「现在给 = 授未用之权」—— 现在**正在用**,不给就是整条路不通。
    // synth-gate §9.4b 的断言同步反转:五类**都必须在**(flink 那条从「必须不在」改成「必须在」)。
    new iam.ManagedPolicy(this, "ExecEnvPerTargetRolePass", {
      roles: [taskRole],
      statements: [
        new iam.PolicyStatement({
          sid: "PassPerTargetExecRoles",
          actions: ["iam:PassRole"],
          resources: ["glue", "emr", "redshift-copy", "dms-kinesis", "flink"].map(
            (kind) => `arn:${this.partition}:iam::${cdk.Stack.of(this).account}:role/BgpExecEnv-*-${kind}-role`
          ),
        }),
      ],
    });
    // ──(任务执行角色可选,用户 2026-11-03 拍板「与 AWS 一致」)──
    // 【起因】客户现网把离线作业依赖库换到自己的桶、想把作业绑到**自建**角色:上面三条 PassRole 只放平台固定名 /
    //   `BgpExecEnv-*-<kind>-role` / 顾问 `bgp-job-role-*`,自建角色名不在内 ⇒ Glue CreateJob / UpdateJob 的 PassRole 被拒
    //   ⇒ 页面「可填自定义角色」是无载体的承诺(纪律 9);回退本区平台 Glue 角色又刻意读不到客户桶 ⇒ 启动期 403。
    // 【口径】与 AWS 控制台「IAM role」下拉同口径:账号内任何**该服务可承担**的角色都能绑。安全边界 = `iam:PassedToService`
    //   锁死三个作业服务(glue / emr-serverless / kinesisanalytics):平台只能把角色交给这三个服务去承担,不能交给别的服务、
    //   也不能自己承担;**不放 dms**(DMS 角色是平台内部编排角色,用户不选)。不加标签 opt-in(用户拍板)。
    // 【为什么独立 ManagedPolicy】同上一条:TaskRole 内联 DefaultPolicy 已逼近 10KB 拆分线。
    // 【配套】`iam:ListRoles`(页面下拉候选 + 刷新)· `iam:GetRole` / `iam:SimulatePrincipalPolicy` 任意角色(保存期预检:
    //   信任策略含该服务主体 + 对作业实际引用面(脚本桶 / --extra-py-files / --extra-jars / 脚本里的 s3:// 字面)逐条模拟)。
    //   synth-gate §9.4d 钉:role/* 的 PassRole 必带且只带这三个服务;IAM 调用清单登记 6 条。
    new iam.ManagedPolicy(this, "ExecutionRoleBinding", {
      roles: [taskRole],
      statements: [
        new iam.PolicyStatement({
          sid: "PassAnyRoleToJobServices",
          actions: ["iam:PassRole"],
          resources: [`arn:${this.partition}:iam::${cdk.Stack.of(this).account}:role/*`],
          conditions: {
            StringEquals: {
              "iam:PassedToService": ["glue.amazonaws.com", "emr-serverless.amazonaws.com", "kinesisanalytics.amazonaws.com"],
            },
          },
        }),
        new iam.PolicyStatement({
          sid: "ListRolesForExecutionRolePicker",
          actions: ["iam:ListRoles"],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          sid: "ReadAndSimulateAnyExecutionRole",
          actions: ["iam:GetRole", "iam:SimulatePrincipalPolicy"],
          resources: [`arn:${this.partition}:iam::${cdk.Stack.of(this).account}:role/*`],
        }),
      ],
    });
    // ══════════════════════════════════════════════════════════════════════════
    // 🔴🔴 **实时计算的平台侧授权,整组搬进独立 ManagedPolicy**
    //
    // 【为什么搬】TaskRole 的内联 `DefaultPolicy` 实测已到 **10110 字节**(IAM 内联上限 10240)⇒ CDK 自动
    //   拆出 `TaskRoleOverflowPolicy`,synth-gate 当场判红(仓内惯例:新权限走独立 ManagedPolicy,
    //   不靠 CDK 隐式拆分 —— 隐式拆分每次部署都可能把语句挪来挪去)。
    //   🔴 这条红**在已部署的栈里就存在**(线上真有 `TaskRoleOverflowPolicy1C9536D18`),也就是说它
    //   已经红了一阵没人看见 —— 正是记忆 `gate-fast-path-is-a-blind-spot`:只跑 `--fast` 收官,
    //   全量门里的红没人看。
    //
    // 【为什么这三段能成一组】它们就是「一个流作业」的全部平台侧动作:源流(kinesis)→ 应用
    //   (kinesisanalytics)→ 日志(logs)。一组搬走也让「实时计算在某个区能不能跑」有了单一落点。
    //
    // 【本批修掉的真缺陷】这三段原来都是「**条件多区、ARN 单区**」的分叉:语句上挂着多区派生的
    //   `aws:RequestedRegion`,而 ARN 的 region 段写死成部署区 ⇒ 第二个区的流建不了/造不了数、
    //   日志组建不出来。2026-09-19 用 `SimulatePrincipalPolicy` 坐实:us-west-2 上
    //   `kinesis:CreateStream` / `PutRecords` / `logs:CreateLogGroup` 全 `implicitDeny`,us-east-1 allowed。
    //   ⇒ 全部翻成 execution 轴(ARN region 段 = `*`,区域条件由 `regionalStatement` 成对挂上)。
    //   🔴 为什么此前没有任何门看得见:**实时计算根本不在「能力 × 区域 × 执行方式」矩阵里**,
    //      而矩阵里没有的那一类 = 默认豁免;IAM 模拟门的清单里也一条 kinesis 都没有(覆盖面 = 判据本身)。
    // ══════════════════════════════════════════════════════════════════════════
    new iam.ManagedPolicy(this, "RealtimeComputeControl", {
      roles: [taskRole],
      statements: [
        // ① MSAF 应用(每流作业一个应用):创建/启停/删除/查状态/快照/Flink Web UI 临时 URL。
        regionalStatement(this, {
          axis: "execution",
          reason: "MSAF 应用是**执行 region 的**资源(流式作业天生一区一个应用)⇒ 建/启/停/"
            + "对账/快照/销毁都必须能打该区。资源面 `*`:应用名由平台随机生成、创建时服务按 application/* 评估。",
          actions: [
            "kinesisanalytics:CreateApplication", "kinesisanalytics:DeleteApplication",
            "kinesisanalytics:UpdateApplication", "kinesisanalytics:StartApplication",
            "kinesisanalytics:StopApplication", "kinesisanalytics:DescribeApplication",
            "kinesisanalytics:ListApplications", "kinesisanalytics:AddApplicationCloudWatchLoggingOption",
            "kinesisanalytics:TagResource",
            // 签发原生 Flink Web UI(Dashboard)临时访问 URL(详情页一键跳转看作业拓扑/反压/checkpoint)。
            "kinesisanalytics:CreateApplicationPresignedUrl",
            // 快照(savepoint)族:有状态流作业「停止打快照 / 启动从快照恢复」的通用语义所必需。
            // 🔴 缺 ListApplicationSnapshots 曾致 S3 Tables sink 启动首帧 HTTP 412(根因,实测 CloudTrail
            //    AccessDenied 被静默吞 → 误判"无快照" → 恒 SKIP_RESTORE → checkpointId 归 1 → delta
            //    manifest 撞同名残留 → S3 Tables 拒覆盖)。成组补齐(非只补一个动作):优雅停止亦依赖快照,
            //    权限不全会静默退化成强停 → 下次启动仍无快照。
            //    见 docs/design/32-realtime-compute/DESIGN-flink-s3tables-412-rootfix.md §3.1 L1。
            "kinesisanalytics:ListApplicationSnapshots",
            "kinesisanalytics:DescribeApplicationSnapshot",
            "kinesisanalytics:CreateApplicationSnapshot",
            "kinesisanalytics:DeleteApplicationSnapshot",
          ],
          resources: () => ["*"],
        }),
        // ② 源流:(多数据源·B方案,用户拍板 2026-07-26)。
        //    provision 按需新建流(不再建固定 `bgp-flink-source`,流名用户定)+ 造数/读取演示。
        regionalStatement(this, {
          axis: "execution",
          reason: "实时计算的源流是**该区自己的** Kinesis 流:平台要在执行 region 里 provision 建流、"
            + "PutRecords 造数、GetRecords 读结果。只放 home 的话第二个区一条流都建不出来 ⇒ 那个区的"
            + "实时计算从第一步就废(2026-09-19 IAM 模拟坐实 us-west-2 implicitDeny)。资源面仍只到 stream/*。",
          actions: [
            "kinesis:PutRecord", "kinesis:PutRecords", "kinesis:DescribeStream",
            "kinesis:DescribeStreamSummary", "kinesis:ListShards", "kinesis:GetShardIterator", "kinesis:GetRecords",
            "kinesis:CreateStream", "kinesis:AddTagsToStream",
          ],
          resources: (r) => [`arn:aws:kinesis:${r}:${cdk.Stack.of(this).account}:stream/*`],
        }),
        // ③ 🔴 kinesis:ListStreams 是【账号级】操作(不关联具体 stream ARN)——必须 resources:["*"],
        //    放到 stream/* 的 statement 里会被永久拒绝(实测踩坑)。"使用已有流"下拉靠它免手敲。
        regionalStatement(this, {
          axis: "execution",
          reason: "「使用已有流」下拉要列出**当前执行 region** 已有的流;账号级动作 ⇒ 资源只能 `*`,"
            + "范围由区域条件收回已登记的执行 region。",
          actions: ["kinesis:ListStreams"],
          resources: () => ["*"],
        }),
        // ④ MSAF 应用的 CloudWatch 日志组(详情页运行日志);读由 CloudWatchLogsReadOnlyAccess 覆盖。
        regionalStatement(this, {
          axis: "execution",
          reason: "MSAF 应用的日志组是**该区**的资源(/aws/kinesis-analytics/ 下、按应用名前缀限定):"
            + "启动流作业时在执行 region 建它、详情页读它、删作业时删它。只放 home ⇒ 非 home 流作业"
            + "「起来了但看不到日志」,而崩溃循环 / CDC 位点过期只在日志里看得见。"
            + "资源面仍是下面那个前缀,一个字没放宽。",
          actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:DeleteLogGroup", "logs:PutRetentionPolicy", "logs:DescribeLogStreams", "logs:FilterLogEvents"],
          resources: (r) => [
            `arn:aws:logs:${r}:${cdk.Stack.of(this).account}:log-group:/aws/kinesis-analytics/bgp-flink-*`,
            `arn:aws:logs:${r}:${cdk.Stack.of(this).account}:log-group:/aws/kinesis-analytics/bgp-flink-*:*`,
          ],
        }),
      ],
    });
    const region = cdk.Stack.of(this).region;
    const acct = cdk.Stack.of(this).account;

    // DynamoDB:仅平台自有 bgp-* 表(含 GSI)的读写。
    taskRole.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "控制面单份:注册表/任务/运行台账等 bgp-* 表按 50 SPEC §1.1 只在 home 存一份,多 target 共读同一份",
      actions: [
        "dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan",
        "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem",
        "dynamodb:DescribeTable",
      ],
      resources: (r) => [
        `arn:aws:dynamodb:${r}:${acct}:table/bgp-*`,
        `arn:aws:dynamodb:${r}:${acct}:table/bgp-*/index/*`,
      ],
    }));
    // S3:仅平台自有 bgp-* 桶(Glue 脚本 / MWAA DAG / 数据湖 / 结果 / GenBI 记忆)。
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation"],
      resources: [`arn:aws:s3:::bgp-*`, `arn:aws:s3:::bgp-*/*`],
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:ListAllMyBuckets"], resources: ["*"], // ListBuckets 不支持资源级
    }));
    // Redshift Data API(只用 Data API + serverless 取凭证;不需要 RedshiftFullAccess)。
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "redshift-data:ExecuteStatement", "redshift-data:BatchExecuteStatement",
        "redshift-data:DescribeStatement", "redshift-data:GetStatementResult", "redshift-data:CancelStatement",
        "redshift-data:ListDatabases", "redshift-data:ListSchemas", "redshift-data:ListTables",
        // 关联回查:按 StatementName(= auditId)反查语句(ListStatements 只列本角色自己跑的,天然收口)
        "redshift-data:ListStatements",
        "redshift-serverless:GetCredentials", "redshift-serverless:ListWorkgroups", "redshift-serverless:GetWorkgroup",
      ],
      resources: ["*"], // Redshift Data API 多数动作不支持资源级限定
    }));
    // Glue:作业/连接的增删改查 + 运行(数据同步与作业开发)。Glue 资源级 ARN 较繁杂,限到本账号本区域。
    // SYNC-FIX(B5): 数据同步到 S3 Tables 时,启动路由会确保 s3tablescatalog 联邦 catalog 存在
    // (GetCatalog 不存在则 CreateCatalog + CreateDatabase namespace)。WS4a 收敛时漏了
    // CreateCatalog/GetCatalogs/CreateDatabase → catalog 建不出来 → Glue 作业 "Catalog not found"。
    // 这里补上,并把 catalog 子资源(联邦派生的 s3tablescatalog/*)纳入 Resource。
    taskRole.addToPolicy(regionalStatement(this, {
      axis: "execution",
      reason: "数据面(Glue 作业/连接/catalog)—— W3-g 起 Glue 作业**按 target 在该 region 建与运行**(用户 2026-09-04 要求三种任务类型都要在多个区域跑通):平台要在执行 region 里 CreateJob/StartJobRun/GetJobRun,只放 home 会让非 home 的 Glue 下推在第一步就 AccessDenied。资源名仍收在 bgp-*(作业名跨区同名,见 job-service ensureGlueJob 的说明)",
      actions: [
        "glue:CreateJob", "glue:UpdateJob", "glue:GetJob", "glue:GetJobs", "glue:GetJobRun", "glue:GetJobRuns",
        "glue:StartJobRun", "glue:BatchStopJobRun", "glue:DeleteJob",
        "glue:CreateConnection", "glue:GetConnection", "glue:GetConnections", "glue:DeleteConnection", "glue:UpdateConnection",
        // 数据源「检测」/「浏览表」改走数据源自己的 Glue 连接:载体是一次性发现作业 bgp-ds-discover-*(见下面 job/bgp-* 的授权面)。
        //   🔴 不授 glue:TestConnection:2026-10-13 实测它对平台建的传统 JDBC 连接直接回「only supported for the Unified Connections」,没有载体。
        // glue:PassConnection —— 创建 S3 Tables 联邦 catalog(FederatedCatalog ConnectionName=aws:s3tables)
        // 时必须能"传递"AWS 托管连接 aws:s3tables,否则同步到 S3Table 目标启动即 500
        // (glue:PassConnection on connection/aws:s3tables is not authorized)。
        "glue:PassConnection",
        "glue:GetTable", "glue:GetTables", "glue:GetDatabase", "glue:GetDatabases", "glue:GetPartitions",
        "glue:GetCatalog", "glue:GetCatalogs", "glue:CreateCatalog", "glue:CreateDatabase",
      ],
      resources: (r) => [
        `arn:aws:glue:${r}:${acct}:catalog`,
        `arn:aws:glue:${r}:${acct}:catalog/*`,
        `arn:aws:glue:${r}:${acct}:job/bgp-*`,
        `arn:aws:glue:${r}:${acct}:connection/bgp-*`,
        // AWS 托管的 S3 Tables 连接(联邦 catalog 依赖),PassConnection 作用对象。
        `arn:aws:glue:${r}:${acct}:connection/aws:s3tables`,
        `arn:aws:glue:${r}:${acct}:database/*`,
        `arn:aws:glue:${r}:${acct}:table/*`,
        `arn:aws:glue:${r}:${acct}:userDefinedFunction/*`,
      ],
    }));
    // ── 切片 b/f:执行环境部署权隔离(DESIGN §12.0 / §12.4)────────
    // 🔴 平台 ECS 角色**刻意不给** `codebuild:StartBuild` —— StartBuild API 自带
    //    buildspecOverride/imageOverride/serviceRoleOverride 等 override(IR-P0-05),
    //    拿到本角色凭证即可 inline 恶意 buildspec 借 CodeBuild 的强权服务角色执行任意部署。
    //    ⇒ 平台只能 `lambda:InvokeFunction` 那个窄权 broker(它只接白名单入参、不透传 override)。
    //    也**刻意不给** `codebuild:UpdateProject`(改项目定义 = 变相提权,§12.0 的"同级保护")。
    // 🔴 改独立 ManagedPolicy(照上 DataSourceReadOnly 先例):切片 f 把 DescribeStacks 的
    //    Resource 从 `*` 收窄到 `stack/BgpExecEnv-*`,ARN 串比 `*` 长几十字节 —— 恰好把 TaskRole
    //    内联 DefaultPolicy 推过 CDK 的 10KB 拆分线(MAX_INLINE_SIZE),触发 splitLargePolicy 把
    //    **别的既有语句**重排进 OverflowPolicy(行为等价但审计噪声大、语句落点漂移)。
    //    独立 ManagedPolicy = 内联体积不增、语句落点稳定、便于审计/回收(memory taskrole-inline-policy-10kb-limit)。
    new iam.ManagedPolicy(this, "ExecEnvControl", {
      roles: [taskRole],
      statements: [
        regionalStatement(this, {
          sid: "ExecEnvDeployViaBrokerOnly",
          axis: "home",
          reason: "控制面单份:窄权 broker Lambda 只部署在 home(§12.0 部署权隔离),不存在 per-target 副本",
          // +GetFunctionConfiguration —— 接线健康卡只读探「部署机制在否」(不 invoke)
          actions: ["lambda:InvokeFunction", "lambda:GetFunctionConfiguration"],
          // 按名拼 ARN(而非跨栈引用):避免把 platform 栈钉在 ExecEnvDeploy 栈上,
          // 也避免"部署顺序反了就 synth 不出来"。名字是控制面单份常量(deploy-stack.ts 导出同一值)。
          resources: (r) => [`arn:aws:lambda:${r}:${acct}:function:bgp-exec-env-broker`],
        }),
        // 进度回读:build 整体状态 + 逐栈进度(§12.4 —— BatchGetBuilds 只报"BUILD in progress",
        // 逐栈进度必须去目标 region 读 CloudFormation)。两者都是**只读**。
        regionalStatement(this, {
          sid: "ExecEnvDeployProgressReadOnly",
          axis: "home",
          reason: "控制面单份:exec-env 部署用的 CodeBuild 项目只在 home(它跨 region 去部署,自身不复制)",
          // +BatchGetProjects —— 接线健康卡只读探项目在否(同一 ARN,零新增资源面)
          // +ListBuildsForProject —— 恢复分类的第二证据「项目列表里没有该 operation 的 build」
          //   (deploy-control.verifyNoBuildForOperation)。真环境撞过:代码用了、角色没给 ⇒ 查询失败被 fail-closed 吞成「无法查列表」,恢复照旧等 2h15m。
          actions: ["codebuild:BatchGetBuilds", "codebuild:BatchGetProjects", "codebuild:ListBuildsForProject"],
          resources: (r) => [`arn:aws:codebuild:${r}:${acct}:project/bgp-exec-env-deploy`],
        }),
        new iam.PolicyStatement({
          sid: "ExecEnvStackProgressReadOnly",
          // 🔴 收窄(销掉切片 b 留的 ⚠️):Resource 从 `*` 收到 `stack/BgpExecEnv-*`。
          //    region 段用 `*`(目标 region 运行期才知道,注册表里;无法在 IaC 枚举),
          //    但**资源名前缀**能收 —— §4.1a 保证栈组全叫 BgpExecEnv-*,于是本语句读不了控制面 21 栈。
          //    动作全部只读。⚠️ 配套:readBuildStatus 已改「按命名 SSOT 推定栈名、逐栈指名查询」——
          //    资源级授权下**无参列举会被拒**(第三个跨切片接缝,f 的 IAM × e 的代码,见 deploy-control.ts)。
          //    🔴 2b 补 `ListChangeSets`(仍在同一条窄语句/同一资源面,零新资源):
          //    失败恢复闸必须证明"目标 region 无进行中的基础设施动作",而**已创建但未执行的 change set**
          //    在 `DescribeStacks` 的 StackStatus 里看不见(栈状态仍是上一次的终态)。少了它,
          //    P0-E(批3)引入 changeset 预演后,恢复闸会把"待执行变更"误判成稳定 ⇒ fail-open。
          //    ⇒ 现在就补齐,不留"等批3 再想起来"的坑(见 DESIGN §20.25)。
          actions: [
            "cloudformation:DescribeStacks",
            "cloudformation:DescribeStackEvents",
            "cloudformation:ListChangeSets",
          ],
          resources: [`arn:aws:cloudformation:*:${acct}:stack/BgpExecEnv-*/*`],
        }),
      ],
    });

    // 删除执行环境收口时平台**自己真查**目标区(不信构建报告):
    //   栈 / VPC / 工作组 / 命名空间 / 经典 MWAA 的读权早已有(ExecEnvStackProgressReadOnly / NetworkAdvisorReadOnly / 探活那几条),
    //   缺的只有「最终快照在不在」这一个只读动作。独立 ManagedPolicy(内联已逼近 10KB,见上面 ExecEnvControl 的理由)。
    //   🔴 用 `requestedRegionCondition`(条件里已含全部执行 region),不新开 execution 轴调用点(那份名单冻结)。
    // 候选区按「组织 SCP 是否拦住部署必需动作」分出 blocked:
    //   拿**部署真正的身份**(CodeBuild build 角色;项目 serviceRole 经 BatchGetProjects 读,已授)做 SimulatePrincipalPolicy,
    //   看 `OrganizationsDecisionDetail.AllowedByOrganizations`。资源只到 build 角色那一族(CDK 生成名的固定前缀),只读、零副作用。
    new iam.ManagedPolicy(this, "ExecEnvDecommissionAndRegionProbe", {
      roles: [taskRole],
      statements: [
        new iam.PolicyStatement({
          sid: "DecommissionFinalSnapshotRead",
          actions: ["redshift-serverless:GetSnapshot"],
          resources: ["*"],
          conditions: { StringEquals: { "aws:RequestedRegion": requestedRegionCondition(this) } },
        }),
        new iam.PolicyStatement({
          sid: "CandidateRegionOrgPolicyProbe",
          actions: ["iam:SimulatePrincipalPolicy"],
          resources: [`arn:aws:iam::${acct}:role/BgpExecEnvDeployStack-ExecEnvBuildRole*`],
        }),
      ],
    });

    // Secrets Manager:仅平台命名空间 bgp/* + Redshift 托管密钥 redshift!* + 数据源密钥。
    // 读:GetSecretValue/DescribeSecret 是只读动作——放开到本账号本区域的 secret,因为数据源
    // 流程要读 RDS/OM 等 CDK 默认命名(BgpRdsStack…/BgpOmDatabaseStack…,无 bgp- 短横线前缀)
    // 的源库凭证。只读放宽到账号内、限本区域,安全可接受。
    taskRole.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "🔴 刻意不放宽:这是账号内 secret:* 的宽只读语句,跨 region 只读另有窄语句(redshift!* + 区域条件)兜住;把宽语句放到多 region = 爆炸半径翻倍,DESIGN §20 明确要求不动它",
      actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
      resources: (r) => [`arn:aws:secretsmanager:${r}:${acct}:secret:*`],
    }));
    // 🔴 **执行环境的 Redshift 托管 admin secret 在【目标 region】**,而上面那条只读语句的
    //    资源 ARN 把 region 写死成 home ⇒ 第二 region 的 secret 一律 describe 不到。
    //    (与  bug #7 同一轴:切片 f 修的是 `aws:RequestedRegion` **条件**,而**资源 ARN 里的
    //     region 段**是另一根轴 —— 26 处 region 写死的 ARN 里,只有"per-target 资源"这几处需要放开。)
    // 🔴 刻意**不去放宽上面那条 `secret:*`** —— 那会把"账号内全部 secret 只读"扩到所有 region,
    //    爆炸半径没必要。这里新增一条**窄语句**:仅 `redshift!*`(Redshift 服务生成名的固定前缀)
    //    + `requestedRegionCondition()` 把 region 限定在**已登记的执行环境 region 列表**内。
    //    用途:finalize 把组件栈吐的 `redshiftSecretName` 按名 DescribeSecret 换成真 ARN(§1.1 要 ARN 形态)。
    taskRole.addToPolicy(new iam.PolicyStatement({
      sid: "ExecEnvRedshiftManagedSecretRead",
      actions: ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"],
      resources: [`arn:aws:secretsmanager:*:${acct}:secret:redshift!*`],
      conditions: { StringEquals: { "aws:RequestedRegion": requestedRegionCondition(this) } },
    }));
    // ListSecrets 是 list 级动作,不作用于具体 secret 资源,必须 Resource:*(否则数据源"从 RDS
    // 选择"的发现接口报 not authorized——WS4a 收敛回归,经浏览器测试发现)。
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:ListSecrets"],
      resources: ["*"],
    }));
    // 写:严格限定到平台自管命名空间 bgp/* + bgp-*(数据源密钥),不允许改他人密钥。
    //
    // 🔴 **本批唯一从 home 轴翻成 execution 轴的语句**。
    // 原因(实测,不是推演):要给每个项目在**它的执行目标所在 region** 建 per-project
    // Redshift 凭证 secret(`bgp/project/<targetId>/<projectId>`)。region 段钉死 home 时,
    // 给非 home target 建 secret **必 AccessDenied** —— 这就是 50 ROADMAP §2quinquies 事实 ④
    // 记的那个"只能 home 先行"的硬阻塞。用户 2026-09-03 拍板「把 region ARN 根治提前一起做」。
    // 爆炸半径控制:① 资源仍严格限定 `bgp/*` + `bgp-*` 两个平台自管前缀(**没有放宽资源面**);
    //              ② region 由 `requestedRegionCondition` 收回**已登记的执行 region 列表**,
    //                 不是 `*`(未登记 region 依旧拒);③ 只读的宽语句仍留在 home 轴(见上)。
    // 🔴 per-project 凭证的**读 + 写 + 指标**收进一个独立 ManagedPolicy。
    //
    // ① **为什么改成 ManagedPolicy(不是继续 `taskRole.addToPolicy`)**:本批加了两条语句后
    //    synth-gate §9f 当场判红 —— TaskRole 的内联 DefaultPolicy 越过 CDK 的 10KB 拆分线,
    //    CDK 自动 `splitLargePolicy` 把**别的既有语句**重排进 `TaskRoleOverflowPolicy`
    //    (行为等价,但审计噪声大、语句落点漂移)。仓内惯例(`ExecEnvControl` /
    //    `DataSourceReadOnly` / `EmrServerlessOrchestration` 等 8 处先例)是新权限独立成
    //    ManagedPolicy。**片① 那条写语句一并搬进来**:三条讲的是同一件事(per-project 凭证),
    //    放在一起才是一个可审计、可整体回收的单元,而且给内联策略腾出余量。
    //
    // ② **写**(片①,用户 2026-09-03 拍板「把 region ARN 根治提前一起做」):要给每个项目在
    //    **它的执行目标所在 region** 建 secret;region 段钉死 home 时给非 home 建必 AccessDenied ——
    //    这就是 50 ROADMAP §2quinquies 事实 ④ 记的那个"只能 home 先行"的硬阻塞。
    //
    // ③ **读**(本轮新发现的硬缺口:片①**只**放开了写):`lookupProjectSecretArn` 要按名
    //    `DescribeSecret` 换真 ARN;`verifyProjectCredentials` 进 isolated 前要逐项目核存在性;
    //    Redshift Data API 用 `SecretArn` 执行时调用方还需 `GetSecretValue`。
    //    而账号内那条宽只读语句是 **home 轴**(`secret:*` 但 region 段钉死 home)⇒ 非 home 的
    //    per-project secret **读不到**。后果不是报错:它会被 `lookupProjectSecretArn` 解释成
    //    "没有凭证" ⇒ 过渡窗口内**静默回落共享 admin**(比报错坏得多),进 isolated 后整个项目不可用。
    //
    // 🔴 爆炸半径:写仍限 `bgp/*` + `bgp-*` 两个自管前缀(**没有放宽资源面**);读更窄,
    //    **只有** `bgp/project/*`;两条的 region 都由 `requestedRegionCondition` 收在
    //    已登记的执行 region 列表内(不是 `*`,未登记 region 依旧拒);账号内的宽只读仍留在 home 轴。
    new iam.ManagedPolicy(this, "ExecEnvProjectCredentials", {
      roles: [taskRole],
      statements: [
        regionalStatement(this, {
          sid: "ProjectCredentialSecretWrite",
          axis: "execution",
          reason: "per-project 凭证:secret 必须建在该项目执行目标所在 region,否则非 home 必 AccessDenied(资源面不放宽,仍限 bgp/* 与 bgp-*)",
          actions: [
            "secretsmanager:CreateSecret", "secretsmanager:UpdateSecret", "secretsmanager:PutSecretValue",
            "secretsmanager:DeleteSecret", "secretsmanager:TagResource",
          ],
          resources: (r) => [
            `arn:aws:secretsmanager:${r}:${acct}:secret:bgp/*`,
            `arn:aws:secretsmanager:${r}:${acct}:secret:bgp-*`,
          ],
        }),
        regionalStatement(this, {
          sid: "ProjectCredentialSecretRead",
          axis: "execution",
          reason: "per-project 凭证的读:DescribeSecret 换真 ARN + isolated 前置逐项目核存在性 + Data API 用 SecretArn 执行需 GetSecretValue;资源面收到只有 bgp/project/*(比写语句更窄)",
          actions: ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"],
          resources: (r) => [`arn:aws:secretsmanager:${r}:${acct}:secret:bgp/project/*`],
        }),
        // 🔴 **数据源密钥的读**(真环境无头验收当场抓到)。
        // 症状:usw2 视角建 JDBC 源 ⇒ HTTP 500
        //   `not authorized to perform: secretsmanager:GetSecretValue on .../secret:bgp/datasource/<id>`
        //   (region 段是 us-west-2)。根因是**非对称授权**:上面 `ProjectCredentialSecretWrite` 已是
        //   execution 轴(`bgp/*` 能在目标区**建**),而读那一半只有两条 —— 账号内的宽只读是 **home 轴**、
        //   `ProjectCredentialSecretRead` 的资源面只到 `bgp/project/*`。⇒ 建源在非 home
        //   「建得出、读不回」,整条建源失败并在那个区留下一个半截 secret(比直接拒更难清)。
        // 🔴 「能建就必须能读」是这类语句的**成对不变式**:一处放 execution 轴而另一处留 home 轴,
        //   症状一定是「在别的区做一半就 AccessDenied」。
        // 爆炸半径:资源面比写语句**更窄**(只 `bgp/datasource/*`,不含 `bgp/*` / `bgp-*`);
        //   region 仍由 `requestedRegionCondition` 收在**已登记的执行 region 列表**内(不是 `*`)。
        regionalStatement(this, {
          sid: "DataSourceSecretRead",
          axis: "execution",
          reason: "建源在非 home 时密钥建在该区(写语句已是 execution 轴),读回那一半若留在 home 轴 ⇒ 建完立刻 GetSecretValue 必 AccessDenied、留下半截 secret;资源面只到 bgp/datasource/*(比写语句更窄)",
          actions: ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"],
          resources: (r) => [`arn:aws:secretsmanager:${r}:${acct}:secret:bgp/datasource/*`],
        }),
        // 🔴 **建模窄权写者 secret 的读**(SPEC §3.9d.1:每个 target 一个
        //   `bgp/shared-writer/<targetSlug>`,建在该 target 所在 region)。写那一半已由 `ProjectCredentialSecretWrite`
        //   (execution 轴,`bgp/*`)覆盖;读那一半若不补,非 home 落地会「供给得出、按名 Describe 不回 /
        //   Data API 拿 SecretArn 执行时 GetSecretValue 被拒」——与上一条 DataSourceSecretRead 同一个成对不变式。
        //   资源面只到 `bgp/shared-writer/*`(比写语句更窄);region 仍由 requestedRegionCondition 收在已登记执行区内。
        regionalStatement(this, {
          sid: "SharedWriterSecretRead",
          axis: "execution",
          reason: "非 home 建模落地:窄权写者 secret 建在该 target 所在 region,按名 DescribeSecret 换 ARN + Data API 用 SecretArn 执行需 GetSecretValue;资源面只到 bgp/shared-writer/*(比写语句更窄)",
          actions: ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"],
          resources: (r) => [`arn:aws:secretsmanager:${r}:${acct}:secret:bgp/shared-writer/*`],
        }),
        // §3.9b「按 target·project 的指标」。`PutMetricData` **不支持资源级限定**(必须 Resource:*),
        // 所以爆炸半径靠 `cloudwatch:namespace` 条件收:只能往这一个命名空间写。
        // 🔴 命名空间字面量与 `lib/exec-env/cred-observability.CRED_METRIC_NAMESPACE` **必须逐字一致**
        //    —— 不一致的症状是"指标一直是 0",而 0 恰好也是我们想看到的值 ⇒ 极难发现。
        // 轴:刻意**不用** regionalStatement —— 本语句 Resource 是 `*`,没有 ARN 的 region 段可谈;
        //    指标统一发到平台所在 region,target 维靠 Dimensions 携带。
        new iam.PolicyStatement({
          sid: "ProjectCredentialMetrics",
          actions: ["cloudwatch:PutMetricData"],
          resources: ["*"],
          conditions: { StringEquals: { "cloudwatch:namespace": "BGP/ExecEnv" } },
        }),
      ],
    });
    // ──:residency-api 片 1 —— 区域审计 / 结果存储的读写 + 审计防篡改 Deny(SPEC v3.22 §3.3;DESIGN 6quinquies ③)──
    // 【为什么是 execution 轴】区域审计表 / 结果表 / 结果桶**建在跨法域 target 所在 region**(residency-stack),平台要往那个 region 写;
    //   资源面收到 `bgp-region-audit-*` / `bgp-region-results-*`(只可能是执行环境栈组建出来的名字),region 由 requestedRegionCondition 收在已登记执行 region。
    // 【为什么 Deny 在这里】审计完整性 = 「写不成即拒」+ 「写了改不了」。中央 `bgp-audit` 与区域审计表、同意留存表 `bgp-residency-acks`
    //   都只许 PutItem:对**平台自己的写身份**显式 Deny UpdateItem / DeleteItem / BatchWriteItem(上面那条 bgp-* 读写语句本来给了它们)。
    //   Deny 的 region 段刻意写 `*`:Deny 越宽越安全,且区域审计表在任意执行 region(这里不走 regionalStatement —— 它禁 execution 轴 + Deny)。
    //   `recordAudit` 只用 PutCommand + QueryCommand(lib/audit.ts),现网零 Update/Delete 调用 ⇒ 功能守恒。synth-gate §9 钉三动作 + 三表。
    new iam.ManagedPolicy(this, "ExecEnvResidency", {
      roles: [taskRole],
      statements: [
        regionalStatement(this, {
          sid: "RegionalAuditAndResultsWrite",
          axis: "execution",
          reason: "residency-api 片 1:区域审计全量 / 结果存储建在跨法域 target 所在 region,平台按 target 往那个 region 写(写不成即拒);资源面只有 bgp-region-audit-* 与 bgp-region-results-*",
          actions: ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:DescribeTable"],
          resources: (r) => [
            `arn:aws:dynamodb:${r}:${acct}:table/bgp-region-audit-*`,
            `arn:aws:dynamodb:${r}:${acct}:table/bgp-region-results-*`,
          ],
        }),
        new iam.PolicyStatement({
          sid: "RegionalResultsBucketRw",
          // 🔴 IAM 动作名是 `s3:GetReplicationConfiguration`(API 叫 GetBucketReplication,IAM 动作不同名)—— 2026-09-05 真环境探活被拒抓到;
          //    synth-gate §13 从此钉住这一类「API 名 ≠ IAM 动作名」的假名(HeadBucket / GetBucketEncryption / PutBucketReplication …)。
          actions: ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:GetBucketLocation", "s3:GetReplicationConfiguration"],
          resources: [`arn:aws:s3:::bgp-region-results-${acct}-*`, `arn:aws:s3:::bgp-region-results-${acct}-*/*`],
        }),
        // 中央两张(bgp-audit / bgp-residency-acks)只在 home ⇒ home 轴(regionalStatement 允许 home 轴 + Deny)
        regionalStatement(this, {
          sid: "DenyAuditTamperCentral",
          axis: "home",
          reason: "审计完整性:中央审计表与同意留存表只在 home 一份、只许 PutItem;对平台自己的写身份显式 Deny 改删(写了改不了)",
          effect: iam.Effect.DENY,
          actions: ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"],
          resources: (r) => [`arn:aws:dynamodb:${r}:${acct}:table/bgp-audit`, `arn:aws:dynamodb:${r}:${acct}:table/bgp-residency-acks`],
        }),
        // 区域审计表在任意执行 region ⇒ Deny 的 region 段刻意写 `*`(Deny 越宽越安全;regionalStatement 禁 execution 轴 + Deny,故直写)
        new iam.PolicyStatement({
          sid: "DenyAuditTamperRegional",
          effect: iam.Effect.DENY,
          actions: ["dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"],
          resources: [`arn:aws:dynamodb:*:${acct}:table/bgp-region-audit-*`],
        }),
      ],
    });
    // IAM:数据源自动建 Glue 角色——严格限定到唯一固定角色 bgp-glue-role(代码常量 GLUE_ROLE_NAME)。
    // 这是把原 IAMFullAccess 收敛到"只能动这一个角色",杜绝任意提权。
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "iam:GetRole", "iam:CreateRole", "iam:AttachRolePolicy", "iam:PutRolePolicy",
        "iam:ListAttachedRolePolicies", "iam:ListRolePolicies",
      ],
      resources: [`arn:aws:iam::${acct}:role/bgp-glue-role`],
    }));
    // PassRole:仅允许把 bgp-glue-role 传给 Glue 服务(收敛原 iam:PassRole *)。
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ["iam:PassRole"],
      resources: [`arn:aws:iam::${acct}:role/bgp-glue-role`],
      conditions: { StringEquals: { "iam:PassedToService": "glue.amazonaws.com" } },
    }));
    // EC2:数据源自动配网(创建/授权/删除安全组 + 只读发现)。EC2 SG 写操作多不支持资源级,
    // 用 Describe* 只读 + 写操作限本区域;后续可按 SG tag 进一步收敛。
    // 网络连通性顾问「一键修复」(network-advisor/apply.ts,以 TaskRole 身份直连 EC2)也用本块:
    //   enable-dns-attributes → ec2:ModifyVpcAttribute;create-s3-gateway-endpoint → ec2:CreateVpcEndpoint。
    //   缺这两个会致一键修复(白名单仅有的两个可执行类型)必 500 AccessDenied。
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "ec2:DescribeSecurityGroups", "ec2:DescribeVpcs", "ec2:DescribeSubnets", "ec2:DescribeNetworkInterfaces",
        "ec2:DescribeRouteTables",
        // **账号启用了哪些 region** 的账号级真值。
        //   新建执行环境的向导原来给的是**写死的 7 个区**候选表 ⇒ 真实账号里开第 8 个区在页面上选不到
        //   (而后端本来就 N 区自动:register 只校验 region 形态)。账号级动作 ⇒ 资源只能 `*`。
        "ec2:DescribeRegions",
        "ec2:CreateSecurityGroup", "ec2:DeleteSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress",
        "ec2:RevokeSecurityGroupIngress", "ec2:CreateTags",
        // 网络一键修复(可逆低风险动作):开 VPC DNS 属性 + 建 S3 Gateway Endpoint。
        "ec2:ModifyVpcAttribute", "ec2:CreateVpcEndpoint",
      ],
      resources: ["*"],
      conditions: { StringEquals: { "aws:RequestedRegion": requestedRegionCondition(this) } },
    }));
    // 网络连通性智能顾问的【只读】探测权限——独立成一个 ManagedPolicy 挂到 TaskRole,
    // 而非 addToPolicy 追加进内联 DefaultPolicy(内联策略已逼近 IAM 10KB 上限)。
    //  · L1 环境感知:路由表/NAT/VPC endpoint/NACL/可用区/VPC 属性(DNS)/前缀列表/对等连接/TGW 附着。
    //  · L1 目标解析:Redshift 集群/Serverless 工作组、Zero-ETL 集成、MSK、OpenSearch。
    // 全只读、本区域限定、零写操作——顾问【永久只读】,只给建议+教步骤,绝不擅自改网络。
    new iam.ManagedPolicy(this, "NetworkAdvisorReadOnly", {
      roles: [taskRole],
      statements: [
        new iam.PolicyStatement({
          actions: [
            "ec2:DescribeRouteTables", "ec2:DescribeVpcEndpoints", "ec2:DescribeNatGateways",
            "ec2:DescribeNetworkAcls", "ec2:DescribeAvailabilityZones", "ec2:DescribeVpcAttribute",
            "ec2:DescribePrefixLists", "ec2:DescribeVpcPeeringConnections", "ec2:DescribeTransitGatewayAttachments",
            "redshift:DescribeClusters",
            "redshift-serverless:GetWorkgroup", "redshift-serverless:GetNamespace", "redshift-serverless:ListWorkgroups",
            "rds:DescribeIntegrations",
            "kafka:DescribeClusterV2", "kafka:ListClustersV2", "kafka:GetBootstrapBrokers",
            "es:DescribeDomain", "es:DescribeDomains",
          ],
          resources: ["*"],
          conditions: { StringEquals: { "aws:RequestedRegion": requestedRegionCondition(this) } },
        }),
      ],
    });
    // 数据源生态:读【用户任意】DynamoDB 表 / S3 桶的【只读】权限。
    //   独立成 ManagedPolicy 挂 TaskRole(内联策略已逼近 IAM 10KB 上限,见 memory taskrole-inline-policy-10kb-limit)。
    //   🔴 诚实边界(与平台"最小权限收敛到 bgp-*"红线的显式权衡,用户 2026-07-29 拍板 Resource=*):
    //     DynamoDB/S3 数据源要能对接【用户既有的任意表/桶】(不像 bgp-* 是平台自建),故 introspect/ping/
    //     建外部表必须能读任意 DDB 表 / S3 桶。收敛手段:①全部【只读】(DescribeTable/Scan/GetObject/ListBucket,
    //     无任何写);②aws:RequestedRegion 限本区域;③独立 policy 便于审计/回收。DDB/S3 数据面同步(Glue)另见 bgp-glue-role。
    new iam.ManagedPolicy(this, "DataSourceReadOnly", {
      roles: [taskRole],
      statements: [
        // NoSQL(DynamoDB)源 introspect/ping:DescribeTable(键 schema/GSI)+ Scan(采样属性推断列)。只读。
        new iam.PolicyStatement({
          actions: ["dynamodb:DescribeTable", "dynamodb:Scan", "dynamodb:Query"],
          resources: ["*"], // 用户任意表(含 index);只读,region 条件收窄。
          conditions: { StringEquals: { "aws:RequestedRegion": requestedRegionCondition(this) } },
        }),
        // 对象存储(S3)源 introspect/ping:HeadBucket(=s3:ListBucket 语义)+ ListObjectsV2 + GetObject(CSV 采样头部)。只读。
        new iam.PolicyStatement({
          actions: ["s3:ListBucket", "s3:GetBucketLocation", "s3:GetObject"],
          resources: ["*"], // 用户任意桶 + 对象;只读。S3 桶为全局资源,ListBucket 不宜按 region 条件(会误伤跨区桶)。
        }),
        // S3 源分析通道:Athena 建外部表 + 直查,需 Glue Data Catalog 建 database/表元数据(bgp_s3_ext)+ Athena 执行。
        //   Glue 限本账号**每个执行区**的 catalog/database/table(外部表建在数据源所在区的目录,原来只放行主控区 ⇒
        //   第二区的 S3 源一建表就 AccessDenied);Athena 走该区自管 workgroup(已在别处授权则重复无害)。
        regionalStatement(this, {
          axis: "execution",
          reason: "S3 外部表随数据源落点建在该区 Glue 目录(bgp_s3_ext)—— 放行清单 = 主控区 ∪ 执行区,资源仍只限 bgp_s3_ext 库",
          actions: [
            "glue:CreateDatabase", "glue:GetDatabase", "glue:GetDatabases",
            "glue:CreateTable", "glue:UpdateTable", "glue:DeleteTable", "glue:GetTable", "glue:GetTables",
            "glue:GetPartitions",
          ],
          resources: (r) => [
            `arn:aws:glue:${r}:${acct}:catalog`,
            `arn:aws:glue:${r}:${acct}:database/bgp_s3_ext`,
            `arn:aws:glue:${r}:${acct}:table/bgp_s3_ext/*`,
          ],
        }),
        // Athena 查询执行(外部表直查):StartQueryExecution/GetQueryExecution/GetQueryResults 等。本区域限定。
        new iam.PolicyStatement({
          actions: [
            "athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults",
            "athena:StopQueryExecution", "athena:GetWorkGroup",
          ],
          resources: ["*"],
          conditions: { StringEquals: { "aws:RequestedRegion": requestedRegionCondition(this) } },
        }),
      ],
    });
    // 平台编排 EMR Serverless 的权限——独立成一个 ManagedPolicy 挂 TaskRole,
    // 而非 addToPolicy 追加进内联 DefaultPolicy(内联策略已逼近 IAM 10KB 上限,memory taskrole-inline-policy-10kb-limit)。
    //  · Create/DeleteApplication —— 拍板④⑤:后端按作业动态建/删 per-作业 application。
    //  · Start/Stop/Get/List/UpdateApplication + Start/Cancel/Get/ListJobRun —— 生命周期与运行编排。
    //  · PassRole 给 bgp-emr-serverless-role(收敛到唯一固定角色 + PassedToService 条件)。
    //  · CreateServiceLinkedRole 限 EMR Serverless —— 首次用需其 SLR(账号已存在则无副作用)。
    new iam.ManagedPolicy(this, "EmrServerlessOrchestration", {
      roles: [taskRole],
      statements: [
        new iam.PolicyStatement({
          actions: [
            "emr-serverless:CreateApplication", "emr-serverless:DeleteApplication",
            "emr-serverless:StartApplication", "emr-serverless:StopApplication",
            "emr-serverless:GetApplication", "emr-serverless:ListApplications", "emr-serverless:UpdateApplication",
            "emr-serverless:StartJobRun", "emr-serverless:CancelJobRun", "emr-serverless:GetJobRun",
            "emr-serverless:ListJobRuns", "emr-serverless:GetDashboardForJobRun", "emr-serverless:TagResource",
          ],
          resources: ["*"],
          conditions: { StringEquals: { "aws:RequestedRegion": requestedRegionCondition(this) } },
        }),
        new iam.PolicyStatement({
          actions: ["iam:PassRole"],
          resources: [`arn:aws:iam::${cdk.Stack.of(this).account}:role/bgp-emr-serverless-role`],
          conditions: { StringEquals: { "iam:PassedToService": "emr-serverless.amazonaws.com" } },
        }),
        new iam.PolicyStatement({
          actions: ["iam:CreateServiceLinkedRole"],
          resources: ["*"],
          conditions: { StringEquals: { "iam:AWSServiceName": "ops.emr-serverless.amazonaws.com" } },
        }),
        // EMR Serverless 提交/更新带 VPC networkConfiguration 的 application 时，EMR 会校验【调用者】
        // 对子网/SG 的 ENI 权限——缺失会报 "Unauthorized to create network interface"（实测踩坑）。
        // 只读 Describe + ENI 管理，本区域限定。
        new iam.PolicyStatement({
          actions: [
            "ec2:CreateNetworkInterface", "ec2:DeleteNetworkInterface",
            "ec2:DescribeNetworkInterfaces", "ec2:CreateNetworkInterfacePermission",
            "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups", "ec2:DescribeVpcs", "ec2:DescribeDhcpOptions",
          ],
          resources: ["*"],
          conditions: { StringEquals: { "aws:RequestedRegion": requestedRegionCondition(this) } },
        }),
      ],
    });
    // 角色顾问(Role Advisor)一键创建执行角色 —— 受控、不提权。
    //  · 权限边界(PermissionsBoundary):定义一键创建的作业角色【权限上限】。建出的角色实际权限 =
    //    内联策略 ∩ 本边界,即便推荐策略写宽也超不过这里,且明确【排除 iam:* / sts:AssumeRole】杜绝提权链。
    const jobRoleBoundary = new iam.ManagedPolicy(this, "JobRolePermissionsBoundary", {
      managedPolicyName: "bgp-job-role-boundary",
      description: "角色顾问一键创建的作业角色权限上限(最小权限作业执行 + 禁 IAM 写/禁提权)",
      statements: [
        new iam.PolicyStatement({
          sid: "AllowedJobActions",
          actions: [
            "secretsmanager:GetSecretValue",
            "s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation",
            "s3tables:*", "lakeformation:GetDataAccess",
            "glue:Get*", "glue:BatchGet*", "glue:CreateTable", "glue:UpdateTable", "glue:BatchCreatePartition",
            "redshift-data:*", "redshift-serverless:GetCredentials",
            "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams",
            // 🔴🔴 2026-09-22 真环境当场抓到(第七层):边界里**一条 `ec2:*` 都没有**,
            //   也**没有分片上传三件套** ⇒ 一键建出来的 EMR 角色即便把权限补齐了,
            //   `SimulatePrincipalPolicy` 仍报 `ec2:CreateNetworkInterface = implicitDeny`
            //   ——「补齐了权限」与「这个角色真能用」是**两件事**,中间卡着这个上限。
            //   平台建的 EMR Serverless application 挂在私有子网里,没有 ENI 权限就卡在启动阶段;
            //   Spark 写大文件走 multipart,只给 `PutObject` 会在写大结果时失败。
            //   ⇒ 补齐,并由闭合判据 `role-advisor/__tests__/boundary-covers-baseline.test.ts` 钉住
            //     「**引擎必备基线 ⊆ 本边界**」,免得下次再出现「策略给了、上限没给」。
            //   🔴 提权链仍被下面那条 Deny 硬封(iam:* / sts:AssumeRole),加这些不改变那条上限。
            "s3:AbortMultipartUpload", "s3:ListBucketMultipartUploads", "s3:ListMultipartUploadParts",
            "s3:GetObjectVersion",
            "ec2:CreateNetworkInterface", "ec2:DeleteNetworkInterface", "ec2:DescribeNetworkInterfaces",
            "ec2:CreateNetworkInterfacePermission", "ec2:DescribeNetworkInterfacePermissions",
            "ec2:DescribeSubnets", "ec2:DescribeVpcs", "ec2:DescribeSecurityGroups", "ec2:DescribeDhcpOptions",
            "secretsmanager:DescribeSecret",
            "dynamodb:DescribeTable", "dynamodb:Scan", "dynamodb:Query", "dynamodb:GetItem", "dynamodb:BatchGetItem",
            "kinesis:DescribeStream", "kinesis:DescribeStreamSummary", "kinesis:GetRecords",
            "kinesis:GetShardIterator", "kinesis:ListShards",
            "athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:StopQueryExecution",
          ],
          resources: ["*"],
        }),
        // 显式拒绝任何 IAM 写与 AssumeRole——边界内 Deny 是硬上限,建出的角色永远无法提权/改角色。
        new iam.PolicyStatement({
          sid: "DenyPrivilegeEscalation",
          effect: iam.Effect.DENY,
          actions: ["iam:*", "sts:AssumeRole", "organizations:*", "account:*"],
          resources: ["*"],
        }),
      ],
    });
    // 平台 TaskRole 一键创建作业角色的权限:严格限定角色名前缀 bgp-job-role-*,且创建时必须挂上述边界。
    new iam.ManagedPolicy(this, "RoleAdvisorProvisioning", {
      roles: [taskRole],
      statements: [
        // CreateRole:强制 PermissionsBoundary = 上面的边界(建角色时该 condition key 才存在;缺失/换别的边界则拒绝)。
        new iam.PolicyStatement({
          sid: "CreateJobRolesWithBoundary",
          actions: ["iam:CreateRole"],
          resources: [`arn:aws:iam::${cdk.Stack.of(this).account}:role/bgp-job-role-*`],
          conditions: { StringEquals: { "iam:PermissionsBoundary": jobRoleBoundary.managedPolicyArn } },
        }),
        // 其余角色管理动作(读/写内联策略)——不带 boundary condition(这些请求上下文无该 key,带了会因 key 缺失被拒)。
        // 仍严格限定到 bgp-job-role-* 前缀,且边界已保证这些角色的实际权限上限。
        new iam.PolicyStatement({
          sid: "ManageJobRolesWithinPrefix",
          actions: ["iam:GetRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:ListAttachedRolePolicies", "iam:ListRolePolicies", "iam:GetRolePolicy"],
          resources: [`arn:aws:iam::${cdk.Stack.of(this).account}:role/bgp-job-role-*`],
        }),
        // 只附加白名单托管策略(AWS 官方 service-role),不允许附任意托管策略。
        new iam.PolicyStatement({
          sid: "AttachApprovedManagedOnly",
          actions: ["iam:AttachRolePolicy"],
          resources: [`arn:aws:iam::${cdk.Stack.of(this).account}:role/bgp-job-role-*`],
          conditions: { ArnLike: { "iam:PolicyARN": "arn:aws:iam::aws:policy/service-role/AWSGlueServiceRole" } },
        }),
        // 🔴🔴 作业启动**前**的执行角色权限预检(2026-09-22 立;用户原话:「他需要知道这种任务需要
        //   添加哪些权限,而不是报错了之后我通过你改源代码重新发布解决问题。」)。
        //   `SimulatePrincipalPolicy` 是**只读**动作,改不了任何东西;资源面限定到平台自己的角色前缀。
        //   预检量不到(权限缺 / 被限流)时**不阻断作业**,但会如实回显「这次没被预检过」——
        //   见 `platform/src/lib/role-advisor/preflight.ts` 的三态说明。
        new iam.PolicyStatement({
          sid: "PreflightSimulateJobRoles",
          actions: ["iam:SimulatePrincipalPolicy"],
          resources: [`arn:aws:iam::${cdk.Stack.of(this).account}:role/bgp-*`],
        }),
        // 把建好的作业角色 PassRole 给对应服务(前缀限定 + PassedToService 条件)。
        new iam.PolicyStatement({
          sid: "PassJobRolesToServices",
          actions: ["iam:PassRole"],
          resources: [`arn:aws:iam::${cdk.Stack.of(this).account}:role/bgp-job-role-*`],
          conditions: { StringEquals: { "iam:PassedToService": ["glue.amazonaws.com", "emr-serverless.amazonaws.com", "dms.amazonaws.com", "kinesisanalytics.amazonaws.com"] } },
        }),
      ],
    });

    // 统一告警中心「邮件通道」的发信权限——独立成一个 ManagedPolicy 挂 TaskRole,
    // 而非 addToPolicy 追加进内联 DefaultPolicy(已逼近 IAM 10KB 上限,memory taskrole-inline-policy-10kb-limit)。
    // 仅 SES 发信(本区域);钉钉/企微/通用 webhook 走出站 fetch 无需 IAM。SES sandbox 下发件人/收件人
    // 须先验证身份,发信失败会如实记入告警事件的 channelResults(诚实行为,非假成功)。
    new iam.ManagedPolicy(this, "AlertingEmailSend", {
      roles: [taskRole],
      statements: [
        new iam.PolicyStatement({
          actions: ["ses:SendEmail"],
          resources: ["*"],
          conditions: { StringEquals: { "aws:RequestedRegion": requestedRegionCondition(this) } },
        }),
      ],
    });

    // FinOps 成本采集只读(L1 大盘数据源)。Cost Explorer 是全局控制面 API,
    // 不支持区域条件;ce:Get* 全只读、零改动面。引擎 per-run 计量(Glue/EMR/Athena)权限已有。
    new iam.ManagedPolicy(this, "FinOpsCostExplorerRead", {
      roles: [taskRole],
      statements: [
        new iam.PolicyStatement({
          actions: ["ce:GetCostAndUsage", "ce:GetCostForecast"],
          resources: ["*"],
        }),
      ],
    });

    // S3 Tables / Lake Formation / Athena 数据访问 + Cognito 用户管理 + Airflow/MWAA。
    // s3tables/lakeformation 资源 ARN 繁杂,限到本账号本区域(后续可细化到 bgp-table-bucket)。
    // 下面三个具名动作已被 s3tables:* 覆盖,写出字面是为了 IAM 调用清单(infra/iam/platform-taskrole-calls.json)
    //   的三层一致判据(清单里的动作 ⇒ 栈里有该字面)—— 建 / 改同步任务时探 S3 Tables 目标表(GetTable + 读元数据)用到。
    // GetTableBucket / ListNamespaces / ListTables —— 登记外部表桶前核它真在;外部表桶的命名空间 / 表进表树与问数。
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ["s3tables:*", "s3tables:ListTableBuckets", "s3tables:GetTable", "s3tables:GetTableData", "lakeformation:GetDataAccess",
        "s3tables:GetTableBucket", "s3tables:ListNamespaces", "s3tables:ListTables",
        // 数据目录「新建表」(S3 Tables)—— 同样已被 s3tables:* 覆盖,写出字面只为 IAM 调用清单
        "s3tables:CreateNamespace", "s3tables:CreateTable"],
      resources: ["*"],
      conditions: { StringEquals: { "aws:RequestedRegion": requestedRegionCondition(this) } },
    }));
    taskRole.addToPolicy(regionalStatement(this, {
      // Cognito 用户管理(用户管理页);限定到本账号的用户池。
      axis: "home",
      reason: "控制面单份:平台只有一个 Cognito 用户池(建在 home),身份不按 region 分片",
      actions: [
        "cognito-idp:ListUsers", "cognito-idp:AdminGetUser", "cognito-idp:AdminCreateUser",
        "cognito-idp:AdminSetUserPassword", "cognito-idp:AdminAddUserToGroup", "cognito-idp:AdminRemoveUserFromGroup",
        "cognito-idp:AdminListGroupsForUser", "cognito-idp:ListGroups", "cognito-idp:CreateGroup",
        // 用户管理页「禁用/启用用户」按钮(PUT action=disable/enable);缺这两个会 500 AccessDenied。
        "cognito-idp:AdminDisableUser", "cognito-idp:AdminEnableUser",
      ],
      resources: (r) => [`arn:aws:cognito-idp:${r}:${acct}:userpool/*`],
    }));
    // B8-FIX: MWAA's CreateWebLoginToken requires the caller's IAM identity to be mapped to
    // an Airflow web RBAC role — granted by allowing the action on the role-suffixed ARN
    // (environment/bgp-mwaa/<Role>), not just the bare environment ARN. Without it MWAA
    // returns "No Airflow role granted in IAM" (the /api/workflow/airflow 500). Grant Admin
    // so the platform's "open Airflow UI" link works for admins.
    taskRole.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "数据面(MWAA 编排)—— per-target MWAA 随后建;那时名字也会带 targetSlug(命名 SSOT mwaaEnvName),需连同资源名一起放开,不能只放 region",
      actions: ["airflow:CreateCliToken", "airflow:CreateWebLoginToken", "airflow:GetEnvironment", "airflow:InvokeRestApi"],
      resources: (r) => [
        `arn:aws:airflow:${r}:${acct}:environment/bgp-mwaa`,
        `arn:aws:airflow:${r}:${acct}:role/bgp-mwaa/Admin`,
      ],
    }));
    // 🔴 per-target MWAA(SPEC v3.26 §3.14):每个 target 自己的环境 `bgp-mwaa-<slug>`(命名 SSOT kind mwaaEnvName)。
    //    平台要在**该 target 所在 region** CreateCliToken(解挂 / 下线 / 触发)与 GetEnvironment(探活)⇒ execution 轴 +
    //    资源名放开到 `bgp-mwaa-*`(home 名 `bgp-mwaa` 不带连字符,不在此模式内;home 仍由上面那条 axis home 语句放行)。
    taskRole.addToPolicy(regionalStatement(this, {
      axis: "execution",
      reason: "per-target MWAA 建在各执行 region:解挂 / 下线 / 探活都要在该 region 拿 CLI token 与 GetEnvironment;资源名按 SSOT mwaaEnvName 的 target 模板 bgp-mwaa-<slug> 放开",
      actions: ["airflow:CreateCliToken", "airflow:CreateWebLoginToken", "airflow:GetEnvironment", "airflow:InvokeRestApi"],
      resources: (r) => [
        `arn:aws:airflow:${r}:${acct}:environment/bgp-mwaa-*`,
        `arn:aws:airflow:${r}:${acct}:role/bgp-mwaa-*/Admin`,
      ],
    }));
    // (K-5 网络规模):向导 / 详情页部署前 EIP 配额预检(只读两问:用量 + 上限)。
    //    每个执行环境标准档 2 NAT = 2 EIP,默认配额 5/区 ⇒ 第 3 个环境必在 CFN 里回滚;预检把它挪到点「开始部署」之前。
    //    🔴 独立 ManagedPolicy(仓内惯例):TaskRole 内联 DefaultPolicy 已近 10KB,再加即被 CDK 拆成 Overflow 策略(synth-gate 拦)。
    // (SPEC v3.27 §3.15):平台在**目标 region** 建 / 改 / 删 workflow、起停 run、读任务实例与 CloudWatch 任务日志;
    //    PassRole 只到 per-target 的 airflow-sls 执行角色。独立 ManagedPolicy(TaskRole 内联策略已近 10KB)。
    new iam.ManagedPolicy(this, "AirflowServerlessControl", {
      roles: [taskRole],
      statements: [
        // 🔴 (2026-09-07 真环境 sls 段撞到):CreateWorkflow **不支持资源级权限**(服务报错「on resource: …:workflow/*」即此意),
        //    名字限定 bgp* 对它永远不匹配 ⇒ AccessDenied;两区三引擎的发布全部倒在第一步。IAM 模拟器实测:连 `workflow/*` 字面都不行,只认 Resource "*"。
        //    资源模式错 ≠ 动作缺,那种「动作名守卫」抓不到 ⇒ 配 scripts/iam-simulate-gate.py(部署后按 infra/iam/platform-taskrole-calls.json
        //    对 TaskRole 做 SimulatePrincipalPolicy 离线模拟,任何 deny 即红);其余动作仍按 workflow 名字前缀 bgp* 收窄(ARN = workflow/<Name>-<随机>)。
        regionalStatement(this, {
          axis: "execution",
          reason: "CreateWorkflow 不支持资源级权限(服务按 workflow/* 报),只能 Resource *;仍绑 execution region(横移由 aws:RequestedRegion 拦)",
          actions: ["airflow-serverless:CreateWorkflow"],
          resources: () => ["*"],
        }),
        regionalStatement(this, {
          axis: "execution",
          reason: "MWAA Serverless workflow 与 run 都建在各执行 region:发布 / 触发 / 下线 / 观测都要在该 region 调 airflow-serverless API;资源名按 dag_id 前缀 bgp*(ARN = workflow/<Name>-<随机>)",
          actions: [
            "airflow-serverless:UpdateWorkflow", "airflow-serverless:DeleteWorkflow", "airflow-serverless:GetWorkflow",
            "airflow-serverless:ListWorkflowVersions", "airflow-serverless:StartWorkflowRun", "airflow-serverless:StopWorkflowRun", "airflow-serverless:GetWorkflowRun",
            "airflow-serverless:ListWorkflowRuns", "airflow-serverless:ListTaskInstances", "airflow-serverless:GetTaskInstance", "airflow-serverless:TagResource", "airflow-serverless:ListTagsForResource",
          ],
          resources: (r) => [`arn:aws:airflow-serverless:${r}:${acct}:workflow/bgp*`],
        }),
        regionalStatement(this, {
          axis: "execution",
          reason: "ListWorkflows 是账号级列举(资源只能 *);仍绑 execution region",
          actions: ["airflow-serverless:ListWorkflows"],
          resources: () => ["*"],
        }),
        new iam.PolicyStatement({
          actions: ["iam:PassRole"],
          resources: [`arn:aws:iam::${acct}:role/BgpExecEnv-*-airflow-sls-role`, `arn:aws:iam::${acct}:role/bgp-airflow-sls-role`],
          conditions: { StringEquals: { "iam:PassedToService": "airflow-serverless.amazonaws.com" } },
        }),
        // 🔴 (2026-09-07 真环境第三次撞,CloudTrail 坐实):CreateWorkflow **每次**都以调用者身份 FAS 调 iam:CreateServiceLinkedRole
        //    (SLR AWSServiceRoleForAmazonMWAAServerless 已存在也照调,已存在回 InvalidInputException 被服务容忍;无权则整个 CreateWorkflow 失败
        //    「Insufficient permissions to create a Service Linked Role」)。成功路径 FAS 全集 = 本条 + logs:CreateLogGroup,两条都进清单。
        //    精确到该 SLR + 服务名条件(与 EMR Serverless / AIDevOps 先例同款)。
        new iam.PolicyStatement({
          actions: ["iam:CreateServiceLinkedRole"],
          resources: [`arn:aws:iam::${acct}:role/aws-service-role/airflow-serverless.amazonaws.com/AWSServiceRoleForAmazonMWAAServerless`],
          conditions: { StringEquals: { "iam:AWSServiceName": "airflow-serverless.amazonaws.com" } },
        }),
        // 🔴 (2026-09-07 真环境第二次撞,CloudTrail 坐实):CreateWorkflow 时服务以**调用者身份**(invokedBy=airflow-serverless.amazonaws.com)
        //    代建默认日志组 /aws/mwaa-serverless/<workflow>/ ⇒ 调用者 TaskRole 必须有 logs:CreateLogGroup,否则服务回「Access denied to logGroup or KmsKey」。
        //    这是代码里看不见的 FAS(前向访问)调用 —— 清单 infra/iam/platform-taskrole-calls.json 按 CloudTrail 登记它,模拟门才盖得住。
        //    成功路径只有 CreateLogGroup(无 retention / tags / KMS;DeleteWorkflow 不删日志组)。
        regionalStatement(this, {
          axis: "execution",
          reason: "serverless run 的任务日志在该 region 的 CloudWatch /aws/mwaa-serverless/<workflow>/(GetTaskInstance 只回 LogStream 名);CreateLogGroup = 服务代调用者建默认日志组(FAS)",
          actions: ["logs:CreateLogGroup", "logs:GetLogEvents", "logs:DescribeLogStreams", "logs:FilterLogEvents"],
          resources: (r) => [`arn:aws:logs:${r}:${acct}:log-group:/aws/mwaa-serverless/*`, `arn:aws:logs:${r}:${acct}:log-group:/aws/mwaa-serverless/*:log-stream:*`],
        }),
      ],
    });
    // 取代 K-7 的 `EipPreflightReadOnly`(EIP 预检已随零出网下线)。
    // 探活两项 `network:egress-none` / `network:home-link` 要读的东西(SPEC §3.16-F):
    //   · 路由表 / NAT / VPC 端点:在**执行 region**(execution 轴,资源按 target 分布)
    //   · Route 53 私有托管域:IAM 里 route53 是**全局**服务(ARN 无 region 段)⇒ 不挂区域条件
    // 🔴 全部只读;判定逻辑在 probe-runner,不在 IAM。
    new iam.ManagedPolicy(this, "ZeroEgressProbeReadOnly", {
      roles: [taskRole],
      statements: [
        regionalStatement(this, {
          axis: "execution",
          // 第三项从「跨区端点 available」换成「跨区 peering active + 读对端网段」
          reason: "零出网探活:该 target 的路由表无默认出口、VPC 下无存活 NAT、跨区 peering active(资源都在执行 region)",
          actions: ["ec2:DescribeRouteTables", "ec2:DescribeNatGateways", "ec2:DescribeVpcPeeringConnections"],
          resources: () => ["*"],
        }),
        new iam.PolicyStatement({
          // route53 是全局服务:ARN 形如 arn:aws:route53:::hostedzone/Z…(**没有 region 段**)⇒
          // 挂 aws:RequestedRegion 会把它判死(调用一律记在 us-east-1)。故不挂条件,只收窄到只读两动作。
          actions: ["route53:GetHostedZone", "route53:ListResourceRecordSets"],
          resources: ["arn:aws:route53:::hostedzone/*"],
        }),
      ],
    });
    // 🔴 **已删除**:`vpce:AllowMultiRegion` 的那条特殊授权。
    //   给 CDK cfn-exec 角色逐字授了这个动作(通配符覆盖不到它),为的是建**跨区** DynamoDB 接口端点。
    //   2026-09-14 用 IAM 模拟器逐 action 量出真相:那个动作是被**组织 SCP** 拦的
    //   (`AllowedByOrganizations = False`,角色挂 `AdministratorAccess` 也一样)⇒ **账号内放不开**,
    //   授了也没用。跨区通路已改成 peering + 主控区同区端点 + 私有托管域(SPEC §3.14ter)。
    //   🔴 为什么要真删而不是留着:留着一条永远无效的授权 = 让下一个人以为「权限已经给了、是别的地方错」,
    //      而这正是它挂了三天没被看穿的原因(ROADMAP §2octies.58)。历史在 git 里。

    // (Athena 查询 S3 Tables): 执行查询 + 读结果。底层数据访问走 Glue 联邦目录
    // s3tablescatalog + lakeformation:GetDataAccess（已由上面的 lakeformation:*/glue:*/s3tables:* 覆盖），
    // 结果读写走 S3FullAccess（已具备）。此处仅补 Athena 控制面动作。
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "athena:StartQueryExecution",
        "athena:GetQueryExecution",
        "athena:GetQueryResults",
        "athena:StopQueryExecution",
        "athena:ListWorkGroups",
        "athena:GetWorkGroup",
        "athena:ListDataCatalogs",
        "athena:GetDataCatalog",
        "athena:ListDatabases",
        "athena:GetDatabase",
        "athena:ListTableMetadata",
        "athena:GetTableMetadata",
      ],
      resources: ["*"],
    }));
    // (故障诊断 / AWS DevOps Agent): 发现/创建 Agent Space、发起调查对话、读取
    // 调查记录与建议。signingName = aidevops。
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ["aidevops:*"],
      resources: ["*"],
    }));
    // DevOps Agent 首次调用需创建服务关联角色 AWSServiceRoleForAIDevOps;否则 CreateChat/SendMessage
    // 报 iam:CreateServiceLinkedRole 未授权(实测:诊断一直 failed 于此)。精确到该 SLR + 服务名条件。
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ["iam:CreateServiceLinkedRole"],
      resources: [`arn:aws:iam::${cdk.Stack.of(this).account}:role/aws-service-role/aidevops.amazonaws.com/AWSServiceRoleForAIDevOps`],
      conditions: { StringEquals: { "iam:AWSServiceName": "aidevops.amazonaws.com" } },
    }));
    // GenBI (智能问数): invoke Bedrock models via the Converse API for NL->SQL.
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:Converse",
        "bedrock:ConverseStream",
        // 跨区域 inference profile(us.anthropic.*)路由到各区 foundation model,需 GetInferenceProfile。
        "bedrock:GetInferenceProfile", "bedrock:ListInferenceProfiles",
        "bedrock:GetFoundationModel", "bedrock:ListFoundationModels",
      ],
      resources: ["*"],
    }));
    // (大模型访问必需): 首次调用 Anthropic 等第三方模型时,Bedrock 需要主体具备
    // AWS Marketplace 订阅动作来"启用模型访问",否则 Converse/InvokeModel 报 AccessDeniedException:
    // "not authorized to perform the required AWS Marketplace actions (aws-marketplace:ViewSubscriptions,
    // aws-marketplace:Subscribe)"。新账号常见坑(IAM 给了 bedrock:* 仍被拒)。授予订阅相关动作。
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "aws-marketplace:Subscribe",
        "aws-marketplace:ViewSubscriptions",
        "aws-marketplace:Unsubscribe",
      ],
      resources: ["*"],
    }));
    // (GenBI on AgentCore): 调用 AgentCore Runtime（数据面）+ 托管 Memory 读写
    //（短期事件 CreateEvent/ListEvents、长期语义召回 RetrieveMemoryRecords）。S3 genbi-memory 长期记忆
    // 读写已由 AmazonS3FullAccess 覆盖；自管短期记忆走 DynamoDB(已具备 DynamoDBFullAccess)。
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "bedrock-agentcore:InvokeAgentRuntime",
        "bedrock-agentcore:CreateEvent", "bedrock-agentcore:ListEvents", "bedrock-agentcore:GetEvent",
        "bedrock-agentcore:ListSessions", "bedrock-agentcore:ListActors",
        "bedrock-agentcore:RetrieveMemoryRecords", "bedrock-agentcore:ListMemoryRecords", "bedrock-agentcore:GetMemoryRecord",
        "bedrock-agentcore:GetMemory", "bedrock-agentcore:ListMemories",
      ],
      resources: ["*"],
    }));
    // (Observability 看板): AgentCore 控制面只读 + CloudWatch 指标读（技能 Lambda 指标）。
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "bedrock-agentcore:ListAgentRuntimes", "bedrock-agentcore:GetAgentRuntime",
        "bedrock-agentcore:ListGateways", "bedrock-agentcore:GetGateway",
        "bedrock-agentcore:ListGatewayTargets", "bedrock-agentcore:GetGatewayTarget",
        "cloudwatch:GetMetricStatistics", "cloudwatch:GetMetricData", "cloudwatch:ListMetrics",
      ],
      resources: ["*"],
    }));

    // (WS1 — 必需授权): DynamoDB 表用数据域 CMK 加密,TaskRole 必须能用该 key 解密/
    // 生成数据密钥,否则所有读写 bgp-* 表的接口返回 KMS AccessDenied(500)。授予最小动作集。
    props.dataKey.grant(
      taskRole,
      "kms:Decrypt",
      "kms:GenerateDataKey",
      "kms:DescribeKey"
    );

    // Public ALB but security group restricted to CloudFront only
    // (WS2 — 高可用): desiredCount 1→2(ECS 默认跨 AZ 分布,去单任务单点);并发滚动
    // 部署时保持至少 100% 健康容量,避免 50% 默认值在部署/重启期出现服务降级。
    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "BgpService", {
      cluster,
      serviceName: "bgp-platform",
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 2,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      taskImageOptions: {
        // 发版号进镜像:build-args 来自 git 事实(唯一作者 shared/build-info.ts);
        //   CDK 把 buildArgs 算进资产哈希 ⇒ 产品字节 / 发版 tag 变了才重建镜像,文档笔不会。
        image: ecs.ContainerImage.fromAsset("../platform", { buildArgs: platformImageBuildArgs() }),
        containerPort: 3000,
        taskRole,
        environment: {},
      },
      publicLoadBalancer: true,
      assignPublicIp: false,
    });

    service.targetGroup.configureHealthCheck({ path: "/", healthyHttpCodes: "200-399" });

    // (顺带:偶发 502 根治)
    // 🔴🔴 **Node 的 keep-alive 必须活得比 ALB 的空闲超时长**,否则会周期性出现无法复现的 502:
    //   ALB 复用一条 keep-alive 连接的**同一瞬间**,目标端(Node 默认 5s)正好把它关掉 ⇒
    //   ALB 自己产出 502(CloudWatch 上是 `HTTPCode_ELB_502_Count`,而 `HTTPCode_Target_5XX` 为 0、
    //   容器日志里一行错都没有、ECS 没有重启)。2026-09-16 全量硬门里实测两发:
    //   02:15 段 gbc(100 并发保存里 1 个 502)、02:25 段 wp18(两区发布 502)—— 各打红一整段,
    //   而同一个请求手动重放 2.3s 就 200。这是 AWS 官方文档点名的那条:目标端 keep-alive > ALB 空闲超时。
    // 🔴 空闲超时**显式写出来**(不吃 CDK 默认值):下面那条不变量拿它当基准,默认值一变就静默失配。
    const ALB_IDLE_TIMEOUT_SECONDS = 60;
    service.loadBalancer.setAttribute("idle_timeout.timeout_seconds", String(ALB_IDLE_TIMEOUT_SECONDS));
    // Next.js standalone 的 server.js 读 `KEEP_ALIVE_TIMEOUT`(毫秒)并赋给 `server.keepAliveTimeout`。
    // Node 18+ 起 `headersTimeout` 不再把 keep-alive 的空闲时间算进去 ⇒ 只调这一个就够。
    const NODE_KEEP_ALIVE_TIMEOUT_MS = (ALB_IDLE_TIMEOUT_SECONDS + 5) * 1000;

    // (WS2 — 弹性伸缩): 目标追踪自动扩缩(CPU 60% / 内存 70%),min 2 ~ max 6。
    // 应对流量峰值与单任务故障自愈,同时设下限保证常态高可用。
    const scaling = service.service.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 6 });
    scaling.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.seconds(120),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });
    scaling.scaleOnMemoryUtilization("MemScaling", { targetUtilizationPercent: 70 });

    // Export ALB DNS for DAG generator
    const albDns = service.loadBalancer.loadBalancerDnsName;
    this.albSecurityGroup = service.loadBalancer.connections.securityGroups[0];

    // 「按时跑一次平台动作」的主控区一侧(说明见 action-dispatch.ts)。
    //   放在平台栈里:ALB 的 SG 在这里(要给分发 Lambda 开入站),命令表的 Stream ARN 也不必跨栈导出。
    const actionDispatch = new ActionDispatch(this, "ActionDispatch", {
      vpc: props.vpc,
      dataKey: props.dataKey,
      albSecurityGroup: this.albSecurityGroup,
      loadBalancerFullName: service.loadBalancer.loadBalancerFullName,
      listenerPort: 80,
    });

    // Add ALB DNS to container environment (self-reference via update)
    const cfnTaskDef = service.taskDefinition.node.defaultChild as cdk.aws_ecs.CfnTaskDefinition;
    cfnTaskDef.addPropertyOverride("ContainerDefinitions.0.Environment", [
      ...Object.entries({
        AWS_REGION: cdk.Stack.of(this).region,
        AWS_ACCOUNT_ID: cdk.Stack.of(this).account,
        // 见上:必须 > ALB 空闲超时,否则偶发 502(判据 N0-17 在真环境比这两个数)
        KEEP_ALIVE_TIMEOUT: String(NODE_KEEP_ALIVE_TIMEOUT_MS),
        // 内部端点守卫按这个 ARN 读共享密钥(没配 ⇒ 503 fail-closed)
        ACTION_DISPATCH_SECRET_ARN: actionDispatch.secret.secretArn,
        ACTION_COMMANDS_TABLE: actionDispatch.table.tableName,
        NEXT_PUBLIC_COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
        NEXT_PUBLIC_COGNITO_CLIENT_ID: props.cognitoClientId,
        COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
        COGNITO_CLIENT_ID: props.cognitoClientId,
        REDSHIFT_WORKGROUP: resourceName("redshiftWorkgroup", { targetId: HOME_TARGET_ID }),
        REDSHIFT_DATABASE: "dev",
        // 注入 ECS 容器的默认模型走全平台 SSOT(ai-model.json,当前 sonnet-4-5);env 可覆盖。
        BEDROCK_MODEL_ID: resolveModelId(),
        GLUE_SCRIPTS_BUCKET: `bgp-glue-scripts-${cdk.Stack.of(this).account}`,
        GLUE_ROLE_ARN: glueRole.roleArn,
        MWAA_DAG_BUCKET: `bgp-mwaa-dags-${cdk.Stack.of(this).account}`,
        MWAA_ENV_NAME: "bgp-mwaa",
        // 让平台**知道自己被烘入了哪些 region**(与上面 IAM 条件同一份解析结果),
        //   注册 / 探活 / 列表据此把「控制面尚未放行该 region」说成人话 + 运维命令(init 段 I-4 真撞:页面只见 9 行「描述符缺 resources.*」)。
        EXECUTION_REGIONS: ((): string => { const v = requestedRegionCondition(this); return Array.isArray(v) ? v.join(",") : v; })(),
        // Strangler 并行双引擎开关(照 GENBI_BACKEND 范式)。默认 legacy = 旧字符串拼接
        // 生成器,默认行为零变化;切新引擎(runtime 库+富节点):部署带 -c workflow-dag-engine=runtime-lib。
        WORKFLOW_DAG_ENGINE: (this.node.tryGetContext("workflow-dag-engine") as string) || "legacy",
        // per-project 凭证身份的开关(照上面 WORKFLOW_DAG_ENGINE / GENBI_BACKEND 同一范式)。
        // 🔴 缺省 **off** = 现网行为逐字节不变(平台侧 `perProjectCredEnabled()` 只认字面量 `on`)。
        // 🔴 **开它之前必须先有**:per-project 身份只看得见 `proj_<id>` 与 `shared`,
        //    而现网数据仍在 `public` ⇒ 现在开会让 SQL 编辑器/问数查不到存量表。
        //    验收时用 `-c per-project-cred=on` 单独部署一轮**只验隔离属性**(见 50 ROADMAP §2septies.2③)。
        PER_PROJECT_CRED: (this.node.tryGetContext("per-project-cred") as string) || "off",
        // 数据面长作业的**停泵开关**(平台侧只认字面 `1`;缺省 `0` = 泵照常推进)。
        //   紧急时 `-c dataplane-jobs-paused=1` 重部署即可停泵(入队照常、推进全停、内部端点回 503),不必回滚镜像。
        BGP_DATAPLANE_JOBS_PAUSED: (this.node.tryGetContext("dataplane-jobs-paused") as string) === "1" ? "1" : "0",
        // 「绑定即自动供给」缺省 **off**(平台侧只认字面 `on`)。
        //   🔴 开它之前必须先有 9b 搬迁 / 只读授权:非主控区项目一被供给就改用项目身份,而现网数据在 `public`。
        BGP_DATAPLANE_AUTO_SUPPLY: (this.node.tryGetContext("dataplane-auto-supply") as string) === "on" ? "on" : "off",
        // 数据面凭证三态(平台侧 `dataPlaneCredsMode()` 只认 observe / enforce)。
        //   缺省 **taskrole** = 现网行为不变;`-c dataplane-creds=observe` 跑一轮全量硬门量角色策略缺口(place.creds.denied),
        //   缺口归零后才切 enforce 并收回任务角色的数据面直授。
        BGP_DATAPLANE_CREDS: ((v) => (v === "observe" || v === "enforce" ? v : "taskrole"))(this.node.tryGetContext("dataplane-creds") as string),
        // 长操作「进程内等多久才转 202」(毫秒;平台侧 lib/long-ops/store.ts SYNC_WAIT_MS 唯一读点)。
        //   缺省 **45000**(< CloudFront origin 60s 墙);🔴 这是验收开关(与 -c dataplane-creds 同类):测试账号 `-c long-ops-sync-wait-ms=500`
        //   把每条已接入路由逼进 202 路径做页面驱动验收;生产**不要**给,重部署不带它就回缺省。非正整数一律回缺省,不接受 0。
        LONG_OPS_SYNC_WAIT_MS: ((v) => (/^[1-9]\d*$/.test(String(v ?? "")) ? String(v) : "45000"))(this.node.tryGetContext("long-ops-sync-wait-ms") as string | undefined),
        ATHENA_WORKGROUP: athenaWorkgroup.name,
        ATHENA_OUTPUT_LOCATION: athenaOutputLocation,
        S3TABLES_BUCKET: "bgp-table-bucket",
        S3TABLES_CATALOG: "s3tablescatalog",
        S3TABLES_NAMESPACE: "ecommerce",
        // GenBI on AgentCore：后端开关 + Runtime ARN + 长期记忆桶。
        // 默认 inprocess 回退；切 AgentCore：部署平台时带 -c genbi-backend=agentcore -c genbi-runtime-arn=<arn>。
        GENBI_BACKEND: (this.node.tryGetContext("genbi-backend") as string) || "inprocess",
        GENBI_RUNTIME_ARN: (this.node.tryGetContext("genbi-runtime-arn") as string) || "",
        GENBI_MEMORY_BUCKET: `bgp-datalake-${cdk.Stack.of(this).account}`,
        // v1.29.0 — 可切换记忆后端：selfmanaged(默认, DynamoDB+S3) | agentcore(托管 Memory)。
        // 切 AgentCore 托管记忆：部署平台时带 -c genbi-memory-backend=agentcore -c genbi-memory-id=<MemoryId>。
        GENBI_MEMORY_BACKEND: (this.node.tryGetContext("genbi-memory-backend") as string) || "selfmanaged",
        GENBI_MEMORY_ID: (this.node.tryGetContext("genbi-memory-id") as string) || "",
        // GenBI 异步化执行(根治 CloudFront 60s 同步超时):提交→轮询→取结果。
        // "1"/"true"=异步(POST 秒回 taskId,前端轮询驱动执行,300s 强制天花板);其余=同步(零回归)。
        // 治线上活 bug + 零行为回归,默认开;需回退带 -c genbi-async=0。
        GENBI_ASYNC: (this.node.tryGetContext("genbi-async") as string) || "1",
        // 网络连通性顾问 on AgentCore：后端开关 + Runtime ARN + 可切换托管记忆。
        // 默认 inprocess 回退(进程内实现一份两用)；切 AgentCore：部署平台时带
        // -c netadvisor-backend=agentcore -c netadvisor-runtime-arn=<arn> -c netadvisor-memory-backend=agentcore -c netadvisor-memory-id=<MemoryId>。
        NETADVISOR_BACKEND: (this.node.tryGetContext("netadvisor-backend") as string) || "inprocess",
        NETADVISOR_RUNTIME_ARN: (this.node.tryGetContext("netadvisor-runtime-arn") as string) || "",
        NETADVISOR_MEMORY_BACKEND: (this.node.tryGetContext("netadvisor-memory-backend") as string) || "selfmanaged",
        NETADVISOR_MEMORY_ID: (this.node.tryGetContext("netadvisor-memory-id") as string) || "",
        // 参数辅助顾问 on AgentCore(标准第二个实现):同款开关矩阵。
        // 切 AgentCore:部署平台时带 -c paramadvisor-backend=agentcore -c paramadvisor-runtime-arn=<arn>
        // -c paramadvisor-memory-backend=agentcore -c paramadvisor-memory-id=<MemoryId>。
        PARAMADVISOR_BACKEND: (this.node.tryGetContext("paramadvisor-backend") as string) || "inprocess",
        PARAMADVISOR_RUNTIME_ARN: (this.node.tryGetContext("paramadvisor-runtime-arn") as string) || "",
        PARAMADVISOR_MEMORY_BACKEND: (this.node.tryGetContext("paramadvisor-memory-backend") as string) || "selfmanaged",
        PARAMADVISOR_MEMORY_ID: (this.node.tryGetContext("paramadvisor-memory-id") as string) || "",
        OPENMETADATA_URL: props.openMetadataUrl || "",
        OPENMETADATA_PUBLIC_URL: props.openMetadataUrl || "",
        PLATFORM_ALB_DNS: albDns,
        DEFAULT_VPC_ID: props.vpc.vpcId,
        DEFAULT_SUBNET_ID: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds[0],
        DEFAULT_AZ: props.vpc.availabilityZones[0],
        // 实时 CDC:稳定标识由 account/region 派生(不再靠每次部署传 context)。
        //  · 复制实例 ARN 不注入:它随 BgpRealtimeStack destroy/recreate 漂移,改由运行时按稳定
        //    id(bgp-dms)发现(见 lib/realtime/dms-service.ts getReplicationInstanceArn)。实例不
        //    存在(实时栈未拉起/已止血)时,实时启动 API 运行时返回 503。
        //  · DMS 角色名 bgp-dms-kinesis-role、Redshift workgroup/host 均为固定命名,可确定性派生。
        REDSHIFT_NAMESPACE: "bgp-namespace",
        REDSHIFT_HOST: `bgp-workgroup.${cdk.Stack.of(this).account}.${cdk.Stack.of(this).region}.redshift-serverless.amazonaws.com`,
        // DMS 经典实例模式(决策回退:常驻复制实例 bgp-dms,task 启动 1-3min)。复制实例由门控
        // BgpRealtimeStack 提供;服务层运行时按稳定 id 发现实例 ARN(免静态 ARN 漂移)。未拉起时
        // 实时启动 API 返回 503。
        DMS_REPLICATION_INSTANCE_ID: "bgp-dms",
        DMS_ROLE_ARN: `arn:aws:iam::${cdk.Stack.of(this).account}:role/bgp-dms-kinesis-role`,
        DMS_TARGET_SECRET_ID: "bgp/dms/redshift-target",
        // (实时计算 Flink) — MSAF 编排所需稳定标识(account/region 确定性派生,免跨栈依赖)。
        //  · 角色/源流/代码 JAR 位置固定命名;BgpFlinkStack 未拉起时,Flink 启动 API 运行时返回 503。
        // Flink 运行时版本(单一事实来源)。升级:`-c flink-runtime=FLINK-1_21` 或改此默认值,零代码改动。
        FLINK_RUNTIME_ENVIRONMENT: (this.node.tryGetContext("flink-runtime") as string) || "FLINK-1_20",
        FLINK_RUNTIME_ROLE_ARN: `arn:aws:iam::${cdk.Stack.of(this).account}:role/bgp-flink-role`,
        FLINK_SOURCE_STREAM: "bgp-flink-source",
        FLINK_CODE_BUCKET: `bgp-glue-scripts-${cdk.Stack.of(this).account}`,
        FLINK_CODE_KEY: "flink/flink-sql-runner.jar",
        FLINK_OUTPUT_BUCKET: `bgp-datalake-${cdk.Stack.of(this).account}`,
        FLINK_SUBNET_IDS: cdk.Fn.join(",", props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds),
        // S3 Tables(托管 Iceberg)连接器包代码 JAR(与基础 runner 同为 Flink 1.20,只是多打 Iceberg)
        //  + 表桶/命名空间标识(配置驱动)。运行时版本统一走上面的 FLINK_RUNTIME_ENVIRONMENT,不另设版本。
        FLINK_S3T_CODE_KEY: "flink/flink-sql-runner-s3t.jar",
        // Bug#5 — Kafka/MSK 源 → S3 Tables 组合包(s3t + kafka connector + msk-iam-auth + relocation)。
        // 装配路由(flink-connectors.ts)对"kafka源+iceberg sink"选它;纯 iceberg 仍用上面的 s3t 包(零回归)。
        FLINK_S3T_KAFKA_CODE_KEY: "flink/flink-sql-runner-s3t-kafka.jar",
        FLINK_S3TABLES_BUCKET: "bgp-table-bucket",
        FLINK_S3TABLE_DB: "realtime",
        // (离线多引擎 EMR Serverless) — 编排所需稳定标识(account 确定性派生,免跨栈依赖;
        // 防跨栈 export 钉栈,memory cdk-cross-stack-export-deadlock)。角色/桶固定命名;BgpEmrStack
        // 未拉起时,后端 CreateApplication 会因执行角色不存在而报错(作业存 draft,不阻断)。
        //  · 默认子网/SG 供前端连接信息区兜底(用户建作业未填时用私有子网 + bgp-emr-sg)。
        EMR_EXECUTION_ROLE_ARN: `arn:aws:iam::${cdk.Stack.of(this).account}:role/bgp-emr-serverless-role`,
        // 角色顾问一键创建的作业角色必挂的权限边界(防提权;缺失则后端拒绝创建)。
        ROLE_PERMISSIONS_BOUNDARY_ARN: jobRoleBoundary.managedPolicyArn,
        // 回落值必须等于平台 lib/engines/emr/spec.ts 的 EMR_DEFAULT_RELEASE(infra 不能 import platform ⇒ 字面量 + 单测 spec.test.ts 钉两处一致)
        EMR_RELEASE_LABEL: (this.node.tryGetContext("emr-release") as string) || "emr-spark-8.0.0",
        EMR_CODE_BUCKET: `bgp-glue-scripts-${cdk.Stack.of(this).account}`,
        EMR_OUTPUT_BUCKET: `bgp-datalake-${cdk.Stack.of(this).account}`,
        EMR_LOG_BUCKET: `bgp-datalake-${cdk.Stack.of(this).account}`,
        EMR_DEFAULT_SUBNET_IDS: cdk.Fn.join(",", props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds),
        // S3 Tables（Iceberg）支持：runtime JAR（预置到脚本桶 emr-jars/）+ 表桶 warehouse ARN。
        // 平台在 submit 时自动注入 catalog 配置，用户脚本直接 spark.table("s3tablescatalog.ns.tbl")。
        EMR_S3TABLES_JAR: `s3://bgp-glue-scripts-${cdk.Stack.of(this).account}/emr-jars/s3-tables-catalog-for-iceberg-runtime-0.1.8.jar`,
        // 🔴 这不是 IAM 语句、是**环境变量的缺省值** —— 主控区那只表桶的 warehouse ARN。
        //   非 home 的 EMR 作业从该 target 的资源袋取**实名**表桶(不读本变量),所以它天然只该是 home 的值。
        EMR_S3TABLES_WAREHOUSE_ARN: `arn:aws:s3tables:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:bucket/bgp-table-bucket`, // region-axis-exempt: 环境变量缺省值,不是 IAM 语句;非 home 从资源袋取实名表桶
      }).map(([name, value]) => ({ Name: name, Value: value })),
    ]);

    // Lock down ALB SG: remove default 0.0.0.0/0, allow only CloudFront prefix list
    const albSg = service.loadBalancer.connections.securityGroups[0];
    const cfnSg = albSg.node.defaultChild as ec2.CfnSecurityGroup;

    // Remove the default wide-open ingress by clearing SecurityGroupIngress
    cfnSg.addPropertyOverride("SecurityGroupIngress", []);

    // Add CloudFront managed prefix list as ingress source.
    // IMPORTANT: the CloudFront origin-facing managed prefix list
    // (com.amazonaws.global.cloudfront.origin-facing) has a DIFFERENT id per region.
    // Hardcoding us-east-1's id breaks deployment in any other region.
    // 表与失败语义收进单一作者(原来这里与 om-service-stack 各一份,
    //   而且那一份查不到是**静默跳过**;详见 lib/shared/cloudfront-prefix-list.ts 的说明)。
    // region 已在上方 TaskRole 收敛块声明(WS4a),此处复用。
    const prefixListId = cloudfrontOriginFacingPrefixList(this); // 部署期按名查本区真值(h)
    const cfPrefixListId = ec2.Peer.prefixList(
      ec2.PrefixList.fromPrefixListId(this, "CfPrefixList", prefixListId).prefixListId
    );
    albSg.addIngressRule(cfPrefixListId, ec2.Port.tcp(80), "Allow CloudFront only");
    albSg.addIngressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(80), "Allow VPC internal");

    // CloudFront distribution → public ALB (restricted by SG)
    const distribution = new cloudfront.Distribution(this, "BgpCdn", {
      defaultBehavior: {
        origin: new origins.HttpOrigin(service.loadBalancer.loadBalancerDnsName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          // GenBI (智能问数) issues a long synchronous request (Redshift query + multi-step
          // Bedrock Opus reasoning) that can exceed CloudFront's default 30s origin timeout
          // and return 504. Raise to the 60s maximum (values >60s need a CloudFront quota
          // increase). Keep-alive bumped to match.
          readTimeout: cdk.Duration.seconds(60),
          keepaliveTimeout: cdk.Duration.seconds(60),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // i18n:用 ALL_VIEWER_AND_CLOUDFRONT_2022(= ALL_VIEWER 的全部转发 + 追加 CloudFront-Viewer-*
        // 地理头)。/api/public/locale 据 CloudFront-Viewer-Country 按访客 IP 建议初始语种;
        // 未透传时该端点自动回退 Accept-Language,故此项非阻塞。
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_AND_CLOUDFRONT_2022,
      },
      // (WS4b-1): 关联 WAF WebACL(若提供)。边缘拦截恶意流量,不影响正常请求。
      webAclId: props.webAclArn,
    });

    new cdk.CfnOutput(this, "PlatformUrl", {
      value: `https://${distribution.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, "DistributionId", {
      value: distribution.distributionId,
    });
  }
}
