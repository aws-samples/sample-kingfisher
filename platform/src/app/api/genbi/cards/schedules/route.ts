export const dynamic = "force-dynamic";
// @kf-batch 50-WP28-platform-action-node(WP-29 问数 · CAP-GENBI)
// GET /api/genbi/cards/schedules?scope=  **我的**卡片定时刷新(调度中心 / 我的卡片抽屉用)。
// 🔴 按执行范围过滤(读路由口径);只列本人的(卡片是个人资产);带 `?withDrift=1` 才查载体是否落后。
import { NextRequest, NextResponse } from "next/server";
import { requireProject } from "@/lib/projects/guard";
import { requireScope, filterRowsByScope } from "@/lib/exec-env/scope";
import { apiOk } from "@/lib/api-response";
import { listMyCardSchedules } from "@/lib/genbi/cards-schedule";
import { actionScheduleError, attachActionCarrierDrift } from "@/lib/scheduler/action-schedules-http";

export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  const scope = await requireScope(req, ctx.projectId);
  if (scope instanceof NextResponse) return scope;
  try {
    const mine = await listMyCardSchedules(ctx.identity.sub);
    const rows = filterRowsByScope(mine as unknown as Array<Record<string, unknown>>, scope) as unknown as typeof mine;
    if (req.nextUrl.searchParams.get("withDrift") === "1") await attachActionCarrierDrift(rows);
    return apiOk(rows.map((r) => ({ ...r, cardId: String((r.params as { cardId?: unknown }).cardId ?? "") })));
  } catch (e) {
    return actionScheduleError(e);
  }
}
