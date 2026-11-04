// 🔴 问数必须校验项目成员资格(原来项目号直接取请求头、身份吞成 null ⇒ 改个头就能查别的项目)。
//   requireProject 走真实实现;只 mock 真外部:身份解析(一个非管理员)、成员表查询(按传入的
//   用户名 + 项目号查夹具,不编返回值)、问数执行体 / 卡片存储(记下收到的参数)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  members: { "proj-a": { u1: "viewer" } } as Record<string, Record<string, string>>,
  asks: [] as Array<Record<string, unknown>>,
  saves: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/auth/identity", async (orig) => {
  const real: any = await orig();
  const who = { sub: "sub-u1", username: "u1", groups: [], isPlatformAdmin: false, isManager: false, isDeveloper: false };
  return { ...real, resolveIdentity: vi.fn(async () => who), requireIdentity: vi.fn(async () => who) };
});
vi.mock("@/lib/projects/project-service", async (orig) => {
  const real: any = await orig();
  return { ...real, resolveRole: vi.fn(async (id: { username: string }, pid: string) => (h.members[pid] || {})[id.username] ?? null) };
});
vi.mock("@/lib/genbi/execute", () => ({
  executeGenBiAsk: vi.fn(async (a: Record<string, unknown>) => { h.asks.push(a); return { result: { answer: "ok" }, usedBackend: "x", targetId: a.targetId }; }),
  persistGenBiSideEffects: vi.fn(),
}));
vi.mock("@/lib/genbi/tasks", () => ({ createTask: vi.fn(async (a: Record<string, unknown>) => { h.asks.push(a); return "t1"; }) }));
vi.mock("@/lib/genbi/cards-service", async (orig) => {
  const real: any = await orig();
  return { ...real, saveCard: vi.fn(async (a: Record<string, unknown>) => { h.saves.push(a); return { cardId: "c1" }; }) };
});

// 一个**伪造**的 JWT(sub = 别人):原来 getUserId 不验签就信它。
const forged = `x.${Buffer.from(JSON.stringify({ sub: "sub-victim" })).toString("base64")}.y`;
const call = async (mod: string, body: Record<string, unknown>, project: string) => {
  const m: any = await import(mod);
  const { NextRequest } = await import("next/server");
  const res = await m.POST(new NextRequest("http://x/api/genbi", {
    method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "x-bgp-project": project, authorization: `Bearer ${forged}` },
  }));
  return { status: res.status, body: await res.json() };
};

beforeEach(() => { h.asks.length = 0; h.saves.length = 0; delete process.env.GENBI_ASYNC; vi.resetModules(); });

describe("🔴 问数提问 POST /api/genbi/ask", () => {
  it("请求头指向**不是成员**的项目 ⇒ 403,一次查询都没发起", async () => {
    const r = await call("../ask/route", { question: "q", targetId: "tgt_home" }, "proj-b");
    expect(r.status).toBe(403);
    expect(h.asks).toEqual([]);
  });
  it("正控制:成员 ⇒ 放行;项目号来自校验结果,用户号是校验过的 sub(不是伪造 token 里的)", async () => {
    const r = await call("../ask/route", { question: "q", targetId: "tgt_home" }, "proj-a");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]).toMatchObject({ projectId: "proj-a", userId: "sub-u1" });
  });
  it("异步模式同样校验(建任务前就拒)", async () => {
    process.env.GENBI_ASYNC = "1";
    expect((await call("../ask/route", { question: "q", targetId: "tgt_home" }, "proj-b")).status).toBe(403);
    expect(h.asks).toEqual([]);
  });
});

describe("🔴 存问数卡片 POST /api/genbi/cards", () => {
  it("非成员 ⇒ 403,不落库", async () => {
    const r = await call("../cards/route", { conversationId: "cv", targetId: "tgt_home", turns: [] }, "proj-b");
    expect(r.status).toBe(403);
    expect(h.saves).toEqual([]);
  });
  it("正控制:成员 ⇒ 落库,卡片归属 = 校验过的 sub", async () => {
    await call("../cards/route", { conversationId: "cv", targetId: "tgt_home", turns: [] }, "proj-a");
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]).toMatchObject({ userSub: "sub-u1", projectId: "proj-a" });
  });
});
