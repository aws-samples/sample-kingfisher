// EMR Serverless 的**日志落点** —— 单一真值源。
//
// 🔴🔴 为什么要单独成文件(2026-09-22 真踩,用户在 copilot 建的 ROI 作业上撞到):
//   EMR Serverless 把 `job-metadata.log` / driver / executor 日志**用作业执行角色**写到这个落点。
//   原来 `LOG_BUCKET` / `LOG_PREFIX` 是 `provider.ts` 的**模块内**常量 ⇒
//   「运行期往哪写」与「角色顾问给哪些权限」是**两个作者**,而授权那一侧压根不知道有这个落点
//   ⇒ 角色顾问一键建出来的角色一跑就:
//     AccessDenied: s3:PutObject on ".../emr-logs/<jobId>/applications/<app>/jobs/<run>/job-metadata.log"
//   而且那条报错里**没有一个字**提示「去把日志落点的写权限加上」。
//
// ⇒ 落点收成单一真值源:运行期(`provider.ts` / `schedule-fanout.ts`)与授权侧
//   (`lib/role-advisor/engine-baseline.ts`)从**同一处**派生。
//   本仓纪律:凡「部署时快照 + 运行期增长」的配置,必须单一真值源派生,不许散点硬编码。

/** 日志前缀。🔴 授权侧按 `arn:aws:s3:::<bucket>/<此前缀>/*` 放写权限,两边必须是同一个值。 */
export const EMR_LOG_PREFIX = "emr-logs";

/**
 * 默认日志桶(= 平台数据湖桶)。
 * 🔴 按调用时读 env(不是模块加载时):这样单测可以换 env 而不用重载模块,
 *   也避免「导入顺序决定取到什么值」这种看不见的耦合。
 */
export function emrLogBucket(): string {
  return (
    process.env.EMR_LOG_BUCKET ||
    process.env.EMR_OUTPUT_BUCKET ||
    `bgp-datalake-${process.env.AWS_ACCOUNT_ID}`
  );
}

/** EMR 的脚本桶(PySpark 入口脚本 + 平台注入的 runtime jar 都在这里,作业角色必须能**读**)。 */
export function emrScriptBucket(): string {
  return process.env.EMR_SCRIPT_BUCKET || `bgp-glue-scripts-${process.env.AWS_ACCOUNT_ID}`;
}

/** 某个作业的日志 URI(交给 EMR 的 `s3MonitoringConfiguration.logUri`)。 */
export function s3LogUri(jobId: string, logBucket?: string): string {
  return `s3://${logBucket || emrLogBucket()}/${EMR_LOG_PREFIX}/${jobId}/`;
}
