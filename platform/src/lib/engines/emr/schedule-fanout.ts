// **EMR 引擎作业的定时 DAG 逐 target 扇出**(吸收「engine-job 定时多区扇出」;50 SPEC v3.26 §3.14 / §5.2)。
//
// 【为什么要有这一刀】原 `engines/[engine]/[id]/schedule` 路由只发 **home** 一份 DAG、用 **home** 的执行角色 / application / 脚本桶
//   (注释自证「MWAA 是 home 独有」),而 W3-g 起 EMR 作业已能绑非 home 运行 ⇒ 「立即运行」在 us-west-2、「定时」却在 home:
//   同一作业手动与调度打两个数仓 —— 正是消灭过的分叉,在调度面原地复活。
// 【口径 = 与 provider.submit 逐项相同】binding(角色)→ 网络事实 → 脚本 / jar 落该区桶 → application(applicationIdByTarget)→
//   spark 参数(该区表桶 warehouse + spark.bgp.* 落点事实)→ DAG(EXEC_ROLE = 该 target 角色,EXEC_REGION = 该区,CTRL_REGION = home)
//   → 写**该 target 自己的** MWAA 桶(mwaa-endpoint 单一作者)→ 台账 deployments[targetId]。
// 【先核 MWAA 再动任何字节】缺 MWAA 的 target 一起列、零副作用;dag_id 口径沿 `dagIdForTarget`(home 不变)。
// 多区扇出的唯一写法(L10)
import { homeRegion } from "@/lib/place/home-region";
import { forEachTargetPlace } from "@/lib/place/fanout";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { TABLES } from "@/lib/aws/dynamodb";
import { baseDagIdOf as etlBaseDagIdOf, dagIdForTarget, deployedOrBoundTargets, offlinePreviousSchedulerIfSwitched, type FanoutPublishRow } from "@/lib/etl/dag-fanout";
import { bindingTargets, resolveEmrBinding } from "@/lib/exec-env/data-plane-target";
// 执行角色解析 / 预检的唯一作者(与 provider.submit 同一口径;原来发布调度这条路不预检)
import { resolveExecutionRoleArn } from "@/lib/execution-role/resolve";
import { preflightExecutionRole, assertPreflightPassed } from "@/lib/execution-role/preflight";
import { recordDeployment, removeDeployment } from "@/lib/exec-env/deployments";
import { requireReadyTarget } from "@/lib/exec-env/registry";
import { s3ClientFor } from "@/lib/exec-env/target-clients";
import { HOME_TARGET_ID, isHome } from "@/lib/exec-env/target-id";
import { requireMwaaForTargets, isServerlessEndpoint, type SchedulerEndpoint } from "@/lib/scheduler/mwaa-endpoint";
import { publishServerlessWorkflow, offlineServerlessWorkflow } from "@/lib/scheduler/serverless/publish";
import type { ServerlessJobSpec } from "@/lib/scheduler/serverless/yaml-generator";
// 组表名的单一出口(别处不许再写 TABLES.RUN_GROUPS)
import { runGroupsTableName } from "@/lib/monitor/run-groups";
import { resolveRunStamp } from "@/lib/monitor/run-records";
import { currentDefinitionVersion } from "@/lib/versions/version-service";
import { ensureApplication, targetEmrNetwork } from "./application";
import { generateEmrJobDag } from "./dag-generator";
import { persistApplicationId, s3LogUri, S3TABLES_JAR } from "./provider";
import { ensureS3TablesJar, uploadScript } from "./script";
// EMR 作业 serverless spec / spark 参数 / 该区数仓事实的唯一作者(工作流离线作业节点拼的是同一份)
import { emrJobSpecFor, emrSparkSubmitParametersFor, emrRedshiftFactsFor, emrLakeRoutesFor } from "./job-spec";
import type { EmrEngineJob } from "./types";

const USER_ID = "default-user";

/** EMR 引擎作业的基准 dagId(home 那一份;存量口径 `bgp_engine_<jobId>`)。 */
export function emrBaseDagIdOf(job: Pick<EmrEngineJob, "jobId" | "airflowDagId">): string {
  return job.airflowDagId || `bgp_engine_${job.jobId}`;
}
void etlBaseDagIdOf;

/** 本文件产出的定时组属于哪类定义(值域 =  ResourceType) */
const DEFINITION_KIND = "engine-job";

export async function publishEmrFanout(
  job: EmrEngineJob,
  cron: string,
  opts: { onlyTargets?: string[] } = {}
): Promise<{ rows: FanoutPublishRow[]; version: number; baseDagId: string; endpoints: Record<string, SchedulerEndpoint> }> {
  const base = emrBaseDagIdOf(job);
  const version = await currentDefinitionVersion("engine-job", job.jobId);
  // home 先发(与 ETL 扇出同理:fail-fast 时最可能成功、承载存量业务的那份先落地)
  const all = bindingTargets(job as unknown as { targets?: unknown }).slice().sort((a, b) => (isHome(a) ? -1 : isHome(b) ? 1 : 0));
  const only = opts.onlyTargets && opts.onlyTargets.length ? new Set(opts.onlyTargets) : null;
  const targets = only ? all.filter((t) => only.has(t)) : all;
  if (only && targets.length === 0) {
    throw new Error(`点名的执行目标都不在该作业的绑定里(点名:${opts.onlyTargets!.join("/")};绑定:${all.join("/")})⇒ 拒绝下发`);
  }
  // 🔴 第一步:全部 target 的 MWAA 必须在(缺则 MwaaNotInstalled,零副作用)
  const endpoints = await requireMwaaForTargets(targets);
  const customRole = (job.spec?.executionRoleArn || "").trim();

  const rows: FanoutPublishRow[] = [];
  let stopped = false;
  // 一次请求碰多个区 ⇒ 唯一写法 `forEachTargetPlace`(L10):逐区**顺序**执行(与原 for 循环同序,
  //   stop-on-first-failure 照旧),解析得开的区各自一个嵌套落点上下文;循环体除 `continue` → `return` 外一字未改。
  await forEachTargetPlace(
    targets,
    async (targetId) => {
      const dagId = dagIdForTarget(base, targetId);
      const ep = endpoints.get(targetId)!;
      if (stopped) {
        rows.push({ targetId, dagId, status: "skipped" });
        return; // (原 continue)
      }
      try {
        // 调度器切换先下线旧产物(与 dag-fanout.publishFanout 同款)
        await offlinePreviousSchedulerIfSwitched(job as unknown as { deployments?: unknown }, targetId, dagId, ep);
        // 与 provider.submit 逐项相同的落点解析
        const landing = await resolveEmrBinding({ targetId });
        const resolvedRole = resolveExecutionRoleArn({
          custom: customRole,
          fallback: landing.executionRoleArn,
          missingMessage: `目标 ${targetId} 没有 EMR 执行角色(描述符缺 emrExecutionRoleArn)`,
        });
        const execRoleArn = resolvedRole.roleArn;
        // 数据湖表桶路由:作业在该区被选中的数据湖路由(与 provider.submit 同一作者;声明不合法 ⇒ 这一区如实记失败行)
        const lake = await emrLakeRoutesFor(job, targetId, landing);
        if (resolvedRole.isCustom) {
          // 发布调度前按该区预检自定义角色(与 provider.submit 同一口径),缺 ⇒ 这一区如实记失败行
          const pf = await preflightExecutionRole({ engine: "emr", roleArn: execRoleArn, targetId, scriptCode: job.script, lakeRoutes: lake.selected });
          assertPreflightPassed(pf, { engine: "emr", roleArn: execRoleArn, targetId, what: `emr-fanout ${job.jobId}` });
        }
        const targetNetwork = await targetEmrNetwork(targetId);
        const entryPoint = await uploadScript(job.jobId, job.script, landing);
        const s3tJar = await ensureS3TablesJar(landing, S3TABLES_JAR);
        const applicationId = await ensureApplication(job, landing, targetNetwork);
        await persistApplicationId(job, targetId, applicationId);
        // 🔴 与手动提交同一个作者(漏改一处 = 定时调度那条路依然 NoRegionError / permission denied)
        //   spark 参数的拼法与该区数仓事实的解析收进唯一作者 `./job-spec.ts`(工作流离线作业节点拼同一份)
        const sparkSubmitParameters = emrSparkSubmitParametersFor(job, landing, s3tJar, await emrRedshiftFactsFor(targetId), lake);
        // serverless 分路:同一套落点解析与 spark 参数,产物换成 YAML + 运行时 + workflow
        if (isServerlessEndpoint(ep)) {
          const stamp = resolveRunStamp(job, targetId);
          // spec 字段集合只在唯一作者 `./job-spec.ts#emrJobSpecFor` 定义;这里只解析事实再交给它。产物逐字节同搬出前。
          const spec: ServerlessJobSpec = emrJobSpecFor(job, targetId, {
            dagId,
            region: landing.region,
            applicationId,
            executionRoleArn: execRoleArn,
            entryPoint,
            sparkSubmitParameters,
            logUri: s3LogUri(job.jobId, landing.datalakeBucket),
            runName: `${job.name}-sched`,
            // O2 定时确定性分组。
            // 🔴 判据是 **`all`(全部绑定)而不是 `targets`(本次发布的子集)**:子集重发时若按 `targets` 判,
            //    那个区的 DAG 就会**没有** scheduledGroup,而另一个区还带着 ⇒ 同一个 cron 分出两个组
            //    (症状只是「没归成一组」,不报错 —— 正是本模块要消灭的那类静默)。
            ...(all.length > 1
              ? {
                  scheduledGroup: {
                    definitionKind: DEFINITION_KIND,
                    definitionId: job.jobId,
                    cron,
                    table: runGroupsTableName(),
                    projectId: stamp.projectId,
                    requestedTargets: all,
                    definitionVersion: version,
                  },
                }
              : {}),
          });
          const existingArn = (job as unknown as { deployments?: Record<string, { workflowArn?: string } | undefined> }).deployments?.[targetId]?.workflowArn;
          const pub = await publishServerlessWorkflow({ ep, dagId, cron, spec, existingArn, description: `BGP EMR Serverless job ${job.jobId} on ${targetId}` });
          await recordDeployment({
            table: TABLES.ENGINE_JOBS,
            key: { userId: USER_ID, jobId: job.jobId },
            targetId,
            record: { version, publishedAt: Date.now(), status: "ok", artifact: dagId, scheduler: "serverless", workflowArn: pub.workflowArn, workflowVersion: pub.workflowVersion },
          });
          rows.push({ targetId, dagId, status: "ok", bucket: ep.workflowBucket, envName: pub.workflowName, region: ep.region, scheduler: "serverless", workflowArn: pub.workflowArn });
          return; // (原 continue)
        }
        const dag = generateEmrJobDag(
          { ...job, cronExpression: cron, airflowDagId: base, applicationId },
          {
            entryPoint,
            sparkSubmitParameters,
            executionRoleArn: execRoleArn,
            applicationId,
            logUri: s3LogUri(job.jobId, landing.datalakeBucket),
            entryPointArguments: job.entryPointArguments || [],
            execRegion: landing.region,
            ctrlRegion: homeRegion(),
            targetId,
            dagId,
          }
        );
        const s3 = await s3ClientFor(ep.region);
        await s3.send(new PutObjectCommand({ Bucket: ep.dagBucket, Key: `dags/${dagId}.py`, Body: dag, ContentType: "text/x-python" }));
        await recordDeployment({
          table: TABLES.ENGINE_JOBS,
          key: { userId: USER_ID, jobId: job.jobId },
          targetId,
          // 经典分支也显式写 scheduler —— 台账必须自己说清这份产物在哪个调度器上,
          //   不靠「缺省即 mwaa」的隐式约定(切换偏好后判定、页面 tag、下线分路都读它)。
          record: { version, publishedAt: Date.now(), status: "ok", artifact: dagId, scheduler: "mwaa" },
        });
        rows.push({ targetId, dagId, status: "ok", bucket: ep.dagBucket, envName: ep.envName, region: ep.region, scheduler: "mwaa" });
      } catch (e) {
        const error = String((e as Error)?.message || e).slice(0, 900);
        await recordDeployment({
          table: TABLES.ENGINE_JOBS,
          key: { userId: USER_ID, jobId: job.jobId },
          targetId,
          record: { version, publishedAt: Date.now(), status: "failed", error, artifact: dagId },
        }).catch(() => {});
        rows.push({ targetId, dagId, status: "failed", error, ...(isServerlessEndpoint(ep) ? { bucket: ep.workflowBucket, envName: dagId, scheduler: "serverless" as const } : { bucket: ep.dagBucket, envName: ep.envName, scheduler: "mwaa" as const }), region: ep.region });
        stopped = true;
      }
    },
    { sequential: true, via: "engine-job.publishFanout" }
  );
  return { rows, version, baseDagId: base, endpoints: Object.fromEntries(endpoints) };
}

/** 下线 EMR 作业的**全部**产物:覆盖面 = 绑定 ∪ 台账(解绑 ≠ 下线),逐 target 去它自己的 MWAA。 */
export async function offlineEmrFanout(
  job: EmrEngineJob
): Promise<Array<{ targetId: string; dagId: string; paused: boolean; dagFileDeleted: boolean; skipped?: string; failed?: boolean }>> {
  const base = emrBaseDagIdOf(job);
  const { offlineDag } = await import("@/lib/scheduler/mwaa-offline");
  const list = deployedOrBoundTargets(job as unknown as { targets?: unknown; deployments?: unknown });
  const out: Array<{ targetId: string; dagId: string; paused: boolean; dagFileDeleted: boolean; skipped?: string; failed?: boolean }> = [];
  // 一次请求碰多个区 ⇒ 唯一写法 `forEachTargetPlace`(L10):逐区**顺序**执行(与原 for 循环同序,
  //   stop-on-first-failure 照旧),解析得开的区各自一个嵌套落点上下文;循环体除 `continue` → `return` 外一字未改。
  await forEachTargetPlace(
    list.length ? list : [HOME_TARGET_ID],
    async (targetId) => {
      const dagId = dagIdForTarget(base, targetId);
      // 按台账 scheduler 分路下线(见 dag-fanout.offlineFanout 同款)
      const rec = (job as unknown as { deployments?: Record<string, { scheduler?: string; workflowArn?: string } | undefined> }).deployments?.[targetId];
      let r: { paused: boolean; dagFileDeleted: boolean; skipped?: string; failed?: boolean };
      if (rec?.scheduler === "serverless") {
        try {
          const { serverlessEndpointFor } = await import("@/lib/scheduler/mwaa-endpoint");
          const sep = await serverlessEndpointFor(targetId);
          const o = await offlineServerlessWorkflow({ ep: sep, dagId, workflowArn: rec.workflowArn });
          r = { paused: o.deleted, dagFileDeleted: o.dagFileDeleted };
        } catch (e) {
          // 🔴 与 dag-fanout 同款 —— 失败不清台账(workflowArn 是找回孤儿的唯一线索)
          r = { paused: false, dagFileDeleted: false, skipped: `serverless 下线失败:${String((e as Error)?.message ?? e).slice(0, 240)}`, failed: true };
        }
      } else {
        r = await offlineDag(dagId, targetId);
      }
      if (!r.failed) await removeDeployment({ table: TABLES.ENGINE_JOBS, key: { userId: USER_ID, jobId: job.jobId }, targetId });
      out.push({ targetId, dagId, paused: r.paused, dagFileDeleted: r.dagFileDeleted, ...(r.skipped ? { skipped: r.skipped } : {}), ...(r.failed ? { failed: true } : {}) });
    },
    { sequential: true, via: "engine-job.offlineFanout" }
  );
  return out;
}
