// Copilot 短期会话记忆(自管 DynamoDB TTL,形态照抄 lib/genbi/memory.ts)。
// 表名走 env(COPILOT_TURNS_TABLE),默认 bgp-copilot-turns。表未建时读写静默降级(不阻断问答),
// 使 inprocess 后端在任何基建就绪度下都可用(面向全球自安装:零基建也能先跑起来)。
// 后续可接 AgentCore 托管 Memory(COPILOT_MEMORY_BACKEND=agentcore),此处保留切换位。

import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@/lib/aws/dynamodb";

const TABLE = process.env.COPILOT_TURNS_TABLE || "bgp-copilot-turns";
const TURN_TTL_HOURS = 24;
const MAX_SHORT_TURNS = 8;

export interface CopilotTurn { question: string; answer: string; ts?: string }

export async function appendTurn(conversationId: string, turn: CopilotTurn): Promise<void> {
  if (!conversationId) return;
  const now = new Date();
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE,
      Item: {
        conversationId,
        ts: `${now.toISOString()}#${Math.random().toString(36).slice(2, 8)}`,
        question: String(turn.question || "").slice(0, 2000),
        answer: String(turn.answer || "").slice(0, 4000),
        ttl: Math.floor(now.getTime() / 1000) + TURN_TTL_HOURS * 3600,
      },
    }));
  } catch { /* 表未建/写失败:静默降级,不阻断问答 */ }
}

export async function loadShortTerm(conversationId: string, n = MAX_SHORT_TURNS): Promise<CopilotTurn[]> {
  if (!conversationId) return [];
  try {
    const { Items = [] } = await docClient.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "conversationId = :c",
      ExpressionAttributeValues: { ":c": conversationId },
      ScanIndexForward: true,
    }));
    return (Items as any[]).slice(-n).map((i) => ({ question: i.question, answer: i.answer, ts: i.ts }));
  } catch { return []; }
}
