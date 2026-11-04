import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
// @kf-batch 50-WP27-9cap-matrix
// 🔴 ARN 的 region 段一律经唯一出口 `regionalStatement`(轴 + 理由都要写在代码里)。
//    本文件原来有 7 处手拼 —— 它们**逃过了门禁**,因为门禁的 `RAW_REGION` 只枚举了四种拼法
//    (`${region}` / `${this.region}` / `${cdk.Aws.REGION}` / `${props…region}`),偏偏漏掉这里用的
//    `${cdk.Stack.of(this).region}`。「清单驱动的门禁,覆盖面就是判据本身」⇒ 门禁已同批改成
//    **结构判定**(region 段只允许 `regionalStatement` 的回调参数),不再枚举拼法。
import { regionalStatement } from "./shared/execution-regions";

// 模块 32 (实时计算 Flink) — 门控基建(MSAF 引擎的耐久依赖)。
//
// ⚠️ 门控栈,但**默认打开**(bin/app.ts 默认 enable-flink=1):本栈现在只创建 **≈零成本的 MSAF 服务角色**,
// 不再建常驻计费资源,故默认全开也几乎零常驻计费。
//
// 成本改造(2026-07-07,用户拍板):删除源 Kinesis 流 —— 本项目 Flink 场景是 MySQL binlog CDC 直连
// (Flink CDC 连接器),不消费 Kinesis;该流是"Kinesis 作为源"的演示遗留,纯多余常驻,删除。
// Flink 应用本身(= 每个流作业一个 MSAF 应用)由后端服务层(flink-service)按需 Create/Start/Stop/Delete。
// Flink SQL Runner fat JAR 上传到 bgp-glue-scripts-<account>/flink/(部署步骤,不进 CDK 资产)。
interface FlinkStackProps extends cdk.StackProps {
  dataKey: kms.IKey; // 数据域 CMK(输出桶 / S3Tables 解密)
}

export class FlinkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FlinkStackProps) {
    super(scope, id, props);
    const acct = cdk.Stack.of(this).account;

    // ── MSAF(Managed Service for Apache Flink)服务执行角色 ──
    const role = new iam.Role(this, "FlinkRole", {
      roleName: "bgp-flink-role",
      assumedBy: new iam.ServicePrincipal("kinesisanalytics.amazonaws.com"),
      description: "BGP MSAF Flink application service execution role",
    });

    // KMS:解密输出桶 / S3Tables
    props.dataKey.grant(role, "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey");

    // 模块42 P42.7(多数据源):Kinesis 作为 Flink 源 —— MSAF 应用消费流所需的读权限。
    //  2026-07-07 曾删固定流 bgp-flink-source 走成本优化;现按 B 方案(用户拍板 2026-07-26)恢复多源支持:
    //  【不建固定流】,流由数据源 provision 按需新建(第二层可有多个);此处只授【消费任意平台流】的读权限。
    //  资源限定到本账号本区 stream/*(平台建的流都在此;不放开跨账号)。DescribeStreamSummary 供 introspect/探活。
    role.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "这是 **home 的** MSAF 服务执行角色(bgp-flink-role):只有主控区的流作业会用它。"
        + "非 home 的流作业用该区自己的 per-target 角色 BgpExecEnv-<slug>-flink-role"
        + "(infra/lib/exec-env/flink-stack.ts,那里的 region 段就是该区)⇒ 本条不需要跨 region。",
      actions: [
        "kinesis:DescribeStream", "kinesis:DescribeStreamSummary", "kinesis:ListShards",
        "kinesis:GetShardIterator", "kinesis:GetRecords", "kinesis:SubscribeToShard",
      ],
      resources: (r) => [`arn:aws:kinesis:${r}:${acct}:stream/*`],
    }));

    // 模块42 P42.6b(MSK/Kafka 源):MSAF 应用【IAM 认证消费】Kafka broker 所需的数据面权限。
    //  🔴 IAM 认证连 MSK 用 kafka-cluster:* 动作族(数据面,作用于 cluster/topic/group 三类资源 ARN),
    //     不是 kafka:*(那是控制面,如 DescribeClusterV2,归平台 TaskRole)。see aws-msk-iam-auth SigV4。
    //  · Connect + DescribeCluster:连集群。
    //  · *Topic + ReadData:读 topic(消费)。
    //  · *Group:消费组管理(Flink Kafka source 用消费组提交/追踪 offset)。
    //  资源限定本账号本区(cluster/topic/group/* 三类通配);GetBootstrapBrokers(控制面)拿 broker 串。
    //  网络:broker 在私有 VPC,MSAF 应用启动时按【作业所选子网/SG】动态接入(§11.5),ENI 权限已在下方通用块。
    role.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "同上:home 的 MSAF 角色只跑主控区的流作业,MSK 集群/topic/消费组也只看主控区那一套。",
      actions: [
        "kafka-cluster:Connect",
        "kafka-cluster:DescribeCluster",
        "kafka-cluster:DescribeTopic", "kafka-cluster:ReadData",
        "kafka-cluster:DescribeGroup", "kafka-cluster:AlterGroup",
      ],
      resources: (r) => [
        `arn:aws:kafka:${r}:${acct}:cluster/*`,
        `arn:aws:kafka:${r}:${acct}:topic/*`,
        `arn:aws:kafka:${r}:${acct}:group/*`,
      ],
    }));
    // 控制面:拿 bootstrap broker 串(MSAF 启动时/introspect 可能需)。GetBootstrapBrokers 作用于 cluster ARN。
    role.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "同上:home 的 MSAF 角色只连主控区的 MSK 集群拿 bootstrap broker 串。",
      actions: ["kafka:GetBootstrapBrokers", "kafka:DescribeClusterV2"],
      resources: (r) => [`arn:aws:kafka:${r}:${acct}:cluster/*`],
    }));

    // 读应用代码 JAR(flink-sql-runner.jar 在 Glue 脚本桶 flink/ 前缀下)
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket", "s3:GetBucketLocation"],
      resources: [`arn:aws:s3:::bgp-glue-scripts-${acct}`, `arn:aws:s3:::bgp-glue-scripts-${acct}/*`],
    }));
    // 写流计算输出(数据湖桶 flink-out/ 前缀)
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation",
        "s3:AbortMultipartUpload", "s3:ListBucketMultipartUploads", "s3:ListMultipartUploadParts",
      ],
      resources: [`arn:aws:s3:::bgp-datalake-${acct}`, `arn:aws:s3:::bgp-datalake-${acct}/*`],
    }));
    // CloudWatch Logs + 指标(MSAF 应用日志)
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents",
        "logs:DescribeLogGroups", "logs:DescribeLogStreams",
      ],
      resources: ["*"],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["cloudwatch:PutMetricData"],
      resources: ["*"],
    }));
    // MSAF VPC 接入(写私有 VPC 内的 RDS / MySQL sink 时需把应用挂进 VPC):ENI 管理 + 子网/SG 描述。
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "ec2:CreateNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DeleteNetworkInterface",
        "ec2:CreateNetworkInterfacePermission", "ec2:DescribeNetworkInterfacePermissions",
        "ec2:DescribeSubnets", "ec2:DescribeVpcs", "ec2:DescribeSecurityGroups", "ec2:DescribeDhcpOptions",
      ],
      resources: ["*"],
    }));

    // 模块 32 — S3 Tables(托管 Iceberg)sink:S3TablesCatalog 经 s3tables API 建命名空间/表 + 读写
    // 数据/元数据(限定到平台表桶 bgp-table-bucket);经 Glue/Lake Formation 联邦目录治理需 glue/
    // lakeformation(与平台 glueRole 同源,已实证可访问 S3 Tables)。表桶静态加密为 SSE-S3,无需额外 KMS。
    role.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "表桶 bgp-table-bucket 是**主控区**那一只;非 home 的表桶名在该 target 的资源袋里,"
        + "由 per-target 的 flink 角色授权(实名资源,不按 bgp-* 约定猜)⇒ 本条不需要跨 region。",
      actions: ["s3tables:*"],
      resources: (r) => [
        `arn:aws:s3tables:${r}:${acct}:bucket/bgp-table-bucket`,
        `arn:aws:s3tables:${r}:${acct}:bucket/bgp-table-bucket/*`,
      ],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ["glue:*", "lakeformation:*"],
      resources: ["*"],
    }));

    new cdk.CfnOutput(this, "FlinkRoleArn", { value: role.roleArn });
  }
}
