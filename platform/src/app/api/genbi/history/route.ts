export const dynamic = "force-dynamic";

import { requireIdentity } from "@/lib/auth/identity";
import { NextRequest } from "next/server";
import { apiOk } from "@/lib/api-response";
import { listGenBiHistory } from "@/lib/genbi/history";
// @kf-batch 50-WP4quater-reads —— 问数历史按执行范围过滤。行上的 `targetId` 是**这次问数的 SQL
// 真打到的那个区**(工单 SC-6 盖的章),所以「在这个区问过什么」是能如实回答的;此前只是没人过滤。
// 🔴 无章的存量条目由 `scalarTargetOf` 统一回落主控区 —— 落章之前问数只在主控区跑,这是历史事实。
import { readScope, filterRowsByScalar } from "@/lib/exec-env/scope";

// GET /api/genbi/history — recent questions for the current user (best-effort).
export async function GET(req: NextRequest) {
  const who = await requireIdentity(req);
  if (who instanceof Response) return who;
  const items = await listGenBiHistory(who.sub);
  const scope = readScope(req);
  if (!scope) return apiOk(items);
  return apiOk(filterRowsByScalar(items as unknown as Array<Record<string, unknown>>, scope, "genbi"));
}
