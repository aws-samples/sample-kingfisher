// @kf-batch 50-P50.2a-exec-env-stackgroup(v2 @ 50-W5-seg1-WP3:per-target 执行角色)
// 执行环境 **core 组件**栈(50 SPEC §1.1 的 core 资源袋)。
//
// 交付 `REQUIRED_CORE_RESOURCES` 那六项的真实资源 + 把实名以 CFN Output 吐出来:
//   datalakeBucket / scriptsBucket / tableBucket / athenaWorkgroup / glueRoleArn / emrSecurityGroupId
//   + 🔴 WP-3 起 `emrExecutionRoleArn`(EMR Serverless 作业执行角色,per-target;SPEC v3.21 §6.1 段二)
// (`emrSubnetIds` 由底座栈的 privateSubnetIds 提供,这里一并转出,免得 buildspec 拼两个栈的输出。)
//
// 🔴🔴 **WP-3(2026-09-05)订正 P50.2 的「IAM 角色只在 home 建一次、栈组引用 home 角色」定案**:
//   那是 SPEC §6.1 段一的过渡形态。跨法域 target 上线前的硬门(段二)= 每个 target 用**绑死本 target** 的角色,
//   共享角色只剩 home。Glue / EMR 不是组件而是 core 能力 ⇒ 两个角色都建在本栈:
//   `glueRoleArn` **改吐本 target 的角色**(不再是 home 的 `bgp-glue-role`),新增 `emrExecutionRoleArn`。
//   角色名 / 信任条件 / 区域条件三层绑定由 `exec-roles.ts` 统一补(见该文件头)。
//
// 🔴🔴 **数据保护(DESIGN §4.1a / §12 P0-A,风险表唯一"客户数据永久丢失"项)**:
//   home 的 `platform-stack.ts:51-53` 三个桶是 `RemovalPolicy.DESTROY + autoDeleteObjects:true`,
//   表桶是 `applyRemovalPolicy(DESTROY)` —— 也就是说 **`cdk destroy` 会清空并删掉数据湖桶和表桶**。
//   执行环境栈组**必须反过来**:数据类资源一律 `RETAIN` 且**不得**带 `autoDeleteObjects`。
//   这不是"更保守一点"的偏好,是"删环境不许删客户数据"的硬要求(ACCEPTANCE C5 会拿真桶去证)。
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as athena from "aws-cdk-lib/aws-athena";
import * as s3tables from "aws-cdk-lib/aws-s3tables";
import { Construct } from "constructs";
import { resourceName } from "../shared/naming";
import { ExecEnvStack, type ExecEnvStackProps } from "./exec-env-stack";
import {
  boundStatement,
  bucketArnPair,
  DDB_READ_ACTIONS,
  EC2_ENI_ACTIONS,
  execRoleArnOf,
  perTargetExecRole,
  REDSHIFT_DATA_ACTIONS,
  S3_RO_ACTIONS,
  S3_RW_ACTIONS,
  serviceTrust,
  tableBucketAnyArn,
} from "./exec-roles";
// @kf-batch 50-WP16-zero-egress —— 私有子网类型的唯一真值(零出网 = PRIVATE_ISOLATED)
import { execEnvPrivateSubnets } from "./private-subnets";

export interface ExecEnvCoreStackProps extends ExecEnvStackProps {
  vpc: ec2.IVpc;
  /** 底座的数据域 CMK:EMR 作业解密本 target 的桶 / 流(与 home `emr-stack.ts` 同口径)。 */
  dataKey: kms.IKey;
}

export class ExecEnvCoreStack extends ExecEnvStack {
  public readonly emrSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: ExecEnvCoreStackProps) {
    super(scope, id, props);
    const { ctx, vpc, dataKey } = props;
    const nameOf = (kind: string) => resourceName(kind, { targetId: ctx.targetId, account: ctx.account });
    // 🔴 partition 用伪参数而不是写死 "aws":aws-cn / aws-us-gov 下 ARN 前缀不同(§1.1a 的分区意识)。
    const p = cdk.Aws.PARTITION;
    const { region, account } = ctx;

    // 与 home 逐字节相同的桶硬化基线(platform-stack.ts:46-50):SSE-S3 + 全禁公网 + 强制 TLS。
    const s3Hardened = {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // 🔴 RETAIN + 不带 autoDeleteObjects(见文件头)。home 侧是 DESTROY+autoDelete,这里刻意相反。
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    } as const;

    const datalakeBucketName = nameOf("datalakeBucket");
    new s3.Bucket(this, "DatalakeBucket", { bucketName: datalakeBucketName, ...s3Hardened });
    new s3.Bucket(this, "ScriptsBucket", { bucketName: nameOf("scriptsBucket"), ...s3Hardened });

    // S3 Tables 表桶(Iceberg)。命名空间与表由平台同步流程按需创建。
    const tableBucketName = nameOf("tableBucket");
    const tableBucket = new s3tables.CfnTableBucket(this, "TableBucket", { tableBucketName });
    tableBucket.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN); // 🔴 home 是 DESTROY = 删湖数据

    // Athena workgroup:结果落本 target 自己的数据湖桶(**不跨 region 回 home**,否则查询结果出境)。
    const athenaWorkgroupName = nameOf("athenaWorkgroup");
    new athena.CfnWorkGroup(this, "AthenaWorkGroup", {
      name: athenaWorkgroupName,
      // Athena 工作组描述的字符集限制未知 ⇒ 新代码一律英文,不拿真部署试(§5b)。
      description: `BGP exec-env ${ctx.targetId} workgroup for querying S3 Tables / Iceberg`,
      state: "ENABLED",
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true, // 客户端不可覆盖结果位置与加密
        publishCloudWatchMetricsEnabled: true,
        engineVersion: { selectedEngineVersion: "Athena engine version 3" },
        resultConfiguration: {
          outputLocation: `s3://${datalakeBucketName}/athena-results/`,
          encryptionConfiguration: { encryptionOption: "SSE_S3" },
        },
      },
    });

    // EMR 默认 SG(私有子网出网底座)。描述符里存的是 **id**,这里给的是创建/按名查用的名字。
    this.emrSecurityGroup = new ec2.SecurityGroup(this, "EmrSg", {
      vpc,
      securityGroupName: nameOf("emrSecurityGroup"),
      // 🔴 EC2 SecurityGroup 的 GroupDescription **只收 ASCII**(中文 400;synth 不校验、真部署才炸 ——
      //    与 IAM description 只收 Latin-1 同一类坑,已由门禁 §5b 扫 synth 产物钉死)。中文说明放注释:
      //    EMR Serverless 默认安全组。
      description: `BGP exec-env ${ctx.targetId} default SG for EMR Serverless`,
      allowAllOutbound: true,
    });

    // ── per-target 执行角色(WP-3;SPEC v3.21 §6.1 段二)────────────────────────
    // 🔴 P50.2 那句「取 home 的角色名、栈组引用 home 角色」已作废(见文件头)。两个角色的**动作集照抄 home 同类角色**
    //    (功能守恒:不在这里单独收窄),资源面改指本 target 的三桶 / 表桶 / 本 region;`Resource:"*"` 的语句由
    //    `boundStatement` 自动挂 `aws:RequestedRegion`。唯一刻意的收窄 = **不给任意用户 S3 桶**(home 的 glue 角色有
    //    `s3:GetObject on *` 供用户 S3 源接入):那正是横移负向(ACCEPTANCE E-143)要拒的面;非 home 的用户源接入归 WP-7。
    const scriptsBucketName = nameOf("scriptsBucket");
    const scriptsArns = bucketArnPair(p, scriptsBucketName);
    const datalakeArns = bucketArnPair(p, datalakeBucketName);
    // B-127:s3tables 授权 = 本区**任意**表桶(客户自有表桶登记后要能写;区仍由 ARN 绑死),不再只有本区平台表桶
    const tableBucketArns = tableBucketAnyArn(ctx, p);
    const regionSecrets = (patterns: string[]) => patterns.map((x) => `arn:${p}:secretsmanager:${region}:${account}:secret:${x}`);
    const regionLogs = [`arn:${p}:logs:${region}:${account}:*`];

    // ① Glue 作业执行角色(照抄 platform-stack.ts 的 bgp-glue-role 动作集;不挂 AWSGlueServiceRole,见 exec-roles.ts 文件头)
    const glueRole = perTargetExecRole(this, "GlueRole", {
      ctx,
      kind: "glueRole",
      assumedBy: serviceTrust(ctx, "glue.amazonaws.com"),
      description: `BGP exec-env ${ctx.targetId} Glue job execution role (bound to this target)`,
    });
    // Glue 目录 / Lake Formation / S3Tables 联邦(home 是 glue:* lakeformation:* s3tables:* on *;这里 s3tables 收到本区的表桶)
    glueRole.addToPolicy(boundStatement(ctx, { actions: ["glue:*", "lakeformation:*"] }));
    glueRole.addToPolicy(boundStatement(ctx, { actions: ["s3tables:*"], resources: tableBucketArns }));
    // 本 target 三桶读写(home 是 bgp-* 全部)
    glueRole.addToPolicy(boundStatement(ctx, { actions: [...S3_RW_ACTIONS], resources: [...datalakeArns, ...scriptsArns] }));
    // 读源库 / 数仓凭证(home:本 region 全部 secret,只读)
    glueRole.addToPolicy(
      boundStatement(ctx, { actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"], resources: regionSecrets(["*"]) })
    );
    glueRole.addToPolicy(boundStatement(ctx, { actions: [...REDSHIFT_DATA_ACTIONS] }));
    glueRole.addToPolicy(boundStatement(ctx, { actions: [...DDB_READ_ACTIONS] }));
    glueRole.addToPolicy(boundStatement(ctx, { actions: ["logs:*"], resources: regionLogs }));
    glueRole.addToPolicy(boundStatement(ctx, { actions: ["cloudwatch:PutMetricData"] }));
    // AWSGlueServiceRole 里 Glue 真需要的两组子集:ENI(VPC 连接)+ 查自己的角色(IAM 全局 ⇒ 不能挂区域条件,资源绑到自己)
    glueRole.addToPolicy(boundStatement(ctx, { actions: [...EC2_ENI_ACTIONS] }));
    glueRole.addToPolicy(
      boundStatement(ctx, {
        actions: ["ec2:CreateTags", "ec2:DeleteTags"],
        resources: [
          `arn:${p}:ec2:${region}:${account}:network-interface/*`,
          `arn:${p}:ec2:${region}:${account}:security-group/*`,
          `arn:${p}:ec2:${region}:${account}:instance/*`,
        ],
        conditions: { "ForAllValues:StringEquals": { "aws:TagKeys": ["aws-glue-service-resource"] } },
      })
    );
    glueRole.addToPolicy(
      boundStatement(ctx, {
        actions: ["iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies"],
        resources: [execRoleArnOf(ctx, "glueRole", p)],
      })
    );

    // ② EMR Serverless 作业执行角色(照抄 infra/lib/emr-stack.ts 的 bgp-emr-serverless-role;信任加 SourceArn 钉到本 region)
    const emrRole = perTargetExecRole(this, "EmrRole", {
      ctx,
      kind: "emrServerlessRole",
      assumedBy: serviceTrust(ctx, "emr-serverless.amazonaws.com", {
        ArnLike: { "aws:SourceArn": `arn:${p}:emr-serverless:${region}:${account}:/applications/*` },
      }),
      description: `BGP exec-env ${ctx.targetId} EMR Serverless job execution role (bound to this target)`,
    });
    // ⚠️ 副作用如实登记:CMK 构造在 base 栈 ⇒ 这条 grant 落进 base 的模板(纯策略变更、无资源替换;flink/redshift 同款)。
    dataKey.grant(emrRole, "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey");
    emrRole.addToPolicy(boundStatement(ctx, { actions: [...S3_RO_ACTIONS], resources: scriptsArns }));
    emrRole.addToPolicy(boundStatement(ctx, { actions: [...S3_RW_ACTIONS], resources: datalakeArns }));
    emrRole.addToPolicy(
      boundStatement(ctx, {
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"],
        resources: regionLogs,
      })
    );
    emrRole.addToPolicy(boundStatement(ctx, { actions: ["cloudwatch:PutMetricData"] }));
    emrRole.addToPolicy(boundStatement(ctx, { actions: [...EC2_ENI_ACTIONS] }));
    emrRole.addToPolicy(boundStatement(ctx, { actions: [...DDB_READ_ACTIONS] }));
    emrRole.addToPolicy(boundStatement(ctx, { actions: ["s3tables:*"], resources: tableBucketArns }));
    emrRole.addToPolicy(boundStatement(ctx, { actions: ["glue:*", "lakeformation:*"] }));
    emrRole.addToPolicy(boundStatement(ctx, { actions: [...REDSHIFT_DATA_ACTIONS] }));
    emrRole.addToPolicy(
      boundStatement(ctx, {
        actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
        resources: regionSecrets(["bgp/*", "redshift!*"]),
      })
    );

    // ── Outputs:OutputKey = 描述符字段名(见 base-stack 的说明)────────────
    new cdk.CfnOutput(this, "datalakeBucket", { value: datalakeBucketName });
    new cdk.CfnOutput(this, "scriptsBucket", { value: nameOf("scriptsBucket") });
    new cdk.CfnOutput(this, "tableBucket", { value: tableBucketName });
    new cdk.CfnOutput(this, "athenaWorkgroup", { value: athenaWorkgroupName });
    // 🔴 WP-3:两个角色 ARN 都是**本 target 的**(平台侧 `assertPerTargetExecRole` 按 SSOT 名核;synth-gate #6 反向钉)
    new cdk.CfnOutput(this, "glueRoleArn", { value: glueRole.roleArn });
    new cdk.CfnOutput(this, "emrExecutionRoleArn", { value: emrRole.roleArn });
    new cdk.CfnOutput(this, "emrSecurityGroupId", { value: this.emrSecurityGroup.securityGroupId });
    new cdk.CfnOutput(this, "emrSubnetIds", {
      value: execEnvPrivateSubnets(vpc).subnetIds.join(","),
    });
  }
}
