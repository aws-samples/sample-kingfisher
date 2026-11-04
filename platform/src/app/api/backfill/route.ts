export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { listPlans } from "@/lib/backfill/service";
// 执行范围(50 SPEC §2.6;当前阶段 1)
import { filterRowsByScope, requireScope } from "@/lib/exec-env/scope";
import { BACKFILL_PLAN_BINDING_ATTR } from "@/lib/backfill/types";

// GET /api/backfill — 当前项目的补数计划列表(viewer)。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  // 执行范围。只认 URL,不回落。
  const scope = await requireScope(req, ctx.projectId);
  if (scope instanceof NextResponse) return scope;
  try {
    const plans = await listPlans(ctx.projectId);
    // B 类(绑定列表)只许内存过滤,且**换字段名读**:
    // 计划行的绑定字段历史上叫 `execTargets`(创建时由所选作业自己的 `bindingTargets` 派生),
    // 三级回落仍然只有 `bindingTargets` 一个作者(见 `filterRowsByScope` 的 `bindingAttr`)。
    return apiOk({
      plans: filterRowsByScope(
        plans as unknown as Array<Record<string, unknown>>,
        scope,
        BACKFILL_PLAN_BINDING_ATTR
      ),
    });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
