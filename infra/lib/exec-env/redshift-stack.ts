// @kf-batch 50-P50.3a-component-stacks
// 执行环境 **redshift 组件**栈(50 SPEC §1.1 的 `redshift` 资源袋:workgroup / database / adminSecret)。
//
// 【与 home 的 `infra/lib/redshift-stack.ts` 是刻意的两份实现】
//   home 那份吃控制面的活构造(`props.vpc` / `props.dataKey` 来自 BgpVpcStack / BgpKmsStack),
//   第二 region 没有那两个栈 ⇒ 本栈吃的是**本组底座**(base 栈)的 VPC 与 CMK。
//   两份的**名字**由命名 SSOT 统一(namespace/workgroup/database 全走 `resourceName`),这是防漂移那一层。
//
// 🔴🔴 **`redshiftSecretArn` 为什么本栈只吐名字、不吐 ARN** —— 开工时逐条核过、不是偷懒:
//   ① admin 口令走 `manageAdminPassword: true`(与 home 一致),secret **由 Redshift 服务自己创建**,
//      名字规则是 `redshift!<namespace>-<adminUsername>`(命名 SSOT 的 `redshiftAdminSecretName`
//      就是在**预测**这个服务生成名,不是我们取的名);
//   ② Secrets Manager 的 ARN 尾部带**服务生成的 6 位随机后缀**(`...-AbCdEf`)⇒ 模板里拼不出来;
//   ③ 查过 `aws-cdk-lib/aws-redshiftserverless` 的 L1 属性表:`CfnNamespace` 的 GetAtt 只有
//      `Namespace.{AdminUsername,CreationDate,DbName,DefaultIamRoleArn,IamRoles,KmsKeyId,
//      NamespaceArn,NamespaceId,NamespaceName,Status}` —— **没有** AdminPasswordSecretArn。
//      硬写一个未文档化的 GetAtt = "synth 绿、部署 400" 那一类坑,本模块已经被同类坑整栈 ROLLBACK 过一次。
//   ⇒ 定案:Output 键叫 **`redshiftSecretName`**(名字就叫名字,不冒充 ARN)。
//      🔴 平台侧回写描述符时必须**按名 DescribeSecret 换成真 ARN** 再填 `resources.redshiftSecretArn`
//      —— 与 home 的既有做法完全一致(`lib/exec-env/seed-home.ts` 就是按 `redshiftAdminSecretName`
//      去 DescribeSecret 取真 ARN)。descriptor 的 §3.1a 把 `redshiftSecretArn` 列进 ARN_RESOURCE_KEYS、
//      畸形即拒,所以**绝不能**把名字塞进那个字段冒充 ARN。
//
// 🔴 数据保护:namespace **存数据** ⇒ `RETAIN`(理由见 core-stack.ts 文件头;删环境不许删客户数据)。
// 🔴 资源文案字段一律英文(IAM 只收 Latin-1、EC2 SG 只收 ASCII;synth 不校验、真部署才 400)。
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as redshiftserverless from "aws-cdk-lib/aws-redshiftserverless";
import { Construct } from "constructs";
import { resourceName } from "../shared/naming";
import { ExecEnvStack, type ExecEnvStackProps } from "./exec-env-stack";
import { boundStatement, bucketArnPair, perTargetExecRole, serviceTrust, tableBucketAnyArn } from "./exec-roles";
// @kf-batch 50-WP16-zero-egress —— 私有子网类型的唯一真值(零出网 = PRIVATE_ISOLATED)
import { execEnvPrivateSubnets } from "./private-subnets";

export interface ExecEnvRedshiftStackProps extends ExecEnvStackProps {
  vpc: ec2.IVpc;
  /** 底座的数据域 CMK:namespace 静态加密用它(L1 构造不会自动补 key policy,见下方 grant)。 */
  dataKey: kms.IKey;
}

export class ExecEnvRedshiftStack extends ExecEnvStack {
  constructor(scope: Construct, id: string, props: ExecEnvRedshiftStackProps) {
    super(scope, id, props);
    const { ctx, vpc, dataKey } = props;
    const nameOf = (kind: string) => resourceName(kind, { targetId: ctx.targetId, account: ctx.account });

    // Redshift Serverless 的接入 SG。
    // 🔴 **刻意不取显式名字**:命名 SSOT 里没有登记 "redshift 的 SG" 这个 kind,而 home 那份也没给名字
    //    (`new ec2.SecurityGroup(this,"RedshiftSg",{vpc,description})`)。在这里自拟一个名字 = 绕过 SSOT
    //    多出第二处定义;要给名字应先进 naming.json。CDK 自动名对本资源无功能影响(描述符不引用它)。
    const sg = new ec2.SecurityGroup(this, "RedshiftSg", {
      vpc,
      description: `BGP exec-env ${ctx.targetId} Redshift Serverless SG`,
      allowAllOutbound: true,
    });
    // 只放行 VPC 内到 5439(与 home 同口径:不对外暴露,workgroup 也 publiclyAccessible=false)。
    sg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(5439), "Redshift from within VPC");

    // 🔴 L1 的 `CfnNamespace` 不会像 L2 那样自动补 key policy ⇒ 必须显式授权 Redshift 服务主体
    //    (含 CreateGrant),否则建 namespace 时 KMS AccessDenied。与 home 逐字同一组动作。
    // ⚠️ 副作用如实登记:CMK 构造属于 **base 栈**,这条 grant 会落进 **base 的模板**
    //    ⇒ 第一次装 redshift 组件时 base 栈也会更新一次(纯 key policy 变更、无资源替换)。
    //    这是"组件栈按需追加授权"的正常代价;栈组已 `addDependency(base)`,部署顺序天然正确。
    dataKey.grant(
      new iam.ServicePrincipal("redshift.amazonaws.com"),
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
      "kms:CreateGrant"
    );

    // ── @kf-batch 50-W5-seg1-WP3:per-target COPY 角色(SPEC v3.21 §6.1 段二)──────────────────
    // 【为什么本栈要建它】home 的 `redshift-stack.ts` 把 `bgp-redshift-copy-role` 挂在 namespace 的 `iamRoles` +
    //   `defaultIamRoleArn` 上,于是 `COPY … IAM_ROLE default` 与同步脚本的 `discover_copy_role()` 都成立。
    //   本栈此前 namespace **没挂任何角色** ⇒ 非 home 的 COPY 必炸(WP-3 开包勘定)。
    //   动作集照抄 home 那份(读数据湖 staging + S3Tables/Glue 目录只读 + 解密),资源面改指**本 target** 的桶 / 表桶。
    const p = cdk.Aws.PARTITION;
    const copyRole = perTargetExecRole(this, "RedshiftCopyRole", {
      ctx,
      kind: "redshiftCopyRole",
      assumedBy: serviceTrust(ctx, "redshift.amazonaws.com"),
      description: `BGP exec-env ${ctx.targetId} Redshift Serverless COPY role (bound to this target)`,
    });
    copyRole.addToPolicy(
      boundStatement(ctx, {
        actions: ["s3:GetObject", "s3:GetBucketLocation", "s3:ListBucket"],
        resources: bucketArnPair(p, nameOf("datalakeBucket")),
      })
    );
    copyRole.addToPolicy(
      boundStatement(ctx, {
        actions: ["s3tables:GetTableData", "s3tables:GetTable", "s3tables:GetNamespace", "s3tables:GetTableBucket", "s3tables:ListTables", "s3tables:ListNamespaces"],
        // B-127:只读动作不变,资源面从「本区平台表桶」放到「本区任意表桶」—— 同步写进已登记自有表桶的表,数仓侧同样要读得到(区仍由 ARN 绑死)
        resources: tableBucketAnyArn(ctx, p),
      })
    );
    // Glue 目录只读(COPY / 查询 S3Table 时要);资源级不可限定 ⇒ boundStatement 自动挂区域条件
    copyRole.addToPolicy(boundStatement(ctx, { actions: ["glue:GetTable", "glue:GetTables", "glue:GetDatabase", "glue:GetDatabases", "glue:GetCatalog"] }));
    dataKey.grant(copyRole, "kms:Decrypt", "kms:DescribeKey");

    const namespaceName = nameOf("redshiftNamespace");
    const databaseName = nameOf("redshiftDatabase");
    // 🔴 `adminUsername` 必须是 "admin":命名 SSOT 的 `redshiftAdminSecretName` 预测的是
    //    `redshift!<namespace>-admin`,改了用户名那份预测就错、平台按名 describe 会 404。
    //    naming.test.ts 已钉住 `redshiftAdminSecretName === "redshift!" + redshiftNamespace + "-admin"`,
    //    本行是那条断言在**基建侧**的另一半,synth-gate 会核对。
    const namespace = new redshiftserverless.CfnNamespace(this, "Namespace", {
      namespaceName,
      dbName: databaseName,
      adminUsername: "admin",
      manageAdminPassword: true,
      kmsKeyId: dataKey.keyId,
      // 🔴 WP-3:挂本 target 的 COPY 角色(与 home 同形:iamRoles + defaultIamRoleArn)。对存量 namespace 是原地
      //    UpdateNamespace(No interruption),不替换、不动数据;P0-E 会把它判成「原地改属性」(disruptive、不需审批)。
      iamRoles: [copyRole.roleArn],
      defaultIamRoleArn: copyRole.roleArn,
    });
    namespace.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN); // 🔴 namespace 存数据

    const workgroupName = nameOf("redshiftWorkgroup");
    const workgroup = new redshiftserverless.CfnWorkgroup(this, "Workgroup", {
      workgroupName,
      namespaceName,
      baseCapacity: 8, // 最小档:Serverless 按用量计费,空闲基本不产生 RPU 费用
      publiclyAccessible: false,
      subnetIds: execEnvPrivateSubnets(vpc).subnetIds,
      securityGroupIds: [sg.securityGroupId],
    });
    workgroup.addDependency(namespace);
    // workgroup 本身不存数据(数据在 namespace),但删它会中断服务 ⇒ 与 namespace 同策略更保守一致。
    workgroup.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // ── Outputs:OutputKey = 描述符字段名(栈组的合同)────────────────────────
    new cdk.CfnOutput(this, "redshiftWorkgroup", { value: workgroupName });
    new cdk.CfnOutput(this, "redshiftDatabase", { value: databaseName });
    // 🔴 名字不是 ARN(见文件头):平台侧回写前必须 DescribeSecret 换成真 ARN。
    new cdk.CfnOutput(this, "redshiftSecretName", { value: nameOf("redshiftAdminSecretName") });
    new cdk.CfnOutput(this, "redshiftNamespace", { value: namespaceName });
    // 🔴 WP-3:组件**可选**键(平台 `COMPONENT_OPTIONAL_RESOURCES.redshift`,读到才进袋;不追溯存量必填)
    new cdk.CfnOutput(this, "redshiftCopyRoleArn", { value: copyRole.roleArn });
  }
}
