// （根治 Task#19）— workflow DAG 生成+下发的【单一权威实现】(SSOT)。
//
// 【为什么存在】publish/route.ts 与 schedule/enable/route.ts 都要"按引擎 flag 生成 workflow DAG 并下发 S3",
// 但历史上各写了一份:publish 正确(flag 分派 + 能力门 + runtime-lib 下发),schedule/enable 是【陈旧副本】
// (硬编码 legacy、无 flag、无能力门、无 runtime-lib 下发、连 redshiftSecretArn 都没传)。两份漂移 → 含新节点
// 的 workflow 从监控页切调度时被 legacy 生成的坏 DAG 覆盖掉 publish 的好 DAG(写同一 S3 key)。
// 根治=把这段逻辑抽成本函数,两个路由同调,消灭副本(单点修 import 只治标,副本还会再漂移)。

// MWAA 环境 / 桶只经解析器(home 逐字节不变)
// 🔴🔴 编排的 target 维度接线。
// 用户 2026-09-10 **第三次**强调:「**这个是误区,我一开始要求的就是按照分区隔离,每一个分区都有
// MWAA serverless 的调度能力,调度只能在自己的区域执行。只是元数据收集上报到主控区而已。**」
// 我此前把「一个 AgentCore / 一个 OpenMetadata」那条中心化纪律套到编排上了 —— 那条只管 AgentCore 与 OM。
// 逐区扇出的机器(`schedulerEndpointFor` + fail-closed 不回落 home)就建好了,
// 只有编排这条路径一直没接。这一刀接上。
import { schedulerEndpointFor, isServerlessEndpoint, unpauseWhenLoaded, MwaaNotInstalled } from "@/lib/scheduler/mwaa-endpoint";
// 多节点编排也走 serverless(SPEC v3.43 §3.15;形状只有 tasks)
import { assertServerlessExpressible, buildWorkflowTasksYaml } from "@/lib/scheduler/serverless/workflow-yaml";
import { publishServerlessWorkflow, offlineServerlessWorkflow } from "@/lib/scheduler/serverless/publish";
import { findWorkflowArnByName, getWorkflow } from "@/lib/scheduler/serverless/workflow-client";
import { buildDagSpec } from "@/lib/workflow/dag-generator-v2";
import { offlineDag } from "@/lib/scheduler/mwaa-offline";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { bindingTargets, resolveRedshiftBinding } from "@/lib/exec-env/data-plane-target";
import { s3ClientFor } from "@/lib/exec-env/target-clients";
import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { generateAirflowDag } from "@/lib/workflow/dag-generator";
import { generateAirflowDagV2, checkEngineCapability } from "@/lib/workflow/dag-generator-v2";
import { RUNTIME_LIB_FILENAME, RUNTIME_LIB_SOURCE, AIRFLOW_IGNORE_CONTENT } from "@/lib/workflow/runtime-lib";
import type { Workflow } from "@/types/workflow";
import type { CarrierLedger } from "@/lib/scheduler/carrier-ledger";
// 逐区全失败时怎么合成拒因,只有这一个作者
import { fanoutRejection } from "@/lib/scheduler/fanout-reject";
// 离线作业节点的发布期 spec 解析 + 同步 / 作业节点的落点一致性 fail-closed(唯一作者)
import { assertWorkflowNodesRunOn, resolveWorkflowJobSpecs, withJobSpecs } from "@/lib/workflow/job-node-spec";
// 作业节点在该区的就位(Glue 作业定义 / EMR 脚本 · jar · application)—— 写操作,只在发布的写阶段调
import { prepareJobNodesForTarget } from "@/lib/workflow/job-node-prepare";

// 🔴 这里原来有个 `WorkflowSchedulerUnsupported`(「多节点编排只支持经典 MWAA」)。**已删**:
//   那条拒绝的前提是「dag-factory 表达不了多节点」,而 2026-09-11 的真跑证伪了它
//   (`tasks` + `dependencies` + `trigger_rule` 都支持;只有两个 operator 在白名单外)。
//   留着一个永远不会走到的抛错分支 = 下一个人以为还不支持(而且判据会去钉它)⇒ 一并删干净。
//   现在真正无对应物的只有 `external` 节点,由 `assertServerlessExpressible` 在**生成期**拒
//   (错误类型 `ServerlessNodeUnsupported`,路由转 400)。

// 33-B Strangler 引擎开关(照 GenBI GENBI_BACKEND 的 env-flag 机制)。默认 legacy,零行为变化;
// 设 runtime-lib 走新引擎(v2 + 固定库,支持 branch/join/foreach 等新节点)。
export function dagEngine(): "legacy" | "runtime-lib" {
  return (process.env.WORKFLOW_DAG_ENGINE || "legacy").toLowerCase() === "runtime-lib"
    ? "runtime-lib" : "legacy";
}

export interface PublishDagResult {
  dagId: string;
  dagContent: string;
  /** 这份产物发给了哪种调度器(路由与审计如实呈现) */
  scheduler: "mwaa" | "serverless";
  workflowArn?: string;
  workflowVersion?: string;
}

/**
 * 写 `deployments[targetId]`(与作业侧同形)。首次发布时这个 map 还不存在 ⇒ 嵌套路径写会失败,
 * 先 `if_not_exists` 建出 map 再写(两次 UpdateCommand 的写法只在这里出现一次)。
 */
async function recordWorkflowDeployment(
  workflowId: string,
  targetId: string,
  rec: Record<string, unknown>,
  // 🔴 **发布台账写哪一行**由调用方声明(缺省 = 工作流自己 ⇒ 逐字节同改动前)。
  //   不拆这个参数,给同步任务合成的载体就会往 `bgp-workflows` **upsert 出一条幽灵工作流**
  //   —— 与 `schedule/enable` 里已修过的那条盲 Update 是同一个缺陷(理由见 carrier-ledger.ts)。
  ledger?: CarrierLedger
): Promise<void> {
  const table = ledger?.table ?? TABLES.WORKFLOWS;
  const key = ledger?.key ?? { userId: "default-user", workflowId };
  const put = () =>
    docClient.send(new UpdateCommand({
      TableName: table,
      Key: key,
      UpdateExpression: "SET deployments.#tid = :rec",
      ExpressionAttributeNames: { "#tid": targetId },
      ExpressionAttributeValues: { ":rec": rec },
      // 🔴 **条件写**:行必须已存在。合成载体的台账落在同步任务那一行,而 DDB 的 update 是 upsert ⇒
      //   taskId 打错就会凭空造出一条只有 deployments 的幽灵任务(与上面同一类)。
      ConditionExpression: Object.keys(key).map((k) => `attribute_exists(${k})`).join(" AND "),
    }));
  try {
    await put();
  } catch {
    try {
      await docClient.send(new UpdateCommand({
        TableName: table,
        Key: key,
        UpdateExpression: "SET deployments = if_not_exists(deployments, :empty)",
        ExpressionAttributeValues: { ":empty": {} },
        ConditionExpression: Object.keys(key).map((k) => `attribute_exists(${k})`).join(" AND "),
      }));
      await put();
    } catch (e) {
      // 🔴 条件写失败的**唯一**可能原因是「那一行不存在」(键打错 / 对象已被删)。
      //   不加这一层的话调用方拿到的是裸的 `ConditionalCheckFailedException` —— 一个指不到根因的报错,
      //   而真相是「发布记录本来要落在哪一行、那一行没了」。fail-closed 是对的(旧行为是**悄悄造出那一行**),
      //   但拒因必须说人话。
      throw new Error(
        `发布记录写不进 ${table} 的 ${JSON.stringify(key)} —— 那一行不存在(键打错,或对象在发布途中被删)。` +
          `刻意不给它凭空建行:那会造出一条只有 deployments 的幽灵记录。原始错误:${String((e as Error)?.message ?? e)}`
      );
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// **「已发布的载体是不是最新的」= 一个可派生的事实**
//
// 做法:拿当前生成器**重新生成**一遍(唯一作者 `buildCarrierArtifact`,零副作用)+ 从服务
// **只读**取回已发布的定义,两边**逐字节**比。刻意不存 `generatorVersion`:版本号自己会漂
// (忘记 bump 就白搭),而且又多一份要同步的真值 —— 本轮反复修的就是「同一件事两个作者」。
//
// 🔴🔴 **逐字节比对有一个必须先处理的坑(真环境实测出来的)**:定义里有
//   `"start_date": "2026-09-22"` = **生成日 +1**,而且这是**服务端硬约束**
//   (`yaml-generator.ts` 注释:「服务校验 `start_date` **必须在未来**」)。
//   ⇒ 不归一它,**每过一天就会误报一次「载体落后」** —— 而误报比漏报更坏:
//     它会教人不相信这条判据,然后这条判据就等于没有。
// 🔴 归一清单**必须闭合**:只允许下面这一项。将来要加一项,必须在这里显式加、写明
//   「这个字段为什么会变、变了为什么不该算落后」—— 判据钉住清单长度,加了就红,逼人想清楚。
//   反过来,`start_date` 之外的一切都该逐字节稳定 ⇒ 「归一后仍不等」就是一个**闭合式**的
//   落后信号:不用枚举「哪些字段算承重」,也不会漏掉第 N+1 个字段。
// ══════════════════════════════════════════════════════════════════════════════
export const CARRIER_VOLATILE_FIELDS = [
  {
    key: "start_date",
    /** 服务端要求它必须在未来 ⇒ 生成器用「生成日 +1」(`futureStartDate`),每天都变。 */
    why: "MSAF 校验 start_date 必须在未来,生成器按生成日+1 派生 ⇒ 与「定义是否落后」无关",
    re: /^(\s*"?start_date"?\s*:\s*)"?\d{4}-\d{2}-\d{2}"?\s*$/gm,
    to: '$1"<volatile>"',
  },
] as const;

/** 比对前两边都过它 —— 把「按设计必须变」的字段抹平。 */
export function normalizeCarrierDefinition(text: string): string {
  let out = text;
  for (const f of CARRIER_VOLATILE_FIELDS) out = out.replace(f.re, f.to);
  return out;
}

export type CarrierDriftState = "ok" | "stale" | "missing" | "unsupported" | "unknown";

/**
 * 这个工作流在这个 target 上**已发布的定义**是否与**当前生成器**一致。
 * 🔴 **零副作用**:只 `buildCarrierArtifact`(只读)+ `findWorkflowArnByName` / `getWorkflow`(只读)。
 *   绝不顺手重发 —— 判据的夹具不许触发副作用,而「检查」更不许把被检查的东西改掉。
 */
export async function carrierDefinitionDrift(
  workflow: Workflow,
  wfTarget: string,
  opts: { ledger?: CarrierLedger } = {}
): Promise<{ state: CarrierDriftState; scheduler: string; dagId: string; reason?: string }> {
  const art = await buildCarrierArtifact(workflow, wfTarget, opts);
  if (!isServerlessEndpoint(art.ep)) {
    // ⚠️ 如实说明,不假装支持:经典 MWAA 已停供、只保存量,它的产物在 S3 上,
    //   要另写一条「读 S3 再比」的路。本期不做,而且**不许静默当成 ok**。
    return {
      state: "unsupported", scheduler: art.scheduler, dagId: art.dagId,
      reason: "经典 MWAA 只保存量(已停供),载体落后检测本期只覆盖 MWAA Serverless",
    };
  }
  const known = (workflow as unknown as { deployments?: Record<string, { workflowArn?: string } | undefined> })
    .deployments?.[wfTarget]?.workflowArn;
  const arn = known || (await findWorkflowArnByName(art.ep.region, art.dagId));
  if (!arn) {
    return { state: "missing", scheduler: art.scheduler, dagId: art.dagId, reason: "该区没有这个工作流的载体(从未发布 / 已被撤下)" };
  }
  const live = await getWorkflow(art.ep.region, arn);
  const published = String((live as unknown as { WorkflowDefinition?: string }).WorkflowDefinition || "");
  if (!published) {
    return { state: "unknown", scheduler: art.scheduler, dagId: art.dagId, reason: "服务没回 WorkflowDefinition ⇒ 判不了,**不许当成一致**" };
  }
  const same = normalizeCarrierDefinition(published) === normalizeCarrierDefinition(art.content);
  return {
    state: same ? "ok" : "stale",
    scheduler: art.scheduler,
    dagId: art.dagId,
    ...(same ? {} : { reason: "已发布的定义与当前生成器不一致 ⇒ 载体落后,需要重新发布" }),
  };
}

// 生成一个 workflow 的 DAG 并下发到 MWAA S3(含 runtime-lib 固定库幂等下发)。
// 抛错类型:
//  - EngineCapabilityError:legacy 引擎遇新节点(调用方应转 400,提示切 runtime-lib)。
//  - dag-spec-invalid:v2 spec 自校验失败(调用方应转 400)。
// 【关键】任何 S3 写入前先生成 DAG(v2 内含 assertSpecValid fail-loud):非法 spec 直接抛、什么都不下发,
// 杜绝"坏 DAG 落 S3 → MWAA 静默不加载/覆盖好 DAG"。
/**
 * 发到**一个** target(原来的 `publishWorkflowDag` 就是这个;扇出版在下面)。
 */
// ══════════════════════════════════════════════════════════════════════════════
// 🔴🔴 **产物生成的唯一作者**(该缺陷的承重件)。
//
// 【为什么必须抽它】要判「已发布的载体定义是不是最新的」,做法是**拿当前生成器
//   重新生成一遍再比对**(刻意不存 `generatorVersion`:版本号自己会漂,而且又多一份要同步
//   的真值;「重新生成再比」没有第二份真值,忘不掉也漂不了)。
//   ⇒ 如果「发布时怎么生成」与「比对时怎么生成」是**两份代码**,它们迟早分叉,
//     而分叉的表现是**误报「载体落后」** —— 一个永远修不好、还会教人不相信这条判据的红。
//   ⇒ 发布(`publishWorkflowDagToTarget`)与比对(`carrierDefinitionDrift`)**都只能走这里**。
//
// 🔴 **零副作用**:只做只读解析(调度端点 / 数仓落点)+ 纯函数生成;
//   **不写 S3、不调 MSAF、不动台账** —— 所有写操作都留在 `publishWorkflowDagToTarget`。
//   (判据反向钉:本函数体里不许出现 Put/publish/record 这类写。)
// ══════════════════════════════════════════════════════════════════════════════
export interface CarrierArtifact {
  dagId: string;
  ep: Awaited<ReturnType<typeof schedulerEndpointFor>>;
  place: Parameters<typeof buildDagSpec>[1];
  scheduler: "serverless" | "mwaa";
  /** serverless = 定义 YAML;经典 = DAG 的 `.py` 源码。 */
  content: string;
  cron: string | null;
  /** 经典引擎名(serverless 恒 undefined)。 */
  engine?: ReturnType<typeof dagEngine>;
  wfWithDag: Workflow;
}

/**
 * 产物生成的**只读前半段**(「这份发布会不会被拒」的全部判定都在这里,一个写都没有)。
 * 🔴 为什么从 `buildCarrierArtifact` 里拆出来:发布的写阶段(`prepareJobNodesForTarget`:建 Glue 作业定义 / 上传 EMR 脚本 · jar / 建 application)
 *    必须排在**生成之前**(EMR 的 applicationId 要先就位才解析得出 spec),而生成里又藏着会拒的判定
 *    (那个区没装调度器 ⇒ 409 / 服务侧表达不了的节点 ⇒ 400 / legacy 引擎 ⇒ 400 / 作业 · 同步节点不绑该区 ⇒ 400 / spec 自校验 ⇒ 400)
 *    ⇒ 原来的顺序是「先写、再发现要拒」:一次会被 409 / 400 拒掉的发布已经在该区留下了 Glue 作业 / application。
 *    现在:`publishWorkflowDagToTarget` 先走这里把能拒的全拒完,再写,再把这份 plan 交给 `buildCarrierArtifact` 生成(端点 / 落点只解析一次)。
 */
export interface CarrierPlan {
  dagId: string;
  wfBase: Workflow;
  ep: Awaited<ReturnType<typeof schedulerEndpointFor>>;
  place: Parameters<typeof buildDagSpec>[1];
  /** 经典引擎名(serverless 恒 undefined)。 */
  engine?: ReturnType<typeof dagEngine>;
}

export async function resolveCarrierPlan(
  workflow: Workflow,
  wfTarget: string,
  opts: { ledger?: CarrierLedger } = {}
): Promise<CarrierPlan> {
  const dagId = workflow.airflowDagId || `bgp_${workflow.workflowId}`;
  const wfBase: Workflow = { ...workflow, airflowDagId: dagId };

  // 🔴 DAG 发到**这个工作流自己那个区**的调度器。
  // 落点来自行上的章(无章的存量工作流回落主控区 —— 落章之前编排确实只在主控区发布过,是历史事实);
  // 那个区没装调度组件 ⇒ `schedulerEndpointFor` 抛 `MwaaNotInstalled`,由路由转 409 + 直达补装,
  // **绝不回落主控区**(回落 = 用户明令禁止的跨区域调度)。
  // 🔴 端点解析**排在引擎能力门之前** —— 那道门(`WORKFLOW_DAG_ENGINE`)
  //   只管经典 MWAA 用哪个生成器;serverless 侧的运行时**恒是新的**(NODE_EXEC_PY)。
  //   顺序反了会出现最难查的一种:现网 flag=legacy ⇒ 一个带 branch 的图发到 serverless 也被判「引擎不支持」。
  const ep = await schedulerEndpointFor(wfTarget);

  // 🔴🔴 **落点解析必须排在生成之前**。
  // 真环境段 `scq` A2-1 抓到的形态:DAG 文件写进了 usw2 的桶、也真跑在 usw2 的 Airflow(A2-2 绿),
  // 但**正文**里 `region = "us-east-1"`、`WorkgroupName="bgp-workgroup"`、`SecretArn=...us-east-1...`
  // ⇒ 「调度在 usw2、活儿在主控区干」。原因就是这里:生成在解析之前,生成器无从知道落点。
  // 🔴 数仓落点走**唯一作者** `resolveRedshiftBinding`(非法 targetId / 该区没装 redshift 都由它拒)。
  const rsBinding = await resolveRedshiftBinding({ targetId: wfTarget, projectId: workflow.projectId });
  const place = {
    targetId: wfTarget,
    execRegion: ep.region,
    workgroup: rsBinding.workgroup,
    database: rsBinding.database,
    // 🔴🔴 **凭证落点只有一个作者 = `resolveRedshiftBinding`**(2026-09-21 开包勘定)。
    //   原来这里写的是 `rsBinding.home ? opts.redshiftSecretArn : rsBinding.secretArn` ——
    //   home 走调用方传进来的那一个,理由写的是「home 产物逐字节不变」。
    //   但 `resolveRedshiftBinding` 的 home 分支**本来就算出了** `secretArn`
    //   (同一个 `getRedshiftSecretArn`),⇒ home 的凭证有**两个作者**。
    //
    // 🔵 逐条查实**三个**调用方传的是什么,结论是与 `rsBinding.secretArn` **同函数同入参**:
    //     · `api/workflow/[id]/publish` → getRedshiftSecretArn({ project: Item.projectId })   (工作流行)
    //     · `api/schedule/enable`       → getRedshiftSecretArn({ project: wf.projectId })     (工作流行)
    //     · `sync/schedule-carrier`     → getRedshiftSecretArn({ project: task.projectId }),
    //        而它合成的 `wf.projectId` **就是** `task.projectId`
    //   而本函数给 `resolveRedshiftBinding` 传的正是 `workflow.projectId`
    //   ⇒ home 分支 = `getRedshiftSecretArn({ project: workflow.projectId })` ⇒ **逐字节相同**。
    //   ⇒ 那个参数是**纯多余的第二作者**,删掉不改变任何产物。
    //
    // 🔴 **为什么非删不可**(该缺陷的前置):要判「已发布的定义是不是最新的」,做法是
    //   **拿当前生成器重新生成一遍再逐字节比对**。重新生成时没有「调用方传进来的那个」,
    //   只能走 `rsBinding.secretArn` ⇒ 只要这两个作者还并存,home 上的比对就会**误报「载体落后」**。
    redshiftSecretArn: rsBinding.secretArn,
    // 🔴🔴 **台账归属必须跟着落点一起走进生成器**(2026-09-20 真环境抓到,第三轮硬门 `sync × dispatch` 两区都红)。
    //   `CarrierLedger` 有**两个**消费点,而本函数原来只接了一个:
    //     ① 台账归属 —— 发布记录写到哪张表哪个 key(`recordWorkflowDeployment(..., opts.ledger)`)✅ 早就接上;
    //     ② **运行期归属** —— run 行记成什么 `taskType`、要不要往 `bgp-workflows` 写行,
    //        由 `buildDagSpec` 从 `opts.ledger` 派生(dag-generator-v2 的 `ledger_task_*`)❌ **没接**。
    //   于是真环境的形态最难查:载体**真发出去了**、三个 `ledger_*` 字段**真出现在定义里**,
    //   但值是缺省的 `ledger_task_type="workflow"` / `writes_workflow_row=true`
    //   ⇒ 同步的定时真烧了、Glue 真跑了、run 行 `status=succeeded`,而那一行记成**工作流**,
    //     监控页按工作流去 join 名字 ⇒ 用户在运行实例页上**看不到自己配的定时**,还白造一条幽灵工作流行。
    //   🔴 为什么把它并进 `place` 而不是在 `buildDagSpec(...)` 那一处补参数:下面有**三条**生成路
    //     (serverless 的 `buildDagSpec` / 经典 `generateAirflowDagV2` / legacy `generateAirflowDag`),
    //     逐个补一定漏掉第 N+1 条(本仓第 N 次「枚举违规写法」的下场)。落点对象是**唯一形态**:
    //     凡「这份产物属于谁、在哪跑、记到哪」都装在 `place` 里,新增生成路自动带上。
    ledger: opts.ledger,
  };

  // 🔴 **发布期落点一致性 fail-closed**,排在任何写 / 任何生成之前
  //   同步节点关联的任务 / 作业节点引用的作业必须「存在 · 本项目 · 绑定含这个落点」,否则抛 JobNodeUnbound(路由 400 点名节点与作业),
  //   不再等运行期 Glue EntityNotFound。没有作业 / 同步节点的工作流这里零次读。
  await assertWorkflowNodesRunOn(wfBase, wfTarget);

  if (isServerlessEndpoint(ep)) {
    // 生成期就拒不可表达的节点(目前只有 `external`)—— 与 buildWorkflowTasksYaml 里那一道是同一个作者,这里只是提前到写之前
    assertServerlessExpressible((wfBase.dagDefinition?.nodes ?? []).map((n: { type?: string }) => ({ type: n?.type })));
    // spec 自校验(task_id 合法 / 无碰撞 / 引用存在)+ 落点 fail-closed:只看节点 id / 边 / 落点,不看 jobSpec ⇒ 可以在写之前先验一遍(纯函数,结果丢弃)
    buildDagSpec(wfBase, place);
    return { dagId, wfBase, ep, place };
  }

  const engine = dagEngine();
  // 引擎能力门(§8.3):含新节点但当前 legacy 引擎 → 拒绝,防旧引擎静默丢节点(坏 DAG 根因)。
  const cap = checkEngineCapability(wfBase, engine);
  if (!cap.ok) {
    const err: any = new Error(
      `当前 DAG 引擎(${engine})不支持节点类型:${cap.unsupported.join("、")}。` +
      `这些节点需 runtime-lib 引擎(设 WORKFLOW_DAG_ENGINE=runtime-lib)。`
    );
    err.code = "engine-capability";
    throw err;
  }
  // runtime-lib 的 v2 spec 自校验同样可以在写之前先过一遍(legacy 生成器没有这道门,照旧)
  if (engine === "runtime-lib") buildDagSpec(wfBase, place);
  return { dagId, wfBase, ep, place, engine };
}

export async function buildCarrierArtifact(
  workflow: Workflow,
  wfTarget: string,
  opts: { ledger?: CarrierLedger } = {},
  // 发布路径把刚核过的 plan 传进来(端点 / 落点 / 判定只做一次);比对路径不传 ⇒ 这里自己核一遍(仍只读)
  plan?: CarrierPlan
): Promise<CarrierArtifact> {
  const { dagId, wfBase, ep, place, engine } = plan ?? (await resolveCarrierPlan(workflow, wfTarget, opts));

  // 把作业节点的运行 spec(与单作业载体同一份,单一作者 job-node-spec.ts)挂进 `node.data.jobSpec`:
  //   下面三条生成路都从 data 透传,运行期 `_exec_job` 只读它;没有作业节点的工作流这里零次读、产物不变。
  //   EMR 作业要先由写阶段(prepareJobNodesForTarget)建好 application 才解析得出 ⇒ 这一步必须排在写之后(只读比对路径没发布过 ⇒ not-prepared)。
  const wfWithDag = withJobSpecs(wfBase, await resolveWorkflowJobSpecs(wfBase, wfTarget, { dagId, execRegion: ep.region }));

  if (isServerlessEndpoint(ep)) {
    // 生成期就拒不可表达的节点(目前只有 `external`)+ spec 自校验 + 落点 fail-closed,
    // 全部排在**任何 S3 写之前** ⇒ 拒的时候零副作用(不会留下半份产物)。
    const spec = buildDagSpec(wfWithDag, place);
    const cron = workflow.cronExpression || null;
    const yaml = buildWorkflowTasksYaml({ spec, cron });
    return { dagId, ep, place, scheduler: "serverless", content: yaml, cron, wfWithDag };
  }

  // 先生成(v2 含 assertSpecValid 自校验 + 落点 fail-closed)——放任何 S3 put 之前,非法即抛,什么都不下发。
  const dagContent = engine === "runtime-lib"
    ? generateAirflowDagV2(wfWithDag, place)
    : generateAirflowDag(wfWithDag, place);

  return {
    dagId, ep, place, scheduler: "mwaa", content: dagContent,
    cron: workflow.cronExpression || null, engine, wfWithDag,
  };
}

export async function publishWorkflowDagToTarget(
  workflow: Workflow,
  wfTarget: string,
  // `ledger` 缺省 = 工作流自己(零回归)
  // 🔴 50-B09:`redshiftSecretArn` **已删** —— 凭证落点的唯一作者是 `resolveRedshiftBinding`(见下)
  opts: { ledger?: CarrierLedger } = {}
): Promise<PublishDagResult> {
  // 顺序铁律:**① 先把会拒的全判完(只读)→ ② 再写 → ③ 再生成**。
  //   ① `resolveCarrierPlan`:调度端点(没装 ⇒ 409)/ 数仓落点 / 作业 · 同步节点落点一致性(⇒ 400)/ 服务侧表达不了的节点(⇒ 400)/
  //      legacy 引擎能力门(⇒ 400)/ spec 自校验(⇒ 400)—— 任一拒 ⇒ 该区一个字节都没动;
  //   ② `prepareJobNodesForTarget`:作业节点在该区的就位是写操作(Glue 作业定义 / EMR 脚本 · jar · application,与「立即运行」同一组作者);没有作业节点 ⇒ 零写;
  //   ③ `buildCarrierArtifact(plan)`:只读生成(EMR 的 applicationId 这时才就位 ⇒ spec 解析得出)。
  const plan = await resolveCarrierPlan(workflow, wfTarget, opts);
  await prepareJobNodesForTarget(workflow, wfTarget);
  // 🔴 产物**只从唯一作者**拿(它零副作用);
  //   本函数只负责「把它发出去」+ 记台账。生成与发布分开之后,比对路径才可能与发布同源。
  const art = await buildCarrierArtifact(workflow, wfTarget, opts, plan);
  const { dagId, ep, cron } = art;

  // 🔴 用 `isServerlessEndpoint(ep)` 而不是 `art.scheduler === "serverless"`:
  //   前者是 type guard,能把 `ep` 的联合类型窄化掉(后者只是个字符串比较,TS 窄化不了)。
  if (isServerlessEndpoint(ep)) {
    const yaml = art.content;
    // 重新发布必须 UpdateWorkflow(同名 Create 会被服务拒):ARN 先看台账,台账没有就问服务本身。
    const known = (workflow as unknown as { deployments?: Record<string, { workflowArn?: string } | undefined> })
      .deployments?.[wfTarget]?.workflowArn;
    const existingArn = known || (await findWorkflowArnByName(ep.region, dagId));
    const pub = await publishServerlessWorkflow({
      ep,
      dagId,
      definitionYaml: yaml,
      // 没有 cron = 手动工作流:定义里不写 schedule,服务侧也别按调度模式收它
      triggerMode: cron ? "scheduled" : "manual_only",
      existingArn,
      description: `BGP workflow ${workflow.workflowId}`,
    });
    // 台账 deployments[targetId](与作业侧同形);ARN 是下线 / 重发的入口 —— 丢了还能靠名字找回来。
    await recordWorkflowDeployment(workflow.workflowId, wfTarget, {
      scheduler: "serverless", artifact: dagId, workflowArn: pub.workflowArn,
      workflowVersion: pub.workflowVersion, publishedAt: Date.now(), status: "ok",
    }, opts.ledger);
    return { dagId, dagContent: yaml, scheduler: "serverless", workflowArn: pub.workflowArn, workflowVersion: pub.workflowVersion };
  }

  const engine = art.engine!;
  const dagContent = art.content;
  const bucket = ep.dagBucket;
  const s3 = await s3ClientFor(ep.region);

  // 新引擎:发 DAG 前先幂等下发固定库 + .airflowignore(§10.3)。走同一 S3 通道,零 CDK。
  // 【这段是 schedule/enable 此前完全缺失的】——裸换 v2 而不下发库会让 DAG import error。
  if (engine === "runtime-lib") {
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: `dags/${RUNTIME_LIB_FILENAME}`,
      Body: RUNTIME_LIB_SOURCE, ContentType: "text/x-python",
    }));
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: `dags/.airflowignore`,
      Body: AIRFLOW_IGNORE_CONTENT, ContentType: "text/plain",
    }));
  }

  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: `dags/${dagId}.py`,
    Body: dagContent, ContentType: "text/x-python",
  }));

  return { dagId, dagContent, scheduler: "mwaa" };
}

/**
 * 一个工作流在 serverless 侧的 workflowArn(读侧也要,单一作者收在这里)。
 * 台账 `deployments[targetId].workflowArn` 优先;台账没有就按名字问服务本身(名字 = dagId)。
 * 🔴 拿不到就返回 undefined,由调用方给**人话**(绝不静默当成「没有运行记录」—— 那是本仓的量具铁律:
 *    「读不到」不许回落成「没有」)。
 */
/**
 * 🔴🔴 **一次发布 → 全部绑定区各一份产物**(用户 2026-09-15:「我不是让你在美东1 发布执行多个区域吗?」)。
 * 改动前这里是 `bindingTargets(...)[0]` —— 绑了两个区只发第一个,另一个区**根本没有产物**,
 * 于是它的定时永远不会跑、手动触发也找不到 workflow;而界面上两个区都亮着(客户痛点「怕漏 region」)。
 *
 * 形状与离线作业侧**一致**:逐 target 发布 + 每个 target 一条 `deployments[targetId]` 台账;
 * 🔴 逐 target 各自 try —— 第 2 个区失败不许把第 1 个区已经发好的产物「回滚」成没发过
 * (那会让用户以为整次发布没发生,而那个区的 cron 已经在跑了);失败逐区如实回报。
 */
export async function publishWorkflowDag(
  workflow: Workflow,
  opts: { ledger?: CarrierLedger } = {}
): Promise<PublishDagResult & {
  perTarget: Array<{ targetId: string; ok: boolean; scheduler?: string; artifact?: string; error?: string; code?: string }>;
}> {
  const targets = bindingTargets(workflow as unknown as { targets?: unknown; targetId?: unknown });
  const list = targets.length ? targets : ["tgt_home"];
  const perTarget: Array<{ targetId: string; ok: boolean; scheduler?: string; artifact?: string; error?: string; code?: string }> = [];
  // 🔴 原始拒因**必须留着**:聚合时要原样抛回去,
  //   `instanceof MwaaNotInstalled` / `instanceof ServerlessNodeUnsupported` 才判得出来。
  const causes: unknown[] = [];
  let first: PublishDagResult | undefined;
  // 🔴 **先把全部绑定区的落点一致性核一遍,再动第一个区**:同步节点的任务 / 作业节点的作业不绑其中任何一个区
  //   ⇒ 整个发布 400(抛 JobNodeUnbound,原样出去由单一作者映射),不许「第 1 个区发成、第 2 个区才发现」留下半份产物。
  for (const t of list) await assertWorkflowNodesRunOn(workflow, t);
  for (const t of list) {
    try {
      const r = await publishWorkflowDagToTarget(workflow, t, opts);
      if (!first) first = r;
      perTarget.push({ targetId: t, ok: true, scheduler: r.scheduler, artifact: r.dagId });
    } catch (e) {
      const err = e as { message?: string; code?: string };
      causes.push(e);
      perTarget.push({ targetId: t, ok: false, error: String(err?.message ?? e).slice(0, 400), ...(err?.code ? { code: err.code } : {}) });
    }
  }
  if (!first) {
    // 一个区都没发成功 ⇒ 走**单一作者**合成(把第一个带语义的拒因原样抛出去,逐区明细挂 `fanoutPerTarget`)。
    // 🔴 这里原来是 `new Error(聚合文本)` + 只拷 `code`:类型信息一丢,路由那两条 instanceof 全落空 ⇒
    //    「图里有 external 节点」「那个区没装调度器」双双被说成 500 平台故障(2026-09-16 段 slsw N-3 实测)。
    throw fanoutRejection(
      causes,
      perTarget,
      `全部执行范围都没发布成功:${perTarget.map((x) => `${x.targetId}: ${x.error}`).join(" | ")}`
    );
  }
  return { ...first, perTarget };
}

export async function serverlessWorkflowArnOf(
  workflow: { workflowId: string; airflowDagId?: string; deployments?: unknown },
  ep: { region: string; targetId: string }
): Promise<string | undefined> {
  const dagId = workflow.airflowDagId || `bgp_${workflow.workflowId}`;
  const known = (workflow.deployments as Record<string, { workflowArn?: string } | undefined> | undefined)?.[ep.targetId]?.workflowArn;
  return known || (await findWorkflowArnByName(ep.region, dagId));
}

/**
 * 「发布之后让它真的会被触发」= 解挂那个 DAG。**落点由本函数自己解析**,调用方不许再传端点。
 *
 * 🔴 为什么收成一个作者:`schedule/enable` 那条路原来写的是 `unpauseWhenLoaded(homeMwaaEndpoint(), …)`
 *   —— **恒打主控区**。工作流绑在别的区时:DAG 发到了那个区、cron 也写进去了,而解挂打在 home
 *   (那里根本没有这个 DAG)⇒ 页面显示「调度已开启」,而那个区的 DAG **一直是 paused、永远不触发**。
 *   这是当时留的「target 维度」的尾巴,接编排时漏了这一处
 *   (publish 路由那条是对的 —— 两个调用方一个对一个错,正是「同一件事有两处实现」的典型下场)。
 * serverless 没有 pause 概念(TriggerMode 决定要不要按 cron 收它)⇒ 如实 no-op。
 */
export async function ensureDagUnpaused(
  workflow: Pick<Workflow, "workflowId"> & { targets?: unknown; targetId?: unknown },
  dagId: string
): Promise<{ unpaused: boolean; scheduler: "mwaa" | "serverless"; perTarget: Array<{ targetId: string; unpaused: boolean; scheduler: string; error?: string }> }> {
  // 🔴 解挂必须**逐个绑定区**做:只解第一个区 ⇒ 第二个区的 DAG 一直是 paused ⇒ **它的 cron 永远不触发**,
  //    而页面上那个区显示「已发布」。这与「只发第一个区」是同一个洞的另一半。
  const list = bindingTargets(workflow);
  const targets = list.length ? list : ["tgt_home"];
  const perTarget: Array<{ targetId: string; unpaused: boolean; scheduler: string; error?: string }> = [];
  let anyUnpaused = false;
  let scheduler: "mwaa" | "serverless" = "serverless";
  for (const wfTarget of targets) {
    try {
      const ep = await schedulerEndpointFor(wfTarget);
      if (isServerlessEndpoint(ep)) {
        perTarget.push({ targetId: wfTarget, unpaused: false, scheduler: "serverless" });
        continue;
      }
      await unpauseWhenLoaded(ep, [dagId]);
      anyUnpaused = true;
      scheduler = "mwaa";
      perTarget.push({ targetId: wfTarget, unpaused: true, scheduler: "mwaa" });
    } catch (e) {
      perTarget.push({ targetId: wfTarget, unpaused: false, scheduler: "unknown", error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }
  return { unpaused: anyUnpaused, scheduler, perTarget };
}

// 🔴 **删工作流必须把 DAG 一起收走**(真环境段 `scq` A2-3 抓到:删掉工作流后,
// `dags/<dagId>.py` 还留在那个区的桶里 ⇒ MWAA 继续按 cron 跑一个**平台上已经看不到**的工作流,
// 还会往台账写行)。存量单区时代这个洞就在,多区域下更坏:孤儿 DAG 长在**别的区**,没人会去看。
// 🔴 桶必须经**同一个解析器**取(`schedulerEndpointFor`):用主控区的桶去删别区的文件是静默 no-op。
//
// 本函数升级成**「把一个工作流从它的调度器上撤下来」的唯一作者**:
//   · 经典 ⇒ `offlineDag(dagId, wfTarget)`:pause(立刻停触发)+ 删该区 DAG 文件;
//   · serverless ⇒ `offlineServerlessWorkflow`:Stop 在跑的 run → 等终态 → DeleteWorkflow + 删定义对象。
// 🔴 两个此前的洞一并补掉:
//   ① 原来 serverless 分支直接 `return { removed: false }`(那是「serverless 从来没被 publish 过」时代的假设)
//      现在它会 publish 了,不接就是**删不掉的孤儿 workflow 继续按 cron 跑**(已付过这个学费);
//   ② `unpublish/route.ts` 原来调 `offlineDag(dagId)` **不传 target** ⇒ 恒打主控区:
//      工作流绑在别的区时,pause 与删文件都作用在 home(静默 no-op),那个区的 DAG 照跑 ——
//      与 A2-3 同一个病、只是长在另一条路由上(当时留的缺省值本意是「存量逐字节不变」,
//      而把工作流变成 per-target 之后,这个缺省就成了洞)。
export interface UnpublishResult {
  removed: boolean;
  scheduler: "mwaa" | "serverless";
  targetId: string;
  dagId: string;
  /** 经典:pause 是否成功(尽力而为) */
  paused?: boolean;
  /** 产物是否真的没了(经典 = DAG 文件;serverless = 定义对象) */
  artifactDeleted?: boolean;
  /** serverless:workflow 本体是否已删 / 停掉了几个在跑的 run */
  workflowDeleted?: boolean;
  stoppedRuns?: number;
  /** 该 target 已经没有调度器可撤(不算错:没有东西可下线) */
  skipped?: string;
}

/**
 * 🔴🔴 扇出**必须把「有没有区撤不下来」透出来**。改动前这里逐区 try/catch 之后只回 `head`,
 * 两个调用方(`unpublish` 路由与 DELETE 路由)于是都**看不到**某个区失败 ——
 * 而它们的注释写的正好相反(「撤不下来就不许把记录改成 draft / 不许删记录,否则只剩一个谁也管不着的孤儿」,
 * 与段 `scq` A2-3 的学费)。把单区改成扇出时,那条不变量**靠的是异常会往上抛**,
 * 扇出把异常收进 `perTarget` 之后守卫就静默失效了 —— 与「扇出把类型化拒因抹平」是同一族接缝缺陷。
 */
export interface UnpublishFanoutResult extends UnpublishResult {
  perTarget: UnpublishResult[];
  /** 🔴 **每一个**该撤的区都真撤下来了。调用方动记录(改 draft / 删行)**之前必须看它**。 */
  allRemoved: boolean;
  /** 真撤不下来的区。🔴「该区没装调度组件」**不算**失败 —— 没有调度器就不可能有产物。 */
  failures: Array<{ targetId: string; error: string; code?: string }>;
}

export async function unpublishWorkflowDag(
  workflow: Pick<Workflow, "workflowId" | "airflowDagId"> & { targets?: unknown; targetId?: unknown; deployments?: unknown }
): Promise<UnpublishFanoutResult> {
  const dagId = workflow.airflowDagId || `bgp_${workflow.workflowId}`;
  // 🔴🔴 下线必须覆盖**每一个有产物的区**,不只是绑定里的第一个:
  //   · 只下线第一个区 ⇒ 另一个区的 workflow / DAG 文件**留着继续按 cron 跑**(孤儿产物,
  //     跨法域下就是数据出境);这与离线作业侧「解绑即下线」是同一条铁律。
  //   · 集合 = **绑定 ∪ 台账里有 deployments 的 target**(被解绑但产物还在的那些必须一起清 —— 
  //     那正是「解绑即下线」要处理的对象)。
  const bound = bindingTargets(workflow);
  const ledger = Object.keys(
    (workflow.deployments as Record<string, unknown> | undefined) ?? {}
  );
  const all = Array.from(new Set([...(bound.length ? bound : ["tgt_home"]), ...ledger]));
  const perTarget: UnpublishResult[] = [];
  const failures: Array<{ targetId: string; error: string; code?: string }> = [];
  for (const wfTarget of all) {
    try {
      perTarget.push(await unpublishWorkflowDagFromTarget(workflow, wfTarget, dagId));
    } catch (e) {
      // 🔴 「该区没装调度组件」**不是失败**:那里不可能有产物,没有东西可下线。
      //   `offlineDag` 早就是这个口径(它自己 catch 掉 MwaaNotInstalled 回 `skipped`);
      //   而落点解析排在它之前,于是同一件事在这里表现成抛错。两处口径必须一致 ——
      //   否则「那个区的调度组件被拆掉」会让这个工作流**永远下线不了、也永远删不掉**
      //   (「一个集合被当成两件事用 ⇒ 夹缝里的对象被永久堵死」那个坑的同族)。
      if (e instanceof MwaaNotInstalled) {
        perTarget.push({
          removed: false, scheduler: "serverless", targetId: wfTarget, dagId,
          skipped: "该执行环境没有调度组件(无可下线的产物)",
        });
        continue;
      }
      const err = e as { message?: string; code?: string };
      failures.push({
        targetId: wfTarget, error: String(err?.message ?? e).slice(0, 400),
        ...(err?.code ? { code: err.code } : {}),
      });
      perTarget.push({
        removed: false, scheduler: "serverless", targetId: wfTarget, dagId,
        skipped: `下线失败:${String(err?.message ?? e).slice(0, 200)}`,
      });
    }
  }
  const head = perTarget.find((x) => x.removed) ?? perTarget[0];
  return { ...head, perTarget, allRemoved: failures.length === 0, failures };
}

/** 从**一个** target 下线(原来的 `unpublishWorkflowDag` 就是这段)。 */
async function unpublishWorkflowDagFromTarget(
  workflow: Pick<Workflow, "workflowId" | "airflowDagId"> & { targets?: unknown; targetId?: unknown; deployments?: unknown },
  wfTarget: string,
  dagId: string
): Promise<UnpublishResult> {
  const ep = await schedulerEndpointFor(wfTarget);

  if (isServerlessEndpoint(ep)) {
    // ARN:台账优先,台账没有就问服务本身(名字 = dagId)—— 台账丢了也不许留孤儿。
    const known = (workflow.deployments as Record<string, { workflowArn?: string } | undefined> | undefined)?.[wfTarget]?.workflowArn;
    const workflowArn = known || (await findWorkflowArnByName(ep.region, dagId));
    const r = await offlineServerlessWorkflow({ ep, dagId, workflowArn });
    return {
      removed: true, scheduler: "serverless", targetId: wfTarget, dagId,
      artifactDeleted: r.dagFileDeleted, workflowDeleted: r.deleted, stoppedRuns: r.stoppedRuns,
      ...(workflowArn ? {} : { skipped: "服务侧没有同名 workflow(可能从未发布或已被删)" }),
    };
  }

  const r = await offlineDag(dagId, wfTarget);
  return {
    removed: !r.skipped, scheduler: "mwaa", targetId: wfTarget, dagId,
    paused: r.paused, artifactDeleted: r.dagFileDeleted,
    ...(r.skipped ? { skipped: r.skipped } : {}),
  };
}

