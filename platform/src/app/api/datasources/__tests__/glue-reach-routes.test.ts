// 数据源「检测」(heartbeat)与「浏览表」(tables)两条路由经 Glue 连接的装配层判据。
//
// 【缺陷原形(2026-10-13 客户生产环境)】源库在客户 VPC,控制面 ECS 在平台 VPC,无 peering:
//   「检测」把源刷成 unreachable、「浏览表」0 张;同一条 Glue 连接跑的同步作业却成功。
// 【规则】auto:先直连,直连失败且有 Glue 连接 ⇒ 起发现作业,**不把直连失败写成 unreachable**;glue-connection:不做直连。
//   探测与发现表是**同一个载体**(发现作业):作业成功 ⇒ 可达 + 表清单顺带缓存;失败 ⇒ 不可达 + Glue 的 ErrorMessage;超预算 ⇒ unknown。
//   🔴 不用 Glue TestConnection(2026-10-13 temp-account 实测:对平台建的传统 JDBC 连接回「only supported for the Unified Connections」,
//      GetConnection 也没有 Status 字段;那一版 s38 单跑 70a/70b/70c 三条红 = 这条路没有载体)。
//   列表 / 单条 GET 读到「验证中」的行也要推进(页面不再轮询时用户仍能看到结论)。
// 【只 mock 真外部】DDB、按区 SDK 客户端工厂、落点解析、鉴权、JDBC 驱动(SPI provider 的 ping / introspect)。glue-reach / glue-job-upsert / glue-probe-settle / ds-patch 不 mock。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import "@aws-sdk/client-glue";
import "@aws-sdk/client-s3";
import { GLUE_VERSION_DEFAULT } from "@/lib/sync/glue-version";

type Call = { svc: string; cmd: string; input: Record<string, unknown> };
const h = vi.hoisted(() => ({
  calls: [] as Call[],
  ds: {} as Record<string, any>,
  ping: { reachable: true as boolean | null, latencyMs: 12, error: undefined as string | undefined },
  introspectError: "" as string,
  jobExists: false,
  jobRunState: "RUNNING" as string,
  jobRunError: undefined as string | undefined,
  resultJson: "" as string,
  startJobRunError: null as Error | null,
}));
const DS_ID = "01DSGLUEREACH000000A1";
const JOB = `bgp-ds-discover-${DS_ID.slice(-12)}`;

vi.mock("@/lib/aws/dynamodb", () => ({
  TABLES: { DATASOURCES: "bgp-datasources" },
  docClient: {
    send: vi.fn(async (cmd: any) => {
      const input = { ...((cmd.input || {}) as Record<string, unknown>) };
      h.calls.push({ svc: "ddb", cmd: cmd.constructor.name, input });
      const n = cmd.constructor.name;
      if (n === "GetCommand") return { Item: { ...h.ds } };
      if (n === "UpdateCommand") {
        const vals = (input.ExpressionAttributeValues || {}) as Record<string, unknown>;
        const names = (input.ExpressionAttributeNames || {}) as Record<string, string>;
        for (const m of String(input.UpdateExpression || "").matchAll(/(#?\w+)\s*=\s*(:\w+)/g)) {
          const k = names[m[1]] ?? m[1];
          if (m[2] in vals) h.ds[k] = vals[m[2]];
        }
        return { Attributes: { ...h.ds } };
      }
      return {};
    }),
  },
}));
vi.mock("@/lib/projects/guard", () => ({
  guardResourceAccess: vi.fn(async () => ({ identity: { username: "admin" }, projectId: "p1" })),
  requireProject: vi.fn(async () => ({ identity: { username: "admin" }, projectId: "p1", role: "editor" })),
}));
vi.mock("@/lib/datasource/heartbeat", () => ({
  pingDataSource: vi.fn(async () => { h.calls.push({ svc: "node", cmd: "ping", input: {} }); return { ...h.ping }; }),
}));
vi.mock("@/lib/datasource-spi/registry", () => ({
  isDataSourceType: (t: string) => ["mysql", "postgresql", "oracle", "sqlserver", "dynamodb"].includes(t),
  getProvider: (t: string) => ({
    capabilities: { paradigm: t === "dynamodb" ? "nosql" : "jdbc", needsGlueConnection: t !== "dynamodb" },
    introspect: vi.fn(async () => {
      h.calls.push({ svc: "node", cmd: "introspect", input: {} });
      if (h.introspectError) throw new Error(h.introspectError);
      return [{ name: "players", kind: "table", columns: [{ name: "id", type: "int", nullable: false, key: "PRI", comment: "" }] }];
    }),
    buildConnection: () => ({ paradigm: "jdbc", jdbcUrl: "jdbc:mysql://db.cust.internal:3306/gamedb", driverClass: "com.mysql.cj.jdbc.Driver" }),
  }),
}));
const clients = vi.hoisted(() => ({} as Record<string, any>));
vi.mock("@/lib/exec-env/target-clients", async (orig) => {
  const real: any = await orig();
  const get = (svc: string) => async () => clients[svc];
  return { ...real, glueClientFor: get("glue"), s3ClientFor: get("s3") };
});
vi.mock("@/lib/exec-env/data-plane-target", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    resolveGlueBinding: vi.fn(async () => ({
      targetId: "tgt_home", region: "ap-southeast-1", scriptsBucket: "bgp-glue-scripts-123456789012", roleArn: "arn:aws:iam::123456789012:role/bgp-glue-role",
      datalakeBucket: "bgp-datalake-123456789012", tableBucket: "bgp-table-bucket", home: true, jurisdiction: "home",
    })),
  };
});

function err(name: string, message: string) { const e = new Error(message); e.name = name; return e; }
function fakeClient(svc: string) {
  return {
    send: vi.fn(async (cmd: any) => {
      const input = { ...((cmd.input || {}) as Record<string, unknown>) };
      h.calls.push({ svc, cmd: cmd.constructor.name, input });
      const n = cmd.constructor.name;
      if (svc === "glue" && n === "GetJobCommand") { if (!h.jobExists) throw err("EntityNotFoundException", "Job not found"); return { Job: { Name: input.JobName } }; }
      if (svc === "glue" && n === "CreateJobCommand") return { Name: input.Name };
      if (svc === "glue" && n === "UpdateJobCommand") return { JobName: input.JobName };
      if (svc === "glue" && n === "StartJobRunCommand") { if (h.startJobRunError) throw h.startJobRunError; return { JobRunId: "jr_discover_1" }; }
      if (svc === "glue" && n === "GetJobRunCommand") return { JobRun: { JobRunState: h.jobRunState, ErrorMessage: h.jobRunError } };
      if (svc === "s3" && n === "PutObjectCommand") return {};
      if (svc === "s3" && n === "GetObjectCommand") return { Body: { transformToString: async () => h.resultJson } };
      return {};
    }),
  };
}

const baseDs = () => ({
  userId: "default-user", datasourceId: DS_ID, projectId: "p1", name: "cust-mysql", type: "mysql",
  host: "db.cust.internal", port: 3306, database: "gamedb", username: "u", status: "active",
  secretArn: "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:bgp-ds-x", glueConnectionName: "bgp-conn-CUST000000A1",
  ownerTargetId: "tgt_home",
});
const runningRec = (ageMs = 60_000) => ({
  state: "running", jobName: JOB, jobRunId: "jr_discover_1", startedAt: new Date(Date.now() - ageMs).toISOString(),
  database: "gamedb", bucket: "bgp-glue-scripts-123456789012", resultKey: `discover/${DS_ID}/gamedb.json`, region: "ap-southeast-1",
});
const okJson = () => JSON.stringify({ database: "gamedb", generatedAt: "2026-10-13T03:00:00Z", via: "glue-discovery", tables: [{ name: "vehicle", database: "gamedb", columns: [{ name: "vin", type: "varchar(32)", nullable: false, key: "PRI", comment: "" }] }] });
const req = (path: string, method = "GET") => new NextRequest(`http://x${path}`, { method });
const glue = (cmd: string) => h.calls.filter((c) => c.svc === "glue" && c.cmd === cmd);
const node = (cmd: string) => h.calls.filter((c) => c.svc === "node" && c.cmd === cmd);
const ddbSets = () => h.calls.filter((c) => c.svc === "ddb" && c.cmd === "UpdateCommand");
async function body(res: Response) { const j: any = await res.json(); return j && typeof j === "object" && "success" in j ? j.data ?? j : j; }

beforeEach(() => {
  h.calls.length = 0; h.ds = baseDs();
  h.ping = { reachable: true, latencyMs: 12, error: undefined };
  h.introspectError = "";
  h.jobExists = false; h.jobRunState = "RUNNING"; h.jobRunError = undefined; h.resultJson = ""; h.startJobRunError = null;
  for (const s of ["glue", "s3"]) clients[s] = fakeClient(s);
  process.env.AWS_ACCOUNT_ID = "123456789012";
  vi.resetModules();
});

describe("🔴 heartbeat POST(探测 = 发现作业)", () => {
  const post = async () => { const m: any = await import("@/app/api/datasources/[id]/heartbeat/route"); return m.POST(req(`/api/datasources/${DS_ID}/heartbeat`, "POST"), { params: { id: DS_ID } }); };
  const get = async () => { const m: any = await import("@/app/api/datasources/[id]/heartbeat/route"); return m.GET(req(`/api/datasources/${DS_ID}/heartbeat`), { params: { id: DS_ID } }); };

  it("auto + 直连可达 ⇒ 存量语义:active、via=control-plane、零 Glue 调用", async () => {
    const r = await post(); const b = await body(r);
    expect(r.status).toBe(200);
    expect(b).toMatchObject({ status: "active", reachable: true });
    expect(h.ds.status).toBe("active");
    expect(h.ds.heartbeat).toMatchObject({ via: "control-plane", state: "settled", reachable: true });
    expect(h.calls.filter((c) => c.svc === "glue")).toHaveLength(0);
  });
  it("auto + 直连不通 + 有 Glue 连接 ⇒ **不写 unreachable**:起发现作业(挂该连接、--database = 源的库),status=testing,记下控制面那一下的错", async () => {
    h.ping = { reachable: false, latencyMs: undefined as any, error: "connect ETIMEDOUT 192.168.23.10:3306" };
    const r = await post(); const b = await body(r);
    expect(r.status).toBe(200);
    expect(b).toMatchObject({ status: "testing", via: "glue-connection", state: "testing", jobRunId: "jr_discover_1", reused: false, controlPlane: { reachable: false, error: "connect ETIMEDOUT 192.168.23.10:3306" } });
    expect(String(b.message)).toContain("控制面直连不到该源");
    expect(glue("StartJobRunCommand")).toHaveLength(1);
    const start = glue("StartJobRunCommand")[0].input as Record<string, any>;
    expect(start.JobName).toBe(JOB);
    expect(start.Arguments["--database"]).toBe("gamedb");
    expect((glue("CreateJobCommand")[0].input as any).Connections).toEqual({ Connections: ["bgp-conn-CUST000000A1"] });
    expect(h.ds.status).toBe("testing");
    expect(h.ds.heartbeat).toMatchObject({ via: "glue-connection", state: "testing", reachable: null, jobRunId: "jr_discover_1" });
    expect(typeof h.ds.heartbeat.startedAt).toBe("string");
    expect(h.ds.discovery).toMatchObject({ state: "running", jobRunId: "jr_discover_1", database: "gamedb" });
    expect(h.calls.some((c) => c.cmd === "TestConnectionCommand")).toBe(false);
  });
  it("auto + 直连不通 + **没有** Glue 连接 ⇒ 存量语义 unreachable", async () => {
    h.ping = { reachable: false, latencyMs: undefined as any, error: "ECONNREFUSED" };
    delete h.ds.glueConnectionName;
    const r = await post(); const b = await body(r);
    expect(b.status).toBe("unreachable");
    expect(h.ds.status).toBe("unreachable");
    expect(h.calls.filter((c) => c.svc === "glue")).toHaveLength(0);
  });
  it("probeVia=glue-connection ⇒ 不做控制面直连,直接起发现作业", async () => {
    h.ds.probeVia = "glue-connection";
    const r = await post(); const b = await body(r);
    expect(b).toMatchObject({ status: "testing", via: "glue-connection" });
    expect(node("ping")).toHaveLength(0);
    expect(glue("StartJobRunCommand")).toHaveLength(1);
    expect(h.ds.heartbeat.controlPlane.reachable).toBeNull();
  });
  it("已有一次发现作业在跑 ⇒ 复用它(不起第二个 run,MaxConcurrentRuns=1),jobRunId 对得上", async () => {
    h.ds.probeVia = "glue-connection";
    h.ds.discovery = runningRec();
    const r = await post(); const b = await body(r);
    expect(r.status).toBe(200);
    expect(b).toMatchObject({ status: "testing", reused: true, jobRunId: "jr_discover_1" });
    expect(glue("GetJobRunCommand")).toHaveLength(1);
    expect(glue("StartJobRunCommand")).toHaveLength(0);
    expect(h.ds.heartbeat.jobRunId).toBe("jr_discover_1");
  });
  it("上一次已经结束但没人读过 ⇒ 先把它的结论落库,再起新的一次(「检测」要的是现在)", async () => {
    h.ds.probeVia = "glue-connection";
    h.ds.discovery = runningRec(); h.jobRunState = "SUCCEEDED"; h.resultJson = okJson();
    clients.glue.send = vi.fn(async (cmd: any) => {
      h.calls.push({ svc: "glue", cmd: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === "GetJobRunCommand") return { JobRun: { JobRunState: "SUCCEEDED" } };
      if (cmd.constructor.name === "GetJobCommand") return { Job: { Name: cmd.input.JobName } };
      if (cmd.constructor.name === "StartJobRunCommand") return { JobRunId: "jr_discover_2" };
      return {};
    });
    const b = await body(await post());
    expect(b).toMatchObject({ status: "testing", reused: false, jobRunId: "jr_discover_2" });
    expect(h.ds.discoveredSchema).toMatchObject({ database: "gamedb" });   // 上一次的结果没丢
    expect(h.ds.discovery).toMatchObject({ state: "running", jobRunId: "jr_discover_2" });
  });
  it("StartJobRun 因权限失败 ⇒ 500 如实上抛,状态不变", async () => {
    h.ds.probeVia = "glue-connection";
    h.startJobRunError = err("AccessDeniedException", "not authorized to perform glue:StartJobRun");
    const r = await post();
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).toContain("glue:StartJobRun");
    expect(h.ds.status).toBe("active");
  });
  it("源没填库名 ⇒ 500 说清「没有填写数据库名」,不起作业", async () => {
    h.ds.probeVia = "glue-connection"; h.ds.database = "";
    const r = await post();
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).toContain("数据库名");
    expect(glue("StartJobRunCommand")).toHaveLength(0);
  });

  describe("GET(读发现作业的结论并落库)", () => {
    const testing = (startedAgoMs: number) => {
      const startedAt = new Date(Date.now() - startedAgoMs).toISOString();
      h.ds.status = "testing";
      h.ds.heartbeat = { reachable: null, at: startedAt, via: "glue-connection", state: "testing", startedAt, jobRunId: "jr_discover_1", controlPlane: { reachable: false, error: "ETIMEDOUT" } };
      h.ds.discovery = { ...runningRec(startedAgoMs), startedAt };
      return startedAt;
    };
    it("RUNNING ⇒ 仍 testing,不落库", async () => {
      testing(30_000);
      const b = await body(await get());
      expect(b).toMatchObject({ status: "testing", state: "testing" });
      expect(ddbSets()).toHaveLength(0);
      expect(glue("GetJobRunCommand")[0].input).toEqual({ JobName: JOB, RunId: "jr_discover_1" });
    });
    it("SUCCEEDED ⇒ active / settled / reachable=true,表清单顺带缓存(discoveredSchema),保留控制面那一下的记录", async () => {
      testing(60_000);
      h.jobRunState = "SUCCEEDED"; h.resultJson = okJson();
      const b = await body(await get());
      expect(b).toMatchObject({ status: "active", state: "settled", reachable: true, via: "glue-connection", controlPlane: { reachable: false } });
      expect(h.ds.status).toBe("active");
      expect(typeof h.ds.heartbeat.validatedAt).toBe("string");
      expect(h.ds.discovery.state).toBe("succeeded");
      expect(h.ds.discoveredSchema.tables[0].name).toBe("vehicle");
    });
    it("FAILED ⇒ unreachable,error = Glue 的 ErrorMessage;discovery.state=failed", async () => {
      testing(60_000);
      h.jobRunState = "FAILED"; h.jobRunError = "Communications link failure: connect timed out (db.cust.internal:3306)";
      const b = await body(await get());
      expect(b).toMatchObject({ status: "unreachable", state: "settled", reachable: false });
      expect(b.error).toContain("Communications link failure");
      expect(h.ds.status).toBe("unreachable");
      expect(h.ds.discovery).toMatchObject({ state: "failed", error: expect.stringContaining("Communications link failure") });
    });
    it("发现记录已被别的读取(浏览表)落成终态且结束时间在本次起点之后 ⇒ 直接用它,不再调 Glue", async () => {
      const startedAt = testing(60_000);
      h.ds.discovery = { ...h.ds.discovery, state: "succeeded", finishedAt: new Date(new Date(startedAt).getTime() + 30_000).toISOString() };
      h.ds.discoveredSchema = { at: "x", database: "gamedb", via: "glue-discovery", tables: [] };
      const b = await body(await get());
      expect(b).toMatchObject({ status: "active", state: "settled", reachable: true });
      expect(glue("GetJobRunCommand")).toHaveLength(0);
    });
    it("超过预算仍没终态 ⇒ unknown + status=error,错误说清「没有结束」(不猜可达 / 不可达)", async () => {
      testing(17 * 60_000);
      const b = await body(await get());
      expect(b).toMatchObject({ status: "error", state: "unknown", reachable: null });
      expect(String(b.error)).toContain("没有结束");
      expect(h.ds.status).toBe("error");
    });
    it("不在 testing 态 ⇒ 原样回最近一次心跳,不调 Glue", async () => {
      h.ds.heartbeat = { reachable: true, at: "2026-10-13T00:00:00Z", via: "control-plane", state: "settled" };
      const b = await body(await get());
      expect(b).toMatchObject({ status: "active", reachable: true });
      expect(h.calls.filter((c) => c.svc === "glue")).toHaveLength(0);
    });
  });
});

describe("🔴 列表 / 单条读取也把「验证中」推进到结论(页面不再轮询时用户仍能看到)", () => {
  const SRC = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
  it("接线判据:列表 GET 与单条 GET 的**调用点**都在(不是只 import)", () => {
    const list = SRC("src/app/api/datasources/route.ts");
    expect(list).toMatch(/apiOk\(await settleGlueProbeRows\(Items/);
    const one = SRC("src/app/api/datasources/[id]/route.ts");
    expect(one).toMatch(/await settleGlueProbeRows\(\[Item/);
  });
  it("单条 GET:行在 testing 且作业 SUCCEEDED ⇒ 返回的就是 active,且已落库", async () => {
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    h.ds.status = "testing";
    h.ds.heartbeat = { reachable: null, at: startedAt, via: "glue-connection", state: "testing", startedAt, jobRunId: "jr_discover_1" };
    h.ds.discovery = { ...runningRec(60_000), startedAt };
    h.jobRunState = "SUCCEEDED"; h.resultJson = okJson();
    const m: any = await import("@/app/api/datasources/[id]/route");
    const b = await body(await m.GET(req(`/api/datasources/${DS_ID}`), { params: { id: DS_ID } }));
    expect(b).toMatchObject({ datasourceId: DS_ID, status: "active", heartbeat: { state: "settled", reachable: true } });
    expect(h.ds.status).toBe("active");
  });
  it("单条 GET:不在 testing 态 ⇒ 零 Glue 调用(存量读取零成本)", async () => {
    const m: any = await import("@/app/api/datasources/[id]/route");
    const b = await body(await m.GET(req(`/api/datasources/${DS_ID}`), { params: { id: DS_ID } }));
    expect(b.datasourceId).toBe(DS_ID);
    expect(h.calls.filter((c) => c.svc === "glue")).toHaveLength(0);
  });
  it("推进失败(Glue 读不到)⇒ 行按原状态返回,读取本身不 500", async () => {
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    h.ds.status = "testing";
    h.ds.heartbeat = { reachable: null, at: startedAt, via: "glue-connection", state: "testing", startedAt, jobRunId: "jr_discover_1" };
    h.ds.discovery = { ...runningRec(60_000), startedAt };
    clients.glue.send = vi.fn(async () => { throw err("ThrottlingException", "Rate exceeded"); });
    const m: any = await import("@/app/api/datasources/[id]/route");
    const r = await m.GET(req(`/api/datasources/${DS_ID}`), { params: { id: DS_ID } });
    expect(r.status).toBe(200);
    expect((await body(r)).status).toBe("testing");
  });
});

describe("🔴 tables GET", () => {
  const get = async (qs = "?database=gamedb") => { const m: any = await import("@/app/api/datasources/[id]/tables/route"); return m.GET(req(`/api/datasources/${DS_ID}/tables${qs}`), { params: { id: DS_ID } }); };

  it("auto + 直连读到 ⇒ 数组应答(存量逐字不变),零 Glue 调用", async () => {
    const r = await get(); const b: any = await r.json();
    expect(r.status).toBe(200);
    expect(Array.isArray(b)).toBe(true);
    expect(b[0]).toMatchObject({ name: "players", database: "gamedb" });
    expect(h.calls.filter((c) => c.svc === "glue")).toHaveLength(0);
  });
  it("auto + 直连失败 + 有 Glue 连接 ⇒ 起发现作业:脚本写进脚本桶(带 JDBC 超时)、作业挂该连接 / 平台缺省 Glue 版本、StartJobRun 带 --result_uri / --database;202", async () => {
    h.introspectError = "connect ETIMEDOUT 192.168.23.10:3306";
    const r = await get(); const b: any = await r.json();
    expect(r.status).toBe(202);
    expect(b).toMatchObject({ discovering: true, via: "glue-discovery", database: "gamedb", jobRunId: "jr_discover_1" });
    expect(String(b.note)).toContain("控制面直连不到该源");
    const put = h.calls.find((c) => c.svc === "s3" && c.cmd === "PutObjectCommand")!;
    expect(put.input.Bucket).toBe("bgp-glue-scripts-123456789012");
    expect(put.input.Key).toBe(`glue-scripts/discover-${DS_ID}.py`);
    expect(String(put.input.Body)).toContain("jdbc:mysql://db.cust.internal:3306/gamedb");
    expect(String(put.input.Body)).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(String(put.input.Body)).toContain('.option("connectTimeout"');
    expect(glue("GetJobCommand")).toHaveLength(1);
    const created = glue("CreateJobCommand")[0].input as Record<string, any>;
    expect(created.Name).toBe(JOB);
    expect(created).toMatchObject({ GlueVersion: GLUE_VERSION_DEFAULT, Connections: { Connections: ["bgp-conn-CUST000000A1"] }, Role: "arn:aws:iam::123456789012:role/bgp-glue-role" });
    const start = glue("StartJobRunCommand")[0].input as Record<string, any>;
    expect(start.Arguments).toEqual({ "--result_uri": `s3://bgp-glue-scripts-123456789012/discover/${DS_ID}/gamedb.json`, "--database": "gamedb" });
    expect(h.ds.discovery).toMatchObject({ state: "running", jobRunId: "jr_discover_1", database: "gamedb" });
  });
  it("auto + 直连失败 + **没有** Glue 连接 ⇒ 存量 500「无法连接源数据库」", async () => {
    h.introspectError = "ECONNREFUSED"; delete h.ds.glueConnectionName;
    const r = await get(); const b: any = await r.json();
    expect(r.status).toBe(500);
    expect(b.error).toContain("无法连接源数据库");
  });
  it("probeVia=glue-connection ⇒ 不做直连 introspect,直接走发现作业", async () => {
    h.ds.probeVia = "glue-connection";
    const r = await get();
    expect(r.status).toBe(202);
    expect(node("introspect")).toHaveLength(0);
    expect(glue("StartJobRunCommand")).toHaveLength(1);
  });
  describe("发现作业在跑 / 跑完", () => {
    const running = () => { h.ds.probeVia = "glue-connection"; h.ds.discovery = runningRec(); };
    it("RUNNING ⇒ 202,不再起第二个 run", async () => {
      running();
      const r = await get();
      expect(r.status).toBe(202);
      expect(glue("StartJobRunCommand")).toHaveLength(0);
      expect(glue("GetJobRunCommand")[0].input).toEqual({ JobName: JOB, RunId: "jr_discover_1" });
    });
    it("SUCCEEDED ⇒ 读结果 JSON,200 { tables, via: glue-discovery },并缓存到源行 discoveredSchema", async () => {
      running(); h.jobRunState = "SUCCEEDED"; h.resultJson = okJson();
      const r = await get(); const b: any = await r.json();
      expect(r.status).toBe(200);
      expect(b).toMatchObject({ via: "glue-discovery", discoveredAt: "2026-10-13T03:00:00Z", database: "gamedb" });
      expect(b.tables[0]).toMatchObject({ name: "vehicle" });
      const s3get = h.calls.find((c) => c.svc === "s3" && c.cmd === "GetObjectCommand")!;
      expect(s3get.input).toEqual({ Bucket: "bgp-glue-scripts-123456789012", Key: `discover/${DS_ID}/gamedb.json` });
      expect(h.ds.discoveredSchema).toMatchObject({ via: "glue-discovery", database: "gamedb" });
      expect(h.ds.discovery.state).toBe("succeeded");
    });
    it("FAILED ⇒ 502 带 Glue 的 ErrorMessage,源行 discovery.state=failed", async () => {
      running(); h.jobRunState = "FAILED"; h.jobRunError = "Communications link failure";
      const r = await get(); const b: any = await r.json();
      expect(r.status).toBe(502);
      expect(b.error).toContain("Communications link failure");
      expect(h.ds.discovery).toMatchObject({ state: "failed", error: "Communications link failure" });
    });
    it("超过预算仍 RUNNING ⇒ 502 说清「没有结束」,源行 discovery.state=failed", async () => {
      h.ds.probeVia = "glue-connection"; h.ds.discovery = runningRec(17 * 60_000);
      const r = await get(); const b: any = await r.json();
      expect(r.status).toBe(502);
      expect(b.error).toContain("没有结束");
      expect(h.ds.discovery.state).toBe("failed");
    });
    it("有缓存且不要求刷新 ⇒ 直接给缓存(零 Glue 调用);refresh=1 ⇒ 重新起作业", async () => {
      h.ds.probeVia = "glue-connection";
      h.ds.discoveredSchema = { at: "2026-10-13T02:00:00Z", database: "gamedb", via: "glue-discovery", tables: [{ name: "vehicle", database: "gamedb", columns: [] }] };
      const r1 = await get(); const b1: any = await r1.json();
      expect(r1.status).toBe(200);
      expect(b1.tables[0].name).toBe("vehicle");
      expect(h.calls.filter((c) => c.svc === "glue")).toHaveLength(0);
      const r2 = await get("?database=gamedb&refresh=1");
      expect(r2.status).toBe(202);
      expect(glue("StartJobRunCommand")).toHaveLength(1);
    });
    it("缓存是别的库的 ⇒ 不拿来充数,按请求的库重新发现", async () => {
      h.ds.probeVia = "glue-connection";
      h.ds.discoveredSchema = { at: "2026-10-13T02:00:00Z", database: "other_db", via: "glue-discovery", tables: [{ name: "x", database: "other_db", columns: [] }] };
      const r = await get();
      expect(r.status).toBe(202);
      expect((glue("StartJobRunCommand")[0].input as any).Arguments["--database"]).toBe("gamedb");
    });
    it("「检测」起的那次作业,「浏览表」复用(同一载体):heartbeat testing + discovery running ⇒ 浏览表 202 且不起第二个 run", async () => {
      h.ds.probeVia = "glue-connection";
      const startedAt = new Date(Date.now() - 20_000).toISOString();
      h.ds.heartbeat = { reachable: null, at: startedAt, via: "glue-connection", state: "testing", startedAt, jobRunId: "jr_discover_1" };
      h.ds.discovery = { ...runningRec(20_000), startedAt };
      const r = await get();
      expect(r.status).toBe(202);
      expect(glue("StartJobRunCommand")).toHaveLength(0);
    });
  });
});
