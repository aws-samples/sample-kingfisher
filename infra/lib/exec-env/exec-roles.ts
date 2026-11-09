// 执行环境 **per-target 执行角色**的唯一作者(50 SPEC v3.21 §6.1 段二落地口径 1–2)。
//
// 【为什么单独一个文件】四类角色(glue / emr / redshift-copy / dms-kinesis)分别建在 core / redshift / dms 三个栈里,
//   而「绑死本 target」这件事有**三层**,每层都容易在某一个栈里漏掉一条:
//   ① 角色名 = 命名 SSOT 的本 target 名(IAM 全局,同名必撞 §12 P0-D;home 名一律不许出现);
//   ② 信任 = 服务主体 + `aws:SourceAccount`(EMR Serverless 另加 `aws:SourceArn` 钉到本 region);
//   ③ 凡 `Resource:"*"` 的语句**一律**挂 `aws:RequestedRegion = 本 region` —— 这条最容易漏:
//      资源 ARN 自带 region 段的语句天然绑区,而 glue:* / logs / ec2 ENI / redshift-data 这类只能给 `*` 的动作,
//      少了区域条件就是「target A 的角色能打 target B 所在 region 的同类服务」= 横移(IR-P1-03)。
//   ⇒ 三层都收进本文件:栈里只写「要哪些动作、指哪些桶」,拼名 / 信任条件 / 区域条件由这里**自动**补,
//     漏不掉。synth-gate §6/§7b 另从模板反向核(每条 `*` 语句必带区域条件、角色名必出自 SSOT)。
//
// 🔴 **不挂 AWS 托管策略 `AWSGlueServiceRole`**(home 的 glue 角色挂了):它带 `s3:ListBucket` / `s3:GetBucketAcl`
//    on `*` —— 对本 target 之外的桶列 key 也是横移。需要的子集逐条内联、逐条绑区。
//
// 🔴 资源文案(description)一律英文:IAM 只收 Latin-1(中文 400、synth 不校验、真部署才炸)。
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { resourceName } from "../shared/naming";
// 数据湖表桶路由:「本区任意 S3 Tables 表桶」ARN 的唯一作者(主控区 EMR / Flink 栈与本文件同一口径)
import { anyTableBucketArn } from "../shared/table-bucket-arn";
import type { ExecEnvContext } from "./context";

/** 本包落地的四类执行角色 kind(与 `platform/naming.json` 的 kind 名逐字一致)。 */
export const EXEC_ROLE_KINDS = ["glueRole", "emrServerlessRole", "redshiftCopyRole", "dmsKinesisRole"] as const;
export type ExecRoleKind = (typeof EXEC_ROLE_KINDS)[number];

type ConditionMap = Record<string, Record<string, string | string[]>>;

/**
 * 服务主体 + 防混淆代理条件(`aws:SourceAccount` 必带;可追加如 `ArnLike aws:SourceArn`)。
 * 🔴 `SourceAccount` 是四类角色**共同**的最低门:没有它,别的账号里的同类服务只要拿到角色 ARN 就能让服务替它 assume。
 */
export function serviceTrust(ctx: ExecEnvContext, service: string, extra?: ConditionMap): iam.IPrincipal {
  const conditions: ConditionMap = { StringEquals: { "aws:SourceAccount": ctx.account } };
  for (const [op, kv] of Object.entries(extra ?? {})) {
    conditions[op] = { ...(conditions[op] ?? {}), ...kv };
  }
  return new iam.ServicePrincipal(service).withConditions(conditions);
}

export interface PerTargetExecRoleProps {
  ctx: ExecEnvContext;
  kind: ExecRoleKind;
  assumedBy: iam.IPrincipal;
  /** 英文(IAM Latin-1 限制) */
  description: string;
}

/** 建一个 per-target 执行角色:名字**只能**来自命名 SSOT(不接受调用方传名)。 */
export function perTargetExecRole(scope: Construct, id: string, props: PerTargetExecRoleProps): iam.Role {
  const roleName = resourceName(props.kind, { targetId: props.ctx.targetId, account: props.ctx.account });
  return new iam.Role(scope, id, { roleName, assumedBy: props.assumedBy, description: props.description });
}

/** 本 target 某类执行角色的 ARN(不依赖构造,给「角色引用自己」这类语句用,避免 token 自引用)。 */
export function execRoleArnOf(ctx: ExecEnvContext, kind: ExecRoleKind, partition: string): string {
  return `arn:${partition}:iam::${ctx.account}:role/${resourceName(kind, { targetId: ctx.targetId, account: ctx.account })}`;
}

export interface BoundStatementProps {
  actions: string[];
  /** 缺省 `["*"]`。含 `*` 的语句会**自动**挂 `aws:RequestedRegion = ctx.region`。 */
  resources?: string[];
  conditions?: ConditionMap;
}

/**
 * 🔴 绑死本 target 的策略语句:资源面含 `*` ⇒ 自动挂区域条件(拆不开);资源 ARN 自带 region 段 ⇒ 由 ARN 绑区。
 * 调用方**不能**为 `*` 语句省掉区域条件 —— 这就是「漏一条就横移」在结构上不可能的地方。
 */
export function boundStatement(ctx: ExecEnvContext, s: BoundStatementProps): iam.PolicyStatement {
  const resources = s.resources && s.resources.length > 0 ? s.resources : ["*"];
  const conditions: ConditionMap = {};
  for (const [op, kv] of Object.entries(s.conditions ?? {})) conditions[op] = { ...kv };
  if (resources.some((r) => r === "*")) {
    conditions.StringEquals = { ...(conditions.StringEquals ?? {}), "aws:RequestedRegion": ctx.region };
  }
  return new iam.PolicyStatement({
    actions: s.actions,
    resources,
    ...(Object.keys(conditions).length > 0 ? { conditions } : {}),
  });
}

/** 本 target 三个桶(数据湖 / 脚本 / 表桶)的 ARN 对:`[bucketArn, bucketArn/*]`。 */
export function bucketArnPair(partition: string, bucketName: string): string[] {
  return [`arn:${partition}:s3:::${bucketName}`, `arn:${partition}:s3:::${bucketName}/*`];
}

/**
 * 本 target 所在区**任意** S3 Tables 表桶的 ARN(`bucket/*` 同时匹配 `bucket/<名>` 与其下 `/table/<id>`)。
 * 执行区 Glue / EMR 角色对 S3 Tables 的授权从「只有本区平台表桶」放到「本区任意表桶」—— 客户自有表桶在
 * 「系统设置 → 数据湖外部表桶」登记后要能被该区的同步作业写入(此前登记了也写不了:角色只认平台表桶)。仍由 ARN 的 region 段绑区
 * (不跨区),与主控区同类角色 `s3tables:* on *`(区条件)口径一致;「哪些桶可写」的准入在平台侧按登记表判(platform lib/sync/table-bucket.ts),
 * IAM 不再是第二道按桶名的门。
 */
export function tableBucketAnyArn(ctx: ExecEnvContext, partition: string): string[] {
  // 数据湖表桶路由:ARN 形态搬到 shared/table-bucket-arn.ts(主控区 EMR / Flink 栈同一作者);这里只是执行区上下文的薄壳
  return anyTableBucketArn(partition, ctx.region, ctx.account);
}

/** 读写一个桶的完整动作集(与 home flink/emr 角色对数据湖桶的口径逐字相同)。 */
export const S3_RW_ACTIONS = [
  "s3:GetObject",
  "s3:PutObject",
  "s3:DeleteObject",
  "s3:ListBucket",
  "s3:GetBucketLocation",
  "s3:AbortMultipartUpload",
  "s3:ListBucketMultipartUploads",
  "s3:ListMultipartUploadParts",
] as const;

/** 只读一个桶(脚本 / jar / COPY 源)。 */
export const S3_RO_ACTIONS = ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket", "s3:GetBucketLocation"] as const;

/** Glue / EMR 把 application 挂进私有 VPC 要管 ENI(这些动作 AWS 不支持资源级限定 ⇒ 靠区域条件绑区)。 */
export const EC2_ENI_ACTIONS = [
  "ec2:CreateNetworkInterface",
  "ec2:DescribeNetworkInterfaces",
  "ec2:DeleteNetworkInterface",
  "ec2:CreateNetworkInterfacePermission",
  "ec2:DescribeNetworkInterfacePermissions",
  "ec2:DescribeSubnets",
  "ec2:DescribeVpcs",
  "ec2:DescribeSecurityGroups",
  "ec2:DescribeDhcpOptions",
  "ec2:DescribeVpcEndpoints",
  "ec2:DescribeRouteTables",
  "ec2:DescribeVpcAttribute",
] as const;

/** Redshift Data API + Serverless 临时凭证(平台各引擎写数仓的同一范式;资源级不可限定 ⇒ 区域条件)。 */
export const REDSHIFT_DATA_ACTIONS = [
  "redshift-data:ExecuteStatement",
  "redshift-data:BatchExecuteStatement",
  "redshift-data:DescribeStatement",
  "redshift-data:GetStatementResult",
  "redshift-data:CancelStatement",
  "redshift-serverless:GetCredentials",
  "redshift-serverless:GetWorkgroup",
  "redshift-serverless:GetNamespace",
] as const;

/** 用户 DynamoDB 表只读(DDB 源 → 湖仓;与 home glue/emr 角色同口径,无写动作)。 */
export const DDB_READ_ACTIONS = ["dynamodb:DescribeTable", "dynamodb:Scan", "dynamodb:Query", "dynamodb:GetItem", "dynamodb:BatchGetItem"] as const;
