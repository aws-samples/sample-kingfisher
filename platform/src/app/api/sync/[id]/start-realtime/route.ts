export const dynamic = "force-dynamic";
import { resourceBusyResponse, assertResourcesFree } from "@/lib/long-ops/guard";
import { resourceKey } from "@/lib/long-ops/kinds";
import { CEILING_MS, LongOpHttpError } from "@/lib/long-ops/store";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { apiOk, apiError } from "@/lib/api-response";
import { guardResourceAccess } from "@/lib/projects/guard";
// 落点 = 任务绑定的那个执行区(唯一作者);该区不具备条件时的拒因也由它给
import { resolveDmsPlace, DmsPlaceUnavailable, type DmsPlace } from "@/lib/realtime/dms-place";
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
// 「禁止跨区取数」与批同步启动同一个判法
import { crossRegionSource } from "@/lib/sync/cross-region-source";
// task-runs 唯一写通道(50 SPEC §6 S10)。
import { putRunRecord, settleRunningRuns, resolveRunStamp } from "@/lib/monitor/run-records";
import { recordAudit } from "@/lib/audit";
import { getCorrelationId, logger } from "@/lib/observability/logger";
// 同步任务行的唯一状态写通道(条件写,不 upsert 幽灵行)
import { updateSyncTaskIfExists } from "@/lib/sync/task-write";
import {
  ensureSourceEndpoint,
  alignSourceEndpoint,
  ensureTargetEndpoint,
  ensureReplicationTask,
  startReplication,
  testEndpoints,
  latestConnectionVerdict,
  getReplicationInstanceArn,
  probeReplicationInstance,
  REPLICATION_INSTANCE_BROKEN_STATUSES,
  waitTaskStartable,
  describeEndpointConnections,
  type EndpointConnectionSnapshot,
} from "@/lib/realtime/dms-service";
// 停 / 删 / 「启动被接管后停回去」共用**同一个**下线作者
import { teardownSyncChannel, TEARDOWN_LONG_OP_WAIT_MS } from "@/lib/sync/teardown";
// 编排失败时复制实例可能刚建出来却没有任务引用 ⇒ 登记回收作业(作业按「零复制任务」事实决定,实例在用就收口为「在用」)
import { enqueueDmsInstanceReclaim } from "@/lib/realtime/dms-instance-reclaim-job";
import {
  ensureRedshiftDmsUser,
  ensureTargetSchema,
  ensureRoleAssociatedToNamespace,
} from "@/lib/realtime/redshift-target";
// 目标 schema 名(= 源库名)的校验唯一作者:受控 DDL 通道在后台编排里还会再判一次,这里只是把同一个结论提前到请求里
import { assertDmsIngestSchema } from "@/lib/exec-env/admin-ddl-request";

// 实时同步启动入口(syncMode=realtime / channel=dms)。
//
// 与 Glue 批同步的 /start 解耦(关注点分离):本路由专门编排 DMS CDC,调用 R5 固化的幂等服务层。
// 编排顺序固化了 R3/R4 实测的 7 个踩坑解法(目标准备 → endpoints → 任务 → 启动)。
//
// 生产级:editor+ RBAC、审计、幂等(全程 ensure*)、结构化日志带 correlationId、错误不吞。
// 不创建常驻基建(子网组 / 安全组 / 访问角色由主控区实时栈或该执行区的 DMS 栈提供;复制实例懒创建)。
// 🔴 在哪个区做 = 任务绑定的执行区(`resolveDmsPlace`):复制实例、端点、复制任务、目标数仓、暂存桶、密钥全在该区,
//   主控区与执行区同一条路。该区还不具备条件 ⇒ 如实拒并指路,绝不替它在别的区跑。
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
/** 「停止 / 删除」受理后最久占着这条任务多久(长操作全局上限 + 终态写入的余量);过了它不再等,只按任务行判归属。 */
const TEARDOWN_IN_FLIGHT_WAIT_MS = CEILING_MS + 30_000;
const TEARDOWN_IN_FLIGHT_POLL_MS = 2_000;

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
  // 这条任务正被「停止 / 删除」长操作占着(它们要等后台通道真正到终态,可能是分钟级)⇒ 409,等它结束再操作
  const busy = await resourceBusyResponse([resourceKey("sync-task", params.id)]);
  if (busy) return busy;

  // + DMS 扩展:DMS 通道支持 full(普通全量 full-load)/ incremental・realtime(full-load-and-cdc)。
  // 迁移类型由同步模式派生。realtime 任务后端已强制 channel=dms;full/incremental 经前端选 DMS 通道路由至此。
  if (task.channel !== "dms") {
    return apiError("该任务非 DMS 通道,请用对应入口启动", 400, { code: "VALIDATION_FAILED", correlationId: cid });
  }
  const migrationType: "full-load" | "full-load-and-cdc" = task.syncMode === "full" ? "full-load" : "full-load-and-cdc";
  // 落点:任务绑定的那个执行区。该区的实时基建没就位(主控区没部署实时栈 / 执行区没装组件、升级后还没重新部署、当前不可用)
  // ⇒ 503 并点名缺什么、去哪补;任务绑了多个区(坏数据行)⇒ 409。🔴 没有「解析不出来就用主控区」这条路。
  let place: DmsPlace;
  try {
    place = await resolveDmsPlace(task as { targets?: unknown; targetId?: unknown });
  } catch (e) {
    if (e instanceof DmsPlaceUnavailable) {
      const multi = e.reason === "multi-binding";
      return apiError(e.message, e.httpStatus, {
        code: multi ? "TARGET_PUSHDOWN_UNAVAILABLE" : "UPSTREAM_ERROR",
        correlationId: cid,
        ...(multi ? { detail: { bound: bindingTargets(task as { targets?: unknown; targetId?: unknown }) } } : {}),
      });
    }
    return apiError(`实时基建未就绪:${String((e as Error)?.message || e).slice(0, 300)}`, 503, {
      code: "UPSTREAM_ERROR",
      correlationId: cid,
    });
  }

  // 源库凭证/库名/主机:任务自身字段优先;否则从关联数据源(datasourceId)解析。
  // 创建流程(SyncTaskModal)只存 datasourceId,不冗余存 secret/database/host,故此处必须能回退解析,
  // 否则任何经 UI 正常创建的实时任务都拿不到源库连接信息而启动失败。
  let sourceSecretArn = task.sourceSecretArn || task.secretArn;
  let schemaName = task.sourceDatabase || task.schemaName || "";
  let sourceHost = task.sourceHost || "";
  let sourcePort = task.sourcePort || 3306;
  if (task.datasourceId) {
    const { Item: ds } = await docClient.send(
      new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: task.datasourceId } })
    );
    if (ds) {
      // 🔴 禁止跨区取数(与批同步启动同一个判法、同一个错误码):通道建在任务绑定的区,源也必须在那个区 ——
      //   源在别的区 = 拿这个区的复制实例去拉另一个区的库。这不是过渡态,设计如此、永久拒;零副作用(还没写任何状态)。
      const cross = crossRegionSource(task as { targets?: unknown; targetId?: unknown }, ds as Record<string, unknown>);
      if (cross) {
        return apiError(
          `禁止跨区取数:数据源在执行环境 ${cross.datasourceOwner},而任务绑定在 ${cross.bound.join(" / ")} —— 同步 = 读源写仓,` +
            `源与任务必须在同一执行环境(数据不离开它所在的区),这是设计规则、永久拒绝(请在源所在的区建同步任务)`,
          409,
          { code: "CROSS_REGION_SOURCE", correlationId: cid, detail: cross }
        );
      }
      // 连接信息:任务自身字段优先,缺的才从数据源行补(三项齐全的任务连端口也用自己的,与改动前一致)
      if (!sourceSecretArn || !schemaName || !sourceHost) sourcePort = ds.port || sourcePort;
      sourceSecretArn = sourceSecretArn || ds.secretArn;
      schemaName = schemaName || ds.database || "";
      sourceHost = sourceHost || ds.host || "";
    }
  }
  const tableName = (task.sourceTables && task.sourceTables[0]) || task.tableName || "%";

  // 源库连接信息缺失则明确报错(而非进后台编排后才失败)。
  if (!sourceSecretArn || !schemaName || !sourceHost) {
    return apiError("任务缺少源库信息(secret/database/host),请确认已正确选择数据源", 400, {
      code: "VALIDATION_FAILED",
      correlationId: cid,
    });
  }

  // DMS 把源库名当作目标数仓里的 schema 名。平台保留的名字 / 不是普通标识符的库名,受控 DDL 通道不收 ⇒ 现在就拒:
  //   这是纯校验,不该等复制实例建好(10–15 分钟、按小时计费)之后才在后台编排的「建目标 schema」一步失败。
  try {
    assertDmsIngestSchema(schemaName);
  } catch (e) {
    return apiError(String((e as Error)?.message ?? e).slice(0, 400), 400, { code: "VALIDATION_FAILED", correlationId: cid });
  }

  // 🔴 ①:这里只**看一眼**(实例缺就发起懒创建、立刻回当前状态),不在请求里等它 available。
  //   放在全部「会拒」的检查之后:懒创建是真副作用(一台按小时计费的实例),被拒的请求不该留下它。
  let instanceStatus = "";
  try {
    instanceStatus = (await probeReplicationInstance(place)).status;
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
  // 旧实例正在删除(空闲回收刚发起,或有人手工删):照常受理 —— 后台编排先等它删完再重建,比单纯冷建更久,话要说在前头。
  const instanceRecycling = instanceStatus === "deleting";

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
  //   本条编排的回写一律落空,绝不盖掉别人的状态。落空分两种:行还在(superseded:被停止 / 被接管)与行已删(gone)——
  //   后者意味着再没有任何记录指向这条通道,编排要把自己建出来的复制任务撤掉(见下面的 yieldTo)。
  // 🔴 用户的「停止 / 删除」一经受理(长操作占住这条任务)就该赢,而任务行要等通道真正撤完才变。这中间编排若照常往前推,
  //   就与下线抢同一条复制任务 —— 2026-11-16 真环境「启动后 9 秒点删除」:删除刚把复制任务删掉,编排同一秒去启动它被 DMS 拒
  //   (cannot be started, invalid state)⇒ 把用户自己删掉的这次运行记成了「失败」(监控页多一条失败,盯全部任务的失败告警规则跟着误报)。
  //   ⇒ 每个关口(含失败分支)先等占着这条任务的停止 / 删除结束,再按任务行判归属:行没了 / 被停止 ⇒ 让路;
  //   它没做成(记录没动)⇒ 编排照原样继续,真失败照实记。
  const waitOutTeardown = async (): Promise<void> => {
    const key = [resourceKey("sync-task", params.id)];
    const deadline = Date.now() + TEARDOWN_IN_FLIGHT_WAIT_MS;
    for (;;) {
      try {
        await assertResourcesFree(key);
        return;
      } catch (e) {
        if (!(e instanceof LongOpHttpError)) {
          // 读不到租约(凭证 / 限流)≠ 有人占:不在这里卡住编排,交给下面按任务行判
          logger.error("realtime.start.lease-read.failed", e, { correlationId: cid, taskId: params.id });
          return;
        }
      }
      if (Date.now() >= deadline) {
        logger.warn("realtime.start.teardown-wait.expired", { correlationId: cid, taskId: params.id, waitedMs: TEARDOWN_IN_FLIGHT_WAIT_MS });
        return;
      }
      await new Promise((r) => setTimeout(r, TEARDOWN_IN_FLIGHT_POLL_MS));
    }
  };
  const writeOwned = async (status: string, extra: Record<string, unknown> = {}): Promise<"owned" | "superseded" | "gone"> => {
    await waitOutTeardown();
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
      if (r.ok) return "owned";
      return r.miss === "gone" ? "gone" : "superseded";
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
      // 章按任务真正跑的那个区显式盖:同步任务的区在 targets[] 里,不传第二个参数会盖成主控区
      //(2026-11-20 页面实测:执行区的 DMS 运行在任务监控里记成了主控区)。
      stamp: resolveRunStamp(task, place.targetId),
      extra: { channel: "dms", metrics: { rowsRead: 0, rowsWritten: 0 }, ...extra },
    }).catch((e) => logger.error("realtime.run.write.failed", e, { correlationId: cid, taskId: params.id }));

  // 落一条 running 运行记录(立即可在"运行历史"看到本次启动)。
  // 关闭本任务此前残留的 running 运行记录(常驻通道重启/后台轮询中断会累积多条 running,与 zero-etl 同处理)。
  try {
    await settleRunningRuns({ taskId: params.id, status: "stopped", set: { finishedAt: startedAt }, stamp: resolveRunStamp(task, place.targetId) });
  } catch { /* best-effort */ }
  const firstStep = instanceRecycling
    ? "[编排] DMS 同步启动已受理;复制实例正在回收,回收完成后自动重建(约 15–25 分钟),就绪后再建复制通道(endpoints/复制任务)..."
    : instanceCold
    ? "[编排] DMS 同步启动已受理;复制实例首次创建中(约 10–15 分钟),就绪后再建复制通道(endpoints/复制任务)..."
    : "[编排] DMS 同步启动已受理,准备复制通道(endpoints/复制任务)...";
  await writeRun("running", { logs: [firstStep] });

  void (async () => {
    const steps: string[] = [firstStep];
    const log = (m: string) => { steps.push(`[${new Date().toISOString().slice(11, 19)}] ${m}`); };
    let started = false;
    /** 复制任务已由本次编排建出 / 接手(从这一刻起,让路时要看它还留在 DMS 里会不会成孤儿)。 */
    let replicationTaskReady = false;
    // 用户已「停止」/「删除」,或另一次启动接管了 ⇒ 本条编排让路:不写状态、不写运行记录(停止 / 删除已把 run 收口)。
    // (停止 / 删除还在进行时,归属检查会先等它结束 —— 见 waitOutTeardown;所以走到这里时任务行已经是它们写完之后的样子。)
    // 让路前先把自己留在 DMS 里的东西收干净:
    //   · 行已删(gone):删除那一刻复制任务还没建出来(或正被本编排启动),删除带不走它 ⇒ 这里撤掉 ——
    //     否则留下一条没有任何记录指向的复制任务(启动了的还在搬数据),复制实例也因为「上面还有任务」永远回收不了;
    //   · 行还在(用户停止 / 被接管)而本编排已把复制任务启动:把它停回去(用户的停止必须赢),不许留「行说已停、DMS 在跑」。
    //   等待预算与「停止 / 删除」同值:刚启动的复制任务要先等它跑起来才能停,不是二十秒的事。
    const yieldTo = async (step: string, why: "superseded" | "gone") => {
      if (replicationTaskReady && (why === "gone" || started)) {
        const td = await teardownSyncChannel(task as never, { purge: why === "gone", waitMs: TEARDOWN_LONG_OP_WAIT_MS })
          .catch((e) => ({ channel: "dms", hardFailures: [{ what: "teardownSyncChannel", error: String((e as Error)?.message ?? e).slice(0, 240) }], softFailures: [] }));
        logger.warn("realtime.start.yield_cleanup", { correlationId: cid, taskId: params.id, step, why, started, teardown: td });
      }
      // 行已删:本编排在这之前可能已经建了端点(甚至复制任务)。删除那一刻登记的回收作业也许已经收口 ⇒ 再登记一次
      //   (同一台实例已有在途作业时原样返回),由它按事实清掉这条任务留在该区的端点、并在实例空闲后回收实例。
      if (why === "gone") {
        await enqueueDmsInstanceReclaim({ targetId: place.targetId, region: place.region, instanceId: place.instanceId, reason: "task-deleted", createdBy: "system:realtime-start" })
          .catch((e2) => logger.error("realtime.instance-reclaim.enqueue-failed", e2, { correlationId: cid, taskId: params.id, step }));
      }
      logger.info("realtime.start.superseded", { correlationId: cid, taskId: params.id, step, why });
    };
    try {
      logger.info("realtime.start.begin", { correlationId: cid, taskId: params.id, targetId: place.targetId, region: place.region, schemaName, tableName, instanceCold });
      // ①:等复制实例就位挪到这里(首次 10–15 分钟,预算 30 分钟);等完先确认任务还归我管。
      await getReplicationInstanceArn(place); log(`✓ DMS 复制实例就绪(${place.instanceId} · ${place.region})`);
      const afterInstance = await writeOwned("provisioning");
      if (afterInstance !== "owned") return yieldTo("instance-ready", afterInstance);
      let ingest = await ensureRedshiftDmsUser(place); log(`✓ 目标 Redshift 专用用户/密钥就绪(dms_ingest${ingest.provisioned ? "" : ",沿用已有密钥"})`); // 踩坑④
      await ensureTargetSchema(place, schemaName); log(`✓ 目标 schema 就绪: ${schemaName}`); // 踩坑⑤
      await ensureRoleAssociatedToNamespace(place); log("✓ DMS COPY 角色已关联 Redshift namespace"); // 踩坑⑥
      const input = { taskId: params.id, sourceSecretArn, sourceHost, sourcePort, targetSecretArn: ingest.secretId, schemaName, tableName };
      const source = await ensureSourceEndpoint(place, input); log("✓ 源 endpoint 就绪(MySQL)");
      const sourceArn = source.arn;
      const targetArn = await ensureTargetEndpoint(place, input); log("✓ 目标 endpoint 就绪(Redshift)");
      // 要建复制任务了 —— 这是第一件「删任务时得连带撤掉」的真资源,建之前再确认一次归属。
      const beforeCreate = await writeOwned("provisioning", { sourceEndpointArn: sourceArn, targetEndpointArn: targetArn });
      if (beforeCreate !== "owned") return yieldTo("before-task-create", beforeCreate);
      const taskArn = await ensureReplicationTask(place, input, sourceArn, targetArn, migrationType, task.dmsSettings); log(`✓ DMS 复制任务就绪(${migrationType})`);
      replicationTaskReady = true;

      // 新建任务返回后仍处 creating,须等其进入 ready/stopped 才能启动(否则 invalid state)。
      const taskState = await waitTaskStartable(place, taskArn); log(`✓ 复制任务状态: ${taskState}`);

      // 沿用的源端点(停止后再启动 / 上一次启动失败后重试):按数据源的现值对齐一次再测 ——
      //   这期间用户改过数据源的主机 / 口令的话,不能还拿旧配置去连(改动前只能删任务重建)。
      if (source.reused) {
        await alignSourceEndpoint(place, input, sourceArn);
        log("✓ 源 endpoint 已按数据源当前的连接配置更新,重新测试连通性");
      }

      // 连通性测试是异步的,轮询等两端 successful 再启动。Redshift 首次连接(冷启动)较慢,
      // 窗口放宽到 ~5min(30×10s);testEndpoints 内部只对未成功端点触发测试,状态单调收敛。
      let lastConn: EndpointConnectionSnapshot = { source: "unknown", target: "unknown" };
      /** 每一端最近一次出了结果的测试结论(超时的时候用它说清「为什么连不上」;最后一轮多半正停在测试中) */
      let verdict: EndpointConnectionSnapshot = lastConn;
      /** 目标端测试失败后的「重设摄入用户口令」本次启动只做一次(有界) */
      let reprovisioned = false;
      for (let i = 0; i < 30; i++) {
        lastConn = await testEndpoints(place, sourceArn, targetArn);
        verdict = latestConnectionVerdict(verdict, lastConn);
        // 目标端连不上、而密钥是沿用的(数仓重建过 / 用户被删 / 口令与密钥对不上)或 DMS 明说是认证失败 ⇒ 重设口令并覆盖密钥,下一轮重测。
        //   别的原因(网络不通之类)换口令没用,不折腾:同区其它正在跑的通道下次重连也要读这份密钥。
        //   第一轮读到的「失败」是这次启动之前留下的旧结论(这次还没测过),不据此动口令;本轮已经触发重测,下一轮起的失败才算数。
        if (i > 0 && lastConn.target === "failed" && !reprovisioned
          && (!ingest.provisioned || /authenticat|password/i.test(lastConn.targetFailure ?? ""))) {
          reprovisioned = true;
          ingest = await ensureRedshiftDmsUser(place, { rotate: true });
          log("↻ 目标端连通性测试失败:已重设目标专用用户的口令并更新密钥,重新测试");
          continue;
        }
        if (lastConn.source === "successful" && lastConn.target === "successful") {
          // 要让复制任务真跑起来(开始搬数据、开始计费)—— 启动前最后一次确认归属:
          // 用户在这几分钟里点了「停止」,就不许再把它启动起来。
          const beforeStart = await writeOwned("provisioning", { replicationTaskArn: taskArn, sourceEndpointArn: sourceArn, targetEndpointArn: targetArn });
          if (beforeStart !== "owned") return yieldTo("before-start", beforeStart);
          await startReplication(place, taskArn);
          started = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10000));
      }
      // 连不上时把 DMS 给的失败原文带出来(只有它知道是网络不通、口令不对还是库不存在)
      const connText = describeEndpointConnections(started ? lastConn : verdict);
      log(started ? "✓ 两端连通性通过,DMS 复制任务已启动(running)" : `✗ 连通性超时:${connText}`);
      const owned = await writeOwned(started ? "running" : "error", {
        replicationTaskArn: taskArn, sourceEndpointArn: sourceArn, targetEndpointArn: targetArn,
        ...(started ? {} : { error: `endpoint 连通性测试未通过(超时):${connText}`.slice(0, 600) }),
      });
      // 归属检查与 StartReplicationTask 之间那几秒里用户点了「停止」/「删除」:复制任务被我们刚刚启动了 ⇒ 让路时停回去 / 撤掉
      if (owned !== "owned") return yieldTo("final", owned);
      await writeRun(started ? "running" : "failed", {
        replicationTaskArn: taskArn, logs: steps,
        ...(started ? {} : { error: `连通性超时:${connText}`.slice(0, 600) }),
      });
      logger.info("realtime.start.done", { correlationId: cid, taskId: params.id, started, conn: { source: lastConn.source, target: lastConn.target } });
    } catch (e: any) {
      logger.error("realtime.start.failed", e, { correlationId: cid, taskId: params.id });
      log(`✗ 编排失败: ${String(e?.message || e).slice(0, 200)}`);
      // 同样只在仍归我管时才写 error —— 别把用户已经「停止」的任务又翻成「异常」。
      const onFailure = await writeOwned("error", { error: String(e?.message || e).slice(0, 300) });
      if (onFailure !== "owned") return yieldTo("failed", onFailure);
      await writeRun("failed", { error: String(e?.message || e).slice(0, 300), logs: steps });
      // 落点就是这次启动用的那一个(实例建在那个区)
      await enqueueDmsInstanceReclaim({ targetId: place.targetId, region: place.region, instanceId: place.instanceId, reason: "start-failed", createdBy: "system:realtime-start" })
        .catch((e2) => logger.error("realtime.instance-reclaim.enqueue-failed", e2, { correlationId: cid, taskId: params.id }));
    }
  })();

  recordAudit(req, "sync.start-realtime", {
    resourceType: "sync", resourceId: params.id, detail: { name: task.name, schemaName, tableName, instanceCold, targetId: place.targetId, region: place.region },
  }).catch(() => {});

  // 202:已受理,后台编排中;前端轮询 /realtime-status。
  const message = instanceRecycling
    ? `DMS 同步编排已启动(${migrationType}):空闲的复制实例正在回收,回收完成后会自动重建(约 15–25 分钟),期间任务显示「启动中」,可随时「停止」;稍后在详情页/监控查看状态`
    : instanceCold
    ? `DMS 同步编排已启动(${migrationType}):首次使用需先创建复制实例(约 10–15 分钟),期间任务显示「启动中」,可随时「停止」;稍后在详情页/监控查看状态`
    : `DMS 同步编排已启动(${migrationType}),稍后在详情页/监控查看状态`;
  return apiOk({ taskId: params.id, status: "provisioning", migrationType, instanceCold, message }, 202);
}
