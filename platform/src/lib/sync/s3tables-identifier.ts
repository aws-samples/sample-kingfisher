// S3Tables / Iceberg 标识符规范化 —— 【单一事实源】(SSOT)。
//
// 为什么存在:S3Tables/Iceberg 的 namespace/表名标识符要求【小写 + 只含 a-z0-9_】,而
// 各类源给出的名字不满足:
//   · Oracle 默认标识符全大写(ORA_EVENTS)→ 不转小写 → "Invalid table identifier"(Bug#2)。
//   · DynamoDB/S3 资源名允许连字符/点(bgp-verify-scores)→ namespace 建失败(Bug#1)。
// 此前规范化散落多处、规则不一(start/route.ts 完全不 sanitize;glue-generator 替非法字符但
// 不转小写)→ 违反 SSOT,各自漂移。本函数收敛为唯一权威规则,namespace/表名都过它。
//
// 🔴 与 Glue 执行脚本(Python 侧 glue-script-generator.ts)的 sanitize 规则必须【逐字对齐】:
//    Python: re.sub(r'[^a-z0-9_]', '_', name.lower()) + 数字开头补 '_'。改一处两处同改(见该文件注释)。
//
// 注:Redshift 目标大小写不敏感,转小写不破坏它;此规范化只为满足 S3Tables/Iceberg 的硬约束,
//     对 Redshift 侧是安全的(且转小写后两目标表名一致,利于血缘 FQN 对齐)。

/**
 * 把任意原始名规范化为合法的 S3Tables/Iceberg 标识符。
 * 规则:小写 → 非 [a-z0-9_] 一律替为 '_' → 数字开头补前导 '_' → 空则用兜底名。
 * @param raw 原始名(源库名/表名/namespace 等)
 * @param fallback 规范化后为空时的兜底(默认 "s3t_default")
 */
export function sanitizeS3TablesIdentifier(raw: string, fallback = "s3t_default"): string {
  let s = (raw || "").toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (s && /^[0-9]/.test(s)) s = "_" + s;
  return s || fallback;
}
