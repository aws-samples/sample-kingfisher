// 序 73 模块 57(57 DESIGN §3.2 / §3.5)—— 编排 DAG「离线作业节点」的**发布期解析**与「同步 / 作业节点落点一致性」的**唯一作者**。
//
// 【做什么】
//   · `resolveJobNodeSpec`:读作业行(ETL `bgp-etl-jobs` / EMR `bgp-engine-jobs`)→ 作业存在 · 项目一致 · `bindingTargets(job) ∋ 工作流落点`
//     → 调**已有**单作业 spec 构造器(`lib/etl/job-spec.ts` / `lib/engines/emr/job-spec.ts`)得到与单作业载体**同一份** spec。
//     不满足 ⇒ 抛 `JobNodeUnbound`(code JOB_NODE_UNBOUND,路由侧映射 400,点名节点与作业)。
//   · `assertWorkflowNodesRunOn`(R5 / B-141 ①):发布前遍历节点 —— sync ⇒ `assertDefinitionRunsHere(task, "同步任务", wfTarget)`;
//     job ⇒ 上面的三道判定。任一不合 ⇒ 抛(整个发布 400,不许先发一半 —— 调用方 `publishWorkflowDag` 先把全部绑定区核完再动第一个字节)。
//   · `withJobSpecs`:把解析结果挂进 `node.data.jobSpec`,两条生成路(serverless YAML / 经典 runtime-lib spec)都从 data 透传,
//     运行期 `_exec_job` 只读它。
// 【边界】本文件**只读**(DDB GetItem + 落点解析):EMR 作业在该区的就位(脚本上传 / jar 复制 / application 建立)是写操作,
//   在 `job-node-prepare.ts`(发布的写阶段)做;只读解析用确定性读法(`applicationIdOf` / `entryPointUri` / `s3TablesJarUriFor`)
//   拿到同一个值,所以 B-09 载体漂移比对(只读)也能重新生成同一份 spec。
// 🔴 不许有静默默认值:`jobRef.kind` 闭合(JOB_NODE_KINDS);落点 / 项目不一致一律拒,绝不「替它挑一个区」。
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { bindingTargets, resolveEmrBinding, resolveRedshiftBinding } from "@/lib/exec-env/data-plane-target";
import { assertDefinitionRunsHere, DefinitionBindingMismatch } from "@/lib/exec-env/definition-binding";
import { resolveRunStamp } from "@/lib/monitor/run-records";
import { serverlessJobSpecFor } from "@/lib/etl/job-spec";
import { emrJobSpecFor, emrRedshiftFactsFor, emrSparkSubmitParametersFor } from "@/lib/engines/emr/job-spec";
import { applicationIdOf } from "@/lib/engines/emr/application";
import { entryPointUri, s3TablesJarUriFor } from "@/lib/engines/emr/script";
import { S3TABLES_JAR, s3LogUri } from "@/lib/engines/emr/provider";
import { resolveExecutionRoleArn } from "@/lib/execution-role/resolve";
import type { ServerlessJobSpec } from "@/lib/scheduler/serverless/yaml-generator";
import type { EmrEngineJob } from "@/lib/engines/emr/types";
import type { EtlJob } from "@/types/etl-job";
import type { Workflow } from "@/types/workflow";
// 节点引用的读法(kind 闭合 + jobId 非空)是纯函数,放在浏览器也能 import 的 job-ref.ts;这里只转出,不另写一份
import { jobRefOf, type WorkflowNodeLike } from "./job-ref";
export { jobRefOf, type WorkflowNodeLike };

const USER_ID = "default-user";

export type JobNodeUnboundReason = "missing-ref" | "not-found" | "kind-mismatch" | "project-mismatch" | "not-bound" | "not-prepared";

/**
 * 发布期拒因:节点引用的作业 / 同步任务**不能在这个工作流的落点上跑**(或压根不存在 / 不属于本项目)。
 * 🔴 调用方映射 **400**(改图或改绑定),不是 409「补装」—— 补装什么都没用。`code` 是类上的字面量常量(fanout-reject 按 code 判,
 *    type-only import 不拖运行期依赖)。
 */
export class JobNodeUnbound extends Error {
  readonly code = "JOB_NODE_UNBOUND" as const;
  readonly nodeId: string;
  readonly nodeType: "job" | "sync";
  readonly reason: JobNodeUnboundReason;
  readonly ref: Record<string, unknown>;
  readonly targetId: string;
  constructor(args: { nodeId: string; nodeType: "job" | "sync"; reason: JobNodeUnboundReason; ref: Record<string, unknown>; targetId: string; message: string }) {
    super(args.message);
    this.name = "JobNodeUnbound";
    this.nodeId = args.nodeId;
    this.nodeType = args.nodeType;
    this.reason = args.reason;
    this.ref = args.ref;
    this.targetId = args.targetId;
  }
}

function nodeIdOf(node: WorkflowNodeLike): string {
  return String(node?.id ?? "");
}

function nodeLabelOf(node: WorkflowNodeLike): string {
  const lb = node?.data?.label;
  return typeof lb === "string" && lb.trim() ? lb : nodeIdOf(node);
}

export type LoadedJobNodeRow = { kind: "etl"; job: EtlJob } | { kind: "emr"; job: EmrEngineJob };

/**
 * 读节点引用的作业行并做三道判定:存在 · 项目一致 · 绑定含工作流落点。任一不合 ⇒ `JobNodeUnbound`。
 * 🔴 项目比对走 `resolveRunStamp(...).projectId`(存量无 projectId 的行归默认项目,与 run 盖章同一口径),不各写一份缺省。
 */
export async function loadJobNodeRow(node: WorkflowNodeLike, workflow: { projectId?: string | null }, wfTarget: string): Promise<LoadedJobNodeRow> {
  const nodeId = nodeIdOf(node);
  const label = nodeLabelOf(node);
  const ref = jobRefOf(node);
  if (!ref) {
    throw new JobNodeUnbound({
      nodeId, nodeType: "job", reason: "missing-ref", ref: { ...((node?.data?.jobRef as object) ?? {}) }, targetId: wfTarget,
      message: `离线作业节点「${label}」未关联离线作业,无法发布 —— 请在节点配置里选择一个离线计算作业或 EMR Serverless 作业`,
    });
  }
  const table = ref.kind === "etl" ? TABLES.ETL_JOBS : TABLES.ENGINE_JOBS;
  // 🔴 ConsistentRead:首次发布时 prepareJobNodesForTarget 刚 UpdateItem 过这一行(EMR persistApplicationId),紧接着再读要读到自己的写
  const { Item } = await docClient.send(new GetCommand({ TableName: table, Key: { userId: USER_ID, jobId: ref.jobId }, ConsistentRead: true }));
  if (!Item) {
    throw new JobNodeUnbound({
      nodeId, nodeType: "job", reason: "not-found", ref: { ...ref }, targetId: wfTarget,
      message: `离线作业节点「${label}」引用的${ref.kind === "etl" ? "离线计算作业" : "EMR Serverless 作业"} ${ref.jobId} 不存在(可能已被删除)—— 请在节点配置里重新选择作业`,
    });
  }
  if (ref.kind === "emr" && String((Item as { engine?: unknown }).engine ?? "") !== "emr-serverless") {
    throw new JobNodeUnbound({
      nodeId, nodeType: "job", reason: "kind-mismatch", ref: { ...ref }, targetId: wfTarget,
      message: `离线作业节点「${label}」引用的作业 ${ref.jobId} 不是 EMR Serverless 作业(engine=${String((Item as { engine?: unknown }).engine ?? "")})—— 请重新选择`,
    });
  }
  const jobName = String((Item as { name?: unknown }).name ?? ref.jobId);
  const jobProject = resolveRunStamp(Item as { projectId?: string }).projectId;
  const wfProject = resolveRunStamp(workflow).projectId;
  if (jobProject !== wfProject) {
    throw new JobNodeUnbound({
      nodeId, nodeType: "job", reason: "project-mismatch", ref: { ...ref }, targetId: wfTarget,
      message: `离线作业节点「${label}」引用的作业「${jobName}」属于项目 ${jobProject},而这个工作流属于项目 ${wfProject} —— 工作流只能引用本项目的作业`,
    });
  }
  const bound = bindingTargets(Item as { targets?: unknown; targetId?: unknown });
  if (!bound.includes(wfTarget)) {
    throw new JobNodeUnbound({
      nodeId, nodeType: "job", reason: "not-bound", ref: { ...ref, bound }, targetId: wfTarget,
      message:
        `离线作业节点「${label}」引用的作业「${jobName}」绑定在执行环境 ${bound.join(" / ")},而这个工作流要发布到 ${wfTarget} —— ` +
        `已拒绝发布(不会替它在别的区跑);请把该作业绑到 ${wfTarget},或换一个绑了 ${wfTarget} 的作业`,
    });
  }
  return ref.kind === "etl" ? { kind: "etl", job: Item as EtlJob } : { kind: "emr", job: Item as EmrEngineJob };
}

/** 一份产物共用的解析上下文(spec.dagId = 工作流自己的 dagId;execRegion = 该区调度端点所在区)。 */
export interface JobNodeSpecContext {
  dagId: string;
  execRegion: string;
}

/**
 * 解析一个离线作业节点在工作流落点上的运行 spec —— 与单作业载体**同一份**(同一个 spec 作者)。
 * 🔴 EMR 作业在该区还没有 application(从没在该区运行 / 发布过,且发布的写阶段还没就位)⇒ `not-prepared`:
 *    只读路径(B-09 比对)不替它建;发布路径在 `prepareJobNodesForTarget` 建好之后再来解析。
 */
export async function resolveJobNodeSpec(
  node: WorkflowNodeLike,
  wfTarget: string,
  projectId: string | null | undefined,
  ctx: JobNodeSpecContext
): Promise<ServerlessJobSpec> {
  const loaded = await loadJobNodeRow(node, { projectId }, wfTarget);
  if (loaded.kind === "etl") {
    const job = loaded.job;
    const binding =
      job.type === "redshift"
        ? await resolveRedshiftBinding({
            targetId: wfTarget,
            projectId: job.projectId,
            workgroupOverride: job.redshiftConfig?.workgroupName,
            databaseOverride: job.redshiftConfig?.database,
          })
        : undefined;
    return serverlessJobSpecFor(job, wfTarget, { dagId: ctx.dagId, endpointRegion: ctx.execRegion, binding });
  }
  const job = loaded.job;
  const landing = await resolveEmrBinding({ targetId: wfTarget });
  const { roleArn } = resolveExecutionRoleArn({
    custom: job.spec?.executionRoleArn,
    fallback: landing.executionRoleArn,
    missingMessage: `目标 ${wfTarget} 没有 EMR 执行角色(描述符缺 emrExecutionRoleArn)`,
  });
  const applicationId = applicationIdOf(job, wfTarget);
  if (!applicationId) {
    throw new JobNodeUnbound({
      nodeId: nodeIdOf(node), nodeType: "job", reason: "not-prepared", ref: { kind: "emr", jobId: job.jobId }, targetId: wfTarget,
      message: `离线作业节点「${nodeLabelOf(node)}」引用的 EMR 作业「${job.name}」在 ${wfTarget} 尚未建好 application —— 发布时会自动建好;比对定义请先发布一次`,
    });
  }
  const sparkSubmitParameters = emrSparkSubmitParametersFor(job, landing, s3TablesJarUriFor(landing, S3TABLES_JAR), await emrRedshiftFactsFor(wfTarget));
  return emrJobSpecFor(job, wfTarget, {
    dagId: ctx.dagId,
    region: landing.region,
    applicationId,
    executionRoleArn: roleArn,
    entryPoint: entryPointUri(job.jobId, landing),
    sparkSubmitParameters,
    logUri: s3LogUri(job.jobId, landing.datalakeBucket),
    runName: `${job.name}-wf`,
  });
}

/** 工作流里全部 `job` 节点的 spec(按节点 id);没有作业节点 ⇒ 空对象、零次读。 */
export async function resolveWorkflowJobSpecs(workflow: Workflow, wfTarget: string, ctx: JobNodeSpecContext): Promise<Record<string, ServerlessJobSpec>> {
  const out: Record<string, ServerlessJobSpec> = {};
  for (const n of (workflow.dagDefinition?.nodes ?? []) as WorkflowNodeLike[]) {
    if (n?.type !== "job") continue;
    out[nodeIdOf(n)] = await resolveJobNodeSpec(n, wfTarget, workflow.projectId, ctx);
  }
  return out;
}

/** 把解析结果挂进 `node.data.jobSpec`(只改作业节点;其余节点与边逐字节不动 ⇒ 存量工作流产物不变)。 */
export function withJobSpecs(workflow: Workflow, specs: Record<string, ServerlessJobSpec>): Workflow {
  if (Object.keys(specs).length === 0) return workflow;
  const nodes = (workflow.dagDefinition?.nodes ?? []).map((n: WorkflowNodeLike) => {
    if (n?.type !== "job") return n;
    const spec = specs[nodeIdOf(n)];
    if (!spec) throw new Error(`[job-node-spec] 作业节点 ${nodeIdOf(n)} 没有解析出 spec(解析与注入不是同一批节点?)`);
    return { ...n, data: { ...(n.data ?? {}), jobSpec: spec } };
  });
  return { ...workflow, dagDefinition: { ...(workflow.dagDefinition ?? { edges: [] }), nodes } };
}

/**
 * R5 / B-141 ①:**发布期落点一致性 fail-closed**。遍历节点:
 *   · sync ⇒ 任务存在 + `assertDefinitionRunsHere(task, "同步任务", wfTarget)`(不再等运行期 EntityNotFound);
 *   · job  ⇒ 作业存在 · 项目一致 · 绑定含 wfTarget(`loadJobNodeRow`)。
 * 任一不合 ⇒ 抛 `JobNodeUnbound`;只读、零副作用(调用方在任何写之前调它)。
 */
export async function assertWorkflowNodesRunOn(workflow: Workflow, wfTarget: string): Promise<void> {
  for (const n of (workflow.dagDefinition?.nodes ?? []) as WorkflowNodeLike[]) {
    if (n?.type === "job") {
      await loadJobNodeRow(n, workflow, wfTarget);
      continue;
    }
    if (n?.type !== "sync") continue;
    const nodeId = nodeIdOf(n);
    const label = nodeLabelOf(n);
    const taskId = String(n.data?.syncTaskId ?? "").trim();
    if (!taskId) continue; // 「未关联」由 node-registry 的 validate 在保存 / 发布前校验,这里只核落点
    const { Item: task } = await docClient.send(new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId }, ConsistentRead: true }));
    if (!task) {
      throw new JobNodeUnbound({
        nodeId, nodeType: "sync", reason: "not-found", ref: { syncTaskId: taskId }, targetId: wfTarget,
        message: `数据同步节点「${label}」关联的同步任务 ${taskId} 不存在(可能已被删除)—— 请在节点配置里重新选择同步任务`,
      });
    }
    try {
      assertDefinitionRunsHere(task, "同步任务", wfTarget);
    } catch (e) {
      if (!(e instanceof DefinitionBindingMismatch)) throw e;
      const name = String((task as { name?: unknown }).name ?? taskId);
      throw new JobNodeUnbound({
        nodeId, nodeType: "sync", reason: "not-bound", ref: { syncTaskId: taskId, bound: e.bound }, targetId: wfTarget,
        message:
          `数据同步节点「${label}」关联的同步任务「${name}」绑定在执行环境 ${e.bound.join(" / ")},而这个工作流要发布到 ${wfTarget} —— ` +
          `已拒绝发布(不会替它在别的区跑);请换一个绑了 ${wfTarget} 的同步任务,或把这个工作流绑到 ${e.bound.join(" / ")}`,
      });
    }
  }
}
