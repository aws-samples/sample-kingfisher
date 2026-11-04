export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
// (原则 3)—— DMS 通道尚未逐区,非 home 章 fail-closed
import { boundToHomeOnly } from "@/lib/exec-env/definition-binding";
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
// task-runs 唯一写通道(50 SPEC §6 S10)。
import { putRunRecord, settleRunningRuns, resolveRunStamp } from "@/lib/monitor/run-records";
import { recordAudit } from "@/lib/audit";
import { getCorrelationId, logger } from "@/lib/observability/logger";
// 同步任务行的唯一状态写通道(条件写,不 upsert 幽灵行)
import { updateSyncTaskIfExists } from "@/lib/sync/task-write";
import {
  ensureSourceEndpoint,
  ensureTargetEndpoint,
  ensureReplicationTask,
  startReplication,
  testEndpoints,
  getReplicationInstanceArn,
  probeReplicationInstance,
  REPLICATION_INSTANCE_BROKEN_STATUSES,
  waitTaskStartable,
} from "@/lib/realtime/dms-service";
// 停 / 删 / 「启动被接管后停回去」共用**同一个**下线作者
import { teardownSyncChannel } from "@/lib/sync/teardown";
import {
  ensureRedshiftDmsUser,
  ensureTargetSchema,
  ensureRoleAssociatedToNamespace,
} from "@/lib/realtime/redshift-target";

// 实时同步启动入口(syncMode=realtime / channel=dms)。
//
// 与 Glue 批同步的 /start 解耦(关注点分离):本路由专门编排 DMS CDC,调用 R5 固化的幂等服务层。
// 编排顺序固化了 R3/R4 实测的 7 个踩坑解法(目标准备 → endpoints → 任务 → 启动)。
//
// 生产级:editor+ RBAC、审计、幂等(全程 ensure*)、结构化日志带 correlationId、错误不吞。
// 不创建常驻基建(DMS 实例/Kinesis 由门控 BgpRealtimeStack 提供;经环境变量判断是否就绪)。
//
// 【(2026-10-24 全新账号页面驱动段 wp24 抓到)】两件事一起坏
//   ① 返 202 之前同步 `await getReplicationInstanceArn()`:全新账号第一次「启动」要现场创建复制实例
//      (3–8 分钟),一次 HTTP 请求等过 60s 边缘超时 ⇒ 页面 504(「不知道成没成」),服务端请求照跑;
//   ② 没有「同一任务只许一条启动编排」的守卫:用户看到 504 再点,就再多一条;实例就位后几条编排
//      一起起跑,互撞 `ResourceAlreadyExistsFault`,撞的那条把任务写成 error(页面「异常」、只剩「启动」),
//      几十秒后另一条又写回 running —— 状态来回翻。
//   修法:等待一律进后台(请求路径只做不等待的探测);把任务置 provisioning 的那一笔改成**条件写**
//   (已在 provisioning 且不陈旧 ⇒ 409,不再起第二条编排);后台编排每到要动真资源的关口都先确认
//   「这条任务仍是我这次启动在管」(status 仍 provisioning 且 startRunId 是本次的),用户中途点了
//   「停止」/「删除」就让路,**绝不**把用户的停止盖回 running(cancel-must-not-be-overwritten)。

const USER_ID = "default-user";
/** 停在 provisioning 超过这么久还没人推进(进程重启把后台编排带走了)⇒ 允许再启动一次,不然永远 409。 */
const STALE_PROVISIONING_MS = 30 * 60 * 1000;
/** 「这条任务仍是本次启动在管」:status 还是 provisioning,且 startRunId 是本次写进去的。 */
const OWNED_BY_THIS_START = "#s = :prov AND realtimeConfig.startRunId = :rid";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const cid = getCorrelationId(req);

  // 取任务 + 资源级 RBAC(editor+)
  const { Item: task } = await docClient.send(
    new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId: params.id } })
  );
  if (!task) return apiError("同步任务不存在", 404, { code: "NOT_FOUND", correlationId: cid });
  const ctx = await guardResourceAccess(req, task, "editor");
  if (ctx instanceof NextResponse) return ctx;

  // + DMS 扩展:DMS 通道支持 full(普通全量 full-load)/ incremental・realtime(full-load-and-cdc)。
  // 迁移类型由同步模式派生。realtime 任务后端已强制 channel=dms;full/incremental 经前端选 DMS 通道路由至此。
  if (task.channel !== "dms") {
    return apiError("该任务非 DMS 通道,请用对应入口启动", 400, { code: "VALIDATION_FAILED", correlationId: cid });
  }
  // 🔴 原则 3:DMS 是主控区里的托管通道(HomeOnlyReason:
  // dms-bootstrap-home;复制实例/角色只有 home 那套 env),尚未逐区。非 home 章任务在这里跑 =
  // 拿主控区的 DMS 去拉别区的源、写主控区数仓 —— 数据当场出境。如实拒,DMS target 化归后续包。
  if (!boundToHomeOnly(task)) {
    return apiError(
      `该任务绑定在执行环境 ${bindingTargets(task as { targets?: unknown; targetId?: unknown }).join(" / ")},` +
        `而 DMS 实时通道尚未逐区下推(目前只在主控区提供)—— 已拒绝启动,不会替它在主控区跑`,
      409,
      { code: "CHANNEL_NOT_PUSHED_DOWN", correlationId: cid }
    );
  }
  const migrationType: "full-load" | "full-load-and-cdc" = task.syncMode === "full" ? "full-load" : "full-load-and-cdc";
  // 实时基建未部署时明确报错(门控栈未拉起)。
  // 复制实例 ARN 不再靠静态 env——改为运行时按稳定 id(bgp-dms)发现,根治 destroy/recreate 后的
  // ARN 漂移;发现失败即说明实时栈未拉起/已止血销毁,快速返回 503。
  if (!process.env.DMS_ROLE_ARN) {
    return apiError("实时基建未就绪:请先部署 BgpRealtimeStack(-c enable-realtime=1)", 503, {
      code: "UPSTREAM_ERROR",
      correlationId: cid,
    });
  }
  // 🔴 ①:这里只**看一眼**(实例缺就发起懒创建、立刻回当前状态),不在请求里等它 available。
  let instanceStatus = "";
  try {
    instanceStatus = (await probeReplicationInstance()).status;
  } catch (e: any) {
    return apiError(`实时基建未就绪:${String(e?.message || e)}`, 503, {
      code: "UPSTREAM_ERROR",
      correlationId: cid,
    });
  }
  if (REPLICATION_INSTANCE_BROKEN_STATUSES.includes(instanceStatus)) {
    return apiError(`实时基建未就绪:DMS 复制实例状态异常:${instanceStatus}`, 503, {
      code: "UPSTREAM_ERROR",
      correlationId: cid,
    });
  }
  const instanceCold = instanceStatus !== "available";

  // 源库凭证/库名/主机:任务自身字段优先;否则从关联数据源(datasourceId)解析。
  // 创建流程(SyncTaskModal)只存 datasourceId,不冗余存 secret/database/host,故此处必须能回退解析,
  // 否则任何经 UI 正常创建的实时任务都拿不到源库连接信息而启动失败。
  let sourceSecretArn = task.sourceSecretArn || task.secretArn;
  let schemaName = task.sourceDatabase || task.schemaName || "";
  let sourceHost = task.sourceHost || "";
  let sourcePort = task.sourcePort || 3306;
  if ((!sourceSecretArn || !schemaName || !sourceHost) && task.datasourceId) {
    const { Item: ds } = await docClient.send(
      new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: task.datasourceId } })
    );
    if (ds) {
      sourceSecretArn = sourceSecretArn || ds.secretArn;
      schemaName = schemaName || ds.database || "";
      sourceHost = sourceHost || ds.host || "";
      sourcePort = ds.port || sourcePort;
    }
  }
  const tableName = (task.sourceTables && task.sourceTables[0]) || task.tableName || "%";
  const stagingBucket = process.env.GENBI_MEMORY_BUCKET || `bgp-datalake-${process.env.AWS_ACCOUNT_ID || ""}`;
  const redshiftHost = process.env.REDSHIFT_HOST || "";
  const dmsRoleArn = process.env.DMS_ROLE_ARN!;

  // 源库连接信息缺失则明确报错(而非进后台编排后才失败)。
  if (!sourceSecretArn || !schemaName || !sourceHost) {
    return apiError("任务缺少源库信息(secret/database/host),请确认已正确选择数据源", 400, {
      code: "VALIDATION_FAILED",
      correlationId: cid,
    });
  }

  // 写一条运行记录到 bgp-task-runs(让详情页"运行历史"Tab + 顶部统计对实时任务也有数据;
  // 实时是常驻通道,这条记录代表"启动编排"这一次运行,含编排步骤日志与复制任务 ARN)。
  // runId 同时充当本次启动的**所有权标记**(写进 realtimeConfig.startRunId)。
  const runId = ulid();
  const startedAt = new Date().toISOString();

  // DMS 编排(建用户/schema/角色关联/endpoints/连通性测试/启动)耗时数十秒到数分钟,远超 HTTP/CloudFront
  // 超时。生产级做法:**异步 fire-and-forget**——立即返回 202 provisioning,后台编排并把进度/
  // 终态(running/error + 错误信息)写回任务;前端轮询 /realtime-status 获取结果。
  // 走唯一写通道(条件写)。
  // 🔴 这是**后台 fire-and-forget** 的写回:从这里发起到真正写回之间,用户完全可能已经把任务删了
  //   ⇒ 盲 Update 会把它凭空造回来(一条没名字、删不掉的残行)。
  // 🔴 每一笔都带「仍是本次启动在管」的条件 —— 用户中途「停止」/「删除」/ 另一次启动接管后,
  //   本条编排的回写一律落空(返回 superseded),绝不盖掉别人的状态。
  const writeOwned = async (status: string, extra: Record<string, unknown> = {}): Promise<"owned" | "superseded"> => {
    try {
      const r = await updateSyncTaskIfExists({
        taskId: params.id,
        UpdateExpression: "SET #s = :s, realtimeConfig = :rc, updatedAt = :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": status,
          ":rc": { target: "redshift", startRunId: runId, ...extra },
          ":now": new Date().toISOString(),
          ":prov": "provisioning",
          ":rid": runId,
        },
        onlyIf: OWNED_BY_THIS_START,
      });
      return r.ok ? "owned" : "superseded";
    } catch (e) {
      // 凭证 / 限流之类:不知道归属,按原来的语义继续(只记日志),不把基建抖动当成「被接管」。
      logger.error("realtime.task.update.failed", e, { correlationId: cid, taskId: params.id });
      return "owned";
    }
  };

  // 🔴 ②:把任务置 provisioning 的这一笔就是「单飞」守卫 —— 条件写:行在、且**不是**一条还新鲜的
  //   provisioning。条件不成立 ⇒ 409,不起第二条编排。(读出来再判不行:读与写之间就是并发窗口。)
  const claim = await updateSyncTaskIfExists({
    taskId: params.id,
    UpdateExpression: "SET #s = :s, realtimeConfig = :rc, updatedAt = :now",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ":s": "provisioning",
      ":rc": { target: "redshift", startRunId: runId, ...(instanceCold ? { phase: "replication-instance-creating" } : {}) },
      ":now": startedAt,
      ":staleBefore": new Date(Date.now() - STALE_PROVISIONING_MS).toISOString(),
    },
    onlyIf: "attribute_not_exists(#s) OR #s <> :s OR attribute_not_exists(updatedAt) OR updatedAt < :staleBefore",
  });
  if (!claim.ok) {
    if (claim.miss === "gone") return apiError("同步任务不存在", 404, { code: "NOT_FOUND", correlationId: cid });
    return apiError(
      "该任务正在启动中(复制通道在建;首次使用含创建复制实例,约 10–15 分钟),这次没有再发一次启动 —— " +
        "请等它结束;要中止就点「停止」。若它长时间停在「启动中」,先「停止」再重新「启动」即可",
      409,
      { code: "START_IN_PROGRESS", correlationId: cid }
    );
  }

  // 同 zero-etl:刻意保留"同 runId 反复 Put 推进状态"的存量语义。
  const writeRun = (status: string, extra: Record<string, unknown> = {}) =>
    putRunRecord({
      taskId: params.id, runId, taskType: "sync", status, startedAt, triggeredBy: "manual",
      stamp: resolveRunStamp(task),
      extra: { channel: "dms", metrics: { rowsRead: 0, rowsWritten: 0 }, ...extra },
    }).catch((e) => logger.error("realtime.run.write.failed", e, { correlationId: cid, taskId: params.id }));

  // 落一条 running 运行记录(立即可在"运行历史"看到本次启动)。
  // 关闭本任务此前残留的 running 运行记录(常驻通道重启/后台轮询中断会累积多条 running,与 zero-etl 同处理)。
  try {
    await settleRunningRuns({ taskId: params.id, status: "stopped", set: { finishedAt: startedAt }, stamp: resolveRunStamp(task) });
  } catch { /* best-effort */ }
  const firstStep = instanceCold
    ? "[编排] DMS 同步启动已受理;复制实例首次创建中(约 10–15 分钟),就绪后再建复制通道(endpoints/复制任务)..."
    : "[编排] DMS 同步启动已受理,准备复制通道(endpoints/复制任务)...";
  await writeRun("running", { logs: [firstStep] });

  void (async () => {
    const steps: string[] = [firstStep];
    const log = (m: string) => { steps.push(`[${new Date().toISOString().slice(11, 19)}] ${m}`); };
    const bail = (step: string) => {
      // 用户已「停止」/「删除」,或另一次启动接管了 ⇒ 本条编排让路:不写状态、不写运行记录(停止路由已把 run 收口)。
      logger.info("realtime.start.superseded", { correlationId: cid, taskId: params.id, step });
    };
    let started = false;
    try {
      logger.info("realtime.start.begin", { correlationId: cid, taskId: params.id, schemaName, tableName, instanceCold });
      // ①:等复制实例就位挪到这里(首次 10–15 分钟,预算 30 分钟);等完先确认任务还归我管。
      await getReplicationInstanceArn(); log("✓ DMS 复制实例就绪");
      if ((await writeOwned("provisioning")) === "superseded") return bail("instance-ready");
      const targetSecretArn = await ensureRedshiftDmsUser(redshiftHost); log("✓ 目标 Redshift 专用用户/密钥就绪(dms_ingest)"); // 踩坑④
      await ensureTargetSchema(schemaName); log(`✓ 目标 schema 就绪: ${schemaName}`); // 踩坑⑤
      await ensureRoleAssociatedToNamespace(dmsRoleArn); log("✓ DMS COPY 角色已关联 Redshift namespace"); // 踩坑⑥
      const input = { taskId: params.id, sourceSecretArn, sourceHost, sourcePort, targetSecretArn, schemaName, tableName };
      const sourceArn = await ensureSourceEndpoint(input); log("✓ 源 endpoint 就绪(MySQL)");
      const targetArn = await ensureTargetEndpoint(input, stagingBucket); log("✓ 目标 endpoint 就绪(Redshift)");
      // 要建复制任务了 —— 这是第一件「删任务时得连带撤掉」的真资源,建之前再确认一次归属。
      if ((await writeOwned("provisioning", { sourceEndpointArn: sourceArn, targetEndpointArn: targetArn })) === "superseded") {
        return bail("before-task-create");
      }
      const taskArn = await ensureReplicationTask(input, sourceArn, targetArn, migrationType, task.dmsSettings); log(`✓ DMS 复制任务就绪(${migrationType})`);

      // 新建任务返回后仍处 creating,须等其进入 ready/stopped 才能启动(否则 invalid state)。
      const taskState = await waitTaskStartable(taskArn); log(`✓ 复制任务状态: ${taskState}`);

      // 连通性测试是异步的,轮询等两端 successful 再启动。Redshift 首次连接(冷启动)较慢,
      // 窗口放宽到 ~5min(30×10s);testEndpoints 内部只对未成功端点触发测试,状态单调收敛。
      let lastConn = { source: "unknown", target: "unknown" };
      for (let i = 0; i < 30; i++) {
        lastConn = await testEndpoints(sourceArn, targetArn);
        if (lastConn.source === "successful" && lastConn.target === "successful") {
          // 要让复制任务真跑起来(开始搬数据、开始计费)—— 启动前最后一次确认归属:
          // 用户在这几分钟里点了「停止」,就不许再把它启动起来。
          if ((await writeOwned("provisioning", { replicationTaskArn: taskArn, sourceEndpointArn: sourceArn, targetEndpointArn: targetArn })) === "superseded") {
            return bail("before-start");
          }
          await startReplication(taskArn);
          started = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10000));
      }
      log(started ? "✓ 两端连通性通过,DMS 复制任务已启动(running)" : `✗ 连通性超时:源=${lastConn.source} 目标=${lastConn.target}`);
      const owned = await writeOwned(started ? "running" : "error", {
        replicationTaskArn: taskArn, sourceEndpointArn: sourceArn, targetEndpointArn: targetArn,
        ...(started ? {} : { error: `endpoint 连通性测试未通过(超时):源=${lastConn.source} 目标=${lastConn.target}` }),
      });
      if (owned === "superseded") {
        // 归属检查与 StartReplicationTask 之间那几秒里用户点了「停止」:行已是 stopped,但复制任务被我们
        // 刚刚启动了 ⇒ 把它停回去(用户的停止必须赢),不许留一条「行说已停、DMS 在跑」的孤儿。
        if (started) {
          const td = await teardownSyncChannel(task as never, { purge: false, waitMs: 20_000 })
            .catch((e) => ({ channel: "dms", hardFailures: [{ what: "teardownSyncChannel", error: String((e as Error)?.message ?? e).slice(0, 240) }], softFailures: [] }));
          logger.warn("realtime.start.superseded_after_start", { correlationId: cid, taskId: params.id, teardown: td });
        }
        return bail("final");
      }
      await writeRun(started ? "running" : "failed", {
        replicationTaskArn: taskArn, logs: steps,
        ...(started ? {} : { error: `连通性超时:源=${lastConn.source} 目标=${lastConn.target}` }),
      });
      logger.info("realtime.start.done", { correlationId: cid, taskId: params.id, started, conn: lastConn });
    } catch (e: any) {
      logger.error("realtime.start.failed", e, { correlationId: cid, taskId: params.id });
      log(`✗ 编排失败: ${String(e?.message || e).slice(0, 200)}`);
      // 同样只在仍归我管时才写 error —— 别把用户已经「停止」的任务又翻成「异常」。
      if ((await writeOwned("error", { error: String(e?.message || e).slice(0, 300) })) === "superseded") return bail("failed");
      await writeRun("failed", { error: String(e?.message || e).slice(0, 300), logs: steps });
    }
  })();

  recordAudit(req, "sync.start-realtime", {
    resourceType: "sync", resourceId: params.id, detail: { name: task.name, schemaName, tableName, instanceCold },
  }).catch(() => {});

  // 202:已受理,后台编排中;前端轮询 /realtime-status。
  const message = instanceCold
    ? `DMS 同步编排已启动(${migrationType}):首次使用需先创建复制实例(约 10–15 分钟),期间任务显示「启动中」,可随时「停止」;稍后在详情页/监控查看状态`
    : `DMS 同步编排已启动(${migrationType}),稍后在详情页/监控查看状态`;
  return apiOk({ taskId: params.id, status: "provisioning", migrationType, instanceCold, message }, 202);
}
