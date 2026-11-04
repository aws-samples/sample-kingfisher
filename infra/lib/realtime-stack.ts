import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dms from "aws-cdk-lib/aws-dms";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
// 资源 ARN 的 region 段唯一出口 + 显式轴声明。
import { regionalStatement } from "./shared/execution-regions";

// 实时数据集成基建(DMS CDC 的耐久依赖)。
//
// ⚠️ 门控栈,但**默认打开**(bin/app.ts 默认 enable-realtime=1):本栈现在只创建**≈零成本的耐久基建**
// (子网组 + 安全组 + 角色),不再建常驻计费资源,故默认全开也几乎零常驻计费。
//
// 成本改造(2026-07-07,用户拍板):
//  · 删除 Kinesis 流 —— 平台不写 Kinesis(见 platform-stack 注释),MySQL→Redshift 场景不经 Kinesis,纯多余常驻。
//  · DMS 复制实例改**懒创建**(dms-service.getReplicationInstanceArn:建同步任务时若 bgp-dms 不存在则创建,
//    用本栈的固定名子网组 bgp-dms-subnet-group + SG bgp-dms-sg,首次 ~3-5min,之后复用)。
//    实例不再随栈常驻计费;用完可 delete,基建(子网组/SG/角色)留着复用。
// 源/目标 endpoint 与复制任务由服务层(R3/R4)按需动态创建(需源库凭证/目标配置)。
interface RealtimeStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  dataKey: kms.IKey; // WS1 数据域 CMK(DMS 目标写入 / COPY 暂存解密)
}

export class RealtimeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RealtimeStackProps) {
    super(scope, id, props);
    const { vpc } = props;
    const region = cdk.Stack.of(this).region;
    const acct = cdk.Stack.of(this).account;

    // ── DMS 账号级服务角色(dms-vpc-role / dms-cloudwatch-logs-role)──
    // 这两个是 DMS 账号级固定名角色,首次用 DMS 必需。若已存在则跳过(幂等由部署 runbook 保证)。
    // 这里创建到本栈;若账号已存在同名角色,部署会报 AlreadyExists → 用 -c skip-dms-roles=1 跳过。
    const skipDmsRoles = this.node.tryGetContext("skip-dms-roles") === "1";
    if (!skipDmsRoles) {
      new iam.CfnRole(this, "DmsVpcRole", {
        roleName: "dms-vpc-role",
        assumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [{ Effect: "Allow", Principal: { Service: "dms.amazonaws.com" }, Action: "sts:AssumeRole" }],
        },
        managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AmazonDMSVPCManagementRole"],
      });
    }

    // ── DMS 安全组:出站到 RDS(3306)与 Redshift(5439),都在 VPC 内 ──
    const dmsSg = new ec2.SecurityGroup(this, "DmsSg", {
      vpc,
      securityGroupName: "bgp-dms-sg", // 固定名:服务层运行时按名查 id(Serverless ComputeConfig 用)
      description: "BGP DMS Serverless SG",
      allowAllOutbound: true, // DMS 需连源/目标 + Kinesis/Secrets/KMS 端点
    });

    // ── DMS 复制子网组(私有子网)──
    const subnetGroup = new dms.CfnReplicationSubnetGroup(this, "DmsSubnetGroup", {
      replicationSubnetGroupIdentifier: "bgp-dms-subnet-group",
      replicationSubnetGroupDescription: "BGP DMS private subnets",
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
    });

    // ── DMS 复制实例:改为**懒创建**(不再随栈常驻,成本改造 2026-07-07)──
    // 服务层 dms-service.getReplicationInstanceArn() 在建同步任务时:若 bgp-dms 不存在,则用本栈的
    // 固定名子网组(bgp-dms-subnet-group)+ SG(bgp-dms-sg)调 CreateReplicationInstance(dms.t3.small,
    // 单 AZ,私有不公网,引擎 3.5.4),轮询 available(首次 ~3-5min),之后复用;不用时可 delete 止血,
    // 基建(子网组/SG/角色)留着零成本复用。经典实例在私有子网有 ENI,走 bgp-dms-sg 出站到源(3306)/
    // 目标(5439)+ NAT。S3 Gateway endpoint 在 VpcStack(与私有路由表同栈)。
    // ⇒ 本栈不再创建 CfnReplicationInstance;子网组 + SG(上方)是懒创建的耐久依赖。

    // ── DMS 统一角色:读源/目标凭证 + Redshift COPY 暂存 S3(不再写 Kinesis)──
    // 固化 R4 实测的完整信任与权限(踩坑②⑥):信任 dms + 【区域化】dms.<region> + redshift
    //(redshift 用于 COPY 时 assume 本角色读 S3 暂存)。
    const dmsTargetRole = new iam.Role(this, "DmsKinesisRole", {
      roleName: "bgp-dms-kinesis-role",
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal("dms.amazonaws.com"),
        new iam.ServicePrincipal(`dms.${region}.amazonaws.com`),
        new iam.ServicePrincipal("redshift.amazonaws.com")
      ),
    });
    props.dataKey.grant(dmsTargetRole, "kms:GenerateDataKey", "kms:Encrypt", "kms:Decrypt", "kms:DescribeKey");

    // 读凭证:平台 bgp/* + bgp-* + RDS/Redshift 的 CDK 默认命名 secret(BgpRdsStack*/redshift!*)。
    dmsTargetRole.addToPolicy(regionalStatement(this, {
      axis: "home",
      reason: "本角色是 home 的 DMS 统一角色(信任主体已含 dms.<home-region>);per-target DMS 由 exec-env 栈在目标 region 各建一套",
      actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
      resources: (r) => [
        `arn:aws:secretsmanager:${r}:${acct}:secret:bgp/*`,
        `arn:aws:secretsmanager:${r}:${acct}:secret:bgp-*`,
        `arn:aws:secretsmanager:${r}:${acct}:secret:BgpRdsStack*`,
        `arn:aws:secretsmanager:${r}:${acct}:secret:redshift!*`,
      ],
    }));
    // Redshift COPY 暂存桶(DMS→Redshift 经 S3 中转):数据湖桶读写。
    dmsTargetRole.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation"],
      resources: [`arn:aws:s3:::bgp-datalake-${acct}`, `arn:aws:s3:::bgp-datalake-${acct}/*`],
    }));
    // BUG-3 修复(2026-07-04):DMS Redshift 目标端点"resolving configuration"要求角色能访问 Redshift 集群本身
    //(此前只有 kinesis/s3/secrets/kms → FATAL "Failed in resolving configuration")。补 Redshift Serverless
    // 临时凭证 + Data API + 集群描述权限。资源用 * —— Serverless 的 GetCredentials/redshift-data 多为账户级动作,
    // 且平台 workgroup/namespace 名固定命名可控;避免因 ARN 形态差异再次 resolving 失败。
    dmsTargetRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "redshift-serverless:GetCredentials",
        "redshift-serverless:GetWorkgroup",
        "redshift:GetClusterCredentials",
        "redshift:GetClusterCredentialsWithIAM",
        "redshift:DescribeClusters",
        "redshift-data:ExecuteStatement",
        "redshift-data:BatchExecuteStatement",
        "redshift-data:DescribeStatement",
        "redshift-data:GetStatementResult",
      ],
      resources: ["*"],
    }));

    // 耐久基建输出(复制实例由服务层懒创建,不在此输出)。
    new cdk.CfnOutput(this, "DmsSubnetGroupId", { value: subnetGroup.replicationSubnetGroupIdentifier! });
    new cdk.CfnOutput(this, "DmsKinesisRoleArn", { value: dmsTargetRole.roleArn });
    new cdk.CfnOutput(this, "DmsSgId", { value: dmsSg.securityGroupId });
  }
}
