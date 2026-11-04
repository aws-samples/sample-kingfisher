// @kf-batch 50-W3f-T0-T3
// 模块 40 × 50 —— 存量成本行补章(门票 T1 的「一次性回填」,50 ROADMAP §2octies.17 ⑧)。
//
// 成本行由 sweep 从 run 行派生;T1 之前的 sweep 不带章 ⇒ 存量成本行没有 `{projectId, targetId}`,
// 成本按 target 归因(O3b)对它们就是盲的。章的真值源是 run 行(`bgp-task-runs`,W2-a 起每条都有章),
// 所以回填 = 按 (taskId, runId) 回查 run 行、把它的章**条件写**到成本行:
//  · 只补空缺(`attribute_not_exists(targetId)`),已有章的行一律不碰 ⇒ 可反复执行;
//  · run 行找不到 / run 行本身无章 ⇒ **如实登记 unresolved,绝不猜 home**
//    (猜 home 会把一条也许跑在 us-west-2 的成本记到 home 头上,而且看起来"回填成功了")。
// 入口:`POST /api/finops/collect?backfill=1`(与 sweep 的 backfill 同一开关;幂等)。
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { FINOPS_TABLES } from "./constants";
import { costRunPk, scanAllCostRuns } from "./store";

export interface StampBackfillResult {
  scanned: number;
  backfilled: number;
  alreadyStamped: number;
  unresolved: Array<{ taskId: string; runId: string; reason: string }>;
}

export async function backfillCostRunStamps(): Promise<StampBackfillResult> {
  const rows = await scanAllCostRuns();
  const out: StampBackfillResult = { scanned: rows.length, backfilled: 0, alreadyStamped: 0, unresolved: [] };
  for (const row of rows) {
    if (row.projectId && row.targetId) {
      out.alreadyStamped++;
      continue;
    }
    const { Item: run } = await docClient.send(
      new GetCommand({ TableName: TABLES.TASK_RUNS, Key: { taskId: row.taskId, runId: row.runId } })
    );
    const projectId = typeof run?.projectId === "string" ? run.projectId : "";
    const targetId = typeof run?.targetId === "string" ? run.targetId : "";
    if (!run || !projectId || !targetId) {
      out.unresolved.push({ taskId: row.taskId, runId: row.runId, reason: run ? "run 行无章" : "run 行不存在" });
      continue;
    }
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: FINOPS_TABLES.COST_RUNS,
          Key: { pk: costRunPk(row.taskId), sk: row.sk },
          UpdateExpression: "SET projectId = :p, targetId = :t",
          ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(targetId)",
          ExpressionAttributeValues: { ":p": projectId, ":t": targetId },
        })
      );
      out.backfilled++;
    } catch (e: unknown) {
      // 条件不满足 = 并发的另一次回填已经补上了;这是正常分支,不是错误。
      if ((e as { name?: string }).name === "ConditionalCheckFailedException") out.alreadyStamped++;
      else throw e;
    }
  }
  return out;
}
