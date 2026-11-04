import * as cdk from "aws-cdk-lib";
import * as redshiftserverless from "aws-cdk-lib/aws-redshiftserverless";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as kms from "aws-cdk-lib/aws-kms";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
// @kf-batch 50-P50.1-workgroup-ssot — home 的 workgroup 名取自命名 SSOT(部署侧出口)。
import { resourceName, HOME_TARGET_ID } from "./shared/naming";

interface RedshiftStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  dataKey: kms.IKey; // 模块 27 (WS1) — 数据域 CMK
}

export class RedshiftStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RedshiftStackProps) {
    super(scope, id, props);

    const sg = new ec2.SecurityGroup(this, "RedshiftSg", { vpc: props.vpc, description: "Redshift Serverless SG" });
    sg.addIngressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(5439));

    // 模块 27 (WS1 — 加密): 命名空间用数据域 CMK 静态加密。CfnNamespace 是 L1 构造,CDK 不会
    // 像 L2 那样自动补 key policy——故显式授权 Redshift 服务主体使用该 key(含 CreateGrant)。
    props.dataKey.grant(
      new iam.ServicePrincipal("redshift.amazonaws.com"),
      "kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey", "kms:CreateGrant"
    );

    // COPY 角色 —— Redshift Serverless 用它从 S3 staging(Parquet)批量 COPY 加载,替代逐行
    // Data API INSERT(10万行 INSERT 需十几分钟,COPY 数十秒)。必须(a)被 Redshift 服务主体可
    // assume,(b)能读数据湖 staging 桶。关联到 namespace 后,同步脚本 discover_copy_role() 才
    // 能发现它;否则 namespace.iamRoles 为空 → 回退逐行 INSERT(新账号曾因此大表写入退化)。
    // 固定名:平台 TaskRole 的 iam:PassRole 白名单按名字收敛(bgp-redshift-copy-role)。
    // UpdateNamespace(关联 DMS COPY 角色)必须对 iamRoles 列表里【每个】角色都有 PassRole,
    // 若本角色用 CDK 生成名则不在白名单 → 实时通道编排 AccessDenied(实测)。
    const copyRole = new iam.Role(this, "RedshiftCopyRole", {
      roleName: "bgp-redshift-copy-role",
      assumedBy: new iam.ServicePrincipal("redshift.amazonaws.com"),
      description: "Redshift Serverless COPY from S3 staging / S3 Tables",
    });
    copyRole.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject", "s3:GetBucketLocation", "s3:ListBucket"],
      resources: [
        `arn:aws:s3:::bgp-datalake-${this.account}`,
        `arn:aws:s3:::bgp-datalake-${this.account}/*`,
      ],
    }));
    // S3 Tables(Iceberg)读 + Glue catalog 读(COPY/查询 S3Table 时需要)。
    copyRole.addToPolicy(new iam.PolicyStatement({
      actions: ["s3tables:GetTableData", "s3tables:GetTable", "s3tables:GetNamespace", "s3tables:GetTableBucket",
        "s3tables:ListTables", "s3tables:ListNamespaces", "glue:GetTable", "glue:GetTables", "glue:GetDatabase", "glue:GetDatabases", "glue:GetCatalog"],
      resources: ["*"],
    }));
    props.dataKey.grant(copyRole, "kms:Decrypt", "kms:DescribeKey");

    const namespace = new redshiftserverless.CfnNamespace(this, "BgpNamespace", {
      namespaceName: "bgp-namespace",
      dbName: "dev",
      adminUsername: "admin",
      manageAdminPassword: true,
      kmsKeyId: props.dataKey.keyId,
      iamRoles: [copyRole.roleArn],
      defaultIamRoleArn: copyRole.roleArn,
    });
    // 🔴 生产上线批次 A:主控区数仓命名空间 = 客户数据本体。L1 资源不设就是 CFN 默认 Delete ⇒ 改 RETAIN
    //   (与执行区 exec-env/redshift-stack 同口径)。
    namespace.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    const workgroup = new redshiftserverless.CfnWorkgroup(this, "BgpWorkgroup", {
      workgroupName: resourceName("redshiftWorkgroup", { targetId: HOME_TARGET_ID }),
      namespaceName: namespace.namespaceName,
      baseCapacity: 8,
      publiclyAccessible: false,
      subnetIds: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
      securityGroupIds: [sg.securityGroupId],
    });
    workgroup.addDependency(namespace);

    new cdk.CfnOutput(this, "WorkgroupName", { value: workgroup.workgroupName });
  }
}
