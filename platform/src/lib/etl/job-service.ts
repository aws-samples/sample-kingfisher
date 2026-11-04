// ETL 开发模块服务：运行用户自写的 Glue PySpark 脚本作业 / Redshift SQL 作业，
// 并把运行记录写入 bgp-task-runs（监控页复用）。引擎复用现有 Glue / Redshift Data API。

import { homeRegion } from "@/lib/place/home-region";
import {
  GlueClient,
  GetJobCommand,
  CreateJobCommand,
  UpdateJobCommand,
  DeleteJobCommand,
  StartJobRunCommand,
  GetJobRunCommand,
} from "@aws-sdk/client-glue";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  RedshiftDataClient,
  BatchExecuteStatementCommand,
  DescribeStatementCommand,
} from "@aws-sdk/client-redshift-data";
import { PutCommand, UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { ulid } from "ulid";
import type { EtlJob } from "@/types/etl-job";
// 业务日期参数的单一作者(保留键清单 / StartJobRun Arguments 都从它取,不再手抄 4 个)
import { renderTemplate, paramSet, todayDs, runParamArguments, RUN_PARAM_ARG_NAMES } from "@/lib/etl/run-params";
import { FLEX_CAPABLE_WORKER_TYPES } from "@/lib/etl/worker-types";
// Glue 版本的单一作者 —— 作业行里存了就用它;没存 ⇒ 按它被写下时的缺省 5.1(不跟新缺省走,升级不改存量作业);清单外当场拒(不替用户猜)
import { glueVersionOfRecord } from "@/lib/sync/glue-version";
import { guard } from "@/lib/cookbook";
import { acquireJobRunLock, releaseJobRunLock, renewRunLockIfDue, keepRunLockForReconcile, RunLockBusy, type RunLock } from "@/lib/etl/run-lock";
// task-runs 唯一写通道(50 SPEC §6 S10)。
import { putRunRecord, updateRunRecord, resolveRunStamp, type RunOwner } from "@/lib/monitor/run-records";
// Redshift SQL 作业成功时把受影响行数写进 run 行 `metrics.rowsAffected`(唯一作者)
import { affectedRowsMetrics } from "@/lib/redshift/affected-rows";
// Glue 作业名 per-target 单一作者(同 region 多 target 不许同名)
import { glueJobNameFor, glueJobNamesOf } from "@/lib/etl/glue-job-name";
// 运行提交的可审计闭包(跨法域 target 提交前写区域审计;定时 run 观测后补写)
import { residencyAudit, auditActorOrService, auditObservedScheduledRun, type ResidencyActor } from "@/lib/exec-env/residency-audit";

/** 盖章只需要 jobId + 归属两字段;用最小结构接口,让"只有 jobId 的调用方"在编译期就露出来。 */
type EtlJobRef = RunOwner & { jobId: string };

// 根治·裂缝C:作业级运行锁的等待预算。backfill/schedule 触发→排队等前序 run 终态(串行,避免并发
// DROP+CTAS 撞同表 OID);手动 run/rerun→不等(waitMs=0),抢不到即"作业运行中"提示,避免狂点堆积。
const RUN_LOCK_WAIT_BACKFILL_MS = 45 * 60 * 1000; // 覆盖最长前序作业(Glue~40min)
function runLockWaitMs(triggeredBy?: string): number {
  return triggeredBy === "backfill" || triggeredBy === "schedule" ? RUN_LOCK_WAIT_BACKFILL_MS : 0;
}

// 🔴 **模块级 home 客户端已全部删掉**(原来是 `glue` / `s3` / `rsData` 三个)。
// 删掉而不是留着"给 home 用",是因为它们正是这一类 bug 的**唯一来源**:
// 谁顺手用一下,非 home 的调用就静默打回 home(建作业建在 home、脚本传到 home 的桶、
// 查 JobRun 查不到 ⇒ 把成功的 run 写成 failed)。
// 现在每一处都必须先解析 target 落点(`resolveGlueBinding` / `resolveRedshiftBinding`)
// 再按 region 取客户端(`glueClientFor` / `s3ClientFor` / `redshiftDataClientFor`)——
// 于是"忘记按区取客户端"在**结构上**不可能:没有一个现成的全局客户端可以拿。

const USER_ID = "default-user";
const SCRIPTS_BUCKET = process.env.GLUE_SCRIPTS_BUCKET || `bgp-glue-scripts-${process.env.AWS_ACCOUNT_ID}`;

// Redshift admin (superuser) secret — re-exported from the shared module so all callers
// (job-service, GenBI, Redshift query page, metrics, quality) use ONE identity → consistent
// table ownership across run-now / scheduled / query / GenBI paths.
import { getRedshiftSecretArn } from "@/lib/redshift/admin-secret";
// 🔴 `resolveWorkgroup` 的 import 已删:落点解析整体上移到 `resolveRedshiftBinding`
// (它内部对 home 仍调同一个 `resolveWorkgroup`,所以 home 逐字节等价)。
// 留着这个 import 会让人以为本文件还有第二条落点解析路径 —— 那正是收编要消灭的形态。
import {
  resolveRedshiftBinding,
  bindingTargets,
  redshiftClientForTarget,
  resolveGlueBinding,
  glueClientForTarget,
  // run 章的唯一作者
  stampedTargetOf,
} from "@/lib/exec-env/data-plane-target";
// 执行角色解析 / 预检 / 依赖 URI 的唯一作者
import { resolveExecutionRoleArn } from "@/lib/execution-role/resolve";
import { preflightExecutionRole, assertPreflightPassed } from "@/lib/execution-role/preflight";
import { s3UrisFromGlueConfig, localizePlatformDepUris } from "@/lib/execution-role/s3-uris";
import { redshiftDataClientFor, glueClientFor, s3ClientFor } from "@/lib/exec-env/target-clients";
import { HOME_TARGET_ID, isHome } from "@/lib/exec-env/target-id";
// 补数标记字段的唯一作者
import { backfillRunExtra, type BackfillRunRef } from "@/lib/backfill/run-extra";
export { getRedshiftSecretArn };

// optional run parameters (business date + trigger origin) for parameterized runs,
// backfill and rerun.
export interface RunOpts {
  runDate?: string; // YYYY-MM-DD business date; defaults to today (UTC)
  triggeredBy?: string; // "manual" | "backfill" | "rerun" | "dryrun" | "schedule"
  /**
   * 🔴 本次运行落在绑定里的**哪一个** target。缺省 = 绑定的第一个(存量单绑时就是它自己)。
   * 一个定义可绑多区,但**一次 run 只发生在一个区** —— 扇出由调用方(路由)逐 target 调本函数,
   * 每次传不同的 `targetId`,于是每条 run 各自盖自己的章。
   */
  targetId?: string;
  /** 同一次多区扇出的关联标识(由运行路由用 `runGroupIdFor(runTargets)` 产出,单区为 undefined)。只透传。 */
  runGroupId?: string;
  /**
   * 运行提交的行为主体(区域审计 entry=run-submit 用;SPEC v3.23 §3.2)。路由传用户 ⇒ 走同意前置;
   * 缺省(backfill 执行器 / 内部调用)⇒ 平台服务主体、跳过同意前置(没有用户可同意),审计照写。
   */
  actor?: ResidencyActor;
  /** 补数实例引用(计划 id + 节点 id):有则 run 行带 `backfillPlanId` / `backfillNode`(与工作流 SQL 节点补数同形;唯一作者 lib/backfill/run-extra.ts)。 */
  backfill?: BackfillRunRef;
}

export interface RunResult {
  runId: string;
  // 本条 run 实际跑在哪个 target(扇出后调用方要能分辨)。
  targetId?: string;
  glueJobName?: string;
  glueJobRunId?: string;
  statementId?: string;
  runDate?: string;
}

// 两个写入点改走**唯一写通道**;第一个参数由 `jobId` 换成**作业行**,因为 run 的归属
// (projectId)以作业行为权威(不取请求头,见 `resolveRunStamp` 说明)。
async function createRunRecord(
  job: EtlJobRef,
  runId: string,
  taskType: string,
  extra: Record<string, unknown>,
  triggeredBy = "manual",
  // 🔴 **必须显式传本次生效的 target**。作业行改成 `targets[]` 之后,`job.targetId` 通常是
  // undefined ⇒ `resolveRunStamp(job)` 会把章盖成 `tgt_home`,**哪怕这条 run 真的跑在 us-west-2**。
  // 那种错最阴:run 跑对了、监控页却把它归到 home,区域筛选从此不可信。
  effectiveTargetId?: string,
  // 多区扇出的关联标识,只透传到写通道的一等参数(不许塞进 extra)。
  runGroupId?: string
) {
  await putRunRecord({
    taskId: job.jobId,
    runId,
    taskType,
    triggeredBy,
    stamp: resolveRunStamp(job, effectiveTargetId),
    runGroupId,
    extra,
  });
}

async function finishRunRecord(
  job: EtlJobRef,
  runId: string,
  status: string,
  extra: Record<string, unknown> = {},
  // 同 createRunRecord:补章只补空缺,但传对了才不会补错。
  effectiveTargetId?: string
) {
  await updateRunRecord({
    taskId: job.jobId,
    runId,
    set: { status, finishedAt: new Date().toISOString(), ...extra },
    stamp: resolveRunStamp(job, effectiveTargetId),
  });
}

async function updateJobStatus(jobId: string, status: string, runId: string) {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.ETL_JOBS,
      Key: { userId: USER_ID, jobId },
      UpdateExpression: "SET #s = :s, lastRunId = :r, lastRunStatus = :ls, lastRunAt = :t, updatedAt = :t",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": status, ":r": runId, ":ls": status, ":t": new Date().toISOString() },
    })
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 读时对账(reconcile-on-read):作业列表/详情纯读 DB,若进程内 pollGlueRun/pollRedshiftRun 因
// 重启丢失,作业会永久卡 running。此函数对 lastRunStatus==="running" 的作业查真实后端态(Glue
// JobRun / Redshift statement)并回写纠正,使列表显示真实状态。返回纠正后的作业(可能原样)。
const RUN_DONE = ["SUCCEEDED", "FAILED", "STOPPED", "ERROR", "TIMEOUT"];
export async function reconcileEtlJob(job: any): Promise<any> {
  if (!job || !job.lastRunId) return job;
  try {
    const { Item: run } = await docClient.send(new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId: job.jobId, runId: job.lastRunId } }));
    if (!run) return job;
    // 定时 run 的**观测后审计**补写(SPEC v3.23 §3.2:MWAA 是执行体,平台不在提交路径上);
    //    幂等(pending 抢占协议),失败不影响对账;非定时 / home 行零 I/O 直接返回。
    await auditObservedScheduledRun({ taskId: job.jobId, runId: job.lastRunId, targetId: run.targetId, triggeredBy: run.triggeredBy, residencyAuditId: run.residencyAuditId });
    if (job.lastRunStatus !== "running") return job;
    // (顺带:取消不许被对账改写)
    // 🔴 判据要看**run 行自己**的状态,不能只看作业行:组取消把 run 行写成了 `stopped`,
    //    而作业行的 `lastRunStatus` 是**另一份**(取消不写它)⇒ 只看作业行就会一路走到下面
    //    「去后端重新判一次」,把「用户取消」判成 `failed`(唯一写通道上另有一道条件写兜底)。
    // 🔴 而且这里**不能只是 return**:run 行已终态、作业行还挂着 running,那正是对账要修的东西 ——
    //    用 **run 行**回填作业行(run 行才是 run 级状态的权威来源),而不是再去问一次后端。
    if (typeof run.status === "string" && run.status !== "running") {
      await updateJobStatus(job.jobId, run.status, job.lastRunId).catch(() => {});
      return { ...job, status: run.status, lastRunStatus: run.status };
    }
    let real: string | null = null; let extra: Record<string, unknown> = {};
    if (run.glueJobRunId && run.glueJobName) {
      // 🔴🔴 与下面 Redshift 那半**同一类**:必须用**这条 run 实际执行的那个 region** 的 Glue 客户端。
      // 用模块级 home 客户端查非 home 的 JobRun ⇒ `EntityNotFoundException` ⇒ 落进
      // 「run 不存在于 Glue(被删)⇒ 判失败」那一支 ⇒ **把一条其实成功的 run 写成 failed**。
      // 🔴 解析 region 失败时**什么都不写**(fail-closed 到"不动"):没确认就不下结论。
      let glueForRun: { send: (c: unknown) => Promise<any> } | null = null;
      try {
        glueForRun = (await glueClientForTarget(stampedTargetOf(run))) as any;
      } catch (e) {
        console.warn("[etl] 对账取不到该 Glue run 的执行区域,本轮不改状态", job.jobId, job.lastRunId, e);
      }
      if (glueForRun) {
        try {
          const { JobRun } = await glueForRun.send(new GetJobRunCommand({ JobName: run.glueJobName, RunId: run.glueJobRunId }));
          const st = JobRun?.JobRunState;
          // `STOPPED` 同理:BatchStopJobRun 的结果 = 被取消,不是失败
          if (st && RUN_DONE.includes(st)) { real = st === "SUCCEEDED" ? "succeeded" : st === "STOPPED" ? "stopped" : "failed"; extra = { duration: JobRun?.ExecutionTime || 0, error: JobRun?.ErrorMessage || null }; }
          else if (!st) real = "failed"; // run 不存在于 Glue(被删)→ 判失败,不再假 running
        } catch { /* 查不到则保留 */ }
      }
    } else if (run.statementId) {
      // 🔴🔴 **必须用这条 run 实际执行的那个 region 的客户端**。原来用模块级 home 客户端 ⇒
      // 非 home 的 run 一律 `Query does not exist.` ⇒ 落到下面那个"记录已过期"分支 ⇒
      // **把一条其实成功的 run 写成 failed**(2026-09-04 用户实测报的 bug 的同源、且更严重的一半:
      // 日志路径只是显示不出来,这里是**写坏状态**)。
      // 🔴 解析 region 本身失败时**什么都不写**(fail-closed 到"不动"):
      // 写状态的路径不许在"没确认"的情况下下结论。
      let rsForRun: { send: (c: unknown) => Promise<any> } | null = null;
      try {
        rsForRun = (await redshiftClientForTarget(stampedTargetOf(run))) as any;
      } catch (e) {
        console.warn("[etl] 对账取不到该 run 的执行区域,本轮不改状态", job.jobId, job.lastRunId, e);
      }
      if (rsForRun) {
        try {
          const desc = await rsForRun.send(new DescribeStatementCommand({ Id: run.statementId }));
          const st = desc.Status;
          if (st === "FINISHED") { real = "succeeded"; extra = affectedRowsMetrics(desc); } // 对账路也记受影响行数
          // 🔴 `ABORTED` = **这条语句被取消了**(CancelStatement 的结果),
          //    不是「跑挂了」。映射成 failed ⇒ 用户自己按的取消在页面上显示成失败、组派生状态从
          //    cancelled 变 failed(EMR 侧 `mapEmrState` 早就把 CANCELLED 映射成 stopped —— 这里是漏的那一处)。
          else if (st === "ABORTED") { real = "stopped"; extra = { error: desc.Error || null }; }
          else if (st === "FAILED") { real = "failed"; extra = { error: desc.Error || null }; }
        } catch (e: any) {
          // Redshift statement 历史会过期(ResourceNotFoundException);此时无法确认成功 → 判失败,
          // 不再永久卡 running(与 Flink deleted 降级同理)。其它瞬时错误则保留待下次对账。
          if (e?.name === "ResourceNotFoundException" || /does not exist/i.test(String(e?.message || ""))) {
            real = "failed"; extra = { error: "Redshift 执行记录已过期,无法确认结果(状态按失败处理)" };
          }
        }
      }
    }
    if (real && real !== "running") {
      await finishRunRecord(job, job.lastRunId, real, extra).catch(() => {});
      await updateJobStatus(job.jobId, real, job.lastRunId).catch(() => {});
      return { ...job, status: real, lastRunStatus: real };
    }
  } catch { /* 对账失败不影响列表 */ }
  return job;
}

// ---- Glue PySpark 脚本作业 -------------------------------------------------
export async function ensureGlueJob(job: EtlJob, targetId: string = HOME_TARGET_ID): Promise<string> {
  // 🔴 **落点按 target 解析**(W3-g:Glue 可以在非 home 跑了)。四样一起来:
  //    region(建客户端)/ 脚本桶(上传脚本)/ 执行角色 / S3Tables 桶(注入 catalog conf)。
  //    home 走的仍是原来那套 env ⇒ 逐字节等价。
  const landing = await resolveGlueBinding({ targetId });
  const glueC = await glueClientFor(landing.region);
  const s3C = await s3ClientFor(landing.region);
  // 执行角色:作业自定义 executionRoleArn 优先,留空回退**该 target 的** Glue 角色。
  // 单一作者 resolveExecutionRoleArn;自定义角色在建 / 改 Glue 作业**之前**按本落点预检 —— 信任 glue.amazonaws.com
  //   + 引擎基线 + 依赖库(--extra-jars / --extra-py-files,已按本区换桶)/ 脚本里 s3:// 引用的每个对象,缺 ⇒ 抛
  //   ExecRolePreflightError(400 可修,作业定义不动)。客户现网 2026-11-03 的「保存成功、Glue 启动期 403」就是在这里被提前量出来。
  const { roleArn, isCustom } = resolveExecutionRoleArn({
    custom: job.glueConfig?.executionRoleArn,
    fallback: landing.roleArn,
    missingMessage: "未指定执行角色:请在作业高级参数填写执行角色 ARN,或部署配置 GLUE_ROLE_ARN",
  });
  if (isCustom) {
    const pf = await preflightExecutionRole({
      engine: "glue", roleArn, targetId,
      extraS3Uris: s3UrisFromGlueConfig({
        extraJars: localizePlatformDepUris(job.glueConfig?.extraJars, landing),
        extraPyFiles: localizePlatformDepUris(job.glueConfig?.extraPyFiles, landing),
      }),
      scriptCode: job.script,
    });
    assertPreflightPassed(pf, { engine: "glue", roleArn, targetId, what: `etl-job ${job.jobId}` });
  }

  const scriptKey = `glue-scripts/etl/${job.jobId}.py`;
  await s3C.send(new PutObjectCommand({ Bucket: landing.scriptsBucket, Key: scriptKey, Body: job.script, ContentType: "text/x-python" }));

  // 🔴 作业名 **per-target**(2026-09-真环境抓到:原「跨区同名」在同 region 两个 target 下互相覆盖 Role,
  //    tgt_usw2_a 的 run 用了 tgt_usw2_b 的执行角色)。唯一作者 `glueJobNameFor`:home 仍是 `bgp-etl-<id12>`(存量不变),
  //    非 home 带 target slug。作业行的 `glueJobName` 只是 home 名的展示副本,**不再当权威读**。
  const jobName = glueJobNameFor(job.jobId, targetId);
  const cfg = job.glueConfig || {};
  const scriptLocation = `s3://${landing.scriptsBucket}/${scriptKey}`;
  // 注册 S3 Tables 的 Iceberg 目录 s3tablescatalog（与「数据同步」Glue 作业一致），
  // 否则脚本里 spark.table("s3tablescatalog.<ns>.<表>") 会报
  // [REQUIRES_SINGLE_PART_NAMESPACE]（Spark 把它当默认 hive 目录的两段命名空间）。
  const account = process.env.AWS_ACCOUNT_ID || "";
  const tableBucket = landing.tableBucket;
  const s3tablesConf = [
    "spark.sql.catalog.s3tablescatalog=org.apache.iceberg.spark.SparkCatalog",
    "spark.sql.catalog.s3tablescatalog.catalog-impl=org.apache.iceberg.aws.glue.GlueCatalog",
    `spark.sql.catalog.s3tablescatalog.glue.id=${account}:s3tablescatalog/${tableBucket}`,
    "spark.sql.catalog.s3tablescatalog.io-impl=org.apache.iceberg.aws.s3.S3FileIO",
    `spark.sql.catalog.s3tablescatalog.warehouse=arn:aws:s3tables:${landing.region}:${account}:bucket/${tableBucket}`,
  ].join(" --conf ");
  // 参数齐全暴露:自定义 Job parameters(--key)合入 DefaultArguments。
  // 平台保留键不允许覆盖(会破坏 S3 Tables 目录注入/业务日期参数);用户的 --conf 追加到平台 conf 链后面。
  // 🔴 平台注入的这几项**用户不许覆盖**:`--bgp_*` 是"你这次跑在哪个区"的事实,
  //    让用户 jobParameters 盖掉它 = 允许把产物写到别的区(驻留承诺形同虚设)。
  // 业务日期参数(15 个)整组保留:运行时由 StartJobRun 的 Arguments 注入,用户 DefaultArguments 写了也会被盖掉,
  //   列进保留键让「写了没用」在定义阶段就被丢弃,而不是看起来接受了。清单来自单一作者 RUN_PARAM_ARG_NAMES(原来手抄 4 个 ⇒ 漏 2 个)。
  const RESERVED_ARGS = new Set(["--datalake-formats", "--TempDir", ...RUN_PARAM_ARG_NAMES, "--job-bookmark-option", "--extra-jars", "--extra-py-files",
    "--bgp_target_id", "--bgp_region", "--bgp_datalake_bucket", "--bgp_table_bucket",
    // 本区数仓三事实同样是「你这次跑在哪个区」的事实,用户不许覆盖
    "--bgp_redshift_workgroup", "--bgp_redshift_database", "--bgp_redshift_secret_arn"]);
  // 🔴🔴 配方库原来教 AI「workgroup=bgp-workgroup、database=dev 直接写死」—— 因为 Glue 这边平台**从没注入过**
  //   数仓事实(EMR 早在 2026-09-22 第九层就注入了 `spark.bgp.redshift*`),代码想读本区实名也没处读 ⇒ 只能写死主控区。
  //   ⇒ 与 EMR 同一组值、同一个作者(`resolveRedshiftBinding`):解析失败**不阻断作业**(不是所有 Glue 作业都碰数仓),
  //   但绝不静默当成「不需要」—— 打一行日志,读这几个参数的代码会当场报缺参,而不是连到别的区。
  let rsFacts: Record<string, string> = {};
  try {
    const rb = await resolveRedshiftBinding({ targetId: landing.targetId });
    rsFacts = {
      "--bgp_redshift_workgroup": rb.workgroup,
      "--bgp_redshift_database": rb.database,
      ...(rb.secretArn ? { "--bgp_redshift_secret_arn": rb.secretArn } : {}),
    };
  } catch (e) {
    console.warn(`[glue] ${landing.targetId} 解析该区 Redshift 连接事实失败(不阻断,但作业里读不到 --bgp_redshift_*):${String((e as Error)?.message || e).slice(0, 160)}`);
  }
  const defaultArgs: Record<string, string> = {
    "--datalake-formats": "iceberg",
    "--TempDir": `s3://${landing.scriptsBucket}/temp/`,
    // 🔴🔴 **把"你这次跑在哪个区、该往哪个桶写"告诉作业**。没有这几个参数,用户脚本只能
    // 硬编码一个桶名 ⇒ 多区域执行时**所有区的产物都写回同一个(通常是 home 的)桶** ——
    // 作业还会报"成功"(权限是通的),而驻留承诺已经破了。这是真环境第一次跑三引擎多区域时
    // 当场暴露出来的:EMR 在 us-west-2 的 run 原生 SUCCESS,而 usw2 桶里 0 个产物。
    // 用户脚本读法:`getResolvedOptions(sys.argv, ['bgp_datalake_bucket'])`。
    "--bgp_target_id": landing.targetId,
    "--bgp_region": landing.region,
    "--bgp_datalake_bucket": landing.datalakeBucket,
    "--bgp_table_bucket": landing.tableBucket,
    ...rsFacts,
    "--conf": s3tablesConf,
  };
  for (const [k0, v] of Object.entries((cfg.jobParameters || {}) as Record<string, string>)) {
    const k = k0.startsWith("--") ? k0 : `--${k0}`;
    if (!k.slice(2).trim() || RESERVED_ARGS.has(k)) continue;
    if (k === "--conf") defaultArgs["--conf"] = `${defaultArgs["--conf"]} --conf ${String(v).trim()}`;
    else defaultArgs[k] = String(v ?? "");
  }
  if (cfg.jobBookmark && cfg.jobBookmark !== "job-bookmark-disable") defaultArgs["--job-bookmark-option"] = cfg.jobBookmark;
  const csv = (s?: string) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean).join(",");
  // 平台「上传依赖文件」落在平台脚本桶(每个绑定区各一份、同 key),提交到哪个区就换成该区的脚本桶;客户自己的桶原样
  const extraJars = csv(localizePlatformDepUris(cfg.extraJars, landing));
  const extraPyFiles = csv(localizePlatformDepUris(cfg.extraPyFiles, landing));
  if (extraJars) defaultArgs["--extra-jars"] = extraJars;
  if (extraPyFiles) defaultArgs["--extra-py-files"] = extraPyFiles;

  const jobInput: any = {
    Role: roleArn,
    Command: { Name: "glueetl", ScriptLocation: scriptLocation, PythonVersion: "3" },
    GlueVersion: glueVersionOfRecord(cfg.glueVersion),
    NumberOfWorkers: cfg.numberOfWorkers || 2,
    WorkerType: cfg.workerType || "G.1X",
    Timeout: cfg.timeoutMinutes || 60,
    MaxRetries: cfg.maxRetries ?? 0,
    // FLEX 弹性容量更省钱但不保证即时启动;仅 G.1X/G.2X 支持 FLEX,规避 API 报错。
    ExecutionClass: cfg.executionClass === "FLEX" && FLEX_CAPABLE_WORKER_TYPES.includes(cfg.workerType || "G.1X") ? "FLEX" : "STANDARD",
    ExecutionProperty: { MaxConcurrentRuns: cfg.maxConcurrentRuns || 3 },
    DefaultArguments: defaultArgs,
    ...(cfg.connectionName ? { Connections: { Connections: [cfg.connectionName] } } : {}),
  };

  // create or update the Glue job (idempotent)
  let exists = false;
  try {
    await glueC.send(new GetJobCommand({ JobName: jobName }));
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) {
    await glueC.send(new UpdateJobCommand({ JobName: jobName, JobUpdate: jobInput }));
  } else {
    await glueC.send(new CreateJobCommand({ Name: jobName, ...jobInput }));
  }
  return jobName;
}

/**
 * 删作业时把它在**每个绑定 target** 上的 Glue 作业定义一并删掉(一个不漏)。
 * 【为什么现在补】原来删作业只撤 DAG、不删 Glue 作业定义 ⇒ 每跑一次验收就在每个 region 留一个孤儿定义
 * (2026-09-05 盘点:us-east-1 13 个 / us-west-2 10 个);per-target 命名后孤儿会按 target 数翻倍,必须随删。
 * 🔴 best-effort:定义不存在(EntityNotFound)算成功;别的错只记不抛 —— 作业行的删除不该被一个"删不掉定义"卡死,
 *    孤儿定义不计费,而删不掉行会让用户以为作业还在。返回逐 target 结果供路由回显 / 审计。
 */
export async function deleteGlueJobs(job: EtlJob): Promise<Array<{ targetId: string; name: string; ok: boolean; error?: string }>> {
  const out: Array<{ targetId: string; name: string; ok: boolean; error?: string }> = [];
  for (const { targetId, name } of glueJobNamesOf(job.jobId, bindingTargets(job))) {
    try {
      const landing = await resolveGlueBinding({ targetId });
      const glueC = await glueClientFor(landing.region);
      await glueC.send(new DeleteJobCommand({ JobName: name }));
      out.push({ targetId, name, ok: true });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/EntityNotFound/i.test(msg) || /not found/i.test(msg)) out.push({ targetId, name, ok: true });
      else {
        console.warn("[etl/job-service] 删除 Glue 作业定义失败(留为孤儿,不阻塞删作业):%s@%s %s", name, targetId, msg);
        out.push({ targetId, name, ok: false, error: msg });
      }
    }
  }
  return out;
}

export async function runGlueScriptJob(job: EtlJob, opts: RunOpts = {}): Promise<RunResult> {
  const runDate = opts.runDate || todayDs();
  const triggeredBy = opts.triggeredBy || "manual";
  // Glue 是 PySpark 命令式代码(code 引擎),cookbook 对它【不做正则改写】(§4.3,target=code 禁 fix);
  // 但【可带 antiPattern 纯检测】拦硬错——如 glue.no-jdbc-redshift(禁 jdbc:redshift 占位符连数仓)命中即
  // g.blocked=true,在此拦执行。各引擎运行时一致收口。
  const g = guard("glue", job.script);
  if (g.blocked) {
    const detail = g.violations.filter((v) => v.severity === "error").map((v) => v.title).join("；");
    throw new Error(`Glue 脚本方言校验未通过,已拦截执行:${detail}。请修正后重试。`);
  }
  // 根治·裂缝C:抢作业级运行锁再提交(与 Redshift 路径同款)。同作业 backfill 排队串行,避免并发写同一
  // 目标表(Iceberg 并发 commit / Glue MaxConcurrentRuns=3 超限抛错);手动 run 抢不到即明确报错。
  // 🔴 **Glue 现在按 target 执行**(W3-g)。锁属性必须按**这次真跑的那个 target** 算 ——
  // 与定时路径(`etl/dag-generator.ts` 用同一个 `lockAttrFor`)同一口径,否则
  // 「定时与手动算出不同属性名 ⇒ 互斥失效」那个原来把 Glue 钉在 home 的理由就真的会发生。
  // 缺省 home ⇒ 存量单绑作业的锁属性逐字节不变。
  const targetId = opts.targetId || HOME_TARGET_ID;
  // 🔴 **抢锁之前**写区域审计(entry=run-submit;SPEC v3.23 §3.2):home / 同法域 ⇒ null,一字不变;跨法域 ⇒ 同意前置 + 区域全量
  //    (脚本原文进 sqlText)+ 中央摘要,写不成 ⇒ 抛、不抢锁、不提交。放在锁前:被拒的提交不该持有作业锁。
  //    法域从绑定解析取(与下面 ensureGlueJob 用的是同一个 resolveGlueBinding;home 不读注册表)。
  const glueJurisdiction = isHome(targetId) ? "home" : (await resolveGlueBinding({ targetId })).jurisdiction;
  const audit = await residencyAudit({
    ...auditActorOrService(opts.actor),
    targetId,
    entry: "run-submit",
    triggeredBy,
    projectId: job.projectId,
    sqlText: job.script,
    knownJurisdiction: glueJurisdiction,
  });
  const lock = await acquireJobRunLock(TABLES.ETL_JOBS, job.jobId, runLockWaitMs(triggeredBy), targetId);
  if (!lock) throw new RunLockBusy("该作业正在运行中,请等待当前运行完成后再试(避免并发重建同一结果表导致失败)。");
  try {
    const jobName = await ensureGlueJob(job, targetId);
    const landing = await resolveGlueBinding({ targetId });
    const glueC = await glueClientFor(landing.region);
    // Pass the business-date params as Glue job arguments; user scripts read them via
    // getResolvedOptions(sys.argv, ['ds', ...]).
    // 全套 15 个(单一作者;原来手抄 4 个,yesterday_ds_nodash / tomorrow_ds_nodash 从没传过);
    //   调度路径(经典 DAG / serverless 运行时)在 Python 里用同一张表的 bgp_run_param_args(ds),三条路同一组参数名。
    const args: Record<string, string> = runParamArguments(runDate);
    const { JobRunId } = await glueC.send(new StartJobRunCommand({ JobName: jobName, Arguments: args }));
    const runId = ulid();
    // 章盖**这次真跑的那个 target**(不是绑定的第一个)。
    await createRunRecord(job, runId, "etl-glue", { glueJobName: jobName, glueJobRunId: JobRunId, runDate, ...(audit ? { residencyAuditId: audit.auditId } : {}), ...backfillRunExtra(opts.backfill) }, triggeredBy, targetId, opts.runGroupId);
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.ETL_JOBS,
        Key: { userId: USER_ID, jobId: job.jobId },
        UpdateExpression: "SET glueJobName = :j, #s = :s, lastRunId = :r, updatedAt = :t",
        ExpressionAttributeNames: { "#s": "status" },
        // 🔴 作业行的 `glueJobName` 恒为 **home 名**(展示副本):非 home 的 run 不许把 per-target 名写进去,
        //    否则下一次 home 运行 / workflow 节点会拿着别的 target 的作业名去 home 区找(找不到或找错)。
        ExpressionAttributeValues: { ":j": glueJobNameFor(job.jobId), ":s": "running", ":r": runId, ":t": new Date().toISOString() },
      })
    );

    pollGlueRun(job, runId, jobName, JobRunId!, lock, landing.region).catch(() => {});
    return { runId, glueJobName: jobName, glueJobRunId: JobRunId, runDate };
  } catch (e) {
    await releaseJobRunLock(lock); // 提交阶段失败→立即释放,不留僵尸锁
    throw e;
  }
}

async function pollGlueRun(
  job: EtlJobRef,
  runId: string,
  jobName: string,
  jobRunId: string,
  lock?: RunLock | null,
  // 🔴 必须按**这条 run 的执行区**建客户端:用 home 客户端查
  // 非 home 的 JobRun 会一直查不到 ⇒ 轮询白转 40 分钟、run 永远卡 running。
  execRegion?: string
) {
  const jobId = job.jobId;
  // L4 过渡:语义是缺省回落主控区(静默默认值类),再按落点改
  const glueC = await glueClientFor(execRegion || homeRegion());
  // 🔴 P0-6 订正(2026-08-29 外部审核):原注释"终态/轮询耗尽都释放作业锁"是**故意**的,
  // 动机是"避免后续 run 等 lease 过期"——但 Glue 轮询窗口只有 160×15s≈40min,而 Glue 作业
  // 可以跑更久 ⇒ 第 40 分钟释放锁时**后端还在跑**,第二个 run 立刻 DROP+CTAS 同一张表 =
  // 裂缝C 的 OID 事故复现。现在:轮询期间续租;**只有确认终态才释放**;耗尽则保持持锁。
  let reachedTerminal = false;
  try {
    for (let i = 0; i < 160; i++) {
      await sleep(15000);
      if (!(await renewRunLockIfDue(lock))) {
        // 锁已被他人抢走(lease 曾过期)⇒ 我们已不是这条 run 的持有者,停止回写终态,
        // 免得把状态写花(另一个 run 正在跑同一作业)。
        console.warn("[etl] Glue 轮询中丢锁,停止回写", jobId, runId);
        reachedTerminal = true; // 锁已不属于我们,无需也不该再 keep
        return;
      }
      try {
        const { JobRun } = await glueC.send(new GetJobRunCommand({ JobName: jobName, RunId: jobRunId }));
        const state = JobRun?.JobRunState;
        if (state && ["SUCCEEDED", "FAILED", "STOPPED", "ERROR", "TIMEOUT"].includes(state)) {
          const status = state === "SUCCEEDED" ? "succeeded" : "failed";
          await finishRunRecord(job, runId, status, {
            duration: JobRun?.ExecutionTime || 0,
            error: JobRun?.ErrorMessage || null,
          });
          await updateJobStatus(jobId, status, runId);
          reachedTerminal = true;
          return;
        }
      } catch {
        /* keep polling */
      }
    }
  } finally {
    if (reachedTerminal) await releaseJobRunLock(lock);
    else await keepRunLockForReconcile(lock, { jobId, runId, engine: "glue" });
  }
}

// ---- Redshift SQL 作业 -----------------------------------------------------
// 多语句切分:必须【先剥注释,再按分号切】。若先 split(";"),注释里的分号(如
// "-- 口径;organic 无点击")会把该行注释拦腰切断,后半段脱离 "--" 残留成非法语句
// (报 syntax error at or near "organic")。同类坑见 [[flink-sql-runner-comment-split-bug]]。
// 剥除 -- 行注释与 /* */ 块注释后再切分号。
function splitSql(script: string): string[] {
  const stripped = script
    .replace(/--[^\n]*/g, " ") // 行注释(含其中的分号)先整体剥掉
    .replace(/\/\*[\s\S]*?\*\//g, " "); // 块注释
  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function runRedshiftSqlJob(job: EtlJob, opts: RunOpts = {}): Promise<RunResult> {
  const runDate = opts.runDate || todayDs();
  const triggeredBy = opts.triggeredBy || "manual";
  const rendered = renderTemplate(job.script, paramSet(runDate));
  // (运行时安全网,用户拍板):即便脚本是用户手改的,执行前也过方言校验。
  //  · 可机械纠正的方言违规(如 Redshift CTAS 误写 IF NOT EXISTS)→ 自动纠正后再跑;
  //  · error 级无法自动修(blocked)→ 拒绝执行并明确报错(经 run 路由 try/catch → apiError),不硬跑必报错的 SQL。
  // guard 幂等(生成时已 guard 过的脚本重复跑无害),纯 CPU 无网络。
  const g = guard("redshift", rendered);
  if (g.blocked) {
    const detail = g.violations.filter((v) => v.severity === "error").map((v) => v.title).join("；");
    throw new Error(`SQL 方言校验未通过,已拦截执行(避免跑必报错的 SQL):${detail}。请修正后重试。`);
  }
  const statements = splitSql(g.code);
  if (statements.length === 0) throw new Error("SQL 为空");
  // 🔴 region / workgroup / database / 凭证 **四样一起**按作业绑定的执行目标解析。
  // 只补其中一两样是最危险的形态:region 对了而 workgroup 还是 home ⇒ 不报错,
  // 只是"看起来正常地连到了别的区域"(见 `data-plane-target.ts` 文件头)。
  // home 缺省逐字节等价;非 home 走准入 + 组件前置 + 描述符落点 + §3.9 凭证工厂。
  const binding = await resolveRedshiftBinding({
    // 本次运行落在绑定里的哪个 target(缺省取第一个)。
    targetId: opts.targetId || bindingTargets(job)[0],
    projectId: job.projectId,
    workgroupOverride: job.redshiftConfig?.workgroupName,
    databaseOverride: job.redshiftConfig?.database,
  });
  const workgroup = binding.workgroup;
  const database = binding.database;
  const client = redshiftDataClientFor(binding.region);

  // 抢锁之前写区域审计(entry=run-submit;与 Glue 路径同一口径;SQL 原文进 sqlText)
  const audit = await residencyAudit({
    ...auditActorOrService(opts.actor),
    targetId: binding.targetId,
    entry: "run-submit",
    triggeredBy,
    projectId: job.projectId,
    sqlText: statements.join(";\n"),
    knownJurisdiction: binding.jurisdiction,
  });

  // 根治·裂缝C:抢作业级运行锁再提交。同作业已有 run 在跑→backfill/schedule 排队等其终态(串行,
  // 避免 N 个 DROP+CTAS 并发撞同表 OID);手动 run 抢不到则明确报错(不狂点堆积)。锁在 poll 终态释放。
  // 🔴 锁属性名带 target:**同 target 同作业互斥、不同 target 同作业并行**(SPEC §3.6 的不变量)。
  // 不带 target 会把两个区域的同一作业串成一条队 —— 等于把多区域并行的价值抹掉,而且**不报错**、
  // 只是变慢,所以只能靠门禁钉。home 时属性名与存量**逐字节相同**(并存期不分裂)。
  const lock = await acquireJobRunLock(TABLES.ETL_JOBS, job.jobId, runLockWaitMs(triggeredBy), binding.targetId);
  if (!lock) throw new RunLockBusy("该作业正在运行中,请等待当前运行完成后再试(避免并发重建同一结果表导致失败)。");
  let Id: string | undefined;
  try {
    // 凭证已在 binding 里解析好(非 home 恒非空、home 保留既有三元语义)。
    const SecretArn = binding.secretArn;
    ({ Id } = await client.send(
      // 跨法域 run 的语句以 auditId 作 StatementName(statement ↔ 区域审计关联;home 不设,逐字节不变)
      new BatchExecuteStatementCommand({ Sqls: statements, WorkgroupName: workgroup, Database: database, ...(SecretArn ? { SecretArn } : {}), ...(audit ? { StatementName: audit.auditId } : {}) })
    ));
    const runId = ulid();
    await createRunRecord(
      job,
      runId,
      "etl-redshift",
      // 🔴 **`extra` 里绝不能带 `targetId`**:归属只能经 `stamp` 参数落地,`putRunRecord` 会
      // 在运行期 `assertStampable` 抛(52 SPEC §1)。它是**运行期**校验、mock 掉写通道的单测
      // 测不出来 ⇒ W3-a 真环境验收里表现为「所有 Redshift 作业运行 500」。
      // target 由下一个参数(第 6 个)盖章,这里写第二遍既多余又致命。
      { statementId: Id, statementCount: statements.length, runDate, ...(audit ? { residencyAuditId: audit.auditId } : {}), ...backfillRunExtra(opts.backfill) },
      triggeredBy,
      binding.targetId, // 🔴 本次生效的 target,别让章回落 home
      opts.runGroupId
    );
    await updateJobStatus(job.jobId, "running", runId);

    // 🔴 轮询必须用**提交时那个 region 的客户端**:Redshift Data API 的 statementId 是 **region 内**的,
    // 拿 home 的客户端去 Describe 非 home 的 statementId 会一直查不到 ⇒ run 永远停在 running,
    // 4 分钟后轮询耗尽还会**保持持锁**(见 pollRedshiftRun 的 P0-6 订正)= 该作业彻底卡死。
    pollRedshiftRun(job, runId, Id!, true, lock, binding.region, binding.targetId).catch(() => {});
    return { runId, statementId: Id, runDate, targetId: binding.targetId };
  } catch (e) {
    // 提交阶段就失败(submit 抛错)→ 立即释放锁,不留僵尸锁卡死后续 run(否则要等 90min lease)。
    await releaseJobRunLock(lock);
    throw e;
  }
}

// Dry-run a Redshift SQL job: render params, then EXPLAIN each statement. EXPLAIN computes a
// query plan WITHOUT executing, so it validates syntax/objects and never mutates data.
// Statements that cannot be EXPLAINed (e.g. DROP / plain CREATE TABLE) will surface as a
// failure for that statement — surfaced to the user as "this statement type can't be dry-run".
export async function dryRunRedshiftSqlJob(job: EtlJob, opts: RunOpts = {}): Promise<RunResult> {
  const runDate = opts.runDate || todayDs();
  const rendered = renderTemplate(job.script, paramSet(runDate));
  // 试运行也过同一方言校验,让 EXPLAIN 校验的是"实际会跑的纠正后 SQL"(与正式运行一致)。
  const g = guard("redshift", rendered);
  if (g.blocked) {
    const detail = g.violations.filter((v) => v.severity === "error").map((v) => v.title).join("；");
    throw new Error(`SQL 方言校验未通过:${detail}。请修正后再试运行。`);
  }
  const statements = splitSql(g.code);
  if (statements.length === 0) throw new Error("SQL 为空");
  // 试运行与正式运行必须**同一落点同一身份**,
  // 否则"试运行过了、正式跑报权限/打到别的区" —— 属主分叉那类症状本仓修过多次。
  const binding = await resolveRedshiftBinding({
    targetId: opts.targetId || bindingTargets(job)[0],
    projectId: job.projectId,
    workgroupOverride: job.redshiftConfig?.workgroupName,
    databaseOverride: job.redshiftConfig?.database,
  });
  const workgroup = binding.workgroup;
  const database = binding.database;
  const client = redshiftDataClientFor(binding.region);

  // 试运行也是一次跨法域数据操作(EXPLAIN 会读元数据):同样先写区域审计(triggeredBy=dryrun)
  const audit = await residencyAudit({
    ...auditActorOrService(opts.actor),
    targetId: binding.targetId,
    entry: "run-submit",
    triggeredBy: opts.triggeredBy || "dryrun",
    projectId: job.projectId,
    sqlText: statements.join(";\n"),
    knownJurisdiction: binding.jurisdiction,
  });

  // EXPLAIN only applies to query/DML statements; pure DDL (CREATE/DROP/TRUNCATE/ALTER)
  // can't be EXPLAINed, so skip those rather than spuriously failing the dry-run.
  const EXPLAINABLE = /^\s*(select|with|insert|update|delete)\b/i;
  const toExplain = statements.filter((s) => EXPLAINABLE.test(s));
  const runId = ulid();
  if (toExplain.length === 0) {
    await createRunRecord(
      job,
      runId,
      "etl-redshift-dryrun",
      { statementCount: statements.length, runDate, dryRun: true, note: "无可 EXPLAIN 的查询/DML 语句（纯 DDL），已跳过校验", ...(audit ? { residencyAuditId: audit.auditId } : {}) },
      opts.triggeredBy || "dryrun",
      binding.targetId,
      opts.runGroupId
    );
    await finishRunRecord(job, runId, "succeeded", { duration: 0 }, binding.targetId);
    return { runId, runDate, targetId: binding.targetId };
  }

  const SecretArn = binding.secretArn;
  const { Id } = await client.send(
    new BatchExecuteStatementCommand({ Sqls: toExplain.map((s) => `EXPLAIN ${s}`), WorkgroupName: workgroup, Database: database, ...(SecretArn ? { SecretArn } : {}), ...(audit ? { StatementName: audit.auditId } : {}) })
  );
  await createRunRecord(
    job,
    runId,
    "etl-redshift-dryrun",
    // 🔴 同上:归属只走 `stamp`(第 6 个参数),`extra` 带 `targetId` 会被写通道当场拒。
    { statementId: Id, statementCount: toExplain.length, runDate, dryRun: true, ...(audit ? { residencyAuditId: audit.auditId } : {}) },
    opts.triggeredBy || "dryrun",
    binding.targetId,
    opts.runGroupId
  );
  // Dry-run must not flip the job's lastRunStatus.
  // 🔴 轮询同样要带**提交时的 region** 与生效 target(试运行也可能跑在非 home)。
  pollRedshiftRun(job, runId, Id!, false, null, binding.region, binding.targetId).catch(() => {});
  return { runId, statementId: Id, runDate, targetId: binding.targetId };
}

// dispatch a run by job type (used by run / backfill / rerun routes).
export async function runEtlJob(job: EtlJob, opts: RunOpts = {}): Promise<RunResult> {
  return job.type === "glue" ? runGlueScriptJob(job, opts) : runRedshiftSqlJob(job, opts);
}

async function pollRedshiftRun(
  job: EtlJobRef,
  runId: string,
  statementId: string,
  updateJob = true,
  lock?: RunLock | null,
  // 🔴 statementId 是 **region 内**的,轮询必须用提交时那个 region。
  region?: string,
  // 回写终态时补章要补对那个 target。
  effectiveTargetId?: string
) {
  const jobId = job.jobId;
  // 模块级 home 客户端已删:缺省显式取 home 的 region
  //    (与原来 `rsData` 逐字节等价,但"按 region 取"这件事在代码里可见)。
  // L4 过渡:语义是缺省回落主控区(静默默认值类),再按落点改
  const poller = redshiftDataClientFor(region || homeRegion());
  // 🔴 P0-6 订正(2026-08-29 外部审核):原注释"无论到达终态还是轮询耗尽都必须释放"最危险 ——
  // Redshift 轮询窗口只有 120×2s = **4 分钟**,而一条 CTAS/补数 SQL 跑十几分钟很常见 ⇒ 第 4 分钟
  // 就放锁、后端还在执行,第二个 run 进来 DROP+CTAS 同一张表 = OID 事故。现在:续租 +
  // 只有确认终态才释放 + 耗尽保持持锁。
  let reachedTerminal = false;
  try {
    for (let i = 0; i < 120; i++) {
      await sleep(2000);
      if (!(await renewRunLockIfDue(lock))) {
        console.warn("[etl] Redshift 轮询中丢锁,停止回写", jobId, runId);
        reachedTerminal = true;
        return;
      }
      try {
        const desc = await poller.send(new DescribeStatementCommand({ Id: statementId }));
        if (desc.Status && ["FINISHED", "FAILED", "ABORTED"].includes(desc.Status)) {
          // ABORTED = 被取消(见 reconcileEtlJob 同款注释)
          const status = desc.Status === "FINISHED" ? "succeeded" : desc.Status === "ABORTED" ? "stopped" : "failed";
          await finishRunRecord(
            job,
            runId,
            status,
            {
              duration: desc.Duration ? Math.round(Number(desc.Duration) / 1e9) : 0,
              error: desc.Error || null,
              // 成功时记受影响行数(补数页据它标「成功(0 行)」;失败 / 取消不写,免得把 0 当成事实)
              ...(status === "succeeded" ? affectedRowsMetrics(desc) : {}),
            },
            effectiveTargetId
          );
          if (updateJob) await updateJobStatus(jobId, status, runId);
          reachedTerminal = true;
          return;
        }
      } catch {
        /* keep polling */
      }
    }
  } finally {
    if (reachedTerminal) await releaseJobRunLock(lock);
    else await keepRunLockForReconcile(lock, { jobId, runId, engine: "redshift" });
  }
}
