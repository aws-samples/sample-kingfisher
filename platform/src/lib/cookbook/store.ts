// Copilot 配方库【管理员动态扩展】存储层(bgp-copilot-recipes)。
// 系统配方(seed.ts)代码内嵌只读;此表存管理员新增的企业特有范式。
// 权限:【读】全局(所有登录用户,规划大脑要用);【写】仅 isPlatformAdmin(路由层鉴权,见 recipes API)。
// 全局共享(不分项目):配方是平台/企业级标准范式,一处沉淀处处受益。

import { PutCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import type { Recipe, CookbookEngine } from "./types";

const recipePk = (engine: CookbookEngine) => `recipe#${engine}`;

// 管理员配方行(= Recipe + 存储元信息)。
export interface AdminRecipeRow extends Recipe {
  pk: string;
  recipeId: string;
  source: "admin"; // 区别于系统内嵌(source="system")
  createdBy: string;
  createdAt: string;
}

// 读某引擎的管理员扩展配方(全局)。失败静默返回 [](不因扩展表异常拖垮规划)。
export async function listAdminRecipes(engine: CookbookEngine): Promise<Recipe[]> {
  try {
    const { Items = [] } = await docClient.send(new QueryCommand({
      TableName: TABLES.COPILOT_RECIPES,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": recipePk(engine) },
    }));
    return (Items as AdminRecipeRow[]).map((it) => ({
      id: it.id, engine: it.engine, capability: it.capability, title: it.title,
      whenToUse: it.whenToUse, template: it.template, dialectNotes: it.dialectNotes || [], tags: it.tags || [],
    }));
  } catch { return []; }
}

// 列全部管理员配方(管理页用)。
export async function listAllAdminRecipes(engines: CookbookEngine[]): Promise<AdminRecipeRow[]> {
  const out: AdminRecipeRow[] = [];
  for (const e of engines) {
    try {
      const { Items = [] } = await docClient.send(new QueryCommand({
        TableName: TABLES.COPILOT_RECIPES,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": recipePk(e) },
      }));
      out.push(...(Items as AdminRecipeRow[]));
    } catch { /* skip */ }
  }
  return out;
}

// 新增管理员配方(仅管理员;路由层已鉴权)。
export async function createAdminRecipe(input: {
  engine: CookbookEngine; capability: string; title: string; whenToUse: string;
  template: string; dialectNotes?: string[]; tags?: string[]; createdBy: string;
}): Promise<AdminRecipeRow> {
  const recipeId = ulid();
  const row: AdminRecipeRow = {
    pk: recipePk(input.engine),
    recipeId,
    id: `admin.${input.engine}.${recipeId}`,
    engine: input.engine,
    capability: input.capability,
    title: input.title,
    whenToUse: input.whenToUse,
    template: input.template,
    dialectNotes: input.dialectNotes || [],
    tags: input.tags || [],
    source: "admin",
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
  };
  await docClient.send(new PutCommand({ TableName: TABLES.COPILOT_RECIPES, Item: row }));
  return row;
}

// 删除管理员配方(仅管理员)。
export async function deleteAdminRecipe(engine: CookbookEngine, recipeId: string): Promise<void> {
  await docClient.send(new DeleteCommand({
    TableName: TABLES.COPILOT_RECIPES,
    Key: { pk: recipePk(engine), recipeId },
  }));
}
