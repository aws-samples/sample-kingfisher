// @kf-batch 44-sync-switch-datasource —— `PUT /api/sync/[id]` 换数据源(用户 2026-10-15 反馈 ②「同步任务切换个数据源,没法保存」;…7698 页面探针坐实)。
//   mock 形态照抄 sync-capability-route.test.ts(只 mock 真外部:DynamoDB / 注册表 / 数仓 Data API)。
//   钉:① 换源 + 表单回显的旧 sourceDatabase ⇒ 落库的是**新源的库名**(不是请求体里的旧值);② 新源不存在 ⇒ 404 不落库;
//      ③ 新源在别的区 ⇒ 409 CROSS_REGION_SOURCE 不落库、拒因点名两个执行环境;④ 没换源的保存不多读数据源行;⑤ 新源没有 database(非 JDBC)⇒ 不碰 sourceDatabase。
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const h = vi.hoisted(() => ({
  ddb: [] as Array<{ name: string; key?: Record<string, unknown>; input?: Record<string, unknown> }>,
  task: {} as Record<string, unknown>,
  dsById: {} as Record<string, Record<string, unknown> | undefined>,
}));

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SYNC_TASKS: "bgp-sync-tasks", DATASOURCES: "bgp-datasources" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      h.ddb.push({ name: cmd.constructor.name, key: cmd.input?.Key, input: cmd.input });
      if (cmd.constructor.name === "GetCommand") {
        if (cmd.input?.Key?.datasourceId) return { Item: h.dsById[String(cmd.input.Key.datasourceId)] };
        return { Item: h.task };
      }
      if (cmd.constructor.name === "UpdateCommand") {
        // 按 #fN → 字段名、:vN → 值 还原 SET 的结果(与 DynamoDB ALL_NEW 等价)
        const names = (cmd.input?.ExpressionAttributeNames ?? {}) as Record<string, string>;
        const values = (cmd.input?.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        for (const [alias, field] of Object.entries(names)) { const v = values[alias.replace(/^#f/, ":v")]; if (v !== undefined) patch[field] = v; }
        return { Attributes: { ...h.task, ...patch } };
      }
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
  class RedshiftDataClient {
    async send(cmd: any) {
      const n = cmd.constructor.name;
      if (n === "ExecuteStatementCommand") return { Id: "1" };
      if (n === "DescribeStatementCommand") return { Status: "FINISHED", HasResultSet: true };
      if (n === "GetStatementResultCommand") return { Records: [] };
      return {};
    }
  }
  return { RedshiftDataClient, ExecuteStatementCommand: mk("ExecuteStatementCommand"), DescribeStatementCommand: mk("DescribeStatementCommand"), GetStatementResultCommand: mk("GetStatementResultCommand") };
});

const put = async (body: Record<string, unknown>) => {
  const m: any = await import("../[id]/route");
  const { NextRequest } = await import("next/server");
  const r = new NextRequest("http://x/api/sync/T1", { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const res = await m.PUT(r, { params: { id: "T1" } });
  return { status: res.status, body: await res.json() };
};
const TASK = { userId: "default-user", taskId: "T1", name: "t", datasourceId: "D1", targetType: "redshift", channel: "glue", syncMode: "full", writeMode: "append", sourceDatabase: "gamedata", sourceTables: ["Orders"], targets: ["tgt_home"], projectId: "p1", status: "draft" };
// 编辑表单用整条记录预填后原样 PUT 回来:带着旧 sourceDatabase
const ECHO = { name: "t", datasourceId: "D1", targetType: "redshift", channel: "glue", syncMode: "full", writeMode: "append", sourceDatabase: "gamedata", sourceTables: ["Orders"], fieldMappings: { Orders: [] } };
const update = () => h.ddb.find((c) => c.name === "UpdateCommand")?.input as Record<string, any> | undefined;
const setValue = (name: string) => {
  const u = update(); if (!u) return undefined;
  const alias = Object.entries(u.ExpressionAttributeNames as Record<string, string>).find(([, v]) => v === name)?.[0];
  return alias ? (u.ExpressionAttributeValues as Record<string, unknown>)[alias.replace("#", ":").replace(/^:f/, ":v")] : undefined;
};
const dsGets = () => h.ddb.filter((c) => c.name === "GetCommand" && c.key?.datasourceId).map((c) => String(c.key!.datasourceId));

beforeEach(() => {
  h.ddb.length = 0;
  h.task = { ...TASK };
  h.dsById = {
    D1: { userId: "default-user", datasourceId: "D1", type: "mysql", database: "gamedata", projectId: "p1" },
    D2: { userId: "default-user", datasourceId: "D2", type: "mysql", database: "sysdb", projectId: "p1" },
    D3: { userId: "default-user", datasourceId: "D3", type: "mysql", database: "far", projectId: "p1", ownerTargetId: "tgt_usw2_a" },
    DDB1: { userId: "default-user", datasourceId: "DDB1", type: "dynamodb", connection: { tableName: "orders" }, projectId: "p1" },
  };
  vi.resetModules();
});

describe("① 换到同区另一个源:sourceDatabase 跟着新源走", () => {
  it("请求体带旧库名 gamedata ⇒ 200,落库 datasourceId=D2、sourceDatabase=sysdb(不是请求体里的旧值);新源行只读一次", async () => {
    const res = await put({ ...ECHO, datasourceId: "D2", sourceTables: ["sys_config"], fieldMappings: { sys_config: [] } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(setValue("datasourceId")).toBe("D2");
    expect(setValue("sourceDatabase")).toBe("sysdb");
    expect(res.body.sourceDatabase).toBe("sysdb");
    expect(dsGets()).toEqual(["D2"]);
  });
});

describe("② 新源不存在 / ③ 新源在别的区 ⇒ 拒且不落库", () => {
  it("D9 不存在 ⇒ 404 NOT_FOUND,没有 UpdateCommand", async () => {
    const res = await put({ ...ECHO, datasourceId: "D9" });
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("NOT_FOUND");
    expect(update()).toBeUndefined();
  });
  it("D3 在 tgt_usw2_a 而任务绑定 tgt_home ⇒ 409 CROSS_REGION_SOURCE(与启动路由同一个码),拒因点名两个执行环境,没有 UpdateCommand", async () => {
    const res = await put({ ...ECHO, datasourceId: "D3" });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("CROSS_REGION_SOURCE");
    expect(res.body.error?.detail).toEqual({ datasourceOwner: "tgt_usw2_a", bound: ["tgt_home"] });
    expect(String(res.body.error?.message)).toContain("tgt_usw2_a");
    expect(String(res.body.error?.message)).toContain("tgt_home");
    expect(update()).toBeUndefined();
  });
});

describe("④ 没换源 / ⑤ 换到没有库名的源", () => {
  it("只改名(datasourceId 回显同值)⇒ 不读数据源行;sourceDatabase 原样", async () => {
    const res = await put({ ...ECHO, name: "renamed" });
    expect(res.status).toBe(200);
    expect(dsGets()).toEqual([]);
    expect(setValue("sourceDatabase")).toBe("gamedata");
  });
  it("换到 DynamoDB 源(没有 database)⇒ 200,sourceDatabase 不被改写成空", async () => {
    const res = await put({ ...ECHO, datasourceId: "DDB1" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(setValue("datasourceId")).toBe("DDB1");
    expect(setValue("sourceDatabase")).toBe("gamedata");
  });
});
