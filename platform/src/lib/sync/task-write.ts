/**
 * 同步任务行(`bgp-sync-tasks`)的**唯一状态写通道**。
 *
 * 【为什么必须收成一个作者】
 * DynamoDB 的 `UpdateItem` 默认是 **upsert**:行不存在时它**建**一个只有 Key + 本次 SET 那几个字段
 * 的残行。于是任何「读出 task → 过一会儿写回状态」的路径,在这中间行被删掉之后,都会
 * **把那条已删的任务凭空造回来** —— 页面上出现一条没有名字、没有源、删不掉的任务。
 *
 * 真环境证据(第三轮全量硬门 `wp24` 段 WP24-4):
 *   `删除 HTTP=['#1 200'] DMS 侧还在=False(轮询到消失) 平台行还在=True`
 * 删除路由本身是对的(先撤通道、撤不下来就 409/502 不删行、否则才 Delete,且 Get/Delete 同一个 Key),
 * 判据也用的是 **`--consistent-read`** ⇒ 「强一致读到行还在」只能是**被谁写回来了**。
 * 而那一轮是**并行 3 worker**,同时有别的段在刷同步任务列表 / 后台还有 `pollGlueJob` 在轮询。
 *
 * 🔴 **不逐处去追「到底是哪一处、什么时序」**:只要还有一处直接发 `UpdateCommand`,这类缺陷就还会回来
 * (本仓「枚举违规写法一定漏掉第 N+1 种」的老账)。⇒ 反过来定**唯一允许的形态**:
 *   · 所有状态写回都走本函数,内部恒带 `ConditionExpression: attribute_exists(taskId)`;
 *   · 行不存在 ⇒ **静默 no-op 并返回 `false`**(这是正确语义:任务已被删,这次回写本就不该发生),
 *     绝不 upsert、也不当成错误往上抛(后台轮询抛错没人接,反而会盖掉真正的失败)。
 * 同源先例:`lib/monitor/run-records.ts` 的 `updateRunRecord`(run 台账的唯一写通道)、
 * 以及 `publish-dag.ts` 的 `recordWorkflowDeployment`(发布台账条件写)。
 *
 * 🔴 路由里那道 `if (!task) return 404` 是**主防线**,本函数是**并发窗口的兜底**(强读之后、
 *   写之前那一瞬被别人删掉)。两道都要 —— 少了条件写就有 TOCTOU 缝。
 */
import { UpdateCommand, type UpdateCommandInput, type UpdateCommandOutput } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";

const USER_ID = "default-user";

/** 同步任务行不存在时,本通道**不建行**;调用方据此知道「这次回写落空了」。 */
export const SYNC_TASK_GONE = false as const;

export type SyncTaskUpdate = Omit<
  UpdateCommandInput,
  "TableName" | "Key" | "ConditionExpression" | "ReturnValuesOnConditionCheckFailure"
> & {
  taskId: string;
  userId?: string;
  /**
   * 额外前置条件(与 `attribute_exists(taskId)` 取 **AND**;只许引用调用方自己在
   * ExpressionAttributeNames / Values 里给出的 `#名` / `:值`)。
   *
   * 「同一任务只许一条启动编排在飞」这类**状态机守卫**
   *   也必须经本通道(否则又回到绕开唯一作者裸发 UpdateCommand 的老路)。写之前**读出来再判**不行:
   *   读与写之间就是并发窗口,该缺陷的两条编排正是在那条缝里一起起跑的。
   */
  onlyIf?: string;
};

/** 条件写没落下去的原因:行已不存在(no-op)/ 行在、但调用方给的前置条件不成立(被别人抢先改了状态)。 */
export type SyncTaskWriteMiss = "gone" | "precondition";

/**
 * 条件写一条同步任务行。
 * @returns 行存在并写成功 ⇒ `{ ok: true, Attributes }`;
 *   行已不存在 ⇒ `{ ok: false, miss: "gone" }`(no-op,不抛);
 *   给了 `onlyIf` 且行在、条件不成立 ⇒ `{ ok: false, miss: "precondition" }`(同样不抛,调用方据此回 409 / 放弃回写)。
 *   其它错误照旧抛出(凭证/限流之类不许被吞成「行不存在」)。
 */
export async function updateSyncTaskIfExists(
  input: SyncTaskUpdate
): Promise<{ ok: boolean; Attributes?: UpdateCommandOutput["Attributes"]; miss?: SyncTaskWriteMiss }> {
  const { taskId, userId, onlyIf, ...rest } = input;
  try {
    const out = await docClient.send(
      new UpdateCommand({
        ...rest,
        TableName: TABLES.SYNC_TASKS,
        Key: { userId: userId || USER_ID, taskId },
        // 🔴 这一行就是本模块存在的理由 —— 删掉它,已删的任务会被后台回写**凭空造回来**。
        //   调用方的额外条件只能**叠**在它后面,不能替掉它。
        ConditionExpression: onlyIf ? `attribute_exists(taskId) AND (${onlyIf})` : "attribute_exists(taskId)",
        // 有额外条件时要分得清「行没了」还是「条件没过」:DynamoDB 条件失败只回一种异常,
        // 让它把旧行带回来 —— 带回来了 = 行在、是条件没过;空 = 行没了。
        ...(onlyIf ? { ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const } : {}),
      })
    );
    return { ok: true, Attributes: out.Attributes };
  } catch (e) {
    const name = (e as { name?: string })?.name || "";
    if (name === "ConditionalCheckFailedException") {
      const rowStillThere = Boolean(onlyIf && (e as { Item?: unknown })?.Item);
      return { ok: SYNC_TASK_GONE, miss: rowStillThere ? "precondition" : "gone" };
    }
    throw e;
  }
}
