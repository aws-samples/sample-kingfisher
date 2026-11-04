// 跨地域元数据镜像的门禁(50 SPEC §3.13 / INTERACTION §4quater)。
//
// 🔴 这一组防的**不是"算不出数"**,是三类"看起来正常":
//   ① 用**过期镜像**画出实时绿灯(DDB 的 TTL 删除最长滞后 48h ⇒ 过期 item 照样会被 Query 返回);
//   ② **部分失败**被总数吞掉(一个来源挂了却显示"资产 0" = 那个区看起来很干净);
//   ③ 定时的 glue 刷新把**手动采的数仓目录条目**顺手删干净(界面上表现为"数仓目录莫名消失")。
//
// 🔴 判据尽量走**全管道**(`buildMirrorOverview` / `mirrorMetadata`),不只测纯函数 ——
//    W3-d2 的 M116 就是被"纯函数对了、管道里没接上"骗过一次(残留态压根没传到看板)。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  /** 假 DDB:pk#sk → item */
  store: new Map<string, Record<string, any>>(),
  /** 记录每一次写请求,用来断言"删了什么/没删什么" */
  writes: [] as Array<{ kind: "put" | "delete"; pk: string; sk: string }>,
  active: [] as Array<{ targetId: string; region: string; jurisdiction?: string }>,
  activeThrows: false,
  queryThrows: false,
  glueDatabases: [] as Array<{ Name: string }>,
  glueTables: {} as Record<string, Array<{ Name: string; StorageDescriptor?: { Columns?: Array<{ Name: string; Type: string }> } }>>,
  glueThrows: false,
  /** 这些库的 GetTables 抛错(LakeFormation 只授了部分库的形态) */
  glueTablesThrow: new Set<string>(),
}));

const key = (pk: string, sk: string) => `${pk} ${sk}`;

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { METADATA_MIRROR: "bgp-metadata-mirror" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const name = cmd?.constructor?.name || "";
      const input = cmd?.input ?? {};
      if (name.startsWith("Get")) {
        const k = key(input.Key.pk, input.Key.sk);
        return { Item: h.store.get(k) };
      }
      if (name.startsWith("Query")) {
        if (h.queryThrows) throw new Error("镜像表读失败(注入)");
        const pk = input.ExpressionAttributeValues[":p"];
        const prefix = input.ExpressionAttributeValues[":k"];
        const items = Array.from(h.store.values()).filter(
          (it) => it.pk === pk && (!prefix || String(it.sk).startsWith(prefix))
        );
        return { Items: items };
      }
      if (name.startsWith("BatchWrite")) {
        for (const [, reqs] of Object.entries(input.RequestItems as Record<string, any[]>)) {
          for (const r of reqs) {
            if (r.PutRequest) {
              const it = r.PutRequest.Item;
              h.store.set(key(it.pk, it.sk), it);
              h.writes.push({ kind: "put", pk: it.pk, sk: it.sk });
            } else if (r.DeleteRequest) {
              const k = r.DeleteRequest.Key;
              h.store.delete(key(k.pk, k.sk));
              h.writes.push({ kind: "delete", pk: k.pk, sk: k.sk });
            }
          }
        }
        return { UnprocessedItems: {} };
      }
      throw new Error(`未预期的命令:${name}`);
    }),
  },
}));

vi.mock("@/lib/exec-env/registry", () => ({
  listActiveTargets: vi.fn(async () => {
    if (h.activeThrows) throw new Error("注册表读失败(注入)");
    return h.active;
  }),
  // 🔴 打桩只到**注册表读**这一层:`regionOfTarget` 走**真实**实现(轻量层 `target-region.ts`)——
  //    W3-e 把它从 `data-plane-target` 搬到轻量层是为了切断 edge bundle 的可达性,
  //    如果这里把 `regionOfTarget` 整个 mock 掉,那次搬移的正确性就一条测试都覆盖不到。
  getTargetRaw: vi.fn(async (t: string) => ({
    targetId: t,
    region: t === "tgt_home" ? "us-east-1" : "us-west-2",
  })),
}));

vi.mock("@/lib/exec-env/target-clients", () => ({
  glueClientFor: vi.fn(async () => ({
    send: vi.fn(async (cmd: any) => {
      if (h.glueThrows) throw new Error("Glue AccessDenied(注入)");
      const n = cmd?.constructor?.name || "";
      if (n.startsWith("GetDatabases")) return { DatabaseList: h.glueDatabases };
      if (n.startsWith("GetTables")) {
        if (h.glueTablesThrow.has(cmd.input.DatabaseName)) throw new Error("AccessDenied(注入:该库未授权)");
        return { TableList: h.glueTables[cmd.input.DatabaseName] ?? [] };
      }
      throw new Error(`未预期的 Glue 命令:${n}`);
    }),
  })),
}));

// OM 对账走真 om-client;只 mock 真外部(取 token 的 Secrets Manager + 下面按用例 stub 的 fetch)
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class { send = async () => ({ SecretString: "bot-jwt" }); },
  GetSecretValueCommand: class { constructor(public input: unknown) {} },
}));

vi.mock("@aws-sdk/client-glue", () => {
  class GetDatabasesCommand {
    constructor(public input: any) {}
  }
  class GetTablesCommand {
    constructor(public input: any) {}
  }
  return { GetDatabasesCommand, GetTablesCommand };
});

import {
  buildMirrorOverview,
  listMirrorEntries,
  mirrorMetadata,
  sanitizeDbPayload,
  sanitizeTablePayload,
  MIRROR_MAX_ENTRIES,
} from "@/lib/exec-env/metadata-mirror";
import {
  MIRROR_STALE_MS,
  MIRROR_TTL_MS,
  mirrorFacetState,
  mirrorNeedsSync,
  parseMirrorSk,
  MIRROR_KINDS,
} from "@/lib/exec-env/metadata-mirror-shared";

const NOW = 1_800_000_000_000;

beforeEach(() => {
  h.store.clear();
  h.writes.length = 0;
  h.active = [{ targetId: "tgt_home", region: "us-east-1", jurisdiction: "home" }];
  h.activeThrows = false;
  h.queryThrows = false;
  h.glueDatabases = [];
  h.glueTables = {};
  h.glueThrows = false;
  h.glueTablesThrow = new Set();
  process.env.OPENMETADATA_URL = "";
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("🔴 新鲜度判定:过期镜像绝不许显示成实时", () => {
  it("从没成功过 ⇒ never(与「过期」是两件事,合并会让人以为同步过、只是旧了)", () => {
    expect(mirrorFacetState({ now: NOW })).toBe("never");
    expect(mirrorFacetState({ mirroredAt: "", now: NOW })).toBe("never");
    // 🔴 认不出的时间戳**不当 0**:当 0 会被算成 1970 年的陈旧镜像(数字上是 stale,语义上是 never)
    expect(mirrorFacetState({ mirroredAt: "not-a-date", now: NOW })).toBe("never");
  });

  it("🔴🔴 `ttl` 已过 ⇒ expired,**即使 mirroredAt 是一分钟前**(DDB 懒删最长 48h,不许信 item 还在)", () => {
    const state = mirrorFacetState({
      mirroredAt: new Date(NOW - 60_000).toISOString(),
      ttl: Math.floor((NOW - 1000) / 1000),
      now: NOW,
    });
    expect(
      state,
      "只按 mirroredAt 判新鲜 ⇒ 一个 TTL 已过(条目正在消失)的镜像会被画成绿灯,而它的表条目已经被删了一半"
    ).toBe("expired");
  });

  it("超过阈值 ⇒ stale;阈值内且上次采集失败 ⇒ failed(数据还新也要说出来)", () => {
    expect(mirrorFacetState({ mirroredAt: new Date(NOW - MIRROR_STALE_MS - 1).toISOString(), now: NOW })).toBe("stale");
    expect(mirrorFacetState({ mirroredAt: new Date(NOW - 60_000).toISOString(), error: "AccessDenied", now: NOW })).toBe(
      "failed"
    );
    expect(mirrorFacetState({ mirroredAt: new Date(NOW - 60_000).toISOString(), now: NOW })).toBe("fresh");
  });

  it("🔴 `failed` 必须算「需要处理」(藏起来的话镜像会一路烂到过期才暴露)", () => {
    expect(mirrorNeedsSync("failed")).toBe(true);
    expect(mirrorNeedsSync("never")).toBe(true);
    expect(mirrorNeedsSync("expired")).toBe(true);
    expect(mirrorNeedsSync("stale")).toBe(true);
    expect(mirrorNeedsSync("fresh")).toBe(false);
  });

  it("sk 反解在**第一个** `#` 处切(FQN 里带 # 时按最后一个切会把 kind 解错 ⇒ 分面静默少一类)", () => {
    expect(parseMirrorSk("table#glue.db.t#1")).toEqual({ kind: "table", fqn: "glue.db.t#1" });
    expect(parseMirrorSk("facet#summary")).toBeNull(); // facet 不是合法 kind
    expect(parseMirrorSk("table#")).toBeNull();
    expect(parseMirrorSk("#x")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("🔴🔴 只搬元数据:payload 是**重建**的,数据行结构上进不来", () => {
  it("多余字段(抽样值/数据行)一个都进不了库", () => {
    const p = sanitizeTablePayload({
      name: "orders",
      db: "dw",
      source: "glue",
      columns: [{ name: "id", type: "bigint" }],
      // 下面这些是"万一有人顺手传进来"的东西 —— 白名单重建 ⇒ 结构上进不来
      ...({ rows: [[1, "alice@x.com"]], sampleValues: ["alice@x.com"], data: "…" } as any),
    });
    const json = JSON.stringify(p);
    for (const banned of ["rows", "sampleValues", "alice@x.com", '"data"']) {
      expect(json, `payload 里出现了 ${banned} ⇒ 镜像不再是"零数据 egress"`).not.toContain(banned);
    }
    expect(Object.keys(p).sort()).toEqual(["columnCount", "columns", "db", "name", "source"]);
  });

  it("列名截断**必须可见**(静默截断 = 「这张表就 200 列」的假象)", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ name: `c${i}`, type: "int" }));
    const p = sanitizeTablePayload({ name: "wide", db: "dw", source: "glue", columns: many });
    expect(p.columnCount, "列**总数**必须是真的(不能等于被截断后的长度)").toBe(400);
    expect(p.columns.length).toBeLessThan(400);
    expect((p as { columnsTruncated?: boolean }).columnsTruncated).toBe(true);
  });

  it("库条目同样是白名单重建", () => {
    const p = sanitizeDbPayload({ name: "dw", source: "glue", tables: 3, ...({ rows: [1] } as any) });
    expect(Object.keys(p).sort()).toEqual(["name", "source", "tables"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("🔴 采集与落库(全管道)", () => {
  it("采到的库/表落成 `<kind>#<fqn>` 条目 + 分面,且分面 state=fresh", async () => {
    h.glueDatabases = [{ Name: "dw" }];
    h.glueTables.dw = [
      { Name: "orders", StorageDescriptor: { Columns: [{ Name: "id", Type: "bigint" }, { Name: "amt", Type: "decimal" }] } },
      { Name: "users", StorageDescriptor: { Columns: [{ Name: "id", Type: "bigint" }] } },
    ];
    const r = await mirrorMetadata("tgt_usw2_a", { now: NOW });
    expect(r.facet.state).toBe("fresh");
    expect(r.facet.tables).toBe(2);
    expect(r.facet.databases).toBe(1);
    expect(r.facet.columns).toBe(3);
    const sks = h.writes.filter((w) => w.kind === "put" && w.pk === "mirror#tgt_usw2_a").map((w) => w.sk).sort();
    expect(sks).toEqual(["db#glue.dw", "table#glue.dw.orders", "table#glue.dw.users"].sort());
    // TTL = 7d(合同),且写在**每一条**条目上
    const one = h.store.get(key("mirror#tgt_usw2_a", "table#glue.dw.orders"))!;
    expect(one.ttl).toBe(Math.floor((NOW + MIRROR_TTL_MS) / 1000));
    expect(one.mirroredAt).toBe(new Date(NOW).toISOString());
  });

  it("🔴 那个区删掉的表**当场消失**,不等 7d TTL(反向假绿:总览里挂着一张早没了的表)", async () => {
    h.glueDatabases = [{ Name: "dw" }];
    h.glueTables.dw = [{ Name: "orders" }, { Name: "gone" }];
    await mirrorMetadata("tgt_usw2_a", { now: NOW });
    expect(h.store.has(key("mirror#tgt_usw2_a", "table#glue.dw.gone"))).toBe(true);

    h.writes.length = 0;
    h.glueTables.dw = [{ Name: "orders" }];
    await mirrorMetadata("tgt_usw2_a", { now: NOW + 60_000 });
    expect(h.store.has(key("mirror#tgt_usw2_a", "table#glue.dw.gone"))).toBe(false);
    expect(h.writes.some((w) => w.kind === "delete" && w.sk === "table#glue.dw.gone")).toBe(true);
  });

  it("🔴🔴 glue-only 的定时刷新**绝不许**删掉手动采的 redshift 条目(界面上表现为数仓目录莫名消失)", async () => {
    // 🔴🔴 **这一版判据是被真环境咬出来的**:第一版只塞了「数仓**条目**」却没塞
    //    「上一次数仓采集的**分面报告**」⇒ `prevReports` 里没有 redshift ⇒ 删除范围天然只有 glue,
    //    测试当然绿。真环境里那份报告是**一定存在**的(手动采过就有),于是
    //    `okSources` 把「历史上成功过的来源」也算进了「本轮采成功的来源」,
    //    一次 glue 定时刷新就把 65 条数仓条目全删了(W3e-12 实测)。
    //    ⇒ 判据必须把**真实前置**(条目 + 分面报告都在)摆齐,否则测的是一个不存在的场景。
    h.store.set(key("mirror#__facets", "tgt_usw2_a"), {
      pk: "mirror#__facets",
      sk: "tgt_usw2_a",
      payload: {
        targetId: "tgt_usw2_a",
        region: "us-west-2",
        mirroredAt: new Date(NOW - 600_000).toISOString(),
        sources: [
          { source: "glue", ok: true, at: new Date(NOW - 600_000).toISOString(), databases: 1, tables: 1, columns: 0 },
          { source: "redshift", ok: true, at: new Date(NOW - 3600_000).toISOString(), databases: 1, tables: 1, columns: 0 },
        ],
        truncated: false,
      },
      mirroredAt: new Date(NOW - 600_000).toISOString(),
      ttl: Math.floor((NOW + MIRROR_TTL_MS) / 1000),
    });
    h.store.set(key("mirror#tgt_usw2_a", "table#redshift.dev.public.sales"), {
      pk: "mirror#tgt_usw2_a",
      sk: "table#redshift.dev.public.sales",
      kind: "table",
      fqn: "redshift.dev.public.sales",
      payload: { name: "sales", db: "dev.public", source: "redshift" },
      mirroredAt: new Date(NOW - 3600_000).toISOString(),
      ttl: Math.floor((NOW + MIRROR_TTL_MS) / 1000),
    });
    h.glueDatabases = [{ Name: "dw" }];
    h.glueTables.dw = [{ Name: "orders" }];
    await mirrorMetadata("tgt_usw2_a", { sources: ["glue"], now: NOW });
    expect(
      h.store.has(key("mirror#tgt_usw2_a", "table#redshift.dev.public.sales")),
      "定时刷新按「本轮没看见就删」删掉了另一个来源的条目 ⇒ 手动采的数仓目录每 30 分钟被抹一次"
    ).toBe(true);
    expect(h.writes.filter((w) => w.kind === "delete").map((w) => w.sk)).not.toContain(
      "table#redshift.dev.public.sales"
    );
  });

  it("🔴 采集失败**保留上一次成功的时间与计数**(一次抖动不许把「3 分钟前采过」变成「从未同步」)", async () => {
    h.glueDatabases = [{ Name: "dw" }];
    h.glueTables.dw = [{ Name: "orders" }];
    await mirrorMetadata("tgt_usw2_a", { now: NOW });

    h.glueThrows = true;
    const r2 = await mirrorMetadata("tgt_usw2_a", { now: NOW + 60_000 });
    const glue = r2.facet.sources.find((s) => s.source === "glue")!;
    expect(glue.ok).toBe(false);
    expect(glue.error).toContain("AccessDenied");
    expect(glue.at, "上一次成功的时间被清掉了 ⇒ 分面会变成「从未同步」").toBe(new Date(NOW).toISOString());
    expect(glue.tables, "上一次成功的计数被清成 0 ⇒ 界面上那个区看起来突然空了").toBe(1);
    // 🔴 采集失败**不许删条目**(否则一次 AccessDenied 就把镜像清空)
    expect(h.store.has(key("mirror#tgt_usw2_a", "table#glue.dw.orders"))).toBe(true);
    // 失败但数据还新 ⇒ failed(要给〔立即同步〕),不是 fresh
    expect(r2.facet.state).toBe("failed");
  });

  it("fqn 前缀与 source 不一致 ⇒ 拒绝写入(删除逻辑靠前缀判来源,不一致会删错来源)", async () => {
    // 用一个"来源说 glue、fqn 却是 redshift."的桩:直接测不到私有函数,
    // 这里用 GetTables 返回的库名把 fqn 顶成非 glue 前缀是做不到的 ⇒ 断言这条不变量的**存在**
    const src = await import("node:fs").then((m) =>
      m.readFileSync(new URL("../metadata-mirror.ts", import.meta.url), "utf8")
    );
    expect(src).toContain("function assertFqnMatchesSource(");
    expect(src, "写入前没有逐条断言前缀 ⇒ 删除逻辑可能删错来源").toMatch(
      /for \(const e of out\.entries\) assertFqnMatchesSource\(e\.fqn, source\)/
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("🔴 一屏总览:算不出来要抛,不许回空分面", () => {
  it("注册表读失败 ⇒ **抛**(空分面在界面上等于「那些区没有资产」)", async () => {
    h.activeThrows = true;
    await expect(buildMirrorOverview(NOW)).rejects.toThrow(/执行目标清单/);
  });

  it("镜像表读失败 ⇒ 不抛,但 `warnings` 必须非空(界面据此说「数字不完整」)", async () => {
    h.queryThrows = true;
    const ov = await buildMirrorOverview(NOW);
    expect(ov.warnings.length).toBeGreaterThan(0);
    expect(ov.facets.length).toBeGreaterThan(0);
    expect(ov.facets[0].state).toBe("never");
  });

  it("活跃但从没采过的 target ⇒ 分面照实给 `never`,**不隐藏**", async () => {
    h.active = [
      { targetId: "tgt_home", region: "us-east-1", jurisdiction: "home" },
      { targetId: "tgt_usw2_a", region: "us-west-2", jurisdiction: "home" },
    ];
    const ov = await buildMirrorOverview(NOW);
    expect(ov.facets.map((f) => f.targetId)).toEqual(["tgt_home", "tgt_usw2_a"]);
    expect(ov.facets.every((f) => f.state === "never")).toBe(true);
    expect(ov.needSync).toBe(2);
  });

  it("🔴 有镜像但**已从注册表摘掉**的 target 仍要出现(只列活跃会把「那个区还留着东西」整列藏掉)", async () => {
    h.glueDatabases = [{ Name: "dw" }];
    h.glueTables.dw = [{ Name: "orders" }];
    await mirrorMetadata("tgt_old", { now: NOW });
    h.active = [{ targetId: "tgt_home", region: "us-east-1", jurisdiction: "home" }];
    const ov = await buildMirrorOverview(NOW);
    const old = ov.facets.find((f) => f.targetId === "tgt_old");
    expect(old, "已下线但有镜像的 target 消失了 ⇒ 那个区留下的资产彻底看不见").toBeTruthy();
    expect(old!.active).toBe(false);
  });

  it("🔴 分面的 `mirroredAt` **只取定时来源**:手动采的数仓目录另有自己的态", async () => {
    h.glueDatabases = [{ Name: "dw" }];
    h.glueTables.dw = [{ Name: "orders" }];
    // 先写一条"3 天前手动采的数仓 report"进分面,再跑一次 glue 定时刷新
    await mirrorMetadata("tgt_usw2_a", { now: NOW - 3 * 24 * 3600_000 });
    const facetKey = key("mirror#__facets", "tgt_usw2_a");
    const f = h.store.get(facetKey)!;
    f.payload.sources.push({
      source: "redshift",
      ok: true,
      at: new Date(NOW - 3 * 24 * 3600_000).toISOString(),
      attemptedAt: new Date(NOW - 3 * 24 * 3600_000).toISOString(),
      databases: 1,
      tables: 7,
      columns: 0,
    });
    h.store.set(facetKey, f);

    await mirrorMetadata("tgt_usw2_a", { sources: ["glue"], now: NOW });
    const ov = await buildMirrorOverview(NOW);
    const facet = ov.facets.find((x) => x.targetId === "tgt_usw2_a")!;
    expect(facet.state, "定时来源刚采过 ⇒ 分面应为 fresh").toBe("fresh");
    expect(
      facet.warehouse?.state,
      "数仓目录 3 天前采的却跟着分面一起变绿 ⇒ 等于用一次陈旧手动采集冒充实时"
    ).toBe("stale");
    expect(facet.tables, "数仓的 7 张表被并进了「资产」总数 ⇒ 两个时间戳的数字混成一个").toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("🔴 下钻:过期条目不许返回", () => {
  it("ttl 已过的条目被跳过(DDB 懒删会把它们照样查出来)", async () => {
    h.store.set(key("mirror#tgt_home", "table#glue.dw.fresh"), {
      pk: "mirror#tgt_home", sk: "table#glue.dw.fresh", kind: "table", fqn: "glue.dw.fresh",
      payload: { name: "fresh" }, ttl: Math.floor((Date.now() + 3600_000) / 1000),
    });
    h.store.set(key("mirror#tgt_home", "table#glue.dw.rotten"), {
      pk: "mirror#tgt_home", sk: "table#glue.dw.rotten", kind: "table", fqn: "glue.dw.rotten",
      payload: { name: "rotten" }, ttl: Math.floor((Date.now() - 3600_000) / 1000),
    });
    const entries = await listMirrorEntries("tgt_home");
    expect(entries.map((e) => e.fqn)).toEqual(["glue.dw.fresh"]);
  });

  it("kind 过滤只取该前缀;facet 汇总条目永远不混进条目列表", async () => {
    h.glueDatabases = [{ Name: "dw" }];
    h.glueTables.dw = [{ Name: "orders" }];
    await mirrorMetadata("tgt_home", { now: NOW });
    const dbs = await listMirrorEntries("tgt_home", "db");
    expect(dbs.map((e) => e.fqn)).toEqual(["glue.dw"]);
    const all = await listMirrorEntries("tgt_home");
    expect(all.every((e) => (MIRROR_KINDS as readonly string[]).includes(e.kind))).toBe(true);
  });
});

describe("上限如实回报", () => {
  it("条目超上限 ⇒ `truncated` 为真且 `cap` 是真实上限(静默截断 = 「这个区就这么点东西」)", async () => {
    h.glueDatabases = [{ Name: "dw" }];
    h.glueTables.dw = Array.from({ length: MIRROR_MAX_ENTRIES + 5 }, (_, i) => ({ Name: `t${i}` }));
    const r = await mirrorMetadata("tgt_home", { now: NOW });
    expect(r.facet.truncated).toBe(true);
    expect(r.facet.cap).toBe(MIRROR_MAX_ENTRIES);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("🔴🔴 差集删除只在采集确知完整时做(镜像 + OM 对账)", () => {
  const seed = (fqn: string) =>
    h.store.set(key("mirror#tgt_home", `table#${fqn}`), {
      pk: "mirror#tgt_home", sk: `table#${fqn}`, kind: "table", fqn, payload: { name: fqn.split(".").pop() },
      ttl: Math.floor(NOW / 1000) + 3600,
    });
  const deletedSks = () => h.writes.filter((w) => w.kind === "delete").map((w) => w.sk);

  it("🔴 读失败的库:镜像里该库的条目一条都不删,其它库照常删;结果报出 unread", async () => {
    h.glueDatabases = [{ Name: "dw" }, { Name: "locked" }];
    h.glueTables.dw = [{ Name: "orders" }];
    h.glueTablesThrow = new Set(["locked"]);
    seed("glue.dw.gone");
    seed("glue.locked.secret_table");
    await mirrorMetadata("tgt_home", { now: NOW });
    expect(deletedSks()).toEqual(["table#glue.dw.gone"]);
  });

  it("🔴 采集被截断:镜像差集一条都不删(截断外的条目本轮没看见 ≠ 不存在)", async () => {
    h.glueDatabases = [{ Name: "dw" }];
    h.glueTables.dw = Array.from({ length: MIRROR_MAX_ENTRIES + 5 }, (_, i) => ({ Name: `t${i}` }));
    seed("glue.dw.zzz_beyond_cap");
    const r = await mirrorMetadata("tgt_home", { now: NOW });
    expect(r.facet.truncated).toBe(true);
    expect(deletedSks()).toEqual([]);
  });

  it("🔴 接线:推完 OM 后按来源对账 —— 软删 OM 里没看见的表,读失败的库不动;结果挂在 om.reconcile", async () => {
    process.env.OPENMETADATA_URL = "http://om.test";
    const omTables = [
      { id: "1", db: "dw", name: "orders" },
      { id: "2", db: "dw", name: "gone" },
      { id: "3", db: "locked", name: "secret_table" },
    ];
    const deleted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
      if (init?.method === "DELETE") {
        deleted.push(decodeURIComponent(u.pathname.split("/").pop() || ""));
        return ok({});
      }
      if (u.pathname === "/api/v1/databases") {
        expect(u.searchParams.get("service")).toBe("bgp-glue");
        return ok({ data: [{ name: "dw", fullyQualifiedName: "bgp-glue.dw" }, { name: "locked", fullyQualifiedName: "bgp-glue.locked" }], paging: {} });
      }
      if (u.pathname === "/api/v1/tables" && u.searchParams.get("database")) {
        const db = String(u.searchParams.get("database")).split(".")[1];
        return ok({ data: omTables.filter((t) => t.db === db).map((t) => ({ id: t.id, name: t.name, databaseSchema: { name: "default" } })), paging: {} });
      }
      return ok({});   // 推送那几个 PUT
    }));
    h.glueDatabases = [{ Name: "dw" }, { Name: "locked" }];
    h.glueTables.dw = [{ Name: "orders" }];
    h.glueTablesThrow = new Set(["locked"]);
    const r = await mirrorMetadata("tgt_home", { now: NOW });
    expect(deleted).toEqual(["2"]);
    expect(r.om?.reconcile).toHaveLength(1);
    expect(r.om?.reconcile?.[0]).toMatchObject({ source: "glue", service: "bgp-glue", deleted: 1, errors: [] });
  });
});
