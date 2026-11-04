// → 45 迁移兼容层。工程配方库已提升为【平台级】lib/cookbook(见 docs/design/45)。
// 本文件保留旧路径 import 兼容:Copilot 侧现有代码继续从 ../recipes/types 拿类型,行为不变。
// 新代码请直接从 @/lib/cookbook 导入。

export type {
  DialectRule,
  Recipe,
  CookbookEngine,
  CookbookEngine as RecipeEngine, // 旧名别名:Copilot 侧仍用 RecipeEngine
} from "@/lib/cookbook/types";

// 旧 EngineCookbook 形状(lookup_recipe 返回):平台级 CookbookSlice 之外的兼容视图。
export interface EngineCookbook {
  engine: import("@/lib/cookbook/types").CookbookEngine;
  dialectRules: { title: string; rule: string }[];
  recipes: import("@/lib/cookbook/types").Recipe[];
}
