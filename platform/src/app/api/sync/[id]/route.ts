export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { guardResourceAccess } from "@/lib/projects/guard";
import { snapshotVersion } from "@/lib/versions/version-service";
import { apiError } from "@/lib/api-response";
import { validateSyncWriteFields, overwritePreflight, OVERWRITE_CONFIRM_CODE, OVERWRITE_CONFIRM_KIND, overwriteConfirmMessage, writesS3Tables, clearsWholeTable } from "@/lib/sync/target-table-guard";
import { recordAudit } from "@/lib/audit";
// 停/删共用**同一个**下线作者
import { teardownSyncChannel, teardownFailureMessage, teardownIsRetryable } from "@/lib/sync/teardown";
// 最后一条 DMS 任务删掉之后,懒创建的复制实例就没人引用了 ⇒ 登记一条持久回收作业(实例上仍有任务时作业自己收口为「在用」)
import { enqueueDmsInstanceReclaim, type DmsReclaimEnqueueResult } from "@/lib/realtime/dms-instance-reclaim-job";
import { REPLICATION_INSTANCE_ID } from "@/lib/realtime/dms-service";
import { getTarget } from "@/lib/exec-env/registry";
import { updateSyncTaskIfExists } from "@/lib/sync/task-write";
// 新字段的合法形态(唯一作者)
import { validateSyncCapabilityFields, whereOf, syncTaskUsesRunDate } from "@/lib/sync/run-vars";
// 写 S3 Tables 的任务 Glue 版本必须 ≥ 5.1(唯一作者;按「改完之后」的整条任务判)
import { validateSyncGlueVersion } from "@/lib/sync/glue-version";
// 自带 Table Bucket 的准入(保存与启动同一份判定)
import { tableBucketSaveRejection } from "@/lib/sync/table-bucket";
import { getProvider, isDataSourceType } from "@/lib/datasource-spi/registry";
// 保存也要让 Glue 脚本跟上定义(作业已存在时)—— 与启动路径同一个作者 ensureGlueSyncJob;收养同一规则
import { ensureGlueSyncJob } from "@/lib/sync/start-run";
import { adoptExistingTargetsOnce } from "@/lib/sync/foreign-guard-adoption";
import { bindingTargets } from "@/lib/exec-env/data-plane-target";
// 换源时读新源的章(与启动路由的跨区判法同一个作者)
import { datasourceOwnerTarget } from "@/lib/datasource/placement-shared";
import type { DataSource } from "@/types/datasource";

const USER_ID = "default-user";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId: params.id } })
  );
  if (!Item) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const guard = await guardResourceAccess(req, Item, "viewer");
  if (guard instanceof NextResponse) return guard;
  return NextResponse.json(Item);
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item: current } = await docClient.send(
    new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId: params.id } })
  );
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const guard = await guardResourceAccess(req, current, "editor");
  if (guard instanceof NextResponse) return guard;

  const body = await req.json();
  // Tenancy attributes are immutable from this endpoint.
  delete body.userId;
  delete body.projectId;
  delete body.createdBy;
  delete body.createdBySub;
  // SYNC-FIX: 编辑弹窗回填整条 task 后提交,body 里会带 updatedAt / taskId / createdAt 等。
  // 而本路由自己用 `SET ..., #upd = :now` 写 updatedAt,若 body 也含 updatedAt 就与之
  // 路径重叠 → DynamoDB `Two document paths overlap: [updatedAt] / [...]` 整个 PUT 500。
  // 故剔除 key 与路由自管字段(它们本就不该由客户端覆盖)。
  delete body.updatedAt;
  delete body.taskId;
  delete body.createdAt;
  // 既有目标收养的时间戳只有服务端写(lib/sync/foreign-guard-adoption.ts);客户端传了一律剔除。
  delete body.foreignGuardAdoptedAt;
  // 实时(CDC)任务通道恒为 DMS——编辑时同样兜底(取本次或现存 syncMode 判定)。
  const effectiveSyncMode = body.syncMode ?? current.syncMode;
  if (effectiveSyncMode === "realtime") body.channel = "dms";
  // B7-FIX: 同 POST,规整增量字段 incrementalConfig.{field,startValue} → 顶层 incrementalColumn/Value。
  if (effectiveSyncMode === "incremental" && body.incrementalConfig) {
    if (body.incrementalColumn == null && body.incrementalConfig.field) body.incrementalColumn = body.incrementalConfig.field;
    if (body.incrementalValue == null && body.incrementalConfig.startValue != null) body.incrementalValue = body.incrementalConfig.startValue;
  }
  if (Object.keys(body).length === 0) return NextResponse.json({ error: "无更新字段" }, { status: 400 });
  // 🔴 生产上线批次 A:按「改完之后」的整条任务校验写模式 + 确认清单,并提前告知会被整表清空的非平台表。
  const merged = { ...current, ...body } as Record<string, unknown>;
  const writeReject = validateSyncWriteFields(merged);
  if (writeReject) return apiError(writeReject, 400, { code: "VALIDATION_FAILED" });
  // 改目标类型 / 改 Glue 版本之后的整条任务,写 S3 Tables 就必须是 Glue 5.1+
  const glueVersionReject = validateSyncGlueVersion(merged);
  if (glueVersionReject) return apiError(glueVersionReject, 400, { code: "VALIDATION_FAILED" });
  // 按「改完之后」的整条任务校验新字段;用到过滤条件 / 表名模板时
  //   才读数据源取范式(只支持 JDBC),不用这两样的保存不多一次读。
  //   🔴 只在这次**改了**过滤条件或源表清单时才按范式拒:存量任务里那条从前不生效的过滤条件(老向导允许在
  //   非 JDBC 源上填),不因一次与它无关的编辑就保存失败(与向导 paradigmForCapabilityCheck 同一口径;
  //   真要运行时,生成脚本那一侧仍会如实拒)。
  const touchedSource = (body.whereClause !== undefined && whereOf(body) !== whereOf(current)) ||
    (body.sourceTables !== undefined && JSON.stringify(body.sourceTables) !== JSON.stringify(current.sourceTables));
  let paradigm: string | undefined;
  let dsRow: Record<string, unknown> | undefined;
  // (用户 2026-10-15 反馈 ②「同步任务切换个数据源,没法保存」;…7698 页面探针坐实)—— 换了数据源
  //   ① 新源必须存在(404);② 新源的章必须 ∈ 任务绑定的执行环境(同步任务跟随源所在的区运行;跨区换源 = 409 CROSS_REGION_SOURCE,与启动路由同一条铁律);
  //   ③ sourceDatabase 跟着新源走 —— 编辑表单用整条记录预填,PUT 回来的是**旧库名**,原样落库就成了「数据源指 sys 库、任务记着 ecommerce」。
  //   这里读到的新源行下面复用(范式校验 / 预检 / 刷脚本),不多读一次。
  const dsSwitched = body.datasourceId !== undefined && String(body.datasourceId) !== String(current.datasourceId ?? "");
  if (dsSwitched) {
    dsRow = (await docClient.send(new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: String(body.datasourceId) } }))).Item as Record<string, unknown> | undefined;
    if (!dsRow) return apiError(`数据源 ${String(body.datasourceId)} 不存在,任务未改`, 404, { code: "NOT_FOUND" });
    // 与启动路由同一条判法(datasourceOwnerTarget ∈ bindingTargets(任务行))、同一个错误码:源与任务必须在同一执行环境
    const dsOwner = datasourceOwnerTarget(dsRow);
    const bound = bindingTargets(current as { targets?: unknown; targetId?: unknown });
    if (!bound.includes(dsOwner)) {
      return apiError(
        `禁止跨区取数:新数据源在执行环境 ${dsOwner},而本任务绑定在 ${bound.join(" / ")} —— 同步 = 读源写仓,源与任务必须在同一执行环境,` +
          `这是设计规则、永久拒绝(请在新源所在的区新建同步任务);任务未改`,
        409,
        { code: "CROSS_REGION_SOURCE", detail: { datasourceOwner: dsOwner, bound } }
      );
    }
    const newDb = typeof dsRow.database === "string" ? dsRow.database.trim() : "";
    if (newDb) { body.sourceDatabase = newDb; merged.sourceDatabase = newDb; }
  }
  // S3 Tables 目标的提前告知要知道 namespace;任务没自带时取数据源库名 ⇒ 这种情形也读一次数据源行。
  //   (不整表清空 / 不写 S3 / 自带 namespace 的保存仍然不多读。)
  const needDsForS3 = writesS3Tables(merged as never) && clearsWholeTable(merged as never) &&
    !(typeof (merged.s3Config as { namespace?: unknown } | undefined)?.namespace === "string" && (merged.s3Config as { namespace: string }).namespace);
  if (!dsRow && ((touchedSource && (whereOf(merged) || syncTaskUsesRunDate(merged))) || needDsForS3)) {
    dsRow = (await docClient.send(new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: String(merged.datasourceId || "") } }))).Item as Record<string, unknown> | undefined;
  }
  if (touchedSource && (whereOf(merged) || syncTaskUsesRunDate(merged))) {
    const dsType = typeof dsRow?.type === "string" ? dsRow.type : "";
    paradigm = isDataSourceType(dsType) ? getProvider(dsType).capabilities.paradigm : undefined;
  }
  const capReject = validateSyncCapabilityFields(merged, paradigm);
  if (capReject) return apiError(capReject, 400, { code: "VALIDATION_FAILED" });
  if (body.overwriteConfirmedTables !== undefined) body.overwriteConfirmedTables = merged.overwriteConfirmedTables;
  // 按「改完之后」的整条任务判自带 Table Bucket 的准入(与 POST / 启动守卫同一份):非主控区只许平台表桶或已登记外部表桶,否则 400 指路
  if (writesS3Tables(merged as never)) {
    const bucketReject = await tableBucketSaveRejection(merged as never);
    if (bucketReject) return apiError(bucketReject.message, bucketReject.status, { code: bucketReject.code });
  }
  // **作业已存在**的任务(跑过至少一次)—— 原来保存只写 DDB,脚本只在平台启动时重生成,而调度载体只起旧作业
  //   ⇒ 改了 WHERE / 分区 / 合并键 / 逐表确认之后定时运行一直跑旧脚本(真环境 2026-10-12 坐实)。
  //   ① 先做一次既有目标收养(与启动路径同一规则、幂等;放在预检之前 —— 否则守卫上线前的老任务一保存就被伪 409 挡住);
  //   ② 预检通过后、**落库之前**重生成脚本并更新作业(ensureGlueSyncJob,唯一作者);刷新不成 ⇒ 不落库、如实报错,
  //      不留下「记录是新的、脚本是旧的」。没跑过的任务(没有作业)不碰:脚本在它第一次启动时生成。
  const jobExists = typeof current.glueJobName === "string" && !!current.glueJobName;
  const refreshTid = jobExists ? bindingTargets(merged as { targets?: unknown; targetId?: unknown })[0] : undefined;
  if (jobExists && refreshTid && !dsRow) {
    dsRow = (await docClient.send(new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: String(merged.datasourceId || "") } }))).Item as Record<string, unknown> | undefined;
  }
  if (jobExists && refreshTid && dsRow) {
    await adoptExistingTargetsOnce(merged as never, params.id, dsRow as { database?: unknown });
  }
  const pre = await overwritePreflight(merged as never, { ds: dsRow as { database?: unknown } | undefined });
  if (pre.kind === "needs-confirm") {
    return apiError(overwriteConfirmMessage(pre.tables), 409, { code: OVERWRITE_CONFIRM_CODE, detail: { kind: OVERWRITE_CONFIRM_KIND, tables: pre.tables } });
  }
  if (jobExists && refreshTid && dsRow) {
    let ensured: Awaited<ReturnType<typeof ensureGlueSyncJob>>;
    try {
      ensured = await ensureGlueSyncJob({ task: merged, taskId: params.id, ds: dsRow as unknown as DataSource, tid: refreshTid });
    } catch (e) {
      return apiError(
        `保存未生效:同步脚本刷新失败(${String((e as Error)?.message ?? e).slice(0, 300)});任务定义未改,请稍后重试`,
        502, { code: "UPSTREAM_ERROR" },
      );
    }
    if (!ensured.ok) return apiError(ensured.message, ensured.status, { code: ensured.code === "CONFLICT" ? "CONFLICT" : "VALIDATION_FAILED" });
  }
  const fields = Object.keys(body); // 在换源重算 sourceDatabase 之后取键(否则新库名不落库)
  const expr = fields.map((k, i) => `#f${i} = :v${i}`).join(", ");
  const names = Object.fromEntries(fields.map((k, i) => [`#f${i}`, k]));
  const values = Object.fromEntries(fields.map((k, i) => [`:v${i}`, body[k]]));

  // 走唯一写通道(条件写)。
  // 🔴 上面那道 Get + 404 是主防线;这里兜的是并发窗口(强读之后、写之前那一瞬被别人删掉)。
  //   少了条件写,「保存」就会把一条已删的任务**凭空造回来**,而且只带本次提交的那几个字段。
  const { ok, Attributes } = await updateSyncTaskIfExists({
    taskId: params.id,
    UpdateExpression: `SET ${expr}, #upd = :now`,
    ExpressionAttributeNames: { ...names, "#upd": "updatedAt" },
    ExpressionAttributeValues: { ...values, ":now": new Date().toISOString() },
    ReturnValues: "ALL_NEW",
  });
  // 行在这一瞬被删掉 ⇒ 如实回 404(**不许**建行,也不许假装保存成功)
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await snapshotVersion("sync", params.id, Attributes as any, guard.identity.username, "保存").catch(() => {});
  return NextResponse.json(Attributes);
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId: params.id } })
  );
  if (!Item) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const guard = await guardResourceAccess(req, Item, "editor");
  if (guard instanceof NextResponse) return guard;
  // 🔴🔴 **先把后台通道撤掉,再删行**。改动前这里**只删 DDB 行**:DMS 复制任务 / Glue 作业 /
  //   Zero-ETL 集成继续存在 —— 继续搬数据、继续计费,而它们的 identifier/ARN 随行消失
  //   ⇒ 平台再也定位不到(多法域下 = 停不下来的跨境数据流动)。与同一条不变量
  //   **撤不下来就不许删记录**(留着行,用户还能再点一次)。
  const td = await teardownSyncChannel(Item as never, { purge: true });
  if (td.hardFailures.length) {
    // 🔴 「还在停的路上」⇒ **409 可重试**;「撤不下来」⇒ 502。两者都**不删行**。
    const retryable = teardownIsRetryable(td);
    return apiError(
      teardownFailureMessage(td, retryable
        ? "任务**未删除** —— 通道**正在停的路上**,过几十秒再点一次「删除」即可(先删行会留下无法再下线的孤儿)。"
        : "任务**未删除** —— 先删行会让那条通道变成再也无法从平台停掉的孤儿(它仍在搬数据并计费)。请重试。"),
      retryable ? 409 : 502,
      retryable
        ? { code: "TEARDOWN_IN_PROGRESS", detail: { teardown: td, retryable: true } }
        : { code: "UPSTREAM_ERROR", detail: { teardown: td } }
    );
  }
  // DMS 通道:复制任务已撤 ⇒ 复制实例可能再无任务引用 ⇒ 入队回收作业;落点取任务自己绑定的执行区(实例就建在那个区),不默认主控区。
  // 入队失败不挡删除(实例仍被成本页 R1 建议盯着),但要如实进响应与审计,不许静默。
  let reclaim: DmsReclaimEnqueueResult | { enqueued: false; error: string } | undefined;
  if ((Item as { channel?: string }).channel === "dms") {
    try {
      const [boundTargetId] = bindingTargets(Item as { targets?: unknown; targetId?: unknown });
      const target = boundTargetId ? await getTarget(boundTargetId) : null;
      if (!target) throw new Error("任务没有绑定可解析的执行区 ⇒ 不知道复制实例在哪个区");
      reclaim = await enqueueDmsInstanceReclaim({
        targetId: target.targetId, region: target.region, instanceId: REPLICATION_INSTANCE_ID,
        reason: "task-deleted", createdBy: `user:${guard.identity.username}`,
      });
    } catch (e) {
      reclaim = { enqueued: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  }
  await docClient.send(
    new DeleteCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId: params.id } })
  );
  recordAudit(req, "sync.delete", { resourceType: "sync", resourceId: params.id, detail: { name: (Item as { name?: string }).name, teardown: td, ...(reclaim ? { instanceReclaim: reclaim } : {}) } }).catch(() => {});
  return NextResponse.json({ success: true, teardown: td, ...(reclaim ? { instanceReclaim: reclaim } : {}) });
}
