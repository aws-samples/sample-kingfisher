import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

interface RdsStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  dataKey: kms.IKey; // 模块 27 (WS1) — 数据域 CMK
}

export class RdsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RdsStackProps) {
    super(scope, id, props);

    const sg = new ec2.SecurityGroup(this, "RdsSg", {
      vpc: props.vpc,
      description: "BGP Source MySQL SG",
    });
    sg.addIngressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(3306));
    // 根因治理(坑2): Glue「NETWORK」连接(造数 job / sync-Glue 通道进 VPC 连 RDS)要求所挂 SG
    // 有【自引用全端口入站】规则,否则 Glue 建作业/跑作业报连不通。此前需带外
    // `authorize-security-group-ingress --source-group 自身` 手动补。改为 IaC 声明,一次根治。
    sg.addIngressRule(sg, ec2.Port.allTraffic(), "Self-reference for Glue NETWORK connection (data-plane)");

    // 根因治理(坑1): 源 MySQL 的 binlog 参数。DMS CDC 需 binlog_format=ROW;Zero-ETL 额外需
    // binlog_row_image=FULL(否则 CreateIntegration 报 "missing parameter(s) ... [binlog_format: ROW,
    // binlog_row_image: FULL]")。默认参数组是 MIXED 且不可改。此前需带外建参数组+挂实例+reboot。
    // 全新实例在此声明自定义参数组零替换风险(见下方实例 parameterGroup),一次根治两个通道的前置。
    const paramGroup = new rds.ParameterGroup(this, "BgpSourceMysqlParams", {
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0 }),
      description: "BGP source MySQL: binlog ROW + row_image FULL for DMS CDC & Zero-ETL",
      parameters: {
        binlog_format: "ROW",
        binlog_row_image: "full",
      },
    });

    const instance = new rds.DatabaseInstance(this, "BgpSourceMysql", {
      instanceIdentifier: "bgp-source-mysql",
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [sg],
      databaseName: "ecommerce",
      // SECURITY: master credentials are generated and stored in AWS Secrets Manager
      // (NO hardcoded password in source — the repo is public). Read the password from
      // `instance.secret` / the RdsSecretArn output when configuring the data source or seeding.
      // 排除 RDS 拒绝(`/ @ " 空格`)与连接串/URL 敏感字符,避免随机命中导致 CREATE_FAILED。
      credentials: rds.Credentials.fromGeneratedSecret("admin", {
        excludeCharacters: "'\"{}[]#&*?|>!%@\\/ :;=+`$^(),<.~",
      }),
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      // 模块 27 (WS2 — 高可用): Multi-AZ 同步备库,主库 AZ 故障自动切换(去单点)。
      multiAz: true,
      publiclyAccessible: false,
      // 模块 27 (WS1 — 加密): 存储用数据域 CMK 静态加密(解密由 RDS 服务经 grant 完成)。
      storageEncrypted: true,
      storageEncryptionKey: props.dataKey,
      // 模块 27 (WS3 — 容灾): 30 天自动备份 + RETAIN + 删除保护,防误删/可时间点恢复。
      backupRetention: cdk.Duration.days(30),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      // 模块 31 (R1) + Zero-ETL 前置: 挂上面声明的自定义参数组(binlog_format=ROW + binlog_row_image=FULL)。
      // 全新实例创建即带正确 binlog 配置,DMS CDC / Zero-ETL 开箱即用,无需带外改参数组+reboot。
      // ⚠️ 对【已存在且带数据】的实例改参数组需评估重启窗口;从零部署无此问题。
      parameterGroup: paramGroup,
    });

    new cdk.CfnOutput(this, "RdsEndpoint", { value: instance.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, "RdsPort", { value: instance.dbInstanceEndpointPort });
    new cdk.CfnOutput(this, "RdsSecretArn", { value: instance.secret?.secretArn ?? "" });
  }
}
