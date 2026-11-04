export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { collectDailyCosts } from "@/lib/finops/collector";
import { sweepTaskCosts } from "@/lib/finops/sweep";
import { backfillCostRunStamps } from "@/lib/finops/stamp-backfill";

// POST /api/finops/collect?backfill=1 — 手动触发采集(CE 日成本 + 任务归因扫描)。
// 幂等:CE 采集是 upsert 覆盖,归因是条件写去重,重复触发安全。RBAC: editor。
// backfill=1 时**顺带**给存量成本行补 {projectId,targetId}(T1;只补空缺、可反复)。
export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;

  const backfill = req.nextUrl.searchParams.get("backfill") === "1";
  try {
    const ce = await collectDailyCosts({ backfill });
    const sweep = await sweepTaskCosts({ backfill });
    const stamps = backfill ? await backfillCostRunStamps() : undefined;
    return apiOk({ ce, sweep, ...(stamps ? { stamps } : {}) });
  } catch (e: unknown) {
    return apiError((e as Error).message || String(e), 500);
  }
}
