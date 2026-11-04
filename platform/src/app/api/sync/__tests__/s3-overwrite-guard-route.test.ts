// @kf-batch 37-sync-capability —— 序 37 B-60:建任务 / 改任务对「客户已有的 S3 Tables 表」的提前告知(路由层行为判据)。
//   mock 形态照抄 overwrite-guard-route.test.ts(只 mock 真外部:DDB、身份、注册表 / 落点解析、Redshift Data API、
//   S3 Tables 控制面 + S3 对象读)。假 S3 Tables 按夹具 EXISTING 作答:GetTable 不存在 ⇒ NotFoundException;存在 ⇒
//   metadataLocation,再由假 S3 回那张表的 Iceberg 元数据 JSON(properties 就是夹具里给的)。
//   B-61:merge 任务的合并键校验(400)与「merge 不需要确认」。
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const h = vi.hoisted(() => ({
  ddb: [] as string[],
  updates: [] as Record<string, unknown>[],
  sql: [] as string[],
  existing: {} as Record<string, string>,                 // Redshift:schema.table → 注释
  s3existing: {} as Record<string, Record<string, string>>, // S3 Tables:ns.table → 表属性
  s3fail: "" as "" | "list" | "get-table" | "get-object",
  s3calls: [] as string[],
  task: {} as Record<string, unknown>,
  ds: { userId: "default-user", datasourceId: "D1", type: "mysql", database: "gamedata", projectId: "p1" } as Record<string, unknown>,
}));

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SYNC_TASKS: "bgp-sync-tasks", DATASOURCES: "bgp-datasources" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      h.ddb.push(cmd.constructor.name);
      if (cmd.constructor.name === "GetCommand") return { Item: cmd.input?.Key?.datasourceId ? h.ds : h.task };
      if (cmd.constructor.name === "UpdateCommand") { h.updates.push(cmd.input); return { Attributes: { ...h.task } }; }
      return {};
    }),
  },
}));
vi.mock("@/lib/projects/guard", () => ({
  requireProject: vi.fn(async () => ({ identity: { username: "admin", sub: "s" }, projectId: "p1", role: "editor" })),
  guardResourceAccess: vi.fn(async () => ({ identity: { username: "admin" }, projectId: "p1" })),
  projectFilter: vi.fn(() => ({ clause: "1=1", values: {} })),
  getActiveEnv: vi.fn(() => "dev"),
  envFilter: vi.fn(() => ({ clause: "1=1", values: {} })),
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real: any = await orig();
  const mk = (targetId: string, region: string) => ({ targetId, region, accountId: "000000000000", partition: "aws", status: "active", ready: true, components: ["core"], resources: {} });
  const known: Record<string, unknown> = { tgt_home: mk("tgt_home", "us-east-1") };
  return { ...real, getTargetRaw: vi.fn(async (id: string) => known[id] ?? null), descriptorViolation: vi.fn(() => null) };
});
vi.mock("@/lib/security/query-handle", () => ({ issueHandle: vi.fn(async () => "h1") }));
vi.mock("@/lib/versions/version-service", () => ({ snapshotVersion: vi.fn(async () => {}) }));
vi.mock("@/lib/governance/lineage-service", () => ({ generateSyncLineage: vi.fn(async () => {}), recordComputeLineage: vi.fn(async () => {}) }));
vi.mock("@/lib/exec-env/data-plane-target", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    resolveRedshiftBinding: vi.fn(async (a: { targetId: string }) => ({ targetId: a.targetId, region: "us-east-1", workgroup: "wg", database: "dev", secretArn: "arn:s" })),
    resolveGlueBinding: vi.fn(async (a: { targetId: string }) => ({ targetId: a.targetId, region: "us-east-1", scriptsBucket: "bgp-glue-scripts-x", roleArn: "arn:aws:iam::000000000000:role/r", datalakeBucket: "bgp-datalake-x", tableBucket: "bgp-table-bucket", home: true, jurisdiction: "home" })),
  };
});
vi.mock("@aws-sdk/client-redshift-data", () => {
  const mk = (n: string) => { const C = class { constructor(public input: any) {} }; Object.defineProperty(C, "name", { value: n }); return C; };
  const q: Record<string, string> = {};
  class RedshiftDataClient {
    async send(cmd: any) {
      const n = cmd.constructor.name;
      if (n === "ExecuteStatementCommand") { h.sql.push(cmd.input.Sql); const id = String(h.sql.length); q[id] = cmd.input.Sql; return { Id: id }; }
      if (n === "DescribeStatementCommand") return { Status: "FINISHED", HasResultSet: /^\s*SELECT/i.test(q[cmd.input.Id]) };
      if (n === "GetStatementResultCommand") {
        const sql = q[cmd.input.Id];
        const recs = [...sql.matchAll(/n\.nspname = '([^']+)' AND c\.relname = '([^']+)'/g)]
          .map((m) => `${m[1]}.${m[2]}`).filter((fq) => fq in h.existing)
          .map((fq) => { const [s, t] = fq.split("."); return [{ stringValue: s }, { stringValue: t }, { stringValue: h.existing[fq] }]; });
        return { Records: recs };
      }
      return {};
    }
  }
  return { RedshiftDataClient, ExecuteStatementCommand: mk("ExecuteStatementCommand"), DescribeStatementCommand: mk("DescribeStatementCommand"), GetStatementResultCommand: mk("GetStatementResultCommand") };
});
// 假 S3 Tables 控制面 + 假 S3 对象读:按夹具作答、记下每一次调用(「没探」「探了几次」都是可观察的事实)
vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real: any = await orig();
  const notFound = () => Object.assign(new Error("The specified table does not exist"), { name: "NotFoundException" });
  const s3tables = {
    send: async (cmd: any) => {
      const n = cmd.constructor.name;
      h.s3calls.push(`s3tables:${n}`);
      if (n === "ListTableBucketsCommand") {
        if (h.s3fail === "list") throw new Error("AccessDenied: s3tables:ListTableBuckets");
        return { tableBuckets: [{ name: "bgp-table-bucket", arn: "arn:aws:s3tables:us-east-1:000000000000:bucket/bgp-table-bucket" }] };
      }
      if (n === "GetTableCommand") {
        if (h.s3fail === "get-table") throw new Error("AccessDenied: s3tables:GetTable");
        const fq = `${cmd.input.namespace}.${cmd.input.name}`;
        if (!(fq in h.s3existing)) throw notFound();
        return { metadataLocation: `s3://0123-table-s3/metadata/${fq}.metadata.json` };
      }
      return {};
    },
  };
  const s3 = {
    send: async (cmd: any) => {
      const n = cmd.constructor.name;
      h.s3calls.push(`s3:${n}`);
      if (n === "GetObjectCommand") {
        if (h.s3fail === "get-object") throw new Error("AccessDenied: s3:GetObject");
        const fq = String(cmd.input.Key).replace(/^metadata\//, "").replace(/\.metadata\.json$/, "");
        return { Body: { transformToString: async () => JSON.stringify({ "format-version": 2, properties: h.s3existing[fq] || {} }) } };
      }
      return {};
    },
  };
  return { ...real, s3tablesClientFor: vi.fn(async () => s3tables), s3ClientFor: vi.fn(async () => s3) };
});

const req = async (mod: string, body: Record<string, unknown>, method = "POST", params?: Record<string, string>) => {
  const m: any = await import(mod);
  const { NextRequest } = await import("next/server");
  const r = new NextRequest("http://x/api/sync", { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const res = await m[method](r, params ? { params } : undefined);
  return { status: res.status, body: await res.json() };
};
const MARK = { "bgp.created-by": "bgp-platform-created" };
const base = { name: "t", datasourceId: "D1", targetType: "s3-tables", channel: "glue", syncMode: "full", sourceDatabase: "gamedata", sourceTables: ["Orders"], targets: ["tgt_home"] };
const S3FQ = "s3tablescatalog.gamedata.orders";

beforeEach(() => {
  h.ddb.length = 0; h.updates.length = 0; h.sql.length = 0; h.s3calls.length = 0;
  h.existing = {}; h.s3existing = {}; h.s3fail = "";
  h.ds = { userId: "default-user", datasourceId: "D1", type: "mysql", database: "gamedata", projectId: "p1" };
  vi.resetModules();
});

describe("🔴 B-60 建任务 POST /api/sync:S3 Tables 目标的提前告知", () => {
  it("overwrite + 客户已有的同名 S3 表(没有平台标记)⇒ 409 DECISION_REQUIRED,清单是三段名,零落库", async () => {
    h.s3existing = { "gamedata.orders": { "format-version": "2" } };
    const r = await req("../route", { ...base, writeMode: "overwrite" });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error.code).toBe("DECISION_REQUIRED");
    expect(r.body.error.detail).toEqual({ kind: "overwrite-foreign-tables", tables: [S3FQ] });
    expect(h.ddb).not.toContain("PutCommand");
    expect(h.s3calls).toEqual(["s3tables:ListTableBucketsCommand", "s3tables:GetTableCommand", "s3:GetObjectCommand"]);
  });
  it("namespace 缺省取数据源库名;任务自带 s3Config.namespace 时用它(安全化)", async () => {
    h.s3existing = { "shop_db.orders": {} };
    const r = await req("../route", { ...base, writeMode: "overwrite", s3Config: { namespace: "Shop-DB" } });
    expect(r.status).toBe(409);
    expect(r.body.error.detail.tables).toEqual(["s3tablescatalog.shop_db.orders"]);
  });
  it("正控制①:用户带三段名确认 ⇒ 201,确认清单随任务存下", async () => {
    h.s3existing = { "gamedata.orders": {} };
    const r = await req("../route", { ...base, writeMode: "overwrite", overwriteConfirmedTables: [S3FQ] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.overwriteConfirmedTables).toEqual([S3FQ]);
  });
  it("正控制②:平台建的表(属性带标记)⇒ 不用确认", async () => {
    h.s3existing = { "gamedata.orders": MARK };
    expect((await req("../route", { ...base, writeMode: "overwrite" })).status).toBe(201);
  });
  it("正控制③:表不存在(GetTable NotFound)⇒ 201", async () => {
    expect((await req("../route", { ...base, writeMode: "overwrite" })).status).toBe(201);
    expect(h.s3calls).toEqual(["s3tables:ListTableBucketsCommand", "s3tables:GetTableCommand"]);
  });
  it("探不到(ListTableBuckets / GetTable / 读元数据任一步失败)⇒ unknown,不拦创建(防线在脚本)", async () => {
    h.s3existing = { "gamedata.orders": {} };
    for (const f of ["list", "get-table", "get-object"] as const) {
      h.s3fail = f;
      vi.resetModules();
      expect((await req("../route", { ...base, writeMode: "overwrite" })).status, f).toBe(201);
    }
  });
  it("append 不清表 ⇒ 不探 S3 Tables;merge(带键)也不探 —— merge 不清表", async () => {
    h.s3existing = { "gamedata.orders": {} };
    expect((await req("../route", { ...base, writeMode: "append" })).status).toBe(201);
    expect(h.s3calls).toEqual([]);
    expect((await req("../route", { ...base, writeMode: "merge", mergeKeys: ["id"] })).status).toBe(201);
    expect(h.s3calls).toEqual([]);
  });
  it("both:Redshift 与 S3 两边都是外来表 ⇒ 一次 409 把两种形态都列出来(排序去重)", async () => {
    h.existing = { "public.orders": "" };
    h.s3existing = { "gamedata.orders": {} };
    const r = await req("../route", { ...base, targetType: "both", writeMode: "overwrite" });
    expect(r.status).toBe(409);
    expect(r.body.error.detail.tables).toEqual(["public.orders", S3FQ]);
  });
  it("both:S3 探不到但 Redshift 探出外来表 ⇒ 仍 409(先把能确定的列给用户)", async () => {
    h.existing = { "public.orders": "" };
    h.s3fail = "list";
    const r = await req("../route", { ...base, targetType: "both", writeMode: "overwrite" });
    expect(r.status).toBe(409);
    expect(r.body.error.detail.tables).toEqual(["public.orders"]);
  });
  it("确认清单形态:三段名合法;别的三段 / 大写 ⇒ 400", async () => {
    expect((await req("../route", { ...base, writeMode: "overwrite", overwriteConfirmedTables: ["glue.gamedata.orders"] })).status).toBe(400);
    expect((await req("../route", { ...base, writeMode: "overwrite", overwriteConfirmedTables: ["s3tablescatalog.gamedata.Orders"] })).status).toBe(400);
  });
});

describe("🔴 B-61 建任务:merge 必须带合并键", () => {
  it("merge 没键 ⇒ 400(中文点名 mergeKeys),零落库;有键 ⇒ 201 且键随任务存下", async () => {
    const r = await req("../route", { ...base, writeMode: "merge" });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/合并键|mergeKeys/);
    expect(h.ddb).not.toContain("PutCommand");
    const ok = await req("../route", { ...base, writeMode: "merge", mergeKeys: ["id"] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.mergeKeys).toEqual(["id"]);
  });
  it("非法键名 ⇒ 400", async () => {
    expect((await req("../route", { ...base, writeMode: "merge", mergeKeys: ["id-1"] })).status).toBe(400);
  });
});

describe("🔴 改任务 PUT /api/sync/[id]", () => {
  it("把 append 改成 overwrite、S3 目标是客户已有表、任务没自带 namespace ⇒ 读一次数据源取库名 ⇒ 409,不写库", async () => {
    h.task = { ...base, taskId: "T1", projectId: "p1", writeMode: "append" };
    h.s3existing = { "gamedata.orders": {} };
    const r = await req("../[id]/route", { writeMode: "overwrite" }, "PUT", { id: "T1" });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error.detail.tables).toEqual([S3FQ]);
    expect(h.ddb).not.toContain("UpdateCommand");
    expect(h.ddb.filter((x) => x === "GetCommand")).toHaveLength(2); // 任务行 + 数据源行
  });
  it("改成 merge 不带键 ⇒ 400;带键 ⇒ 200 且不探 S3", async () => {
    h.task = { ...base, taskId: "T1", projectId: "p1", writeMode: "append" };
    h.s3existing = { "gamedata.orders": {} };
    expect((await req("../[id]/route", { writeMode: "merge" }, "PUT", { id: "T1" })).status).toBe(400);
    const ok = await req("../[id]/route", { writeMode: "merge", mergeKeys: ["id"] }, "PUT", { id: "T1" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(h.s3calls).toEqual([]);
  });
  it("客户端传来的 foreignGuardAdoptedAt 被剔除(只有服务端写)", async () => {
    h.task = { ...base, taskId: "T1", projectId: "p1", writeMode: "append" };
    const r = await req("../[id]/route", { name: "renamed", foreignGuardAdoptedAt: "2026-01-01T00:00:00Z" }, "PUT", { id: "T1" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.updates).toHaveLength(1);
    const names = Object.values((h.updates[0].ExpressionAttributeNames || {}) as Record<string, string>);
    expect(names).toContain("name");
    expect(names).not.toContain("foreignGuardAdoptedAt");
  });
});
