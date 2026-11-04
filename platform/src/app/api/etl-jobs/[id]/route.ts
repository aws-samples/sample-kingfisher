export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
// 改绑定的落点只认点名(空列表 ⇒ 400,不再静默改绑主控区)
import { hasTargetsPatch, requestedTargets } from "@/lib/place/resolve";
import { placeErrorResponse } from "@/lib/place/route";
import { GetCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { deleteGlueJobs } from "@/lib/etl/job-service";
import { apiOk, apiError } from "@/lib/api-response";
import { assertBindableTargetsForEngine, TargetBindingRejected, bindingTargets } from "@/lib/exec-env/data-plane-target";
// 自定义执行角色保存期预检
import { preflightCustomRoleForTargets } from "@/lib/execution-role/preflight";
import { s3UrisFromGlueConfig } from "@/lib/execution-role/s3-uris";
import { offlineUnboundTargets, offlineFanout, offlineFailures, offlineFailureMessage } from "@/lib/etl/dag-fanout";
import type { EtlJob } from "@/types/etl-job";
import { guardResourceAccess } from "@/lib/projects/guard";
import { snapshotVersion } from "@/lib/versions/version-service";
import { pushSqlLineageToOpenMetadata } from "@/lib/openmetadata/om-push";
import { recordComputeLineage } from "@/lib/governance/lineage-service";
// 删作业前核编排 DAG 的离线作业节点引用(唯一作者;被引用 ⇒ 409 JOB_IN_USE,一样不删)
import { workflowsReferencingJob, hasJobReferences, jobInUseResponse } from "@/lib/workflow/job-references";
import { resolveRunStamp } from "@/lib/monitor/run-records";

const USER_ID = "default-user";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.ETL_JOBS, Key: { userId: USER_ID, jobId: params.id } })
  );
  if (!Item) return apiError("作业不存在", 404);
  const guard = await guardResourceAccess(req, Item, "viewer");
  if (guard instanceof NextResponse) return guard;
  return apiOk(Item);
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item: current } = await docClient.send(
    new GetCommand({ TableName: TABLES.ETL_JOBS, Key: { userId: USER_ID, jobId: params.id } })
  );
  if (!current) return apiError("作业不存在", 404);
  const guard = await guardResourceAccess(req, current, "editor");
  if (guard instanceof NextResponse) return guard;

  const body = await req.json();
  // 🔴 `targetId` 进白名单**必须连校验一起进**:改执行目标 = 改"SQL 打到哪个区域",
  // 与创建路径同一条判据(单一作者 `assertBindableTarget`),否则改的口子比建的口子还宽。
  // 校验后的绑定放进局部变量,后面只读它(不再回头读 body)
  let newTargets: string[] | undefined;
  if (hasTargetsPatch(body)) {
    try {
      // 判据按**引擎**分(Glue 本期只许 home,理由见该函数注释)。
      // 引擎取**存量行**的 `type`,不取 body:type 不在可改字段白名单里,信 body 等于给了个绕过口。
      newTargets = await assertBindableTargetsForEngine(
        String((current as { type?: string }).type || "redshift"),
        requestedTargets(body, "修改作业绑定"),
        "redshift",
        { scope: "per-project", projectId: guard.projectId } // 项目白名单(scope 必填)
      );
      body.targets = newTargets;
      delete body.targetId; // 只保留一个真值源
    } catch (e) {
      const pr = placeErrorResponse(e);
      if (pr) return pr;
      if (e instanceof TargetBindingRejected) return apiError(e.message, 409, { code: "CONFLICT" });
      return apiError((e as Error)?.message ?? String(e), 400, { code: "VALIDATION_FAILED" });
    }
  }
  // 按「改完之后」的整条作业预检自定义执行角色(只在角色 / 依赖 / 脚本 / 绑定被动到时量;与新建同一作者),缺 ⇒ 400 不落库
  if (String((current as { type?: unknown }).type || "") === "glue" && (body.glueConfig !== undefined || body.script !== undefined || newTargets !== undefined)) {
    const merged = { ...(current as Record<string, unknown>), ...body } as { glueConfig?: { executionRoleArn?: unknown; extraJars?: unknown; extraPyFiles?: unknown }; script?: unknown };
    const pfRes = await preflightCustomRoleForTargets({
      engine: "glue",
      customRoleArn: merged.glueConfig?.executionRoleArn,
      targets: newTargets ?? bindingTargets(current as { targets?: unknown; targetId?: unknown }),
      extraS3Uris: s3UrisFromGlueConfig(merged.glueConfig),
      scriptCode: typeof merged.script === "string" ? merged.script : undefined,
    });
    if (pfRes) return pfRes;
  }
  const fields = ["name", "description", "script", "glueConfig", "redshiftConfig", "cronExpression", "scheduleEnabled", "targets"];
  const sets: string[] = ["updatedAt = :now"];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = { ":now": new Date().toISOString() };
  fields.forEach((f, i) => {
    if (body[f] !== undefined) {
      sets.push(`#f${i} = :v${i}`);
      names[`#f${i}`] = f;
      values[`:v${i}`] = body[f];
    }
  });
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.ETL_JOBS,
        Key: { userId: USER_ID, jobId: params.id },
        UpdateExpression: "SET " + sets.join(", "),
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ExpressionAttributeValues: values,
      })
    );
    const { Item } = await docClient.send(
      new GetCommand({ TableName: TABLES.ETL_JOBS, Key: { userId: USER_ID, jobId: params.id } })
    );
    // 🔴 **解绑 ≠ 下线**:把作业从 `[home, usw2]` 改成 `[home]` 之后,usw2 那份 DAG
    // 还在 MWAA 里按 cron 跑 —— 界面上它已经不绑那个区,那个区却仍在往自己的数仓写数
    // (跨法域下即数据出境)。所以绑定收缩时必须显式下线被摘掉的 target。
    // 顺序:**先落绑定再下线** —— 绑定是用户的意图,写失败时不该已经把某个区的调度停掉;
    // 反过来若下线失败,如实回报(不静默),用户可以再点一次下线。
    let offlinedOnRebind: string[] = [];
    if (newTargets !== undefined) {
      try {
        const un = await offlineUnboundTargets(current as EtlJob, newTargets);
        offlinedOnRebind = un.offlined;
        // 🔴 `offlineFanout` **不抛**(失败写成 failed 行 + 刻意保留台账)⇒ 下面那个 catch 拦不到
        //   逐区失败。不显式判就是「解绑成功」的假象,而那个区还在按 cron 往自己的数仓写数。
        if (un.failures.length) {
          return apiError(
            offlineFailureMessage(un.failures, "🔴 绑定已保存,但这些区域的产物**仍在按 cron 运行** —— "
              + "请在调度面板点一次「下线调度」再重发(台账已保留,可重试)。"),
            502,
            { code: "UPSTREAM_ERROR", detail: { savedTargets: newTargets, failures: un.failures } }
          );
        }
      } catch (e) {
        return apiError(
          `绑定已保存,但被摘掉的执行目标下线失败:${(e as Error)?.message}。` +
            `🔴 那些区域的 DAG 可能仍在 MWAA 里按 cron 运行,请在调度面板点一次「下线调度」再重发。`,
          502,
          { code: "UPSTREAM_ERROR", detail: { savedTargets: newTargets } }
        );
      }
    }
    await snapshotVersion("etl-job", params.id, Item as any, guard.identity.username, "保存").catch(() => {});
    // re-parse SQL → lineage on save (best-effort).
    const saved = Item as any;
    if (saved?.type === "redshift" && saved?.script) {
      pushSqlLineageToOpenMetadata({
        sql: saved.script,
        database: saved.redshiftConfig?.database,
        pipeline: { resourceType: "etl-job", id: params.id, name: saved.name },
      }).catch(() => {});
      // 计算血缘:并排写平台血缘表(治理页可见),保存即刷新。
      recordComputeLineage({
        sql: saved.script,
        database: saved.redshiftConfig?.database,
        taskId: params.id,
        engine: "etl-redshift",
      }).catch(() => {});
    }
    return apiOk(offlinedOnRebind.length ? { ...(Item as object), offlinedOnRebind } : Item);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.ETL_JOBS, Key: { userId: USER_ID, jobId: params.id } })
  );
  if (!Item) return apiError("作业不存在", 404);
  const guard = await guardResourceAccess(req, Item, "editor");
  if (guard instanceof NextResponse) return guard;
  // 仍被工作流的离线作业节点引用 ⇒ 409 逐条点名工作流,作业行 / Glue 作业 / 调度产物一个都不动(与删源同口径)
  //   §3.7 项目内:本项目的工作流逐条点名;其他项目的只给数量(名字不出项目),一样拒
  const jobRefs = await workflowsReferencingJob(params.id, resolveRunStamp(Item as { projectId?: string }).projectId);
  if (hasJobReferences(jobRefs)) return jobInUseResponse(jobRefs);
  // 🔴 删作业**必须先把它的 DAG 全撤掉**。原来只删 DDB 行 ⇒ `dags/bgp_etl_<id>.py` 留在 S3 里,
  // MWAA 继续按 cron 触发一个"已经不存在"的作业(它会去读已删的行然后失败/或按旧脚本继续写数)。
  // 多绑之后这个洞被放大成 N 份产物,而且非 home 的那份在**另一个区域**里跑,更查不到。
  // 下线失败就**不删行**:留着行至少能再点一次下线;先删行再失败等于永久孤儿 DAG。
  const del = Item as EtlJob;
  // 从没发布过的作业不去打 MWAA(省掉每次删除都要拿一次 CLI token 的等待);
  // 判据是"有没有产物",三个来源任一为真都要走下线。
  const everPublished =
    Boolean(del.scheduleEnabled) || Boolean(del.airflowDagId) || Object.keys(del.deployments ?? {}).length > 0;
  try {
    if (everPublished) {
      const bad = offlineFailures(await offlineFanout(del));
      // 🔴 注释(上面)立的是「下线失败就不删行」,而 `offlineFanout` 不抛 ⇒ 这个 try/catch
      //   一条 serverless 下线失败都拦不住,行照删 ⇒ 孤儿 workflow 按 cron 跑而 workflowArn 已随行消失。
      if (bad.length) {
        return apiError(
          offlineFailureMessage(bad, "作业**未删除** —— 先删行会让那个区的产物变成再也无法从平台下线的孤儿"
            + "(它仍会按 cron 触发)。台账已保留,请重试或先手动下线调度。"),
          502,
          { code: "UPSTREAM_ERROR", detail: { failures: bad } }
        );
      }
    }
  } catch (e) {
    return apiError(
      `删除前下线调度失败:${(e as Error)?.message}。作业未删除 —— 先删行会让 MWAA 里的 DAG 变成` +
        `无法再从平台下线的孤儿(它仍会按 cron 触发)。请重试或先手动下线调度。`,
      502,
      { code: "UPSTREAM_ERROR" }
    );
  }
  // Glue 作业定义**随删**(每个绑定 target 各一份;best-effort,详见 deleteGlueJobs)
  const glueCleanup = del.type === "glue" ? await deleteGlueJobs(del).catch(() => [] as Array<{ targetId: string; name: string; ok: boolean }>) : [];
  await docClient.send(new DeleteCommand({ TableName: TABLES.ETL_JOBS, Key: { userId: USER_ID, jobId: params.id } }));
  return apiOk({ deleted: true, glueJobsDeleted: glueCleanup });
}
