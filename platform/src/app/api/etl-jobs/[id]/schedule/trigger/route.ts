export const dynamic = "force-dynamic";
// POST /api/etl-jobs/[id]/schedule/trigger —— 〔触发一次〕:对已发布的 target 立刻跑一次调度产物。
// 分路在 lib/scheduler/trigger.ts(serverless ⇒ StartWorkflowRun;mwaa ⇒ dags trigger);跨法域 target 的手动触发是用户发起的数据操作
// ⇒ 与〔立即运行〕同一前置(免责告知同意);运行行仍由调度产物内的运行时写(triggeredBy=schedule + runType=ON_DEMAND)。
import { NextRequest, NextResponse } from "next/server";
// targets 子集的唯一解析作者
import { requestedSubset } from "@/lib/place/resolve";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { recordAudit } from "@/lib/audit";
import { guardResourceAccess } from "@/lib/projects/guard";
import { baseDagIdOf } from "@/lib/etl/dag-fanout";
import { triggerScheduledRuns } from "@/lib/scheduler/trigger";
import { MwaaNotInstalled, mwaaErrorResponse } from "@/lib/scheduler/mwaa-endpoint";
import { requireResidencyAckForTargets, residencyErrorResponse } from "@/lib/exec-env/residency-audit";
import { AuditUnavailable, ResidencyAckRequired } from "@/lib/exec-env/residency";
import type { EtlJob } from "@/types/etl-job";

const USER_ID = "default-user";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.ETL_JOBS, Key: { userId: USER_ID, jobId: params.id } }));
  if (!Item) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const guard = await guardResourceAccess(req, Item, "editor");
  if (guard instanceof NextResponse) return guard;
  const job = Item as EtlJob;
  const body = await req.json().catch(() => ({}));
  const only: string[] | undefined = requestedSubset(body);
  const deployed = Object.keys((job.deployments ?? {}) as Record<string, unknown>);
  const targets = only && only.length ? only.filter((t) => deployed.includes(t)) : deployed;
  if (targets.length === 0) return apiError("该作业没有已发布的调度产物 —— 先〔发布到 MWAA 调度〕再触发(触发 ≠ 发布)", 409, { code: "CONFLICT" });
  try {
    await requireResidencyAckForTargets(guard.identity, targets);
    const rows = await triggerScheduledRuns({ baseDagId: baseDagIdOf(job), deployments: job.deployments as Record<string, { scheduler?: string; workflowArn?: string } | undefined>, targets });
    recordAudit(req, "etl-job.schedule.trigger", { resourceType: "etl-job", resourceId: job.jobId, detail: { rows } }).catch(() => {});
    return apiOk({ rows, partial: rows.some((r) => r.status !== "ok") });
  } catch (e: unknown) {
    if (e instanceof ResidencyAckRequired || e instanceof AuditUnavailable) {
      // residencyErrorResponse 对非驻留类错误回 null;Next 的路由类型检查要求 POST 只回 Response ⇒ 显式收窄
      const r = residencyErrorResponse(e);
      if (r) return r;
    }
    if (e instanceof MwaaNotInstalled) return mwaaErrorResponse(e);
    return apiError(`触发失败:${String((e as Error)?.message ?? e)}`, 500);
  }
}
