// 「哪些作业到期了」的**唯一一次 Query** —— 泵与 store 共用(单一作者)。
//
// 🔴 零 node 内置依赖(泵在 instrumentation 可达面里;见 schema.ts 文件头)。
// 🔴 只读 jobId:泵拿到 id 就回环 POST 内部端点,真正的抢占 / 执行 / 写回全在内部端点里
//    (泵侧零执行器 import —— 这既是 bundle 约束,也让「正确性不依赖选主」成立:
//    泵只是个闹钟,两个闹钟同时响也只有一个能抢到租约)。
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@/lib/aws/dynamodb";
import { DATAPLANE_JOBS_TABLE, DUE_SHARD, GSI_BY_DUE } from "@/lib/dataplane-jobs/schema";

/** 每轮最多推进几条(④-2:每轮 ≤5)。 */
export const PUMP_MAX_PER_TICK = 5;

/**
 * 取到期(`nextRunAt <= now`)且未终态的作业 id,按到期先后。
 * 🔴 GSI 最终一致:可能取到刚被别人推进过的作业 —— 无害(抢占条件会挡下),只是多一次 409。
 */
export async function queryDueJobIds(now: number, limit = PUMP_MAX_PER_TICK): Promise<string[]> {
  const r = await docClient.send(
    new QueryCommand({
      TableName: DATAPLANE_JOBS_TABLE(),
      IndexName: GSI_BY_DUE,
      KeyConditionExpression: "#d = :d AND #n <= :now",
      ExpressionAttributeNames: { "#d": "dueShard", "#n": "nextRunAt" },
      ExpressionAttributeValues: { ":d": DUE_SHARD, ":now": now },
      ScanIndexForward: true,
      Limit: Math.max(1, Math.min(limit, 25)),
      ProjectionExpression: "jobId",
    })
  );
  return (r.Items ?? []).map((i) => String(i.jobId ?? "")).filter((s) => s.length > 0);
}
