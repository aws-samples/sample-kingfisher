export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { listMasters } from "@/lib/incidents/store";
import { reconcileIncidents } from "@/lib/incidents/reconcile";
import type { IncidentCategory } from "@/lib/incidents/types";
// @kf-batch 50-WP4quater-reads(工单 SC-20)—— 运维知识库按执行范围过滤。
// 🔴 主档上的 `targets[]` 就是平台 B 类绑定的默认字段名 ⇒ 直接用 `filterRowsByScope`,
// 三级回落(targets → targetId → home)由 `bindingTargets` 唯一作者提供,这里不写第二份判定。
// 过滤放在**其它筛选之后、排序之前**:排序是「复发多的在前」,先过滤再排序才能让单区视角下
// 的 Top 是**那个区自己的** Top(先排序后过滤会让「前 N 名」跨区串味)。
import { readScope, filterRowsByScope } from "@/lib/exec-env/scope";

// GET /api/incidents?status=&engine=&q=&window=  运维知识库列表(按 signature 归并的故障类别)。
// RBAC: viewer。读时先 reconcile(把 done 诊断补记为结构化事件,幂等)—— 这是 A.1 的沉淀入口,
// 零侵入模块25。reconcile best-effort,失败不阻断列表。
export async function GET(req: NextRequest) {
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;

  const sp = req.nextUrl.searchParams;
  const status = sp.get("status") || undefined; // unresolved|resolved-verified|silenced
  const engine = sp.get("engine") || undefined;
  const q = (sp.get("q") || "").toLowerCase().trim();
  const windowDays = parseInt(sp.get("window") || "0", 10) || 0;
  const skipReconcile = sp.get("reconcile") === "0";

  try {
    let reconcile = { scanned: 0, recorded: 0, skipped: 0 };
    if (!skipReconcile) reconcile = await reconcileIncidents(ctx.projectId);

    let masters = await listMasters(ctx.projectId);

    if (status) masters = masters.filter((m) => m.status === status);
    if (engine) masters = masters.filter((m) => m.engine === engine);
    if (q) masters = masters.filter((m) => (m.signature + " " + (m.title || "")).toLowerCase().includes(q));
    if (windowDays > 0) {
      const cutoff = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString();
      masters = masters.filter((m) => (m.lastSeenAt || "") >= cutoff);
    }

    const scope = readScope(req);
    if (scope) masters = filterRowsByScope(masters as unknown as Array<Record<string, unknown>>, scope) as unknown as typeof masters;

    // 复发多的在前;派生 hasVerifiedFix。
    const rows: IncidentCategory[] = masters
      .sort((a, b) => (b.occurrenceCount || 0) - (a.occurrenceCount || 0))
      .map((m) => ({ ...m, hasVerifiedFix: !!m.resolution?.verified }));

    return apiOk({ items: rows, reconcile });
  } catch (e: any) {
    return apiError(e.message || String(e), 500);
  }
}
