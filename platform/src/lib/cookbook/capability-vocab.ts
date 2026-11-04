// capability 受控词表 + 别名归一(修复设计审核 🟠E:检索命中不稳)。
//
// 问题:capability/tags 是自由字符串,大模型/管理员可能写 "rollup"/"聚合"/"agg" 表达同一意图,
// retrieve 打分时命不中 → 相关配方沉底。
//
// 方案:维护一份【别名 → 规范能力词】映射。retrieve 打分前把 query 关键词和配方 capability/tags
// 都【归一化】到规范词再比对。既保证检索稳定,又不锁死 capability 字段类型(仍是 string,未知词软处理)。
//
// 抽象:加同义词 = 这里 CANONICAL 加一行别名;不改 retrieve 逻辑。

// 规范能力词 → 其别名集合(含中英、缩写、常见变体)。全部小写。
// 【与 seed 配方的 capability 一一对齐】——加配方时若引入新 capability,这里同步加一行别名,
// 否则该配方检索命中弱(仅靠 title/tag 子串兜底)。规范词 = 配方 capability 值。
const CANONICAL: Record<string, string[]> = {
  // Redshift
  "ctas-aggregate": ["ctas-aggregate", "aggregate", "agg", "聚合", "汇总", "gmv", "roi", "roas", "conversion", "转化", "join", "ctas"],
  "time-rollup": ["time-rollup", "rollup", "时间汇总", "按日", "按月", "按周", "date_trunc", "日汇总", "月汇总", "分区汇总"],
  scd2: ["scd2", "拉链表", "拉链", "缓变维", "慢变维", "slowly-changing", "dimension", "维度历史", "历史版本", "is_current"],
  dedup: ["dedup", "去重", "去重计数", "row_number", "取最新", "distinct", "排重", "清洗"],
  retention: ["retention", "留存", "留存率", "次日留存", "次日留存率", "7日留存", "funnel", "漏斗", "同比", "环比", "cohort", "转化漏斗"],
  upsert: ["upsert", "merge", "增量合并", "合并", "去重覆盖"],
  window: ["window", "窗口", "rank", "排名", "占比", "累计", "analytics", "lag", "lead"],
  // Glue / S3Tables
  "jdbc-read": ["jdbc-read", "jdbc", "读源", "读源库", "source", "mysql", "postgresql", "读数据库", "抽取"],
  incremental: ["incremental", "增量", "增量抽取", "水位", "watermark", "bookmark", "书签", "增量同步"],
  "data-quality": ["data-quality", "数据质量", "质量校验", "dq", "空值", "校验", "脏数据", "质检"],
  "etl-skeleton": ["etl-skeleton", "etl", "pyspark", "spark", "骨架", "skeleton", "batch", "批处理"],
  "s3table-write": ["s3table-write", "s3table", "s3tables", "iceberg", "写湖", "lake-write", "spark-s3tables"],
  "s3table-merge": ["s3table-merge", "merge", "iceberg-merge", "湖增量", "分区", "partition", "幂等写入", "format-version"],
  // 全量 / 按分区原子覆盖(s3tables.atomic-overwrite)
  "s3table-overwrite": ["s3table-overwrite", "overwrite", "覆盖", "全量覆盖", "按分区覆盖", "整表覆盖", "原子覆盖", "insert-overwrite", "overwritepartitions", "回刷"],
  "athena-query": ["athena-query", "athena", "trino", "湖查询", "lake-query"],
  // Flink / Sync
  "cdc-stream": ["cdc-stream", "cdc", "stream", "流", "实时", "近实时", "kinesis", "flink-sql"],
  "window-agg": ["window-agg", "窗口聚合", "窗口", "window", "tumble", "hop", "cumulate", "滚动窗口", "实时聚合", "watermark", "tvf"],
  "sync-channel": ["sync-channel", "sync", "同步", "channel", "通道", "dms", "全量"],
};

// 反向索引:别名 → 规范词(构建一次)。
const ALIAS_TO_CANONICAL: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [canon, aliases] of Object.entries(CANONICAL)) {
    m.set(canon, canon);
    for (const a of aliases) m.set(a.toLowerCase(), canon);
  }
  return m;
})();

// 把一个词归一到规范能力词;未知词原样返回(小写),不阻断(软处理)。
export function normalizeCapability(word: string): string {
  const w = String(word || "").trim().toLowerCase();
  return ALIAS_TO_CANONICAL.get(w) || w;
}

// 把一段查询文本(可能含多个词/中文)拆成归一化后的关键词集合(用于打分)。
// 简单切分:非字母数字中文的字符为分隔符;每个 token 归一;同时保留整串归一(命中多词别名如 "s3table-write")。
export function normalizeQueryTokens(query: string): Set<string> {
  const raw = String(query || "").trim().toLowerCase();
  const out = new Set<string>();
  if (!raw) return out;
  // 整串直接尝试归一(命中如 "ctas-aggregate" 这种带连字符的别名)。
  out.add(normalizeCapability(raw));
  // 分词(保留中文、英文、数字;连字符视为词内)。
  const tokens = raw.split(/[^a-z0-9一-龥-]+/).filter(Boolean);
  for (const t of tokens) {
    out.add(normalizeCapability(t));
    // 连字符词也拆开归一(如 "s3table-write" 的 "s3table")。
    if (t.includes("-")) for (const p of t.split("-").filter(Boolean)) out.add(normalizeCapability(p));
  }
  out.delete(""); // 清理空
  return out;
}

// 是否为已知规范能力词(供 admin 增配方时软告警未知 capability)。
export function isKnownCapability(word: string): boolean {
  return ALIAS_TO_CANONICAL.has(String(word || "").trim().toLowerCase());
}

// 全部规范能力词(供 UI 下拉/文档)。
export function listCanonicalCapabilities(): string[] {
  return Object.keys(CANONICAL);
}
