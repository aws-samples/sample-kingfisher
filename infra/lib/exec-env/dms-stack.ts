// 执行环境 **dms 组件**栈(50 SPEC §1.1 的 `dms` 资源袋:`dmsSubnetGroup`)。
//
// 【本栈为什么这么薄 —— 不是没做完,是 DMS 的形态如此】
//   复制实例(`AWS::DMS::ReplicationInstance`)是**按小时计费的常驻资源**,而平台的既有做法是
//   「同步任务需要时按需 provision 实例、用完销毁」(home 侧 `realtime-stack.ts` 同样只建子网组)。
//   ⇒ 组件栈只交付**实例的耐久前置**:子网组(告诉 DMS 能把 ENI 放进哪些私有子网)。
//   §3.1a 对 `dms` 组件要求的实名资源也正好只有 `dmsSubnetGroup` 一项(不发明合同)。
//
// 🔴 资源文案字段一律英文(本模块被"中文描述"整栈 ROLLBACK 过一次:EC2 SG 的 GroupDescription
//    只收 ASCII、IAM description 只收 Latin-1,synth 不校验、真部署才 400)。
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as dms from "aws-cdk-lib/aws-dms";
import { Construct } from "constructs";
import { resourceName } from "../shared/naming";
import { ExecEnvStack, type ExecEnvStackProps } from "./exec-env-stack";
import { boundStatement, bucketArnPair, perTargetExecRole, serviceTrust } from "./exec-roles";
// 私有子网类型的唯一真值(零出网 = PRIVATE_ISOLATED)
import { execEnvPrivateSubnets } from "./private-subnets";

export interface ExecEnvDmsStackProps extends ExecEnvStackProps {
  vpc: ec2.IVpc;
  /** 底座的数据域 CMK:DMS 写 S3 暂存 / 读 secret 时解密(与 home `realtime-stack.ts` 同口径)。 */
  dataKey: kms.IKey;
}

export class ExecEnvDmsStack extends ExecEnvStack {
  constructor(scope: Construct, id: string, props: ExecEnvDmsStackProps) {
    super(scope, id, props);
    const { ctx, vpc, dataKey } = props;
    const nameOf = (kind: string) => resourceName(kind, { targetId: ctx.targetId, account: ctx.account });
    const p = cdk.Aws.PARTITION;
    const { region, account } = ctx;

    // ──:per-target DMS 统一角色(SPEC v3.21 §6.1 段二)──────────────────
    // 照抄 home `realtime-stack.ts` 的 `bgp-dms-kinesis-role`:信任 dms + **区域化** dms.<region> + redshift(COPY 时
    // assume 本角色读 S3 暂存);动作集相同,资源面改指本 target 的数据湖桶 / 本 region secret。
    // 🔴 **消费方接线不在本包**:DMS 实时同步尚未 target 化(`dms-service.ts` 仍读 home 的 `DMS_ROLE_ARN`),
    //    ;这里先把角色与探活备好,免得届时又回头改栈(再改一次 = usw2 再重新部署一次)。
    const dmsRole = perTargetExecRole(this, "DmsKinesisRole", {
      ctx,
      kind: "dmsKinesisRole",
      assumedBy: new iam.CompositePrincipal(
        serviceTrust(ctx, "dms.amazonaws.com"),
        serviceTrust(ctx, `dms.${region}.amazonaws.com`),
        serviceTrust(ctx, "redshift.amazonaws.com")
      ),
      description: `BGP exec-env ${ctx.targetId} DMS replication role (secrets + S3 staging + Redshift target; bound to this target)`,
    });
    dataKey.grant(dmsRole, "kms:GenerateDataKey", "kms:Encrypt", "kms:Decrypt", "kms:DescribeKey");
    dmsRole.addToPolicy(
      boundStatement(ctx, {
        actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
        resources: ["bgp/*", "bgp-*", "redshift!*"].map((x) => `arn:${p}:secretsmanager:${region}:${account}:secret:${x}`),
      })
    );
    dmsRole.addToPolicy(
      boundStatement(ctx, {
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation"],
        resources: bucketArnPair(p, nameOf("datalakeBucket")),
      })
    );
    // Redshift 目标端点 resolving configuration 要能碰到数仓本身(home 的 BUG-3 修复原样搬过来);资源级不可限定 ⇒ 区域条件
    dmsRole.addToPolicy(
      boundStatement(ctx, {
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
      })
    );

    const subnetGroupId = resourceName("dmsSubnetGroup", { targetId: ctx.targetId, account: ctx.account });
    // 🔴 子网必须是**跨 AZ 的私有子网**:DMS 要求子网组覆盖 ≥2 个 AZ(底座固定给 2 个 AZ),
    //    且复制实例要能出网访问源库 ⇒ PRIVATE_WITH_EGRESS(经 NAT),不放公有子网。
    new dms.CfnReplicationSubnetGroup(this, "SubnetGroup", {
      replicationSubnetGroupIdentifier: subnetGroupId,
      replicationSubnetGroupDescription: `BGP exec-env ${ctx.targetId} DMS replication subnet group`,
      subnetIds: execEnvPrivateSubnets(vpc).subnetIds,
    });

    new cdk.CfnOutput(this, "dmsSubnetGroup", { value: subnetGroupId });
    // 🔴 组件**可选**键(平台 `COMPONENT_OPTIONAL_RESOURCES.dms`,读到才进袋;不追溯存量必填)
    new cdk.CfnOutput(this, "dmsKinesisRoleArn", { value: dmsRole.roleArn });
  }
}
