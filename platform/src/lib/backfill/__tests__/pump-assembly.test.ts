// 🔴 装配层:泵 + 「哪些计划要推」的读法**一起**跑(只 mock 真外部:DDB / fetch)。
// 判据钉的是用户能感知的事实:**页面没开,未收口的计划也会被推进**;已收口的不碰;不是选主副本 / 停泵 / 缺密钥都真的不跑。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, scans: 0 }));
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    docClient: {
      send: async (c: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (c.constructor.name !== "ScanCommand") throw new Error("泵只许发 Scan:" + c.constructor.name);
        h.scans++;
        // 两页:验证翻页真的翻了
        const start = Number((c.input.ExclusiveStartKey as { i?: number } | undefined)?.i ?? 0);
        const page = h.rows.slice(start, start + 2);
        const next = start + 2 < h.rows.length ? { i: start + 2 } : undefined;
        return { Items: page, ...(next ? { LastEvaluatedKey: next } : {}) };
      },
    },
  };
});

const { runBackfillPumpTick, BACKFILL_TICK_ENDPOINT_PATH } = await import("@/lib/backfill/pump");
const { INTERNAL_KEY_HEADER, INTERNAL_SOURCE_HEADER, INTERNAL_SOURCE_BACKFILL_PUMP, INTERNAL_SOURCES } = await import(
  "@/lib/scheduler/internal-source"
);

let posted: Array<{ url: string; headers: Record<string, string>; body: { projectId: string; planId: string } }> = [];
let status = 200;
const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
  posted.push({ url, headers: init.headers, body: JSON.parse(init.body) });
  return { ok: status < 300, status } as Response;
}) as unknown as typeof fetch;
const deps = (over: Record<string, unknown> = {}) => ({
  isLeader: () => true,
  fetchImpl,
  loadKey: async () => "k-1",
  baseUrl: "http://self:3000",
  ...over,
});

beforeEach(() => {
  h.rows = [
    { projectId: "proj-a", planId: "01B", status: "running" },
    { projectId: "proj-a", planId: "01A", status: "planned" },
    { projectId: "proj-b", planId: "01C", status: "paused" }, // 暂停也要推:在途实例的终态回收
    { projectId: "proj-b", planId: "01D", status: "succeeded" },
    { projectId: "proj-b", planId: "01E", status: "cancelled" },
  ];
  h.scans = 0;
  posted = [];
  status = 200;
  delete process.env.BGP_BACKFILL_PUMP_PAUSED;
});

describe("🔴 补数后台推进泵", () => {
  it("未收口(planned / running / paused)的计划逐个回环推进,按创建先后;已收口的不碰;翻页翻到底", async () => {
    const s = await runBackfillPumpTick(deps());
    expect(s).toMatchObject({ ran: true, open: 3, posted: 3, failed: 0 });
    expect(h.scans).toBe(3);
    expect(posted.map((p) => p.body)).toEqual([
      { projectId: "proj-a", planId: "01A" },
      { projectId: "proj-a", planId: "01B" },
      { projectId: "proj-b", planId: "01C" },
    ]);
    for (const p of posted) {
      expect(p.url).toBe(`http://self:3000${BACKFILL_TICK_ENDPOINT_PATH}`);
      expect(p.headers[INTERNAL_SOURCE_HEADER]).toBe(INTERNAL_SOURCE_BACKFILL_PUMP);
      expect(p.headers[INTERNAL_KEY_HEADER]).toBe("k-1");
    }
  });
  it("来源已登记进封闭集合(否则中间件就拦了,泵永远敲不开)", () => {
    expect(INTERNAL_SOURCES).toContain(INTERNAL_SOURCE_BACKFILL_PUMP);
  });
  it("不是选主副本 ⇒ 一次 Scan 都不发", async () => {
    const s = await runBackfillPumpTick(deps({ isLeader: () => false }));
    expect(s).toMatchObject({ ran: false, skipped: "not-leader" });
    expect(h.scans).toBe(0);
    expect(posted).toHaveLength(0);
  });
  it("停泵开关 ⇒ 不跑", async () => {
    process.env.BGP_BACKFILL_PUMP_PAUSED = "1";
    expect(await runBackfillPumpTick(deps())).toMatchObject({ ran: false, skipped: "paused" });
    expect(h.scans).toBe(0);
  });
  it("读不到内部密钥 ⇒ 不跑(不带空密钥去敲)", async () => {
    expect(await runBackfillPumpTick(deps({ loadKey: async () => "" }))).toMatchObject({ ran: false, skipped: "no-key" });
    expect(posted).toHaveLength(0);
  });
  it("端点 5xx 计失败;404(计划刚删)不计失败", async () => {
    status = 500;
    expect(await runBackfillPumpTick(deps())).toMatchObject({ posted: 0, failed: 3 });
    posted = [];
    status = 404;
    expect(await runBackfillPumpTick(deps())).toMatchObject({ posted: 3, failed: 0 });
  });
});
