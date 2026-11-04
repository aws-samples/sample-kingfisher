// @kf-batch 50-B42-om-reconcile
// 目录对账(B-42)的装配层判据:**只 mock 真外部**(Secrets Manager 取 token · OM 的 HTTP),
// om-client / om-service / om-mirror-push / om-reconcile 全部跑真代码(接缝不许被 mock 抹平)。
//
// 🔴 要钉住的是「删对的、**绝不删错的**」:
//   ① 没看见的软删;看见的、别的 service 的(别的区 / 别的来源)一张不动;
//   ② 采集截断 / 采集为空 / 列 OM 任一页失败 / 读失败的库 ⇒ **一张都不删**(fail-closed);
//   ③ 分页:第 2 页上的表也参与对账(只读第一页 = 把第二页当成「不存在」或「看不见」);
//   ④ 上限:超出只删上限张并报 truncated;单张删除失败如实报。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class { send = async () => ({ SecretString: "bot-jwt" }); },
  GetSecretValueCommand: class { constructor(public input: unknown) {} },
}));

type T = { id: string; name: string; service: string; db: string; schema: string; deleted?: boolean };
let tables: T[] = [];
let failPath: RegExp | null = null;
let failDeleteId: string | null = null;
let pageSize = 200;
const deletes: string[] = [];

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function fakeOm(url: string, init?: RequestInit): Response {
  const u = new URL(url);
  const method = init?.method || "GET";
  if (failPath && failPath.test(u.pathname + u.search)) return respond(500, { message: "boom" });
  const after = Number(u.searchParams.get("after") || "0");
  const lim = Math.min(Number(u.searchParams.get("limit") || "10"), pageSize);
  const page = (rows: unknown[]) => {
    const slice = rows.slice(after, after + lim);
    const next = after + lim < rows.length ? String(after + lim) : undefined;
    return respond(200, { data: slice, paging: next ? { after: next } : {} });
  };
  if (method === "GET" && u.pathname === "/api/v1/databases") {
    const svc = u.searchParams.get("service");
    const names = Array.from(new Set(tables.filter((t) => t.service === svc).map((t) => t.db))).sort();
    return page(names.map((n) => ({ name: n, fullyQualifiedName: `${svc}.${n}` })));
  }
  if (method === "GET" && u.pathname === "/api/v1/tables") {
    const dbFqn = u.searchParams.get("database") || "";
    const rows = tables
      .filter((t) => !t.deleted && `${t.service}.${t.db}` === dbFqn)
      .map((t) => ({ id: t.id, name: t.name, fullyQualifiedName: `${dbFqn}.${t.schema}.${t.name}`, databaseSchema: { name: t.schema } }));
    return page(rows);
  }
  const m = u.pathname.match(/^\/api\/v1\/tables\/([^/]+)$/);
  if (method === "DELETE" && m) {
    const id = decodeURIComponent(m[1]);
    if (id === failDeleteId) return respond(500, { message: "nope" });
    expect(u.searchParams.get("hardDelete")).toBe("false");
    const t = tables.find((x) => x.id === id);
    if (!t) return respond(404, {});
    t.deleted = true;
    deletes.push(`${t.service}.${t.db}.${t.schema}.${t.name}`);
    return respond(200, { id });
  }
  return respond(404, {});
}

const tb = (service: string, db: string, schema: string, name: string): T => ({ id: `${service}|${db}|${schema}|${name}`, service, db, schema, name });

beforeEach(() => {
  process.env.OPENMETADATA_URL = "http://om.test";
  tables = [];
  failPath = null;
  failDeleteId = null;
  pageSize = 200;
  deletes.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => fakeOm(url, init)));
});
afterEach(() => vi.unstubAllGlobals());

async function run(args: Partial<Parameters<typeof import("../om-reconcile").reconcileOmTables>[0]> & { seen: string[] }) {
  const { reconcileOmTables } = await import("../om-reconcile");
  return reconcileOmTables({ targetId: "tgt_home", source: "redshift", complete: true, unreadDatabases: [], ...args });
}

describe("① 删对的,不碰别人的", () => {
  it("🔴 home 数仓:没看见的软删;看见的、别的区的 service、Glue 的 service 都不动", async () => {
    tables = [
      tb("bgp-redshift", "dev", "public", "players"),
      tb("bgp-redshift", "dev", "proda_for_1", "ad_campaigns"),
      tb("bgp-redshift", "dev", "public", "w3b_1009"),
      tb("bgp-redshift-tgt-usw2-a", "dev", "public", "w3b_1009"),
      tb("bgp-glue", "raw", "default", "w3b_1009"),
    ];
    const r = await run({ seen: ["redshift.dev.public.players"] });
    expect(r.service).toBe("bgp-redshift");
    expect(r.skipped).toBeUndefined();
    expect(deletes.sort()).toEqual(["bgp-redshift.dev.proda_for_1.ad_campaigns", "bgp-redshift.dev.public.w3b_1009"]);
    expect(r).toMatchObject({ listed: 3, deleted: 2, truncated: false, errors: [] });
  });

  it("🔴 非 home 落在 per-target service;Glue 坐标的 schema = default", async () => {
    tables = [
      tb("bgp-glue-tgt-usw2-a", "raw", "default", "events"),
      tb("bgp-glue-tgt-usw2-a", "raw", "default", "gone"),
      tb("bgp-glue", "raw", "default", "gone"),
    ];
    const r = await run({ targetId: "tgt_usw2_a", source: "glue", seen: ["glue.raw.events"] });
    expect(r.service).toBe("bgp-glue-tgt-usw2-a");
    expect(deletes).toEqual(["bgp-glue-tgt-usw2-a.raw.default.gone"]);
  });
});

describe("② fail-closed:读不清楚就一张都不删", () => {
  beforeEach(() => {
    tables = [tb("bgp-redshift", "dev", "public", "keep"), tb("bgp-redshift", "dev", "public", "stale"), tb("bgp-redshift", "zz", "public", "stale2")];
  });
  it("采集被截断 ⇒ skipped=pull-incomplete,零删除", async () => {
    const r = await run({ seen: ["redshift.dev.public.keep"], complete: false });
    expect(r.skipped).toBe("pull-incomplete");
    expect(deletes).toEqual([]);
  });
  it("🔴 采集一张表都没看见 ⇒ skipped=empty-pull(空输入不许变成全删)", async () => {
    const r = await run({ seen: [] });
    expect(r.skipped).toBe("empty-pull");
    expect(deletes).toEqual([]);
  });
  it("🔴 第二个库的表清单读失败 ⇒ 整轮不删(第一个库里的 stale 也不删)", async () => {
    failPath = /\/api\/v1\/tables\?database=bgp-redshift\.zz/;
    const r = await run({ seen: ["redshift.dev.public.keep"] });
    expect(r.skipped).toBe("om-list-failed");
    expect(r.errors[0].error).toContain("500");
    expect(deletes).toEqual([]);
  });
  it("库清单读失败 ⇒ 整轮不删", async () => {
    failPath = /\/api\/v1\/databases/;
    const r = await run({ seen: ["redshift.dev.public.keep"] });
    expect(r.skipped).toBe("om-list-failed");
    expect(deletes).toEqual([]);
  });
  it("🔴 读失败的库一张都不动,其它库照常对账", async () => {
    const r = await run({ seen: ["redshift.dev.public.keep"], unreadDatabases: ["zz"] });
    expect(deletes).toEqual(["bgp-redshift.dev.public.stale"]);
    expect(r.skipped).toBeUndefined();
  });
  it("OM 没配置 ⇒ skipped,零请求", async () => {
    process.env.OPENMETADATA_URL = "";
    const r = await run({ seen: ["redshift.dev.public.keep"] });
    expect(r.skipped).toBe("om-not-configured");
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });
});

describe("③ 分页 · ④ 上限与失败", () => {
  it("🔴 第 2 页上的表也参与对账:看见的不删、没看见的删", async () => {
    pageSize = 2;
    tables = ["a", "b", "c", "d", "e"].map((n) => tb("bgp-redshift", "dev", "public", n));
    const r = await run({ seen: ["redshift.dev.public.a", "redshift.dev.public.d"] });
    expect(r.listed).toBe(5);
    expect(deletes.sort()).toEqual(["bgp-redshift.dev.public.b", "bgp-redshift.dev.public.c", "bgp-redshift.dev.public.e"]);
  });
  it("超出上限 ⇒ 只删上限张并报 truncated", async () => {
    const { OM_RECONCILE_MAX_DELETES } = await import("../om-reconcile");
    tables = [tb("bgp-redshift", "dev", "public", "keep")];
    for (let i = 0; i < OM_RECONCILE_MAX_DELETES + 5; i++) tables.push(tb("bgp-redshift", "dev", "public", `s${i}`));
    const r = await run({ seen: ["redshift.dev.public.keep"] });
    expect(r.deleted).toBe(OM_RECONCILE_MAX_DELETES);
    expect(r.truncated).toBe(true);
  });
  it("单张删除失败如实报进 errors,其它照删", async () => {
    tables = [tb("bgp-redshift", "dev", "public", "keep"), tb("bgp-redshift", "dev", "public", "x"), tb("bgp-redshift", "dev", "public", "y")];
    failDeleteId = "bgp-redshift|dev|public|x";
    const r = await run({ seen: ["redshift.dev.public.keep"] });
    expect(deletes).toEqual(["bgp-redshift.dev.public.y"]);
    expect(r.errors.map((e) => e.fqn)).toEqual(["bgp-redshift.dev.public.x"]);
  });
});
