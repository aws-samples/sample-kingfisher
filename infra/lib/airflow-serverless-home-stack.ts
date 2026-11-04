// @kf-batch 50-WP15-airflow-serverless
// home 区的 **MWAA Serverless 入口**栈 BgpAirflowServerlessStack(50 SPEC v3.27 §3.15;WP-15 施工序 2b)。
//
// 【为什么 home 也要一份】用户拍板的验收 = 无头 + **≥2 region** 每个调度任务真跑三引擎(DESIGN 6septies);home 是两区之一。
//   与执行环境组件栈 `infra/lib/exec-env/airflow-serverless-stack.ts` 是刻意的两份实现(同 mwaa 的 home / 非 home 两份先例):
//   home 吃控制面活构造(`props.vpc` / `props.dataKey`),名字走命名 SSOT 的 **home 模板**(bgp-airflow-sls-<acct> / bgp-airflow-sls-sg / bgp-airflow-sls-role);
//   动作集逐条对着组件栈抄,差别只有 home 的必然:① 控制面回写就在本 region(不是跨区例外,dataKey 直接 grant);② axis:"home" 不挂区域条件。
//   workflow 本身不在这里建(一个作业一个 workflow,由平台发布时 CreateWorkflow / UpdateWorkflow)。
// 🔴 seed-home 按 SSOT 名探三样(桶 HeadBucket / 角色 GetRole / SG 按名查 id)⇒ 查到才在 home 描述符声称组件 airflow-serverless。
// 🔴 桶 RETAIN、不带 autoDeleteObjects。资源文案一律英文。
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { HOME_TARGET_ID, resourceName } from "./shared/naming";
import { regionalStatement } from "./shared/execution-regions";
import { REDSHIFT_DATA_ACTIONS, S3_RO_ACTIONS } from "./exec-env/exec-roles";

interface AirflowServerlessStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  /** 控制面数据域 CMK:home 的 workflow 任务回写 bgp-* 加密表需解密权限(与 MwaaStack 同理由)。 */
  dataKey: kms.IKey;
}

export class AirflowServerlessStack extends cdk.Stack {
  public readonly workflowBucket: s3.Bucket;
  public readonly role: iam.Role;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: AirflowServerlessStackProps) {
    super(scope, id, props);
    const acct = cdk.Stack.of(this).account;
    const p = cdk.Aws.PARTITION;
    const home = (kind: string) => resourceName(kind, { targetId: HOME_TARGET_ID, account: acct });
    const bucketName = home("workflowBucket");

    this.workflowBucket = new s3.Bucket(this, "WorkflowBucket", {
      bucketName,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.securityGroup = new ec2.SecurityGroup(this, "WorkerSg", {
      vpc: props.vpc,
      securityGroupName: resourceName("airflowServerlessSg", { targetId: HOME_TARGET_ID }),
      description: "BGP home MWAA Serverless worker security group",
      allowAllOutbound: true,
    });
    this.securityGroup.addIngressRule(this.securityGroup, ec2.Port.allTraffic(), "MWAA Serverless self-reference");

    const role = new iam.Role(this, "ExecutionRole", {
      roleName: resourceName("airflowServerlessRole", { targetId: HOME_TARGET_ID }),
      assumedBy: new iam.ServicePrincipal("airflow-serverless.amazonaws.com"),
      description: "BGP home MWAA Serverless execution role (workflow tasks: Redshift Data / Glue / EMR Serverless + run ledger write-back)",
    });
    this.role = role;
    // 🔴 每条 regionalStatement 写明 axis 与 reason(synth-gate §12 静态扫每个调用点;不经 helper 包装)
    role.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "home serverless 任务日志落本 region 的 /aws/mwaa-serverless/<workflow>/",
      actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
      resources: (r) => [`arn:${p}:logs:${r}:${acct}:log-group:/aws/mwaa-serverless/*`],
    }));
    role.addToPolicy(regionalStatement(this, { axis: "home", reason: "DescribeLogGroups 只能 *;home 轴不挂区域条件", actions: ["logs:DescribeLogGroups"], resources: () => ["*"] }));
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [...S3_RO_ACTIONS],
        resources: [
          `arn:${p}:s3:::${bucketName}`, `arn:${p}:s3:::${bucketName}/*`,
          `arn:${p}:s3:::${home("scriptsBucket")}`, `arn:${p}:s3:::${home("scriptsBucket")}/*`,
        ],
      })
    );
    role.addToPolicy(regionalStatement(this, { axis: "home", reason: "home 数仓 Redshift Data API + 托管凭证(资源级 ARN 运行期才知道)", actions: [...REDSHIFT_DATA_ACTIONS], resources: () => ["*"] }));
    role.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "home 的 Redshift 托管 secret 与项目 secret",
      actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
      resources: (r) => [`arn:${p}:secretsmanager:${r}:${acct}:secret:redshift!*`, `arn:${p}:secretsmanager:${r}:${acct}:secret:bgp/project/*`],
    }));
    role.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "GlueJobOperator 走幂等 CreateJob(spike 真撞 AccessDenied);限 bgp-* 作业",
      actions: ["glue:StartJobRun", "glue:GetJobRun", "glue:GetJobRuns", "glue:GetJob", "glue:CreateJob", "glue:UpdateJob", "glue:BatchStopJobRun"],
      resources: (r) => [`arn:${p}:glue:${r}:${acct}:job/bgp-*`],
    }));
    role.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "EMR Serverless 起停应用与作业(资源级 ARN 运行期才知道)",
      actions: ["emr-serverless:GetApplication", "emr-serverless:StartApplication", "emr-serverless:StartJobRun", "emr-serverless:GetJobRun", "emr-serverless:CancelJobRun", "emr-serverless:ListJobRuns", "emr-serverless:TagResource"],
      resources: () => ["*"],
    }));
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [`arn:${p}:iam::${acct}:role/${home("emrServerlessRole")}`],
        conditions: { StringEquals: { "iam:PassedToService": "emr-serverless.amazonaws.com" } },
      })
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [`arn:${p}:iam::${acct}:role/${home("glueRole")}`],
        conditions: { StringEquals: { "iam:PassedToService": "glue.amazonaws.com" } },
      })
    );
    // 控制面回写:home 就在本 region(不是跨区例外);表是数据域 CMK 加密的 ⇒ 直接 grant
    role.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "run 台账 / 运行锁写 home 的 bgp-* 表(控制面单份)",
      actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"],
      resources: (r) => [`arn:${p}:dynamodb:${r}:${acct}:table/bgp-*`],
    }));
    props.dataKey.grantEncryptDecrypt(role);

    new cdk.CfnOutput(this, "workflowBucket", { value: bucketName });
    new cdk.CfnOutput(this, "airflowServerlessRoleArn", { value: role.roleArn });
    new cdk.CfnOutput(this, "airflowServerlessSgId", { value: this.securityGroup.securityGroupId });
  }
}
