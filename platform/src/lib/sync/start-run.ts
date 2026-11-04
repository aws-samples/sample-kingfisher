// @kf-batch 37-sync-backfill —— 同步任务 glue 通道的**启动核心**(唯一作者)。
//
// 由 `app/api/sync/[id]/start/route.ts` 原样搬来:序 37 ⑥(手动运行指定业务日期)与 ⑦(补数中心支持同步任务)
// 必须走**同一条**启动路径,而 Next 的 route.ts 只能导出 HTTP 方法 ⇒ 核心搬到这里,路由与补数各调一次。
//   本文件:解析落点 → 建 / 更新作业 → 启动 → 写 run → 挂后台轮询 → OM 推送。
//   路由保留:取任务 / 取源 / 项目守卫 / 章反向卡 / 跨区取数 409 / 空活 400 / 通道判定(含 zero-etl)/ 审计 / 响应。
//   补数(`lib/backfill/execute.ts`)调用前自己做同一组前置判定(用同一批单一作者函数,见那边)。
//
// 🔴 纯搬移:语句、顺序、错误分支与搬家前逐条相同。判据 `app/api/sync/[id]/start/__tests__/start-route-baseline.test.ts`
//    是搬家**之前**录下的调用序列快照,搬完逐条比对。与搬家前的差别只有下面这些,且都只在「指定了业务日期 / 补数」时生效:
//    ① StartJobRun 带 `Arguments: syncRunArguments(runDate)`(没给日期 ⇒ 仍然只有 `{ JobName }`);
//    ② run 记录的 triggeredBy 取调用方传入的值;extra 多 `runDate` / `backfillPlanId`(没有就不加键);
//    ③ 补数触发的 run 成功后不推进增量水位、不扇出下游(手动触发与改动前完全相同)。
//    原来路由里 `return apiError(...)` 的三条拒绝(角色 ARN 非法 / 无角色 / 表桶冲突)改为返回 `{ started: false, ... }`,
//    由路由原样转成同一个状态码与 code(补数把它当实例失败原因)。
import { StartJobRunCommand } from "@aws-sdk/client-glue";
// 序 43 B-91:联邦目录 s3tablescatalog 的运行时唯一作者(直查路径与安装脚本共用同一份入参)
import { ensureS3TablesFederatedCatalog } from "@/lib/aws/s3tables-catalog";
// 序 38 B-68:建 / 更新作业的唯一作者(GetJob 判存在 → UpdateJob / CreateJob;失败如实上抛)
import { upsertGlueJob } from "@/lib/aws/glue-job-upsert";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { CreateTableBucketCommand, CreateNamespaceCommand, ListTableBucketsCommand, ListNamespacesCommand } from "@aws-sdk/client-s3tables";
import { generateGlueScript } from "@/lib/sync/glue-script-generator";
import { resolveGlueBinding, resolveRedshiftBinding } from "@/lib/exec-env/data-plane-target";
// 序 72 B-139(模块 56):执行角色解析 / 预检的唯一作者
import { resolveExecutionRoleArn, ExecRoleRejected } from "@/lib/execution-role/resolve";
import { preflightExecutionRole } from "@/lib/execution-role/preflight";
import { s3UrisFromGlueConfig } from "@/lib/execution-role/s3-uris";
import { glueClientFor, s3ClientFor, s3tablesClientFor, logsClientFor } from "@/lib/exec-env/target-clients";
import { sanitizeS3TablesIdentifier } from "@/lib/sync/s3tables-identifier";
import { ulid } from "ulid";
import type { DataSource } from "@/types/datasource";
import { pushSyncToOpenMetadata } from "@/lib/openmetadata/om-push";
import { syncOmPlaceOf, type SyncOmPlace } from "@/lib/openmetadata/om-sync-coords";
import { fireDownstreamOnce } from "@/lib/scheduler/dependency";
import { putRunRecord, updateRunRecord, resolveRunStamp, type RunOwner } from "@/lib/monitor/run-records";
import { updateSyncTaskIfExists } from "@/lib/sync/task-write";
import { syncRunArguments } from "@/lib/sync/run-vars";
// 序 37 B-62:运行行数指标的解析单一作者
import { parseSyncRunMetrics } from "@/lib/sync/run-metrics";
// 序 37 B-60:既有目标收养(升级兼容,一次性)
import { adoptExistingTargetsOnce } from "@/lib/sync/foreign-guard-adoption";
// 序 38 B-69:Glue 版本的唯一作者(缺省值 + 写 S3 Tables 的最低版本)
import { GLUE_VERSIONS, isGlueVersion, glueVersionOfRecord, syncCompatSparkConf, glueVersionSupportsS3Tables, syncGlueVersionRejection } from "@/lib/sync/glue-version";
// @kf-batch 56-B127-exec-env-own-table-bucket —— 任务写哪个表桶 / 自带桶的准入(唯一作者)
import { effectiveTableBucket, tableBucketRejection } from "@/lib/sync/table-bucket";
// 序 61 B-133 —— 数据源外部网络对象(平台自建安全组 / 子网 / Glue 连接)核对自愈 + 运行失败原话分类(两处唯一作者)
import { reconcileDatasourceNetwork, noteNetworkDriftFromRunError } from "@/lib/datasource/network-reconcile";
import { classifyRunError, isNetworkDrift } from "@/lib/sync/run-error";

/** 谁触发的这次同步运行(写进 run 记录的 triggeredBy;监控 / SLA 基线据此把补数排除在在线统计外)。 */
export type SyncRunTriggeredBy = "manual" | "backfill";

/**
 * 🔴 类型堵死(A4):`triggeredBy` 必填、无缺省;补数必须带业务日期与补数计划号(run 记录要能回指计划),
 * 手动可选带业务日期(不带 = 脚本按任务时区取今天,与改动前相同)。
 */
export type SyncRunTrigger =
  | { triggeredBy: "manual"; runDate?: string }
  | { triggeredBy: "backfill"; runDate: string; backfillPlanId: string };

export type StartGlueSyncRunArgs = SyncRunTrigger & {
  /** 任务行(DDB 原样;写 S3 Tables 时会就地补上表桶 / namespace —— 与搬家前同一行为,脚本生成要读它) */
  task: Record<string, any>;
  taskId: string;
  ds: DataSource;
  /** 任务的章(唯一执行落点,调用方用 bindingTargets(task)[0] 取得并已过反向卡) */
  tid: string;
  /** 源的落点章(datasourceOwnerTarget(ds));OM 推送坐标要用 */
  dsOwner: string;
  /** 只给测试注入:StartJobRun 撞上「上一次 run 收尾中」时的等待(缺省真 sleep) */
  sleep?: (ms: number) => Promise<void>;
};

// @kf-batch 37-sync-capability —— 序 37 B-64:Glue 的已知行为 —— 上一次 run 刚到终态后的一两分钟内,StartJobRun 仍可能回
//   ConcurrentRunsExceededException(那次 run 在收尾;作业定义 MaxConcurrentRuns=1 是刻意的,见 lib/backfill/types.ts)。
//   真环境两次撞到(2026-10-12 第二轮):补数第二个日期紧接第一个日期启动 ⇒ 实例失败、计划「部分失败」;守卫刚拒掉一次运行、
//   用户马上再点 ⇒ 500。⇒ 在**唯一启动核心**做有界重试:手动 3 次(用户在等,总共 ≤ 40s);补数 2 次(泵的 HTTP 预算 55s,
//   更长的等待由 backfill/runner.ts 把实例还回 pending、下一拍再领,见 BACKFILL_DEFER_MAX_ATTEMPTS);间隔 10–20s 全抖动;
//   用尽后抛一条说得清的中文错(name 保持 ConcurrentRunsExceededException 供 runner 识别;路由照旧映射)。别的异常不重试、原样抛。
export const GLUE_START_RETRY = Object.freeze({ manual: 3, backfill: 2, baseMs: 10_000, jitterMs: 10_000 });
export const GLUE_CONCURRENT_RUNS_ERROR = "ConcurrentRunsExceededException";
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function startJobRunWithRetry(
  glue: { send: (cmd: StartJobRunCommand) => Promise<{ JobRunId?: string }> },
  input: ConstructorParameters<typeof StartJobRunCommand>[0],
  triggeredBy: SyncRunTriggeredBy,
  sleep: (ms: number) => Promise<void>,
): Promise<{ JobRunId?: string }> {
  const max = triggeredBy === "backfill" ? GLUE_START_RETRY.backfill : GLUE_START_RETRY.manual;
  for (let attempt = 1; ; attempt++) {
    try {
      return await glue.send(new StartJobRunCommand(input));
    } catch (e) {
      const name = String((e as { name?: string })?.name || "");
      if (name !== GLUE_CONCURRENT_RUNS_ERROR) throw e;
      if (attempt >= max) {
        const err = new Error(`上一次运行仍在收尾(同一个 Glue 作业同时只能跑一个),等了 ${attempt} 次仍未释放;请稍后再试`);
        err.name = GLUE_CONCURRENT_RUNS_ERROR;
        throw err;
      }
      console.warn(`[sync.start] ${input.JobName} 上一次 run 收尾中(${GLUE_CONCURRENT_RUNS_ERROR}),第 ${attempt}/${max} 次等待后重试`);
      await sleep(GLUE_START_RETRY.baseMs + Math.floor(Math.random() * GLUE_START_RETRY.jitterMs));
    }
  }
}

/** 业务拒绝的错误码(路由原样透传;页面按码指路)。B-133 起多一种:数据源的用户自带网络对象 / 密钥缺失,平台不代建。 */
export type SyncRejectCode = "CONFLICT" | "DATASOURCE_NETWORK_BROKEN";

export type StartGlueSyncRunResult =
  | { started: true; jobName: string; jobRunId: string | undefined; runId: string }
  | { started: false; status: 400 | 409; message: string; code?: SyncRejectCode };

function reject(status: 400 | 409, message: string, code?: SyncRejectCode): StartGlueSyncRunResult {
  return { started: false, status, message, ...(code ? { code } : {}) };
}

/**
 * 启动一次 glue 通道同步运行。
 * 落点解析拒绝(`TargetBindingRejected`)与 AWS 调用失败照原样**抛出**(路由转 409 / 500,补数记为实例失败)。
 */
export async function startGlueSyncRun(args: StartGlueSyncRunArgs): Promise<StartGlueSyncRunResult> {
  const { task, taskId, ds, tid, dsOwner } = args;
  // 业务日期非法 ⇒ 这里就抛(无副作用:在解析落点 / 建作业之前)。路由在更早处已经按 400 拒过。
  const runArguments = syncRunArguments(args.runDate);

  // 序 37 B-67:落点解析 → 收养 → 生成脚本 → 写 S3 → 建 / 更新作业 = 唯一作者 ensureGlueSyncJob(保存路由也走它);
  //   调用序列与改动前逐字相同(golden / 装配层判据钉住)。
  const ensured = await ensureGlueSyncJob({
    task, taskId, ds, tid,
    // 序 37 B-60 升级兼容:守卫上线前已成功运行过的任务,首次运行时把当时的目标表记为已确认(一次性;规则见
    //   lib/sync/foreign-guard-adoption.ts)。必须在生成脚本之前、在 namespace 补齐之后(S3 三段名要用补齐后的 namespace)。
    beforeGenerate: async (t) => { await adoptExistingTargetsOnce(t as never, taskId, ds as { database?: unknown }); },
  });
  if (!ensured.ok) return reject(ensured.status, ensured.message, ensured.code);
  const { jobName, landing, rsb, glue } = ensured;
  return startEnsuredGlueSyncRun({ task, taskId, ds, tid, dsOwner, jobName, landing, rsb, glue, runArguments, trigger: args, sleep: args.sleep });
}

export interface EnsureGlueSyncJobArgs {
  /** 任务行(DDB 原样;写 S3 Tables 时会就地补上表桶 / namespace —— 脚本生成要读它) */
  task: Record<string, any>;
  taskId: string;
  ds: DataSource;
  /** 任务的章(唯一执行落点) */
  tid: string;
  /** 生成脚本之前的钩子(启动路径 = 既有目标收养;可就地改 task) */
  beforeGenerate?: (task: Record<string, any>) => Promise<void>;
}
export type EnsureGlueSyncJobResult =
  | {
      ok: true;
      jobName: string;
      scriptKey: string;
      bucket: string;
      landing: Awaited<ReturnType<typeof resolveGlueBinding>>;
      rsb: Awaited<ReturnType<typeof resolveRedshiftBinding>> | null;
      glue: Awaited<ReturnType<typeof glueClientFor>>;
    }
  | { ok: false; status: 400 | 409; message: string; code?: SyncRejectCode };

/**
 * 序 37 B-67:让该任务的 Glue 作业与**当前任务定义**一致 —— 解析落点、(可选)生成前钩子、生成脚本、写进脚本桶、
 * 建或更新作业定义。启动路径(startGlueSyncRun)与保存路径(PUT /api/sync/[id])共用这一份:
 * 原来脚本只在启动时重生成,而调度载体只 start_job_run 旧作业 ⇒ 用户改了 WHERE / 分区 / 合并键 / 逐表确认之后,
 * **定时运行一直跑旧脚本**,直到有人手动跑一次(真环境 2026-10-12 坐实)。
 * 落点解析拒绝(`TargetBindingRejected`)与 AWS 调用失败照原样**抛出**;业务校验不过回 `ok: false`(400 / 409)。
 */
export async function ensureGlueSyncJob(args: EnsureGlueSyncJobArgs): Promise<EnsureGlueSyncJobResult> {
  const { task, ds, tid } = args;

  // @kf-batch 50-WP7-sync-pushdown(施工序 3)—— 落点解析(唯一作者):
  // landing = 该章的 Spark 落点(区/脚本桶/执行角色/湖桶/表桶;home 逐字节等价、非 home 取描述符
  // 实名资源袋、缺一即拒);rsb = 写数仓时该章的数仓四样(区/workgroup/库/凭证)。
  const landing = await resolveGlueBinding({ targetId: tid });
  const writeRedshift = task.targetType === "redshift" || task.targetType === "both";
  const rsb = writeRedshift
    ? await resolveRedshiftBinding({
        targetId: tid,
        projectId: typeof task.projectId === "string" ? task.projectId : null,
        workgroupOverride: task.redshiftConfig?.workgroupName,
        databaseOverride: task.redshiftConfig?.database,
      })
    : null;
  const glue = await glueClientFor(landing.region);
  const s3 = await s3ClientFor(landing.region);

  // 执行角色:任务自定义 executionRoleArn 优先(最小权限),留空回退**该落点的**执行角色
  // (home = 既有 GLUE_ROLE_ARN env;非 home = 该 target 自己的 glue role,resolveTargetGlue
  // 已 fail-closed 断言 —— 🔴 非 home 绝不回落 env:那是拿主控区的执行身份去别的区跑)。
  // 序 72 B-139:单一作者 resolveExecutionRoleArn;自定义角色在建 / 改 Glue 作业之前按本落点预检(信任 glue + 引擎基线 + 依赖引用),
  //   缺 ⇒ 400 指路、不动 Glue 作业(与离线计算同一口径)。
  let roleArn: string;
  try {
    const resolved = resolveExecutionRoleArn({
      custom: task.glueConfig?.executionRoleArn,
      fallback: landing.roleArn,
      missingMessage: "未指定执行角色:请在任务网络与执行角色区填写 ARN,或部署配置 GLUE_ROLE_ARN",
    });
    roleArn = resolved.roleArn;
    if (resolved.isCustom) {
      const pf = await preflightExecutionRole({ engine: "glue", roleArn, targetId: tid, extraS3Uris: s3UrisFromGlueConfig(task.glueConfig) });
      if (!pf.ok) return ensureReject(400, pf.message || "执行角色预检未通过");
      if (pf.unverifiable) console.warn(`[sync:preflight] ${tid} ${pf.unverifiable}`);
    }
  } catch (e) {
    if (e instanceof ExecRoleRejected) return ensureReject(400, e.message);
    throw e;
  }

  // Auto-create S3 Table Bucket & Namespace if target is S3 Tables
  const writeS3 = task.targetType === "s3-tables" || task.targetType === "both";
  const gcfg = (task.glueConfig || {}) as { workerType?: string; numberOfWorkers?: number; glueVersion?: string; timeoutMinutes?: number; maxRetries?: number };
  // 序 53:记录里存了版本就用它;没存 ⇒ 按「它被写下时的缺省」(5.1)跑,**不是**新缺省 6.0 —— 升级平台不许静默改任何已有任务的 Glue 版本
  //   (用户 2026-10-26:源库 / 生产环境不会跟着我们的支持版本升级)。存了清单外的值 ⇒ 400 如实拒,不替用户猜。
  if (gcfg.glueVersion !== undefined && gcfg.glueVersion !== null && gcfg.glueVersion !== "" && !isGlueVersion(gcfg.glueVersion)) {
    return ensureReject(400, `Glue 版本不合法:${JSON.stringify(gcfg.glueVersion)}(可选:${GLUE_VERSIONS.join(" / ")})`);
  }
  const glueVersion = glueVersionOfRecord(gcfg.glueVersion);
  // 序 38 B-69 —— 写 S3 Tables 的作业只能是 Glue ≥ 5.1(联邦目录 `s3tablescatalog/<表桶>` + warehouse ARN 只在 5.1 可用;
  //   5.0 跑起来才报「Invalid S3 URI … arn:aws:s3tables」,客户生产环境 2026-10-13 坐实)。路由保存 / 新建已被
  //   validateSyncGlueVersion 拦过;这里是唯一作者处的 fail-closed(存量任务 / 调度 / 补数路径都经过这里),
  //   🔴 放在**任何副作用之前**(建命名空间 / 写脚本 / 建作业都还没发生)。
  if (writeS3 && !glueVersionSupportsS3Tables(glueVersion)) {
    return ensureReject(400, syncGlueVersionRejection(glueVersion));
  }
  // @kf-batch 56-B127-exec-env-own-table-bucket —— 写哪个表桶 = 唯一作者 lib/sync/table-bucket.ts(生成器 / 目标表守卫同一函数)
  const tableBucketName = effectiveTableBucket(task, landing);
  // 🔴 自带表桶的准入与保存路由**同一份判定**:非主控区只许平台表桶或「系统设置 → 数据湖外部表桶」已登记的桶,拒绝即指路;主控区不变。
  //   改动前这里按「非 home 只认描述符」写死(登记了也 409)⇒ 执行区只能写平台表桶(客户 2026-10-27 反馈,B-127)。
  //   不静默取一个(与 resolveRedshiftBinding 的 assertNoWarehouseConflict 同一语义:用户看到自己填的值、真写的是另一个桶,正是要消灭的形态)。
  if (writeS3) {
    const bucketReject = await tableBucketRejection(task, landing);
    if (bucketReject) return ensureReject(409, bucketReject, "CONFLICT");
  }
  // 序 61 B-133 —— 数据源依赖的外部网络对象(平台自建安全组 / 平台选的子网 / Glue 连接)核对与自愈,🔴 仍在**任何副作用之前**
  //   (建命名空间 / 写脚本 / 建作业都还没发生;启动 / 保存 / 调度扇出 / 补数四条路都经过这里)。
  //   平台拥有的缺了 ⇒ 按源行 + 密钥重建并接回连接(响亮:审计 + 告警中心 + 源行 healCount);用户自带的缺了 ⇒ 409 点名对象、源行标 broken;
  //   事实读不到 ⇒ 不拦(Glue 自己会报,运行终态由 classifyRunError 翻成中文)。
  //   2026-10-28 真撞:平台组被平台外删除后每次运行只剩 AWS 原话「Security Group Not Found」,源仍显示「已连接」,产品里无修复入口。
  const net = await reconcileDatasourceNetwork(ds, { via: "sync.ensure-job" });
  if (net.kind === "broken") return ensureReject(409, net.message, "DATASOURCE_NETWORK_BROKEN");
  // Bug#1 修复:namespace 过 S3Tables 标识符 SSOT(小写+非法字符→_)。auto 模式默认取 ds.database
  // /源表名/桶名,DDB/S3 源常含连字符 → CreateNamespace "isn't valid" 500。sanitize-on-read:
  // 这里与 glue-generator:94、om-push:158/329 用【同一表达式过同一函数】→ 必算同值,无需持久化
  // (幂等纯函数),从根上避免"物理侧 sanitize 了、元数据侧还是原始名"的血缘 FQN 分叉。
  const namespace = sanitizeS3TablesIdentifier(task.s3Config?.namespace || ds.database || "default");
  if (writeS3) {
    await ensureS3TableBucketAndNamespace(landing, tableBucketName, namespace);
    // Patch task config so glue script uses correct namespace
    task.s3Config = { ...task.s3Config, tableBucket: tableBucketName, namespace };
  }

  // 生成前钩子(启动路径 = B-60 既有目标收养;必须在生成脚本之前、在 namespace 补齐之后 —— S3 三段名要用补齐后的 namespace)。
  if (args.beforeGenerate) await args.beforeGenerate(task);

  // Generate script —— 脚本里的区位值(区/桶/workgroup/库/凭证)全部由 binding 生成期注入,
  // Python 侧不再按 env / home 命名猜(施工序 2 落的,glue-script-landing 单测钉住)。
  const script = generateGlueScript(task, ds as DataSource, { landing, rsb });
  const bucket = landing.scriptsBucket;
  const scriptKey = `glue-scripts/${task.taskId}.py`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: scriptKey, Body: script }));

  // Create or update Glue Job(参数齐全暴露:worker/版本/超时/重试来自 task.glueConfig,不再写死;
  // 已存在时用 UpdateJob 让改参数真正生效,而非静默沿用旧定义)。
  const jobName = `bgp-sync-${task.taskId.slice(-12)}`;
  const connName = ds.glueConnectionName;
  const jobDef = {
    Role: roleArn,
    Command: { Name: "glueetl" as const, ScriptLocation: `s3://${bucket}/${scriptKey}`, PythonVersion: "3" },
    GlueVersion: glueVersion,
    NumberOfWorkers: gcfg.numberOfWorkers || 2,
    WorkerType: (gcfg.workerType || "G.1X") as any,
    Timeout: gcfg.timeoutMinutes || 60,
    MaxRetries: gcfg.maxRetries ?? 0,
    DefaultArguments: {
      "--datalake-formats": "iceberg",
      "--TempDir": `s3://${bucket}/temp/`,
      "--conf": [
        "spark.sql.catalog.s3tablescatalog=org.apache.iceberg.spark.SparkCatalog",
        "spark.sql.catalog.s3tablescatalog.catalog-impl=org.apache.iceberg.aws.glue.GlueCatalog",
        `spark.sql.catalog.s3tablescatalog.glue.id=${process.env.AWS_ACCOUNT_ID}:s3tablescatalog/${tableBucketName}`,
        "spark.sql.catalog.s3tablescatalog.io-impl=org.apache.iceberg.aws.s3.S3FileIO",
        `spark.sql.catalog.s3tablescatalog.warehouse=arn:aws:s3tables:${landing.region}:${process.env.AWS_ACCOUNT_ID}:bucket/${tableBucketName}`,
        // 序 53:Glue ≥ 6.0(Spark 4)的平台同步脚本钉兼容开关(ANSI 关 + JDBC legacy 类型映射),让同一张源表在 5.1 / 6.0 下读出同样的类型;
        //   < 6.0 为空数组 ⇒ 作业定义逐字节不变(单一作者 lib/sync/glue-version.ts)
        ...syncCompatSparkConf(glueVersion),
      ].join(" --conf "),
    } as Record<string, string>,
    Connections: connName ? { Connections: [connName] } : undefined,
  };
  // 序 38 B-68 —— 建 / 更新作业的唯一规则(客户生产环境 2026-10-13 坐实的缺陷):
  //   原来「先 CreateJob,报 already exists 才 UpdateJob」:作业已存在而**定义有变**(改 Glue 版本 / 改目标表桶 ⇒ --conf 变)时
  //   Glue 回的是 IdempotentParameterMismatchException「Job already submitted with different configuration」,不含 already exists
  //   ⇒ 掉进「最小参数重建」分支再撞同一错 ⇒ 保存 502「保存未生效」、启动 500;定义没变时 UpdateJob 失败又被吞(页面说保存成功,作业还是旧的)。
  //   现在与离线作业(etl/job-service.ts)同一形状:GetJob 判存在 ⇒ 存在就 UpdateJob(失败**如实上抛**,保存路由回 502 带 Glue 原话、
  //   不落库;启动路由回 500);不存在才 CreateJob;CreateJob 撞「已存在 / 幂等不匹配」(GetJob 与 CreateJob 之间被别人建了)⇒ 按已存在走 UpdateJob。
  //   🔴 删掉「最小参数重建」:那样建出的作业没有 S3 Tables 目录配置,写湖必失败,是一条静默降级([[silent-default-is-a-defect-class]])。
  //   具体规则与清单见 lib/aws/glue-job-upsert.ts(唯一作者;离线作业与数据源发现作业同一份)。
  await upsertGlueJob(glue, jobName, jobDef);
  return { ok: true, jobName, scriptKey, bucket, landing, rsb, glue };
}

function ensureReject(status: 400 | 409, message: string, code?: SyncRejectCode): EnsureGlueSyncJobResult {
  return { ok: false, status, message, ...(code ? { code } : {}) };
}

interface StartEnsuredGlueSyncRunArgs {
  task: Record<string, any>;
  taskId: string;
  ds: DataSource;
  tid: string;
  dsOwner: string;
  jobName: string;
  landing: Awaited<ReturnType<typeof resolveGlueBinding>>;
  rsb: Awaited<ReturnType<typeof resolveRedshiftBinding>> | null;
  glue: Awaited<ReturnType<typeof glueClientFor>>;
  runArguments: Record<string, string> | undefined;
  trigger: SyncRunTrigger;
  sleep?: (ms: number) => Promise<void>;
}

/** 作业已与定义一致之后的启动段:StartJobRun(有界重试)→ run 行 → 任务状态 → 后台轮询 → OM 推送。与改动前逐字同序。 */
async function startEnsuredGlueSyncRun(a: StartEnsuredGlueSyncRunArgs): Promise<StartGlueSyncRunResult> {
  const { task, taskId, ds, tid, dsOwner, jobName, landing, rsb, glue, runArguments } = a;
  const args = a.trigger;

  // Start job run
  // @kf-batch 37-sync-backfill —— 🔴 没指定业务日期 ⇒ 入参与改动前**逐字节相同**(只有 JobName;脚本按任务时区取今天,
  //   与调度 / 工作流节点重跑同一个作业不带参数是同一条路)。指定了才带 `--ds`(参数名与取值规则的唯一作者是 run-vars.ts)。
  // 序 37 B-64:撞上「上一次 run 收尾中」有界重试(见 startJobRunWithRetry);成功路径的入参与调用序列不变。
  const { JobRunId } = await startJobRunWithRetry(
    glue, runArguments ? { JobName: jobName, Arguments: runArguments } : { JobName: jobName }, args.triggeredBy, a.sleep ?? realSleep,
  );

  // Create run record in bgp-task-runs
  const runId = ulid();
  const now = new Date().toISOString();
  // @kf-batch 52-P52.2-W2a-run-stamp — 归属取**任务行**(guardResourceAccess 判的也是它)。
  // @kf-batch 50-WP7-sync-pushdown —— 🔴 章按**真落点**显式盖:同步任务的区维在 `targets[]`
  // 而 `resolveRunStamp(task)` 读的是 `owner.targetId` ⇒ 不显式传就**永远盖 home**
  // (监控页区域筛选、成本行继承会一致地说谎)。成本行随 w3f 机制继承同章。
  await putRunRecord({
    taskId, runId, taskType: "sync", startedAt: now, triggeredBy: args.triggeredBy,
    stamp: resolveRunStamp(task, tid),
    // @kf-batch 37-sync-backfill —— 业务日期 / 补数计划号只在有时才加键(手动不指定日期 ⇒ 与改动前同形)。
    extra: {
      glueJobName: jobName, glueJobRunId: JobRunId, metrics: { rowsRead: 0, rowsWritten: 0 },
      ...(args.runDate ? { runDate: args.runDate } : {}),
      ...(args.triggeredBy === "backfill" ? { backfillPlanId: args.backfillPlanId } : {}),
    },
  });

  // Update task status
  // @kf-batch 50-B08-sync-task-write-guard —— 唯一写通道
  await updateSyncTaskIfExists({
    taskId,
    UpdateExpression: "SET #s = :s, glueJobName = :j, lastRunId = :r, updatedAt = :now",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":s": "running", ":j": jobName, ":r": runId, ":now": now },
  });

  // Poll for completion in background (update run record when done)
  // @kf-batch 50-o4REG-sync-om-per-target —— OM 落点 = 本次执行解析出的**同一份** landing / rsb + 源落点
  //   (启动推送与成功回填共用;非主控区缺表桶 / 库名就不推,绝不回落主控区缺省值)。
  const omPlace: SyncOmPlace = syncOmPlaceOf(landing, rsb, dsOwner);
  pollGlueJob(task, taskId, runId, jobName, JobRunId!, landing, { task, ds: ds as DataSource, place: omPlace }, args.triggeredBy).catch(() => {});

  // P3: push source -> S3 Tables -> Redshift entities + column-level lineage to
  // OpenMetadata (fire-and-forget; best-effort, never blocks the sync run).
  // @kf-batch 50-o4REG-sync-om-per-target —— 🔴 原来 `if (landing.home)` 才推(om-push 是主控区口径,
  //   非 home 推上去 = 把主控区 schema 当成该区的)。现在坐标由 `syncOmCoords` 按落点算:
  //   主控区逐字节不变,其它区进该区的 per-target service ⇒ **每个区都推、各推各的**(登记 o4-REG 交付)。
  pushSyncToOpenMetadata(task, ds as DataSource, omPlace).catch(() => {});

  return { started: true, jobName, jobRunId: JobRunId, runId };
}

async function ensureS3TableBucketAndNamespace(landing: { region: string }, bucketName: string, namespace: string): Promise<string> {
  const glue = await glueClientFor(landing.region);
  const s3tables = await s3tablesClientFor(landing.region);
  // Find or create table bucket
  let bucketArn = "";
  const { tableBuckets = [] } = await s3tables.send(new ListTableBucketsCommand({}));
  const existing = tableBuckets.find((b) => b.name === bucketName);
  if (existing) {
    bucketArn = existing.arn!;
  } else {
    const res = await s3tables.send(new CreateTableBucketCommand({ name: bucketName }));
    bucketArn = res.arn!;
  }

  // Ensure s3tablescatalog federated catalog exists in Glue Data Catalog
  // SYNC-FIX(B5): missing ⇒ create;AlreadyExists = success;其它错误如实上抛(原来 `.catch(()=>{})` 吞掉 ⇒ Glue 作业 Catalog not found)。
  // @kf-batch 43-page-sweep(B-91)—— 实现搬到 lib/aws/s3tables-catalog.ts(直查路径 + 安装脚本共用同一份入参);本路径行为逐字节不变。
  const accountId = bucketArn.split(":")[4];
  await ensureS3TablesFederatedCatalog(glue, { region: landing.region, accountId });

  // Ensure namespace exists
  try {
    const { namespaces = [] } = await s3tables.send(new ListNamespacesCommand({ tableBucketARN: bucketArn }));
    if (!namespaces.some((n) => n.namespace?.includes(namespace))) {
      await s3tables.send(new CreateNamespaceCommand({ tableBucketARN: bucketArn, namespace: [namespace] }));
    }
  } catch (e: any) {
    if (!e.message?.includes("already exists")) throw e;
  }

  return bucketArn;
}

// @kf-batch 52-P52.2-W2a-run-stamp
// `task` 只用于**取归属**(DDB 行是 `Record<string, any>`,不带类型上的 taskId);
// taskId 仍单独传,避免为了盖章去 cast 一个未类型化的行。
// @kf-batch 50-WP7-sync-pushdown —— 轮询/取日志/存日志/盖章全按 `landing`(启动时解析的那份,
// 同一次 run 不重解析:重解析可能拿到已变更的描述符,轮询与启动就会各说各话)。
async function pollGlueJob(
  task: RunOwner,
  taskId: string,
  runId: string,
  jobName: string,
  jobRunId: string,
  landing: { targetId: string; region: string; scriptsBucket: string; home: boolean },
  // @kf-batch 50-o4REG-sync-om-per-target —— 成功后 OM 回填要的三样(与启动推送同一份落点)
  om: { task: Record<string, any>; ds: DataSource; place: SyncOmPlace },
  // @kf-batch 37-sync-backfill —— 谁触发的(不给缺省值:补数与手动在收口时有两处不同,见下)
  triggeredBy: SyncRunTriggeredBy
) {
  const { GetJobRunCommand } = await import("@aws-sdk/client-glue");
  const glue = await glueClientFor(landing.region);

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 15000));

    try {
      const { JobRun } = await glue.send(new GetJobRunCommand({ JobName: jobName, RunId: jobRunId }));
      if (!JobRun) continue;

      const state = JobRun.JobRunState;
      if (state === "SUCCEEDED" || state === "FAILED" || state === "STOPPED" || state === "ERROR") {
        const now = new Date().toISOString();
        const status = state === "SUCCEEDED" ? "succeeded" : "failed";
        // 序 61 B-133 —— 失败原话分类(唯一作者 lib/sync/run-error.ts):运行行 error 写中文结论、errorRaw 存 AWS 原话;
        //   「网络漂移」类(安全组 / 子网 / 连接被平台外删除)同时把源行标 broken ⇒ 下一次启动前 reconcileDatasourceNetwork 自愈。
        const errCls = classifyRunError(JobRun.ErrorMessage);
        if (status !== "succeeded" && isNetworkDrift(errCls.kind)) {
          void noteNetworkDriftFromRunError(om.ds, JobRun.ErrorMessage).catch(() => undefined);
        }

        // Collect full logs and save to S3.
        // SYNC-FIX(B1/log): Glue flushes stdout to CloudWatch with a 30–60s lag, so a
        // single fetch right when the run reaches SUCCEEDED often comes back empty —
        // which left BOTH the run log (logS3Key=null → UI "暂无日志") AND the row
        // metrics (rowsRead/Written stuck at 0) blank. Retry the collection until the
        // job's own stream actually yields events (the stream must match this jobRunId,
        // never fall back to other concurrent jobs' streams which would mis-parse metrics).
        let logS3Key = "";
        let allLogs: string[] = [];
        try {
          const { GetLogEventsCommand, DescribeLogStreamsCommand } = await import("@aws-sdk/client-cloudwatch-logs");
          // 🔴 CloudWatch 日志组是 region 内的:非 home 的 Glue 作业日志在**那个区**的日志组里,
          // 用 home 客户端取只会取到空 —— 而「空日志」在界面上与「作业没输出」长得一模一样。
          const cwl = await logsClientFor(landing.region);

          const collectOnce = async (): Promise<string[]> => {
            const out: string[] = [];
            for (const logGroup of ["/aws-glue/jobs/output", "/aws-glue/jobs/logs-v2"]) {
              try {
                const { logStreams = [] } = await cwl.send(new DescribeLogStreamsCommand({
                  logGroupName: logGroup, orderBy: "LastEventTime", descending: true, limit: 50,
                }));
                // Only this run's streams — never fall back to other jobs' streams, which
                // would pollute metric parsing with another table's row counts.
                const streams = logStreams.filter((s) => s.logStreamName?.includes(jobRunId.slice(0, 20)));
                for (const stream of streams.slice(0, 3)) {
                  let nextToken: string | undefined;
                  do {
                    const { events = [], nextForwardToken } = await cwl.send(new GetLogEventsCommand({
                      logGroupName: logGroup, logStreamName: stream.logStreamName!, startFromHead: true, limit: 1000, nextToken,
                    }));
                    for (const e of events) { if (e.message) out.push(`[${new Date(e.timestamp || 0).toISOString()}] ${e.message.trim()}`); }
                    if (nextForwardToken === nextToken) break;
                    nextToken = nextForwardToken;
                  } while (nextToken);
                }
                if (out.length > 0) break;
              } catch {}
            }
            return out;
          };

          // Up to 6 attempts × 10s = ~60s, enough for CloudWatch to flush the job output.
          for (let attempt = 0; attempt < 6; attempt++) {
            allLogs = await collectOnce();
            if (allLogs.length > 0) break;
            await new Promise((r) => setTimeout(r, 10000));
          }

          if (allLogs.length > 0) {
            const { PutObjectCommand } = await import("@aws-sdk/client-s3");
            // 日志存**该区**的 scripts 桶(与脚本同桶;home 值与旧 env 表达式逐字相等)。
            const bucket = landing.scriptsBucket;
            const s3 = await s3ClientFor(landing.region);
            logS3Key = `logs/${taskId}/${runId}.log`;
            await s3.send(new PutObjectCommand({
              Bucket: bucket, Key: logS3Key,
              Body: allLogs.join("\n"),
              ContentType: "text/plain",
            }));
          }
        } catch {}

        // SYNC-FIX(B1): backfill real row metrics by parsing the job's own log markers
        // (ROWS_READ / REDSHIFT_ROWS_WRITTEN), instead of leaving the run stuck at 0/0.
        // 序 37 B-62:解析规则收到唯一作者 lib/sync/run-metrics.ts —— S3 目标不再一律抄 rowsRead,
        //   覆盖 / 合并按 SYNC_VERIFY 的 target_rows 取真值(规则与兜底理由见那个文件头)。
        let rowsRead = 0, rowsWritten = 0;
        try {
          ({ rowsRead, rowsWritten } = parseSyncRunMetrics(allLogs, status));
        } catch {}

        // 防线①:parse the SYNC_DEGRADED marker the Glue script emits when the fast COPY path
        // fell back to slow row-by-row INSERT. A degraded run still SUCCEEDS (data is not lost),
        // so this NEVER downgrades status — it only surfaces the silent performance regression on
        // the run record + logs so the next occurrence (new type/permission blind spot) is visible
        // instead of hiding for months like the TINYINT→Spectrum-Scan-Error case did.
        let degraded: { reason: string; detail: string } | null = null;
        try {
          const dm = /SYNC_DEGRADED\s+reason=(\S+)\s+table=\S+\s+detail=(.*)/.exec(allLogs.join("\n"));
          if (dm) degraded = { reason: dm[1], detail: (dm[2] || "").slice(0, 300) };
        } catch {}

        // Update run record
        // 序 37 B-62(落库顺序):run 行的终态字段(status / finishedAt / duration / error / logS3Key / metrics / degraded)
        //   **在这里就写**,放在水位回写与 OM 回填之前。原来它排在 OM 回填之后,而回填是 best-effort、真环境实测 > 3 分钟;
        //   页面轮询的 glue-status 路由早已把 status 翻成 succeeded ⇒ 用户在运行历史里看到「成功 · 0 · 0 · 日志尚未生成」
        //   好几分钟(看起来像什么都没同步)。水位回写与 OM 回填不改 run 行的任何字段,顺序保持在后面。
        // @kf-batch 52-P52.2-W2a-run-stamp
        // 原注释记的那次真事故(metrics/status/duration/error 是 DDB 保留字,漏起别名 ⇒
        // **整条写入失败**,status/finishedAt/logS3Key/metrics 一起被写没)——
        // 唯一写通道现在对 set 里的**每个** key 无条件起别名,这类 bug 结构上不可能再犯。
        await updateRunRecord({
          taskId, runId,
          set: {
            status, finishedAt: now, duration: JobRun.ExecutionTime || 0,
            error: errCls.message || null, ...(JobRun.ErrorMessage ? { errorRaw: JobRun.ErrorMessage, errorKind: errCls.kind } : {}), logS3Key: logS3Key || null,
            metrics: { rowsRead, rowsWritten },
            degraded,  // 防线①:非空=本次跑成了但走了慢兜底路径,前端/告警可据此提示
          },
          // @kf-batch 50-WP7-sync-pushdown —— 章按真落点显式盖(同步任务的区维在 targets[],见 start 处说明)
          stamp: resolveRunStamp(task, landing.targetId),
        });

        // SYNC: 增量真前进 —— 解析 INC_WATERMARK 标记,成功后把 task.incrementalValue 推进到本次
        // 读到的最大水位(取多表/多条标记中的最大)。下次启动生成脚本时即以新水位为谓词,只读更新行。
        // @kf-batch 37-sync-backfill —— 🔴 补数重跑的是**历史某天**:不许把增量水位推成那一天读到的最大值
        //   (水位只进不退的前提是「每次都读到最新」,补数恰好相反 ⇒ 推了就是把水位往回拨,下一次在线增量重读一大段)。
        //   补数计划本身也拒增量任务(backfill/plan 路由),这里是第二道。
        if (status === "succeeded" && triggeredBy !== "backfill") {
          try {
            const joined = allLogs.join("\n");
            const wmRe = /INC_WATERMARK\s+col=\S+\s+max=(.+)/g;
            let best = "";
            let wm: RegExpExecArray | null;
            while ((wm = wmRe.exec(joined)) !== null) {
              const v = wm[1].trim();
              if (!v) continue;
              if (best === "") { best = v; continue; }
              const bothNum = !isNaN(Number(v)) && !isNaN(Number(best));
              if (bothNum) { if (Number(v) > Number(best)) best = v; }
              else if (v > best) best = v;
            }
            if (best !== "") {
              // @kf-batch 50-B08-sync-task-write-guard —— 🔴 后台轮询里写回:任务很可能**已被删**
              await updateSyncTaskIfExists({
                taskId,
                UpdateExpression: "SET incrementalValue = :wm, updatedAt = :now",
                ExpressionAttributeValues: { ":wm": best, ":now": now },
              }).catch(() => {});
            }
          } catch {}
        }
        if (status === "succeeded") {
          // 🔴 列级血缘根治(配套层):数据真正写完 → 目标 Redshift/S3 Tables 已有真实列。此时
          // 回填真实列 schema 到 OM(替换 _row 占位),再重推列级血缘。绑定在"数据落地成功"事件上,
          // 让全表同步【开箱即有列级血缘】,不再依赖手动点"Sync Redshift columns"或默认关闭的 ingestion。
          // best-effort:失败绝不影响同步成功态(血缘是旁路)。见 governance/sync-redshift-schema 的根治说明。
          // @kf-batch 50-o4REG-sync-om-per-target —— 🔴 「回填什么、回填到哪个 service」只有一个作者
          //   (`backfillSyncOmAfterSuccess`):主控区 = 原来那四个回填原顺序原调用;其它区 = 只回填这个任务、
          //   只在该区取真实列、写该区的 per-target service、再重推这个任务的列级血缘。本路由不再判区。
          try {
            const { backfillSyncOmAfterSuccess } = await import("@/lib/openmetadata/om-sync-backfill");
            await backfillSyncOmAfterSuccess(om.task, om.ds, om.place);
          } catch { /* 血缘旁路,best-effort,绝不影响同步成功态 */ }
        }

        // Update task status
        // @kf-batch 50-B08-sync-task-write-guard —— 🔴 后台轮询里写回终态:任务很可能**已被删**
        //   (Glue 作业跑几分钟,用户完全可能中途把任务删掉)⇒ 盲写会把它凭空造回来。
        await updateSyncTaskIfExists({
          taskId,
          UpdateExpression: "SET #s = :s, updatedAt = :now",
          ExpressionAttributeNames: { "#s": "status" },
          // 批同步跑成 = succeeded(终态);曾误写 stopped 导致 UI 显示"已停止"与事实(成功)不符。
          ExpressionAttributeValues: { ":s": status === "succeeded" ? "succeeded" : "error", ":now": now },
        });

        // SCH-03: on success, fan out to any configured downstream tasks/workflows.
        // @kf-batch 37-sync-backfill —— 🔴 补数不扇出下游:下游被触发时不带业务日期 ⇒ 补 N 天 = 下游按「今天」白跑 N 次
        //   (补数与在线调度隔离是补数中心的硬约束;离线作业补数走 runEtlJob 本来就不扇出,这里与它一致)。
        if (status === "succeeded" && triggeredBy !== "backfill") fireDownstreamOnce(taskId, runId).catch(() => {});

        return;
      }
    } catch {}
  }
}
