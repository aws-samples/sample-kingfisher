// EMR Serverless EngineProvider 实现（七方法）。
// 结构照抄 lib/etl/job-service.ts（submit/poll/reconcile）+ lib/realtime/flink-service.ts（stop/readLogs）。
// per-作业 application（拍板④⑤）：submit 前 ensureApplication+ensureStarted；作业删除时 destroyResource。

import { homeRegion } from "@/lib/place/home-region";
import {
  StartJobRunCommand,
  GetJobRunCommand,
  CancelJobRunCommand,
} from "@aws-sdk/client-emr-serverless";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { gunzipSync } from "zlib";
import { ulid } from "ulid";
import type { EngineProvider, RunOpts, RunResult, LogLine } from "../spi";
// 补数标记字段的唯一作者(与 etl/job-service 同一个)
import { backfillRunExtra } from "@/lib/backfill/run-extra";
import type { EngineJob } from "../types";
import type { EmrEngineJob } from "./types";
import { toSparkSubmitParameters, userSparkConfToParameters, s3TablesCatalogParameters, bgpLandingParameters } from "./spec";
import { ensureApplication, ensureStarted, destroyApplication, applicationIdOf, allApplicationRefs, targetEmrNetwork } from "./application";
import { uploadScript, ensureS3TablesJar } from "./script";
import { s3LogUri, EMR_LOG_PREFIX as LOG_PREFIX } from "./log-destination";
// 执行角色解析 / 预检的唯一作者(原直接调 role-advisor/preflight,现经落点化封装)
import { resolveExecutionRoleArn, roleArnShapeRejection, ExecRoleRejected } from "@/lib/execution-role/resolve";
import { preflightExecutionRole, assertPreflightPassed } from "@/lib/execution-role/preflight";
// per-target 落点与客户端
import { bindingTargets, resolveGlueBinding, resolveEmrBinding, resolveRedshiftBinding } from "@/lib/exec-env/data-plane-target";
import { emrServerlessClientFor, s3ClientFor } from "@/lib/exec-env/target-clients";
import { requireReadyTarget } from "@/lib/exec-env/registry";
import { isHome } from "@/lib/exec-env/target-id";
// 运行提交的可审计闭包
import { residencyAudit, auditActorOrService, auditObservedScheduledRun } from "@/lib/exec-env/residency-audit";
import { createRunRecord, finishRunRecord, updateEngineJobStatus, mapEmrState, EMR_TERMINAL_STATES } from "./run-record";
import { recordComputeLineage } from "@/lib/governance/lineage-service";
import { pushComputeLineageToOM } from "@/lib/openmetadata/om-push";
import { parseSparkScriptLineage, sparkRefToFqn } from "@/lib/lineage/spark-lineage";
import { guard } from "@/lib/cookbook";
import { acquireJobRunLock, releaseJobRunLock, renewRunLockIfDue, keepRunLockForReconcile, type RunLock, RunLockBusy } from "@/lib/etl/run-lock";
// 业务日期以参数进作业(单一作者;与 Glue 离线作业同一张表)
import { runParamArgv, todayDs } from "@/lib/etl/run-params";

// 根治·裂缝C:作业级运行锁等待预算。backfill/schedule→排队等前序 run 终态(串行);手动 run→不等(0)。
function emrRunLockWaitMs(triggeredBy?: string): number {
  return triggeredBy === "backfill" || triggeredBy === "schedule" ? 60 * 60 * 1000 : 0; // EMR 冷启~1-2min,前序作业最长~60min
}

// 🔴 **模块级 home 客户端已删**(原来 `emr` / `s3`)。EMR application 与 S3 日志桶都是 **region 内**的:
// 用 home 客户端去 us-west-2 查 job-run 会 ResourceNotFound(而"找不到"在轮询里长得像"还在跑"),
// 取日志会取到**空**(空日志与"作业没输出"界面上一模一样)。
// ⇒ 每处都先解析该 run 的 target 落点,再按 region 取客户端。

const USER_ID = "default-user";
// 🔴 原模块级常量(读 env `EMR_EXECUTION_ROLE_ARN`)**已删**:执行角色从此按 target
// 解析(`resolveEmrBinding`:home 走同一个 env、逐字节等价;非 home 取该 target 描述符里**自己的**角色,缺即拒)。
// 留一个模块级 home 常量 = 留一个「非 home 也顺手用 home 角色」的口子(SPEC §6.1 要消灭的共享形态)。
// 🔴🔴 日志落点收成**单一真值源** `./log-destination`(2026-09-22):原来这两个常量在本文件里,
//   于是「运行期往哪写日志」与「角色顾问给哪些权限」成了两个作者 —— 授权那一侧压根不知道有这个落点,
//   建出来的执行角色一跑就 `AccessDenied: s3:PutObject .../emr-logs/.../job-metadata.log`。
//   见 `lib/role-advisor/engine-baseline.ts`(它从同一处派生必备权限)。
// 平台注入的 S3 Tables 支持（catalog runtime JAR + 表桶 warehouse ARN）。CDK 注入。
// 导出给 schedule-fanout(EMR 定时逐 target 扇出)复用,免第二份常量
export const S3TABLES_JAR = process.env.EMR_S3TABLES_JAR || (process.env.AWS_ACCOUNT_ID ? `s3://bgp-glue-scripts-${process.env.AWS_ACCOUNT_ID}/emr-jars/s3-tables-catalog-for-iceberg-runtime-0.1.8.jar` : "");
export const S3TABLES_WAREHOUSE_ARN = process.env.EMR_S3TABLES_WAREHOUSE_ARN || (process.env.AWS_ACCOUNT_ID ? `arn:aws:s3tables:${homeRegion()}:${process.env.AWS_ACCOUNT_ID}:bucket/bgp-table-bucket` : "");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 🔴 只此一处转出,别再写第二份(下游 `schedule-fanout.ts` 也从这里拿)。
export { s3LogUri };

/**
 * 从 **run 记录** 反解这条 run 的执行上下文(target / region / application / 日志桶)。
 *
 * 🔴 为什么从 run 记录反解、而不是从作业行读:作业的绑定会变(用户随时可以改),
 * 而**这条 run 已经跑在哪个区是历史事实**。从作业行读 = 改一次绑定就把历史 run 的
 * 对账/日志指到别的区(那正是"看板假绿"的另一种形态)。
 */
async function runCtx(job: EmrEngineJob, runId: string): Promise<{
  targetId: string;
  region: string;
  logBucket: string;
  applicationId: string;
} | null> {
  const { Item: run } = await docClient.send(
    new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId: job.jobId, runId } })
  );
  const targetId = String((run as { targetId?: string } | undefined)?.targetId || "tgt_home");
  const landing = await resolveGlueBinding({ targetId });
  const applicationId =
    String((run as { applicationId?: string } | undefined)?.applicationId || "") ||
    applicationIdOf(job, targetId) ||
    (await loadJob(job.jobId).then((j) => (j ? applicationIdOf(j, targetId) : undefined))) ||
    "";
  if (!applicationId) return null;
  return { targetId, region: landing.region, logBucket: landing.datalakeBucket, applicationId };
}

/**
 * 把某个 target 上新建的 applicationId 记回作业行。
 *
 * 🔴 home 仍写老字段 `applicationId`(存量作业零迁移、DAG 里那份也照旧);
 * 非 home 写 `applicationIdByTarget.<targetId>` —— **用 map 路径写**,不整包覆盖
 * (两个区并发提交时,后写的不许把前一个区的 id 抹掉;与 `recordDeployment` 同一条纪律)。
 */
export async function persistApplicationId(job: EmrEngineJob, targetId: string, applicationId: string): Promise<void> {
  if (!applicationId) return;
  if (applicationIdOf(job, targetId) === applicationId) return;
  const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
  if (targetId === "tgt_home") {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.ENGINE_JOBS,
        Key: { userId: USER_ID, jobId: job.jobId },
        UpdateExpression: "SET applicationId = :a, updatedAt = :t",
        ExpressionAttributeValues: { ":a": applicationId, ":t": new Date().toISOString() },
      })
    );
    return;
  }
  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.ENGINE_JOBS,
      Key: { userId: USER_ID, jobId: job.jobId },
      UpdateExpression: "SET #m = if_not_exists(#m, :empty), updatedAt = :t",
      ExpressionAttributeNames: { "#m": "applicationIdByTarget" },
      ExpressionAttributeValues: { ":empty": {}, ":t": new Date().toISOString() },
    })
  );
  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.ENGINE_JOBS,
      Key: { userId: USER_ID, jobId: job.jobId },
      UpdateExpression: "SET #m.#t = :a",
      ExpressionAttributeNames: { "#m": "applicationIdByTarget", "#t": targetId },
      ExpressionAttributeValues: { ":a": applicationId },
    })
  );
}

async function loadJob(jobId: string): Promise<EmrEngineJob | null> {
  const { Item } = await docClient.send(new GetCommand({ TableName: TABLES.ENGINE_JOBS, Key: { userId: USER_ID, jobId } }));
  return (Item as EmrEngineJob) || null;
}

export const emrServerlessProvider: EngineProvider = {
  type: "emr-serverless",
  capabilities: { canStop: true, logsSource: "s3", supportsDryRun: false },

  // 🔴 (观测器):原来 `ensureApplication(job)` 不带落点 ⇒
  //   给 us-west-2 建的作业在**主控区**先建出一个 application(+ 用主控区网络),作业的 applicationId 也记在主控区名下。
  //   现在按作业**每一个绑定区**各建各的(与 submit 同一条落点解析),返回 targetId → applicationId。
  async ensureResource(job: EngineJob): Promise<Record<string, string>> {
    const j = job as EmrEngineJob;
    const out: Record<string, string> = {};
    for (const targetId of bindingTargets(j as { targets?: unknown; targetId?: unknown })) {
      const landing = await resolveEmrBinding({ targetId });
      out[targetId] = await ensureApplication(j, landing, await targetEmrNetwork(targetId));
    }
    return out;
  },

  async destroyResource(job: EngineJob): Promise<void> {
    // 🔴 **一个作业在多个区各有一个 application**,删作业时必须**一个不漏**地删 ——
    // 漏掉一个就是一个跨区孤儿(还挂着 tag 说是我们建的,而且 autoStop 之后仍占额度)。
    const j = job as EmrEngineJob;
    for (const ref of allApplicationRefs(j)) {
      let region: string | undefined;
      try {
        region = (await resolveGlueBinding({ targetId: ref.targetId })).region;
      } catch {
        region = undefined; // 解析不到就用 home 试一次:删不掉会在下面被吞掉,但不能因此不删
      }
      await destroyApplication(ref.applicationId, region).catch(() => {});
    }
  },

  async submit(job: EngineJob, opts: RunOpts = {}): Promise<RunResult> {
    const j = job as EmrEngineJob;
    // 执行角色:作业自定义 spec.executionRoleArn 优先(最小权限),留空回退平台默认 EMR_EXECUTION_ROLE_ARN。
    const customRole = (j.spec?.executionRoleArn || "").trim();
    {
      // ARN 形态单一作者(先于落点解析,形态错不去碰注册表)
      const shapeReject = customRole ? roleArnShapeRejection(customRole) : null;
      if (shapeReject) throw new ExecRoleRejected(shapeReject);
    }
    const triggeredBy = opts.triggeredBy || "manual";
    // 🔴 原来 `runDate` 只写台账,作业本身一个日期都拿不到(手动「指定日期运行」/
    //   补数 / 同日期重跑对 EMR 全是空转,而页面上写着那一天)。现在:缺省 = 今天(UTC,与 Glue 离线作业同口径),
    //   非法当场拒;参数在下面 StartJobRun 时**追加**到用户入参之后(脚本对象本身不含日期,见 uploadScript)。
    const runDate = opts.runDate || todayDs();
    const runParamArgs = runParamArgv(runDate);
    // 这次跑在哪个 target(缺省 home ⇒ 存量逐字节等价)
    const targetId = (opts as { targetId?: string }).targetId || "tgt_home";
    // 0) **落点按 target 解析**(W3-g:EMR 作业可以在非 home 跑了)。五样一起来:
    //    region(建客户端)/ 脚本桶(entryPoint)/ 产物·日志桶 / 该区的网络事实 / **该 target 自己的执行角色**(SPEC §6.1 段二)。
    //    放在抢锁之前:只读解析,失败就不该去抢锁。
    const landing = await resolveEmrBinding({ targetId });
    const { roleArn: execRoleArn } = resolveExecutionRoleArn({
      custom: customRole,
      fallback: landing.executionRoleArn,
      missingMessage: "未指定执行角色:请在作业规格填写执行角色 ARN,或部署配置 EMR_EXECUTION_ROLE_ARN",
    });
    // ══════════════════════════════════════════════════════════════════════
    // 🔴🔴🔴 **执行角色权限预检**(2026-09-22 立;用户原话:「他需要知道这种任务需要添加哪些权限,
    //   而不是报错了之后我通过你改源代码重新发布解决问题。」)
    //
    // 真实事故:copilot 建的 ROI 作业填了一个角色顾问建出来的角色,那个角色**一条 S3 语句都没有**
    //   ⇒ EMR 起步就 `AccessDenied: s3:PutObject .../emr-logs/.../job-metadata.log`,
    //   而报错里没有一个字提示「缺日志落点写权限」;它填的另一个名字在账号里**压根不存在**。
    // ⇒ 在**提交之前**把必备权限逐条量一遍(`SimulatePrincipalPolicy`),缺了就当场拒绝并说清出路。
    //
    // 🔴 只量**自定义角色**:平台默认角色由 CDK 建、权限本来就齐,每次跑都去 simulate 是白花钱白花时间。
    // 🔴 预检**自己**量不了(平台缺 iam:SimulatePrincipalPolicy / 被限流)⇒ 不阻断,但把
    //   「这次没被预检过」如实写进日志(三态分开:齐 / 缺 / 量不了)。
    // ══════════════════════════════════════════════════════════════════════
    if (customRole) {
      // 走统一入口(信任 emr-serverless.amazonaws.com + 引擎基线 + 脚本里 s3:// 引用;模拟带本区 RequestedRegion)
      const pf = await preflightExecutionRole({ engine: "emr", roleArn: execRoleArn, targetId, scriptCode: j.script });
      assertPreflightPassed(pf, { engine: "emr", roleArn: execRoleArn, targetId, what: `emr-job ${j.jobId}` });
    }
    // 抢锁之前写区域审计(entry=run-submit;与 ETL 侧同一口径;脚本原文进 sqlText)
    const audit = await residencyAudit({
      ...auditActorOrService(opts.actor),
      targetId,
      entry: "run-submit",
      triggeredBy,
      projectId: j.projectId,
      sqlText: j.script,
      knownJurisdiction: landing.jurisdiction,
    });
    const residencyAuditId = audit?.auditId;

    // (运行时收口一致性):EMR 是 PySpark 命令式代码(code 引擎),cookbook 对它【不做正则改写】
    // (types.ts:24 硬约束 target=code 禁配 fix,不误伤语义);但【可带 antiPattern 纯检测】拦硬错——
    // 如 emr.no-jdbc-redshift(禁 jdbc:redshift 占位符连数仓)命中即 g.blocked=true,在此拦执行。
    // 与 glue(job-service.ts:234)/redshift/flink 各引擎运行时一致收口。写回幂等靠【生成前引导】
    // (codegen 注入 s3tables createOrReplace 范式),不靠此处事后纠正——这是 code 引擎的正解。
    const g = guard("emr", j.script);
    if (g.blocked) {
      const detail = g.violations.filter((v) => v.severity === "error").map((v) => v.title).join("；");
      throw new Error(`EMR 脚本方言校验未通过,已拦截执行:${detail}。请修正后重试。`);
    }

    // 根治·裂缝C:抢作业级运行锁(engine-jobs 表)再提交。同作业 backfill 排队串行,避免并发写同一
    // S3Tables 目标表(Iceberg 并发 commit 冲突);手动 run 抢不到即明确报错。锁在 poll 终态释放(见下)。
    // 🔴 锁属性按 target(与 ETL 侧同一口径):同一作业在不同区可以并行,同区必须互斥。
    const lock = await acquireJobRunLock(TABLES.ENGINE_JOBS, j.jobId, emrRunLockWaitMs(triggeredBy), targetId);
    if (!lock) throw new RunLockBusy("该作业正在运行中,请等待当前运行完成后再试(避免并发重建同一结果表导致失败)。");
    try {

    const emr = await emrServerlessClientFor(landing.region);
    // 非 home 的网络事实只能来自**该 target 描述符**(home 走既有 env 兜底,逐字节等价)
    const targetNetwork = await targetEmrNetwork(targetId);

    // 1) 脚本落**该 target 的**脚本桶 → entryPoint。
    const entryPoint = await uploadScript(j.jobId, j.script, landing);
    // 1b) 🔴 S3 Tables 的 runtime jar 必须在**该 target 的**桶里(平台恒定注入 `--jars`;
    //     per-target 脚本桶原来是空的 ⇒ 非 home 的 run 会在拉 jar 那步就失败)。幂等服务端复制。
    const s3tJar = await ensureS3TablesJar(landing, S3TABLES_JAR);

    // 2) 确保**该 target 上**本作业专属 application 存在且已启动。
    const applicationId = await ensureApplication(j, landing, targetNetwork);
    await ensureStarted(applicationId, landing.region);
    // 2b) 非 home 的 applicationId 记在 `applicationIdByTarget`(home 仍写老字段 ⇒ 存量零迁移)
    await persistApplicationId(j, targetId, applicationId);

    // 3) 组 sparkSubmitParameters：平台规格（保留键）+ 平台注入 S3 Tables catalog 支持 + 用户自定义 conf。
    //    S3 Tables 参数由平台自动注入（catalog+jars+warehouse），用户脚本直接 spark.table("s3tablescatalog.ns.tbl")。
    const specParams = toSparkSubmitParameters(j.spec);
    // 🔴 catalog 的 warehouse ARN 也必须是**该区的表桶**(拿 home 的 ARN 去那个区 = 跨区写元数据)
    const s3tParams = s3TablesCatalogParameters(
      s3tJar,
      landing.home
        ? S3TABLES_WAREHOUSE_ARN
        : `arn:aws:s3tables:${landing.region}:${process.env.AWS_ACCOUNT_ID}:bucket/${landing.tableBucket}`
    );
    const userParams = userSparkConfToParameters(j.sparkConf);
    // 🔴🔴 与 Glue 同一件事:**把该区的落点事实注入作业**(`spark.conf.get('spark.bgp.datalakeBucket')`)。
    // 不注入的话用户脚本只能硬编码桶名 ⇒ 多区域执行时所有区的产物都写回同一个桶,
    // 而作业照样报成功(权限是通的)。真环境实测:usw2 的 run 原生 SUCCESS、usw2 桶里 0 个产物。
    // 🔴 落点事实 + 执行区注入 + Redshift 连接事实,走**单一作者**(见 spec.ts 的 bgpLandingParameters)
    // 🔴 Redshift 那三个事实解析失败**不阻断作业**(不是所有 EMR 作业都碰数仓)——
    //   但**绝不静默当成「不需要」**:拿不到就写一行日志,生成的代码会因为 conf 取不到而当场报错,
    //   而不是连上一个没授权的临时用户再报 `permission denied for database dev`。
    let rsFacts: { redshiftWorkgroup?: string; redshiftDatabase?: string; redshiftSecretArn?: string } = {};
    try {
      const rb = await resolveRedshiftBinding({ targetId });
      rsFacts = { redshiftWorkgroup: rb.workgroup, redshiftDatabase: rb.database, redshiftSecretArn: rb.secretArn };
    } catch (e) {
      console.warn(`[emr] ${j.jobId} 解析该区 Redshift 连接事实失败(不阻断,但作业里读不到 spark.bgp.redshift*):${String((e as Error)?.message || e).slice(0, 160)}`);
    }
    const bgpParams = bgpLandingParameters({ ...landing, ...rsFacts });
    const sparkSubmitParameters = [specParams, s3tParams, bgpParams, userParams].filter(Boolean).join(" ");

    // 4) StartJobRun。
    // 🔴 业务日期参数**追加在用户入参之后**(用户按位置读自己的入参,下标不变),
    //   `--ds <YYYY-MM-DD>` 起、全套 15 个,与 Glue 的 sys.argv 形状一致;调度产物(经典 DAG / serverless 运行时)
    //   在 Python 侧用同一张表的 bgp_run_param_argv(ds) 做同样的追加。脚本文本(entryPoint 指向的 S3 对象)不含日期。
    const runId = ulid();
    const { jobRunId } = await emr.send(
      new StartJobRunCommand({
        applicationId,
        executionRoleArn: execRoleArn,
        name: `${j.name}-${runId.slice(-8)}`,
        jobDriver: {
          sparkSubmit: {
            entryPoint,
            entryPointArguments: [...(j.entryPointArguments || []), ...runParamArgs],
            sparkSubmitParameters,
          },
        },
        configurationOverrides: {
          monitoringConfiguration: { s3MonitoringConfiguration: { logUri: s3LogUri(j.jobId, landing.datalakeBucket) } },
        },
      })
    );
    if (!jobRunId) throw new Error("StartJobRun 未返回 jobRunId");

    // 5) 写运行记录（running）+ 起后台轮询。轮询到终态(或异常)后释放作业锁(根治·裂缝C):
    //    poll 不改 SPI 签名,锁释放挂在其 promise 的 finally,与 Redshift/Glue 的 poll 内 finally 等价。
    // residencyAuditId 为 undefined(home / 同法域)时由写通道的 removeUndefinedValues 丢掉,不落属性
    await createRunRecord(j, runId, { nativeRunId: jobRunId, applicationId, runDate, residencyAuditId, ...backfillRunExtra(opts.backfill) }, triggeredBy, targetId, opts.runGroupId);
    await updateEngineJobStatus(j.jobId, "running", runId);
    // 🔴 P0-6 订正(2026-08-29 外部审核):原来把释放挂在 poll promise 的 `.finally()` ——
    // poll 正常跑完 240×15s≈60min 掉出循环也会走 finally ⇒ **EMR 作业还在跑就放锁**,
    // 第二个 run 进来撞同一张目标表。现在锁交给 poll 内部:确认终态才释放,耗尽保持持锁。
    this.poll(j, runId, jobRunId, lock).catch(() => {});

    // 计算血缘（2026-07-08）：PySpark 作业提交后，从脚本启发式提取 输入表→输出表 写平台血缘表，
    // 让 EMR 产出的结果表在治理页血缘图有上游计算来源(此前 EMR 完全零血缘)。best-effort 不阻断提交。
    // 显式声明优先(job.lineageInputs/Outputs, 未来 UI 可填);否则解析脚本 spark.table/saveAsTable/INSERT INTO。
    try {
      const parsed = parseSparkScriptLineage(j.script || "");
      const toFqn = (r: string) => sparkRefToFqn(r);
      const inputs = ((j as any).lineageInputs as string[] | undefined)?.length
        ? (j as any).lineageInputs
        : parsed.inputs.map(toFqn).filter(Boolean) as string[];
      const outputs = ((j as any).lineageOutputs as string[] | undefined)?.length
        ? (j as any).lineageOutputs
        : parsed.outputs.map(toFqn).filter(Boolean) as string[];
      if (inputs.length && outputs.length) {
        // 双写:①平台 bgp-lineage(回退源) ②OpenMetadata(治理页血缘图主源)——此前 EMR 只写①
        // 导致产出表在治理页无上游(治理页读 OM)。两条腿都写,与 SQL 类任务的双写策略对齐。
        recordComputeLineage({ inputs, outputs, taskId: j.jobId, engine: "emr-serverless" }).catch(() => {});
        pushComputeLineageToOM({ inputs, outputs, taskId: j.jobId, engine: "EMR Serverless", taskName: (j as any).name }).catch(() => {});
      }
    } catch { /* best-effort: 血缘采集不得影响作业提交 */ }

    return { runId, nativeRunId: jobRunId, runDate };
    } catch (e) {
      // 提交阶段失败(上传脚本/建应用/StartJobRun 抛错)→ 立即释放锁,不留僵尸锁卡死后续 run。
      await releaseJobRunLock(lock);
      throw e;
    }
  },

  // 第 4 参 `lock` 是可选扩展(SPI spi.ts:50 声明 3 参;TS 允许实现多一个可选参),
  // 让"续租 / 只在终态释放 / 耗尽保持持锁"与轮询在同一作用域,不再由调用方 finally 盲放。
  async poll(job: EngineJob, runId: string, nativeRunId: string, lock?: RunLock | null): Promise<void> {
    const j = job as EmrEngineJob;
    // 🔴 按**这条 run 自己的 target** 解析 application/region(用 home 客户端查非 home 的 job-run
    //    会一直 ResourceNotFound ⇒ 轮询白转 60 分钟、run 永远卡 running)。
    const ctx = await runCtx(j, runId).catch(() => null);
    if (!ctx) return;
    const { applicationId } = ctx;
    const emr = await emrServerlessClientFor(ctx.region);
    let reachedTerminal = false;
    try {
    for (let i = 0; i < 240; i++) {
      await sleep(15000);
      if (!(await renewRunLockIfDue(lock))) {
        console.warn("[emr] 轮询中丢锁,停止回写", j.jobId, runId);
        reachedTerminal = true;
        return;
      }
      try {
        const { jobRun } = await emr.send(new GetJobRunCommand({ applicationId, jobRunId: nativeRunId }));
        const state = jobRun?.state;
        if (state && EMR_TERMINAL_STATES.includes(state)) {
          const runStatus = mapEmrState(state); // run 级：succeeded/failed/stopped
          const jobStatus = runStatus === "succeeded" ? "succeeded" : "failed"; // 作业级无 stopped
          await finishRunRecord(j, runId, runStatus, {
            duration: Math.round(Number(jobRun?.totalExecutionDurationSeconds || 0)),
            error: jobRun?.stateDetails || null,
          });
          await updateEngineJobStatus(j.jobId, jobStatus, runId, runStatus);
          reachedTerminal = true;
          return;
        }
      } catch {
        /* 瞬时错误保留，继续轮询 */
      }
    }
    } finally {
      if (reachedTerminal) await releaseJobRunLock(lock);
      else await keepRunLockForReconcile(lock, { jobId: j.jobId, runId, engine: "emr-serverless" });
    }
  },

  async stop(job: EngineJob, runId: string, nativeRunId: string): Promise<void> {
    const j = job as EmrEngineJob;
    const ctx = await runCtx(j, runId);
    if (!ctx) return;
    const emr = await emrServerlessClientFor(ctx.region);
    await emr.send(new CancelJobRunCommand({ applicationId: ctx.applicationId, jobRunId: nativeRunId }));
    // run 级记 stopped（真实语义）；作业主表 status 无 stopped 枚举 → 记 failed。
    await finishRunRecord(j, runId, "stopped", {});
    await updateEngineJobStatus(j.jobId, "failed", runId, "stopped");
  },

  async readLogs(job: EngineJob, _runId: string, nativeRunId: string): Promise<LogLine[]> {
    const j = job as EmrEngineJob;
    // 🔴 日志桶与客户端都按**这条 run 的 target**:拿 home 的桶去找非 home 的日志只会拿到空,
    //    而"空日志"在界面上与"作业没输出"完全一样(最坏的一种静默)。
    const ctx = await runCtx(j, _runId).catch(() => null);
    if (!ctx) return [];
    const { applicationId } = ctx;
    const s3 = await s3ClientFor(ctx.region);
    // EMR Serverless S3 日志落点：<logUri>/applications/<appId>/jobs/<runId>/SPARK_DRIVER/{stdout,stderr}.gz
    const base = `${LOG_PREFIX}/${j.jobId}/applications/${applicationId}/jobs/${nativeRunId}/SPARK_DRIVER/`;
    const lines: LogLine[] = [];
    for (const which of ["stdout.gz", "stderr.gz"]) {
      try {
        const { Body } = await s3.send(new GetObjectCommand({ Bucket: ctx.logBucket, Key: base + which }));
        const buf = Buffer.from(await Body!.transformToByteArray());
        const text = gunzipSync(buf).toString("utf-8");
        for (const raw of text.split("\n")) {
          const msg = raw.trimEnd();
          if (msg) lines.push({ level: which === "stderr.gz" ? "stderr" : "stdout", msg });
        }
      } catch {
        /* 该文件可能还没生成（run 未产出日志），跳过 */
      }
    }
    if (lines.length === 0) {
      // 日志可能尚未落 S3（run 刚起或还在跑）——给个占位提示而非空白。
      lines.push({ level: "info", msg: "日志尚未生成或正在写入 S3（EMR Serverless 日志在 run 结束后完整可读）。" });
    }
    return lines.slice(-500);
  },

  async reconcile(job: EngineJob): Promise<EngineJob> {
    const j = job as EmrEngineJob;
    if (!j || !j.lastRunId) return job;
    try {
      const { Item: run } = await docClient.send(
        new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId: j.jobId, runId: j.lastRunId } })
      );
      if (!run) return job;
      // 定时 run 的观测后审计补写(与 ETL 侧 reconcileEtlJob 同一口径;幂等、不影响对账)
      await auditObservedScheduledRun({ taskId: j.jobId, runId: j.lastRunId, targetId: run.targetId, triggeredBy: run.triggeredBy, residencyAuditId: run.residencyAuditId });
      if (j.lastRunStatus !== "running") return job;
      if (!run.nativeRunId || !run.applicationId) return job;
      // 🔴 与 ETL 侧那两处**同一类**:必须用这条 run 的 region。用 home 客户端查非 home 的 job-run
      //    会 ResourceNotFound ⇒ 下面那句 `state` 恒空 ⇒ run 永远卡 running(比写错状态更难查)。
      const landing = await resolveGlueBinding({ targetId: String((run as { targetId?: string }).targetId || "tgt_home") });
      const emr = await emrServerlessClientFor(landing.region);
      const { jobRun } = await emr.send(
        new GetJobRunCommand({ applicationId: String(run.applicationId), jobRunId: String(run.nativeRunId) })
      );
      const state = jobRun?.state;
      if (state && EMR_TERMINAL_STATES.includes(state)) {
        const real = mapEmrState(state); // run 级：succeeded/failed/stopped
        // 作业主表 status 只有 succeeded/failed（无 stopped）——run 级 stopped 在作业级记为 failed。
        const jobStatus = real === "succeeded" ? "succeeded" : "failed";
        await finishRunRecord(j, j.lastRunId, real, {
          duration: Math.round(Number(jobRun?.totalExecutionDurationSeconds || 0)),
          error: jobRun?.stateDetails || null,
        }).catch(() => {});
        await updateEngineJobStatus(j.jobId, jobStatus, j.lastRunId, real).catch(() => {});
        return { ...j, status: jobStatus, lastRunStatus: real };
      }
    } catch {
      /* 对账失败不影响列表 */
    }
    return job;
  },
};
