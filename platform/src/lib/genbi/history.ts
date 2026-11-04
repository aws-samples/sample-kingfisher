// GenBI question history — best-effort persistence to DynamoDB (bgp-genbi-history).
// Writes never block or break the ask flow; reads degrade to an empty list if the table
// is not yet deployed. Mirrors the platform's /api/redshift/history pattern.

import { PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
import { ulid } from "ulid";
import type { GenBiHistoryItem, GenBiResult } from "@/types/genbi";

// Compact per-request tool-call tally from the agent's step trace, e.g.
// [{tool:"run_sql",calls:2,errors:0}, {tool:"introspect_redshift_schema",calls:1,errors:0}].
// Persisted so Observability can count IN-PROCESS skill/tool calls (which never hit the
// AgentCore Lambda and thus emit no CloudWatch EMF). Named-tool steps only; SQL string dropped.
function summarizeToolCalls(steps: GenBiResult["steps"]): { tool: string; calls: number; errors: number }[] {
  const acc = new Map<string, { calls: number; errors: number }>();
  for (const s of steps || []) {
    const tool = (s?.tool || "").trim();
    if (!tool) continue; // only steps that named a tool/skill
    const cur = acc.get(tool) || { calls: 0, errors: 0 };
    cur.calls += 1;
    if (s.ok === false) cur.errors += 1;
    acc.set(tool, cur);
  }
  return Array.from(acc.entries()).map(([tool, v]) => ({ tool, calls: v.calls, errors: v.errors }));
}

export async function recordGenBiHistory(
  userId: string,
  question: string,
  result: GenBiResult,
  // `targetId` = 这次问数的 SQL 真打到的区。
  // 🔴 可选而不是必填:本函数是 best-effort 旁路,签名收紧会让调用方为了编译通过而**瞎填一个区**。
  // 缺省不补 home:历史行没有章就交给读侧的三级/标量回落统一处理(一处定义)。
  meta?: { engine?: string; backend?: string; targetId?: string }
): Promise<void> {
  try {
    const toolCalls = summarizeToolCalls(result.steps);
    const item: GenBiHistoryItem & {
      engine?: string; backend?: string; inputTokens?: number; outputTokens?: number;
      toolCalls?: { tool: string; calls: number; errors: number }[];
    } = {
      userId,
      historyId: ulid(),
      question,
      answer: result.answer,
      sql: result.sql,
      rowCount: result.rowCount,
      chartType: result.chart.type,
      createdAt: new Date().toISOString(),
      ...(meta?.engine ? { engine: meta.engine } : {}),
      ...(meta?.backend ? { backend: meta.backend } : {}),
      ...(meta?.targetId ? { targetId: meta.targetId } : {}),
      ...(result.usage ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    };
    await docClient.send(new PutCommand({ TableName: TABLES.GENBI_HISTORY, Item: item }));
  } catch {
    // best-effort — history must never break the primary request
  }
}

// 跨用户扫描最近 GenBI 历史（供 Observability 看板用量统计；量级低）。
export async function scanGenBiHistory(limit = 500): Promise<any[]> {
  try {
    const { Items = [] } = await docClient.send(
      new ScanCommand({ TableName: TABLES.GENBI_HISTORY, Limit: Math.min(Math.max(limit, 1), 1000) })
    );
    return Items as any[];
  } catch {
    return [];
  }
}

export async function listGenBiHistory(userId: string, limit = 50): Promise<GenBiHistoryItem[]> {
  try {
    const { Items = [] } = await docClient.send(
      new QueryCommand({
        TableName: TABLES.GENBI_HISTORY,
        KeyConditionExpression: "userId = :uid",
        ExpressionAttributeValues: { ":uid": userId },
        ScanIndexForward: false,
        Limit: Math.min(Math.max(limit, 1), 200),
      })
    );
    return Items as GenBiHistoryItem[];
  } catch {
    return [];
  }
}
