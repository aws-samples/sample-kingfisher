export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { listMasters } from "@/lib/incidents/store";
import { computeHealth } from "@/lib/incidents/health";
import { reconcileIncidents } from "@/lib/incidents/reconcile";
// @kf-batch 50-WP4quater-reads(工单 SC-20)—— 🔴 健康度**必须与列表用同一个过滤**:
// 顶部卡片(类别数 / 已验证修复覆盖率 / 复发 Top)若还是全平台合计,而下面的表只列本区,
// 用户看到的是「覆盖率 60%」配一张两行的表 —— 两个数字互相矛盾比都不过滤更难判断。
import { readScope, filterRowsByScope } from "@/lib/exec-env/scope";

// GET /api/incidents/health — 知识库健康度聚合(类别数/已验证修复覆盖率/MTTR/复发Top/按引擎分布)。
// RBAC: viewer。同列表:读时先 reconcile(幂等,best-effort)。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const skipReconcile = req.nextUrl.searchParams.get("reconcile") === "0";
  try {
    if (!skipReconcile) await reconcileIncidents(ctx.projectId);
    const all = await listMasters(ctx.projectId);
    const scope = readScope(req);
    const masters = scope
      ? (filterRowsByScope(all as unknown as Array<Record<string, unknown>>, scope) as unknown as typeof all)
      : all;
    return apiOk(computeHealth(masters));
  } catch (e: any) {
    return apiError(e.message || String(e), 500);
  }
}
