export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
// @kf-batch 50-WP31-place-first-class —— targets 子集的唯一解析作者
import { requestedSubset } from "@/lib/place/resolve";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
// @kf-batch 50-P50.3-dataplane
import { bindingTargets, TargetBindingRejected } from "@/lib/exec-env/data-plane-target";
// @kf-batch 50-P50.3-fanout —— 逐 target 下发/下线的唯一作者。
import { planFanout, publishFanout, offlineFanout, baseDagIdOf, mwaaDagBucket, offlineFailures, offlineFailureMessage, OFFLINE_RETRY_TAIL } from "@/lib/etl/dag-fanout";
// @kf-batch 50-WP13-mwaa-region —— 缺 MWAA 前置(409 直达补装)+ 按 target 的 Airflow 解挂
import { MwaaNotInstalled, mwaaErrorResponse, requireMwaaForTargets, unpauseWhenLoaded } from "@/lib/scheduler/mwaa-endpoint";
import { ensureGlueJob } from "@/lib/etl/job-service";
import { glueJobNameFor } from "@/lib/etl/glue-job-name";
import { recordAudit } from "@/lib/audit";
import { guardResourceAccess } from "@/lib/projects/guard";
import type { EtlJob } from "@/types/etl-job";

const USER_ID = "default-user";

// @kf-batch 50-P50.3-fanout
// **下发预览**(INTERACTION §2.2 机制B「先预览、再逐 region 执行」)。
// 🔴 GET 是**纯读**:它绝不能有任何副作用 —— 预览若自己就把 DAG 发了,「先看清再确认」就成了摆设。
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.ETL_JOBS, Key: { userId: USER_ID, jobId: params.id } })
  );
  if (!Item) return apiError("作业不存在", 404);
  const guard = await guardResourceAccess(req, Item, "viewer");
  if (guard instanceof NextResponse) return guard;
  const job = Item as EtlJob;
  try {
    const rows = await planFanout(job);
    return apiOk({
      jobId: job.jobId,
      baseDagId: baseDagIdOf(job),
      bucket: mwaaDagBucket(),
      cron: job.cronExpression || null,
      targets: bindingTargets(job),
      rows,
      blocked: rows.filter((row) => !row.ok).map((row) => row.targetId),
    });
  } catch (e: unknown) {
    // 🔴 预览失败**不许回空列表**:空列表会被读成「没有要下发的区」,那是最危险的误读
    // (与 `/api/exec-targets` 同一条判据)。
    return apiError(`算下发预览失败:${(e as Error)?.message}`, 502, { code: "UPSTREAM_ERROR" });
  }
}

// Publish a cron-scheduled Airflow DAG for this ETL job to MWAA, then auto-unpause it.
//
// @kf-batch 50-P50.3-dataplane(🔴 已被 WP-13 订正,见下)
// 原写「MWAA 是 home 独有的 ⇒ 调度中心化、DAG 永远落 home 桶」—— 用户 2026-09-06 拍板「每个区域的定时任务都是自己区域的 MWAA
// 执行的,不允许跨区域调度」⇒ 现在每份 DAG 落**该 target 自己的** MWAA(SPEC v3.26 §3.14),缺 MWAA 的 target 在任何写之前整体拒。
// @kf-batch 50-P50.3-fanout —— 订正上一版的边界说明:**产物是逐 target 的**
// (`<base>__<targetId>`,N 个区 N 份 DAG 文件,都落 home 那一个桶),下线也逐份撤
// (`offlineFanout`)。真正还没做的是 SPEC §3.12 的「per-target **MWAA 环境**」——
// 那要等 `mwaa` 从 `PENDING_COMPONENTS` 里出来才成立。别把这两件事混成一件。
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.ETL_JOBS, Key: { userId: USER_ID, jobId: params.id } })
  );
  if (!Item) return apiError("作业不存在", 404);
  const guard = await guardResourceAccess(req, Item, "editor");
  if (guard instanceof NextResponse) return guard;
  const job = Item as EtlJob;
  const body = await req.json().catch(() => ({}));
  const cron = body.cronExpression || job.cronExpression;
  if (!cron) return apiError("缺少 cronExpression（如 '0 * * * *'）");

  try {
    // @kf-batch 50-P50.3-engines
    // 🔴🔴 Glue 的 DAG 是**按名字触发一个已存在的 Glue 作业**,而 Glue 作业是 **region 作用域**资源
    // ⇒ 绑了 N 个区就必须在**每个要下发的区**都先把它建出来。
    // 原来这里只 `ensureGlueJob(job)`(= 只建 home 那份)⇒ usw2 的 DAG 发上去了、cron 到点却在
    // us-west-2 调一个**不存在的作业**:任务当场失败,而看板上"已下发"是绿的(静默漏区的变体)。
    // 顺序也重要:**先把作业建齐再发 DAG** —— 反过来会出现"DAG 已在跑、作业还没建好"的窗口。
    // 作业行的 `glueJobName` 字段 = **home 名**的展示副本(per-target 名由 `glueJobNameFor` 派生,DAG 生成器自己算)
    let glueJobName: string | undefined = job.type === "glue" ? glueJobNameFor(job.jobId) : job.glueJobName;

    // @kf-batch 50-P50.3-fanout
    // 🔴 **逐 target 扇出**:一个定义绑了 N 个区就要产出 N 份 DAG。
    // W3-a 只发绑定的第一个 ⇒ 绑了 `[home, usw2]` 的作业 **usw2 永远不被调度**,
    // 而界面显示"已绑两个区、已发布" = 静默漏区(客户痛点原话「怕漏 region 对不上」)。
    // 串行 fail-fast + 逐 target 写台账,失败那格进版本一致性矩阵(INTERACTION §2.2)。
    // @kf-batch 50-P50.3-matrix —— `targets` 可指定**子集**(矩阵页「重发到此 region」);
    // 缺省 = 全部绑定(存量行为不变)。子集必须是绑定的子集,扇出作者会再核一遍。
    const onlyTargets = requestedSubset(body);
    // @kf-batch 50-WP13-mwaa-region
    // 🔴 **第一步**:全部要下发的 target 都得有自己的 MWAA(用户拍板「每个区域的定时任务都是自己区域的 MWAA 执行的」)。
    //    放在 ensureGlueJob 之前 —— 建 Glue 作业已是副作用,缺 MWAA 时必须零副作用(E-208);缺的一起列 ⇒ 409 + 直达补装。
    const wantedTargets = onlyTargets && onlyTargets.length ? onlyTargets : bindingTargets(job);
    await requireMwaaForTargets(wantedTargets);
    if (job.type === "glue") {
      const wanted = wantedTargets;
      for (const t of wanted) {
        // 逐区建/更新(幂等:GetJob 命中就 UpdateJob);任一区建不出来就整体拒 ——
        // 半数区有作业、半数没有,比完全没发更难查。
        await ensureGlueJob(job, t); // 返回的是**该 target** 的名字;行上只存 home 名
      }
    }

    const { rows, version, baseDagId, endpoints } = await publishFanout(
      { ...job, cronExpression: cron },
      { cron, ...(onlyTargets && onlyTargets.length ? { onlyTargets } : {}) }
    );
    const okRows = rows.filter((r) => r.status === "ok");
    const failed = rows.filter((r) => r.status === "failed");
    const bucket = mwaaDagBucket();

    // 🔴 **一个区都没发出去 ⇒ 不许把 `scheduleEnabled` 置真**,否则界面显示"已启用调度"
    // 而 MWAA 里什么都没有 —— 那是最典型的假绿。
    if (okRows.length === 0) {
      recordAudit(req, "etl-job.schedule.failed", {
        resourceType: "etl-job", resourceId: job.jobId, detail: { cron, rows },
      }).catch(() => {});
      return apiError(`发布调度失败:没有任何执行目标下发成功`, 409, {
        code: "CONFLICT",
        detail: { rows, baseDagId, bucket },
      });
    }

    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.ETL_JOBS,
        Key: { userId: USER_ID, jobId: params.id },
        UpdateExpression:
          "SET cronExpression = :c, scheduleEnabled = :e, airflowDagId = :d, glueJobName = :g, updatedAt = :now",
        ExpressionAttributeValues: {
          ":c": cron,
          ":e": true,
          // 🔴 存的仍是**基准** dagId(home 那一份),per-target 的产物名在台账
          // `deployments[targetId].artifact` 里 —— 一个字段塞不下 N 份产物,而基准值是可复算的。
          ":d": baseDagId,
          ":g": glueJobName || null,
          ":now": new Date().toISOString(),
        },
      })
    );

    // Auto-unpause once MWAA picks up the DAG (fire-and-forget to keep the response fast).
    // 🔴 扇出后要 unpause **每一份**产物:漏 unpause 的那份 DAG 会以 paused 状态躺在 MWAA 里,
    // 表现与"漏发"一模一样(台账却是绿的)。
    // @kf-batch 50-WP13-mwaa-region —— 🔴 逐 target 去**该 target 自己的** Airflow 解挂(原来只对 home 环境轮询 ⇒ 非 home 的 DAG 永远 paused)
    (async () => {
      const byTarget = new Map<string, string[]>();
      for (const row of okRows) byTarget.set(row.targetId, [...(byTarget.get(row.targetId) ?? []), row.dagId]);
      await Promise.all(
        Array.from(byTarget.entries()).map(([tid, dagIds]) => {
          const ep = endpoints[tid];
          return ep ? unpauseWhenLoaded(ep, dagIds) : Promise.resolve([]);
        })
      );
    })().catch(() => {
      /* best-effort */
    });

    recordAudit(req, "etl-job.schedule", {
      resourceType: "etl-job", resourceId: job.jobId,
      detail: { baseDagId, cron, version, rows },
    }).catch(() => {});
    // 🔴 部分成功要**如实回报**(`partial` + 逐行状态),不许把 N 个区里发成 1 个说成"发布成功"。
    return apiOk({
      dagId: baseDagId,
      bucket,
      cron,
      version,
      rows,
      partial: failed.length > 0,
    });
  } catch (e: any) {
    // @kf-batch 50-WP13-mwaa-region —— 缺 MWAA:409 MWAA_NOT_INSTALLED + detail.missing[] + fix.href(前端直达补装)
    if (e instanceof MwaaNotInstalled) return mwaaErrorResponse(e);
    // @kf-batch 50-P50.3-dataplane
    // 绑定被拒是**用户可修**的(目标没装 redshift / 落点冲突 / 缺凭证),给 409 + 原因,
    // 不要混在 500 里 —— 500 会让人去查平台故障,而真正该做的是换目标或补装组件。
    if (e instanceof TargetBindingRejected) {
      return apiError(`发布调度失败:${e.message}`, 409, { code: "CONFLICT" });
    }
    return apiError(`发布调度失败: ${e.message}`, 500);
  }
}

// 下线调度:pause DAG + 删 S3 DAG 文件 + scheduleEnabled=false(发布的逆操作)。
// 之前平台只有"发布到 MWAA",取消调度得手动登 MWAA 删 DAG——此端点补齐闭环。
export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.ETL_JOBS, Key: { userId: USER_ID, jobId: params.id } })
  );
  if (!Item) return apiError("作业不存在", 404);
  const guard = await guardResourceAccess(req, Item, "editor");
  if (guard instanceof NextResponse) return guard;
  const job = Item as EtlJob;

  try {
    // @kf-batch 50-P50.3-fanout
    // 🔴 下线覆盖面 = **当前绑定 ∪ 台账里出现过的 target**。只下线基准那一份的话,
    // 非 home 的 `<base>__<target>` 会永久留在 MWAA 里按 cron 跑 ——
    // 用户以为调度已下线,那个区还在往自己的数仓写数(跨法域下就是数据出境)。
    const results = await offlineFanout(job);
    // 🔴 T-14:有任何一区下线失败(如还有 run 没停)⇒ 整体报错、**不**把 scheduleEnabled 置 false。
    //   否则页面显示「已下线」而那个区的 workflow 还在按 cron 跑(真环境留下过孤儿)。台账已刻意保留,再点一次即可重试。
    const failedRows = offlineFailures(results);
    if (failedRows.length) {
      return apiError(offlineFailureMessage(failedRows, OFFLINE_RETRY_TAIL), 502,
        { code: "UPSTREAM_ERROR", detail: { failures: failedRows } });
    }
    const result = { dagId: baseDagIdOf(job), offlined: results };

    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.ETL_JOBS,
        Key: { userId: USER_ID, jobId: params.id },
        UpdateExpression: "SET scheduleEnabled = :e, updatedAt = :now REMOVE cronExpression",
        ExpressionAttributeValues: { ":e": false, ":now": new Date().toISOString() },
      })
    );

    recordAudit(req, "etl-job.schedule.offline", {
      resourceType: "etl-job", resourceId: job.jobId, detail: { ...result },
    }).catch(() => {});
    return apiOk(result);
  } catch (e: any) {
    return apiError(`下线调度失败: ${e.message}`, 500);
  }
}
