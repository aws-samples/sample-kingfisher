// @kf-batch 50-WP26-sync-schedule-carrier
// 🔴🔴 **同步任务的「定时调度」载体**(WP-26;用户 2026-09-20:「我们后面所有的调度都走 mwaa serverless」)。
//
// 【改动前是个空壳 —— 而页面还替它宣称在跑】
//   `POST /api/schedule/enable` 的 sync 分支只往 `bgp-sync-tasks` 写 `scheduleEnabled` / `cronExpression`
//   两个字段,**不建任何调度产物**:`airflowDagId` 空、两个 region 的 EventBridge Scheduler 各 0 条、
//   MWAA Serverless 里没有 sync 的 DAG。实测配 `*/10 * * * *` + 启用,**等了 25 分钟一次都没跑**;
//   而页面当时写着「调度已启用 (EventBridge Scheduler)」+「自动调度」绿标 —— 比没有这个功能更糟
//   (ROADMAP §2octies.79 缺陷 ⑤;诚实那一半已于 2026-09-19 修掉,本文件交付的是**载体本身**)。
//
// 【载体不新造:复用编排那一整套】
//   编排早就有:`publishWorkflowDag` 按 `targets` **逐区扇出**、`NODE_REGISTRY` 里本来就有 `sync` 节点、
//   运行期 `_exec_sync` 会起该任务的 Glue 作业并轮询到终态、`__start`/`__finish` 负责 run 台账收口、
//   日志落 `/aws/mwaa-serverless/<workflow>/` 且任务监控点得开(段 `sls` S-11 真验过)。
//   ⇒ 「同步任务的定时调度」= **发一个单节点工作流**,节点就是那个 sync 节点。
//   这样「所有调度都走 MWAA Serverless」是**结构上**成立的,不是又长出一条平行机制。
//
// 【唯一需要拆开的概念:载体 ≠ 记在谁头上】
//   那套机制的两处台账都隐含假定「载体就是工作流」⇒ 直接复用会往 `bgp-workflows` upsert 出**幽灵行**。
//   所以台账归属做成显式参数(`CarrierLedger`):发布记录落到同步任务自己那一行、run 台账 `taskType="sync"`、
//   **不回写** workflow 行。缺省值等于改动前 ⇒ 编排那条路零回归。
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { publishWorkflowDag } from "@/lib/workflow/publish-dag";
import { unpublishWorkflowDag } from "@/lib/workflow/publish-dag";
import { syncTaskCarrierLedger } from "@/lib/scheduler/carrier-ledger";
import type { Workflow } from "@/types/workflow";

const USER_ID = "default-user";

/** 同步任务行里与调度载体相关的那几个字段。 */
export interface SyncTaskForCarrier {
  taskId: string;
  name?: string;
  projectId?: string;
  targets?: unknown;
  targetId?: unknown;
  cronExpression?: string | null;
  glueJobName?: string | null;
  deployments?: Record<string, { workflowArn?: string } | undefined>;
}

/**
 * DAG id:与编排的 `bgp_<workflowId>` 同一命名空间但带 `sync_` 段,
 * 一眼能看出这是**同步任务的调度载体**而不是用户建的工作流。
 */
export function syncCarrierDagId(taskId: string): string {
  return `bgp_sync_${taskId}`;
}

/**
 * 把同步任务编译成「单节点工作流」形状。**纯函数**(不碰 DDB / AWS)——
 * 判据可以直接断它的形状,不必起真环境。
 */
export function buildSyncCarrierWorkflow(task: SyncTaskForCarrier, cron: string | null): Workflow {
  const now = new Date().toISOString();
  return {
    userId: USER_ID,
    // 🔴 刻意用同步任务自己的 id:产物名、ARN、台账归属三处一眼可追溯到同一个对象。
    //   它**不会**在 `bgp-workflows` 里建行(台账归属见下面的 ledger)。
    workflowId: task.taskId,
    name: `${task.name || task.taskId}(定时同步)`,
    description: "同步任务的定时调度载体(WP-26):单节点 sync 工作流,由平台按 cron 触发",
    projectId: task.projectId,
    dagDefinition: {
      nodes: [{ id: "sync", type: "sync", data: { syncTaskId: task.taskId, name: task.name || task.taskId } }],
      edges: [],
    },
    airflowDagId: syncCarrierDagId(task.taskId),
    cronExpression: cron || undefined,
    scheduleEnabled: Boolean(cron),
    status: "active",
    createdAt: now,
    updatedAt: now,
    // 逐区扇出按 `targets` 走(同步任务行用的就是这个字段名)
    ...(task.targets ? ({ targets: task.targets } as unknown as Record<string, never>) : {}),
    ...(task.targetId ? ({ targetId: task.targetId } as unknown as Record<string, never>) : {}),
    ...(task.deployments ? ({ deployments: task.deployments } as unknown as Record<string, never>) : {}),
  } as unknown as Workflow;
}

// @kf-batch 50-B09-carrier-drift
// 🔴 **「同步任务的定时载体是不是落后了」只有这一个作者。**
//   同步载体不是用户建的工作流,它由 `buildSyncCarrierWorkflow` 现编译出来,而且**带 ledger**
//   (归属写回 `bgp-sync-tasks` 而不是 `bgp-workflows`)—— ledger 是比对的**隐藏输入**:
//   少传它,重新生成出来的定义里 `ledger_task_*` 会退回缺省值 ⇒ **每一个同步载体都误报落后**。
//   ⇒ 谁要查同步载体的 drift,都必须走这里,不许自己拼 workflow + ledger。
//   (这正是 B-01 的现场:那三个 `ledger_*` 字段**在定义里**,但值是缺省的。)
export async function syncCarrierDrift(task: SyncTaskForCarrier, targetId: string) {
  const { carrierDefinitionDrift } = await import("@/lib/workflow/publish-dag");
  const wf = buildSyncCarrierWorkflow(task, task.cronExpression ?? null);
  return carrierDefinitionDrift(wf, targetId, {
    ledger: syncTaskCarrierLedger(task.taskId, TABLES.SYNC_TASKS),
  });
}

/** 载体成立的前置条件(不满足就**响亮拒**,绝不发一个注定跑不起来的 DAG)。 */
export function carrierPrereqReason(task: SyncTaskForCarrier): string | null {
  if (!task.glueJobName) {
    // `_exec_sync` 就是起这个 Glue 作业。作业还没建出来(任务从未手动跑过一次)⇒ 到点会失败,
    // 而失败信息离根因很远(「Sync task has no Glue job」)。⇒ 提前说清出路。
    return (
      "这个同步任务还没有后台作业(glueJobName 为空)—— 定时调度到点会无事可做。" +
      "请先在页面上**手动运行一次**(平台会在那一次建出该任务的 Glue 作业),再启用定时。"
    );
  }
  return null;
}

/**
 * 发布载体:按同步任务的 `targets` **逐区**各发一份单节点工作流,cron 写进定义。
 * 失败语义沿用编排那条路(任一区失败就抛,拒因带逐区明细)。
 */
export async function publishSyncScheduleCarrier(
  task: SyncTaskForCarrier,
  cron: string
): Promise<{ perTarget: Array<{ targetId: string; ok: boolean; artifact?: string; error?: string }>; dagId: string }> {
  const wf = buildSyncCarrierWorkflow(task, cron);
  // @kf-batch 50-B09-secret-single-author —— 🔴 原来在这里按 `task.projectId` 取一遍 admin secret 再传下去,
  //   而 `wf.projectId` **就是** `task.projectId`,发布函数内部的 `resolveRedshiftBinding` 在 home 分支
  //   **算的就是同一个值** ⇒ 两个作者。已收成一个:本处不再取、不再传。
  const r = await publishWorkflowDag(wf, {
    ledger: syncTaskCarrierLedger(task.taskId, TABLES.SYNC_TASKS),
  });
  return { perTarget: r.perTarget, dagId: syncCarrierDagId(task.taskId) };
}

/**
 * 停用:把**每一个有产物的区**的 workflow 真删掉 —— 直接复用编排的 `unpublishWorkflowDag`
 * (它的集合口径 = 绑定 ∪ 台账里有 deployments 的 target;「该区没装调度组件」不算失败)。
 * 🔴 调用方在改记录(`scheduleEnabled=false`)之前**必须看 `allRemoved`** ——
 *   撤不下来就不许动记录,否则孤儿 workflow 会继续按 cron 跑而平台已认为它下线了(WP-18d 那条铁律)。
 */
export async function offlineSyncScheduleCarrier(task: SyncTaskForCarrier) {
  const wf = buildSyncCarrierWorkflow(task, null);
  return unpublishWorkflowDag(wf as unknown as Parameters<typeof unpublishWorkflowDag>[0]);
}

/** 取同步任务行(载体发布/下线都要先拿到 targets 与 glueJobName)。 */
export async function getSyncTaskForCarrier(taskId: string): Promise<SyncTaskForCarrier | undefined> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.SYNC_TASKS, Key: { userId: USER_ID, taskId } })
  );
  return Item as SyncTaskForCarrier | undefined;
}
