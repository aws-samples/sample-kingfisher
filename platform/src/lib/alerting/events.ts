// 告警事件流(bgp-alert-events)。pk=ruleId(天然分散),sk=dedupeKey(**即去重键**)。
// 幂等铁律:命中时 putEventIfNew 用条件写 attribute_not_exists(ruleId),同一 run/窗口只产生一条
// 事件,连点评估/多次触发都不重复告警。事件 TTL ~90 天自动过期。

import { PutCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { AlertEvent, ChannelDeliveryResult, EventStatus } from "./types";

const TTL_DAYS = 90;

// 尝试写入一条新事件。若该 (ruleId, dedupeKey) 已存在(已告过警)→ 返回 null(幂等跳过)。
export async function putEventIfNew(
  ev: Omit<AlertEvent, "sk" | "eventId" | "createdAt" | "ttl" | "channelResults" | "status"> & {
    channelResults?: ChannelDeliveryResult[];
    status?: EventStatus;
  }
): Promise<AlertEvent | null> {
  const now = new Date();
  const item: AlertEvent = {
    ruleId: ev.ruleId,
    sk: ev.dedupeKey,
    eventId: ulid(),
    ruleName: ev.ruleName,
    severity: ev.severity,
    projectId: ev.projectId,
    status: ev.status || "firing",
    dedupeKey: ev.dedupeKey,
    message: ev.message,
    ...(ev.msgKey ? { msgKey: ev.msgKey } : {}),
    ...(ev.msgParams ? { msgParams: ev.msgParams } : {}),
    trigger: ev.trigger,
    // 事件行盖区章:告警中心要能按区筛
    // 「这个区有哪些告警」。真值取 `trigger.targetId`(评估时算出来的那个区),**不另猜**;
    // 池化评估(evaluation:"pooled")的事件天然没有区 ⇒ 不盖章,读侧按主控区回落显示。
    ...(typeof (ev.trigger as { targetId?: unknown })?.targetId === "string"
      ? { targetId: (ev.trigger as { targetId: string }).targetId }
      : {}),
    ...(ev.diagnosisId ? { diagnosisId: ev.diagnosisId } : {}),
    channelResults: ev.channelResults || [],
    createdAt: now.toISOString(),
    ttl: Math.floor(now.getTime() / 1000) + TTL_DAYS * 86400,
  };
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLES.ALERT_EVENTS,
        Item: item,
        ConditionExpression: "attribute_not_exists(ruleId)",
      })
    );
    return item;
  } catch (e: any) {
    if (e?.name === "ConditionalCheckFailedException") return null; // 已存在 → 幂等跳过
    throw e;
  }
}

// 分发完成后回写投递结果 + 最终状态(firing → notified/partial/failed)。
export async function updateEventDelivery(
  ruleId: string,
  sk: string,
  status: EventStatus,
  channelResults: ChannelDeliveryResult[],
  diagnosisId?: string
): Promise<void> {
  const sets = ["#s = :s", "channelResults = :cr"];
  const values: Record<string, unknown> = { ":s": status, ":cr": channelResults };
  if (diagnosisId) { sets.push("diagnosisId = :d"); values[":d"] = diagnosisId; }
  await docClient
    .send(
      new UpdateCommand({
        TableName: TABLES.ALERT_EVENTS,
        Key: { ruleId, sk },
        UpdateExpression: "SET " + sets.join(", "),
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: values,
      })
    )
    .catch(() => {});
}

// 列出某规则的事件(Query,新在前)。
export async function listEventsByRule(ruleId: string, limit = 100): Promise<AlertEvent[]> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.ALERT_EVENTS,
      KeyConditionExpression: "ruleId = :r",
      ExpressionAttributeValues: { ":r": ruleId },
      Limit: limit,
    })
  );
  return sortByCreatedDesc(Items as AlertEvent[]);
}

// 跨规则列出最近事件(告警中心「事件」Tab / 大屏「最近告警」卡)。低量,Scan + 内存排序,
// 同 bgp-task-runs 监控约定。可按 projectId 过滤。
export async function listRecentEvents(opts?: { projectId?: string; limit?: number }): Promise<AlertEvent[]> {
  const { Items = [] } = await docClient.send(
    new ScanCommand({ TableName: TABLES.ALERT_EVENTS, Limit: 500 })
  );
  let items = Items as AlertEvent[];
  if (opts?.projectId) items = items.filter((e) => e.projectId === opts.projectId);
  return sortByCreatedDesc(items).slice(0, opts?.limit ?? 100);
}

function sortByCreatedDesc(items: AlertEvent[]): AlertEvent[] {
  return items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}
