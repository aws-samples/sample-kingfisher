// 模块 34 — 自测 sink 存储。generic 通道可指向平台自身 api/alerting/test-sink,收到的 payload
// 存进 bgp-alert-events 的保留分区(ruleId="__testsink__"),供无头验证「投递确实到达」+ 页面回看。
// 复用告警事件表(带 TTL,自动清理),不新增表。

import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { docClient, TABLES } from "@/lib/aws/dynamodb";

const SINK_PK = "__testsink__";
const TTL_DAYS = 7; // 自测数据留 7 天足够

export async function recordSinkHit(payload: unknown): Promise<{ id: string; at: string }> {
  const now = new Date();
  const id = ulid();
  const at = now.toISOString();
  await docClient.send(
    new PutCommand({
      TableName: TABLES.ALERT_EVENTS,
      Item: {
        ruleId: SINK_PK,
        sk: `${at}#${id}`,
        receivedAt: at,
        payload,
        ttl: Math.floor(now.getTime() / 1000) + TTL_DAYS * 86400,
      },
    })
  );
  return { id, at };
}

// 读最近的自测投递(新在前),供 UI/验收查看 sink 是否收到。
export async function listSinkHits(limit = 20): Promise<Array<{ receivedAt: string; payload: unknown }>> {
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.ALERT_EVENTS,
      KeyConditionExpression: "ruleId = :r",
      ExpressionAttributeValues: { ":r": SINK_PK },
      ScanIndexForward: false,
      Limit: limit,
    })
  );
  return (Items as any[]).map((i) => ({ receivedAt: i.receivedAt, payload: i.payload }));
}
