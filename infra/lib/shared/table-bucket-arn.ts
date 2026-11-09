// 数据湖表桶路由(设计稿 §6.7)—— 「本区任意 S3 Tables 表桶」ARN 的**唯一作者**。
//
// 【为什么搬到 shared】2026-10-27 时只有执行区的 Glue / EMR / Redshift-copy 角色放到了「同区任意表桶」(exec-env/exec-roles.ts#tableBucketAnyArn),
//   主控区 EMR 角色(emr-stack.ts)与两份 Flink 角色(flink-stack.ts / exec-env/flink-stack.ts)仍写死平台表桶名 ⇒ 客户把聚合层放进自己的
//   表桶后,主控区 EMR 作业 / Flink sink 一律 AccessDenied。数据湖表桶路由让这三处与执行区角色同一口径,ARN 形态只在这里拼一次,
//   synth-gate §9.8 对三份模板断言「每条 s3tables 语句的 Resource 都是 bucket/* 形态、不含任何桶名字面」。
// 【形态】`arn:<partition>:s3tables:<region>:<account>:bucket/*` —— `bucket/*` 同时匹配 `bucket/<名>` 与其下 `/table/<id>`;
//   region 段仍绑区(不跨区),与主控区 Glue 角色 `s3tables:* on *`(区条件)口径一致;「哪些桶可写」的准入在平台侧按路由表判
//   (platform lib/lake/routes.ts),IAM 不再是第二道按桶名的门。
export function anyTableBucketArn(partition: string, region: string, account: string): string[] {
  return [`arn:${partition}:s3tables:${region}:${account}:bucket/*`];
}
