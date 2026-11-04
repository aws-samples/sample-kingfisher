// 镜像 → OM 推送的可执行门禁(合同 50 SPEC §3.4.6)。
//
// 🔴 要钉住的三件,错了都是「目录看起来正常、其实落错了地方」:
//   ① 坐标翻译:`redshift.<db>.<schema>.<table>` 与 `glue.<db>.<table>` 段数不同,
//      按同一套解析必然把 schema 与 table 错位(目录里出现一堆名字是 schema 的「表」);
//   ② 落在**per-target service** 上(落到 home 的 service = 把别的区的表推成主控区的);
//   ③ 父实体先建(OM 要求 service → database → schema → table),否则 PUT 表会 404 而**整轮静默失败**。

import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: Array<{ fn: string; args: unknown[] }> = [];
let failOn: string | null = null;

vi.mock("@/lib/openmetadata/om-client", () => ({ isOmConfigured: () => true }));
vi.mock("@/lib/openmetadata/om-write", () => ({
  ensureService: vi.fn(async (...a: unknown[]) => { calls.push({ fn: "ensureService", args: a }); }),
  customDbService: (name: string) => ({ name, serviceType: "CustomDatabase" }),
  putDatabase: vi.fn(async (...a: unknown[]) => { calls.push({ fn: "putDatabase", args: a }); }),
  putSchema: vi.fn(async (...a: unknown[]) => { calls.push({ fn: "putSchema", args: a }); }),
  putTable: vi.fn(async (...a: unknown[]) => {
    calls.push({ fn: "putTable", args: a });
    if (failOn && String(a[0]) === failOn) throw new Error("OM 500");
  }),
}));

import { pushMirrorToOpenMetadata } from "../om-mirror-push";

const entry = (fqn: string, extra: Record<string, unknown> = {}) => ({
  kind: "table" as const,
  fqn,
  payload: { name: fqn.split(".").pop(), source: fqn.split(".")[0], columns: [], ...extra },
});

beforeEach(() => { calls.length = 0; failOn = null; });

describe("坐标翻译", () => {
  it("🔴 数仓四段 `redshift.db.schema.table` ⇒ database=db · schema=schema · table=table", async () => {
    const r = await pushMirrorToOpenMetadata({ targetId: "tgt_usw2_a", entries: [entry("redshift.dev.public.orders")] });
    expect(r.tables).toBe(1);
    expect(calls.map((c) => [c.fn, ...c.args.slice(0, 2)])).toEqual([
      ["ensureService", "bgp-redshift-tgt-usw2-a", { name: "bgp-redshift-tgt-usw2-a", serviceType: "CustomDatabase" }],
      ["putDatabase", "dev", "bgp-redshift-tgt-usw2-a"],
      ["putSchema", "public", "bgp-redshift-tgt-usw2-a.dev"],
      ["putTable", "orders", "bgp-redshift-tgt-usw2-a.dev.public"],
    ]);
  });

  it("🔴 Glue 三段 `glue.db.table` ⇒ schema 统一放 `default`(Glue 没有 schema 这一层)", async () => {
    await pushMirrorToOpenMetadata({ targetId: "tgt_usw2_a", entries: [entry("glue.raw.events")] });
    expect(calls.map((c) => [c.fn, ...c.args.slice(0, 2)])).toEqual([
      ["ensureService", "bgp-glue-tgt-usw2-a", { name: "bgp-glue-tgt-usw2-a", serviceType: "CustomDatabase" }],
      ["putDatabase", "raw", "bgp-glue-tgt-usw2-a"],
      ["putSchema", "default", "bgp-glue-tgt-usw2-a.raw"],
      ["putTable", "events", "bgp-glue-tgt-usw2-a.raw.default"],
    ]);
  });

  it("段数不对的 fqn 直接跳过(不猜)", async () => {
    const r = await pushMirrorToOpenMetadata({ targetId: "tgt_usw2_a", entries: [entry("redshift.dev.public")] });
    expect(r.tables).toBe(0);
    expect(calls).toEqual([]);
  });

  it("主控区落**无后缀**的 service(存量资产零搬家)", async () => {
    await pushMirrorToOpenMetadata({ targetId: "tgt_home", entries: [entry("redshift.dev.public.players")] });
    expect(calls[0].args[0]).toBe("bgp-redshift");
  });
});

describe("父实体与幂等", () => {
  it("同 service / db / schema 只 ensure 一次(N 张表不发 3N 个 PUT)", async () => {
    await pushMirrorToOpenMetadata({
      targetId: "tgt_usw2_a",
      entries: [entry("redshift.dev.public.a"), entry("redshift.dev.public.b"), entry("redshift.dev.other.c")],
    });
    expect(calls.filter((c) => c.fn === "ensureService")).toHaveLength(1);
    expect(calls.filter((c) => c.fn === "putDatabase")).toHaveLength(1);
    expect(calls.filter((c) => c.fn === "putSchema")).toHaveLength(2); // public + other
    expect(calls.filter((c) => c.fn === "putTable")).toHaveLength(3);
  });

  it("只处理 table 条目(db 条目不推 —— 它只是给总览数数的)", async () => {
    const r = await pushMirrorToOpenMetadata({
      targetId: "tgt_usw2_a",
      entries: [{ kind: "db", fqn: "redshift.dev.public", payload: {} }, entry("redshift.dev.public.a")],
    });
    expect(r.tables).toBe(1);
  });
});

describe("失败要报,不许静默", () => {
  it("🔴 单表失败不打断整轮,但计进 errors(推不进 OM = 那个区的目录停更,页面看不出来)", async () => {
    failOn = "b";
    const r = await pushMirrorToOpenMetadata({
      targetId: "tgt_usw2_a",
      entries: [entry("redshift.dev.public.a"), entry("redshift.dev.public.b"), entry("redshift.dev.public.c")],
    });
    expect(r.tables).toBe(2);
    expect(r.errors).toEqual([{ fqn: "redshift.dev.public.b", error: "OM 500" }]);
  });

  it("触到上限 ⇒ `truncated` 为真(静默截断 = 「这个区就这么点表」的假象)", async () => {
    const many = Array.from({ length: 801 }, (_, i) => entry(`redshift.dev.public.t${i}`));
    const r = await pushMirrorToOpenMetadata({ targetId: "tgt_usw2_a", entries: many });
    expect(r.truncated).toBe(true);
    expect(r.tables).toBe(800);
  });
});

describe("OM 没配", () => {
  it("什么都不做,也不假装推成功了", async () => {
    vi.doMock("@/lib/openmetadata/om-client", () => ({ isOmConfigured: () => false }));
    vi.resetModules();
    const { pushMirrorToOpenMetadata: fn } = await import("../om-mirror-push");
    const r = await fn({ targetId: "tgt_usw2_a", entries: [entry("redshift.dev.public.a")] });
    expect(r).toEqual({ tables: 0, services: [], truncated: false, errors: [] });
    vi.doUnmock("@/lib/openmetadata/om-client");
    vi.resetModules();
  });
});
