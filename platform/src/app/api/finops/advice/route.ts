export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { listAdvice } from "@/lib/finops/advice";
// @kf-batch 50-WP4quater-reads(工单 SC-24)—— 🔴 优化建议按范围内的**每个区**探。
// 只探主控区的后果:别的区的空转实例永远不被建议,而界面上写着「无优化建议」——
// 比没有建议更坏(用户会以为已经没有可省的了)。
import { requireScope } from "@/lib/exec-env/scope";
// @kf-batch 50-WP6-cost-by-region —— 「全部已装区」与「视角 → 区集合」都改由 cost-region.ts 单一作者给出
// (原为本文件私有副本;且原写法在全部视角下 `readScope` 回 global 真值 ⇒ 一个区都不探)
import { listActiveTargetsForScope, allInstalledTargetIds, regionsInViewOf } from "@/lib/finops/cost-region";

// GET /api/finops/advice — 确定性优化建议(只读探测;规则见 lib/finops/advice.ts RULES)。RBAC: viewer。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const scope = await requireScope(req, ctx.projectId);
  if (scope instanceof NextResponse) return scope;

  try {
    // 未传 `?scope=` / 全局 ⇒ 探**全部已装区**(而不是只探主控区):建议本来就该覆盖全平台。
    const inView = await regionsInViewOf(scope);
    const regions = inView
      ? Array.from(inView)
      : Array.from(await listActiveTargetsForScope(await allInstalledTargetIds()));
    const items = await listAdvice(regions);
    return apiOk({ items });
  } catch (e: unknown) {
    return apiError((e as Error).message || String(e), 500);
  }
}
