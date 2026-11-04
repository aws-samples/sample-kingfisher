// 入库前错误文本脱敏。写进 bgp-incidents 的任何文本(症状摘要/根因归纳)都要先过
// 这道,确保不落表名/路径/主机/账号/UUID(继承E5"只存元数据"铁律)。
// 复用 signature.ts 的 normalizeErrorText(已把可变/敏感 token 抹成占位符),这里在其上做长度收敛。

import { normalizeErrorText } from "./signature";

// 症状摘要:取错误文本首个有信息量的片段,脱敏后截断。用于 occ.symptomDigest 与主档 title 兜底。
export function buildSymptomDigest(errorText: string | undefined | null, maxLen = 200): string {
  const raw = String(errorText || "").trim();
  if (!raw) return "(无错误文本)";
  const normalized = normalizeErrorText(raw);
  return normalized.length > maxLen ? normalized.slice(0, maxLen) + "…" : normalized;
}

// 根因归纳:诊断报告是自由 Markdown。这里【不落原文】,只抽"根因分析"分节的首句并脱敏,
// 避免把报告里可能出现的表名/账号/路径带入库。取不到分节则回退到症状摘要。
export function buildRootCauseSummary(report: string | undefined | null, fallbackErrorText?: string | null, maxLen = 300): string | undefined {
  const text = String(report || "").trim();
  if (!text) return fallbackErrorText ? buildSymptomDigest(fallbackErrorText, maxLen) : undefined;
  // 诊断 prompt 约定输出含"② 根因分析"分节(见 lib/diagnostics/evidence.ts)。抽该节到下一节前。
  const m = text.match(/根因分析[^\n]*\n([\s\S]*?)(?:\n\s*(?:③|3[.、)]|修复建议|预防建议)|$)/);
  const seg = (m ? m[1] : text).replace(/[#*`>-]/g, " ").replace(/\s+/g, " ").trim();
  if (!seg) return fallbackErrorText ? buildSymptomDigest(fallbackErrorText, maxLen) : undefined;
  const normalized = normalizeErrorText(seg);
  return normalized.length > maxLen ? normalized.slice(0, maxLen) + "…" : normalized;
}
