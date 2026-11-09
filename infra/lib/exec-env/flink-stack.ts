// 执行环境 **flink 组件**栈(50 SPEC §1.1 的 `flink` 资源袋:`flinkRoleArn`)。
//
// 【和 home 的 `infra/lib/flink-stack.ts` 什么关系】
//   动作集**照抄 home 那份**(逐条对着读的,没有发明新权限);差别只有两处,且都是多 region 的必然:
//   ① **角色名 per-target**:IAM 是**全局**资源,第二 region 再建 `bgp-flink-role` 必 `AlreadyExists`
//      (DESIGN §12 P0-D)⇒ 用命名 SSOT 的 per-target 名 `BgpExecEnv-<slug>-flink-role`。
//      (core 栈里的 `glueRoleArn` 走的是另一条路 —— 引用 home 的角色;那是因为 Glue 角色被 home 侧
//       大量既有代码按名引用。Flink 角色只被本 target 的 MSAF 应用用,所以可以 per-target。)
//   ② **桶/表桶 ARN 指向本 target 自己的资源**(home 那份写死 `bgp-datalake-<acct>`):
//      作业的输入 JAR、输出数据、Iceberg 表都必须留在本 region —— 指回 home 就是数据出境。
//
// 🔴 MSAF 应用本身(每个流作业一个)由平台的 flink-service 按需 Create/Start/Delete,
//    **本栈只建零成本的服务执行角色**(与 home 同口径:门控栈默认开也几乎零常驻计费)。
//
// 🔴 资源文案字段一律英文(IAM `description` 只收 **Latin-1**:中文 400、synth 不校验、真部署才炸)。
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
import { resourceName } from "../shared/naming";
// 数据湖表桶路由:「本区任意 S3 Tables 表桶」ARN 的唯一作者
import { anyTableBucketArn } from "../shared/table-bucket-arn";
import { ExecEnvStack, type ExecEnvStackProps } from "./exec-env-stack";

export interface ExecEnvFlinkStackProps extends ExecEnvStackProps {
  /** 底座的数据域 CMK:解密输出桶 / S3Tables。 */
  dataKey: kms.IKey;
}

export class ExecEnvFlinkStack extends ExecEnvStack {
  constructor(scope: Construct, id: string, props: ExecEnvFlinkStackProps) {
    super(scope, id, props);
    const { ctx, dataKey } = props;
    const nameOf = (kind: string) => resourceName(kind, { targetId: ctx.targetId, account: ctx.account });
    const { region, account } = ctx;
    // 🔴 partition 用伪参数而不是写死 "aws":aws-cn / aws-us-gov 下 ARN 前缀不同(§1.1a 的分区意识)。
    const p = cdk.Aws.PARTITION;

    const role = new iam.Role(this, "FlinkRole", {
      roleName: nameOf("flinkRole"),
      assumedBy: new iam.ServicePrincipal("kinesisanalytics.amazonaws.com"),
      description: `BGP exec-env ${ctx.targetId} MSAF Flink application service execution role`,
    });

    // KMS:解密本 target 的输出桶 / S3Tables。
    // ⚠️ 副作用如实登记:CMK 构造在 **base 栈** ⇒ 这条 grant 落进 base 的模板,第一次装 flink 时
    //    base 会更新一次(纯策略变更、无资源替换)。栈组已 addDependency(base),顺序天然正确。
    dataKey.grant(role, "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey");

    // Kinesis 源(平台按需建流,不建固定流 ⇒ 只授"消费本账号本区任意平台流"的读权限)。
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "kinesis:DescribeStream",
          "kinesis:DescribeStreamSummary",
          "kinesis:ListShards",
          "kinesis:GetShardIterator",
          "kinesis:GetRecords",
          "kinesis:SubscribeToShard",
        ],
        resources: [`arn:${p}:kinesis:${region}:${account}:stream/*`],
      })
    );

    // MSK/Kafka 源的 **IAM 认证数据面**动作族(kafka-cluster:*,不是控制面的 kafka:*)。
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "kafka-cluster:Connect",
          "kafka-cluster:DescribeCluster",
          "kafka-cluster:DescribeTopic",
          "kafka-cluster:ReadData",
          "kafka-cluster:DescribeGroup",
          "kafka-cluster:AlterGroup",
        ],
        resources: [
          `arn:${p}:kafka:${region}:${account}:cluster/*`,
          `arn:${p}:kafka:${region}:${account}:topic/*`,
          `arn:${p}:kafka:${region}:${account}:group/*`,
        ],
      })
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["kafka:GetBootstrapBrokers", "kafka:DescribeClusterV2"],
        resources: [`arn:${p}:kafka:${region}:${account}:cluster/*`],
      })
    );

    // 读应用 JAR(本 target 的脚本桶 flink/ 前缀)
    const scriptsBucket = nameOf("scriptsBucket");
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket", "s3:GetBucketLocation"],
        resources: [`arn:${p}:s3:::${scriptsBucket}`, `arn:${p}:s3:::${scriptsBucket}/*`],
      })
    );
    // 写流计算输出(本 target 的数据湖桶)
    const datalakeBucket = nameOf("datalakeBucket");
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
          "s3:GetBucketLocation",
          "s3:AbortMultipartUpload",
          "s3:ListBucketMultipartUploads",
          "s3:ListMultipartUploadParts",
        ],
        resources: [`arn:${p}:s3:::${datalakeBucket}`, `arn:${p}:s3:::${datalakeBucket}/*`],
      })
    );

    // MSAF 应用日志与指标
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
        ],
        resources: ["*"],
      })
    );
    role.addToPolicy(new iam.PolicyStatement({ actions: ["cloudwatch:PutMetricData"], resources: ["*"] }));

    // MSAF VPC 接入:把应用挂进私有 VPC 需要管 ENI(这些动作 AWS 不支持资源级限定)。
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
          "ec2:CreateNetworkInterfacePermission",
          "ec2:DescribeNetworkInterfacePermissions",
          "ec2:DescribeSubnets",
          "ec2:DescribeVpcs",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeDhcpOptions",
        ],
        resources: ["*"],
      })
    );

    // S3 Tables(托管 Iceberg)sink。数据湖表桶路由(设计稿 §6.7):从「只有本 target 的平台表桶」放到「本区**任意**表桶 bucket/*」
    //   (与本区 Glue / EMR / Redshift-copy 角色 2026-10-27 起同一口径;Phase 3 的 Flink lakeRoute 选桶 sink 要它)。ARN 形态唯一作者
    //   shared/table-bucket-arn.ts;region 段仍绑本区,synth-gate §9.8 断言不含任何桶名字面。
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3tables:*"],
        resources: anyTableBucketArn(p, region, account),
      })
    );
    // ⚠️ 与 home 逐字相同的宽授权(`glue:*` / `lakeformation:*` on `*`):S3Tables 经 Glue/Lake Formation
    //    联邦目录治理,收窄需要先摸清实际调用集。**刻意保持与 home 一致**(收窄是全平台一起做的事,
    //    在这里单独收窄会造出"两个 region 行为不同"的更坏问题)。已作为观察项交回主线程。
    role.addToPolicy(new iam.PolicyStatement({ actions: ["glue:*", "lakeformation:*"], resources: ["*"] }));

    new cdk.CfnOutput(this, "flinkRoleArn", { value: role.roleArn });
  }
}
