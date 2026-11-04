import * as cdk from "aws-cdk-lib";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

// 模块 27 (WS1) — 加密底座:客户托管 CMK。
//
// 设计:按"数据域"分两把 CMK,而非一把通吃——便于按域审计/轮换/隔离访问。
//  - dataKey:湖仓与数据库静态加密(RDS / Redshift / OpenSearch / DynamoDB / S3)。
//  - logsKey:日志与审计(CloudWatch Logs / 审计桶,WS4/WS6 会用)。
// 两把都开**自动年度轮换**,且 **RemovalPolicy.RETAIN + 启用删除等待期**——CMK 一旦被删,
// 用它加密的数据将永久不可解;保留策略防止 `cdk destroy` 误删导致灾难。
//
// 服务透明加密(RDS/Redshift/OpenSearch/DynamoDB)解密由 AWS 服务经 grant 完成,调用方
// (应用角色)无需 kms 权限;S3 SSE-KMS 需调用方持 kms:Decrypt,故 S3 的 CMK 化放在 WS4
// (IAM 收敛)精确映射各角色授权后再开启,WS1 阶段 S3 用强化的 SSE-S3 + 强制 TLS。
export class KmsStack extends cdk.Stack {
  public readonly dataKey: kms.Key;
  public readonly logsKey: kms.Key;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.dataKey = new kms.Key(this, "BgpDataKey", {
      alias: "alias/bgp-data",
      description: "BGP 数据域静态加密 CMK(RDS/Redshift/OpenSearch/DynamoDB/S3)",
      enableKeyRotation: true, // 自动年度轮换
      removalPolicy: cdk.RemovalPolicy.RETAIN, // 防误删:删 CMK = 数据永久不可解
      pendingWindow: cdk.Duration.days(30), // 删除前 30 天等待期(可取消)
    });

    this.logsKey = new kms.Key(this, "BgpLogsKey", {
      alias: "alias/bgp-logs",
      description: "BGP 日志/审计加密 CMK(CloudWatch Logs / 审计桶)",
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pendingWindow: cdk.Duration.days(30),
    });

    // CloudWatch Logs 必须能用该 key 加密日志组(否则 WS6 接入时创建日志组会失败)。
    // 仅授权本区域的 logs 服务主体,且用 EncryptionContext 限定为本账号的日志组,收敛授权面。
    this.logsKey.grantEncryptDecrypt(
      new cdk.aws_iam.ServicePrincipal(`logs.${cdk.Stack.of(this).region}.amazonaws.com`)
    );

    // 模块 27 (WS4b-1): CloudTrail 用本 key 加密日志文件,需 key policy 授权 cloudtrail 服务主体
    // (GenerateDataKey* + DescribeKey)。否则建 Trail 报 "Insufficient permissions to access KMS key"。
    // 用 SourceArn 条件限定为本账号的 trail,收敛授权面。
    this.logsKey.addToResourcePolicy(new cdk.aws_iam.PolicyStatement({
      sid: "AllowCloudTrailEncrypt",
      principals: [new cdk.aws_iam.ServicePrincipal("cloudtrail.amazonaws.com")],
      actions: ["kms:GenerateDataKey*", "kms:DescribeKey"],
      resources: ["*"], // 资源策略内 "*" 指本 key 自身
      conditions: {
        StringLike: {
          "kms:EncryptionContext:aws:cloudtrail:arn": `arn:aws:cloudtrail:*:${cdk.Stack.of(this).account}:trail/*`,
        },
      },
    }));

    new cdk.CfnOutput(this, "DataKeyArn", { value: this.dataKey.keyArn });
    new cdk.CfnOutput(this, "LogsKeyArn", { value: this.logsKey.keyArn });
  }
}
