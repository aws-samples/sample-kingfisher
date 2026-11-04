// 🔴🔴 **装配层**:CE 采集器 ↔ v2 存储 ↔ 区卡片 / 对账 ↔ 异常检测 ↔ 签名 ↔ 读路由 —— 兄弟模块之间**一个都不 mock**
// (mock-hygiene-guard 的纪律;lib/finops 原在欠账名单里,本文件补上后从名单删除)。
//
// 只 mock **真外部**:DynamoDB(一张按 pk/sk 存、Query 会翻页的假表)/ Cost Explorer(会翻页的假账单)/
// 执行环境注册表 / 项目守卫 / 告警投递与知识库写入(断言它们收到了什么)。
//
// 判据对应 §⑦:
//   区卡片金额 == CE 按 region 直查 scope=usw2 列表 == 该 target 的成本行 ·
//   未分摊 = 区账单 − Σ归因 v1 旧行存在时总额不变 两区同任务各自基线(只报一区)。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  /** `表名|pk|sk` → item */
  ddb: new Map<string, Record<string, unknown>>(),
  /** CE 假账单:每页一组 [date, service, region, amount] */
  cePages: [] as Array<Array<[string, string, string, number]>>,
  ceCalls: [] as Array<Record<string, any>>,
  targets: {} as Record<string, Record<string, unknown>>,
  events: [] as Array<Record<string, any>>,
  masters: [] as Array<Record<string, any>>,
  /** Query/Scan 每页最多几条(故意很小,逼出翻页) */
  pageSize: 2,
}));

// ── 真外部 ① DynamoDB ──────────────────────────────────────────────────────────
vi.mock("@/lib/aws/dynamodb", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const page = (rows: Array<[string, Record<string, unknown>]>, start: Record<string, unknown> | undefined) => {
    rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    let i = 0;
    if (start) {
      const sk = `${start.pk}|${start.sk}`;
      i = rows.findIndex(([k]) => k.slice(k.indexOf("|") + 1) === sk) + 1;
    }
    const slice = rows.slice(i, i + h.pageSize);
    const last = i + h.pageSize < rows.length ? slice[slice.length - 1][1] : undefined;
    return {
      Items: slice.map(([, v]) => v),
      ...(last ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk } } : {}),
    };
  };
  return {
    ...real,
    docClient: {
      send: vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
        const n = cmd.constructor.name;
        const t = cmd.input.TableName;
        if (n === "GetCommand") return { Item: h.ddb.get(`${t}|${cmd.input.Key.pk}|${cmd.input.Key.sk}`) };
        if (n === "PutCommand") {
          const it = cmd.input.Item;
          const k = `${t}|${it.pk}|${it.sk}`;
          if (cmd.input.ConditionExpression === "attribute_not_exists(pk)" && h.ddb.has(k)) {
            throw Object.assign(new Error("ccf"), { name: "ConditionalCheckFailedException" });
          }
          h.ddb.set(k, it);
          return {};
        }
        if (n === "QueryCommand") {
          const pk = cmd.input.ExpressionAttributeValues[":pk"];
          const rows = [...h.ddb.entries()].filter(([k]) => k.startsWith(`${t}|${pk}|`));
          return page(rows, cmd.input.ExclusiveStartKey);
        }
        if (n === "ScanCommand") {
          const rows = [...h.ddb.entries()].filter(([k]) => k.startsWith(`${t}|`));
          return page(rows, cmd.input.ExclusiveStartKey);
        }
        if (n === "DeleteCommand") throw new Error("🔴 成本链路不许删任何行");
        throw new Error(`假 DDB 未支持 ${n}`);
      }),
    },
  };
});

// ── 真外部 ② Cost Explorer(会翻页)────────────────────────────────────────────────
vi.mock("@aws-sdk/client-cost-explorer", () => {
  class GetCostAndUsageCommand {
    input: Record<string, any>;
    constructor(input: Record<string, any>) {
      this.input = input;
    }
  }
  class CostExplorerClient {
    async send(cmd: GetCostAndUsageCommand) {
      h.ceCalls.push(cmd.input);
      const idx = cmd.input.NextPageToken ? Number(cmd.input.NextPageToken) : 0;
      const groups = h.cePages[idx] ?? [];
      const byDate = new Map<string, Array<{ Keys: string[]; Metrics: Record<string, { Amount: string }> }>>();
      for (const [date, svc, region, amt] of groups) {
        const arr = byDate.get(date) ?? [];
        arr.push({ Keys: region === "" ? [svc] : [svc, region], Metrics: { UnblendedCost: { Amount: String(amt) } } });
        byDate.set(date, arr);
      }
      return {
        ResultsByTime: [...byDate.entries()].map(([d, g]) => ({ TimePeriod: { Start: d }, Groups: g })),
        ...(idx + 1 < h.cePages.length ? { NextPageToken: String(idx + 1) } : {}),
      };
    }
  }
  return { CostExplorerClient, GetCostAndUsageCommand };
});

// ── 真外部 ③ 注册表 / 项目守卫 ───────────────────────────────────────────────────────
vi.mock("@/lib/exec-env/registry", () => ({
  getTargetRaw: vi.fn(async (id: string) => h.targets[id] ?? null),
  descriptorViolation: vi.fn(() => null),
  listTargetsRaw: vi.fn(async () => Object.values(h.targets)),
}));
vi.mock("@/lib/projects/guard", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects/guard")>("@/lib/projects/guard");
  return { ...actual, requireProject: vi.fn(async () => ({ identity: { username: "u" }, projectId: "proj-a", role: "editor" })) };
});

// ── 真外部 ④ 告警投递 / 知识库(断言收到了什么)─────────────────────────────────────
vi.mock("@/lib/alerting/channels", () => ({ listChannels: vi.fn(async () => []), getChannels: vi.fn(async () => []) }));
vi.mock("@/lib/alerting/notify", () => ({ dispatch: vi.fn(async () => ({ status: "sent", results: [] })) }));
vi.mock("@/lib/alerting/events", () => ({
  putEventIfNew: vi.fn(async (e: Record<string, any>) => {
    if (h.events.some((x) => x.dedupeKey === e.dedupeKey)) return null;
    const ev = { ...e, sk: `ev#${h.events.length}` };
    h.events.push(ev);
    return ev;
  }),
  updateEventDelivery: vi.fn(async () => {}),
}));
vi.mock("@/lib/incidents/store", () => ({
  upsertMaster: vi.fn(async (m: Record<string, any>) => {
    h.masters.push(m);
  }),
  putOccurrenceIfNew: vi.fn(async () => true),
}));

import { collectDailyCosts } from "../collector";
import { costDailyPk, upsertCostDaily } from "../store";
import { detectTaskAnomalies, detectServiceAnomalies, settleAnomalies } from "../anomaly";
import { FINOPS_TABLES, WATERMARK_PK, WATERMARK_SK } from "../constants";
import { prevPeriodEnd } from "../region-cost";
import { GET as overviewGET } from "@/app/api/finops/overview/route";
import { GET as tasksGET } from "@/app/api/finops/tasks/route";

const today = new Date().toISOString().slice(0, 10);
const thisMonth = today.slice(0, 7);
const prevSame = prevPeriodEnd(today);
const req = (path: string) => new NextRequest(`https://x.test${path}`);
const json = async (p: Promise<Response>) => (await (await p).json()).data;

function putRun(taskId: string, runId: string, targetId: string | undefined, costUsd: number, finishedAt: string) {
  h.ddb.set(`${FINOPS_TABLES.COST_RUNS}|taskcost#${taskId}|${runId}`, {
    pk: `taskcost#${taskId}`, sk: runId, taskId, runId, engine: "glue", taskType: "etl-glue", usage: {},
    costUsd, priceVersion: "v", startedAt: finishedAt, finishedAt, runStatus: "succeeded",
    ...(targetId ? { projectId: "proj-a", targetId } : {}), ttl: 0,
  });
}

beforeEach(() => {
  process.env.AWS_REGION = "us-east-1";
  h.ddb.clear();
  h.ceCalls.length = 0;
  h.events.length = 0;
  h.masters.length = 0;
  h.pageSize = 2;
  h.targets = {
    tgt_home: { targetId: "tgt_home", region: "us-east-1", ready: true },
    tgt_usw2_a: { targetId: "tgt_usw2_a", region: "us-west-2", ready: true },
  };
  h.cePages = [
    [
      [today, "AWS Glue", "us-east-1", 3],
      [today, "AWS Glue", "us-west-2", 5],
      [prevSame, "AWS Glue", "us-west-2", 4],
    ],
    [
      [today, "Tax", "NoRegion", 2],
      [today, "Amazon Virtual Private Cloud", "us-west-2", 1.25],
      [today, "AWS Support", "", 0.5], // CE 没回 REGION ⇒ 落 NoRegion
    ],
  ];
});

describe("采集 → v2 分区", () => {
  it("🔴 v2 首次采集自动回填:窗口回到上月 1 日(且 ≥30 天),之后回到常规 3 天", async () => {
    const first = await collectDailyCosts();
    expect(first.backfillReason).toBe("v2-first-run");
    const start = h.ceCalls[0].TimePeriod.Start as string;
    const prevMonthStart = `${prevSame.slice(0, 7)}-01`;
    expect(start <= prevMonthStart).toBe(true);
    expect(Date.parse(today) - Date.parse(start)).toBeGreaterThanOrEqual(30 * 86400_000);
    expect(first.ceCalls).toBe(2); // 两页 = 两次计费调用
    h.ceCalls.length = 0;
    const second = await collectDailyCosts();
    expect(second.backfill).toBe(false);
    expect(Date.parse(today) - Date.parse(h.ceCalls[0].TimePeriod.Start)).toBe(3 * 86400_000);
  });

  it("每行落在 `costv2#<month>`、sk 三段;REGION 缺失落 NoRegion;旧水位键不算 v2 已采", async () => {
    h.ddb.set(`${FINOPS_TABLES.COST_DAILY}|${WATERMARK_PK}|watermark#ce-daily`, { pk: WATERMARK_PK, sk: "watermark#ce-daily", value: new Date().toISOString() });
    const r = await collectDailyCosts();
    expect(r.backfillReason).toBe("v2-first-run");
    const keys = [...h.ddb.keys()].filter((k) => k.includes(`|${costDailyPk(thisMonth)}|`));
    expect(keys).toContain(`${FINOPS_TABLES.COST_DAILY}|costv2#${thisMonth}|${today}#AWS Support#NoRegion`);
    expect(keys.every((k) => k.split("|")[2].split("#").length === 3)).toBe(true);
  });

  it("🔴 v2 写侧对空 region fail-closed(绝不退回两段 sk)", async () => {
    await expect(upsertCostDaily({ date: today, service: "X", region: " ", category: "other", amountUsd: 1, collectedAt: "" })).rejects.toThrow(/缺 region/);
  });
});

describe("大盘区卡片(O3a)", () => {
  beforeEach(async () => {
    await collectDailyCosts();
  });

  it("🔴 区卡片本月累计 == CE 按 region 求和;全局服务单独一张,不进任何区", async () => {
    const d = await json(overviewGET(req("/api/finops/overview")));
    const card = (r: string) => d.byRegion.find((c: any) => c.region === r);
    expect(card("us-west-2").monthToDateUsd).toBeCloseTo(6.25, 6);
    expect(card("us-east-1").monthToDateUsd).toBeCloseTo(3, 6);
    expect(d.byRegion.map((c: any) => c.region)).toEqual(["us-west-2", "us-east-1"]); // 降序
    expect(d.regionlessMonthToDateUsd).toBeCloseTo(2.5, 6);
    // 环比:上月同期 us-west-2 = 4 ⇒ (6.25 − 4) / 4 = +56.25%;us-east-1 上月同期无数据 ⇒ null
    if (prevSame.slice(0, 7) !== thisMonth) {
      expect(card("us-west-2").momPct).toBeCloseTo(56.25, 6);
    }
    expect(card("us-east-1").momPct).toBeNull();
  });

  it("🔴 全部视角(不带 ?scope=)的合计 == 全部账单 —— 原实现在这里恒为 0", async () => {
    const d = await json(overviewGET(req("/api/finops/overview")));
    expect(d.monthToDateUsd).toBeCloseTo(3 + 5 + 2 + 1.25 + 0.5, 6);
    expect(d.scopedRegions).toBeUndefined();
  });

  it("单区视角:只给该区卡片,合计只含该区;全局服务如实报成未计入", async () => {
    const d = await json(overviewGET(req("/api/finops/overview?scope=tgt_usw2_a")));
    expect(d.byRegion.map((c: any) => c.region)).toEqual(["us-west-2"]);
    expect(d.monthToDateUsd).toBeCloseTo(6.25, 6);
    expect(d.unattributedUsd).toBeCloseTo(2.5, 6);
    expect(d.regionlessMonthToDateUsd).toBe(0);
  });

  it("🔴 旧分区 `cost#<month>` 里的旧格式行存在时,总额不变(读侧只读 v2)", async () => {
    const before = await json(overviewGET(req("/api/finops/overview")));
    for (const [sk, extra] of [[`${today}#AWS Glue`, {}], [`${today}#AWS Glue#us-west-2`, { region: "us-west-2" }]] as const) {
      h.ddb.set(`${FINOPS_TABLES.COST_DAILY}|cost#${thisMonth}|${sk}`, {
        pk: `cost#${thisMonth}`, sk, date: today, service: "AWS Glue", category: "engine", amountUsd: 999, collectedAt: "", ...extra,
      });
    }
    const after = await json(overviewGET(req("/api/finops/overview")));
    expect(after.monthToDateUsd).toBeCloseTo(before.monthToDateUsd, 9);
    expect(after.byRegion).toEqual(before.byRegion);
  });

  it("翻页:v2 一个月的行多于一页时一行不丢", async () => {
    h.pageSize = 1;
    const d = await json(overviewGET(req("/api/finops/overview")));
    expect(d.monthToDateUsd).toBeCloseTo(11.75, 6);
  });
});

describe("任务成本按区(O3b)", () => {
  beforeEach(async () => {
    await collectDailyCosts();
    const t = new Date().toISOString();
    putRun("t1", "r1", "tgt_home", 1, t);
    putRun("t1", "r2", "tgt_usw2_a", 2, t);
    putRun("t2", "r3", "tgt_usw2_a", 0.5, t);
  });

  it("scope=tgt_usw2_a 的列表 == targetId=tgt_usw2_a 的成本行集合", async () => {
    const d = await json(tasksGET(req("/api/finops/tasks?scope=tgt_usw2_a")));
    expect(d.items.map((i: any) => `${i.taskId}@${i.targetId}`).sort()).toEqual(["t1@tgt_usw2_a", "t2@tgt_usw2_a"]);
  });

  it("🔴 未分摊 = 区账单(CE)− Σ该区归因(DDB)", async () => {
    const d = await json(tasksGET(req("/api/finops/tasks?scope=tgt_usw2_a")));
    expect(d.reconcile.byRegion).toHaveLength(1);
    const r = d.reconcile.byRegion[0];
    expect(r.region).toBe("us-west-2");
    expect(r.attributedUsd).toBeCloseTo(2.5, 6);
    // 账单窗口 = 近 30 天(含上月同期那一天若落在窗口内)
    const inWindow = prevSame >= d.reconcile.windowFrom ? 5 + 1.25 + 4 : 5 + 1.25;
    expect(r.regionCostUsd).toBeCloseTo(inWindow, 6);
    expect(r.unallocatedUsd).toBeCloseTo(inWindow - 2.5, 6);
  });
});

describe("异常检测按 (task, target)", () => {
  /**
   * 造数:同一任务 T 在两个区各跑 8 次 —— 主控区每次 $1,us-west-2 每次 $10(两区本来就不一样贵)。
   * 主控区最后一次涨到 $5(真突增);us-west-2 最后一次 $10(完全正常)。
   * 正确:只报主控区。池化(去掉 target 维)⇒ 基线被 $1 与 $10 混在一起,至少有一个区判错。
   */
  beforeEach(() => {
    const base = Date.now() - 20 * 86400_000;
    for (let i = 0; i < 8; i++) {
      putRun("T", `h${i}`, "tgt_home", 1, new Date(base + i * 3600_000).toISOString());
      putRun("T", `w${i}`, "tgt_usw2_a", 10, new Date(base + i * 3600_000 + 60_000).toISOString());
    }
    putRun("T", "h9", "tgt_home", 5, new Date(base + 10 * 3600_000).toISOString());
    putRun("T", "w9", "tgt_usw2_a", 10, new Date(base + 11 * 3600_000).toISOString());
  });

  it("🔴 两区同任务各自基线:造一区突增只报那一区", async () => {
    const out = await detectTaskAnomalies();
    expect(out.map((a) => (a.scope === "task" ? a.targetId : "?"))).toEqual(["tgt_home"]);
    expect(out[0].baselineUsd).toBe(1);
  });

  it("🔴 闭环:告警事件盖区章、去重键与知识库签名都带区(两区事件不互相吞)", async () => {
    const out = await settleAnomalies(await detectTaskAnomalies());
    expect(out).toHaveLength(1);
    expect(h.events[0].trigger.targetId).toBe("tgt_home");
    expect(h.events[0].dedupeKey).toContain("#tgt_home#");
    expect(h.masters[0].signature).toMatch(/_AT_[0-9A-F]{8}$/);
  });
});

describe("服务级异常按 (service, region)", () => {
  /**
   * 两区同服务:主控区每天 $1(昨天也 $1,正常);us-west-2 每天 $1、昨天 $5(真突增)。
   * 池化(去掉 region 维)⇒ 「昨天」只取到排在前面的主控区那一行 ⇒ us-west-2 的突增**漏报**。
   */
  it("🔴 两区同服务各自基线:只报真突增的那一区;单区视角不含全局服务", async () => {
    const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
    for (let n = 1; n <= 9; n++) {
      await upsertCostDaily({ date: day(n), service: "AWS Glue", region: "us-east-1", category: "engine", amountUsd: 1, collectedAt: "" });
      await upsertCostDaily({ date: day(n), service: "AWS Glue", region: "us-west-2", category: "engine", amountUsd: n === 1 ? 5 : 1, collectedAt: "" });
      await upsertCostDaily({ date: day(n), service: "Tax", region: "NoRegion", category: "other", amountUsd: n === 1 ? 50 : 1, collectedAt: "" });
    }
    const tag = (xs: Awaited<ReturnType<typeof detectServiceAnomalies>>) =>
      xs.map((a) => (a.scope === "service" ? `${a.key}@${a.region}` : "?")).sort();
    expect(tag(await detectServiceAnomalies())).toEqual(["AWS Glue@us-west-2", "Tax@NoRegion"]);
    expect(tag(await detectServiceAnomalies({ regions: new Set(["us-west-2"]) }))).toEqual(["AWS Glue@us-west-2"]);
    expect(tag(await detectServiceAnomalies({ regions: new Set(["us-east-1"]) }))).toEqual([]);
  });
});

describe("装配层自检", () => {
  it("v2 水位键与旧键不同(否则升级后不触发首次回填)", () => {
    expect(WATERMARK_SK.CE_DAILY).not.toBe("watermark#ce-daily");
  });
});
