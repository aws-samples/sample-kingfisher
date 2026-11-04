export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
// 改绑定的落点只认点名(空列表 ⇒ 400,不再静默改绑主控区)
import { hasTargetsPatch, requestedTargets } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { GetCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
import { recordAudit } from "@/lib/audit";
import { isEngineType, getProvider } from "@/lib/engines/registry";
import { assertBindableTargetsForEngine, TargetBindingRejected } from "@/lib/exec-env/data-plane-target";
import { snapshotVersion } from "@/lib/versions/version-service";
// 删引擎作业**也必须先把它的调度产物撤掉**(ETL 侧早就这么做,这条路一直没做)
import { offlineEmrFanout } from "@/lib/engines/emr/schedule-fanout";
import { offlineFailures, offlineFailureMessage } from "@/lib/etl/dag-fanout";
import type { EmrEngineJob } from "@/lib/engines/emr/types";
// 「运行」的提交段是长操作(engine-run,租约 engine-job:<jobId>)⇒ 提交进行中改 / 删这条作业 ⇒ 409 LONG_OP_IN_PROGRESS
import { resourceBusyResponse } from "@/lib/long-ops/guard";
import { resourceKey } from "@/lib/long-ops/kinds";
// 删作业前核编排 DAG 的离线作业节点引用(唯一作者;被引用 ⇒ 409 JOB_IN_USE,一样不删)
import { workflowsReferencingJob, hasJobReferences, jobInUseResponse } from "@/lib/workflow/job-references";
import { resolveRunStamp } from "@/lib/monitor/run-records";

const USER_ID = "default-user";

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ engine: string; id: string }> }
) {
  const params = await props.params;
  if (!isEngineType(params.engine)) return apiError("未知引擎", 400, { code: "VALIDATION_FAILED" });
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.ENGINE_JOBS, Key: { userId: USER_ID, jobId: params.id } })
  );
  if (!Item) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const guard = await guardResourceAccess(req, Item, "viewer");
  if (guard instanceof NextResponse) return guard;
  return apiOk(Item);
}

export async function PUT(
  req: NextRequest,
  props: { params: Promise<{ engine: string; id: string }> }
) {
  const params = await props.params;
  if (!isEngineType(params.engine)) return apiError("未知引擎", 400, { code: "VALIDATION_FAILED" });
  const { Item: current } = await docClient.send(
    new GetCommand({ TableName: TABLES.ENGINE_JOBS, Key: { userId: USER_ID, jobId: params.id } })
  );
  if (!current) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const guard = await guardResourceAccess(req, current, "editor");
  if (guard instanceof NextResponse) return guard;
  // 「运行」提交进行中(等 EMR 应用 STARTED)⇒ 改作业 409,不让定义在提交途中被改
  const busy = await resourceBusyResponse([resourceKey("engine-job", params.id)]);
  if (busy) return busy;

  const body = await req.json().catch(() => ({}));
  // 改绑定 = 改"在哪个区跑",必须连校验一起进(与创建同一作者)
  if (hasTargetsPatch(body)) {
    try {
      body.targets = await assertBindableTargetsForEngine(
        params.engine,
        requestedTargets(body, "修改作业绑定"),
        "core",
        { scope: "per-project", projectId: guard.projectId } // 项目白名单(scope 必填)
      );
      delete body.targetId;
    } catch (e) {
      const pr = placeErrorResponse(e);
      if (pr) return pr;
      if (e instanceof TargetBindingRejected) return apiError(e.message, 409, { code: "CONFLICT" });
      return apiError((e as Error)?.message ?? String(e), 400, { code: "VALIDATION_FAILED" });
    }
  }
  // cronExpression/scheduleEnabled 由 schedule 路由维护,但也允许 PUT 编辑基础配置。
  const editable = ["name", "description", "script", "spec", "network", "sparkConf", "entryPointArguments", "targets"];
  const sets: string[] = ["updatedAt = :now"];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = { ":now": new Date().toISOString() };
  editable.forEach((f, i) => {
    if (body[f] !== undefined) {
      sets.push(`#f${i} = :v${i}`);
      names[`#f${i}`] = f;
      values[`:v${i}`] = body[f];
    }
  });
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.ENGINE_JOBS,
        Key: { userId: USER_ID, jobId: params.id },
        UpdateExpression: "SET " + sets.join(", "),
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ExpressionAttributeValues: values,
      })
    );
    const { Item } = await docClient.send(
      new GetCommand({ TableName: TABLES.ENGINE_JOBS, Key: { userId: USER_ID, jobId: params.id } })
    );
    // 保存即快照一版(与 etl-job 一致,接入通用版本/晋升/回滚)。best-effort,失败不影响保存。
    await snapshotVersion("engine-job", params.id, Item as any, guard.identity.username, "保存").catch(() => {});
    return apiOk(Item);
  } catch (e: any) {
    return apiError(e.message, 500, { code: "INTERNAL" });
  }
}

// DELETE —— 删作业 + 回收 per-作业 application（destroyResource，零垃圾）。
export async function DELETE(
  req: NextRequest,
  props: { params: Promise<{ engine: string; id: string }> }
) {
  const params = await props.params;
  if (!isEngineType(params.engine)) return apiError("未知引擎", 400, { code: "VALIDATION_FAILED" });
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.ENGINE_JOBS, Key: { userId: USER_ID, jobId: params.id } })
  );
  if (!Item) return apiError("作业不存在", 404, { code: "NOT_FOUND" });
  const guard = await guardResourceAccess(req, Item, "editor");
  if (guard instanceof NextResponse) return guard;
  // 「运行」提交进行中 ⇒ 删作业 409(删掉会让正在提交的那次运行成为再也定位不到的孤儿)
  const busy = await resourceBusyResponse([resourceKey("engine-job", params.id)]);
  if (busy) return busy;
  // 仍被工作流的离线作业节点引用 ⇒ 409 逐条点名工作流,作业行 / application / 调度产物一个都不动(与删源同口径)
  //   §3.7 项目内:本项目的工作流逐条点名;其他项目的只给数量(名字不出项目),一样拒
  const jobRefs = await workflowsReferencingJob(params.id, resolveRunStamp(Item as { projectId?: string }).projectId);
  if (hasJobReferences(jobRefs)) return jobInUseResponse(jobRefs);

  // 🔴🔴 **先撤调度产物,再删行**(2026-09-16:这条路一直缺 —— ETL 侧 `DELETE /api/etl-jobs/[id]`
  //   早就这么做了,引擎作业这条**从来没做**)。少了它的下场:一个开着定时的 EMR 作业被删掉之后,
  //   `<base>__<target>` 的 DAG / serverless workflow **继续按 cron 触发**,而它的落点章与 workflowArn
  //   随 DDB 行一起消失 ⇒ 平台再也定位不到它(孤儿,非 home 的那份还长在别的区)。
  //   「有没有产物」的判据与 ETL 侧同款:调度开着 / 有 dagId / 台账非空,任一为真都要走下线。
  const ej = Item as unknown as EmrEngineJob & { scheduleEnabled?: boolean; airflowDagId?: string; deployments?: Record<string, unknown> };
  const everPublished = Boolean(ej.scheduleEnabled) || Boolean(ej.airflowDagId)
    || Object.keys(ej.deployments ?? {}).length > 0;
  if (everPublished) {
    try {
      const bad = offlineFailures(await offlineEmrFanout(Item as unknown as EmrEngineJob));
      if (bad.length) {
        return apiError(
          offlineFailureMessage(bad, "作业**未删除** —— 先删行会让那个区的调度产物变成再也无法从平台下线的孤儿"
            + "(它仍会按 cron 触发)。台账已保留,请重试或先手动下线调度。"),
          502, { code: "UPSTREAM_ERROR", detail: { failures: bad } }
        );
      }
    } catch (e) {
      return apiError(
        `删除前下线调度失败:${(e as Error)?.message}。作业未删除(先删行会留下无法再下线的孤儿调度)。`,
        502, { code: "UPSTREAM_ERROR" }
      );
    }
  }

  // 再删 application（StopApplication+DeleteApplication）——best-effort，不阻断作业删除。
  try {
    await getProvider(params.engine).destroyResource(Item as any);
  } catch {
    /* application 可能已不存在；作业删除照常 */
  }
  await docClient.send(new DeleteCommand({ TableName: TABLES.ENGINE_JOBS, Key: { userId: USER_ID, jobId: params.id } }));
  recordAudit(req, `engine.${params.engine}.delete`, {
    resourceType: "engine-job",
    resourceId: params.id,
    detail: { applicationId: (Item as any).applicationId || null },
  }).catch(() => {});
  return apiOk({ deleted: true });
}
