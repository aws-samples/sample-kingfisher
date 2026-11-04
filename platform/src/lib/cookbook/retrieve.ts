// 模块 45 — 【核心】确定性检索(控 token 成本的关键;修复设计审核 🟠E:原型只有子串过滤无打分/topK)。
//
// 生成前:codegen 出口先 retrieve(engine, {capability/keywords}) 拿到"该引擎该意图"的方言规则 + topK 相关配方,
// 注入提示词 → 大模型照验证过的范式写。token 只花在相关内容上(不全量注入所有引擎所有配方)。
//
// 检索三步(见 docs/design/45 §3.1):
//  1) engine 过滤(强):只取目标引擎的配方(算 Redshift ROI 不加载 Flink 配方)。
//  2) capability/keywords 打分排序:query 归一化到受控词表,与配方 capability/tags/title/whenToUse 比对打分。
//  3) topK 截断(默认 3):只返回最相关的。同时【恒定注入该引擎全部方言规则】(体量小、必须全带,防致命语法错)。
//
// 未来升级向量检索时,retrieve 签名不变,只换本文件内部打分实现(§3.2)。

import type { CookbookEngine, CookbookSlice, Recipe } from "./types";
import { dialectRulesFor, allRecipesFor } from "./registry";
import { normalizeCapability, normalizeQueryTokens } from "./capability-vocab";

export interface RetrieveOpts {
  capability?: string; // 主要意图(如 "aggregate" / "s3table-write");归一后精确命中权重最高
  keywords?: string; // 自由关键词(如用户诉求原文片段);归一后按 token 命中打分
  topK?: number; // 返回配方上限,默认 3
}

const DEFAULT_TOP_K = 3;

// 给一条配方按归一化后的查询意图打分(命中越多、越核心,分越高)。
function scoreRecipe(recipe: Recipe, wantCapability: string, queryTokens: string[]): number {
  let score = 0;
  const recipeCap = normalizeCapability(recipe.capability);

  // capability 精确命中(归一后)= 最强信号。
  if (wantCapability && recipeCap === wantCapability) score += 100;

  // 归一化配方的 tags + capability 到规范词集合,与查询 token 求交。
  const recipeTokens = new Set<string>([recipeCap, ...recipe.tags.map(normalizeCapability)]);
  const hay = (recipe.title + " " + recipe.whenToUse).toLowerCase(); // 标题/whenToUse 原文兜底
  for (const qt of queryTokens) {
    if (!qt) continue;
    if (recipeTokens.has(qt)) score += 20; // 归一词命中(tag/capability)
    else if (qt.length >= 2 && hay.includes(qt)) score += 5; // 未归一自由文本子串命中(弱信号)
  }

  return score;
}

// 检索某引擎的方言规则 + topK 相关配方。零查询时返回该引擎全部配方(按稳定顺序,不打分)。
export async function retrieve(engine: CookbookEngine, opts: RetrieveOpts = {}): Promise<CookbookSlice> {
  const topK = Math.max(1, opts.topK ?? DEFAULT_TOP_K);
  const all = await allRecipesFor(engine);

  const wantCapability = opts.capability ? normalizeCapability(opts.capability) : "";
  const queryTokens = Array.from(normalizeQueryTokens([opts.capability, opts.keywords].filter(Boolean).join(" ")));
  const hasQuery = !!wantCapability || queryTokens.length > 0;

  let ranked: Recipe[];
  let totalMatched: number;

  if (!hasQuery) {
    // 无查询:返回全部(稳定顺序),仍受 topK 约束以控 token。
    ranked = all;
    totalMatched = all.length;
  } else {
    const scored = all
      .map((r) => ({ r, s: scoreRecipe(r, wantCapability, queryTokens) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    totalMatched = scored.length;
    // 命中为空时,退化返回该引擎全部配方(宁可多给相关引擎的配方,也不给空——方言规则仍恒定注入)。
    ranked = scored.length ? scored.map((x) => x.r) : all;
    if (!scored.length) totalMatched = all.length;
  }

  return {
    engine,
    // 恒定注入该引擎全部方言规则(体量小、必带,防致命语法错)。error 在前,warn 在后。
    dialectRules: dialectRulesFor(engine)
      .slice()
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1))
      .map((d) => ({ title: d.title, rule: d.rule, severity: d.severity })),
    recipes: ranked.slice(0, topK),
    totalMatched,
  };
}
