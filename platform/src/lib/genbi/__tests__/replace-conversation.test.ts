// @kf-batch 54-genbi-session-cards
// 打开会话卡片时**重建短期记忆**的单测(54 DESIGN v1.2 §3.3)。
// 两条后端各测一遍:selfmanaged(`bgp-genbi-turns`)与 agentcore(托管会话事件)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const hooks = vi.hoisted(() => ({
  agentcore: true,             // isAgentCoreMemory() 的开关
  events: [] as { eventId: string; q: string; a: string }[],
  deleteFails: false,
  listCalls: 0,
}));

// 内存版 bgp-genbi-turns:key = `${conversationId}|${ts}`
const turnsTable = new Map<string, any>();

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { GENBI_TURNS: "bgp-genbi-turns" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const i = cmd.input;
      if (i.RequestItems) {
        const reqs = i.RequestItems["bgp-genbi-turns"] || [];
        for (const r of reqs) {
          const k = r.DeleteRequest.Key;
          turnsTable.delete(`${k.conversationId}|${k.ts}`);
        }
        return {};
      }
      if (i.Item) { turnsTable.set(`${i.Item.conversationId}|${i.Item.ts}`, { ...i.Item }); return {}; }
      if (i.KeyConditionExpression) {
        const c = i.ExpressionAttributeValues[":c"];
        const rows = Array.from(turnsTable.values()).filter((r) => r.conversationId === c)
          .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
        return i.Select === "COUNT" ? { Count: rows.length } : { Items: rows };
      }
      throw new Error("mock 不认识这个 DDB 命令");
    }),
  },
}));

// AgentCore:CreateEvent / ListEvents / DeleteEvent 三个都在内存里实现语义
vi.mock("@aws-sdk/client-bedrock-agentcore", () => {
  class Cmd { constructor(public input: any) {} }
  return {
    BedrockAgentCoreClient: class {
      async send(cmd: any) {
        const n = cmd.constructor.name;
        if (n === "CreateEventCommand") {
          const payload = cmd.input.payload || [];
          hooks.events.push({
            eventId: `ev-${hooks.events.length}-${Math.random().toString(36).slice(2, 6)}`,
            q: payload[0]?.conversational?.content?.text || "",
            a: payload[1]?.conversational?.content?.text || "",
          });
          return {};
        }
        if (n === "ListEventsCommand") {
          hooks.listCalls += 1;
          return {
            events: hooks.events.map((e, idx) => ({
              eventId: e.eventId,
              eventTimestamp: new Date(1700000000000 + idx * 1000),
              payload: [
                { conversational: { role: "USER", content: { text: e.q } } },
                { conversational: { role: "ASSISTANT", content: { text: e.a } } },
              ],
            })),
          };
        }
        if (n === "DeleteEventCommand") {
          if (hooks.deleteFails) return {}; // 假装删了(服务端静默不生效)⇒ 必须撞上界并抛
          hooks.events = hooks.events.filter((e) => e.eventId !== cmd.input.eventId);
          return {};
        }
        if (n === "RetrieveMemoryRecordsCommand") return { memoryRecordSummaries: [] };
        throw new Error(`mock 不认识 ${n}`);
      }
    },
    CreateEventCommand: class extends Cmd {},
    ListEventsCommand: class extends Cmd {},
    DeleteEventCommand: class extends Cmd {},
    RetrieveMemoryRecordsCommand: class extends Cmd {},
  };
});
vi.mock("@aws-sdk/client-s3", () => {
  class Cmd { constructor(public input: any) {} }
  return { S3Client: class { async send() { return {}; } }, PutObjectCommand: class extends Cmd {}, GetObjectCommand: class extends Cmd {}, ListObjectsV2Command: class extends Cmd {} };
});
vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  class Cmd { constructor(public input: any) {} }
  return { BedrockRuntimeClient: class { async send() { return {}; } }, ConverseCommand: class extends Cmd {} };
});
vi.mock("@/lib/ai/invoke", () => ({ invokeConverse: vi.fn(async () => ({ response: { output: { message: { content: [] } } } })) }));

const CONV = "conv-1757600000000-abcd1234";
const turn = (q: string) => ({ question: q, answer: `答:${q}`, sql: `select /* ${q} */ 1` });

beforeEach(() => {
  turnsTable.clear();
  hooks.events = [];
  hooks.deleteFails = false;
  hooks.listCalls = 0;
  process.env.GENBI_MEMORY_BACKEND = "selfmanaged";
  delete process.env.GENBI_MEMORY_ID;
  vi.resetModules();
});

async function mod() {
  return await import("../memory");
}

describe("54 会话卡片 · 打开时覆盖式重建短期记忆", () => {
  it("conversationId 缺失 ⇒ 抛(它是卡片与记忆的共同键,不许现编)", async () => {
    const m = await mod();
    await expect(m.replaceConversation("", [turn("a")])).rejects.toThrow(/conversationId/);
  });

  it("selfmanaged:回灌后能按序读回,且排序键前缀排在真实时间戳之前(历史在前、新问在后)", async () => {
    const m = await mod();
    const r = await m.replaceConversation(CONV, [turn("按地区统计客户数"), turn("那按分类呢")]);
    expect(r.backend).toBe("selfmanaged");
    expect(r.written).toBe(2);
    expect(r.skipped).toBe(false);

    const got = await m.loadShortTerm(CONV, "proj-default", 50);
    expect(got.map((t) => t.question)).toEqual(["按地区统计客户数", "那按分类呢"]);
    // 回灌键必须排在真实 ISO 时间戳(以 2 开头)之前
    const keys = Array.from(turnsTable.values()).map((r2) => r2.ts);
    expect(keys.every((k: string) => k.startsWith(m.REPLAY_TS_PREFIX))).toBe(true);
    expect(m.REPLAY_TS_PREFIX < "2026-01-01T00:00:00.000Z").toBe(true);

    // 之后真实追问一轮 ⇒ 它排在回灌历史之后
    await m.appendTurn(CONV, turn("那按商品呢"), "proj-default");
    const after = await m.loadShortTerm(CONV, "proj-default", 50);
    expect(after.map((t) => t.question)).toEqual(["按地区统计客户数", "那按分类呢", "那按商品呢"]);
  });

  it("🔴 幂等:重复打开同一张卡不许把上下文灌成两倍", async () => {
    const m = await mod();
    await m.replaceConversation(CONV, [turn("q1"), turn("q2")]);
    const r2 = await m.replaceConversation(CONV, [turn("q1"), turn("q2")]);
    expect(r2.skipped).toBe(true);
    expect(r2.written).toBe(0);
    expect((await m.loadShortTerm(CONV, "proj-default", 50)).length).toBe(2);
  });

  it("🔴🔴 用户续聊之后再触发一次 resume:**不许清掉他刚问的那几轮**(卡片轮次是现存对话的前缀 ⇒ 跳过)", async () => {
    const m = await mod();
    await m.replaceConversation(CONV, [turn("q1"), turn("q2")]);
    // ⏱ 两次 append 之间留 2ms:`appendTurn` 的排序键是 `<ISO 毫秒>#<随机>`,同一毫秒内的两条
    //    先后由随机后缀决定(真实场景两次提问隔几秒,碰不上;测试里不留间隔会假红)。
    await m.appendTurn(CONV, turn("q3-用户自己问的"), "proj-default");
    await new Promise((r) => setTimeout(r, 2));
    await m.appendTurn(CONV, turn("q4-用户自己问的"), "proj-default");
    const r = await m.replaceConversation(CONV, [turn("q1"), turn("q2")]);
    expect(r.skipped, "判「完全相等」就会走清理重灌,把 q3/q4 的上下文抹掉").toBe(true);
    const got = await m.loadShortTerm(CONV, "proj-default", 50);
    expect(got.map((t) => t.question)).toEqual(["q1", "q2", "q3-用户自己问的", "q4-用户自己问的"]);
  });

  it("🔴 覆盖式:卡片内容变了(前缀不匹配)⇒ 清旧 + 重灌,不留残渣", async () => {
    const m = await mod();
    await m.replaceConversation(CONV, [turn("旧问题1"), turn("旧问题2"), turn("旧问题3")]);
    const r = await m.replaceConversation(CONV, [turn("新问题1"), turn("新问题2")]);
    expect(r.skipped).toBe(false);
    expect(r.cleared).toBe(3);
    expect(r.written).toBe(2);
    const got = await m.loadShortTerm(CONV, "proj-default", 50);
    expect(got.map((t) => t.question)).toEqual(["新问题1", "新问题2"]);
    expect(Array.from(turnsTable.values()).length).toBe(2); // 旧的三条真没了
  });

  it("回灌的条目带 TTL 与来源标记(排障时分得清「回灌的」与「真问的」)", async () => {
    const m = await mod();
    await m.replaceConversation(CONV, [turn("q1")]);
    const row = Array.from(turnsTable.values())[0];
    expect(row.replayedFromCard).toBe(true);
    expect(typeof row.ttl).toBe("number");
    expect(row.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("agentcore:先删后写,读回顺序正确", async () => {
    process.env.GENBI_MEMORY_BACKEND = "agentcore";
    process.env.GENBI_MEMORY_ID = "mem-abc";
    vi.resetModules();
    const m = await mod();
    hooks.events = [{ eventId: "old-1", q: "陈旧问题", a: "陈旧答案" }];
    const r = await m.replaceConversation(CONV, [turn("q1"), turn("q2")]);
    expect(r.backend).toBe("agentcore");
    expect(r.cleared).toBe(1);
    expect(r.written).toBe(2);
    expect(hooks.events.map((e) => e.q)).toEqual(["q1", "q2"]);
  });

  it("agentcore 幂等:内容相同 ⇒ 一个事件都不动", async () => {
    process.env.GENBI_MEMORY_BACKEND = "agentcore";
    process.env.GENBI_MEMORY_ID = "mem-abc";
    vi.resetModules();
    const m = await mod();
    await m.replaceConversation(CONV, [turn("q1"), turn("q2")]);
    const before = hooks.events.map((e) => e.eventId);
    const r = await m.replaceConversation(CONV, [turn("q1"), turn("q2")]);
    expect(r.skipped).toBe(true);
    expect(hooks.events.map((e) => e.eventId)).toEqual(before);
  });

  it("🔴 agentcore:DeleteEvent 静默不生效 ⇒ 撞上界**抛出**,绝不原地死循环", async () => {
    process.env.GENBI_MEMORY_BACKEND = "agentcore";
    process.env.GENBI_MEMORY_ID = "mem-abc";
    vi.resetModules();
    const m = await mod();
    hooks.events = [{ eventId: "stuck-1", q: "删不掉", a: "x" }];
    hooks.deleteFails = true;
    await expect(m.replaceConversation(CONV, [turn("q1")])).rejects.toThrow(/超过 50 轮仍未清空/);
    expect(hooks.listCalls).toBeLessThan(60); // 有上界,不是无限翻
  });
});
