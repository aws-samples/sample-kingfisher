import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import { Construct } from "constructs";

// 模块 27 (WS4b-1) — 审计底座。
//
// 与应用层 bgp-audit 表互补:bgp-audit 记"谁在平台里做了什么操作",本栈记"谁动了 AWS
// 资源(控制面 API)"与"网络流量"。
//  - CloudTrail:管理事件(IAM/EC2/S3/KMS… 控制面调用)→ S3,日志桶用 logs CMK 加密 +
//    阻断公共访问 + 强制 TLS + 生命周期归档。
//  - VPC Flow Logs:VPC 内网络流量(ACCEPT/REJECT)→ CloudWatch Logs(logs CMK 加密)。
//
// 纯增量、零功能风险(不改任何现有资源的行为)。
//
// ⚠️ workshop 临时账号可能有 SCP 禁止建 CloudTrail。故 CloudTrail 受 context 开关控制:
//    默认建;若该账号不允许,部署带 -c skip-cloudtrail=1 跳过,仅保留 Flow Logs。
interface AuditStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  logsKey: kms.IKey;
  /**
   * 该 VPC 是否是【导入的现有 VPC】(VpcStack.imported 的单一来源)。
   *
   * 🔴 为什么要有这个标记(实测事故):`vpc-stack.ts` 在导入模式下刻意不建 S3 Gateway Endpoint,
   * 理由是"绝不往别人 CloudFormation 栈名下的 VPC 里塞资源"。但本栈过去**无条件**给 `props.vpc`
   * 挂 `CfnFlowLog` —— 于是同一次部署里,一边声明不碰别人的 VPC,一边把 TrafficType=ALL 的
   * Flow Log 挂了上去(2026-08-29 在共用 workshop 账号实测发生:`fl-0d27a1e2b86f5ce20` 已 ACTIVE)。
   * 那个 VPC 里跑着别人的 EKS/负载,ALL 流量的 CloudWatch 摄入既是他人资源上的变更、也是真实成本。
   * ⇒ 导入模式默认**不挂** Flow Log;确实需要时用 `-c vpcFlowLogOnImported=1` 显式选择。
   */
  vpcImported?: boolean;
}

export class AuditStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AuditStackProps) {
    super(scope, id, props);

    // ── VPC Flow Logs → CloudWatch Logs(CMK 加密)──
    // 用低层 CfnFlowLog 直接引用 VPC id,使 FlowLog 与日志组/角色都建在本 AuditStack 内——
    // 依赖方向为 Audit→Vpc(只读引用 vpcId),避免 vpc.addFlowLog() 把资源塞进 VpcStack 而造成
    // VpcStack 反向依赖 AuditStack(底层栈不应依赖审计栈)。
    const flowLogGroup = new logs.LogGroup(this, "VpcFlowLogs", {
      logGroupName: "/bgp/vpc-flow-logs",
      retention: logs.RetentionDays.ONE_MONTH, // 合规:≥30 天
      encryptionKey: props.logsKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const flowRole = new iam.Role(this, "FlowLogRole", {
      assumedBy: new iam.ServicePrincipal("vpc-flow-logs.amazonaws.com"),
    });
    flowLogGroup.grantWrite(flowRole);
    // 🔴 导入的 VPC 默认不挂 Flow Log —— 那是别人栈名下的资源(见 props.vpcImported 注释)。
    // 日志组与角色仍然创建:它们是本栈自己的资源、空载零成本,且一旦显式 opt-in 或将来切回自建
    // VPC 就直接可用;不建它们反而会因 RemovalPolicy.RETAIN 留下孤儿。
    const attachFlowLog = !props.vpcImported || this.node.tryGetContext("vpcFlowLogOnImported") === "1";
    if (attachFlowLog) {
      new ec2.CfnFlowLog(this, "BgpVpcFlowLog", {
        resourceId: props.vpc.vpcId,
        resourceType: "VPC",
        trafficType: "ALL",
        logDestinationType: "cloud-watch-logs",
        logGroupName: flowLogGroup.logGroupName,
        deliverLogsPermissionArn: flowRole.roleArn,
      });
    }
    new cdk.CfnOutput(this, "VpcFlowLogAttached", { value: String(attachFlowLog) });

    // ── CloudTrail(管理事件)→ S3(CMK 加密)──
    const skipCloudTrail = this.node.tryGetContext("skip-cloudtrail") === "1";
    if (!skipCloudTrail) {
      const trailBucket = new s3.Bucket(this, "TrailBucket", {
        bucketName: `bgp-cloudtrail-${cdk.Stack.of(this).account}`,
        encryption: s3.BucketEncryption.KMS,
        encryptionKey: props.logsKey,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        lifecycleRules: [
          { transitions: [{ storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(90) }] },
        ],
      });
      new cloudtrail.Trail(this, "BgpTrail", {
        trailName: "bgp-management-trail",
        bucket: trailBucket,
        encryptionKey: props.logsKey,
        includeGlobalServiceEvents: true,
        isMultiRegionTrail: true,
        enableFileValidation: true, // 日志完整性校验(防篡改)
      });
      new cdk.CfnOutput(this, "TrailBucketName", { value: trailBucket.bucketName });
    }

    new cdk.CfnOutput(this, "FlowLogGroup", { value: flowLogGroup.logGroupName });
  }
}
