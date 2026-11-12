export const dynamic = "force-dynamic";
// GET /api/admin/pending-cleanups:平台自建安全组的后台清理作业清单(全平台所有执行环境)。
//
// 回什么:kind = sg-cleanup 里**未终态**(还在等网卡释放)与 **failed**(预算耗尽 ⇒ 需人工)的作业;成功的不列(删源响应与审计已记)。
// 🔴 回的是 DTO(`toPublicJob` 允许列表):lease / runToken / revision / 私有 state 永不出去;evidence 里有 sgId / region / eniCount / outcome。
// 🔴 清单的用途本身就是跨执行范围(人要看全平台哪些组还没清),所以不接 ?scope=(读取级台账 `cross-scope-by-design`)。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireExecEnvAdmin } from "@/lib/exec-env/admin-guard";
import { listTargetsRaw } from "@/lib/exec-env/registry";
import { listJobsByTarget } from "@/lib/dataplane-jobs/store";
import { toPublicJob, type PublicJob } from "@/lib/dataplane-jobs/dto";
import type { JobKind } from "@/lib/dataplane-jobs/schema";
import { dataplaneJobsPaused } from "@/lib/dataplane-jobs/schema";
import { isTerminalPhase } from "@/lib/dataplane-jobs/model";

export async function GET(req: NextRequest) {
  const identity = await requireExecEnvAdmin(req);
  if (identity instanceof NextResponse) return identity;
  try {
    const jobs: PublicJob[] = [];
    // 清理类作业两种:平台自建安全组按网卡事实收口 · DMS 复制实例按「零复制任务」事实回收
    const CLEANUP_KINDS: readonly JobKind[] = ["sg-cleanup", "dms-instance-reclaim"];
    for (const t of await listTargetsRaw()) {
      for (const kind of CLEANUP_KINDS) {
        const rows = await listJobsByTarget(t.targetId, { kind, maxItems: 200 });
        for (const row of rows) {
          if (!isTerminalPhase(row.phase) || row.phase === "failed") jobs.push(toPublicJob(row));
        }
      }
    }
    jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return apiOk({ paused: dataplaneJobsPaused(), jobs });
  } catch (e) {
    return apiError((e as Error)?.message ?? String(e), 500);
  }
}
