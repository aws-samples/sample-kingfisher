// @kf-batch 50-B51-backfill-pump
// 「哪些补数计划还要推进」的**唯一一次读** —— 后台推进泵用(单一作者)。
//
// 🔴 零 node 内置依赖:泵在 `instrumentation.ts` 的可达面上(见 `pump.ts` 文件头)。只 import docClient / 表名 /
//    零依赖的 types.ts(「未收口」的穷尽表就在那里,与删项目前置校验同一个口径)。
// 🔴 只读键(pk / planId / projectId / status):泵拿到键就回环 POST 内部端点,真正的推进在那里。
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { isBackfillPlanOpen } from "@/lib/backfill/types";

/** 每轮最多推进几个计划(每个计划一次 tick 只领 concurrency 个实例,这里限的是回环请求数)。 */
export const BACKFILL_PUMP_MAX_PER_TICK = 10;
/** 扫描翻页上限(计划表是小表:每个计划一行;翻不完说明表异常大,本轮只推已读到的,下一轮继续)。 */
const MAX_SCAN_PAGES = 10;

export interface OpenPlanKey {
  projectId: string;
  planId: string;
}

/**
 * 未收口(planned / running / paused)的计划键,按 planId(ULID ⇒ 创建先后)排序后取前 `limit` 个。
 * paused 也要推:暂停只停「领新实例」,在途实例的终态回收(reconcile)仍要做,否则进度永远停在 running。
 */
export async function listOpenPlanKeys(limit = BACKFILL_PUMP_MAX_PER_TICK): Promise<OpenPlanKey[]> {
  const out: OpenPlanKey[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const r = await docClient.send(
      new ScanCommand({
        TableName: TABLES.BACKFILL_PLANS,
        ProjectionExpression: "planId, projectId, #s",
        ExpressionAttributeNames: { "#s": "status" },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      })
    );
    for (const it of r.Items ?? []) {
      const projectId = String(it.projectId ?? "");
      const planId = String(it.planId ?? "");
      if (projectId && planId && isBackfillPlanOpen(it.status)) out.push({ projectId, planId });
    }
    startKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!startKey) break;
  }
  out.sort((a, b) => a.planId.localeCompare(b.planId));
  return out.slice(0, Math.max(1, limit));
}
