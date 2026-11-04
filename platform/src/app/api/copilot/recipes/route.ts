export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { recordAudit } from "@/lib/audit";
import { listRecipeEngines } from "@/lib/copilot/recipes/registry";
import { SYSTEM_RECIPES } from "@/lib/copilot/recipes/seed";
import { listAllAdminRecipes, createAdminRecipe } from "@/lib/copilot/recipes/store";
import { bustAdminCache } from "@/lib/cookbook";
import type { RecipeEngine } from "@/lib/copilot/recipes/types";

// GET /api/copilot/recipes → 列配方(系统内嵌 只读 + 管理员扩展)。所有登录用户可读(规划要用)。
export async function GET(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效,请重新登录", 401);
  try {
    const engines = listRecipeEngines();
    const system = SYSTEM_RECIPES.map((r) => ({ ...r, source: "system" as const, readonly: true }));
    const admin = (await listAllAdminRecipes(engines)).map((r) => ({
      id: r.id, engine: r.engine, capability: r.capability, title: r.title,
      whenToUse: r.whenToUse, template: r.template, dialectNotes: r.dialectNotes, tags: r.tags,
      recipeId: r.recipeId, source: "admin" as const, readonly: false, createdBy: r.createdBy,
    }));
    return apiOk({ engines, system, admin, canManage: identity.isPlatformAdmin });
  } catch (err: unknown) {
    return apiError(`获取配方失败: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
}

// POST /api/copilot/recipes → 新增管理员配方。【仅平台管理员】。
export async function POST(req: NextRequest) {
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效,请重新登录", 401);
  // 权限铁律:配方是系统内嵌能力,仅平台管理员可增,普通用户不可修改。
  if (!identity.isPlatformAdmin) return apiError("配方库仅平台管理员可维护", 403, { code: "RBAC_DENIED" });

  let body: any;
  try { body = await req.json(); } catch { return apiError("请求体无效"); }
  const engine = String(body?.engine || "").trim().toLowerCase() as RecipeEngine;
  if (!listRecipeEngines().includes(engine)) {
    return apiError(`engine 必须是:${listRecipeEngines().join(" / ")}`, 400, { code: "VALIDATION_FAILED" });
  }
  const capability = String(body?.capability || "").trim();
  const title = String(body?.title || "").trim();
  const template = String(body?.template || "").trim();
  if (!capability || !title || !template) return apiError("缺少 capability / title / template", 400, { code: "VALIDATION_FAILED" });

  try {
    const row = await createAdminRecipe({
      engine, capability, title,
      whenToUse: String(body?.whenToUse || ""),
      template,
      dialectNotes: Array.isArray(body?.dialectNotes) ? body.dialectNotes.map(String) : [],
      tags: Array.isArray(body?.tags) ? body.tags.map(String) : [],
      createdBy: identity.username,
    });
    bustAdminCache(engine); // 失效 cookbook 缓存,下次 retrieve 立即见新配方
    recordAudit(req, "copilot.recipe.create", {
      resourceType: "copilot-recipe", resourceId: row.recipeId, detail: { engine, capability, title },
    }).catch(() => {});
    return apiOk(row, 201);
  } catch (err: unknown) {
    return apiError(`新增配方失败: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
}
