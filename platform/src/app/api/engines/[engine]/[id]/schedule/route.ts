export const dynamic = "force-dynamic";

// POST /api/engines/[engine]/[id]/schedule  body { cronExpression, targets?: string[] }
//   为该引擎作业发布 cron 调度 DAG —— @kf-batch 50-WP13-mwaa-region **逐 target 扇出到该 target 自己的 MWAA**
//   (用户 2026-09-06 拍板「每个区域的定时任务都是自己区域的 MWAA 执行的,不允许跨区域调度」;SPEC v3.26 §3.14)。
//   原版只发 home 一份、用 home 的角色 / application / 脚本桶(注释自证「MWAA 是 home 独有」)—— 已作废。
//   前提:作业至少成功运行过一次(脚本已写);扇出时逐 target ensure application + 上传脚本 + 复制 jar。
// DELETE /api/engines/[engine]/[id]/schedule  下线全部产物(绑定 ∪ 台账,逐 target pause + 删该区 DAG 文件 + scheduleEnabled=false)。

import { NextRequest, NextResponse } from "next/server";
// @kf-batch 50-WP31-place-first-class —— targets 子集的唯一解析作者
import { requestedSubset } from "@/lib/place/resolve";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { isEngineType } from "@/lib/engines/registry";
import type { EmrEngineJob } from "@/lib/engines/emr/types";
import { TargetBindingRejected } from "@/lib/exec-env/data-plane-target";
import { publishEmrFanout, offlineEmrFanout, emrBaseDagIdOf } from "@/lib/engines/emr/schedule-fanout";
import { offlineFailures, offlineFailureMessage, OFFLINE_RETRY_TAIL } from "@/lib/etl/dag-fanout";
import { MwaaNotInstalled, mwaaErrorResponse, mwaaDagBucketOfHome, unpauseWhenLoaded } from "@/lib/scheduler/mwaa-endpoint";

const USER_ID = "default-user";

async function loadJob(id: string): Promise<EmrEngineJob | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.ENGINE_JOBS, Key: { userId: USER_ID, jobId: id } }));
  return (Item as EmrEngineJob) || null;
}

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ engine: string; id: string }> }
) {
  const params = await props.params;
  if (!isEngineType(params.engine)) return apiError("未知引擎", 400, { code: "VALIDATION_FAILED" });
  const job = await loadJob(params.id);
  if (!job) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const guard = await guardResourceAccess(req, job, "editor");
  if (guard instanceof NextResponse) return guard;
  if (!job.script || !job.script.trim()) return apiError("脚本为空，请先编写并运行一次作业", 400, { code: "VALIDATION_FAILED" });
  if (params.engine !== "emr-serverless") return apiError("该引擎暂不支持调度", 400, { code: "VALIDATION_FAILED" });

  const body = await req.json().catch(() => ({}));
  const cron = body.cronExpression || job.cronExpression;
  if (!cron) return apiError("缺少 cronExpression（如 '0 * * * *'）", 400, { code: "VALIDATION_FAILED" });
  const onlyTargets = requestedSubset(body);

  try {
    const { rows, version, baseDagId, endpoints } = await publishEmrFanout(
      { ...job, cronExpression: cron },
      cron,
      onlyTargets && onlyTargets.length ? { onlyTargets } : {}
    );
    const okRows = rows.filter((r) => r.status === "ok");
    const failed = rows.filter((r) => r.status === "failed");
    // 🔴 一个区都没发出去 ⇒ 不许把 scheduleEnabled 置真(界面「已启用调度」而 MWAA 里什么都没有 = 假绿)
    if (okRows.length === 0) {
      recordAudit(req, `engine.${params.engine}.schedule.failed`, { resourceType: "engine-job", resourceId: job.jobId, detail: { cron, rows } }).catch(() => {});
      return apiError("发布调度失败:没有任何执行目标下发成功", 409, { code: "CONFLICT", detail: { rows, baseDagId } });
    }
    await docClient.send(new UpdateCommand({
      TableName: TABLES.ENGINE_JOBS,
      Key: { userId: USER_ID, jobId: params.id },
      UpdateExpression: "SET cronExpression = :c, scheduleEnabled = :e, airflowDagId = :d, updatedAt = :now",
      // 存的仍是**基准** dagId(home 那一份);per-target 产物名在台账 deployments[targetId].artifact
      ExpressionAttributeValues: { ":c": cron, ":e": true, ":d": baseDagId, ":now": new Date().toISOString() },
    }));

    // 加载后解挂 —— 逐 target 去**该 target 自己的** Airflow(fire-and-forget)
    (async () => {
      const byTarget = new Map<string, string[]>();
      for (const row of okRows) byTarget.set(row.targetId, [...(byTarget.get(row.targetId) ?? []), row.dagId]);
      await Promise.all(Array.from(byTarget.entries()).map(([tid, dagIds]) => (endpoints[tid] ? unpauseWhenLoaded(endpoints[tid], dagIds) : Promise.resolve([]))));
    })().catch(() => {});

    recordAudit(req, `engine.${params.engine}.schedule`, { resourceType: "engine-job", resourceId: job.jobId, detail: { baseDagId, cron, version, rows } }).catch(() => {});
    // 兼容旧客户端的 `dagId` / `bucket`(home 口径);行级 rows[].bucket 才是各区真值
    return apiOk({ dagId: baseDagId, bucket: mwaaDagBucketOfHome(), cron, version, rows, partial: failed.length > 0 });
  } catch (e: any) {
    if (e instanceof MwaaNotInstalled) return mwaaErrorResponse(e);
    if (e instanceof TargetBindingRejected) return apiError(`发布调度失败:${e.message}`, 409, { code: "CONFLICT" });
    return apiError(`发布调度失败: ${e.message}`, 500, { code: "UPSTREAM_ERROR" });
  }
}

export async function DELETE(
  req: NextRequest,
  props: { params: Promise<{ engine: string; id: string }> }
) {
  const params = await props.params;
  if (!isEngineType(params.engine)) return apiError("未知引擎", 400, { code: "VALIDATION_FAILED" });
  const job = await loadJob(params.id);
  if (!job) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const guard = await guardResourceAccess(req, job, "editor");
  if (guard instanceof NextResponse) return guard;

  try {
    // 覆盖面 = 绑定 ∪ 台账,逐 target 去它自己的 MWAA(原版只 pause home / 删 home 桶 ⇒ 非 home 孤儿调度)
    const offlined = await offlineEmrFanout(job);
    const result = { dagId: emrBaseDagIdOf(job), offlined };
    // 🔴 T-14:有任何一区下线失败(如还有 run 没停)⇒ 整体报错、**不**把 scheduleEnabled 置 false;台账已刻意保留,再点一次可重试。
    const failedRows = offlineFailures(offlined);
    if (failedRows.length) {
      return apiError(offlineFailureMessage(failedRows, OFFLINE_RETRY_TAIL), 502,
        { code: "UPSTREAM_ERROR", detail: { failures: failedRows } });
    }
    await docClient.send(new UpdateCommand({
      TableName: TABLES.ENGINE_JOBS,
      Key: { userId: USER_ID, jobId: params.id },
      UpdateExpression: "SET scheduleEnabled = :e, updatedAt = :now REMOVE cronExpression",
      ExpressionAttributeValues: { ":e": false, ":now": new Date().toISOString() },
    }));
    recordAudit(req, `engine.${params.engine}.schedule.offline`, { resourceType: "engine-job", resourceId: job.jobId, detail: { ...result } }).catch(() => {});
    return apiOk(result);
  } catch (e: any) {
    return apiError(`下线调度失败: ${e.message}`, 500, { code: "UPSTREAM_ERROR" });
  }
}
