export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { PutCommand, ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { syncWorkRejection } from "@/lib/sync/task-shape";
import { validateSyncWriteFields, overwritePreflight, OVERWRITE_CONFIRM_CODE, OVERWRITE_CONFIRM_KIND, overwriteConfirmMessage, writesS3Tables } from "@/lib/sync/target-table-guard";
// @kf-batch 56-B127-exec-env-own-table-bucket —— 自带 Table Bucket 的准入(保存与启动同一份判定)
import { tableBucketSaveRejection } from "@/lib/sync/table-bucket";
import { apiOk, apiError } from "@/lib/api-response";
import { generateSyncLineage } from "@/lib/governance/lineage-service";
import { recordAudit } from "@/lib/audit";
import { requireProject, projectFilter, getActiveEnv, envFilter } from "@/lib/projects/guard";
import { snapshotVersion } from "@/lib/versions/version-service";
import { reconcileSyncTask } from "@/lib/sync/reconcile";
// @kf-batch 50-WP4ter-coverage —— 执行范围(50 SPEC §2.6;工单 SC-2)。🔴 只认 URL 的 `?scope=`,
// 过滤走 `bindingTargets` 三级回落(`targets` → `targetId` → home):存量同步任务没有区域维,
// 而它们**确实**只在主控区跑过(start 路由的 region 是 `process.env.AWS_REGION`)⇒ 归 home 是真话,
// 不是兜底猜测。非主控区因此为空,空态由页面说清「为什么这个区还不能建」(执行下推 = WP-7)。
import { filterRowsByScope, requireScope } from "@/lib/exec-env/scope";
// @kf-batch 50-WP4ter-coverage —— 新建行盖区章的**唯一作者**(章从数据源落点导出,不收调用方传的区)
import { bindingForNewSyncTask } from "@/lib/exec-env/definition-binding";
import { ulid } from "ulid";
// @kf-batch 37-sync-capability —— 序 37 新字段的合法形态(唯一作者)
import { validateSyncCapabilityFields } from "@/lib/sync/run-vars";
// 序 38 B-69:写 S3 Tables 的任务 Glue 版本必须 ≥ 5.1(唯一作者)
import { validateSyncGlueVersion } from "@/lib/sync/glue-version";
import { getProvider, isDataSourceType } from "@/lib/datasource-spi/registry";

const USER_ID = "default-user";

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireProject(req, "viewer");
    if (ctx instanceof NextResponse) return ctx;
    // @kf-batch 50-WP4ter-coverage
    const scope = await requireScope(req, ctx.projectId);
    if (scope instanceof NextResponse) return scope;

    const p = req.nextUrl.searchParams;
    const name = p.get("name") || "";
    const status = p.get("status") || "";
    const scheduleEnabled = p.get("scheduleEnabled") || "";
    const channel = p.get("channel") || "";
    const syncMode = p.get("syncMode") || "";
    const targetType = p.get("targetType") || "";

    const pf = projectFilter(ctx.projectId);
    const filterParts: string[] = ["userId = :uid", pf.clause];
    const attrNames: Record<string, string> = {};
    const attrValues: Record<string, any> = { ":uid": USER_ID, ...pf.values };
    const ef = envFilter(getActiveEnv(req));
    filterParts.push(ef.clause);
    attrNames["#env"] = "env";
    Object.assign(attrValues, ef.values);

    if (status) { filterParts.push("#st = :st"); attrNames["#st"] = "status"; attrValues[":st"] = status; }
    if (name) { filterParts.push("contains(#nm, :nm)"); attrNames["#nm"] = "name"; attrValues[":nm"] = name; }
    if (channel) { filterParts.push("channel = :ch"); attrValues[":ch"] = channel; }
    if (syncMode) { filterParts.push("syncMode = :sm"); attrValues[":sm"] = syncMode; }
    if (targetType) { filterParts.push("targetType = :tt"); attrValues[":tt"] = targetType; }
    if (scheduleEnabled === "true") { filterParts.push("scheduleEnabled = :se"); attrValues[":se"] = true; }
    else if (scheduleEnabled === "false") { filterParts.push("(attribute_not_exists(scheduleEnabled) OR scheduleEnabled = :se)"); attrValues[":se"] = false; }

    const { Items = [] } = await docClient.send(new ScanCommand({
      TableName: TABLES.SYNC_TASKS,
      FilterExpression: filterParts.join(" AND "),
      ...(Object.keys(attrNames).length > 0 ? { ExpressionAttributeNames: attrNames } : {}),
      ExpressionAttributeValues: attrValues,
    }));
    // 读时对账:对 glue 通道卡 running 的任务查真实 Glue JobRun 并回写,杜绝列表假 running。
    const reconciled = await Promise.all(Items.map((it: any) => reconcileSyncTask(it).catch(() => it)));
    // @kf-batch 50-WP4ter-coverage —— 🔴 **在对账之后**过滤(与 `/api/etl-jobs` 同序):
    // 对账会回写 DDB,提前过滤等于「切了区就不再对账别区的任务」= 改了副作用而不只是改了视图。
    const rows = filterRowsByScope(reconciled as Array<Record<string, unknown>>, scope);

    // @kf-batch 50-B09-carrier-drift —— 「定时调度载体的定义是不是最新的」(B-09)
    // 🔴 显式开关 `?withDrift=1`(**没有静默默认**);查不动如实回 `unknown`,**绝不省略**
    //   ——「没这个字段」与「字段是 ok」在呈现面上必须是两回事。
    // 🔴 走**单一作者** `syncCarrierDrift`:同步载体的比对**必须带 ledger**
    //   (少传它,重新生成出来的 `ledger_task_*` 会退回缺省 ⇒ 每个同步载体都误报落后 ——
    //   那正是 B-01 的现场:字段在定义里,而值是缺省的)。
    if (req.nextUrl.searchParams.get("withDrift") === "1") {
      const { syncCarrierDrift } = await import("@/lib/sync/schedule-carrier");
      await Promise.all(rows.map(async (r) => {
        const dep = (r as { deployments?: Record<string, unknown> }).deployments;
        const targets = dep && typeof dep === "object" ? Object.keys(dep) : [];
        if (!targets.length) return; // 没有载体 ⇒ 不谈「落后」
        const out: Record<string, { state: string; reason?: string }> = {};
        await Promise.all(targets.map(async (t) => {
          try {
            const d = await syncCarrierDrift(r as never, t);
            out[t] = { state: d.state, ...(d.reason ? { reason: d.reason } : {}) };
          } catch (e) {
            out[t] = { state: "unknown", reason: String((e as Error)?.message ?? e).slice(0, 200) };
          }
        }));
        (r as Record<string, unknown>).carrierDrift = out;
      }));
    }
    return apiOk(rows);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}

export async function POST(req: NextRequest) {
  const ctx = await requireProject(req, "editor");
  if (ctx instanceof NextResponse) return ctx;

  const body = await req.json();
  const now = new Date().toISOString();
  // 校验 targetType(合法值:s3-tables / redshift / both)。非法值必须显式拒绝——否则 Glue 脚本生成器
  // 的 `writeS3 = targetType==="s3-tables"` / `writeRedshift = targetType==="redshift"` 都为 false,
  // 会静默生成"只读不写"的空操作脚本、job 却 SUCCEEDED(假成功,数据零落地)。见根因:传 "s3table"
  // (少连字符)时曾扫出此坑。宁可建任务就 400,不可让用户跑出一个假成功的空同步。
  const VALID_TARGET_TYPES = ["s3-tables", "redshift", "both"];
  if (body.targetType !== undefined && !VALID_TARGET_TYPES.includes(body.targetType)) {
    return apiError(`非法 targetType「${body.targetType}」(合法值:${VALID_TARGET_TYPES.join(" / ")})`, 400, { code: "VALIDATION_FAILED" });
  }
  // 模块 31: 实时(CDC)任务的通道恒为 DMS(唯一实现)——后端兜底,防止前端推荐/交互把 channel 误存为 glue。
  if (body.syncMode === "realtime") body.channel = "dms";
  // @kf-batch 50-WP4ter-coverage —— 🔴 **先取数据源**(章要从它的落点导出),同一份行下面复用给血缘,
  // 不为了盖章多读一次(两次读会得到两个说法)。
  const dsRow = body.datasourceId
    ? (await docClient.send(new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: body.datasourceId } }))).Item
    : undefined;
  // 🔴 生产上线批次 A(prodA 段页面实测):页面向导从不传 sourceDatabase ⇒ 自 09-17 加了下面那道门起,
  //   **从页面新建同步任务一律 400**。源库名的真值本来就是数据源自己的库名(执行体取的就是
  //   `ds.database || task.sourceDatabase`)⇒ 缺省时按同一优先级从数据源取,不是猜。
  if (!(typeof body.sourceDatabase === "string" && body.sourceDatabase.trim())) {
    const dsDb = typeof dsRow?.database === "string" ? dsRow.database.trim() : "";
    if (dsDb) body.sourceDatabase = dsDb;
  }
  // @kf-batch 50-WP24b-vacuous-sync —— 🔴 空表清单的任务**不许落库**(它注定空转却报成功)
  //   B-123:「从哪读」按数据源范式判(S3 / DynamoDB 源没有库名,定位在连接袋里)⇒ 数据源行一起交给单一作者
  const workReject = syncWorkRejection(body as { sourceDatabase?: unknown; sourceTables?: unknown }, dsRow);
  if (workReject) return apiError(workReject, 400, { code: "VALIDATION_FAILED" });
  // 🔴 生产上线批次 A:写模式必填(不再静默缺省成会整表清空的 overwrite)+ 确认清单形态校验。
  const writeReject = validateSyncWriteFields(body);
  if (writeReject) return apiError(writeReject, 400, { code: "VALIDATION_FAILED" });
  // 序 38 B-69:写 S3 Tables 的 Glue 作业只能是 5.1+(5.0 建得出来、跑到写表才报 Invalid S3 URI)
  const glueVersionReject = validateSyncGlueVersion(body);
  if (glueVersionReject) return apiError(glueVersionReject, 400, { code: "VALIDATION_FAILED" });
  // @kf-batch 37-sync-capability —— 过滤条件 / 表名模板 / 派生列 / 分区覆盖 / 空结果开关(不带这些字段 ⇒ 恒放行)
  const dsType = typeof dsRow?.type === "string" ? dsRow.type : "";
  const capReject = validateSyncCapabilityFields(body, isDataSourceType(dsType) ? getProvider(dsType).capabilities.paradigm : undefined);
  if (capReject) return apiError(capReject, 400, { code: "VALIDATION_FAILED" });
  // B7-FIX: 向导把增量字段存在 incrementalConfig.{field,startValue},但 Glue 脚本生成器读
  // 顶层 task.incrementalColumn/incrementalValue。两者名字不一致 → 增量谓词为空、退化成全量。
  // 此处统一规整:把 incrementalConfig 映射到脚本期望的顶层字段(已有顶层值则不覆盖)。
  if (body.syncMode === "incremental" && body.incrementalConfig) {
    if (body.incrementalColumn == null && body.incrementalConfig.field) body.incrementalColumn = body.incrementalConfig.field;
    if (body.incrementalValue == null && body.incrementalConfig.startValue != null) body.incrementalValue = body.incrementalConfig.startValue;
  }
  const item = {
    ...body,
    ...bindingForNewSyncTask(dsRow as Record<string, unknown> | undefined),
    userId: USER_ID,
    taskId: ulid(),
    projectId: ctx.projectId,
    env: getActiveEnv(req),
    createdBy: ctx.identity.username,
    createdBySub: ctx.identity.sub,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
  // B-127:自带 Table Bucket 的准入在**保存**时就判(启动守卫同一份判定):非主控区只许平台表桶或「系统设置 → 数据湖外部表桶」
  //   已登记的桶,否则 400 并指路去登记(改动前保存能成、启动才 409,登记了也仍 409)。主控区不变。
  if (writesS3Tables(item as never)) {
    const bucketReject = await tableBucketSaveRejection(item as never);
    if (bucketReject) return apiError(bucketReject.message, bucketReject.status, { code: "VALIDATION_FAILED" });
  }
  // 🔴 生产上线批次 A:这个任务一跑会整表清空「已存在且不是平台建的」表 ⇒ 先列给用户逐表确认(409),
  //   不落库。探不到(数仓暂不可达)不拦 —— 防线在 Glue 脚本清表前那道守卫(target-table-guard 规则 ②)。
  //   序 37 B-60:S3 Tables 目标也探(namespace 缺省取数据源库名 ⇒ 把数据源行传进去,探不到如实 unknown)。
  const pre = await overwritePreflight(item as never, { ds: dsRow as { database?: unknown } | undefined });
  if (pre.kind === "needs-confirm") {
    return apiError(overwriteConfirmMessage(pre.tables), 409, { code: OVERWRITE_CONFIRM_CODE, detail: { kind: OVERWRITE_CONFIRM_KIND, tables: pre.tables } });
  }
  try {
    await docClient.send(new PutCommand({ TableName: TABLES.SYNC_TASKS, Item: item }));
    await snapshotVersion("sync", item.taskId, item, ctx.identity.username, "创建").catch(() => {});

    // Auto-generate lineage (GOV-02)。@kf-batch 50-WP4ter-coverage —— 复用上面那次读,不再读第二遍。
    if (dsRow) generateSyncLineage(item, dsRow).catch(() => {});

    recordAudit(req, "sync.create", {
      resourceType: "sync",
      resourceId: item.taskId,
      detail: { name: item.name, channel: item.channel, targetType: item.targetType },
    }).catch(() => {});

    return apiOk(item, 201);
  } catch (e: any) {
    return apiError(e.message, 500);
  }
}
