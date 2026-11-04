// @kf-batch 50-WP28-platform-action-node
// 🔴🔴 **平台动作命令的消费端(状态机的唯一作者)**:读命令 → 校验 → 抢单(pending → running)→ 执行 → 写终态。
//
// 【谁调它】主控区的分发 Lambda(DDB Streams 触发)→ 平台内部端点 `POST /api/internal/actions/run` → 本模块。
//   内部端点只把 `commandId` 交进来 —— **动作 id 与参数一律从命令行自己读**(那一行是 IAM 授权的执行区角色写的),
//   HTTP 请求里带不进任何别的东西 ⇒ 即使内部密钥泄露,能做的也只是「把表里已有的白名单命令再跑一次」。
//
// 【状态机】pending →(条件写抢单)→ running →(条件写)→ succeeded | failed。
//   🔴 每一步都是**条件写**:两个消费者同时到(Streams 至少一次投递 ⇒ 重复是常态)只有一个抢得到;
//      终态只能从 running 写 ⇒ 不会把别人的结果盖掉。
//   🔴 **不许停在半路**:执行体抛错 ⇒ failed + 真因;非法命令(白名单外 / 参数不对 / 缺项目)⇒ 直接 failed,
//      不留 pending 让 DAG 白等到超时。DAG 那头轮询到 failed 就 raise,task 失败,监控页看得见。
//
// 【执行体注入】`handlers` 由调用方传入(内部端点传 `ACTION_HANDLERS`)—— 本模块只管状态机,
//   不 import 任何业务库;判据用真的状态机 + 假执行体,不必 mock 兄弟模块。
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { parseActionCommand, validateActionParams, type ActionCommand } from "@/lib/scheduler/action-commands";

/** 一条已通过校验、可执行的命令(projectId 必有)。 */
export type ExecutableCommand = ActionCommand & { projectId: string; params: Record<string, unknown> };

/** 执行体:成功回非数据摘要;失败**抛**(抛出的 message 就是写进命令行与台账的真因)。 */
export type ActionHandler = (cmd: ExecutableCommand) => Promise<Record<string, unknown>>;
export type ActionHandlers = Readonly<Record<string, ActionHandler>>;

export type DispatchOutcome =
  | { kind: "accepted"; command: ExecutableCommand; execution: Promise<void> }
  | { kind: "missing" }
  | { kind: "not-pending"; status: string }
  | { kind: "rejected"; reason: string; action?: string };

const ERR_MAX = 1000;

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return (m || "未给出原因").slice(0, ERR_MAX);
}

async function getCommandRow(commandId: string): Promise<Record<string, unknown> | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: TABLES.ACTION_COMMANDS, Key: { commandId }, ConsistentRead: true })
  );
  return (Item as Record<string, unknown> | undefined) ?? null;
}

function isConditionalFail(e: unknown): boolean {
  return (e as { name?: string })?.name === "ConditionalCheckFailedException";
}

/** pending → failed(拒绝非法命令时用):只在仍是 pending 时写,不覆盖任何人的结果。 */
async function rejectPending(commandId: string, reason: string): Promise<void> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.ACTION_COMMANDS,
        Key: { commandId },
        UpdateExpression: "SET #s = :failed, finishedAt = :t, #e = :err",
        ConditionExpression: "#s = :pending",
        ExpressionAttributeNames: { "#s": "status", "#e": "error" },
        ExpressionAttributeValues: { ":failed": "failed", ":pending": "pending", ":t": new Date().toISOString(), ":err": reason.slice(0, ERR_MAX) },
      })
    );
  } catch (e) {
    if (!isConditionalFail(e)) throw e;
  }
}

/** 抢单:pending → running(条件写)。抢到 true;别人已抢 / 已终态 ⇒ false。 */
export async function claimCommand(commandId: string): Promise<boolean> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.ACTION_COMMANDS,
        Key: { commandId },
        UpdateExpression: "SET #s = :running, startedAt = :t",
        ConditionExpression: "#s = :pending",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":running": "running", ":pending": "pending", ":t": new Date().toISOString() },
      })
    );
    return true;
  } catch (e) {
    if (isConditionalFail(e)) return false;
    throw e;
  }
}

/** 写终态(只能从 running 写)。返回是否真写成(false = 已被别人收口,不覆盖)。 */
export async function finishCommand(
  commandId: string,
  outcome: { status: "succeeded"; summary: Record<string, unknown> } | { status: "failed"; error: string }
): Promise<boolean> {
  const now = new Date().toISOString();
  const succeeded = outcome.status === "succeeded";
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLES.ACTION_COMMANDS,
        Key: { commandId },
        UpdateExpression: succeeded
          ? "SET #s = :st, finishedAt = :t, summary = :x"
          : "SET #s = :st, finishedAt = :t, #e = :x",
        ConditionExpression: "#s = :running",
        ExpressionAttributeNames: succeeded ? { "#s": "status" } : { "#s": "status", "#e": "error" },
        ExpressionAttributeValues: {
          ":st": outcome.status,
          ":t": now,
          ":running": "running",
          ":x": succeeded ? outcome.summary : outcome.error.slice(0, ERR_MAX),
        },
      })
    );
    return true;
  } catch (e) {
    if (isConditionalFail(e)) return false;
    throw e;
  }
}

/**
 * 执行一条**已抢到**的命令并收口。🔴 永不抛:任何异常都落成 failed(否则命令停在 running,DAG 白等到租约)。
 * 收口本身写失败(DDB 抖动)⇒ 再试一次;还不行就打日志 —— 由 DAG 侧的租约兜底让 task 失败。
 */
export async function runClaimedCommand(cmd: ExecutableCommand, handlers: ActionHandlers): Promise<"succeeded" | "failed"> {
  const handler = handlers[cmd.action];
  let outcome: { status: "succeeded"; summary: Record<string, unknown> } | { status: "failed"; error: string };
  if (!handler) {
    outcome = { status: "failed", error: `动作 ${cmd.action} 在白名单里但没有执行体(部署版本不一致?)` };
  } else {
    try {
      outcome = { status: "succeeded", summary: (await handler(cmd)) ?? {} };
    } catch (e) {
      outcome = { status: "failed", error: errText(e) };
    }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await finishCommand(cmd.commandId, outcome);
      return outcome.status;
    } catch (e) {
      if (attempt === 1) {
        console.error("[action-dispatch] 命令 %s 收口写失败(由 DAG 侧租约兜底):%s", cmd.commandId, errText(e));
      }
    }
  }
  return outcome.status;
}

/**
 * 消费一条命令(内部端点调它)。
 * 返回 `accepted` 时**同步部分已完成**(校验 + 抢单),`execution` 是后台执行的 promise ——
 * 内部端点立刻回 202(动作可能跑几分钟,而 ALB 空闲超时只有 60s),执行在平台进程里继续。
 */
export async function dispatchCommand(commandId: string, handlers: ActionHandlers): Promise<DispatchOutcome> {
  const row = await getCommandRow(commandId);
  if (!row) return { kind: "missing" };
  const parsed = parseActionCommand(row);
  if (!parsed) {
    // 白名单外 / 缺字段 / 状态非法 ⇒ 不是合法命令:还在 pending 就直接判死(不许留给 DAG 等到超时)
    const reason = "命令不合法(动作不在白名单 / 缺字段 / 状态非法)—— 拒绝执行";
    await rejectPending(commandId, reason);
    return { kind: "rejected", reason, action: typeof row.action === "string" ? row.action : undefined };
  }
  if (parsed.status !== "pending") return { kind: "not-pending", status: parsed.status };
  if (!parsed.projectId) {
    const reason = "命令缺 projectId —— 不知道以哪个项目的身份执行(不默认任何项目)";
    await rejectPending(commandId, reason);
    return { kind: "rejected", reason, action: parsed.action };
  }
  const params = parsed.params ?? {};
  const bad = validateActionParams(parsed.action, params);
  if (bad) {
    await rejectPending(commandId, `参数不合法:${bad}`);
    return { kind: "rejected", reason: bad, action: parsed.action };
  }
  if (!(await claimCommand(commandId))) {
    const now = await getCommandRow(commandId);
    return { kind: "not-pending", status: String(now?.status ?? "unknown") };
  }
  const command: ExecutableCommand = { ...parsed, projectId: parsed.projectId, params, status: "running" };
  return { kind: "accepted", command, execution: runClaimedCommand(command, handlers).then(() => undefined) };
}
