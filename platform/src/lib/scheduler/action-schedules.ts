// 🔴🔴 **平台动作的调度对象**(治理定时任务 / 问数卡片定时刷新)—— 行形状 + 读写 + 载体(发布 / 下线 / 落后检测)。
//
// 【载体不新造:照抄】同步任务的定时调度已经证明了这条路:合成一个**单节点工作流**,
//   由 `publishWorkflowDag` 按 `targets` **逐区**发到该区的 MWAA Serverless(用户拍板:每区自治调度,
//   绝不回落主控区);运行台账靠 `__start` / `__finish` 收口;下线复用 `unpublishWorkflowDag`。
//   唯一的差别是节点类型:这里是 `platform-action`(往主控区命令表投命令 + 轮询终态,见 node-exec-py.ts)。
//
// 【台账归属 = CarrierLedger】发布记录 `deployments[targetId]` 落在本表自己那一行;
//   run 台账 `taskType` = 种类(`governance` / `genbi-card`),**不回写** `bgp-workflows`(那里没有它的行)。
//
// 【先办载体再改记录】启用:发布失败**不许**写 enabled(那就是空壳);停用:撤不下来**不许**改记录
//   (铁律:孤儿 workflow 会继续按 cron 跑,而平台已认为它下线了)。两条都在 `setActionScheduleEnabled` 一处。
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { publishWorkflowDag, unpublishWorkflowDag } from "@/lib/workflow/publish-dag";
import { actionScheduleCarrierLedger, type ActionScheduleTaskType } from "@/lib/scheduler/carrier-ledger";
import { isDispatchableAction, validateActionParams } from "@/lib/scheduler/action-commands";
import { isValidTargetId } from "@/lib/exec-env/target-id";
import type { Workflow } from "@/types/workflow";

const USER_ID = "default-user";

/** 调度对象行(**只存非数据值**:动作 id、参数、归属、cron、发布台账)。 */
export interface ActionScheduleRow {
  userId: typeof USER_ID;
  taskId: string;
  kind: ActionScheduleTaskType;
  name: string;
  projectId: string;
  /** 绑定的执行范围(本期恒一个:治理任务 = 建它时的视角;卡片 = 卡片自己的区)。 */
  targets: string[];
  action: string;
  params: Record<string, unknown>;
  cronExpression: string | null;
  scheduleEnabled: boolean;
  deployments?: Record<string, { workflowArn?: string; status?: string; publishedAt?: number } | undefined>;
  ownerSub: string;
  ownerUsername: string;
  createdAt: string;
  updatedAt: string;
}

/** 输入非法(参数 / 落点 / cron)。路由转 400。 */
export class ActionScheduleInvalid extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "ActionScheduleInvalid";
  }
}

/** 有执行范围的产物没撤下来 ⇒ 记录不动。路由转 502(与同步任务那条同一口径)。 */
export class ActionScheduleOfflineIncomplete extends Error {
  constructor(readonly failures: Array<{ targetId: string; error: string }>) {
    super(
      "有执行范围的调度产物没撤下来,记录不动(撤不下来就不许说已停用):" +
        failures.map((f) => `${f.targetId}: ${f.error}`).join(" | ")
    );
    this.name = "ActionScheduleOfflineIncomplete";
  }
}

/** DAG id:与编排同一命名空间、带 `act_` 段 —— 一眼看出这是平台动作的调度载体。 */
export function actionCarrierDagId(taskId: string): string {
  return `bgp_act_${taskId}`;
}

/** 行级不变量(建行与启用前都过它)。纯函数。 */
export function actionScheduleInvalidReason(row: Pick<ActionScheduleRow, "taskId" | "action" | "params" | "targets" | "projectId">): string | null {
  if (!/^[A-Za-z0-9_]{1,120}$/.test(row.taskId || "")) return `taskId 形态非法:${JSON.stringify(row.taskId)}`;
  if (!isDispatchableAction(row.action)) return `动作 ${JSON.stringify(row.action)} 不在可下发白名单里`;
  const pv = validateActionParams(row.action, row.params);
  if (pv) return pv;
  if (!Array.isArray(row.targets) || row.targets.length !== 1 || !isValidTargetId(row.targets[0])) {
    // 🔴 本期每个调度对象**恰好一个**执行范围:治理任务的「在哪个区跑」= 建它时的视角(每区自治);
    //    多区一起跑就各建一个 —— 不做「一个任务扇到 N 个区」,免得一个区的失败把另一个区的结果拖成部分成功。
    return "调度对象必须恰好绑定一个合法执行范围(targets)";
  }
  if (!row.projectId) return "缺 projectId";
  return null;
}

/** 把调度对象编译成「单节点工作流」形状。**纯函数**(判据直接断形状)。 */
export function buildActionCarrierWorkflow(row: ActionScheduleRow, cron: string | null): Workflow {
  const now = new Date().toISOString();
  return {
    userId: USER_ID,
    workflowId: row.taskId,
    name: `${row.name}(定时平台动作)`,
    description: "平台动作的定时调度载体:单节点 platform-action 工作流,由该区的 MWAA Serverless 按 cron 触发",
    projectId: row.projectId,
    dagDefinition: {
      nodes: [{ id: "action", type: "platform-action", data: { action: row.action, params: row.params, name: row.name } }],
      edges: [],
    },
    airflowDagId: actionCarrierDagId(row.taskId),
    cronExpression: cron || undefined,
    scheduleEnabled: Boolean(cron),
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...({ targets: row.targets } as unknown as Record<string, never>),
    ...(row.deployments ? ({ deployments: row.deployments } as unknown as Record<string, never>) : {}),
  } as unknown as Workflow;
}

export function ledgerOf(row: Pick<ActionScheduleRow, "taskId" | "kind">) {
  return actionScheduleCarrierLedger(row.taskId, TABLES.ACTION_SCHEDULES, row.kind);
}

// ─── 读写 ────────────────────────────────────────────────────────────────────

export async function getActionSchedule(taskId: string): Promise<ActionScheduleRow | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.ACTION_SCHEDULES, Key: { userId: USER_ID, taskId }, ConsistentRead: true })
  );
  return (Item as ActionScheduleRow | undefined) ?? null;
}

/** 某一种调度对象的全部行(低量配置数据:单分区 Query + 翻页,内存里再按项目 / 范围过滤)。 */
export async function listActionSchedules(kind: ActionScheduleTaskType): Promise<ActionScheduleRow[]> {
  const out: ActionScheduleRow[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < 50; page++) {
    const r = await docClient.send(
      new QueryCommand({
        TableName: TABLES.ACTION_SCHEDULES,
        KeyConditionExpression: "userId = :u",
        FilterExpression: "kind = :k",
        ExpressionAttributeValues: { ":u": USER_ID, ":k": kind },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      })
    );
    out.push(...((r.Items ?? []) as ActionScheduleRow[]));
    startKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!startKey) break;
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/**
 * 某一种调度对象里**归属该项目**的行(删项目前置校验用)。
 *
 * 🔴 与 `listActionSchedules` 的两点区别(都是删除守卫要、列表页不要的):
 *   · **精确归属**:分区键是恒定的 `default-user`(不是用户、更不是项目)⇒ 归属只在 `projectId` 属性上;
 *     只收 `projectId === 本项目` 的行,别的项目的、缺 projectId 的一律不算。
 *   · **翻不完就抛**:`listActionSchedules` 翻 50 页后**静默截断**(列表页可以接受);计数接受不了 ——
 *     截断 = 偏小 = fail-open 放行删除。抛出去由调用方变成 `count:null` ⇒ 阻断。
 * 🔴 删除守卫要的是「拥有什么」—— 治理定时 / 定时造数在**到点照样触发**(MWAA Serverless 上的载体还在),
 *    项目删了它们就成了「谁都看不见、还在真跑」的孤儿。
 */
export async function listActionSchedulesOwnedByProject(
  kind: ActionScheduleTaskType,
  projectId: string,
  maxPages = 50
): Promise<ActionScheduleRow[]> {
  const out: ActionScheduleRow[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < maxPages; page++) {
    const r = await docClient.send(
      new QueryCommand({
        TableName: TABLES.ACTION_SCHEDULES,
        KeyConditionExpression: "userId = :u",
        FilterExpression: "kind = :k AND projectId = :p",
        ExpressionAttributeValues: { ":u": USER_ID, ":k": kind, ":p": projectId },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      })
    );
    for (const it of (r.Items ?? []) as ActionScheduleRow[]) {
      // 第二道:过滤表达式之外再按值核一遍(mock / 脏数据都不许把别的项目的行带进来)
      if (it.kind === kind && it.projectId === projectId) out.push(it);
    }
    startKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!startKey) return out;
  }
  throw new Error(`listActionSchedulesOwnedByProject(${kind}, ${projectId}):翻页超过 ${maxPages} 页仍未到尾 ⇒ 数不清,拒绝回一个可能偏小的数`);
}

/** 建行(**未启用**、无产物)。🔴 条件写:同 taskId 已存在 ⇒ 拒(不许静默覆盖别人的任务)。 */
export async function createActionSchedule(
  input: Omit<ActionScheduleRow, "userId" | "createdAt" | "updatedAt" | "scheduleEnabled" | "deployments">
): Promise<ActionScheduleRow> {
  const why = actionScheduleInvalidReason(input);
  if (why) throw new ActionScheduleInvalid(why);
  const now = new Date().toISOString();
  const row: ActionScheduleRow = { ...input, userId: USER_ID, scheduleEnabled: false, createdAt: now, updatedAt: now };
  await docClient.send(
    new PutCommand({ TableName: TABLES.ACTION_SCHEDULES, Item: row, ConditionExpression: "attribute_not_exists(taskId)" })
  );
  return row;
}

/**
 * 启停的**唯一作者**。
 * 🔴 启用:先发布载体(逐区),发布失败抛错、**记录不动**;成功才写 `scheduleEnabled=true + cron`。
 * 🔴 停用:先把每个有产物的区真撤下来,`allRemoved=false` ⇒ 抛 `ActionScheduleOfflineIncomplete`,**记录不动**。
 */
export async function setActionScheduleEnabled(
  row: ActionScheduleRow,
  opts: { enabled: boolean; cron?: string | null }
): Promise<{ enabled: boolean; cronExpression: string | null; dagId: string; perTarget?: unknown }> {
  const dagId = actionCarrierDagId(row.taskId);
  if (opts.enabled) {
    const cron = String(opts.cron || "").trim();
    if (!cron) throw new ActionScheduleInvalid("启用定时必须给 cronExpression");
    const why = actionScheduleInvalidReason(row);
    if (why) throw new ActionScheduleInvalid(why);
    const pub = await publishWorkflowDag(buildActionCarrierWorkflow(row, cron), { ledger: ledgerOf(row) });
    await updateScheduleFlags(row.taskId, true, cron);
    return { enabled: true, cronExpression: cron, dagId, perTarget: pub.perTarget };
  }
  const off = await offlineActionScheduleCarrier(row);
  if (!off.allRemoved) throw new ActionScheduleOfflineIncomplete(off.failures);
  await updateScheduleFlags(row.taskId, false, row.cronExpression ?? null);
  return { enabled: false, cronExpression: row.cronExpression ?? null, dagId };
}

/** 撤载体(删除对象 / 停用都走它)。集合口径 = 绑定 ∪ 台账里有产物的区(`unpublishWorkflowDag` 自己算)。 */
export async function offlineActionScheduleCarrier(row: ActionScheduleRow) {
  const wf = buildActionCarrierWorkflow(row, null);
  return unpublishWorkflowDag(wf as unknown as Parameters<typeof unpublishWorkflowDag>[0]);
}

/** 「这个调度对象的载体是不是落后了」—— 必须带 ledger(否则 `ledger_task_*` 回缺省 ⇒ 每个都误报落后)。 */
export async function actionCarrierDrift(row: ActionScheduleRow, targetId: string) {
  const { carrierDefinitionDrift } = await import("@/lib/workflow/publish-dag");
  return carrierDefinitionDrift(buildActionCarrierWorkflow(row, row.cronExpression ?? null), targetId, { ledger: ledgerOf(row) });
}

/**
 * 删除调度对象:**先撤载体**(撤不下来 ⇒ 抛,行不删),再删行。
 * 🔴 顺序反了 = 平台上看不到这个任务,而那个区的 workflow 还在按 cron 跑(而且往命令表里投命令)。
 */
export async function deleteActionSchedule(row: ActionScheduleRow): Promise<void> {
  const off = await offlineActionScheduleCarrier(row);
  if (!off.allRemoved) throw new ActionScheduleOfflineIncomplete(off.failures);
  await docClient.send(
    new DeleteCommand({ TableName: TABLES.ACTION_SCHEDULES, Key: { userId: USER_ID, taskId: row.taskId } })
  );
}

/** 改参数 / cron 草稿(只许在**未启用**时改:启用中改参数 = 已发布的载体与记录分叉)。 */
export async function updateActionScheduleDraft(
  row: ActionScheduleRow,
  patch: { name?: string; params?: Record<string, unknown>; cronExpression?: string | null }
): Promise<ActionScheduleRow> {
  if (row.scheduleEnabled) throw new ActionScheduleInvalid("定时启用中不能改参数 —— 先停用(撤掉载体)再改,改完重新启用");
  const next: ActionScheduleRow = {
    ...row,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.params !== undefined ? { params: patch.params } : {}),
    ...(patch.cronExpression !== undefined ? { cronExpression: patch.cronExpression } : {}),
    updatedAt: new Date().toISOString(),
  };
  const why = actionScheduleInvalidReason(next);
  if (why) throw new ActionScheduleInvalid(why);
  await docClient.send(
    new PutCommand({
      TableName: TABLES.ACTION_SCHEDULES,
      Item: next,
      // 🔴 条件写:行必须还在、且仍未启用(并发启用的窗口兜底)
      ConditionExpression: "attribute_exists(taskId) AND scheduleEnabled = :f",
      ExpressionAttributeValues: { ":f": false },
    })
  );
  return next;
}

async function updateScheduleFlags(taskId: string, enabled: boolean, cron: string | null): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.ACTION_SCHEDULES,
      Key: { userId: USER_ID, taskId },
      UpdateExpression: "SET scheduleEnabled = :e, cronExpression = :c, updatedAt = :now",
      // 🔴 修盲 Update:行不存在 ⇒ 拒(DDB 的 UpdateItem 默认 upsert,会凭空造出幽灵调度对象)
      ConditionExpression: "attribute_exists(taskId)",
      ExpressionAttributeValues: { ":e": enabled, ":c": cron, ":now": new Date().toISOString() },
    })
  );
}

/** 「这一行真有载体在跑吗」—— 看**产物**(deployments 里有 workflowArn),不看 `scheduleEnabled` 这个愿望字段。 */
export function isCarrierArmed(row: Pick<ActionScheduleRow, "scheduleEnabled" | "cronExpression" | "deployments">): boolean {
  if (!row.scheduleEnabled || !row.cronExpression) return false;
  return Object.values(row.deployments || {}).some((d) => Boolean(d?.workflowArn));
}
