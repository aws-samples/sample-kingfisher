// 模块 45 — 配方库注册表(统一数据入口)。合并【系统内嵌配方(seed,只读基座)】+【管理员动态配方(store,DynamoDB)】。
// 系统配方永远在、不可删;管理员只能在其上新增(带 isPlatformAdmin 鉴权,见 cookbook API)。
// 是 retrieve(检索)、guard(校验)、planner 提示词注入的统一数据源。
//
// 方言规则(DialectRule)只来自系统内嵌(seed)——方言是引擎客观事实,由平台维护,不开放给管理员改
// (管理员能加"配方/范式",但不能改"引擎方言硬规则",避免误配把校验层搞坏)。
//
// 缓存(修复设计审核 🟡F):管理员动态配方读 DynamoDB;GenBI 等高频出口每次 retrieve 都打库会累积延迟/成本。
// 加【进程内 TTL 缓存】(按引擎),失效重拉;管理员增删后主动 bust。系统配方是代码常量、零 IO,不需缓存。

import type { DialectRule, Recipe, CookbookEngine } from "./types";
import { SYSTEM_RECIPES, SYSTEM_DIALECT_RULES } from "./seed";
import { listAdminRecipes } from "./store";

export const COOKBOOK_ENGINES: CookbookEngine[] = ["redshift", "s3tables", "glue", "emr", "flink", "athena"];

// 系统配方里实际出现过的引擎(用于"只列有内容的引擎")。
export function listCookbookEngines(): CookbookEngine[] {
  const withContent = new Set<CookbookEngine>(SYSTEM_RECIPES.map((r) => r.engine));
  SYSTEM_DIALECT_RULES.forEach((r) => withContent.add(r.engine));
  // 保持 COOKBOOK_ENGINES 的稳定顺序。
  return COOKBOOK_ENGINES.filter((e) => withContent.has(e));
}

// 某引擎的方言规则(仅系统内嵌;guard 用完整对象含 antiPattern/fix,retrieve/展示用 title+rule+severity)。
export function dialectRulesFor(engine: CookbookEngine): DialectRule[] {
  return SYSTEM_DIALECT_RULES.filter((r) => r.engine === engine);
}

// 全部引擎的 error 级方言硬规则汇总(注入 planner 提示词:让 AI 生成前就知道所有硬约束)。
export function allDialectRulesForPrompt(): { engine: string; rules: string[] }[] {
  return listCookbookEngines().map((engine) => ({
    engine,
    rules: dialectRulesFor(engine).filter((d) => d.severity === "error").map((d) => `【${d.title}】${d.rule}`),
  }));
}

// ── 管理员动态配方:进程内 TTL 缓存(按引擎)──
const ADMIN_CACHE_TTL_MS = 60_000; // 60s;管理员增删后主动 bust,或接受 ≤60s 最终一致
interface CacheEntry { at: number; recipes: Recipe[] }
const adminCache = new Map<CookbookEngine, CacheEntry>();

// now():用 Date.now();若不可用(受限环境)退化为 0 → 每次都视为过期(等价无缓存,安全)。
function now(): number {
  try { return Date.now(); } catch { return 0; }
}

// 读某引擎的管理员配方(带缓存)。失败静默返回 []( store 层已 try/catch)。
async function getAdminRecipes(engine: CookbookEngine): Promise<Recipe[]> {
  const hit = adminCache.get(engine);
  const t = now();
  if (hit && t > 0 && t - hit.at < ADMIN_CACHE_TTL_MS) return hit.recipes;
  const recipes = await listAdminRecipes(engine);
  adminCache.set(engine, { at: t, recipes });
  return recipes;
}

// 管理员增删配方后调用,失效对应引擎缓存(下次 retrieve 立即见新数据)。不传则清全部。
export function bustAdminCache(engine?: CookbookEngine): void {
  if (engine) adminCache.delete(engine);
  else adminCache.clear();
}

// 某引擎【系统 + 管理员】全部配方(合并;系统在前)。retrieve 的数据来源。
export async function allRecipesFor(engine: CookbookEngine): Promise<Recipe[]> {
  const system = SYSTEM_RECIPES.filter((r) => r.engine === engine).map((r) => ({ ...r, source: r.source ?? ("system" as const) }));
  const admin = await getAdminRecipes(engine);
  return [...system, ...admin.map((r) => ({ ...r, source: "admin" as const }))];
}
