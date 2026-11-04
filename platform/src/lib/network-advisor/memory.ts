// 模块 28 — 网络顾问多轮对话记忆（可切换记忆后端）。镜像 genbi/memory.ts 的双后端骨架。
// NETADVISOR_MEMORY_BACKEND=selfmanaged(默认) | agentcore
//  • selfmanaged：短期=DynamoDB bgp-network-advisor-turns(TTL~24h)。顾问对话通常较短，短期足够。
//  • agentcore：AgentCore 托管 Memory。短期=会话事件(CreateEvent/ListEvents)；
//    长期=语义策略自动抽取的记忆记录(平台侧本模块只用短期；长期由 Runtime 侧记忆策略沉淀)。
//
// 与 GenBI 一致：fire-and-forget，记忆失败不影响主流程。actorId = projectId（按项目隔离，
// 与 Runtime Memory namespace /netadvisor/{actorId} 对齐）。

import { homeRegion } from "@/lib/place/home-region";
// @kf-batch 50-WP31-place-first-class —— 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { sdkClient } from "@/lib/aws/clients";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "crypto";
import { BedrockAgentCoreClient, CreateEventCommand, ListEventsCommand } from "@aws-sdk/client-bedrock-agentcore";
import { docClient, TABLES } from "@/lib/aws/dynamodb";

const REGION = homeRegion();
const TURN_TTL_HOURS = 24;
const MAX_SHORT_TURNS = 6;

// 记忆后端开关（镜像 genbi/memory.ts:24-28）。
const MEMORY_BACKEND = (process.env.NETADVISOR_MEMORY_BACKEND || "selfmanaged").toLowerCase();
const MEMORY_ID = process.env.NETADVISOR_MEMORY_ID || "";
export function isAgentCoreMemory(): boolean {
  return MEMORY_BACKEND === "agentcore" && !!MEMORY_ID;
}

const agentcore = sdkClient("central:agentcore", BedrockAgentCoreClient, { region: REGION });

export interface AdvisorTurn {
  question: string;
  answer: string;
  ts?: string;
}

// AgentCore runtimeSessionId 需 ≥33 字符且对同一对话稳定（复用会话上下文）。镜像 genbi/memory.ts:37-40。
export function runtimeSessionId(conversationId: string): string {
  const h = createHash("sha256").update(conversationId || "default").digest("hex").slice(0, 48);
  return `netadvisor-${h}`; // 11 + 48 = 59 字符
}

// AgentCore Memory：actorId = projectId（按项目隔离）；会话事件 sessionId 复用 runtimeSessionId 规整。
const actorOf = (projectId?: string) => projectId || "proj-default";
const memSession = (conversationId: string) => runtimeSessionId(conversationId || "default");

// 写一轮（fire-and-forget 调用方）。
export async function appendTurn(conversationId: string, turn: AdvisorTurn, projectId?: string): Promise<void> {
  if (!conversationId) return;
  if (isAgentCoreMemory()) return appendTurnAgentCore(conversationId, turn, projectId);
  const now = new Date();
  await docClient.send(
    new PutCommand({
      TableName: TABLES.NETWORK_ADVISOR_TURNS,
      Item: {
        conversationId,
        ts: `${now.toISOString()}#${Math.random().toString(36).slice(2, 8)}`,
        question: (turn.question || "").slice(0, 4000),
        answer: (turn.answer || "").slice(0, 6000),
        ttl: Math.floor(now.getTime() / 1000) + TURN_TTL_HOURS * 3600,
      },
    })
  );
}

// 读最近 N 轮（注入 agent，支撑多轮细化）。
export async function loadShortTerm(conversationId: string, projectId?: string, n = MAX_SHORT_TURNS): Promise<AdvisorTurn[]> {
  if (!conversationId) return [];
  if (isAgentCoreMemory()) return loadShortTermAgentCore(conversationId, projectId, n);
  const { Items = [] } = await docClient.send(
    new QueryCommand({
      TableName: TABLES.NETWORK_ADVISOR_TURNS,
      KeyConditionExpression: "conversationId = :c",
      ExpressionAttributeValues: { ":c": conversationId },
      ScanIndexForward: true,
    })
  );
  return (Items as AdvisorTurn[]).slice(-n).map((i) => ({ question: i.question, answer: i.answer, ts: i.ts }));
}

// ───────────────────────── AgentCore 托管 Memory 后端（镜像 genbi/memory.ts:140-182）─────────────────────────

async function appendTurnAgentCore(conversationId: string, turn: AdvisorTurn, projectId?: string): Promise<void> {
  try {
    await agentcore.send(new CreateEventCommand({
      memoryId: MEMORY_ID,
      actorId: actorOf(projectId),
      sessionId: memSession(conversationId),
      eventTimestamp: new Date(),
      payload: [
        { conversational: { role: "USER", content: { text: turn.question || "" } } },
        { conversational: { role: "ASSISTANT", content: { text: (turn.answer || "（无文字结论）").slice(0, 6000) } } },
      ],
    }));
  } catch { /* best-effort：记忆失败不影响顾问 */ }
}

async function loadShortTermAgentCore(conversationId: string, projectId: string | undefined, n: number): Promise<AdvisorTurn[]> {
  try {
    const r = await agentcore.send(new ListEventsCommand({
      memoryId: MEMORY_ID,
      actorId: actorOf(projectId),
      sessionId: memSession(conversationId),
      includePayloads: true,
      maxResults: 40,
    }));
    const events = (r.events || []).slice().sort(
      (a, b) => (a.eventTimestamp?.getTime?.() || 0) - (b.eventTimestamp?.getTime?.() || 0)
    );
    const turns: AdvisorTurn[] = [];
    for (const ev of events) {
      let q = "", a = "";
      for (const p of (ev.payload || []) as { conversational?: { role?: string; content?: { text?: string } } }[]) {
        const c = p?.conversational;
        if (!c) continue;
        const text = c.content?.text || "";
        if (c.role === "USER") q = text;
        else if (c.role === "ASSISTANT") a = text;
      }
      if (q) turns.push({ question: q, answer: a });
    }
    return turns.slice(-n);
  } catch {
    return [];
  }
}
