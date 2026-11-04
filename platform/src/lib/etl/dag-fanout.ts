// @kf-batch 50-P50.3-fanout
// **逐 target 扇出下发**(50 DESIGN §5.2「逐 region 下发」/ INTERACTION §2.2 / SPEC §1.3a-S1)——
// 一个定义绑了 N 个 region,发布时就要产出 N 份产物、写 N 条台账。本文件是这件事的**唯一作者**。
//
// ── 为什么必须有这一刀 ────────────────────────────────────────────────────────
// W3-a 只做到「绑定的**第一个** target 与手动运行同一个」。那一步之后:
//   · 一个绑了 `[home, usw2]` 的作业,发布调度只会产出 **home 那一份** DAG ⇒ usw2 永远不被调度;
//   · 而作业列表看起来「已绑两个区、已发布」⇒ **静默漏区**,正是客户痛点原话「怕漏 region 对不上」。
// 所以扇出与「版本一致性矩阵」是**同一件事的两面**:扇出负责真发出去,台账负责让漏的那格显出来。
// 🔴 也因此矩阵**不能先于扇出做** —— 单绑之下每行只有一个格子有值,「漏发/版本不齐」概念不成立,
// 那张看板会是假的(50 ROADMAP §2octies 的切法订正)。
//
// ── dag_id 的命名口径(逐字节兼容是硬要求)────────────────────────────────────
//   · home       → **与存量完全同名**(`bgp_etl_<jobId>`)。换名会让存量 DAG 变成孤儿:
//     旧文件还在 S3、MWAA 还在按 cron 触发它,新名的 DAG 也在跑 ⇒ **同一作业一天跑两遍**。
//   · 非 home    → `<base>__<targetId>`(用 **targetId 原值**,不用 slug)。
//     Airflow 的 dag_id 允许 `_`,SPEC §1.1a 的口径是「只有禁 `_` 的出口才换 slug」;
//     混用两种分隔符只会让人以后分不清哪个是哪个。
//   🔴 这个映射是**单向**的:权威记录是台账里的 `deployments[targetId].artifact`,
//   不要试图从 dag_id 反解 targetId(`TARGET_ID_RE` 允许正文内部出现 `__`,反解不唯一)。
//
// ── 🔴 WP-13(2026-09-06 用户拍板)「每个区域的定时任务都是自己区域的 MWAA 执行的」──────────
// 本文件曾把 N 份 DAG 都写进 **home** 桶、由 home Airflow 跨区触发。现在每份产物落**该 target 自己的** MWAA
// (`mwaaEndpointFor`,SPEC §3.14):桶 / 环境 / region 三元由 mwaa-endpoint.ts 单一作者给,这里只按它写;
// 缺 MWAA 的 target 在**任何写之前**整体拒(`requireMwaaForTargets`,零产物),预览行给机器可读 code 让前端直达补装。
//
// ── 「解绑 ≠ 下线」(本文件最容易被漏掉的一条)──────────────────────────────
// 把作业从 `[home, usw2]` 改成 `[home]` 之后,usw2 那份 DAG **还在 MWAA 里按 cron 跑**。
// 症状不是报错,是「作业已经不绑那个区了,那个区还在往自己的数仓里写数」——
// 在跨法域场景下这就是**数据出境**。⇒ 绑定收缩时必须显式下线被摘掉的那些 target
// (`offlineUnboundTargets`),而下线的覆盖面是 **绑定 ∪ 台账**,不是只看当前绑定。

// @kf-batch 50-WP31-place-first-class —— 多区扇出的唯一写法(L10)
import { forEachTargetPlace } from "@/lib/place/fanout";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { TABLES } from "@/lib/aws/dynamodb";
import { generateEtlJobDag } from "@/lib/etl/dag-generator";
import { bindingTargets, resolveRedshiftBinding } from "@/lib/exec-env/data-plane-target";
import { assertTargetId, isHome } from "@/lib/exec-env/target-id";
import { regionOfTarget } from "@/lib/exec-env/target-region";
import { s3ClientFor } from "@/lib/exec-env/target-clients";
import { recordDeployment, removeDeployment } from "@/lib/exec-env/deployments";
// @kf-batch 50-WP15-airflow-serverless —— serverless 分路(产物 = YAML + 运行时代码包 → 该区 workflow;经典分路逐字节不变)
import { publishServerlessWorkflow, offlineServerlessWorkflow } from "@/lib/scheduler/serverless/publish";
import type { ServerlessJobSpec } from "@/lib/scheduler/serverless/yaml-generator";
// 序 73 模块 57 —— serverless 作业 spec 的唯一作者(字段集合只在那里定义;工作流离线作业节点拼的是同一份)
import { serverlessJobSpecFor } from "@/lib/etl/job-spec";
// @kf-batch 50-WP5-rungroup —— 组表名的单一出口(别处不许再写 TABLES.RUN_GROUPS)
import { runGroupsTableName } from "@/lib/monitor/run-groups";
import { resolveRunStamp } from "@/lib/monitor/run-records";
import { currentDefinitionVersion } from "@/lib/versions/version-service";
// @kf-batch 50-WP13-mwaa-region —— 「哪个 target 用哪套 Airflow」的唯一作者(SPEC v3.26 §3.14)
import {
  homeMwaaEndpoint,
  mwaaEndpointFor,
  MwaaNotInstalled,
  MWAA_NOT_INSTALLED_CODE,
  requireMwaaForTargets,
  isServerlessEndpoint,
  // @kf-batch 50-WP15-airflow-serverless(施工序 6):预览与发布同一份联合解析;调度器切换时下线旧产物
  schedulerEndpointFor,
  serverlessEndpointFor,
  type SchedulerEndpoint,
  type MwaaEndpoint,
  type ServerlessEndpoint,
} from "@/lib/scheduler/mwaa-endpoint";
import type { EtlJob } from "@/types/etl-job";

const USER_ID = "default-user";

/**
 * home 的 DAG 桶(GET 预览响应顶层 `bucket` 字段的兼容口径)。
 * @kf-batch 50-WP13-mwaa-region 🔴 **不再是「所有 target 的桶」**:非 home 的 DAG 从此落**该 target 自己的** MWAA 桶
 *   (`MwaaEndpoint.dagBucket`,预览 / 发布行级 `bucket` 才是真值)。原注释「只有 home 有 MWAA」已作废 —— 那正是用户点名的漏洞。
 */
export function mwaaDagBucket(): string {
  // home-only-exit: 这是 GET 预览响应**顶层 `bucket`** 的兼容口径(老客户端读它),不参与任何下发决策;
  //   每一行产物的真值是行级 `bucket`(= 该 target 自己的桶)。收口方式 = 老字段下线后本函数一并删。
  return homeMwaaEndpoint().dagBucket;
}

/** 作业的基准 dagId(home 那一份;非 home 在它后面加 target 段)。 */
export function baseDagIdOf(job: Pick<EtlJob, "jobId" | "airflowDagId">): string {
  return job.airflowDagId || `bgp_etl_${job.jobId}`;
}

/**
 * (基准 dagId × target) → 这一份 DAG 的 dag_id。
 *
 * 🔴 home **逐字节等于基准值**(见文件头:换名 = 存量 DAG 变孤儿 = 同一作业一天跑两遍)。
 */
export function dagIdForTarget(baseDagId: string, targetId: string): string {
  if (isHome(targetId)) return baseDagId;
  return `${baseDagId}__${assertTargetId(targetId)}`;
}

/** 一行下发预览(INTERACTION §2.2:让运维在**下发之前**看清烘焙进产物的值)。 */
export interface FanoutPlanRow {
  targetId: string;
  home: boolean;
  region: string;
  workgroup: string;
  database: string;
  dagId: string;
  /** 🔴 WP-13:**该 target 自己的** DAG 桶(缺 MWAA 时为 `—`) */
  bucket: string;
  /** 该 target 的 Airflow 环境名(缺 MWAA 时为 `—`);serverless ⇒ `workflow <dagId>` */
  envName: string;
  /** @kf-batch 50-WP15-airflow-serverless:这一行会走哪个调度器(INTERACTION §2.2b 预览行显示;缺调度组件时无) */
  scheduler?: "mwaa" | "serverless";
  /**
   * 凭证**形态**。🔴 只给形态,绝不给 ARN/用户名/口令 —— 预览是要显示给人看的,
   * 而凭证标识落进前端就等于落进浏览器历史与截图(§3.9a 的返回面封闭同一条理由)。
   */
  credential: "per-project" | "shared-admin" | "worker-iam";
  /** 这个 target 现在能不能下发。`false` 时 `reason` 必有值。 */
  ok: boolean;
  reason?: string;
  /** @kf-batch 50-WP13-mwaa-region 机器可读拒因(前端据此渲染「去执行环境补装 MWAA」按钮) */
  code?: typeof MWAA_NOT_INSTALLED_CODE;
}

/**
 * 算下发预览。
 *
 * 🔴 **绝不抛**:预览的全部意义就是「先把哪个区会失败、为什么,一次性摆出来」。
 * 一个 target 解析失败就整体抛错的话,用户只能看到第一个错、一个一个试
 * (宪法 B6「前置校验提前告知」的反面)。所以逐行 try,把原因写进 `reason`。
 */
/** @kf-batch 50-WP5-rungroup —— 本文件产出的定时组属于哪类定义(值域 = 模块 14 的 ResourceType) */
const DEFINITION_KIND = "etl-job";

// 序 73 模块 57:`serverlessPlaceOf`(执行落点 PlaceWire)随 spec 字面量一起搬进唯一作者 `lib/etl/job-spec.ts`。

export async function planFanout(job: EtlJob): Promise<FanoutPlanRow[]> {
  const base = baseDagIdOf(job);
  const rows: FanoutPlanRow[] = [];
  // @kf-batch 50-WP31-place-first-class —— 一次请求碰多个区 ⇒ 唯一写法 `forEachTargetPlace`(L10):逐区**顺序**执行(与原 for 循环同序,
  //   stop-on-first-failure 照旧),解析得开的区各自一个嵌套落点上下文;循环体除 `continue` → `return` 外一字未改。
  await forEachTargetPlace(
    bindingTargets(job),
    async (targetId) => {
      const home = isHome(targetId);
      const dagId = dagIdForTarget(base, targetId);
      // @kf-batch 50-WP13-mwaa-region
      // 🔴 先解析**该 target 的 MWAA**:没装就整行 ✗ + 机器可读 code(前端渲染「去执行环境补装 MWAA」),
      //    而不是把它的 DAG 算成「发到 home 桶」—— 那就是用户点名的跨区域调度。
      // @kf-batch 50-WP15-airflow-serverless —— 🔴 预览与发布**同一份解析**(schedulerEndpointFor)。真环境 T-3:预览仍按经典 MWAA 解析,
      //    与实际走 serverless 的发布不一致;只装 serverless 的 target 会被预览判 ✗ 挡住整次发布。
      let ep: SchedulerEndpoint | null = null;
      let mwaaReason: string | undefined;
      try {
        ep = await schedulerEndpointFor(targetId);
      } catch (e) {
        if (e instanceof MwaaNotInstalled) mwaaReason = e.missing[0]?.reason ?? "未安装调度组件";
        else mwaaReason = (e as Error)?.message || String(e);
      }
      const sls = ep !== null && isServerlessEndpoint(ep);
      const common = {
        targetId,
        home,
        dagId,
        bucket: ep ? (sls ? (ep as ServerlessEndpoint).workflowBucket : (ep as MwaaEndpoint).dagBucket) : "—",
        envName: ep ? (sls ? `workflow ${dagId}` : (ep as MwaaEndpoint).envName) : "—",
        ...(ep ? { scheduler: (sls ? "serverless" : "mwaa") as "serverless" | "mwaa" } : {}),
      };
      if (!ep) {
        let region = "?";
        try {
          region = await regionOfTarget(targetId);
        } catch {
          /* 目标不存在等:region 未知 */
        }
        rows.push({ ...common, region, workgroup: "—", database: "—", credential: "worker-iam", ok: false, reason: mwaaReason, code: MWAA_NOT_INSTALLED_CODE });
        return; // (原 continue)
      }
      if (job.type !== "redshift") {
        // Glue 作业不经 Redshift 落点解析;W3-g 起 Glue 可在非 home 跑(脚本 / 作业 / StartJobRun 全走该区客户端)。
        rows.push({ ...common, region: ep.region, workgroup: "—", database: "—", credential: "worker-iam", ok: true });
        return; // (原 continue)
      }
      try {
        const b = await resolveRedshiftBinding({
          targetId,
          projectId: job.projectId,
          workgroupOverride: job.redshiftConfig?.workgroupName,
          databaseOverride: job.redshiftConfig?.database,
        });
        rows.push({
          ...common,
          region: b.region,
          workgroup: b.workgroup,
          database: b.database,
          credential: !b.secretArn ? "worker-iam" : b.degradedToLegacyAdmin ? "shared-admin" : "per-project",
          ok: true,
        });
      } catch (e) {
        rows.push({
          ...common,
          region: ep.region,
          workgroup: "?",
          database: "?",
          credential: "worker-iam",
          ok: false,
          reason: (e as Error)?.message || String(e),
        });
      }
    },
    { sequential: true, via: "etl-job.planFanout" }
  );
  return rows;
}

export interface FanoutPublishRow {
  targetId: string;
  dagId: string;
  /** @kf-batch 50-WP13-mwaa-region 这份产物落到的桶 / Airflow / region(该 target 自己的;skipped 行为空) */
  bucket?: string;
  envName?: string;
  region?: string;
  /** `skipped` = 前面某个 target 失败,按 fail-fast 停在那里,这个 target **没动过** */
  status: "ok" | "failed" | "skipped";
  error?: string;
  /** @kf-batch 50-WP15-airflow-serverless:这份产物走的调度器 */
  scheduler?: "mwaa" | "serverless";
  workflowArn?: string;
}

/**
 * 逐 target 串行下发,**fail-fast**(INTERACTION §2.2:「某 region 失败即停,已成功的保留」)。
 *
 * 🔴 为什么串行 fail-fast、而不是并发尽力而为:多区下发失败最常见的原因是**共因**
 * (组件没装齐、凭证还没供给、跨法域门)。并发只会把同一个错在 N 个区各犯一遍,
 * 还让「哪个区先坏的」不可复现。
 *
 * 🔴 **失败也写台账**(`status:"failed"` + error):不写就退化成 `never-deployed`,
 * 而「从没发过」与「发过但失败了」处置完全不同 —— 后者要看错误(权限?组件?)。
 * 被 fail-fast 跳过的 target **不写**:它确实没动过,写 failed 就是编造。
 */
export async function publishFanout(
  job: EtlJob,
  args: {
    cron: string;
    // @kf-batch 50-P50.3-matrix
    /**
     * 🔴 只下发这几个 target(版本一致性矩阵的「**重发到此 region**」用)。
     * 必须是**绑定的子集** —— 由调用方(路由)先校验;这里再过一遍归一,
     * 不在绑定里的直接被过滤掉而不是"顺手绑上"(下发不该有副作用改绑定)。
     */
    onlyTargets?: string[];
  }
): Promise<{ rows: FanoutPublishRow[]; version: number; baseDagId: string; endpoints: Record<string, SchedulerEndpoint> }> {
  const base = baseDagIdOf(job);
  const version = await currentDefinitionVersion("etl-job", job.jobId);
  // 🔴 **home 排在最前**(其余保持用户点选顺序)。理由是 fail-fast 的一个副作用:
  // 用户若先勾 us-west-2 再勾 home,而 usw2 这次发不出去(组件/凭证/桶策略),
  // 按原顺序就会在第一个 target 上停住 ⇒ **home 那份根本不会更新**,
  // 而 home 是存量业务所在、也是最可能成功的那个。让它先落地才符合 §2.2「已成功的保留」。
  // (只改下发**顺序**,不改绑定本身 —— 绑定顺序仍是用户的,存在 `targets[]` 里。)
  const all = bindingTargets(job).slice().sort((a, b) => (isHome(a) ? -1 : isHome(b) ? 1 : 0));
  // @kf-batch 50-P50.3-matrix —— 子集重发:只保留既在绑定里、又被点名的那些。
  const only = args.onlyTargets && args.onlyTargets.length ? new Set(args.onlyTargets) : null;
  const targets = only ? all.filter((t) => only.has(t)) : all;
  if (only && targets.length === 0) {
    throw new Error(
      `点名的执行目标都不在该作业的绑定里(点名:${args.onlyTargets!.join("/")};绑定:${all.join("/")})⇒ 拒绝下发。` +
        `下发不会顺手改绑定 —— 要发到新区域请先在作业编辑器里绑上它。`
    );
  }
  // @kf-batch 50-WP13-mwaa-region
  // 🔴 **先核全部 target 的 MWAA,再动任何一个字节**(ACCEPTANCE E-208:缺 MWAA 时零产物)。缺的一起列(宪法 B6),
  //    抛 MwaaNotInstalled 由路由映射 409 + 直达补装;绝不「把该区的 DAG 先发到 home」。
  const endpoints = await requireMwaaForTargets(targets);
  const rows: FanoutPublishRow[] = [];
  let stopped = false;

  // @kf-batch 50-WP31-place-first-class —— 一次请求碰多个区 ⇒ 唯一写法 `forEachTargetPlace`(L10):逐区**顺序**执行(与原 for 循环同序,
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
        // @kf-batch 50-WP15-airflow-serverless —— 调度器切换(详情页改偏好后重新发布):台账记的调度器 ≠ 本次端点种类 ⇒ 先下线旧产物,
        //    否则两套调度器按同一 cron 跑同一作业(S-10)。有台账且种类不同才动手;零切换 = 零副作用。
        await offlinePreviousSchedulerIfSwitched(job, targetId, dagId, ep);
        const binding =
          job.type === "redshift"
            ? await resolveRedshiftBinding({
                targetId,
                projectId: job.projectId,
                workgroupOverride: job.redshiftConfig?.workgroupName,
                databaseOverride: job.redshiftConfig?.database,
              })
            : undefined;
        // @kf-batch 50-WP15-airflow-serverless —— serverless 分路:同一份绑定解析(binding),产物换成 YAML + 运行时代码包 + workflow
        if (isServerlessEndpoint(ep)) {
          const stamp = resolveRunStamp(job, targetId);
          // 序 73 模块 57:spec 字段集合只在唯一作者 `lib/etl/job-spec.ts#serverlessJobSpecFor` 定义(工作流的离线作业节点拼的是同一份);
          //   这里只解析事实(端点区 / 数仓绑定 / 定时分组)再交给它。产物逐字节同搬出前。
          const spec: ServerlessJobSpec = serverlessJobSpecFor(job, targetId, {
            dagId,
            endpointRegion: ep.region,
            binding: job.type === "redshift" ? binding : undefined,
            // @kf-batch 50-WP5-rungroup —— O2 定时确定性分组。
            // 🔴 判据是 **`all`(全部绑定)而不是 `targets`(本次发布的子集)**:子集重发时若按 `targets` 判,
            //    那个区的 DAG 就会**没有** scheduledGroup,而另一个区还带着 ⇒ 同一个 cron 分出两个组
            //    (症状只是「没归成一组」,不报错 —— 正是本模块要消灭的那类静默)。
            ...(all.length > 1
              ? {
                  scheduledGroup: {
                    definitionKind: DEFINITION_KIND,
                    definitionId: job.jobId,
                    cron: args.cron,
                    table: runGroupsTableName(),
                    projectId: stamp.projectId,
                    requestedTargets: all,
                    definitionVersion: version,
                  },
                }
              : {}),
          });
          const existingArn = (job.deployments as Record<string, { workflowArn?: string } | undefined> | undefined)?.[targetId]?.workflowArn;
          const pub = await publishServerlessWorkflow({ ep, dagId, cron: args.cron, spec, existingArn, description: `BGP ETL job ${job.jobId} (${job.type}) on ${targetId}` });
          await recordDeployment({
            table: TABLES.ETL_JOBS,
            key: { userId: USER_ID, jobId: job.jobId },
            targetId,
            record: { version, publishedAt: Date.now(), status: "ok", artifact: dagId, scheduler: "serverless", workflowArn: pub.workflowArn, workflowVersion: pub.workflowVersion },
          });
          rows.push({ targetId, dagId, status: "ok", bucket: ep.workflowBucket, envName: pub.workflowName, region: ep.region, scheduler: "serverless", workflowArn: pub.workflowArn });
          return; // (原 continue)
        }
        const dag = generateEtlJobDag(
          // Glue 作业名由生成器按 **本份 DAG 的 target** 派生(`glueJobNameFor`),不再从这里透传一个跨区同名值
          { ...job, cronExpression: args.cron, airflowDagId: base },
          {
            // 🔴 这三样必须一起传:只传 region 而 workgroup 还是 home 的话不报错,
            // 只是「看起来正常地连到了别的区域」(见 data-plane-target.ts 文件头)。
            targetId,
            dagId,
            ...(binding
              ? {
                  redshiftSecretArn: binding.secretArn,
                  execRegion: binding.region,
                  workgroup: binding.workgroup,
                  database: binding.database,
                }
              : {}),
          }
        );
        // 🔴 写**该 target 自己的** DAG 桶(S3 客户端按该区建;桶名来自它的描述符)—— home 逐字节 = 原来的 home 桶
        const s3 = await s3ClientFor(ep.region);
        await s3.send(
          new PutObjectCommand({ Bucket: ep.dagBucket, Key: `dags/${dagId}.py`, Body: dag, ContentType: "text/x-python" })
        );
        // 🔴 台账在 S3 写**成功之后**才记 ok:先记后写会在写失败时留下一条绿格(看板假绿)。
        await recordDeployment({
          table: TABLES.ETL_JOBS,
          key: { userId: USER_ID, jobId: job.jobId },
          targetId,
          // @kf-batch 50-WP15-airflow-serverless(T-16):经典分支也显式写 scheduler —— 台账必须自己说清这份产物在哪个调度器上,
          //   不靠「缺省即 mwaa」的隐式约定(切换偏好后判定、页面 tag、下线分路都读它)。
          record: { version, publishedAt: Date.now(), status: "ok", artifact: dagId, scheduler: "mwaa" },
        });
        rows.push({ targetId, dagId, status: "ok", bucket: ep.dagBucket, envName: ep.envName, region: ep.region, scheduler: "mwaa" });
      } catch (e) {
        const error = String((e as Error)?.message || e).slice(0, 900);
        await recordDeployment({
          table: TABLES.ETL_JOBS,
          key: { userId: USER_ID, jobId: job.jobId },
          targetId,
          record: { version, publishedAt: Date.now(), status: "failed", error, artifact: dagId },
        }).catch(() => {
          /* 台账写不进去不能把「这个区发失败了」这个事实吞掉:下面的 rows 仍然记 failed */
        });
        rows.push({ targetId, dagId, status: "failed", error, ...(isServerlessEndpoint(ep) ? { bucket: ep.workflowBucket, envName: dagId, scheduler: "serverless" as const } : { bucket: ep.dagBucket, envName: ep.envName, scheduler: "mwaa" as const }), region: ep.region });
        stopped = true;
      }
    },
    { sequential: true, via: "etl-job.publishFanout" }
  );
  return { rows, version, baseDagId: base, endpoints: Object.fromEntries(endpoints) };
}

/**
 * 下线一个作业的**全部**产物。
 *
 * 🔴 覆盖面 = **当前绑定 ∪ 台账里出现过的 target**。只看当前绑定会漏掉「先解绑、再下线」
 * 这条顺序 —— 那份 DAG 会永久留在 MWAA 里按 cron 跑(见文件头「解绑 ≠ 下线」)。
 */
export async function offlineFanout(
  job: EtlJob,
  opts: { onlyTargets?: string[] } = {}
): Promise<Array<{ targetId: string; dagId: string; paused: boolean; dagFileDeleted: boolean; skipped?: string; failed?: boolean }>> {
  const base = baseDagIdOf(job);
  const { offlineDag } = await import("@/lib/scheduler/mwaa-offline");
  const list = opts.onlyTargets ?? deployedOrBoundTargets(job);
  const out: Array<{ targetId: string; dagId: string; paused: boolean; dagFileDeleted: boolean; skipped?: string; failed?: boolean }> = [];
  // @kf-batch 50-WP31-place-first-class —— 一次请求碰多个区 ⇒ 唯一写法 `forEachTargetPlace`(L10):逐区**顺序**执行(与原 for 循环同序,
  //   stop-on-first-failure 照旧),解析得开的区各自一个嵌套落点上下文;循环体除 `continue` → `return` 外一字未改。
  await forEachTargetPlace(
    list,
    async (targetId) => {
      const dagId = dagIdForTarget(base, targetId);
      // @kf-batch 50-WP15-airflow-serverless —— 台账说这份产物走的是 serverless ⇒ 去该区 workflow(Stop run + DeleteWorkflow + 删定义);否则经典 offlineDag
      const rec = (job.deployments as Record<string, { scheduler?: string; workflowArn?: string } | undefined> | undefined)?.[targetId];
      let r: { paused: boolean; dagFileDeleted: boolean; skipped?: string; failed?: boolean };
      if (rec?.scheduler === "serverless") {
        try {
          const { serverlessEndpointFor } = await import("@/lib/scheduler/mwaa-endpoint");
          const sep = await serverlessEndpointFor(targetId);
          const o = await offlineServerlessWorkflow({ ep: sep, dagId, workflowArn: rec.workflowArn });
          r = { paused: o.deleted, dagFileDeleted: o.dagFileDeleted };
        } catch (e) {
          // 🔴 T-14:下线失败**绝不清台账** —— 台账里的 workflowArn 是平台唯一能再找到它的线索,
          //   清了就是「workflow 还按 cron 跑、平台却认为已下线」的永久孤儿(真环境留下过 4 个)。
          //   失败如实带出(failed),由路由决定报错;运维再点一次下线即可重试。
          r = { paused: false, dagFileDeleted: false, skipped: `serverless 下线失败:${String((e as Error)?.message ?? e).slice(0, 240)}`, failed: true };
        }
      } else {
        // @kf-batch 50-WP13-mwaa-region 🔴 下线去**该 target 的** MWAA(SPEC §3.12 `offlineDag(dagId, targetId)`);原版只 pause home / 删 home 桶
        r = await offlineDag(dagId, targetId);
      }
      // 台账跟着清:DAG 撤了台账还留 ok 就是「看板假绿」(见 removeDeployment 的说明)。
      // 🔴 T-14 例外:下线**失败**时保留台账(含 workflowArn),否则孤儿 workflow 再也找不回来。
      if (!r.failed) await removeDeployment({ table: TABLES.ETL_JOBS, key: { userId: USER_ID, jobId: job.jobId }, targetId });
      out.push({ targetId, dagId, paused: r.paused, dagFileDeleted: r.dagFileDeleted, ...(r.skipped ? { skipped: r.skipped } : {}), ...(r.failed ? { failed: true } : {}) });
    },
    { sequential: true, via: "etl-job.offlineFanout" }
  );
  return out;
}

/**
 * @kf-batch 50-WP18d-unpublish-seam
 * 「逐区下线之后,**哪些区其实没撤下来**」—— 四个调用点(删作业 / 解绑 / 取消调度 ×2)问同一个人。
 *
 * 🔴 为什么必须有这个作者:`offlineFanout` **不抛异常**(它按 T-14 的教训把失败写成 `failed` 行并
 *   刻意保留台账),于是「靠 try/catch 拦住」的调用点**一个都拦不住** —— 真环境的下场是
 *   「页面说已下线 / 作业已删,而那个区的 workflow 还在按 cron 跑,且 workflowArn 随行消失」。
 *   原来这段过滤在两个路由里各写一遍、另两个调用点**根本没写**(写了 ≠ 接上了)。
 */
export function offlineFailures(
  rows: Array<{ targetId: string; skipped?: string; failed?: boolean }>
): Array<{ targetId: string; error: string }> {
  return rows.filter((row) => row.failed).map((row) => ({ targetId: row.targetId, error: row.skipped ?? "下线失败" }));
}

/** 下线失败的统一人话(原来三处逐字重复;要改口径只改这里)。 */
export function offlineFailureMessage(bad: Array<{ targetId: string; error: string }>, tail: string): string {
  return `下线失败(${bad.length} 个区):${bad.map((x) => `${x.targetId} ${x.error}`).join(" / ")}。${tail}`;
}

/** 常用尾句:调度类(状态不变、台账保留、可重试)。 */
export const OFFLINE_RETRY_TAIL =
  "调度状态保持不变、台账保留 —— 再点一次下线可重试(常见原因:还有 run 在跑,等它到终态)。";

/**
 * @kf-batch 50-WP15-airflow-serverless —— 调度器切换时先下线旧产物(ETL / EMR 两条扇出共用)。
 * 台账 `deployments[targetId].scheduler`(缺省 mwaa)≠ 本次端点种类 ⇒ 按**旧**种类下线(serverless ⇒ 删 workflow + 定义;mwaa ⇒ pause + 删 DAG 文件)。
 * 返回被下线的旧种类;无台账 / 种类相同 ⇒ "none"(零副作用)。
 */
export async function offlinePreviousSchedulerIfSwitched(
  job: { deployments?: unknown },
  targetId: string,
  dagId: string,
  ep: SchedulerEndpoint
): Promise<"none" | "mwaa" | "serverless"> {
  const rec = (job.deployments as Record<string, { scheduler?: string; workflowArn?: string } | undefined> | undefined)?.[targetId];
  if (!rec) return "none";
  const prev: "mwaa" | "serverless" = rec.scheduler === "serverless" ? "serverless" : "mwaa";
  const next: "mwaa" | "serverless" = isServerlessEndpoint(ep) ? "serverless" : "mwaa";
  if (prev === next) return "none";
  if (prev === "serverless") {
    const sep = await serverlessEndpointFor(targetId);
    await offlineServerlessWorkflow({ ep: sep, dagId, workflowArn: rec.workflowArn });
  } else {
    const { offlineDag } = await import("@/lib/scheduler/mwaa-offline");
    await offlineDag(dagId, targetId);
  }
  return prev;
}

/** 台账里出现过的 target ∪ 当前绑定(去重,顺序:绑定优先)。 */
export function deployedOrBoundTargets(job: { targets?: unknown; targetId?: unknown; deployments?: unknown }): string[] {
  const bound = bindingTargets(job);
  const deployed = Object.keys((job.deployments ?? {}) as Record<string, unknown>);
  const all = [...bound, ...deployed];
  return all.filter((x, i) => all.indexOf(x) === i);
}

/**
 * 绑定**收缩**时下线被摘掉的那些 target。
 *
 * 调用点 = 编辑作业(PUT)。🔴 不做这件事的后果不是报错,是那个区**继续按 cron 往自己的数仓写数**,
 * 而界面上它已经不绑那个区了(跨法域下即数据出境)。
 */
export async function offlineUnboundTargets(
  job: EtlJob, newTargets: string[]
): Promise<{ offlined: string[]; failures: Array<{ targetId: string; error: string }> }> {
  const keep = new Set(newTargets);
  const removed = deployedOrBoundTargets(job).filter((t) => !keep.has(t));
  if (removed.length === 0) return { offlined: [], failures: [] };
  // 🔴 原来这里把 `offlineFanout` 的返回**整个丢掉**、只回名字 ⇒ 「被摘掉的区其实没撤下来」
  //   在调用方那里长得和成功一样(而 `offlineFanout` 从不抛,PUT 的 try/catch 拦不到)。
  //   后果正是上面注释写的那件事:那个区继续按 cron 往自己的数仓写数,而界面上已经不绑它。
  const rows = await offlineFanout(job, { onlyTargets: removed });
  const failures = offlineFailures(rows);
  return { offlined: removed.filter((t) => !failures.some((fail) => fail.targetId === t)), failures };
}


// @kf-batch 50-WP31-place-first-class —— 原 resolveWorkgroupForSpec(数仓绑定缺失时的工作组缺省)已删:落点只来自绑定(serverlessPlaceOf)
// 序 73 模块 57 —— `splitSqlForSpec` 随 spec 字面量一起搬进唯一作者 `lib/etl/job-spec.ts`(语句切分仍只经 lib/etl/dag-generator.ts#splitSql)。
