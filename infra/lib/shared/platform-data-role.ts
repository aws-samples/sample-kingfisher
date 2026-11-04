// 平台数据面角色的**唯一作者**(L5「能力即授权」)。主控区(平台栈)与每个执行环境(base 栈)都经这里建,
// 两边同一套语句、同一个命名真源 —— 「主控区与其他区走同一条派生路径」在 IAM 层也成立。
//
// 【它是什么】平台 ECS 任务(控制面)要碰**某个区的数据**时,不再用任务角色本身,而是代入这个区的这一个角色
//   (运行时唯一注入点 `platform/src/lib/aws/clients.ts#buildDataPlane`)。于是:
//     · 落点写错 ⇒ 拿到的是别的 target 的凭证 ⇒ 被 `aws:RequestedRegion` 挡住(一区一套 ⇒ 区即 target);
//     · 单区凭证泄漏的爆炸半径 = 一个区。
//
// 【三层绑定】
//   ① 名字只来自命名 SSOT(`platformDataRole`);
//   ② 信任 = 本账号的**平台任务角色**(`aws:PrincipalArn` 钉到 `BgpPlatformStack-TaskRole*`,OM 等别的任务角色不许代入);
//   ③ 区域型服务一律 `aws:RequestedRegion = 本区`;全局命名空间(S3 桶 / IAM 角色)按**本 target 的实名**收窄。
//
// 🔴 S3(D9 / E4):数据源浏览要读用户自己的桶(名字部署期不可知)⇒ 只读三件给 `*` **并挂 `aws:RequestedRegion`**。
//   D9 实测的是「跨区客户端被 301 改向后,请求区变成**桶所在区**」—— 所以区域条件对 S3 判的是**桶在哪个区**:
//   本角色只读得到**本区**的桶(本区的平台桶只属于本 target,一区一套),别区的桶(含别的 target 的平台桶)一律拒。
//   写权限只给本 target 的实名桶。
//
// 🔴 本刀是**只增**:平台任务角色的数据面直授一条没动(才收回)。策略先给到服务级,
//   缺口由 `BGP_DATAPLANE_CREDS=observe` 跑一轮全量硬门量出来(`place.creds.denied`,带 AWS 原话)再补。
//
// 🔴 资源文案(description)一律英文:IAM 只收 Latin-1。
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { resourceName } from "./naming";

export interface PlatformDataRoleProps {
  targetId: string;
  account: string;
  region: string;
  partition: string;
}

/** 本区平台数据面角色的实名(运行时侧 `dataplane-creds.ts#pickDataPlaneRole` 用同一个命名真源推出同一个 ARN)。 */
export function platformDataRoleName(targetId: string): string {
  return resourceName("platformDataRole", { targetId });
}

/** 信任它的平台任务角色(CFN 生成名 `BgpPlatformStack-TaskRole<hash>-<rand>`)。 */
export function platformTaskRoleArnPattern(account: string, partition: string): string {
  return `arn:${partition}:iam::${account}:role/BgpPlatformStack-TaskRole*`;
}

/** 区域型数据面服务(一区一套 ⇒ `aws:RequestedRegion` 即把权限关在本 target)。 */
export const REGIONAL_DATA_PLANE_ACTIONS: readonly string[] = [
  "glue:*",
  "athena:*",
  "s3tables:*",
  "lakeformation:GetDataAccess",
  "emr-serverless:*",
  "redshift-serverless:*",
  "redshift-data:*",
  "redshift:DescribeClusters",
  "redshift:DescribeInboundIntegrations",
  "redshift:CreateInboundIntegration",
  "redshift:GetResourcePolicy",
  "redshift:PutResourcePolicy",
  "kinesisanalytics:*",
  "kinesis:*",
  "dms:*",
  "rds:Describe*",
  "rds:CreateIntegration",
  "rds:DeleteIntegration",
  "logs:*",
  "airflow:*",
  "airflow-serverless:*",
  "cloudwatch:GetMetricData",
  "cloudwatch:GetMetricStatistics",
  "cloudwatch:ListMetrics",
  "kafka:Describe*",
  "kafka:List*",
  "kafka:GetBootstrapBrokers",
  "ec2:Describe*",
  "ec2:CreateSecurityGroup",
  "ec2:DeleteSecurityGroup",
  "ec2:AuthorizeSecurityGroupIngress",
  "ec2:AuthorizeSecurityGroupEgress",
  "ec2:RevokeSecurityGroupIngress",
  "ec2:RevokeSecurityGroupEgress",
  "ec2:CreateTags",
  "ec2:CreateNetworkInterface",
  "ec2:DeleteNetworkInterface",
  "ec2:CreateNetworkInterfacePermission",
  "kms:Decrypt",
  "kms:Encrypt",
  "kms:GenerateDataKey",
  "kms:DescribeKey",
  "kms:CreateGrant",
  "kms:ListGrants",
  "kms:RetireGrant",
  // IAM 侧(2026-10-21):RDS 发现(`datasource-service.ts#discoverRdsInstances`)按区 ListSecrets 找实例的托管密钥;
  //   动作不支持资源级权限(只能 `*`),靠区域条件关在本区。读某个密钥的值仍只到下面 OwnRegionSecretsRead 列出的名字。
  "secretsmanager:ListSecrets",
  // 数据源 DynamoDB 只读(用户表名部署期不可知)+ 本区驻留表(下面单独给写)
  "dynamodb:DescribeTable",
  "dynamodb:ListTables",
  "dynamodb:Scan",
  "dynamodb:Query",
  "dynamodb:GetItem",
];

/** 本 target 的平台自有桶(读写)。 */
function ownBuckets(p: PlatformDataRoleProps): string[] {
  const v = { targetId: p.targetId, account: p.account };
  return ["datalakeBucket", "scriptsBucket", "dagBucket", "workflowBucket", "residencyBucket"].map((k) => resourceName(k, v));
}

/** 本 target 的执行角色(PassRole / GetRole 只许传本 target 的)。 */
function ownExecRoles(p: PlatformDataRoleProps): string[] {
  const v = { targetId: p.targetId, account: p.account };
  return ["glueRole", "emrServerlessRole", "flinkRole", "redshiftCopyRole", "dmsKinesisRole", "mwaaRole", "airflowServerlessRole"].map((k) =>
    resourceName(k, v)
  );
}

export function buildPlatformDataRole(scope: Construct, id: string, p: PlatformDataRoleProps): iam.Role {
  const { account, region, partition } = p;
  const inRegion = { StringEquals: { "aws:RequestedRegion": region } };
  const slug = p.targetId.replace(/_/g, "-");
  const role = new iam.Role(scope, id, {
    roleName: platformDataRoleName(p.targetId),
    description: `BGP platform data-plane role for ${p.targetId} (${region}); assumed only by the platform ECS task role`,
    assumedBy: new iam.AccountPrincipal(account).withConditions({
      ArnLike: { "aws:PrincipalArn": platformTaskRoleArnPattern(account, partition) },
    }),
  });

  role.addToPolicy(new iam.PolicyStatement({ sid: "RegionalDataPlane", actions: [...REGIONAL_DATA_PLANE_ACTIONS], resources: ["*"], conditions: inRegion }));

  const buckets = ownBuckets(p);
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "OwnPlatformBucketsRw",
      actions: [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:GetReplicationConfiguration",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts",
      ],
      resources: buckets.flatMap((b) => [`arn:${partition}:s3:::${b}`, `arn:${partition}:s3:::${b}/*`]),
    })
  );
  // 数据源浏览读用户桶 —— 只读三件,只限本区的桶(见文件头 S3 一段)
  role.addToPolicy(
    new iam.PolicyStatement({ sid: "DataSourceBucketsReadOnly", actions: ["s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation"], resources: ["*"], conditions: inRegion })
  );

  // 本区驻留表(写只给这两张)
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "OwnResidencyTablesWrite",
      actions: ["dynamodb:PutItem"],
      resources: ["residencyAuditTable", "residencyResultsTable"].map(
        (k) => `arn:${partition}:dynamodb:${region}:${account}:table/${resourceName(k, { targetId: p.targetId, account })}`
      ),
    })
  );

  // 本区密钥:数据源 / 项目凭证 / 共享写入身份 / 本区 Redshift 托管 admin(ARN 自带区段 ⇒ 天然绑区)
  const sec = (s: string) => `arn:${partition}:secretsmanager:${region}:${account}:secret:${s}`;
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "OwnRegionSecretsRead",
      actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
      resources: [sec("bgp/datasource/*"), sec(`bgp/project/${slug}/*`), sec("bgp/shared-writer/*"), sec("redshift!*")],
    })
  );
  // IAM 侧(2026-10-21,…9435 observe 第四十四轮 `place.creds.denied` 量出):
  //   · `bgp/datasource/*` —— 建源 / 改口令 / 删源的 CreateSecret / UpdateSecret / DeleteSecret 一直走该区的数据面客户端
  //     (`lib/datasource-spi/secrets.ts`),而本角色此前只给了读 ⇒ 「能读不能建」是上一轮「能建不能读」的镜像,同样是非对称授权;
  //   · `bgp/dms/*` —— 实时链给 DMS 建 Redshift 专用用户后写完整字段密钥(`lib/realtime/redshift-target.ts`,CreateSecret / PutSecretValue)。
  //   平台不读 `bgp/dms/*`(DMS 用自己的访问角色读),所以只进写语句,不进上面的读语句。
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "OwnRegionCredentialSecretsWrite",
      actions: ["secretsmanager:CreateSecret", "secretsmanager:UpdateSecret", "secretsmanager:PutSecretValue", "secretsmanager:DeleteSecret", "secretsmanager:TagResource"],
      resources: [sec(`bgp/project/${slug}/*`), sec("bgp/shared-writer/*"), sec("bgp/datasource/*"), sec("bgp/dms/*")],
    })
  );

  // IAM(全局):只许把**本 target 的**执行角色交给服务;用户经角色顾问建的作业角色(`bgp-job-role-*`)照现状放行
  const roleArn = (n: string) => `arn:${partition}:iam::${account}:role/${n}`;
  const own = ownExecRoles(p).map(roleArn);
  role.addToPolicy(new iam.PolicyStatement({ sid: "PassOwnExecRoles", actions: ["iam:PassRole", "iam:GetRole"], resources: [...own, roleArn("bgp-job-role-*")] }));
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: "ServiceLinkedRoles",
      actions: ["iam:CreateServiceLinkedRole"],
      // IAM 是全局服务(请求区恒为 us-east-1)⇒ 不能挂区域条件,按服务链接角色的路径收窄
      resources: [roleArn("aws-service-role/ops.emr-serverless.amazonaws.com/*"), roleArn("aws-service-role/airflow-serverless.amazonaws.com/*")],
      conditions: { StringEquals: { "iam:AWSServiceName": ["ops.emr-serverless.amazonaws.com", "airflow-serverless.amazonaws.com"] } },
    })
  );
  return role;
}
