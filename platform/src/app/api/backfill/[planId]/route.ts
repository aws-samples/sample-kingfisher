export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { getPlan, listInstances } from "@/lib/backfill/service";
// @kf-batch 50-SEQ47b-backfill-observability —— 序 47b(B-101):实例带上底层 run 的事实(终态 / 错误原话 / 写入行数 / 日志定位键)+ 计划级行数汇总
import { loadRunFacts, factsForInstance, zeroRowHints, summarizeRows } from "@/lib/backfill/run-facts";

// GET /api/backfill/[planId] — 计划详情 + 进度矩阵(日期×节点实例状态)。viewer。
//   序 47b:每个实例多一个 `run`(底层 run 事实;没起过 run ⇒ 无此键)与 `zeroRowHints`(成功但 0 行时的候选原因;否则空数组),
//   响应多一个 `rows`(计划级:已知行数之和 / 已知 / 0 行 / 未上报 的实例数)。既有键逐字节不变(纯追加)。
export async function GET(req: NextRequest, props: { params: Promise<{ planId: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "viewer");
  if (ctx instanceof NextResponse) return ctx;
  try {
    const plan = await getPlan(ctx.projectId, params.planId);
    if (!plan) return apiError("补数计划不存在", 404, { code: "NOT_FOUND" });
    const rawInstances = await listInstances(params.planId);
    // 矩阵坐标:去重日期(行)× 去重节点(列),稳定排序。
    const dates = Array.from(new Set(rawInstances.map((i) => i.date))).sort();
    const seen = new Map<string, { nodeId: string; nodeName: string }>();
    for (const i of rawInstances) if (!seen.has(i.nodeId)) seen.set(i.nodeId, { nodeId: i.nodeId, nodeName: i.nodeName });
    const nodes = Array.from(seen.values());
    const facts = await loadRunFacts(rawInstances);
    const instances = rawInstances.map((i) => {
      const run = factsForInstance(i, facts);
      return { ...i, ...(run ? { run } : {}), zeroRowHints: zeroRowHints(i, run) };
    });
    return apiOk({ plan, instances, matrix: { dates, nodes }, rows: summarizeRows(rawInstances, facts) });
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
