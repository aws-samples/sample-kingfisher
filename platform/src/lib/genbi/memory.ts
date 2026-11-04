// GenBI on AgentCore：对话存储（可切换记忆后端）。
// GENBI_MEMORY_BACKEND=selfmanaged(默认) | agentcore
//  • selfmanaged：短期=DynamoDB bgp-genbi-turns(TTL~24h)；长期=S3 摘要(Bedrock 生成)。
//  • agentcore：AgentCore 托管 Memory。短期=会话事件(CreateEvent/ListEvents)；
//    长期=语义策略自动抽取的记忆记录(RetrieveMemoryRecords，托管向量语义检索)。
// 散建客户端收口到唯一工厂(L3;行为保持:构造参数原样,见 lib/aws/clients.ts#sdkClient)
import { homeRegion } from "@/lib/place/home-region";
import { sdkClient } from "@/lib/aws/clients";
import { BatchWriteCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  BedrockAgentCoreClient, CreateEventCommand, ListEventsCommand, RetrieveMemoryRecordsCommand, DeleteEventCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { docClient, TABLES } from "@/lib/aws/dynamodb";
// 长期摘要的 modelId 改为调用时经 invokeConverse 求值(能力 key genbi-memory);
// 删掉此前的模块加载期顶层常量 MODEL_ID = resolveModelId()(DESIGN §1.2 #3「最易漏」的那个)。
import { invokeConverse } from "@/lib/ai/invoke";

const REGION = homeRegion();
const MEMORY_BUCKET = process.env.GENBI_MEMORY_BUCKET || `bgp-datalake-${process.env.AWS_ACCOUNT_ID || ""}`;
const MEMORY_PREFIX = "genbi-memory";
const TURN_TTL_HOURS = 24;
const MAX_SHORT_TURNS = 6;     // 注入 Agent 的最近轮数
const SUMMARIZE_EVERY = 6;     // 每累计 N 轮触发一次长期摘要（仅 selfmanaged）

// 记忆后端开关。
const MEMORY_BACKEND = (process.env.GENBI_MEMORY_BACKEND || "selfmanaged").toLowerCase();
const MEMORY_ID = process.env.GENBI_MEMORY_ID || "";
export function isAgentCoreMemory(): boolean {
  return MEMORY_BACKEND === "agentcore" && !!MEMORY_ID;
}

const s3 = sdkClient("control-plane", S3Client, { region: REGION });
const bedrock = sdkClient("model", BedrockRuntimeClient, { region: REGION });
const agentcore = sdkClient("central:agentcore", BedrockAgentCoreClient, { region: REGION });

export interface Turn { question: string; answer: string; sql?: string | null; ts?: string }

// AgentCore runtimeSessionId 需 ≥33 字符且对同一对话稳定（复用会话上下文）。
export function runtimeSessionId(conversationId: string): string {
  const h = createHash("sha256").update(conversationId || "default").digest("hex").slice(0, 48);
  return `genbi-${h}`; // 6 + 48 = 54 字符
}

// AgentCore Memory：actorId = projectId（长期记忆按项目隔离，与自管 S3 一致）；
// 会话事件 sessionId 须 ≥ 一定长度且仅含允许字符——复用 runtimeSessionId 规整。
const actorOf = (projectId?: string) => projectId || "proj-default";
const namespaceOf = (projectId?: string) => `/genbi/${actorOf(projectId)}`;
const memSession = (conversationId: string) => runtimeSessionId(conversationId || "default");

// ── 短期：写一轮 ──
export async function appendTurn(conversationId: string, turn: Turn, projectId?: string): Promise<void> {
  if (!conversationId) return;
  if (isAgentCoreMemory()) return appendTurnAgentCore(conversationId, turn, projectId);
  const now = new Date();
  await docClient.send(new PutCommand({
    TableName: TABLES.GENBI_TURNS,
    Item: {
      conversationId,
      ts: `${now.toISOString()}#${Math.random().toString(36).slice(2, 8)}`,
      question: turn.question,
      answer: (turn.answer || "").slice(0, 4000),
      sql: turn.sql || null,
      ttl: Math.floor(now.getTime() / 1000) + TURN_TTL_HOURS * 3600,
    },
  }));
}

// ── 短期：读最近 N 轮 ──
export async function loadShortTerm(conversationId: string, projectId?: string, n = MAX_SHORT_TURNS): Promise<Turn[]> {
  if (!conversationId) return [];
  if (isAgentCoreMemory()) return loadShortTermAgentCore(conversationId, projectId, n);
  const { Items = [] } = await docClient.send(new QueryCommand({
    TableName: TABLES.GENBI_TURNS,
    KeyConditionExpression: "conversationId = :c",
    ExpressionAttributeValues: { ":c": conversationId },
    ScanIndexForward: true,
  }));
  return (Items as any[]).slice(-n).map((i) => ({ question: i.question, answer: i.answer, sql: i.sql, ts: i.ts }));
}

export async function countTurns(conversationId: string): Promise<number> {
  if (!conversationId) return 0;
  const { Count = 0 } = await docClient.send(new QueryCommand({
    TableName: TABLES.GENBI_TURNS,
    KeyConditionExpression: "conversationId = :c",
    ExpressionAttributeValues: { ":c": conversationId },
    Select: "COUNT",
  }));
  return Count;
}

// ── 长期：读相关历史（selfmanaged=最近摘要；agentcore=语义召回）──
export async function loadLongTerm(projectId: string, question: string, limit = 3): Promise<string> {
  if (isAgentCoreMemory()) return loadLongTermAgentCore(projectId, question, limit);
  if (!MEMORY_BUCKET) return "";
  const prefix = `${MEMORY_PREFIX}/${projectId || "proj-default"}/`;
  try {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: MEMORY_BUCKET, Prefix: prefix, MaxKeys: 50 }));
    const objs = (list.Contents || []).sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0)).slice(0, limit);
    const parts: string[] = [];
    for (const o of objs) {
      if (!o.Key) continue;
      const r = await s3.send(new GetObjectCommand({ Bucket: MEMORY_BUCKET, Key: o.Key }));
      const body = await r.Body?.transformToString();
      if (!body) continue;
      try { const j = JSON.parse(body); if (j.summary) parts.push(`- ${j.summary}`); } catch {}
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}

// ── 长期：达阈值时把对话总结写入 S3（fire-and-forget）。仅 selfmanaged；agentcore 由语义策略自动抽取。──
export async function maybeSummarize(conversationId: string, projectId: string): Promise<void> {
  if (isAgentCoreMemory()) return; // AgentCore 语义策略自动从事件抽取长期记忆，无需手工摘要。
  if (!MEMORY_BUCKET || !conversationId) return;
  const turns = await loadShortTerm(conversationId, projectId, 50);
  if (turns.length === 0 || turns.length % SUMMARIZE_EVERY !== 0) return; // 每 N 轮一次
  const convoText = turns.map((t) => `Q: ${t.question}\nA: ${(t.answer || "").slice(0, 300)}\nSQL: ${t.sql || ""}`).join("\n---\n");
  let summary = "";
  try {
    // modelId 每次调用求值(genbi-memory),经 invokeConverse 退避/降级。
    const { response: resp } = await invokeConverse("genbi-memory", undefined, bedrock, (modelId) => new ConverseCommand({
      modelId,
      system: [{ text: "你是数据分析助理。把以下智能问数对话总结成一段中文长期记忆：用户关注的业务口径/常用表/结论要点/偏好。只输出摘要本身，120字内，不要敏感明细数据。" }],
      messages: [{ role: "user", content: [{ text: convoText.slice(0, 6000) }] }],
      inferenceConfig: { maxTokens: 400 },
    }));
    summary = (resp.output?.message?.content || []).map((b: any) => (b.text ? b.text : "")).join("").trim();
  } catch { return; }
  if (!summary) return;
  await s3.send(new PutObjectCommand({
    Bucket: MEMORY_BUCKET,
    Key: `${MEMORY_PREFIX}/${projectId || "proj-default"}/${conversationId}.json`,
    Body: JSON.stringify({ conversationId, projectId, summary, turns: turns.length, updatedAt: new Date().toISOString() }),
    ContentType: "application/json",
  })).catch(() => {});
}

// ───────────────────────── AgentCore 托管 Memory 后端 ─────────────────────────

async function appendTurnAgentCore(conversationId: string, turn: Turn, projectId?: string): Promise<void> {
  try {
    const answer = (turn.answer || "").slice(0, 4000) + (turn.sql ? `\n[SQL] ${turn.sql}` : "");
    await agentcore.send(new CreateEventCommand({
      memoryId: MEMORY_ID,
      actorId: actorOf(projectId),
      sessionId: memSession(conversationId),
      eventTimestamp: new Date(),
      payload: [
        { conversational: { role: "USER", content: { text: turn.question || "" } } },
        { conversational: { role: "ASSISTANT", content: { text: answer || "（无文字结论）" } } },
      ],
    }));
  } catch { /* best-effort：记忆失败不影响问数 */ }
}

async function loadShortTermAgentCore(conversationId: string, projectId: string | undefined, n: number): Promise<Turn[]> {
  try {
    const r = await agentcore.send(new ListEventsCommand({
      memoryId: MEMORY_ID,
      actorId: actorOf(projectId),
      sessionId: memSession(conversationId),
      includePayloads: true,
      maxResults: 40,
    }));
    const events = (r.events || []).slice().sort((a: any, b: any) => (a.eventTimestamp?.getTime?.() || 0) - (b.eventTimestamp?.getTime?.() || 0));
    const turns: Turn[] = [];
    for (const ev of events) {
      let q = "", a = "";
      for (const p of (ev.payload || []) as any[]) {
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

async function loadLongTermAgentCore(projectId: string, question: string, limit: number): Promise<string> {
  try {
    const r = await agentcore.send(new RetrieveMemoryRecordsCommand({
      memoryId: MEMORY_ID,
      namespace: namespaceOf(projectId),
      searchCriteria: { searchQuery: (question && question.trim()) || "用户偏好与业务口径", topK: limit },
      maxResults: limit,
    }));
    const recs = (r.memoryRecordSummaries || []) as any[];
    return recs
      .map((x) => (x.content?.text || "").trim())
      .filter(Boolean)
      .map((t) => `- ${t}`)
      .join("\n");
  } catch {
    return "";
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 打开一张会话卡片时**重建短期记忆**(54 DESIGN v1.2 §3.3)
//
// 【为什么必须回灌,而不是「把 conversationId 塞回去就行」】
//   短期记忆 TTL 只有 24h(`TURN_TTL_HOURS`),AgentCore 侧也是托管会话。三周后打开那张卡,
//   id 还在、上下文早没了 ⇒ 追问「那按分类呢?」会得到一个**看起来正常、其实脱离上下文**的答案。
//   这正是本仓最怕的「错得像对的」—— 比明确报错坏得多。
//
// 【为什么是「覆盖式」而不是「追加」】
//   记忆里可能残留旧事件 / 暖容器状态,而**卡片正文是权威**。追加会把同一段对话灌成两份,
//   模型看到重复问答后更容易胡编。⇒ 先清同 conversationId 的短期条目,再按序写回。
//
// 【幂等】重复打开同一张卡不能把上下文灌成两倍:
//   ① 先比一次「现存的问题序列是否已经等于要灌的」⇒ 相等就什么都不做(`skipped`);
//   ② selfmanaged 侧的排序键**确定性**(`0000-replay-<序号>`)⇒ 即便重复执行也是**覆盖同一批键**,
//      而不是产生第二份;而且这个前缀在字典序上**排在所有真实 ISO 时间戳之前**(ISO 以「2」开头),
//      于是「回灌的历史在前、之后新问的在后」天然成立(`loadShortTerm` 取的是升序后的最后 n 条)。
//   ③ AgentCore 侧事件 id 由服务生成、无法构造成幂等 ⇒ 靠 ①,并且**先删后写**。
// ═════════════════════════════════════════════════════════════════════════════

/** 回灌结果。`skipped` = 已经是这份内容,一个字节都没动(幂等命中)。 */
export interface ReplaceConversationResult {
  backend: "selfmanaged" | "agentcore";
  /** 清掉的旧条目 / 事件数 */
  cleared: number;
  /** 真正写回的轮数 */
  written: number;
  skipped: boolean;
}

/** 回灌用的确定性排序键前缀:必须排在真实 ISO 时间戳(以 `2` 开头)之前。 */
export const REPLAY_TS_PREFIX = "0000-replay-";

/** 现存短期记忆里的问题序列(用于幂等比对)。 */
async function existingQuestions(conversationId: string, projectId?: string): Promise<string[]> {
  const turns = await loadShortTerm(conversationId, projectId, 500);
  return turns.map((t) => (t.question || "").trim());
}

/**
 * 🔴 幂等判据是「**卡片的轮次是现存对话的前缀**」,不是「完全相等」。
 * 差别是一个真 bug:用户打开卡片(回灌 4 轮)→ 又追问了 2 轮(现存 6 轮)→ 再点一次「打开续聊」
 * (或页面重复触发 resume)。若判「完全相等」⇒ 4 ≠ 6 ⇒ 走清理重灌 ⇒ **把他刚问的 2 轮上下文清掉**,
 * 违反护栏一「不丢东西」,而且现象是「越用越傻」,几乎不可能被归因到这里。
 */
function isPrefixOf(want: string[], have: string[]): boolean {
  return have.length >= want.length && want.every((x, i) => have[i] === x);
}

/**
 * 用卡片正文里的轮次**覆盖式重建**这段对话的短期记忆。
 *
 * 🔴 `conversationId` **必填且沿用卡片原来那个** —— 换一个新 id 会让「再次保存」找不到原来那张卡
 * (卡片的幂等键就是 conversationId,见 cards-store.ts),于是点一次保存就多吃一个额度。
 */
export async function replaceConversation(
  conversationId: string,
  turns: Turn[],
  projectId?: string
): Promise<ReplaceConversationResult> {
  const backend: "selfmanaged" | "agentcore" = isAgentCoreMemory() ? "agentcore" : "selfmanaged";
  if (!conversationId) throw new Error("replaceConversation 缺 conversationId(它是卡片与对话记忆的共同键,不许现编一个)");
  const want = turns.map((t) => (t.question || "").trim());

  // ① 幂等:已经是这份内容 ⇒ 什么都不做(重复打开同一张卡不该把上下文灌成两倍)
  const have = await existingQuestions(conversationId, projectId).catch(() => [] as string[]);
  if (want.length > 0 && isPrefixOf(want, have)) {
    return { backend, cleared: 0, written: 0, skipped: true };
  }

  // ② 清旧
  const cleared = backend === "agentcore"
    ? await clearConversationAgentCore(conversationId, projectId)
    : await clearConversationSelfManaged(conversationId);

  // ③ 按序回灌
  let written = 0;
  if (backend === "agentcore") {
    for (const t of turns) {
      await appendTurnAgentCore(conversationId, t, projectId);
      written += 1;
    }
  } else {
    const ttl = Math.floor(Date.now() / 1000) + TURN_TTL_HOURS * 3600;
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      await docClient.send(new PutCommand({
        TableName: TABLES.GENBI_TURNS,
        Item: {
          conversationId,
          // 🔴 确定性排序键 ⇒ 重复执行是**覆盖**而不是再灌一份;前缀保证它排在后续真实轮次之前。
          ts: `${REPLAY_TS_PREFIX}${String(i).padStart(4, "0")}`,
          question: t.question,
          answer: (t.answer || "").slice(0, 4000),
          sql: t.sql || null,
          replayedFromCard: true,
          ttl,
        },
      }));
      written += 1;
    }
  }
  return { backend, cleared, written, skipped: false };
}

/** 清掉 `bgp-genbi-turns` 里这段对话的全部条目。返回删除条数。 */
async function clearConversationSelfManaged(conversationId: string): Promise<number> {
  const { Items = [] } = await docClient.send(new QueryCommand({
    TableName: TABLES.GENBI_TURNS,
    KeyConditionExpression: "conversationId = :c",
    ExpressionAttributeValues: { ":c": conversationId },
    ProjectionExpression: "conversationId, ts",
  }));
  let n = 0;
  for (let i = 0; i < Items.length; i += 25) {
    const chunk = (Items as { conversationId: string; ts: string }[]).slice(i, i + 25);
    await docClient.send(new BatchWriteCommand({
      RequestItems: { [TABLES.GENBI_TURNS]: chunk.map((k) => ({ DeleteRequest: { Key: { conversationId: k.conversationId, ts: k.ts } } })) },
    }));
    n += chunk.length;
  }
  return n;
}

/** 清掉 AgentCore Memory 里这个会话的全部事件(分页;`DeleteEvent` 要 memoryId + sessionId + actorId + eventId)。 */
async function clearConversationAgentCore(conversationId: string, projectId?: string): Promise<number> {
  const actorId = actorOf(projectId);
  const sessionId = memSession(conversationId);
  let n = 0;
  // 🔴 **不带 nextToken 往下翻**:游标是基于「还没删」的内容算的,边删边翻会跳过条目。
  //    做法 = 每轮都从头列一页、删干净、再列;直到某一轮列出 0 条。
  // 🔴 安全上界:删不掉(权限/服务端拒)时必须**响亮失败**,绝不原地打转 —— 静默死循环会把一次
  //    「打开卡片」变成挂住的请求,而日志里什么都看不出来。
  const MAX_ROUNDS = 50;
  for (let round = 0; ; round++) {
    if (round >= MAX_ROUNDS) {
      throw new Error(
        `清理 AgentCore 会话事件超过 ${MAX_ROUNDS} 轮仍未清空(session=${sessionId},已删 ${n} 条)—— ` +
          `很可能是 DeleteEvent 被拒但没抛(或事件在被清理期间仍在写入);拒绝继续打转`
      );
    }
    const r: { events?: { eventId?: string }[] } = await agentcore.send(new ListEventsCommand({
      memoryId: MEMORY_ID, actorId, sessionId, includePayloads: false, maxResults: 100,
    }));
    const events = r.events || [];
    if (events.length === 0) break;
    for (const ev of events) {
      if (!ev.eventId) continue;
      await agentcore.send(new DeleteEventCommand({ memoryId: MEMORY_ID, actorId, sessionId, eventId: ev.eventId }));
      n += 1;
    }
  }
  return n;
}
