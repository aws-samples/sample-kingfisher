// 🔴 行为判据(路由层):建任务 / 改任务 / 生成 DDL / 执行 DDL 四个入口对「客户已有的表」的处理。
//   只 mock 真外部:DynamoDB、身份、注册表 / 凭证解析、Redshift Data API。
//   假 Redshift 按 SQL 内容作答(查的是夹具 EXISTING 的「库中现有表 + 注释」),并记下每一条语句 ——
//   于是「拒绝之前有没有发过写语句」「建表之后有没有打标记」都是可观察的事实,不是自编返回值。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  ddb: [] as string[],
  sql: [] as string[],
  existing: {} as Record<string, string>,
  task: {} as Record<string, unknown>,
  ds: { userId: "default-user", datasourceId: "D1", type: "mysql", database: "gamedata", projectId: "p1" } as Record<string, unknown>,
}));

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SYNC_TASKS: "bgp-sync-tasks", DATASOURCES: "bgp-datasources" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      h.ddb.push(cmd.constructor.name);
      if (cmd.constructor.name === "GetCommand") return { Item: cmd.input?.Key?.datasourceId ? h.ds : h.task };
      if (cmd.constructor.name === "UpdateCommand") return { Attributes: { ...h.task } };
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
// 入口点名改为「已注册且装好」(requestedRegisteredPlace)⇒ 注册表是真外部(DDB 边界),给夹具描述符
vi.mock("@/lib/exec-env/registry", async (orig) => {
  const real: any = await orig();
  const mk = (targetId: string, region: string) => ({ targetId, region, accountId: "000000000000", partition: "aws", status: "active", ready: true, components: ["core"], resources: {} });
  const known: Record<string, unknown> = { tgt_home: mk("tgt_home", "us-east-1"), tgt_usw2_a: mk("tgt_usw2_a", "us-west-2") };
  return { ...real, getTargetRaw: vi.fn(async (id: string) => known[id] ?? null), descriptorViolation: vi.fn(() => null) };
});
vi.mock("@/lib/security/query-handle", () => ({ issueHandle: vi.fn(async () => "h1") }));
vi.mock("@/lib/versions/version-service", () => ({ snapshotVersion: vi.fn(async () => {}) }));
vi.mock("@/lib/governance/lineage-service", () => ({ generateSyncLineage: vi.fn(async () => {}), recordComputeLineage: vi.fn(async () => {}) }));
vi.mock("@/lib/exec-env/data-plane-target", async (orig) => {
  const real: any = await orig();
  return { ...real, resolveRedshiftBinding: vi.fn(async (a: { targetId: string }) => ({ targetId: a.targetId, region: "us-east-1", workgroup: "wg", database: "dev", secretArn: "arn:s" })) };
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

const req = async (mod: string, body: Record<string, unknown>, method = "POST", params?: Record<string, string>) => {
  const m: any = await import(mod);
  const { NextRequest } = await import("next/server");
  const r = new NextRequest("http://x/api/sync", { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const res = await m[method](r, params ? { params } : undefined);
  return { status: res.status, body: await res.json() };
};
const writes = () => h.sql.filter((s) => !/^\s*SELECT/i.test(s));
const base = { name: "t", datasourceId: "D1", targetType: "redshift", channel: "glue", syncMode: "full", sourceDatabase: "gamedata", sourceTables: ["Orders"], targets: ["tgt_home"] };

beforeEach(() => { h.ddb.length = 0; h.sql.length = 0; h.existing = {}; vi.resetModules(); });

describe("🔴 建任务 POST /api/sync", () => {
  it("缺 writeMode ⇒ 400,零落库(不再缺省成 overwrite)", async () => {
    const r = await req("../route", { ...base });
    expect(r.status).toBe(400);
    expect(h.ddb).not.toContain("PutCommand");
  });
  it("overwrite + 客户已有的同名表(无平台标记)⇒ 409 DECISION_REQUIRED 列出该表,零落库", async () => {
    h.existing = { "public.orders": "客户自己的注释" };
    const r = await req("../route", { ...base, writeMode: "overwrite" });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error.code).toBe("DECISION_REQUIRED");
    expect(r.body.error.detail).toEqual({ kind: "overwrite-foreign-tables", tables: ["public.orders"] });
    expect(h.ddb).not.toContain("PutCommand");
    expect(writes()).toEqual([]);
  });
  it("正控制:用户逐表确认后 ⇒ 落库,且确认清单随任务存下", async () => {
    h.existing = { "public.orders": "" };
    const r = await req("../route", { ...base, writeMode: "overwrite", overwriteConfirmedTables: ["public.orders"] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.overwriteConfirmedTables).toEqual(["public.orders"]);
  });
  it("正控制:平台建的表(带标记)⇒ 不用确认", async () => {
    h.existing = { "public.orders": "bgp-platform-created" };
    expect((await req("../route", { ...base, writeMode: "overwrite" })).status).toBe(201);
  });
  it("append 不整表清空 ⇒ 不探测、直接落库", async () => {
    h.existing = { "public.orders": "" };
    expect((await req("../route", { ...base, writeMode: "append" })).status).toBe(201);
    expect(h.sql).toEqual([]);
  });
});

describe("🔴 改任务 PUT /api/sync/[id]:按改完之后的整条任务判", () => {
  it("把 append 改成 overwrite、目标是客户已有表 ⇒ 409,不写库", async () => {
    h.task = { ...base, taskId: "T1", projectId: "p1", writeMode: "append" };
    h.existing = { "public.orders": "" };
    const r = await req("../[id]/route", { writeMode: "overwrite" }, "PUT", { id: "T1" });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(h.ddb).not.toContain("UpdateCommand");
  });
  it("把 writeMode 改成非法值 ⇒ 400", async () => {
    h.task = { ...base, taskId: "T1", projectId: "p1", writeMode: "append" };
    expect((await req("../[id]/route", { writeMode: "replace" }, "PUT", { id: "T1" })).status).toBe(400);
  });
});

const spec = { tableName: "Orders", columns: [{ name: "id", type: "int" }], targetId: "tgt_home" };
describe("🔴 执行 DDL:不再执行客户端的 SQL", () => {
  it("请求体带 ddl 文本 ⇒ 400,一条语句都不发(即使建表参数齐全 —— 判别力:不是靠参数缺失才拒)", async () => {
    const r = await req("../execute-ddl/route", { ...spec, ddl: "DROP TABLE public.orders" });
    expect(r.status).toBe(400);
    expect(h.sql).toEqual([]);
  });
  it("目标表已存在 ⇒ 409,**不打标记**(否则客户的表会被冒认成平台建的)", async () => {
    h.existing = { "public.orders": "" };
    const r = await req("../execute-ddl/route", spec);
    expect(r.status).toBe(409);
    expect(writes()).toEqual([]);
  });
  it("新表 ⇒ 服务端生成的 CREATE + 平台标记,按这个顺序", async () => {
    const r = await req("../execute-ddl/route", spec);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const w = writes();
    expect(w[0]).toMatch(/^CREATE TABLE IF NOT EXISTS public\.orders \(/);
    expect(w[1]).toBe("COMMENT ON TABLE public.orders IS 'bgp-platform-created'");
    expect(w).toHaveLength(2);
  });
});

describe("🔴 生成 DDL:「表已存在」检测不再恒为假", () => {
  it("客户已有表 ⇒ tableExists=true、platformCreated=false;探测 SQL 里 schema 不带双引号", async () => {
    h.existing = { "public.orders": "" };
    const r = await req("../generate-ddl/route", spec);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ table: "public.orders", tableExists: true, platformCreated: false });
    expect(h.sql[0]).toContain("n.nspname = 'public'");
    expect(h.sql[0]).not.toContain(`'"public"'`);
  });
  it("新表 ⇒ tableExists=false", async () => {
    expect((await req("../generate-ddl/route", spec)).body.data.tableExists).toBe(false);
  });
});
