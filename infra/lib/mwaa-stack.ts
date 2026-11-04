import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as mwaa from "aws-cdk-lib/aws-mwaa";
import { Construct } from "constructs";
// @kf-batch 52-P52.5a-supply — 资源 ARN 的 region 段唯一出口 + 显式轴声明。
import { regionalStatement } from "./shared/execution-regions";

interface MwaaStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  dagBucketArn: string;
  albSecurityGroup: ec2.ISecurityGroup;
  dataKey: kms.IKey; // 模块 27 (WS1) — DAG 回写 bgp-* 加密表需解密权限
}

export class MwaaStack extends cdk.Stack {
  public readonly environmentName: string;

  constructor(scope: Construct, id: string, props: MwaaStackProps) {
    super(scope, id, props);

    this.environmentName = "bgp-mwaa";

    const sg = new ec2.SecurityGroup(this, "MwaaSg", {
      vpc: props.vpc,
      description: "MWAA Security Group",
    });
    sg.addIngressRule(sg, ec2.Port.allTraffic(), "MWAA self-reference");

    // Allow MWAA to access platform ALB (use Cfn to avoid cyclic dep)
    new ec2.CfnSecurityGroupIngress(this, "MwaaToAlb", {
      groupId: props.albSecurityGroup.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 80,
      toPort: 80,
      sourceSecurityGroupId: sg.securityGroupId,
      description: "MWAA to ALB",
    });

    const role = new iam.Role(this, "MwaaRole", {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal("airflow.amazonaws.com"),
        new iam.ServicePrincipal("airflow-env.amazonaws.com"),
      ),
    });

    role.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "本角色是 home 的 MWAA 执行角色(环境本身建在 home);per-target MWAA 随 P50.3 由 exec-env 栈在目标 region 各建一套,那时 region 段天然=目标 region" ,
      actions: ["airflow:PublishMetrics"],
      resources: (r) => [`arn:aws:airflow:${r}:${this.account}:environment/${this.environmentName}`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject*", "s3:GetBucket*", "s3:List*"],
      resources: [props.dagBucketArn, `${props.dagBucketArn}/*`],
    }));
    role.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "日志组与 MWAA 环境同区同生命周期(环境在 home)",
      actions: ["logs:CreateLogStream", "logs:CreateLogGroup", "logs:PutLogEvents", "logs:GetLogEvents", "logs:GetLogRecord", "logs:GetLogGroupFields", "logs:GetQueryResults"],
      resources: (r) => [`arn:aws:logs:${r}:${this.account}:log-group:airflow-${this.environmentName}-*`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["logs:DescribeLogGroups"],
      resources: ["*"],
    }));
    role.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "MWAA 托管的 Celery 队列由服务在环境所在 region 创建,跨 region 无此队列",
      actions: ["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ReceiveMessage", "sqs:SendMessage"],
      resources: (r) => [`arn:aws:sqs:${r}:*:airflow-celery-*`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKey*", "kms:Encrypt"],
      resources: ["*"],
      conditions: { StringLike: { "kms:ViaService": [`sqs.${this.region}.amazonaws.com`] } },
    }));
    // DAG tasks need Glue, DynamoDB, Redshift Data API access
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["glue:StartJobRun", "glue:GetJobRun", "glue:GetJob"],
      resources: ["*"],
    }));
    // 模块 33-A 补齐:EMR Serverless 引擎作业的周期调度 DAG 需要用 boto3 确保 application 启动、
    // 提交 job-run 并轮询终态(见 lib/engines/emr/dag-generator.ts)。缺这些权限时 run_job 会在
    // get_application 第一步即 AccessDenied 秒失败(与 Glue DAG 对称:Glue 有权限、EMR 之前漏了)。
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "emr-serverless:GetApplication", "emr-serverless:StartApplication",
        "emr-serverless:StartJobRun", "emr-serverless:GetJobRun", "emr-serverless:CancelJobRun",
      ],
      resources: ["*"],
    }));
    // StartJobRun 要把 EMR 执行角色 PassRole 给 EMR Serverless 服务(与平台 TaskRole 同款约束)。
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["iam:PassRole"],
      resources: [`arn:aws:iam::${this.account}:role/bgp-emr-serverless-role`],
      conditions: { StringEquals: { "iam:PassedToService": "emr-serverless.amazonaws.com" } },
    }));
    role.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "控制面单份:DAG 回写的任务/运行台账(bgp-task-runs 等)按 50 SPEC §1.1 只在 home 存一份",
      actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:PutItem"],
      resources: (r) => [`arn:aws:dynamodb:${r}:${this.account}:table/bgp-*`],
    }));
    // 模块 27 (WS1): bgp-* 表用数据域 CMK 加密,DAG 回写状态需用该 key 解密/生成数据密钥。
    props.dataKey.grant(role, "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey");
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["redshift-data:ExecuteStatement", "redshift-data:BatchExecuteStatement", "redshift-data:DescribeStatement", "redshift-data:GetStatementResult", "redshift-data:CancelStatement", "redshift-serverless:GetCredentials"],
      resources: ["*"],
    }));
    // Scheduled Redshift ETL DAGs authenticate to Redshift via the managed admin secret
    // (so scheduled runs share ONE Redshift identity with the platform's run-now — avoids the
    // cross-identity table-owner failure). The Data API needs the caller to read that secret.
    role.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "本 MWAA 在 home,其 DAG 打的是 home 数仓;跨 region 调度随 P50.3 的 per-target MWAA 一起做",
      actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
      resources: (r) => [`arn:aws:secretsmanager:${r}:${this.account}:secret:redshift!*`],
    }));

    const env = new mwaa.CfnEnvironment(this, "BgpMwaa", {
      name: this.environmentName,
      airflowVersion: "2.10.3",
      environmentClass: "mw1.small",
      maxWorkers: 2,
      minWorkers: 1,
      sourceBucketArn: props.dagBucketArn,
      dagS3Path: "dags/",
      executionRoleArn: role.roleArn,
      networkConfiguration: {
        subnetIds: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.slice(0, 2),
        securityGroupIds: [sg.securityGroupId],
      },
      webserverAccessMode: "PUBLIC_ONLY",
      airflowConfigurationOptions: {
        "scheduler.dag_dir_list_interval": "30",
        "core.min_file_process_interval": "30",
        "core.dags_are_paused_at_creation": "False",
      },
      loggingConfiguration: {
        dagProcessingLogs: { enabled: true, logLevel: "INFO" },
        schedulerLogs: { enabled: true, logLevel: "INFO" },
        taskLogs: { enabled: true, logLevel: "INFO" },
        webserverLogs: { enabled: true, logLevel: "INFO" },
        workerLogs: { enabled: true, logLevel: "INFO" },
      },
    });

    new cdk.CfnOutput(this, "MwaaEnvName", { value: this.environmentName });
    new cdk.CfnOutput(this, "MwaaWebserverUrl", {
      value: cdk.Fn.getAtt(env.logicalId, "WebserverUrl").toString(),
    });
  }
}
