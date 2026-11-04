export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { resolveIdentity } from "@/lib/auth/identity";
import { recordAudit } from "@/lib/audit";
import { listRecipeEngines } from "@/lib/copilot/recipes/registry";
import { deleteAdminRecipe } from "@/lib/copilot/recipes/store";
import { bustAdminCache } from "@/lib/cookbook";
import type { RecipeEngine } from "@/lib/copilot/recipes/types";

// DELETE /api/copilot/recipes/[recipeId]?engine=redshift → 删管理员配方。【仅平台管理员】。
// 系统内嵌配方无 recipeId、不走此表,天然删不掉(只能删管理员新增的)。
export async function DELETE(req: NextRequest, props: { params: Promise<{ recipeId: string }> }) {
  const params = await props.params;
  const identity = await resolveIdentity(req);
  if (!identity) return apiError("未认证或登录态已失效,请重新登录", 401);
  if (!identity.isPlatformAdmin) return apiError("配方库仅平台管理员可维护", 403, { code: "RBAC_DENIED" });

  const engine = String(req.nextUrl.searchParams.get("engine") || "").trim().toLowerCase() as RecipeEngine;
  if (!listRecipeEngines().includes(engine)) {
    return apiError(`engine 必须是:${listRecipeEngines().join(" / ")}`, 400, { code: "VALIDATION_FAILED" });
  }
  try {
    await deleteAdminRecipe(engine, params.recipeId);
    bustAdminCache(engine); // 失效 cookbook 缓存
    recordAudit(req, "copilot.recipe.delete", {
      resourceType: "copilot-recipe", resourceId: params.recipeId, detail: { engine },
    }).catch(() => {});
    return apiOk({ deleted: params.recipeId });
  } catch (err: unknown) {
    return apiError(`删除配方失败: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
}
