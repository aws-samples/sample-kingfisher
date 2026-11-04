// 执行环境 **airflow-serverless 组件**栈(50 SPEC v3.27 §3.15;§1.1 资源袋:`workflowBucket` / `airflowServerlessRoleArn` / `airflowServerlessSgId`)。
//
// 【为什么有它】用户拍板(2026-09-06,DESIGN §18 决策 6septies):「原来的 MWAA 先保留着,新增一个 MWAA Serverless 的入口」;宗旨「服务层面尽量 serverless」。
//   经典 MWAA 每区建环实测 35 分钟、常驻 ≈$350/月;Serverless 没有环境可建 —— 本栈只放三样**分钟级、零常驻**的东西:
//   ① 定义 / 代码包桶(服务按 S3 VersionId 快照,必须 versioned;必须与 workflow 同 region,跨区桶 301);
//   ② 工作 SG(自引用 inbound all + egress all,官方要求);子网用底座私有子网(有 NAT);
//   ③ 执行角色(信任 airflow-serverless.amazonaws.com;策略一律 boundStatement 绑本 region)。
//   workflow 本身**不在这里建**:一个作业一个 workflow,由平台在发布调度时 CreateWorkflow / UpdateWorkflow(§3.15)。
//
// 【spike 七跑坐实的三条硬约束,全部落在本栈】
//   · 🔴 默认网络只通同区 AWS 端点 ⇒ 跨区回写 home 台账**必须 VPC 模式** ⇒ 本栈给出 SG(子网来自底座),平台 CreateWorkflow 必带 NetworkConfiguration;
//   · GlueJobOperator 走幂等 CreateJob ⇒ 角色要 glue:CreateJob / UpdateJob(限 job/bgp-*);
//   · 控制面回写 = 与 mwaa 栈**完全相同**的唯一跨区例外(home bgp-* 表 + kms via dynamodb.<home>)。
//
// 🔴 信任策略按官方样例(无 aws:SourceAccount 条件):该服务的 AssumeRole 是否带 SourceAccount 未经真环境验证,先不加条件 —— 加了要真测。
// 🔴 数据保护:桶 RETAIN、不带 autoDeleteObjects(exec-env 纪律)。资源文案一律英文(IAM Latin-1 / SG ASCII)。
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { HOME_TARGET_ID, resourceName } from "../shared/naming";
import { ExecEnvStack, type ExecEnvStackProps } from "./exec-env-stack";
import { boundStatement, bucketArnPair, execRoleArnOf, REDSHIFT_DATA_ACTIONS, S3_RO_ACTIONS } from "./exec-roles";

export interface ExecEnvAirflowServerlessStackProps extends ExecEnvStackProps {
  /** 底座 VPC:工作 SG 建在这里;子网(私有 ×2,有 NAT)由平台在 CreateWorkflow 时从资源袋 privateSubnetIds 取。 */
  vpc: ec2.IVpc;
}

export class ExecEnvAirflowServerlessStack extends ExecEnvStack {
  constructor(scope: Construct, id: string, props: ExecEnvAirflowServerlessStackProps) {
    super(scope, id, props);
    const { ctx, vpc } = props;
    const homeRegion = ctx.homeRegion;
    if (!homeRegion) throw new Error(`ExecEnvAirflowServerlessStack(${ctx.targetId}):缺 homeRegion —— 该区 workflow 回写 home 运行台账,必须知道控制面 region`);
    const p = cdk.Aws.PARTITION;
    const slug = ctx.targetId.replace(/_/g, "-");
    const bucketName = resourceName("workflowBucket", { targetId: ctx.targetId, account: ctx.account });
    const scriptsBucketName = resourceName("scriptsBucket", { targetId: ctx.targetId, account: ctx.account });

    // ── 定义 / 代码包桶(服务按 VersionId 快照 ⇒ versioned;同 region;RETAIN)────────────
    const bucket = new s3.Bucket(this, "WorkflowBucket", {
      bucketName,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── 工作 SG(官方要求:自引用 inbound all + egress all)────────────────────────────
    const sg = new ec2.SecurityGroup(this, "WorkerSg", {
      vpc,
      securityGroupName: resourceName("airflowServerlessSg", { targetId: ctx.targetId, account: ctx.account }),
      description: `BGP exec-env ${ctx.targetId} MWAA Serverless worker security group`,
      allowAllOutbound: true,
    });
    sg.addIngressRule(sg, ec2.Port.allTraffic(), "MWAA Serverless self-reference");

    // ── 执行角色(per-target 名;信任 airflow-serverless 服务主体)──────────────────────
    const role = new iam.Role(this, "ExecutionRole", {
      // 🔴 字面调用 resourceName(命名门禁靠这条形状放行 home 模板;home 由b 的 BgpAirflowServerlessStack 建)
      roleName: resourceName("airflowServerlessRole", { targetId: ctx.targetId, account: ctx.account }),
      assumedBy: new iam.ServicePrincipal("airflow-serverless.amazonaws.com"),
      description: `BGP exec-env ${ctx.targetId} MWAA Serverless execution role (bound to this target; control-plane run ledger write-back is the only cross-region grant)`,
    });
    // 任务日志(服务默认落 /aws/mwaa-serverless/<workflow>/)
    role.addToPolicy(
      boundStatement(ctx, {
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
        resources: [`arn:${p}:logs:${ctx.region}:${ctx.account}:log-group:/aws/mwaa-serverless/*`],
      })
    );
    role.addToPolicy(boundStatement(ctx, { actions: ["logs:DescribeLogGroups"] }));
    // 定义 / 代码包桶只读 + 脚本桶只读(EMR / Glue 入口脚本由各自角色读,这里只为 operator 侧校验存在性)
    role.addToPolicy(boundStatement(ctx, { actions: [...S3_RO_ACTIONS], resources: [...bucketArnPair(p, bucketName), ...bucketArnPair(p, scriptsBucketName)] }));
    // 执行面(全部本 region):Redshift Data API + 托管凭证 / 该区 secret / Glue(幂等 CreateJob)/ EMR Serverless
    role.addToPolicy(boundStatement(ctx, { actions: [...REDSHIFT_DATA_ACTIONS] }));
    role.addToPolicy(
      boundStatement(ctx, {
        actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
        resources: [
          `arn:${p}:secretsmanager:${ctx.region}:${ctx.account}:secret:redshift!*`,
          `arn:${p}:secretsmanager:${ctx.region}:${ctx.account}:secret:bgp/project/${slug}/*`,
        ],
      })
    );
    role.addToPolicy(
      boundStatement(ctx, {
        actions: ["glue:StartJobRun", "glue:GetJobRun", "glue:GetJobRuns", "glue:GetJob", "glue:CreateJob", "glue:UpdateJob", "glue:BatchStopJobRun"],
        resources: [`arn:${p}:glue:${ctx.region}:${ctx.account}:job/bgp-*`],
      })
    );
    role.addToPolicy(
      boundStatement(ctx, {
        actions: ["emr-serverless:GetApplication", "emr-serverless:StartApplication", "emr-serverless:StartJobRun", "emr-serverless:GetJobRun", "emr-serverless:CancelJobRun", "emr-serverless:ListJobRuns", "emr-serverless:TagResource"],
      })
    );
    // 🔴 PassRole 只到**本 target** 的 EMR / Glue 执行角色
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [execRoleArnOf(ctx, "emrServerlessRole", p)],
        conditions: { StringEquals: { "iam:PassedToService": "emr-serverless.amazonaws.com" } },
      })
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [execRoleArnOf(ctx, "glueRole", p)],
        conditions: { StringEquals: { "iam:PassedToService": "glue.amazonaws.com" } },
      })
    );
    // ── 🔴 控制面回写 = 唯一跨区例外(与 mwaa 栈逐字同口径;SPEC §3.14 / §3.15)────────────
    const homeDataKeyAlias = resourceName("dataKeyAlias", { targetId: HOME_TARGET_ID });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ControlPlaneRunLedgerWriteBack",
        actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"],
        resources: [`arn:${p}:dynamodb:${homeRegion}:${ctx.account}:table/bgp-*`],
      })
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ControlPlaneRunLedgerKms",
        actions: ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"],
        resources: ["*"],
        conditions: {
          StringEquals: { "kms:ViaService": `dynamodb.${homeRegion}.amazonaws.com`, "aws:RequestedRegion": homeRegion },
          "ForAnyValue:StringEquals": { "kms:ResourceAliases": homeDataKeyAlias },
        },
      })
    );

    // ── Outputs:OutputKey = 描述符字段名(§1.1 组件↔资源配套)────────────────────────
    new cdk.CfnOutput(this, "workflowBucket", { value: bucketName });
    new cdk.CfnOutput(this, "airflowServerlessRoleArn", { value: role.roleArn });
    new cdk.CfnOutput(this, "airflowServerlessSgId", { value: sg.securityGroupId });
  }
}
