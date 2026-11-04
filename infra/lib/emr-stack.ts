import * as cdk from "aws-cdk-lib";
import { requestedRegionCondition, regionalStatement } from "./shared/execution-regions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

// (离线多引擎 EMR Serverless) — 门控「共享底座」栈。
//
// ⚠️ 门控创建:仅当 `-c enable-emr=1` 时在 bin/app.ts 实例化。
// 本栈只建「可被所有 per-作业 application 复用的底座」:EMR 执行角色 + 默认 SG。
// EMR Serverless application 本身【不在 CDK 建】——拍板④⑤:每作业一个独立 application(不共享,
// 避免资源争抢/队头阻塞),由后端服务层(lib/engines/emr/application.ts)按作业动态 Create/Delete。
// 故本栈无常驻计费资源(角色/SG 不计费),但仍门控以保持与 flink/realtime 一致的可选装配风格。
//
// EMR 执行角色权限照抄 flink-stack.ts:34-93(信任主体换 emr-serverless);SG 照抄 realtime-stack.ts:53-58。
interface EmrStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  dataKey: kms.IKey; // 数据域 CMK(桶/流 SSE-KMS 解密)
}

export class EmrStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EmrStackProps) {
    super(scope, id, props);
    const { vpc } = props;
    const acct = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    // ── EMR 默认 SG(私有子网出网底座;network-private-only)。照抄 realtime-stack.ts:53-58。 ──
    // 用户建作业时可另选/叠加 SG;此为兜底默认(出网经 NAT 到 S3/Glue/CloudWatch/S3Tables)。
    const emrSg = new ec2.SecurityGroup(this, "EmrSg", {
      vpc,
      securityGroupName: "bgp-emr-sg",
      description: "BGP EMR Serverless default SG",
      allowAllOutbound: true,
    });

    // ── EMR Serverless 作业执行角色(照抄 flink-stack.ts:34-93,信任主体换 emr-serverless)。 ──
    const role = new iam.Role(this, "EmrRole", {
      roleName: "bgp-emr-serverless-role",
      assumedBy: new iam.ServicePrincipal("emr-serverless.amazonaws.com"),
      description: "BGP EMR Serverless job execution role",
    });

    // KMS:解密源桶/流(SSE-KMS)。
    props.dataKey.grant(role, "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey");

    // 读 PySpark 脚本 / 依赖 JAR(Glue 脚本桶 emr-scripts/ 前缀,与 Flink 共桶不同前缀)。
    // 🔴 **W3-g 的放宽已撤销**:W3-g 曾把这两条的资源面从 home 两桶全名放宽到
    // `bgp-glue-scripts-<acct>-*` / `bgp-datalake-<acct>-*`,好让非 home 的 EMR run 用**这一个 home 角色**去拉别的区的
    // 桶(IR-P1-03 的横移形状,当时如实登记)。非 home 的 EMR 用 exec-env core 栈里**本 target 自己的**角色
    // (`BgpExecEnv-<slug>-emr-role`,见 infra/lib/exec-env/core-stack.ts),本角色只剩 home 一份 ⇒ 资源面**收回**到
    // home 两桶的全名。synth-gate §9 钉:S3 语句里不许再出现 `-*` 通配(ACCEPTANCE)。
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket", "s3:GetBucketLocation"],
      resources: [`arn:aws:s3:::bgp-glue-scripts-${acct}`, `arn:aws:s3:::bgp-glue-scripts-${acct}/*`],
    }));
    // 读写数据湖桶(Spark 输入/输出/结果 + EMR 日志 emr-logs/ 前缀)。
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation",
        "s3:AbortMultipartUpload", "s3:ListBucketMultipartUploads", "s3:ListMultipartUploadParts",
      ],
      resources: [`arn:aws:s3:::bgp-datalake-${acct}`, `arn:aws:s3:::bgp-datalake-${acct}/*`],
    }));
    // CloudWatch Logs(EMR Serverless 可选 CW 日志) + 指标。
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents",
        "logs:DescribeLogGroups", "logs:DescribeLogStreams",
      ],
      resources: ["*"],
    }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ["cloudwatch:PutMetricData"], resources: ["*"] }));
    // VPC 接入:EMR Serverless application 挂进私有 VPC 需 ENI 管理 + 子网/SG 描述。
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "ec2:CreateNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DeleteNetworkInterface",
        "ec2:CreateNetworkInterfacePermission", "ec2:DescribeNetworkInterfacePermissions",
        "ec2:DescribeSubnets", "ec2:DescribeVpcs", "ec2:DescribeSecurityGroups", "ec2:DescribeDhcpOptions",
      ],
      resources: ["*"],
    }));
    // DynamoDB 只读(EMR PySpark boto3 并行分片 Scan 拉 NoSQL 源表 → 写 S3 Tables;
    // 与平台 TaskRole 的 DataSourceReadOnly 同口径:全只读 + region 条件,放开读用户任意 DDB 表。
    // DDB 无官方 Flink 批 source、EMR 亦无 GlueContext,故 EMR 侧走 boto3 Scan(零 jar 依赖),
    // 需 Scan/DescribeTable/Query;不含任何写动作。见 cookbook emr.spark-dynamodb-to-s3tables)。
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["dynamodb:DescribeTable", "dynamodb:Scan", "dynamodb:Query", "dynamodb:GetItem", "dynamodb:BatchGetItem"],
      resources: ["*"],
      conditions: { StringEquals: { "aws:RequestedRegion": requestedRegionCondition(this) } },
    }));
    // S3 Tables(托管 Iceberg)+ Glue Catalog / Lake Formation 联邦(Spark SQL 读写表)。
    role.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "表桶名按命名 SSOT 逐 target 不同(非 home 带 targetSlug 后缀,见 naming.json 的 tableBucket)⇒ 光放 region 段也访问不到别的 target,必须连资源名一起改",
      actions: ["s3tables:*"],
      resources: (r) => [
        `arn:aws:s3tables:${r}:${acct}:bucket/bgp-table-bucket`,
        `arn:aws:s3tables:${r}:${acct}:bucket/bgp-table-bucket/*`,
      ],
    }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ["glue:*", "lakeformation:*"], resources: ["*"] }));
    // 写 Redshift 数仓（EMR 脚本用 boto3 redshift-data API，与平台其他模块同范式，免 JDBC）：
    // Data API 执行 + Serverless 临时凭证 + 读 admin secret。数据链路 EMR→计算→Redshift 落库。
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "redshift-data:ExecuteStatement", "redshift-data:BatchExecuteStatement",
        "redshift-data:DescribeStatement", "redshift-data:GetStatementResult", "redshift-data:CancelStatement",
        "redshift-serverless:GetCredentials",
      ],
      resources: ["*"],
    }));
    role.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "本角色是 home 的 EMR 执行角色;非 home 的 EMR 由 exec-env per-target 栈各自建角色(那时 ARN 的 region 段天然=目标 region)",
      actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
      // 根因治理: EMR 作业读源库(MySQL JDBC)需读 RDS master secret。该 secret 由 RdsStack 用
      // fromGeneratedSecret 生成,名字前缀 BgpRdsStackBgpSourceMysql*(非 bgp/)。补上此 pattern,
      // EMR PySpark 直接 boto3 读源库口令,无需带外 put-role-policy。
      resources: (r) => [
        `arn:aws:secretsmanager:${r}:${acct}:secret:bgp/*`,
        `arn:aws:secretsmanager:${r}:${acct}:secret:redshift!*`,
        `arn:aws:secretsmanager:${r}:${acct}:secret:BgpRdsStack*`,
      ],
    }));

    new cdk.CfnOutput(this, "EmrRoleArn", { value: role.roleArn });
    new cdk.CfnOutput(this, "EmrSgId", { value: emrSg.securityGroupId });
  }
}
