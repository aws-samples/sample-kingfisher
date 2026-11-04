// 模块 43-A — 知识库健康度聚合(纯函数式,零新表)。与模块36治理健康分同思路:
// 从主档列表算出对外叙事指标(护城河量化):类别数 / 已验证修复覆盖率 / 近30天 MTTR / 复发 Top。

import type { IncidentMaster } from "./types";

export interface IncidentHealth {
  categoryCount: number; // 故障类别数(signature 数)
  verifiedFixCount: number; // 已有已验证修复的类别数
  verifiedFixCoverage: number; // 覆盖率 0~1
  unresolvedCount: number; // 未解决类别数
  silencedCount: number; // 已抑制类别数
  totalOccurrences: number; // 累计发生次数(所有类别 occurrenceCount 之和)
  avgMttrSec: number | null; // 近30天平均 MTTR(有样本才非 null)
  topRecurring: { signature: string; title: string; engine: string; occurrenceCount: number; status: string }[];
  byEngine: { engine: string; count: number }[]; // 按引擎族分布
}

export function computeHealth(masters: IncidentMaster[]): IncidentHealth {
  const categoryCount = masters.length;
  const verified = masters.filter((m) => m.status === "resolved-verified" || m.resolution?.verified);
  const verifiedFixCount = verified.length;
  const unresolvedCount = masters.filter((m) => m.status === "unresolved").length;
  const silencedCount = masters.filter((m) => m.status === "silenced").length;
  const totalOccurrences = masters.reduce((s, m) => s + (m.occurrenceCount || 0), 0);

  // MTTR:取有 lastMttrSec 的类别求均(A.1 阶段样本可能为空 → null)。
  const mttrSamples = masters.map((m) => m.mttrStats?.avgMttrSec ?? m.mttrStats?.lastMttrSec).filter((v): v is number => typeof v === "number" && v > 0);
  const avgMttrSec = mttrSamples.length ? Math.round(mttrSamples.reduce((s, v) => s + v, 0) / mttrSamples.length) : null;

  const topRecurring = [...masters]
    .sort((a, b) => (b.occurrenceCount || 0) - (a.occurrenceCount || 0))
    .slice(0, 5)
    .map((m) => ({ signature: m.signature, title: m.title, engine: m.engine, occurrenceCount: m.occurrenceCount || 0, status: m.status }));

  const engineMap = new Map<string, number>();
  for (const m of masters) engineMap.set(m.engine || "unknown", (engineMap.get(m.engine || "unknown") || 0) + 1);
  const byEngine = Array.from(engineMap.entries())
    .map(([engine, count]) => ({ engine, count }))
    .sort((a, b) => b.count - a.count);

  return {
    categoryCount,
    verifiedFixCount,
    verifiedFixCoverage: categoryCount ? verifiedFixCount / categoryCount : 0,
    unresolvedCount,
    silencedCount,
    totalOccurrences,
    avgMttrSec,
    topRecurring,
    byEngine,
  };
}

// DataOps-Bench 安全导出(§8 契约):每行只含脱敏元数据,不含客户标识/真实表名/日志原文。
export function toExportRow(m: IncidentMaster): Record<string, unknown> {
  return {
    signature: m.signature,
    symptomTemplate: m.title, // 已脱敏(signature 算法产出)
    taskType: m.engine,
    engine: m.engine,
    rootCauseCategory: m.signature.split("::")[1] || "unknown",
    resolutionKind: m.resolution?.fixKind || null,
    verified: !!m.resolution?.verified,
    occurrenceCount: m.occurrenceCount || 0,
    mttrSec: m.mttrStats?.avgMttrSec ?? m.mttrStats?.lastMttrSec ?? null,
  };
}
