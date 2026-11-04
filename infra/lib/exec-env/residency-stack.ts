// @kf-batch 50-W5-seg1-WP10a
// 执行环境 **residency-api 组件**栈 · 片 1 = 区域审计 / 结果存储(50 SPEC v3.22 §1.3 D / §1.3a S4;DESIGN §18 决策 6quinquies ③)。
//
// 【这个组件是什么、不是什么】
//   用户 2026-09-05 拍板「不设法务门,只要可审计」。跨法域 target 的**唯一**技术前置就是装本组件 —— 与「跑 Redshift 作业要装 redshift 组件」
//   同性质,不是门。它交付三样**留在本 region** 的存储:
//     · `bgp-region-audit-<slug>`   区域审计全量(operator / SQL 原文 / statementId / entry / triggeredBy / authKind)—— 中央只留摘要;
//     · `bgp-region-results-<slug>` 区域结果存储(SQL 历史 / 问数 turns / 导出索引)—— 中央只留指针;
//     · 区域结果桶(结果对象 / 导出 / 记忆摘要)。
//   片 2(区域 API Gateway 浏览器直连就近执行)归 WP-10b,本栈**不建**任何 API / Lambda。
//
// 【三条硬要求,synth-gate §7b 逐条打】
//   ① **RETAIN + 底座 CMK**:审计与结果是客户数据,删环境不许删(core-stack 文件头同一条纪律);
//   ② **桶策略 deny 复制**(`s3:ReplicateObject` / `s3:PutReplicationConfiguration`)—— 这是「结果留区」的产品能力(数据放哪),不是干预;
//      ACCEPTANCE E2 / E-182 断 `get-bucket-replication` 无配置且策略含 deny;
//   ③ **OutputKey = 描述符字段名**(`residencyAuditTable` / `residencyResultsTable` / `residencyBucket`),平台 finalize 按键取值进袋、probe 三项真探。
//
// 🔴 防篡改不在本栈:审计表的 Deny UpdateItem / DeleteItem / BatchWriteItem 挂在**平台 TaskRole**(platform-stack `ExecEnvResidency`),
//    因为要拒的是**平台自己**的写身份;区域表的 IAM 资源策略 DDB 不支持,靠身份侧 Deny + synth-gate 钉。
// 🔴 资源文案一律英文(IAM Latin-1 / SG ASCII 那一类坑)。
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { resourceName } from "../shared/naming";
import { ExecEnvStack, type ExecEnvStackProps } from "./exec-env-stack";

export interface ExecEnvResidencyStackProps extends ExecEnvStackProps {
  /** 底座的数据域 CMK:两张表与桶都用它静态加密(审计里有 operator 身份与 SQL 原文)。 */
  dataKey: kms.IKey;
}

export class ExecEnvResidencyStack extends ExecEnvStack {
  constructor(scope: Construct, id: string, props: ExecEnvResidencyStackProps) {
    super(scope, id, props);
    const { ctx, dataKey } = props;
    // 🔴 三处都**字面调用** resourceName(不经包装函数):命名门禁 naming.test / naming-coverage 靠
    //    「infra 侧从 SSOT 派生」这条形状放行 home 模板(home 法域永不建本栈),包装一层就看不见了。
    const vars = { targetId: ctx.targetId, account: ctx.account };

    // ── 两张区域表(与控制面 database-stack 同口径:按量 + PITR + CMK + RETAIN)────────────────
    const tableProps = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: dataKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN, // 🔴 审计 / 结果是客户数据,删环境不许删
    } as const;
    // 审计表:pk="audit#<targetId>#<yyyymmdd>", sk="<ts>#<auditId>"(SPEC §3.3 分片键;与中央 bgp-audit 同形)
    const auditTableName = resourceName("residencyAuditTable", vars);
    const auditTable = new dynamodb.Table(this, "RegionAuditTable", {
      tableName: auditTableName,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      ...tableProps,
    });
    // 结果表:pk="<projectId>#<targetId>", sk="<kind>#<ts>"(SPEC §1.3a S4)
    const resultsTableName = resourceName("residencyResultsTable", vars);
    const resultsTable = new dynamodb.Table(this, "RegionResultsTable", {
      tableName: resultsTableName,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      ...tableProps,
    });
    void auditTable;
    void resultsTable;

    // ── 区域结果桶(RETAIN + CMK + 阻公网 + 强制 TLS + deny 复制)─────────────────────────
    const bucketName = resourceName("residencyBucket", vars);
    const bucket = new s3.Bucket(this, "RegionResultsBucket", {
      bucketName,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: dataKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // 🔴 不带 autoDeleteObjects(core-stack 文件头同一条纪律)
    });
    // 🔴 deny 复制:结果留区是产品能力(数据放哪)。资源策略上的显式 Deny 对**任何**身份生效(含账号管理员的一次误配)。
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "DenyCrossRegionReplication",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags", "s3:PutReplicationConfiguration"],
        resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
      })
    );

    // ── Outputs:OutputKey = 描述符字段名(栈组合同)────────────────────────────────────
    new cdk.CfnOutput(this, "residencyAuditTable", { value: auditTableName });
    new cdk.CfnOutput(this, "residencyResultsTable", { value: resultsTableName });
    new cdk.CfnOutput(this, "residencyBucket", { value: bucketName });
  }
}
