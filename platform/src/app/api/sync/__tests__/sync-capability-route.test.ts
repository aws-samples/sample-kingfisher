// 新字段在建任务 / 改任务两个入口的校验(路由层行为判据)。
//   mock 形态照抄 overwrite-guard-route.test.ts(只 mock 真外部);断「拒绝时没有落库」与「存量保存不多读数据源」。
import { describe, it, expect, vi, beforeEach } from "vitest";

// 首个用例要冷加载整条路由(几百个模块),负载高时会超过默认 5 秒;放宽到 30 秒,不影响判据本身。
vi.setConfig({ testTimeout: 30_000 });

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
const base = { name: "t", datasourceId: "D1", targetType: "redshift", channel: "glue", syncMode: "full", writeMode: "append", sourceDatabase: "gamedata", sourceTables: ["Orders"], targets: ["tgt_home"] };

beforeEach(() => { h.ddb.length = 0; h.sql.length = 0; h.existing = {}; h.ds = { userId: "default-user", datasourceId: "D1", type: "mysql", database: "gamedata", projectId: "p1" }; vi.resetModules(); });

describe("建任务入口校验新字段", () => {
  it("过滤条件带未知变量 ⇒ 400,不落库", async () => {
    const r = await req("@/app/api/sync/route", { ...base, whereClause: "d = '${today}'" });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/不支持的变量/);
    expect(h.ddb).not.toContain("PutCommand");
  });
  it("非 JDBC 源填过滤条件 ⇒ 400,不落库", async () => {
    // 起「有没有活可干」按范式判:非 JDBC 源的定位在连接袋里(DynamoDB = tableName),夹具要像真的数据源行一样带上
    h.ds = { ...h.ds, type: "dynamodb", connection: { tableName: "orders", region: "us-east-1" } };
    const r = await req("@/app/api/sync/route", { ...base, whereClause: "x > 1" });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/JDBC/);
    expect(h.ddb).not.toContain("PutCommand");
  });
  it("合法的过滤条件 + 表名模板 ⇒ 201 落库,字段原样存", async () => {
    const tpl = "orders_${bizmonth}";
    const r = await req("@/app/api/sync/route", { ...base, whereClause: "d >= '${run_date}'", sourceTables: [tpl], targetTableNames: { [tpl]: "ods_orders" } });
    expect(r.status).toBe(201);
    expect(h.ddb).toContain("PutCommand");
    expect(r.body.data?.whereClause ?? r.body.whereClause).toBe("d >= '${run_date}'");
  });
  it("表名模板没给固定目标表名 ⇒ 400", async () => {
    const r = await req("@/app/api/sync/route", { ...base, sourceTables: ["orders_${bizmonth}"] });
    expect(r.status).toBe(400);
    expect(h.ddb).not.toContain("PutCommand");
  });
  it("普通表(月表实例)的目标名与模板的固定目标名撞车 ⇒ 400 点名样例表,不落库;带样例表的合法任务 ⇒ 201 且样例原样存", async () => {
    const tpl = "orders_${bizmonth}";
    const clash = await req("@/app/api/sync/route", { ...base, sourceTables: ["orders_202609", tpl], targetTableNames: { [tpl]: "ods_orders", orders_202609: "ods_orders" } });
    expect(clash.status).toBe(400);
    expect(JSON.stringify(clash.body)).toMatch(/样例表/);
    expect(h.ddb).not.toContain("PutCommand");
    const ok = await req("@/app/api/sync/route", { ...base, sourceTables: [tpl], targetTableNames: { [tpl]: "ods_orders" }, templateSampleTables: { [tpl]: "orders_202609" } });
    expect(ok.status).toBe(201);
    expect(h.ddb).toContain("PutCommand");
    expect(ok.body.data?.templateSampleTables ?? ok.body.templateSampleTables).toEqual({ [tpl]: "orders_202609" });
    const badKey = await req("@/app/api/sync/route", { ...base, sourceTables: [tpl], targetTableNames: { [tpl]: "ods_orders" }, templateSampleTables: { orders: "orders_202609" } });
    expect(badKey.status).toBe(400);
  });
});

describe("改任务入口校验新字段", () => {
  it("改成按分区覆盖却没给分区列 ⇒ 400,不写", async () => {
    h.task = { ...base, userId: "default-user", taskId: "T1", projectId: "p1" };
    const r = await req("@/app/api/sync/[id]/route", { writeMode: "overwrite", overwriteScope: "partitions" }, "PUT", { id: "T1" });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/分区列/);
    expect(h.ddb).not.toContain("UpdateCommand");
  });
  it("存量任务改名(不涉及新字段)⇒ 照常保存,且不多读一次数据源", async () => {
    h.task = { ...base, userId: "default-user", taskId: "T1", projectId: "p1" };
    const r = await req("@/app/api/sync/[id]/route", { name: "renamed" }, "PUT", { id: "T1" });
    expect(r.status).toBe(200);
    expect(h.ddb.filter((n) => n === "GetCommand")).toHaveLength(1);
    expect(h.ddb).toContain("UpdateCommand");
  });
  it("改出一个带变量的过滤条件 ⇒ 读数据源判范式;DynamoDB 源 ⇒ 400", async () => {
    h.task = { ...base, userId: "default-user", taskId: "T1", projectId: "p1" };
    // 起「有没有活可干」按范式判:非 JDBC 源的定位在连接袋里(DynamoDB = tableName),夹具要像真的数据源行一样带上
    h.ds = { ...h.ds, type: "dynamodb", connection: { tableName: "orders", region: "us-east-1" } };
    const r = await req("@/app/api/sync/[id]/route", { whereClause: "d = '${ds}'" }, "PUT", { id: "T1" });
    expect(r.status).toBe(400);
    expect(h.ddb).not.toContain("UpdateCommand");
  });
  it("存量 DynamoDB 任务带着从前不生效的过滤条件,做一次无关编辑 ⇒ 照常保存(不读数据源)", async () => {
    h.task = { ...base, userId: "default-user", taskId: "T1", projectId: "p1", whereClause: "x > 1" };
    // 起「有没有活可干」按范式判:非 JDBC 源的定位在连接袋里(DynamoDB = tableName),夹具要像真的数据源行一样带上
    h.ds = { ...h.ds, type: "dynamodb", connection: { tableName: "orders", region: "us-east-1" } };
    const r = await req("@/app/api/sync/[id]/route", { name: "renamed", whereClause: "x > 1" }, "PUT", { id: "T1" });
    expect(r.status).toBe(200);
    expect(h.ddb.filter((n) => n === "GetCommand")).toHaveLength(1);
  });
});
