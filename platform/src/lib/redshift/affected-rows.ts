// @kf-batch 50-SEQ47b-backfill-observability —— 序 47b(B-101)
// Redshift Data API `DescribeStatement` 的「受影响行数」唯一作者。
//   · 批语句(BatchExecuteStatement)⇒ 各子语句 `SubStatements[].ResultRows` 之和;
//   · 单语句 ⇒ 顶层 `ResultRows`;
//   · Data API 对无结果的语句回 -1、字段缺省 ⇒ **null**(不知道就说不知道,不写 0)。
// 调用方:离线 Redshift SQL 作业轮询(lib/etl/job-service.ts)、补数工作流 SQL 节点轮询(lib/backfill/execute.ts),
// 两处都把它写进 run 行 `metrics.rowsAffected`;补数页 / 监控页只消费,不自己算。
export function affectedRowsOf(desc: { ResultRows?: number; SubStatements?: Array<{ ResultRows?: number }> } | null | undefined): number | null {
  if (!desc) return null;
  const subs = Array.isArray(desc.SubStatements) ? desc.SubStatements : [];
  if (subs.length) {
    let sum = 0;
    let seen = false;
    for (const s of subs) {
      const n = s?.ResultRows;
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) { sum += n; seen = true; }
    }
    return seen ? sum : null;
  }
  const n = desc.ResultRows;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/** 把受影响行数包成 run 行要写的 `metrics` 片段(null ⇒ 空对象,调用方展开即可,不会写出 `metrics: undefined`)。 */
export function affectedRowsMetrics(desc: Parameters<typeof affectedRowsOf>[0]): { metrics?: { rowsAffected: number } } {
  const n = affectedRowsOf(desc);
  return n === null ? {} : { metrics: { rowsAffected: n } };
}
