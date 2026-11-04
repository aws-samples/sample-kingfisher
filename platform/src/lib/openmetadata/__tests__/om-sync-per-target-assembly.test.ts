// @kf-batch 50-o4REG-sync-om-per-target
// 登记 o4-REG(非主控区同步的 OM schema / 列级血缘按区)的**装配层**判据。
// 只 mock 真外部:Secrets Manager(取 OM token)· OM 的 HTTP(fetch)· 两个「去该区数据面读真实列」的读函数
// (`introspectSchema` / `introspectS3Tables`,背后是 Redshift Data / Athena)· 主控区回填用到的表桶树与
// lineage-service(主控区分支只断「原样调用」)。om-client / om-write / om-push / om-sync-coords /
// om-sync-backfill / om-mirror-push / om-service 全部跑真代码(接缝不许被 mock 抹平)。
//
// 🔴 要钉住的四件事:
//   ① 主控区**逐字节不变**(service 名 / FQN 与改动前 om-push 里的表达式逐字相同);
//   ② 其它区:每一个 PUT 都落在该区的 per-target service 上,**一个都不许**落进主控区的 service;
//   ③ 与目录同步(om-mirror-push)**同一个 OM 实体**(FQN 逐字相等)⇒ 列级血缘挂在用户看得见的那个表上;
//   ④ 落点不全 ⇒ 一个 PUT 都不发(绝不回落 `bgp-table-bucket` / `dev`);成功回填读到空 ⇒ 如实报错。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class { send = async () => ({ SecretString: "bot-jwt" }); },
  GetSecretValueCommand: class { constructor(public input: unknown) {} },
}));

const introspectSchemaMock = vi.fn();
const introspectS3TablesMock = vi.fn();
vi.mock("@/lib/genbi/schema", () => ({ introspectSchema: (...a: unknown[]) => introspectSchemaMock(...a) }));
vi.mock("@/lib/genbi/athena", () => ({ introspectS3Tables: (...a: unknown[]) => introspectS3TablesMock(...a) }));
const homeCalls: string[] = [];
vi.mock("@/lib/athena/s3tables", () => ({
  resolveS3TablesPlace: async (t: string) => { homeCalls.push(`s3tablesPlace:${t}`); return { home: true }; },
  // 序 38 B-71:表桶列回填改走「平台表桶 + 已登记外部表桶」(本判据没登记外部桶 ⇒ 只有平台表桶那一个,记同一个标记)
  resolveS3TablesPlaces: async (t: string) => { homeCalls.push(`s3tablesPlace:${t}`); return [{ targetId: t, home: true, external: false, bucket: "bgp-table-bucket", catalogRef: "s3tablescatalog/bgp-table-bucket", region: "us-east-1" }]; },
  listNamespaceTree: async () => [],
}));
vi.mock("@/lib/governance/lineage-service", () => ({
  repushSyncLineageToOM: async () => { homeCalls.push("repushSyncLineageToOM"); return { tasks: 0 }; },
  backfillComputeLineageToOM: async () => { homeCalls.push("backfillComputeLineageToOM"); return { targets: 0, edgesPushed: 0 }; },
}));

type Put = { path: string; body: any };
let puts: Put[] = [];
let tablesByFqn: Map<string, Array<{ name: string }>>;

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}
function fakeOm(url: string, init?: RequestInit): Response {
  const u = new URL(url);
  const method = init?.method || "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (method === "PUT") {
    puts.push({ path: u.pathname, body });
    if (u.pathname === "/api/v1/tables") {
      tablesByFqn.set(`${body.databaseSchema}.${body.name}`, body.columns || []);
    }
    return respond(200, { id: `${u.pathname}:${body?.name ?? ""}` });
  }
  const m = u.pathname.match(/^\/api\/v1\/tables\/name\/(.+)$/);
  if (method === "GET" && m) {
    const fqn = decodeURIComponent(m[1]);
    const cols = tablesByFqn.get(fqn);
    return cols ? respond(200, { id: fqn, fullyQualifiedName: fqn, columns: cols }) : respond(404, {});
  }
  return respond(404, {});
}

beforeEach(() => {
  process.env.OPENMETADATA_URL = "http://om.test";
  delete process.env.REDSHIFT_WORKGROUP;
  puts = [];
  tablesByFqn = new Map();
  homeCalls.length = 0;
  introspectSchemaMock.mockReset();
  introspectS3TablesMock.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => fakeOm(url, init)));
});
afterEach(() => vi.unstubAllGlobals());

const HOME = "tgt_home";
const T = "tgt_usw2_a";
const HOME_SERVICES = ["bgp-sources", "bgp-s3tables", "bgp-redshift", "bgp-physical"];

const ds = { database: "gamedata", host: "src-db.abc.us-west-2.rds.amazonaws.com" } as any;
function task(over: Record<string, unknown> = {}) {
  return {
    taskId: "t1",
    projectId: "p1",
    targetType: "both",
    sourceTables: ["Orders"],
    s3Config: { namespace: "Game-Data" },
    redshiftConfig: { schema: "Analytics" },
    fieldMappings: { Orders: [{ source: "id", target: "id", sourceType: "int" }, { source: "amt", target: "amt", sourceType: "decimal" }] },
    ...over,
  };
}
const usw2Place = { targetId: T, sourceTargetId: T, tableBucket: "bgp-tb-tgt-usw2-a", rsDatabase: "DEV", rsWorkgroup: "bgp-wg-tgt-usw2-a" };

/** 每个 PUT 落在哪个 service 上(从 FQN / service 字段读,不靠猜)。 */
function servicesTouched(): string[] {
  const out = new Set<string>();
  for (const p of puts) {
    const b = p.body || {};
    if (p.path.startsWith("/api/v1/services/")) out.add(String(b.name));
    else if (p.path === "/api/v1/databases" || p.path === "/api/v1/containers") out.add(String(b.service));
    else if (p.path === "/api/v1/databaseSchemas") out.add(String(b.database).split(".")[0]);
    else if (p.path === "/api/v1/tables") out.add(String(b.databaseSchema).split(".")[0]);
  }
  return Array.from(out).sort();
}

describe("o4-REG ① 主控区逐字节不变", () => {
  it("坐标与改动前 om-push 的表达式逐字相同(service 不带后缀 / 缺省桶与库照旧)", async () => {
    const { syncOmCoords, syncOmPlaceOf } = await import("../om-sync-coords");
    const t = task();
    const c = syncOmCoords(t, ds, syncOmPlaceOf({ targetId: HOME, tableBucket: "" }, null, HOME));
    // 改动前的原表达式(从旧版 pushSyncToOpenMetadata 逐字搬来):
    const { sanitizeS3TablesIdentifier } = await import("@/lib/sync/s3tables-identifier");
    const { resolveTargetTableName } = await import("@/lib/sync/target-naming");
    const legacyNs = sanitizeS3TablesIdentifier(t.s3Config?.namespace || ds.database || "default");
    const legacyTarget = sanitizeS3TablesIdentifier(resolveTargetTableName("Orders", t as any), "Orders");
    expect(c.services).toEqual({ src: "bgp-sources", s3t: "bgp-s3tables", rs: "bgp-redshift", physSrc: "bgp-physical", physTgt: "bgp-physical" });
    expect(c.tables[0].srcFqn).toBe(`bgp-sources.${ds.database}.default.Orders`);
    expect(c.tables[0].s3Fqn).toBe(`bgp-s3tables.bgp-table-bucket.${legacyNs}.${legacyTarget}`);
    expect(c.tables[0].rsFqn).toBe(`bgp-redshift.dev.Analytics.${legacyTarget}`); // 主控区 schema 原样(不小写)= 存量行为
    expect(c.workgroup).toBe("bgp-workgroup");
  });

  it("主控区推送只碰主控区的 service", async () => {
    const { pushSyncToOpenMetadata } = await import("../om-push");
    const { syncOmPlaceOf } = await import("../om-sync-coords");
    await pushSyncToOpenMetadata(task(), ds, syncOmPlaceOf({ targetId: HOME, tableBucket: "" }, null, HOME));
    expect(puts.length).toBeGreaterThan(0);
    expect(servicesTouched()).toEqual([...HOME_SERVICES].sort());
  });

  it("主控区成功回填 = 原来那四个(数仓列 / 表桶列 / 重放同步血缘 / 计算血缘),原顺序", async () => {
    introspectSchemaMock.mockResolvedValue([]);
    const { backfillSyncOmAfterSuccess } = await import("../om-sync-backfill");
    const { syncOmPlaceOf } = await import("../om-sync-coords");
    const r = await backfillSyncOmAfterSuccess(task(), ds, syncOmPlaceOf({ targetId: HOME, tableBucket: "" }, null, HOME));
    expect(r.mode).toBe("home");
    expect(introspectSchemaMock).toHaveBeenCalledWith("bgp-workgroup", "dev", { targetId: HOME, project: null });
    expect(homeCalls).toEqual([`s3tablesPlace:${HOME}`, "repushSyncLineageToOM", "backfillComputeLineageToOM"]);
  });
});

describe("o4-REG ② 其它区:全部落该区的 per-target service", () => {
  it("启动推送:每个 PUT 都在 *-tgt-usw2-a 上,零个落进主控区 service;列级血缘边带列映射", async () => {
    const { pushSyncToOpenMetadata } = await import("../om-push");
    await pushSyncToOpenMetadata(task(), ds, usw2Place);
    const touched = servicesTouched();
    expect(touched).toEqual(HOME_SERVICES.map((s) => `${s}-tgt-usw2-a`).sort());
    for (const h of HOME_SERVICES) expect(touched).not.toContain(h);
    const edges = puts.filter((p) => p.path === "/api/v1/lineage").map((p) => p.body.edge);
    const colEdges = edges.filter((e) => e.lineageDetails?.columnsLineage?.length);
    expect(colEdges.length).toBe(2); // 源 → 湖、湖 → 数仓
    const toCols = colEdges.flatMap((e) => e.lineageDetails.columnsLineage.map((x: any) => x.toColumn));
    expect(toCols).toContain("bgp-redshift-tgt-usw2-a.dev.analytics.orders.amt");
    expect(toCols).toContain("bgp-s3tables-tgt-usw2-a.bgp-tb-tgt-usw2-a.game_data.orders.id");
  });

  it("③ 数仓表实体与目录同步(om-mirror-push)是同一个 OM 实体(FQN 逐字相等)", async () => {
    const { syncOmCoords } = await import("../om-sync-coords");
    const { pushMirrorToOpenMetadata } = await import("../om-mirror-push");
    const c = syncOmCoords(task(), ds, usw2Place);
    // 目录同步读回来的是 SVV_ALL_TABLES 的小写库 / schema / 表名
    await pushMirrorToOpenMetadata({ targetId: T, entries: [{ kind: "table", fqn: "redshift.dev.analytics.orders", payload: { columns: [] } }] });
    const mirrorTable = puts.filter((p) => p.path === "/api/v1/tables").map((p) => `${p.body.databaseSchema}.${p.body.name}`);
    expect(mirrorTable).toEqual([c.tables[0].rsFqn]);
  });

  it("建数据源推的源表与同步推的源表是同一个实体(按源落点选 service)", async () => {
    const { pushDataSourceToOpenMetadata } = await import("../om-push");
    const { syncOmCoords } = await import("../om-sync-coords");
    await pushDataSourceToOpenMetadata({ database: "gamedata" }, [{ name: "Orders", columns: [{ name: "id" }] }], T);
    const fqns = puts.filter((p) => p.path === "/api/v1/tables").map((p) => `${p.body.databaseSchema}.${p.body.name}`);
    expect(fqns).toEqual([syncOmCoords(task(), ds, usw2Place).tables[0].srcFqn]);
    expect(fqns[0].startsWith("bgp-sources-tgt-usw2-a.")).toBe(true);
  });

  it("④ 落点缺表桶(写湖)⇒ 一个 PUT 都不发,绝不回落 bgp-table-bucket", async () => {
    const { pushSyncToOpenMetadata } = await import("../om-push");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await pushSyncToOpenMetadata(task(), ds, { ...usw2Place, tableBucket: null });
    expect(puts).toEqual([]);
    expect(String(err.mock.calls[0]?.slice(1).join(" "))).toContain("缺表桶");
    err.mockRestore();
  });

  it("④ 落点缺库名(写数仓)⇒ 一个 PUT 都不发,绝不回落 dev", async () => {
    const { pushSyncToOpenMetadata } = await import("../om-push");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await pushSyncToOpenMetadata(task({ targetType: "redshift" }), ds, { ...usw2Place, rsDatabase: null });
    expect(puts).toEqual([]);
    err.mockRestore();
  });
});

describe("o4-REG 成功回填(其它区):只回填这个任务、只在该区取真实列", () => {
  it("真实列写进该区 service + 用真实列重推列级血缘(全表同步无字段映射也有列级)", async () => {
    introspectSchemaMock.mockResolvedValue([
      { schema: "analytics", table: "orders", columns: [{ name: "id", type: "int" }, { name: "amt", type: "numeric" }] },
      { schema: "analytics", table: "unrelated", columns: [{ name: "x", type: "int" }] },
      { schema: "public", table: "orders", columns: [{ name: "y", type: "int" }] },
    ]);
    introspectS3TablesMock.mockResolvedValue([{ schema: "game_data", table: "orders", columns: [{ name: "id", type: "int" }, { name: "amt", type: "decimal" }] }]);
    const { backfillSyncOmAfterSuccess } = await import("../om-sync-backfill");
    const r = await backfillSyncOmAfterSuccess(task({ fieldMappings: undefined }), ds, usw2Place);
    expect(r).toMatchObject({ mode: "target", targetId: T, rsTables: 1, s3Tables: 1, lineageRepushed: true, errors: [] });
    // 只在该区读(落点四样逐字来自 place)
    expect(introspectSchemaMock).toHaveBeenCalledWith("bgp-wg-tgt-usw2-a", "DEV", { targetId: T, project: "p1" });
    expect(introspectS3TablesMock).toHaveBeenCalledWith("game_data", { targetId: T });
    // 别的表 / 别的 schema 一张不碰
    const tablePuts = puts.filter((p) => p.path === "/api/v1/tables").map((p) => `${p.body.databaseSchema}.${p.body.name}`);
    expect(tablePuts.some((f) => f.endsWith(".unrelated") || f.includes(".public."))).toBe(false);
    expect(servicesTouched().every((s) => s.endsWith("-tgt-usw2-a"))).toBe(true);
    expect(homeCalls).toEqual([]); // 主控区口径的回填一个都没跑
    // 全表同步:列级血缘由真实列派生(数仓 orders 的 amt)
    const toCols = puts
      .filter((p) => p.path === "/api/v1/lineage")
      .flatMap((p) => (p.body.edge.lineageDetails?.columnsLineage || []).map((x: any) => x.toColumn));
    expect(toCols).toContain("bgp-redshift-tgt-usw2-a.dev.analytics.orders.amt");
  });

  it("🔴 刚成功却在该区读不到目标表 ⇒ 如实报错(不许「成功地什么都没回填」)", async () => {
    introspectSchemaMock.mockResolvedValue([]);
    introspectS3TablesMock.mockResolvedValue([]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { backfillSyncOmAfterSuccess } = await import("../om-sync-backfill");
    const r = await backfillSyncOmAfterSuccess(task(), ds, usw2Place);
    expect(r.errors.map((e) => e.step).sort()).toEqual(["redshift-columns", "s3tables-columns"]);
    err.mockRestore();
  });

  it("该区数据面读失败 ⇒ 报错且仍重推血缘(元数据旁路不抛)", async () => {
    introspectSchemaMock.mockRejectedValue(new Error("AccessDenied"));
    introspectS3TablesMock.mockResolvedValue([{ schema: "game_data", table: "orders", columns: [{ name: "id", type: "int" }] }]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { backfillSyncOmAfterSuccess } = await import("../om-sync-backfill");
    const r = await backfillSyncOmAfterSuccess(task(), ds, usw2Place);
    expect(r.errors).toEqual([{ step: "redshift-columns", error: "AccessDenied" }]);
    expect(r.lineageRepushed).toBe(true);
    err.mockRestore();
  });
});
