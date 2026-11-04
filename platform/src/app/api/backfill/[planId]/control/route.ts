export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { requireProject } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { getPlan, setPlanStatus, retryFailedInstances, listInstances, refreshPlanProgress } from "@/lib/backfill/service";
import { isEngineType, getProvider } from "@/lib/engines/registry";

const USER_ID = "default-user";

// POST /api/backfill/[planId]/control  { action: "pause"|"resume"|"cancel"|"retry-failed" }
// editor。pause/resume 切计划状态(tick 据此决定是否领新实例);cancel 停未开始+尝试 stop 运行中;
// retry-failed 把 failed 实例重置 pending(续跑,只重跑失败项)。
export async function POST(req: NextRequest, props: { params: Promise<{ planId: string }> }) {
  const params = await props.params;
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || "");
  try {
    const plan = await getPlan(ctx.projectId, params.planId);
    if (!plan) return apiError("补数计划不存在", 404, { code: "NOT_FOUND" });

    if (action === "pause") {
      await setPlanStatus(plan, "paused");
    } else if (action === "resume") {
      await setPlanStatus(plan, "running");
    } else if (action === "cancel") {
      await setPlanStatus(plan, "cancelled");
      // best-effort:尝试停运行中实例的引擎 run(EMR 有 stop;ETL/SQL 无原生 stop 则任其自然结束)。
      const instances = await listInstances(params.planId);
      for (const inst of instances.filter((i) => i.status === "running" && i.runId)) {
        try {
          if (plan.target.kind === "engine-job") {
            const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.ENGINE_JOBS, Key: { userId: USER_ID, jobId: plan.target.id } }));
            const engineType = String((Item as any)?.engine || "emr-serverless");
            const { Item: run } = await docClient.send(new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId: inst.runTaskId, runId: inst.runId } }));
            if (Item && isEngineType(engineType) && run?.nativeRunId) {
              await getProvider(engineType).stop(Item as any, inst.runId!, String(run.nativeRunId)).catch(() => {});
            }
          }
        } catch { /* best-effort */ }
      }
    } else if (action === "retry-failed") {
      const n = await retryFailedInstances(params.planId);
      // 续跑后计划回 running(若之前 partially-failed),重算进度。
      const fresh = await listInstances(params.planId);
      await refreshPlanProgress({ ...plan, status: n > 0 ? "running" : plan.status }, fresh);
    } else {
      return apiError("未知操作", 400, { code: "VALIDATION_FAILED" });
    }

    recordAudit(req, `backfill.control`, { resourceType: "backfill-plan", resourceId: params.planId, detail: { action } }).catch(() => {});
    const updated = await getPlan(ctx.projectId, params.planId);
    return apiOk(updated);
  } catch (e: any) {
    // 乐观锁冲突。
    if (e?.name === "ConditionalCheckFailedException") return apiError("计划已被其他操作更新,请刷新重试", 409, { code: "CONFLICT" });
    return apiError(e?.message || "操作失败", 500);
  }
}
