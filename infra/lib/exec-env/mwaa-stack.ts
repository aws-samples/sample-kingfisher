// @kf-batch 50-WP13-mwaa-region
// 执行环境 **mwaa 组件**栈(50 SPEC v3.26 §3.14「区域内调度」;§1.1 的 `mwaa` 资源袋:`dagBucket` / `mwaaEnvName`)。
//
// 【为什么每个 target 要有自己的 MWAA】用户拍板(2026-09-06,DESIGN §18 决策 6sexies):「每个区域的定时任务都是自己区域的
//   MWAA 执行的,不允许跨区域调度。」此前 `dag-fanout.ts` 把全部 target 的 DAG 都写 home 桶、由 home Airflow 跨区触发 —— 本栈就是
//   把「定时 / 编排是执行面」这件事落到基建上:DAG 桶 + Airflow 环境 + 执行角色,三样都在**本 region**、名字全部出自命名 SSOT。
//
// 【与 home 的 `infra/lib/mwaa-stack.ts` 是刻意的两份实现】
//   home 那份吃控制面活构造(`props.vpc` / `props.albSecurityGroup` / `props.dataKey`),还向平台 ALB SG 加 ingress;
//   第二 region 没有那些构造 ⇒ 本栈吃**本组底座**的 VPC。动作集逐条对着 home 那份抄,差别只有多 region 的必然:
//   ① 角色名 per-target(IAM 全局,§12 P0-D);② 一切 `Resource:"*"` 语句挂 `aws:RequestedRegion=本 region`(exec-roles 三层绑定);
//   ③ 🔴 **控制面回写是唯一跨区例外**:该区 DAG 回写 run 台账到 **home** 的 `bgp-*` 表(§1.1 控制面单份;DESIGN §6.3 已定
//      「DDB 直写控制面走 IAM」)—— DDB 语句的 ARN 自带 home region(无 `*`);表是 home 数据域 CMK 加密的,KMS 语句用
//      `kms:ViaService=dynamodb.<home>` ∧ `kms:ResourceAliases=<home 别名>` ∧ `aws:RequestedRegion=<home>` 三条件收口,
//      synth-gate 对本角色单列判据(除这一条外其余 `*` 语句必须 = 本 region)。
//
// 🔴 数据保护:DAG 桶是可再生产物,但 exec-env 一律「删环境不顺手删桶」(core-stack 文件头纪律)⇒ RETAIN、不带 autoDeleteObjects;
//    Airflow 环境是有状态托管资源(P0-E 有状态集已列 `AWS::MWAA::Environment`)⇒ RETAIN。
// 🔴 MWAA 要求源桶 **开版本控制**、阻公网;缺版本控制 CreateEnvironment 直接 400(synth 不校验)。
// 🔴 资源文案一律英文(IAM Latin-1 / SG ASCII)。
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as mwaa from "aws-cdk-lib/aws-mwaa";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { HOME_TARGET_ID, resourceName } from "../shared/naming";
import { ExecEnvStack, type ExecEnvStackProps } from "./exec-env-stack";
import { boundStatement, bucketArnPair, execRoleArnOf, REDSHIFT_DATA_ACTIONS } from "./exec-roles";
// @kf-batch 50-WP16-zero-egress —— 私有子网类型的唯一真值(零出网 = PRIVATE_ISOLATED)
import { execEnvPrivateSubnets } from "./private-subnets";

export interface ExecEnvMwaaStackProps extends ExecEnvStackProps {
  /** 底座 VPC:环境挂私有子网 ×2(MWAA 要求恰好两个不同 AZ 的私有子网)。 */
  vpc: ec2.IVpc;
}

/** 与 home 逐字相同的 Airflow 配置(两侧行为一致,别让「第二区调度快慢不一」变成新问题)。 */
const AIRFLOW_OPTIONS = {
  "scheduler.dag_dir_list_interval": "30",
  "core.min_file_process_interval": "30",
  "core.dags_are_paused_at_creation": "False",
};

export class ExecEnvMwaaStack extends ExecEnvStack {
  constructor(scope: Construct, id: string, props: ExecEnvMwaaStackProps) {
    super(scope, id, props);
    const { ctx, vpc } = props;
    // context.ts 对 mwaa ∈ components 已 fail-closed;这里再挡一次,免得别的入口绕过 readExecEnvContext 直接 new 本栈
    const homeRegion = ctx.homeRegion;
    if (!homeRegion) throw new Error(`ExecEnvMwaaStack(${ctx.targetId}):缺 homeRegion —— 该区 MWAA 回写 home 运行台账,必须知道控制面 region`);
    const p = cdk.Aws.PARTITION;
    const nameOf = (kind: string) => resourceName(kind, { targetId: ctx.targetId, account: ctx.account });
    const bucketName = nameOf("dagBucket");
    const envName = nameOf("mwaaEnvName");
    const slug = ctx.targetId.replace(/_/g, "-");

    // ── DAG 桶(MWAA 源桶:版本控制必开)────────────────────────────────────────
    const bucket = new s3.Bucket(this, "DagBucket", {
      bucketName,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // 🔴 不带 autoDeleteObjects(exec-env 纪律)
    });

    // ── SG:自引全通(与 home 同口径;不向任何控制面 SG 加 ingress —— 第二 region 没有 ALB)────
    const sg = new ec2.SecurityGroup(this, "MwaaSg", {
      vpc,
      description: `BGP exec-env ${ctx.targetId} MWAA security group`,
      allowAllOutbound: true,
    });
    sg.addIngressRule(sg, ec2.Port.allTraffic(), "MWAA self-reference");

    // ── 执行角色(per-target 名;信任两个 MWAA 服务主体,各绑 SourceAccount 防混淆代理)────────
    const trust = new iam.CompositePrincipal(
      new iam.ServicePrincipal("airflow.amazonaws.com").withConditions({ StringEquals: { "aws:SourceAccount": ctx.account } }),
      new iam.ServicePrincipal("airflow-env.amazonaws.com").withConditions({ StringEquals: { "aws:SourceAccount": ctx.account } })
    );
    const role = new iam.Role(this, "MwaaRole", {
      // 🔴 字面调用 resourceName(不经 nameOf 包装):命名门禁 naming.test / naming-coverage 靠「infra 侧从 SSOT 派生」这条形状放行 home 模板(home 永不建本角色)
      roleName: resourceName("mwaaRole", { targetId: ctx.targetId, account: ctx.account }),
      assumedBy: trust,
      description: `BGP exec-env ${ctx.targetId} MWAA execution role (bound to this target; control-plane run ledger write-back is the only cross-region grant)`,
    });
    const envArn = `arn:${p}:airflow:${ctx.region}:${ctx.account}:environment/${envName}`;
    role.addToPolicy(boundStatement(ctx, { actions: ["airflow:PublishMetrics"], resources: [envArn] }));
    // DAG 源桶只读(MWAA 拉 DAG / requirements / plugins)
    role.addToPolicy(boundStatement(ctx, { actions: ["s3:GetObject*", "s3:GetBucket*", "s3:List*"], resources: bucketArnPair(p, bucketName) }));
    // 日志组与环境同区同生命周期
    role.addToPolicy(
      boundStatement(ctx, {
        actions: ["logs:CreateLogStream", "logs:CreateLogGroup", "logs:PutLogEvents", "logs:GetLogEvents", "logs:GetLogRecord", "logs:GetLogGroupFields", "logs:GetQueryResults"],
        resources: [`arn:${p}:logs:${ctx.region}:${ctx.account}:log-group:airflow-${envName}-*`],
      })
    );
    role.addToPolicy(boundStatement(ctx, { actions: ["logs:DescribeLogGroups"] })); // * ⇒ 自动挂本 region 条件
    // MWAA 托管 Celery 队列(服务在环境所在 region 建)
    role.addToPolicy(
      boundStatement(ctx, {
        actions: ["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ReceiveMessage", "sqs:SendMessage"],
        resources: [`arn:${p}:sqs:${ctx.region}:*:airflow-celery-*`],
      })
    );
    role.addToPolicy(
      boundStatement(ctx, {
        actions: ["kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKey*", "kms:Encrypt"],
        conditions: { StringLike: { "kms:ViaService": [`sqs.${ctx.region}.amazonaws.com`] } },
      })
    );
    // 执行面(全部本 region):Glue 作业 / EMR Serverless / Redshift Data API + 托管凭证 / 该区的 secret
    role.addToPolicy(boundStatement(ctx, { actions: ["glue:StartJobRun", "glue:GetJobRun", "glue:GetJob"] }));
    role.addToPolicy(
      boundStatement(ctx, {
        actions: ["emr-serverless:GetApplication", "emr-serverless:StartApplication", "emr-serverless:StartJobRun", "emr-serverless:GetJobRun", "emr-serverless:CancelJobRun"],
      })
    );
    // 🔴 PassRole 只到**本 target** 的 EMR 执行角色(home 那份 pass 的是 home 角色;这里若写 home 名 = 该区定时 EMR run 用 home 身份跑)
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [execRoleArnOf(ctx, "emrServerlessRole", p)],
        conditions: { StringEquals: { "iam:PassedToService": "emr-serverless.amazonaws.com" } },
      })
    );
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
    // ── 🔴 控制面回写 = 唯一跨区例外(SPEC §3.14)────────────────────────────────────
    //   DAG 的 _record / 运行锁写 home 的 bgp-task-runs / bgp-etl-jobs / bgp-engine-jobs 等(控制面单份)。
    //   ARN 自带 home region ⇒ 没有 `*`、不经 boundStatement;KMS 用 via-service + 别名 + RequestedRegion 三条件收到「只为 home 的 DDB 解密」。
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

    // ── Airflow 环境(与 home 同版本 / 同档 / 同配置)────────────────────────────────
    const env = new mwaa.CfnEnvironment(this, "Environment", {
      name: envName,
      airflowVersion: "2.10.3",
      environmentClass: "mw1.small",
      maxWorkers: 2,
      minWorkers: 1,
      sourceBucketArn: bucket.bucketArn,
      dagS3Path: "dags/",
      executionRoleArn: role.roleArn,
      networkConfiguration: {
        subnetIds: execEnvPrivateSubnets(vpc).subnetIds.slice(0, 2),
        securityGroupIds: [sg.securityGroupId],
      },
      webserverAccessMode: "PUBLIC_ONLY",
      airflowConfigurationOptions: AIRFLOW_OPTIONS,
      loggingConfiguration: {
        dagProcessingLogs: { enabled: true, logLevel: "INFO" },
        schedulerLogs: { enabled: true, logLevel: "INFO" },
        taskLogs: { enabled: true, logLevel: "INFO" },
        webserverLogs: { enabled: true, logLevel: "INFO" },
        workerLogs: { enabled: true, logLevel: "INFO" },
      },
    });
    env.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN); // 🔴 有状态托管环境(P0-E)
    // 🔴 MWAA 建环时会校验执行角色**已能**读源桶 / 写日志:策略资源(DefaultPolicy)必须先于环境创建,
    //    否则 CreateEnvironment 报「execution role does not have permission」后整栈回滚 ~20 分钟。
    const policy = role.node.tryFindChild("DefaultPolicy")?.node.defaultChild as cdk.CfnResource | undefined;
    if (policy) env.addDependency(policy);
    env.addDependency(role.node.defaultChild as cdk.CfnResource);

    // ── Outputs:OutputKey = 描述符字段名(§1.1 组件↔资源配套:mwaa ⇒ dagBucket + mwaaEnvName)────
    new cdk.CfnOutput(this, "dagBucket", { value: bucketName });
    new cdk.CfnOutput(this, "mwaaEnvName", { value: envName });
    // 给人看的(不在描述符合同里,finalize 只取合同键)
    new cdk.CfnOutput(this, "mwaaWebserverUrl", { value: cdk.Fn.getAtt(env.logicalId, "WebserverUrl").toString() });
  }
}
