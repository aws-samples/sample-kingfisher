// → 45 迁移兼容层。配方注册表已提升为平台级 lib/cookbook/registry + retrieve。
// 保留 Copilot 侧现有调用签名(planner 的 allDialectRulesForPrompt、discovery-tools 的 getCookbook/listRecipeEngines),
// 委托平台级实现,行为等价。新代码请直接用 @/lib/cookbook 的 retrieve/dialectRulesFor 等。

import {
  listCookbookEngines,
  dialectRulesFor as cbDialectRulesFor,
  allDialectRulesForPrompt as cbAllDialectRulesForPrompt,
  retrieve,
} from "@/lib/cookbook";
import type { CookbookEngine } from "@/lib/cookbook/types";
import type { EngineCookbook } from "./types";

export function listRecipeEngines(): CookbookEngine[] {
  return listCookbookEngines();
}

export function dialectRulesFor(engine: CookbookEngine) {
  return cbDialectRulesFor(engine);
}

export function allDialectRulesForPrompt(): { engine: string; rules: string[] }[] {
  return cbAllDialectRulesForPrompt();
}

// lookup_recipe 工具用:某引擎方言硬规则 + 配方(系统 + 管理员合并;可选 capability 关键词过滤)。
// 委托平台级 retrieve;为保持交互工具的旧行为(不截断,给全量相关配方),用大 topK。
// 返回旧 EngineCookbook 形状(dialectRules 只含 {title,rule})。
export async function getCookbook(engine: CookbookEngine, query?: string): Promise<EngineCookbook> {
  const slice = await retrieve(engine, { keywords: query, topK: 50 });
  return {
    engine: slice.engine,
    dialectRules: slice.dialectRules.map((d) => ({ title: d.title, rule: d.rule })),
    recipes: slice.recipes,
  };
}
