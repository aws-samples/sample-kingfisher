// 模块 45 — 平台级工程知识库(Engine Cookbook)公共 API。
// 所有 AI codegen 出口(Copilot 规划、离线 ETL、实时 Flink、智能问数 GenBI)统一从这里消费:
//   · retrieve(engine, opts)  生成前:拿方言规则 + topK 相关配方注入提示词(控 token)。
//   · guard(engine, code)     生成后:用同源方言规则校验/纠正(词法安全 + fixpoint + 违规阻断)。
// 管理/数据:allRecipesFor / dialectRulesFor / allDialectRulesForPrompt / store CRUD / bustAdminCache。
//
// 谱系与设计:docs/design/45-engine-cookbook/DESIGN.md。Copilot(模块44)是消费者之一,非所有者。

export type {
  CookbookEngine,
  CookbookTarget,
  DialectRule,
  Recipe,
  CookbookSlice,
  GuardResult,
} from "./types";
export { defaultTargetForEngine, targetOfRule } from "./types";

export { retrieve, type RetrieveOpts } from "./retrieve";
export { guard, guardCode, detectableRuleCount } from "./guard";
export { maskSqlLiterals } from "./mask";
export { sliceToPromptText, type SliceToPromptOpts } from "./prompt";

export {
  COOKBOOK_ENGINES,
  listCookbookEngines,
  dialectRulesFor,
  allDialectRulesForPrompt,
  allRecipesFor,
  bustAdminCache,
} from "./registry";

export {
  normalizeCapability,
  isKnownCapability,
  listCanonicalCapabilities,
} from "./capability-vocab";

export {
  listAdminRecipes,
  listAllAdminRecipes,
  createAdminRecipe,
  deleteAdminRecipe,
  type AdminRecipeRow,
} from "./store";

export { SYSTEM_RECIPES, SYSTEM_DIALECT_RULES } from "./seed";
