// 🔴🔴 **「调度载体」与「这次运行记在谁头上」必须分开声明。**
//
// 【为什么需要这个概念(立包时勘定出来的)】
//   同步任务的「启用调度 + cron」原来是个**空壳**:只往 `bgp-sync-tasks` 写两个字段,
//   不建任何调度产物(两个区的 EventBridge Scheduler 各 0 条、MWAA Serverless 里没有 sync 的 DAG),
//   实测配 `*/10` 等 25 分钟零次触发 —— 而页面当时还替它宣称「已启用 (EventBridge Scheduler)」。
//   载体本身**不用新造**:编排那条路已经有一整套(`publishWorkflowDag` 按 target 扇出 + `NODE_REGISTRY`
//   里本来就有 `sync` 节点 + 运行期 `_exec_sync`),同步任务的定时调度 = **发一个单节点工作流**。
//
// 【坑在哪 —— 不拆这个概念就会造幽灵行】
//   那套机制的两处台账都**隐含地假定「载体 == 工作流」**:
//     ① 发布台账:`deployments[targetId]` 写进 `bgp-workflows`,键是 `workflowId`;
//     ② 运行台账:DAG 运行期按 `env["workflow_id"]` 写 `bgp-task-runs`(`taskType: "workflow"`),
//        并且还会 `update_item` 回写 `bgp-workflows.lastRunStatus`。
//   给同步任务合成一个工作流去复用它 ⇒ 这两处都会往 `bgp-workflows` **upsert 出一条根本不存在的行**
//   —— 正是 `POST /api/schedule/enable` 里已经修过的那类「盲 Update 造幽灵任务」缺陷(52 SPEC §2 缺口B)。
//
// ⇒ 把「记在谁头上」从「载体是谁」里**显式拆出来**:
//   载体(DAG / workflow 产物)复用一套;台账归属由调用方声明。缺省值逐字节等于改动前的行为,
//   所以编排那条路**零回归**;同步任务这条路给一份自己的归属(写 `bgp-sync-tasks`、`taskType: "sync"`、
//   不回写 workflow 行)。
//
// 🔴 这是本轮反复出现的那个元模式的又一次应用:**一个集合被当成两件事用**就会在夹缝里出事
//   (见记忆 one-set-two-meanings-deadlock)。这里「workflowId」原来同时是「载体标识」与「台账归属」。

/** 调度载体的台账归属(发布记录 + 运行记录 + 是否回写 workflow 行)。 */
export interface CarrierLedger {
  /** 发布记录 `deployments[targetId]` 写哪张表。 */
  table: string;
  /** 那张表里这一行的主键。 */
  key: Record<string, unknown>;
  /** run 台账的 `taskType`(监控页按它分类、按它取日志)。 */
  taskType: string;
  /** run 台账的 `taskId`。 */
  taskId: string;
  /**
   * 运行期是否回写 `bgp-workflows.lastRunStatus`。
   * 🔴 合成载体**必须 false**:那张表里没有它的行,盲写会 upsert 出一条幽灵工作流。
   */
  writesWorkflowRow: boolean;
}

/** 编排工作流自己的归属 —— **缺省值**,逐字节等于此前的行为。 */
export function workflowCarrierLedger(workflowId: string, table: string): CarrierLedger {
  return {
    table,
    key: { userId: "default-user", workflowId },
    taskType: "workflow",
    taskId: workflowId,
    writesWorkflowRow: true,
  };
}

/** 同步任务的定时调度载体的归属:台账落在同步任务自己那一行,运行记录归 `sync`。 */
export function syncTaskCarrierLedger(taskId: string, table: string): CarrierLedger {
  return {
    table,
    key: { userId: "default-user", taskId },
    taskType: "sync",
    taskId,
    // 🔴 见上:同步任务在 `bgp-workflows` 里没有行,回写会造幽灵工作流
    writesWorkflowRow: false,
  };
}

/** 平台动作调度对象的 run 台账 `taskType`(监控页按它分类;闭合词表,页面与服务端同源)。 */
// + `seed`(在该区下发一次造数;手动那次也记 `seed`,监控页同一种类)
export const ACTION_SCHEDULE_TASK_TYPES = ["governance", "genbi-card", "seed"] as const;
export type ActionScheduleTaskType = (typeof ACTION_SCHEDULE_TASK_TYPES)[number];

/**
 * 平台动作调度对象(治理定时任务 / 问数卡片定时刷新)的归属:发布台账落在 `bgp-action-schedules` 自己那一行,
 * run 台账 `taskType` 按种类记,**不回写** workflow 行(那张表里没有它)。
 */
export function actionScheduleCarrierLedger(taskId: string, table: string, taskType: ActionScheduleTaskType): CarrierLedger {
  return {
    table,
    key: { userId: "default-user", taskId },
    taskType,
    taskId,
    writesWorkflowRow: false,
  };
}
