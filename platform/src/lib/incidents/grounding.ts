// 模块 43-A.2 — 诊断证据 grounding:把"运维知识库历史已验证修复"+"业务口径"渲染成一段中文
// prompt 区块,拼进喂给 AWS DevOps Agent 的证据里(见 lib/diagnostics/evidence.ts)。
//
// 这是护城河复利闭环的"注入"环:DevOps Agent 的强项是自主关联 AWS 遥测(CloudWatch/X-Ray)找
// 根因;我们在它调查之前,先把"这个客户上次这么修好的"和"业务口径(如金额单位/测试数据排除)"
// 摆到它眼前,让 RCA 对照历史修复、且不违背治理口径 —— 竞品拿到空框架,这段历史归零。
//
// best-effort:任何一步失败都不阻断诊断(知识库读不到就当没有历史,照常走原诊断)。
// 安全:注入内容全部来自已脱敏的 bgp-incidents(signature 算法产出的 symptomTemplate/rootCause
// 已去表名/账号/路径)与业务口径条目;不引入新的敏感面。

import { lookupIncident, type IncidentLookupResult } from "./lookup";
import { computeSignature } from "./signature";
import { getContextForGrounding, contextToPromptText, type ContextEntry } from "@/lib/genbi/context";

export interface DiagnosisGrounding {
  // 拼进证据 prompt 的中文区块(命中历史修复或有业务口径时非空;都没有则空串)。
  promptBlock: string;
  // 本次诊断是否用到了历史修复(命中且人工已验证)——落库到 bgp-diagnostics.usedIncidentHistory。
  usedIncidentHistory: boolean;
  // 命中的故障签名(即使未 verified 也回填,便于 UI/审计关联;无则空串)。
  signature: string;
  // 命中的已验证修复摘要(供 service.ts 落库/日志;未命中为 null)。
  lookup: IncidentLookupResult | null;
}

const EMPTY: DiagnosisGrounding = { promptBlock: "", usedIncidentHistory: false, signature: "", lookup: null };

// 渲染"同类故障历史 + 已验证修复手册"区块(仅当人工已验证时给全文)。
function renderIncidentBlock(l: IncidentLookupResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("## 🔁 运维知识库:同类故障历史(平台沉淀,优先对照)");
  lines.push(
    `本平台此前已记录同签名故障(signature: ${l.signature})共 ${l.occurrenceCount || 0} 次` +
      `${l.firstSeenAt ? `,首次 ${l.firstSeenAt.slice(0, 10)}` : ""}${l.lastSeenAt ? `,最近 ${l.lastSeenAt.slice(0, 10)}` : ""}。`,
  );
  if (l.rootCauseSummary) lines.push(`- 历史根因归纳:${l.rootCauseSummary}`);
  if (l.hasVerifiedFix && l.resolution) {
    const r = l.resolution;
    lines.push(
      `- **上次由 ${r.verifiedBy || "运维"} 于 ${r.verifiedAt ? r.verifiedAt.slice(0, 10) : "此前"} 修复并【人工验证有效】` +
        `${r.fixKind ? `(修复类型:${r.fixKind})` : ""}:**`,
    );
    lines.push("```");
    lines.push(String(r.markdown || "").slice(0, 2000));
    lines.push("```");
    lines.push(
      "**要求:请把本次证据与上述已验证修复对照——若根因一致,请在报告中明确指出「与历史同因」并复用/微调该修复;" +
        "若证据表明根因不同,请说明差异,不要盲目套用历史修复。**",
    );
  } else {
    // 命中主档但尚未人工验证:只给"曾发生过"的提示,不给未验证的 AI 建议(设计 §8)。
    lines.push("- 该类故障此前已发生但【尚无人工验证的修复手册】,请正常取证并给出可操作修复。");
  }
  return lines.join("\n");
}

// 渲染业务口径区块(让修复建议不违背治理口径:金额单位/测试数据排除等)。
// 条目行复用语义层唯一格式化器 contextToPromptText(消除各消费方各写 kindLabel 的重复);
// 标题保留诊断语境的措辞("修复建议须遵循",与问数/codegen 的"生成须遵循"是合理的语境差异)。
function renderContextBlock(entries: ContextEntry[]): string {
  const body = contextToPromptText(entries.slice(0, 15));
  if (!body) return "";
  return ["", "## 📐 业务口径与规则(修复建议须遵循,勿与之冲突)", body].join("\n");
}

// 构造诊断 grounding:先按 (taskType, errorText) 算签名 → 查知识库历史已验证修复 + 业务口径。
// 只在"失败诊断"场景注入历史修复(复盘/成功分析场景 errorText 为空,无可归并的故障)。
export async function buildDiagnosisGrounding(input: {
  projectId: string;
  taskType: string;
  errorText: string | undefined | null;
  keywords?: string; // 业务口径相关性排序用(通常传资源名/错误摘要)
}): Promise<DiagnosisGrounding> {
  const errorText = String(input.errorText || "").trim();

  // 并行:历史修复检索 + 业务口径(两者互不依赖;各自 best-effort)。
  const [lookup, contextEntries] = await Promise.all([
    errorText
      ? lookupIncident({ projectId: input.projectId, taskType: input.taskType, errorText }).catch(() => null)
      : Promise.resolve(null),
    getContextForGrounding(input.projectId, input.keywords || errorText.slice(0, 200))
      .catch(() => [] as ContextEntry[]),
  ]);

  const signature = lookup?.signature || (errorText ? computeSignature(input.taskType, errorText).signature : "");
  const usedIncidentHistory = !!(lookup?.found && lookup.hasVerifiedFix);

  const incidentBlock = lookup?.found ? renderIncidentBlock(lookup) : "";
  const contextBlock = renderContextBlock(contextEntries || []);

  const promptBlock = [incidentBlock, contextBlock].filter(Boolean).join("\n");
  if (!promptBlock) return { ...EMPTY, signature };

  return { promptBlock, usedIncidentHistory, signature, lookup: lookup || null };
}
