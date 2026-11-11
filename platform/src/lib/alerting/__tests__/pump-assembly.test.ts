// 🔴 装配层:泵 + 「哪些项目要评估」的读法**一起**跑(只 mock 真外部:DDB / fetch)。
// 判据钉的是用户能感知的事实:**没人点「立即评估」,每个项目也会被后台评估**;不是选主副本 / 停泵 / 缺密钥都真的不跑;
// 泵侧不碰评估器(它在 instrumentation 的可达面上)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, queries: 0 }));
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    docClient: {
      send: async (c: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (c.constructor.name !== "QueryCommand") throw new Error("泵只许发 Query:" + c.constructor.name);
        expect(c.input.TableName).toBe((real.TABLES as Record<string, string>).PROJECTS);
        h.queries++;
        // 两页:验证翻页真的翻了
        const start = Number((c.input.ExclusiveStartKey as { i?: number } | undefined)?.i ?? 0);
        const page = h.rows.slice(start, start + 2);
        const next = start + 2 < h.rows.length ? { i: start + 2 } : undefined;
        return { Items: page, ...(next ? { LastEvaluatedKey: next } : {}) };
      },
    },
  };
});

const { runAlertingPumpTick, ALERTING_TICK_ENDPOINT_PATH, ALERTING_PUMP_INTERVAL_MS } = await import("@/lib/alerting/pump");
const { INTERNAL_KEY_HEADER, INTERNAL_SOURCE_HEADER, INTERNAL_SOURCE_ALERTING_PUMP, INTERNAL_SOURCES } = await import(
  "@/lib/scheduler/internal-source"
);
const { ALERTING_PUMP_INTERVAL_MS: FROM_TYPES } = await import("@/lib/alerting/types");

let posted: Array<{ url: string; headers: Record<string, string>; body: { projectId: string } }> = [];
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
    { projectId: "proj-b" },
    { projectId: "proj-default" },
    { projectId: "proj-a" },
  ];
  h.queries = 0;
  posted = [];
  status = 200;
  delete process.env.BGP_ALERTING_PUMP_PAUSED;
});

describe("🔴 告警 / SLA 后台评估泵", () => {
  it("每个项目逐个回环评估(字典序稳定),头带来源与密钥;翻页翻到底", async () => {
    const s = await runAlertingPumpTick(deps());
    expect(s).toMatchObject({ ran: true, projects: 3, posted: 3, failed: 0 });
    expect(h.queries).toBe(2);
    expect(posted.map((p) => p.body)).toEqual([{ projectId: "proj-a" }, { projectId: "proj-b" }, { projectId: "proj-default" }]);
    for (const p of posted) {
      expect(p.url).toBe(`http://self:3000${ALERTING_TICK_ENDPOINT_PATH}`);
      expect(p.headers[INTERNAL_SOURCE_HEADER]).toBe(INTERNAL_SOURCE_ALERTING_PUMP);
      expect(p.headers[INTERNAL_KEY_HEADER]).toBe("k-1");
    }
  });
  it("来源已登记进封闭集合(否则中间件就拦了,泵永远敲不开)", () => {
    expect(INTERNAL_SOURCES).toContain(INTERNAL_SOURCE_ALERTING_PUMP);
  });
  it("周期只有一个作者:泵 re-export 的就是 types.ts 那一份(页面文案按它换算)", () => {
    expect(ALERTING_PUMP_INTERVAL_MS).toBe(FROM_TYPES);
    expect(ALERTING_PUMP_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);
  });
  it("不是选主副本 ⇒ 一次 Query 都不发", async () => {
    const s = await runAlertingPumpTick(deps({ isLeader: () => false }));
    expect(s).toMatchObject({ ran: false, skipped: "not-leader" });
    expect(h.queries).toBe(0);
    expect(posted).toHaveLength(0);
  });
  it("停泵开关 ⇒ 不跑(页面「立即评估」不受影响,它不经泵)", async () => {
    process.env.BGP_ALERTING_PUMP_PAUSED = "1";
    expect(await runAlertingPumpTick(deps())).toMatchObject({ ran: false, skipped: "paused" });
    expect(h.queries).toBe(0);
  });
  it("读不到内部密钥 ⇒ 不跑(不带空密钥去敲)", async () => {
    expect(await runAlertingPumpTick(deps({ loadKey: async () => "" }))).toMatchObject({ ran: false, skipped: "no-key" });
    expect(posted).toHaveLength(0);
  });
  it("端点 5xx 计失败;404(项目刚删)不计失败", async () => {
    status = 500;
    expect(await runAlertingPumpTick(deps())).toMatchObject({ posted: 0, failed: 3 });
    posted = [];
    status = 404;
    expect(await runAlertingPumpTick(deps())).toMatchObject({ posted: 3, failed: 0 });
  });
  it("🔴 泵侧零执行器 import(它在 instrumentation 可达面上):不许碰评估器 / 基线 / 通道", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/lib/alerting/pump.ts"), "utf8");
    for (const banned of ["@/lib/alerting/tick", "@/lib/alerting/evaluate", "@/lib/baseline/", "@/lib/alerting/notify", "@/lib/diagnostics"]) {
      expect(src, `pump.ts 不许 import ${banned}`).not.toContain(`from "${banned}`);
    }
  });
});
