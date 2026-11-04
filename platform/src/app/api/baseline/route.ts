export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { listBaselines } from "@/lib/baseline/learn";
// 基线按执行范围,且**摊平成「任务 × 区」**。
// 🔴 摊平而不是只过滤:同一个任务在两个区有两份基线,合成一行只能显示其中一个(或一个混合值)。
// 用户 2026-09-10 的原话是「基线行按任务聚合、跨区混在一起」——一行一区才是那句话的解。
// 🔴 `legacy: true` 的行如实标出「落章之前学的,没有区维」:把它冒充成某个区的基线,
// 会让 SLA 预测拿别的区的数字算 ETA。
import { readScope, filterRowsByScope } from "@/lib/exec-env/scope";
import { explodeByTarget, baselineTargetsOf } from "@/lib/baseline/target-baseline";

// GET /api/baseline[?scope=] — 当前项目全部任务基线(viewer)。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  try {
    const all = await listBaselines(ctx.projectId);
    const scope = readScope(req);
    const kept = scope
      ? all.filter((b) => filterRowsByScope([{ targets: baselineTargetsOf(b) } as Record<string, unknown>], scope).length > 0)
      : all;
    // 摊平后再按范围裁一次:一行覆盖多区时,只留当前范围内的那几区。
    const rows = explodeByTarget(kept).filter(
      (r) => !scope || filterRowsByScope([{ targets: [r.targetId] } as Record<string, unknown>], scope).length > 0
    );
    return apiOk({ baselines: rows });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
