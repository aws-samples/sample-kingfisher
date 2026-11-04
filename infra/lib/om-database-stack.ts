import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

interface Props extends cdk.StackProps { vpc: ec2.IVpc; dataKey: kms.IKey; }

export class OmDatabaseStack extends cdk.Stack {
  public readonly db: rds.DatabaseInstance;
  public readonly dbSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    this.dbSg = new ec2.SecurityGroup(this, "OmDbSg", { vpc: props.vpc, description: "OpenMetadata DB" });
    this.dbSg.addIngressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(3306));

    this.db = new rds.DatabaseInstance(this, "OmDb", {
      instanceIdentifier: "bgp-openmetadata-db",
      // (用户 2026-10-25 拍板):MySQL 8.0 → **8.4**。RDS 对 MySQL 8.0 自 2026-08-01 起收「扩展支持」费
      //   ($0.10 / vCPU·h,本实例 Multi-AZ 4 vCPU ⇒ ≈ $292 / 月,docs/COST-MODEL.md §7 第 1 条),8.4 在标准支持内。
      //   只钉大版本(与原 VER_8_0 同一口径):CloudFormation 收到 "8.4" 由 RDS 选该大版本的默认小版本,小版本自动升级照旧。
      //   存量环境升级 = RDS 原地大版本升级(Multi-AZ 实例一次停机窗口约 10–20 分钟,RDS 升级前自动留快照;回滚 = 从快照恢复),
      //   由 scripts/redeploy-platform.sh 的 2c″ 步部署本栈触发(升级须知见 CHANGELOG / 手册 §7ter)。
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.of("8.4", "8.4") }),
      // 🔴 没有这一项 CloudFormation 会拒绝大版本变更(「Cannot upgrade mysql from 8.0.x to 8.4 … AllowMajorVersionUpgrade」),整栈回滚
      allowMajorVersionUpgrade: true,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      vpc: props.vpc, vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.dbSg],
      databaseName: "openmetadata_db",
      // RDS 拒绝口令含 `/ @ " 空格`;OM 还会把口令拼进 JDBC URL,故一并排除 URL/连接串敏感字符
      //（/ @ 空格 : ; = + 等）。原排除集漏了 `/` 与空格,导致随机命中 `/` 时 CREATE_FAILED。
      credentials: rds.Credentials.fromGeneratedSecret("omadmin", {
        excludeCharacters: "'\"{}[]#&*?|>!%@\\/ :;=+`$^(),<.~",
      }),
      allocatedStorage: 20,
      // WS2 Multi-AZ 去单点 + WS1 CMK 静态加密 + WS3 备份/RETAIN/删除保护。
      multiAz: true,
      storageEncrypted: true,
      storageEncryptionKey: props.dataKey,
      backupRetention: cdk.Duration.days(30),
      removalPolicy: cdk.RemovalPolicy.RETAIN, deletionProtection: true,
      // 不覆盖 sort_buffer_size:OM 是低并发元数据库,默认值(256KB)足够。此前设 20MB 是【每连接】
      // 分配的过大排序缓冲,在小规格实例(T3.SMALL 2GB)+ Multi-AZ 的严格内存校验下被 RDS 判定
      // "memory setting inappropriate" → incompatible-parameters → CREATE_FAILED(某些账号/规格
      // 组合才触发,故此前侥幸未暴露)。移除后与成功的 source-mysql(仅设 binlog 参数)口径一致。
    });

    new cdk.CfnOutput(this, "DbEndpoint", { value: this.db.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, "DbPort", { value: this.db.dbInstanceEndpointPort });
  }
}
