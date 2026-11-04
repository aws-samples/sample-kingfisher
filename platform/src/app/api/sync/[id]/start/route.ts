export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
// 落点唯一作者(binding 解析)+ 按区客户端工厂(单例退役)
// glue 通道的「解析落点 → 建作业 → 启动 → 写 run → 轮询 → OM 推送」已原样搬到
//   lib/sync/start-run.ts(补数中心要走同一条启动路径;route.ts 只能导出 HTTP 方法)。本路由只留入口判定。
import { bindingTargets, TargetBindingRejected } from "@/lib/exec-env/data-plane-target";
import { homeRegion } from "@/lib/exec-env/target-clients";
import { datasourceOwnerTarget } from "@/lib/datasource/placement-shared";
import { apiOk, apiError } from "@/lib/api-response";
import { ulid } from "ulid";
import type { DataSource } from "@/types/datasource";
import { recordAudit } from "@/lib/audit";
import { guardResourceAccess } from "@/lib/projects/guard";
import { syncWorkRejection } from "@/lib/sync/task-shape";
// 🔴 反向卡:章说在哪跑,就必须真在那儿跑(否则 fail-closed)
import { assertDefinitionRunsHere, DefinitionBindingMismatch } from "@/lib/exec-env/definition-binding";
import { HOME_TARGET_ID, isHome } from "@/lib/exec-env/target-id";
// task-runs 唯一写通道(50 SPEC §6 S10)。
import { putRunRecord, settleRunningRuns, resolveRunStamp } from "@/lib/monitor/run-records";
// 同步任务行的唯一状态写通道(条件写,不 upsert 幽灵行)
import { updateSyncTaskIfExists } from "@/lib/sync/task-write";
import { startGlueSyncRun } from "@/lib/sync/start-run";
import { isValidDs, toDs } from "@/lib/etl/run-params";
import {
  zeroEtlNames,
  ensureZeroEtlWarehouse,
  ensureNamespaceResourcePolicy,
  buildZeroEtlDataFilter,
  ensureIntegration,
  getIntegrationStatus,
  ensureDestinationDatabase,
} from "@/lib/realtime/zeroetl-service";

const USER_ID = "default-user";
// 原来钉死主控区的模块级 region/glue/s3/s3tables
// 四个单例已退役:任务的章在哪个区,客户端就按那个区建(*ClientFor,按 region 缓存)。
// 🔴 别把单例加回来:模块级 env 客户端会让非 home 章的任务「看起来正常地」在主控区建作业/建表桶,
// 界面、审计、成本三处一致地说谎(跨法域下即数据出境)。

// 可选请求体 `{ runDate?: "YYYY-MM-DD" }`(手动运行指定业务日期)。
// 🔴 空请求体 = 现在所有页面(列表 / 详情 / 监控页重试)的发法 ⇒ 必须照常工作、行为与改动前相同。
// 回 string = 业务日期;undefined = 没指定;{ error } = 请求体不合法(400,零副作用)。
async function readRunDate(req: NextRequest): Promise<string | undefined | { error: string }> {
  const raw = await req.text().catch(() => "");
  if (!raw.trim()) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { error: "请求体不是合法的 JSON(可以不带请求体;指定业务日期时请求体为对象,字段 runDate 取 YYYY-MM-DD)" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "请求体应为对象(字段 runDate 取 YYYY-MM-DD)" };
  const rd = (body as { runDate?: unknown }).runDate;
  if (rd === undefined || rd === null || rd === "") return undefined;
  // 🔴 `isValidDs` 只看形状 + Date.parse,而 V8 的 Date.parse 会把 2026-02-30 顺延成 3 月 2 日 ⇒ 再做一次往返,
  //    不存在的日子在这里就拒(否则会一路传到 Glue 脚本里才炸)。
  if (typeof rd !== "string" || !isValidDs(rd) || toDs(new Date(`${rd}T00:00:00Z`)) !== rd) {
    return { error: `业务日期格式应为 YYYY-MM-DD 且是真实存在的日子:${JSON.stringify(rd)}` };
  }
  return rd;
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  // 先读请求体:非法就在碰任何资源之前拒(零副作用)。
  const runDateIn = await readRunDate(req);
  if (runDateIn && typeof runDateIn === "object") return apiError(runDateIn.error, 400, { code: "VALIDATION_FAILED" });
  const runDate = runDateIn;
  try {
    const { Item: task } = await docClient.send(
      new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId: params.id } })
    );
    if (!task) return apiError("任务不存在", 404);

    const guard = await guardResourceAccess(req, task, "editor");
    if (guard instanceof NextResponse) return guard;
    // 章 = 唯一执行落点(建任务时由
    // bindingForNewSyncTask 从数据源的 ownerTargetId 派生,单一作者)。执行链整体按它下推:
    // 章在哪个区,Glue 作业/脚本/staging/数仓写入/日志/run 台账/审计就全在那个区。
    const bound = bindingTargets(task as { targets?: unknown; targetId?: unknown });
    const tid = bound[0];
    // 反向卡保留(立的):章与真正要用的落点不一致就拒。落点现在从章导出、结构上恒一致;
    // 这道卡挡的是将来任何人把「落点」改成第二个来源(以及多章的坏数据行)。
    assertDefinitionRunsHere(task, "同步任务", tid);

    const { Item: ds } = await docClient.send(
      new GetCommand({ TableName: TABLES.DATASOURCES, Key: { userId: USER_ID, datasourceId: task.datasourceId } })
    );
    if (!ds) return apiError("数据源不存在", 404);

    // 🔴 原则 2:**禁止跨区取数**(与编排/实时同一条铁律)。同步 = 读源写仓,源的落点章必须 ∈ 任务章;
    // 不一致 ⇒ 409 且零副作用(不建 Glue 作业、run 台账不新增)。这不是「未下推所限」的过渡态 ——
    // 源在 A 区、活在 B 区跑 = 数据出境,**设计如此,永久拒**(段 scq 据此改判)。
    // 存量源无章 = home(补维前所有源都在主控区可达,历史事实,与 bindingTargets 三级回落同一条理由)。
    // 读法收成一个(`datasourceOwnerTarget`,按 DATASOURCE_OWNER_TARGET_ATTR 读),
    //   OM 回填重放(源表 service)用的是同一个。
    const dsOwner = datasourceOwnerTarget(ds as Record<string, unknown>);
    if (!bound.includes(dsOwner)) {
      // 🔴 文案不做法务定性(「数据出境」等词只许 disclaimer.ts 一处定义),只说事实与规则。
      return apiError(
        `禁止跨区取数:数据源在执行环境 ${dsOwner},而任务绑定在 ${bound.join(" / ")} —— 同步 = 读源写仓,` +
          `源与任务必须在同一执行环境(数据不离开它所在的区),这是设计规则、永久拒绝(请在源所在的区建同步任务)`,
        409,
        { code: "CROSS_REGION_SOURCE", detail: { datasourceOwner: dsOwner, bound } }
      );
    }

    // 🔴 启动前再判一次「有没有活可干」:存量任务可能就是空的(建任务那道门是后加的),
    //   而空表清单的同步会**什么都不做却报 succeeded**(真环境实测:Glue 日志 `SYNC RESULTS: {}`、
    //   数仓里连表都没建,而任务是绿的)。空转成功比失败更坏:看板/审计全绿而什么都没发生。
    //   「从哪读」按数据源范式判(S3 / DynamoDB 源没有库名)⇒ 数据源行一起交给单一作者
    const workReject = syncWorkRejection(task as { sourceDatabase?: unknown; sourceTables?: unknown }, ds);
    if (workReject) return apiError(workReject, 400, { code: "VALIDATION_FAILED" });

    const channel = task.channel || "glue";
    // 🔴 原则 3:zero-etl 是主控区数仓里的托管集成(HomeOnlyReason: zeroetl-home-namespace),
    // 尚未逐区。非 home 章任务选它 ⇒ 如实拒,绝不替它在主控区跑(那会把该区的源数据复制进主控区数仓)。
    if (channel === "zero-etl" && !isHome(tid)) {
      return apiError(
        `该任务绑定在执行环境 ${tid},而 Zero-ETL 通道尚未逐区下推(托管集成目前只在主控区数仓提供)—— 已拒绝启动`,
        409,
        { code: "CHANNEL_NOT_PUSHED_DOWN", detail: { channel, bound } }
      );
    }
    // (Zero-ETL) — "增量同步"真·CDC 通道(托管集成,替代 Glue 假增量,修复 B6)。
    // 异步编排(集成激活耗时数十分钟,不依赖 Glue);dms 通道走专用 /start-realtime 入口(那边同样有原则 3 的通道卡)。
    if (channel === "zero-etl") {
      // Zero-ETL 是持续复制,没有「某一天」可言 ⇒ 指定业务日期如实拒,不静默忽略
      if (runDate) return apiError("Zero-ETL 是持续复制通道,不支持指定业务日期运行", 400, { code: "VALIDATION_FAILED" });
      return await startZeroEtl(req, task as any, ds as DataSource);
    }
    if (channel !== "glue") return apiError(`通道 ${channel} 请用对应入口启动(实时 CDC 走 start-realtime)`, 400);

    // 启动核心(唯一作者,补数中心走同一个函数)。三条可修的拒绝原样转回同一状态码 / code。
    const started = await startGlueSyncRun({
      task, taskId: params.id, ds: ds as DataSource, tid, dsOwner, triggeredBy: "manual", runDate,
    });
    if (!started.started) return apiError(started.message, started.status, started.code ? { code: started.code } : {});
    const { jobName, runId, jobRunId: JobRunId } = started;

    recordAudit(req, "sync.start", {
      resourceType: "sync",
      // 审计盖真落点(与执行用的是同一个解析结果)
      targetId: tid,
      resourceId: params.id,
      detail: { name: task.name, jobName, runId, ...(runDate ? { runDate } : {}) },
    }).catch(() => {});

    return apiOk({ channel: "glue", jobName, jobRunId: JobRunId, runId, ...(runDate ? { runDate } : {}) });
  } catch (err: any) {
    // 绑定/落点类拒绝是**可修的冲突**,不是服务端错误
    // 409 + 原话给用户(缺资源袋键 / workgroup 与描述符不一致 / 多章坏行),与 etl-jobs 路由同款。
    if (err instanceof DefinitionBindingMismatch || err instanceof TargetBindingRejected) {
      return apiError(err.message, 409, { code: "CONFLICT" });
    }
    return apiError(`启动失败: ${err.message}`, 500);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// (Zero-ETL) — "增量同步"真·CDC 启动编排(channel=zero-etl,修复 B6)。
//
// 与 Glue 批同步解耦:zero-etl 是【托管常驻复制】,语义=持续近实时同步(非"跑完即止")。
//  · 异步 fire-and-forget:立即返回 202 provisioning;集成激活耗时数十分钟,后台轮询推进。
//  · run 记录:写一条代表"启动编排"的运行(含编排步骤日志 + 集成 ARN),active 后置 running
//    且【不】自动转 stopped(常驻);停止任务时由 /stop 关闭(B10)。
//  · 详情页轮询 /zeroetl-status 获取集成状态/已复制行数;该端点幂等推进(进程重启可恢复)。
//  · 成本闭环:停止任务 = DeleteIntegration(见 /stop 路由)。
// ─────────────────────────────────────────────────────────────────────────────
async function startZeroEtl(req: NextRequest, task: any, ds: DataSource) {
  const taskId = task.taskId;

  // 校验:Zero-ETL 仅支持 MySQL/Aurora MySQL 源 → Redshift 目标,且仅【增量】(近实时 CDC,无纯全量)。
  if (!["mysql", "aurora-mysql"].includes(ds.type)) {
    return apiError("Zero-ETL 仅支持 MySQL / Aurora MySQL 源", 400);
  }
  if (task.syncMode !== "incremental") {
    return apiError("Zero-ETL 仅支持增量(近实时 CDC);全量请用 Glue 或 DMS 通道", 400);
  }
  const toRedshift = task.targetType === "redshift" || task.targetType === "both";
  if (!toRedshift) return apiError("Zero-ETL 仅支持 Redshift 目标", 400);
  const rdsInstanceId = ds.networkConfig?.rdsInstanceId;
  if (!rdsInstanceId) return apiError("数据源非 RDS 托管实例,无法建 Zero-ETL 集成(缺 rdsInstanceId)", 400);

  const accountId = process.env.AWS_ACCOUNT_ID || "";
  // zero-etl 只会在 home 跑(POST 里原则 3 的通道卡挡住非 home 章),
  // 这里如实用主控区(homeRegion 是该字面量的唯一作者),不是「按 target 解析」的漏改。
  const region = homeRegion();
  const sourceArn = `arn:aws:rds:${region}:${accountId}:db:${rdsInstanceId}`;
  const database = ds.database || task.sourceDatabase || "";
  const tables: string[] = task.sourceTables || [];
  if (!database) return apiError("数据源缺少库名(database),无法构造 Zero-ETL data-filter", 400);
  const { integrationName, destDb } = zeroEtlNames(taskId);

  const runId = ulid();
  const startedAt = new Date().toISOString();
  const steps: string[] = ["[编排] Zero-ETL 增量同步启动已受理,准备托管 CDC 集成..."];
  const log = (m: string) => { steps.push(`[${new Date().toISOString().slice(11, 19)}] ${m}`); };

  const updateTask = (status: string, extra: Record<string, unknown> = {}) => {
    const setExpr = "SET #s = :s, lastRunId = :r, updatedAt = :now" +
      (extra.integrationArn !== undefined ? ", integrationArn = :ia" : "") +
      (extra.zeroEtlConfig !== undefined ? ", zeroEtlConfig = :zc" : "") +
      (extra.error !== undefined ? ", zeroEtlError = :err" : "");
    // 健康推进(provisioning/running 且无 error)时清除上一次失败留下的陈旧错误,避免详情页误显示。
    const removeExpr = extra.error === undefined ? " REMOVE zeroEtlError" : "";
    // 🔴 zero-etl 的后台编排写回:从受理到写回是分钟级,
    //   期间用户完全可能把任务删了 ⇒ 盲写会把它凭空造回来。走唯一写通道(条件写)。
    //   🔴 这一处是闭合判据 ④ **当场抓出来的**:我手工列改点时漏了它 —— 正是「枚举一定漏第 N+1 个」。
    return updateSyncTaskIfExists({
      taskId,
      UpdateExpression: setExpr + removeExpr,
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": status, ":r": runId, ":now": new Date().toISOString(),
        ...(extra.integrationArn !== undefined ? { ":ia": extra.integrationArn } : {}),
        ...(extra.zeroEtlConfig !== undefined ? { ":zc": extra.zeroEtlConfig } : {}),
        ...(extra.error !== undefined ? { ":err": extra.error } : {}),
      },
    }).catch(() => {});
  };

  // 🔴 这里**刻意**保留"同一个 runId 反复 Put"的存量语义(Put = 整行替换,zero-etl 靠它推进状态)。
  // 唯一写通道的 `putRunRecord` 不加 `attribute_not_exists` 正是为了不弄坏它,见该文件说明。
  const writeRun = (status: string, extra: Record<string, unknown> = {}) =>
    putRunRecord({
      taskId, runId, taskType: "sync", status, startedAt, triggeredBy: "manual",
      // zero-etl 只在 home 跑(POST 的通道卡保证章 = home),
      // 章显式盖 home;裸调 resolveRunStamp(task) 已在本文件绝迹(sync-pushdown-wiring 钉住)。
      stamp: resolveRunStamp(task, HOME_TARGET_ID),
      extra: { channel: "zero-etl", metrics: { rowsRead: 0, rowsWritten: 0 }, ...extra },
    }).catch(() => {});

  // 关闭本任务此前残留的 running 运行记录:Zero-ETL 是常驻通道,激活靠长后台轮询,进程被回收
  // (如重新部署)会让旧 run 永远停在 running(与 B10 同类)。重启时先把旧的 running 收口为 stopped,
  // 保证一个任务最多只有"当前这条"running run,避免运行历史/监控"运行中"计数被污染。
  // 5 处同款"收口残留 running"循环收敛到 settleRunningRuns
  // (顺带修掉原先 Query **不翻页** ⇒ run 多到超 1MB 就漏收口、留下永久 running 污染监控计数)。
  try {
    await settleRunningRuns({ taskId, status: "stopped", set: { finishedAt: startedAt }, stamp: resolveRunStamp(task, HOME_TARGET_ID) });
  } catch {}

  await updateTask("provisioning");
  await writeRun("running", { logs: [...steps] });

  void (async () => {
    try {
      const wh = await ensureZeroEtlWarehouse();
      log("✓ 独立 Zero-ETL 数仓就绪(case-sensitive namespace + workgroup,隔离主库)");
      await ensureNamespaceResourcePolicy(wh.namespaceArn, sourceArn, accountId);
      log("✓ namespace 资源策略已授权入站集成(锁定源实例 ARN)");
      const dataFilter = buildZeroEtlDataFilter(database, tables);
      log(`✓ data-filter:${dataFilter}`);
      const integ = await ensureIntegration({ sourceArn, targetArn: wh.namespaceArn, integrationName, dataFilter });
      log(`✓ Zero-ETL 集成已创建/复用:${integrationName}(${integ.status})`);
      const zeroEtlConfig = { namespace: wh.namespaceArn, workgroup: wh.workgroupName, destDb, integrationId: integ.integrationId, database, schema: database };
      await updateTask("provisioning", { integrationArn: integ.integrationArn, zeroEtlConfig });
      await writeRun("running", { logs: [...steps], integrationArn: integ.integrationArn });

      // 轮询等集成 active(冷启动 ~50min;窗口放宽到 ~90min)。
      let status = integ.status;
      for (let i = 0; i < 360; i++) {
        const s = await getIntegrationStatus(integ.integrationArn);
        status = s.status;
        if (status === "active") break;
        if (status === "failed" || (s.errors && s.errors.length > 0)) {
          throw new Error(`集成失败:${s.errors.join("; ") || status}`);
        }
        await new Promise((r) => setTimeout(r, 15000));
      }
      if (status !== "active") throw new Error(`集成未在预期时间内 active(当前 ${status})`);
      log("✓ 集成已 active(全量快照 + binlog CDC 已建立)");

      await ensureDestinationDatabase(destDb, integ.integrationId);
      log(`✓ 目标库已建:${destDb}(CREATE DATABASE FROM INTEGRATION)`);
      log(`✓ 增量同步运行中:源 ${database} 变更将近实时复制到 Redshift ${destDb} 库(schema=${database})。验证:Redshift 查询页选 ${wh.workgroupName} / ${destDb}。`);

      await updateTask("running", { integrationArn: integ.integrationArn, zeroEtlConfig });
      await writeRun("running", { logs: [...steps], integrationArn: integ.integrationArn });
    } catch (e: any) {
      log(`✗ 编排失败:${String(e?.message || e).slice(0, 200)}`);
      await updateTask("error", { error: String(e?.message || e).slice(0, 300) });
      await writeRun("failed", { logs: [...steps], error: String(e?.message || e).slice(0, 300) });
    }
  })();

  recordAudit(req, "sync.start-zeroetl", {
    resourceType: "sync", resourceId: taskId, detail: { name: task.name, integrationName, database },
  }).catch(() => {});

  return apiOk({ taskId, channel: "zero-etl", status: "provisioning", message: "Zero-ETL 增量同步编排已启动(集成激活约需数十分钟),可在详情页查看进度" }, 202);
}
