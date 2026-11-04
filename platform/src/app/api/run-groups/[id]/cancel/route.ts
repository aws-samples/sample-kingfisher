export const dynamic = "force-dynamic";

// @kf-batch 50-WP5-rungroup
// POST /api/run-groups/[id]/cancel —— 取消这一组里**还没终态**的子 run(50 SPEC v3.44 §2.7)。
//
// 🔴 **已终态的一个都不许动**(E-163 的负向半边):把 succeeded 改成 stopped = 伪造历史。
// 🔴 逐 run 独立结果、整体 200:一个区停不下来不该让另一个区的成功取消变成「失败」。
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { loadRunGroupForRequest } from "@/lib/monitor/run-group-http";
import { cancelRunOnItsTarget } from "@/lib/monitor/run-cancel";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  let loaded;
  try {
    loaded = await loadRunGroupForRequest(req, params.id, "editor");
  } catch (e) {
    return apiError(`读取联动运行失败:${e instanceof Error ? e.message : String(e)}`, 500, { code: "UPSTREAM_ERROR" });
  }
  if (loaded instanceof NextResponse) return loaded;
  const { view, job } = loaded;

  const running = view.children.filter((c) => c.status === "running");
  if (running.length === 0) {
    return apiError(
      `这一组已经没有正在运行的区了(当前 ${view.derivedStatus})—— 无需取消`,
      409,
      { code: "CONFLICT", detail: { reason: "nothing-running", derivedStatus: view.derivedStatus } }
    );
  }

  const rows = await Promise.all(
    running.map((c) => cancelRunOnItsTarget({ ...c, taskId: view.group.definitionId }, { job }))
  );
  recordAudit(req, "run-group.cancel", {
    resourceType: view.group.definitionKind,
    resourceId: view.group.definitionId,
    detail: { runGroupId: params.id, results: rows },
  }).catch(() => {});
  return apiOk({ runGroupId: params.id, results: rows });
}
