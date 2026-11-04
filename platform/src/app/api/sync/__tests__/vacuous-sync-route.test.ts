// 🔴 **行为**判据(不是文本):空表清单的同步任务
//   ① 建不出来(400 且**零 PutCommand**)· ② 启动不了(400 且**不建 Glue 作业**)。
// 为什么必须是行为:第一版只断「文件里出现 syncWorkRejection(」——把那句 `return apiError(...)`
// 删掉之后**判据照绿**(变异存活)。文本判据挡不住变异,这是本仓第三次付这个学费。
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  ddb: [] as string[],
  glue: [] as string[],
  puts: [] as Record<string, unknown>[],
  task: {} as Record<string, unknown>,
  ds: { userId: "default-user", datasourceId: "D1", type: "mysql", database: "gamedata", projectId: "p1" } as Record<string, unknown>,
}));

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { SYNC_TASKS: "bgp-sync-tasks", DATASOURCES: "bgp-datasources" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      h.ddb.push(cmd.constructor.name);
      if (cmd.constructor.name === "PutCommand") h.puts.push(cmd.input?.Item ?? {});
      if (cmd.constructor.name === "GetCommand") {
        return { Item: cmd.input?.Key?.datasourceId ? h.ds : h.task };
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
vi.mock("@/lib/versions/version-service", () => ({ snapshotVersion: vi.fn(async () => {}) }));
vi.mock("@/lib/governance/lineage-service", () => ({ generateSyncLineage: vi.fn(async () => {}), recordComputeLineage: vi.fn(async () => {}) }));
vi.mock("@/lib/sync/reconcile", () => ({ reconcileSyncTask: vi.fn(async (x: unknown) => x) }));
vi.mock("@/lib/exec-env/registry", () => ({
  getTargetRaw: vi.fn(async (id: string) => ({ targetId: id, ready: true, region: "us-east-1" })),
  descriptorViolation: vi.fn(() => null),
}));
vi.mock("@aws-sdk/client-glue", () => {
  const mk = (n: string) => { const C = class { constructor(public input: any) {} }; Object.defineProperty(C, "name", { value: n }); return C; };
  class GlueClient { async send(cmd: any) { h.glue.push(cmd.constructor.name); return {}; } }
  return {
    GlueClient,
    CreateJobCommand: mk("CreateJobCommand"), UpdateJobCommand: mk("UpdateJobCommand"),
    StartJobRunCommand: mk("StartJobRunCommand"), GetCatalogCommand: mk("GetCatalogCommand"),
    CreateCatalogCommand: mk("CreateCatalogCommand"),
  };
});

const post = async (body: Record<string, unknown>) => {
  const { POST } = await import("../route");
  const { NextRequest } = await import("next/server");
  const res = await POST(new NextRequest("http://x/api/sync", {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
  }));
  return { status: res.status, body: await res.json() };
};
const start = async () => {
  const { POST } = await import("../[id]/start/route");
  const res = await POST(new Request("http://x/api/sync/T1/start", { method: "POST" }) as never, { params: { id: "T1" } });
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  h.ddb.length = 0; h.glue.length = 0; h.puts.length = 0; vi.resetModules();
  h.ds = { userId: "default-user", datasourceId: "D1", type: "mysql", database: "gamedata", projectId: "p1" };
});

// 段 prodA 页面实测:向导从不传 sourceDatabase ⇒ 页面新建一律 400
describe("页面向导不传 sourceDatabase:源库名按执行体同一优先级从数据源取", () => {
  it("缺 sourceDatabase、数据源有库名 ⇒ 建得出来,落库 sourceDatabase = 数据源的库名", async () => {
    const r = await post({ name: "t", datasourceId: "D1", targetType: "redshift", channel: "glue",
                           writeMode: "append", sourceTables: ["players"] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const put = h.puts.find((x) => x.name === "t");
    expect(put?.sourceDatabase).toBe("gamedata");
  });
  it("缺 sourceDatabase、数据源也没有库名 ⇒ 仍 400 且不落库(不许空转)", async () => {
    h.ds = { userId: "default-user", datasourceId: "D1", type: "mysql", projectId: "p1" };
    const r = await post({ name: "t", datasourceId: "D1", targetType: "redshift", channel: "glue",
                           writeMode: "append", sourceTables: ["players"] });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("sourceDatabase");
    expect(h.ddb.filter((x) => x === "PutCommand")).toHaveLength(0);
  });
  it("显式给了 sourceDatabase ⇒ 原样保留(不被数据源覆盖)", async () => {
    const r = await post({ name: "t", datasourceId: "D1", targetType: "redshift", channel: "glue",
                           writeMode: "append", sourceDatabase: "other_db", sourceTables: ["players"] });
    expect(r.status).toBe(201);
    expect(h.puts.find((x) => x.name === "t")?.sourceDatabase).toBe("other_db");
  });
});

// 页面驱动段 scq A1-2(2026-10-25,demo 账号第二区视角)真撞
//   S3 源(湖桶 gamedata/ 前缀)在向导第 2 步列出 7 个数据集、勾一个、「完成」⇒ 400「缺少源库名」。
describe("S3 对象存储源(没有库名)经页面向导建任务", () => {
  const s3ds = { userId: "default-user", datasourceId: "D1", type: "s3", projectId: "p1",
                 connection: { bucket: "bgp-datalake-x", prefix: "gamedata/", region: "us-west-2", format: "auto" } };

  it("建任务:数据源是 S3(连接袋 bucket/prefix,无 database)、向导不传 sourceDatabase ⇒ **201 落库**(原来 400)且不编造库名", async () => {
    h.ds = { ...s3ds };
    const r = await post({ name: "t-s3", datasourceId: "D1", targetType: "redshift", channel: "glue",
                           writeMode: "append", sourceTables: ["ad_campaigns"] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const put = h.puts.find((x) => x.name === "t-s3");
    expect(put?.sourceTables).toEqual(["ad_campaigns"]);
    expect(put?.sourceDatabase).toBeUndefined();
  });

  it("建任务:S3 源连接袋缺 bucket ⇒ 400,拒因点名 bucket(provider 自己的校验),不落库", async () => {
    h.ds = { ...s3ds, connection: { prefix: "gamedata/" } };
    const r = await post({ name: "t-s3", datasourceId: "D1", targetType: "redshift", channel: "glue",
                           writeMode: "append", sourceTables: ["ad_campaigns"] });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("bucket");
    expect(h.ddb.filter((x) => x === "PutCommand")).toHaveLength(0);
  });

  it("启动:S3 源任务行没有 sourceDatabase ⇒ 不再被「缺少源库名」挡住", async () => {
    h.ds = { ...s3ds };
    h.task = { userId: "default-user", taskId: "T1", name: "t", channel: "glue", targetType: "redshift", writeMode: "append",
               projectId: "p1", datasourceId: "D1", sourceTables: ["ad_campaigns"], targets: ["tgt_home"] };
    const r = await start();
    expect(JSON.stringify(r.body)).not.toContain("sourceDatabase");
  });
});

describe("🔴 空转成功的入口守卫(行为)", () => {
  it("建任务:表清单写错字段名(tables 而不是 sourceTables)⇒ **400** 且**一条都没落库**", async () => {
    const r = await post({ name: "t", datasourceId: "D1", targetType: "redshift", channel: "glue",
                           sourceDatabase: "gamedata", tables: [{ schema: "gamedata", table: "players" }] });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("sourceTables");
    expect(h.ddb.filter((x) => x === "PutCommand")).toHaveLength(0);
  });

  it("建任务:sourceTables 为空数组 ⇒ 400 且不落库", async () => {
    const r = await post({ name: "t", datasourceId: "D1", targetType: "redshift", channel: "glue",
                           sourceDatabase: "gamedata", sourceTables: [] });
    expect(r.status).toBe(400);
    expect(h.ddb.filter((x) => x === "PutCommand")).toHaveLength(0);
  });

  it("建任务:字段齐 ⇒ 放行(证明这道门不是把所有请求都拦了)", async () => {
    // 生产上线批次 A:writeMode 必填(不再缺省成 overwrite)⇒ 「字段齐」包括它。
    const r = await post({ name: "t", datasourceId: "D1", targetType: "redshift", channel: "glue", writeMode: "append",
                           sourceDatabase: "gamedata", sourceTables: ["players"] });
    // 🔴 判别力:血缘 mock 修成返回 Promise 后,合法请求真走到落库 ⇒ 直接断 201 + 落了一行
    //   (原来靠「500 且拒因不含 sourceTables」间接判,成功体里回显 sourceTables 就判不了了)。
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(h.ddb.filter((x) => x === "PutCommand").length).toBeGreaterThanOrEqual(1);
  });

  it("启动:存量空任务 ⇒ **400** 且**不去建 Glue 作业**(否则它会空转成功)", async () => {
    h.task = { userId: "default-user", taskId: "T1", name: "t", channel: "glue", targetType: "redshift",
               projectId: "p1", sourceDatabase: "gamedata", sourceTables: [], targets: ["tgt_home"] };
    const r = await start();
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("sourceTables");
    expect(h.glue.filter((x) => x.startsWith("Create") || x.startsWith("Start"))).toHaveLength(0);
  });
});
